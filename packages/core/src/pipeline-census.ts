/**
 * A bounded observation of the pipelines a Three.js renderer actually asked the GPU device to make.
 *
 * This module deliberately knows the shape of Three's private render object, but not its cache-key
 * algorithm. Three owns the identity; the collector only reads the object at the backend boundary
 * where a cache miss becomes a real device creation. That keeps a material label from becoming a
 * pipeline key and makes the same observation useful on browser WebGPU and the native binding.
 *
 * The backend boundary alone is not the whole device, and a census that claims otherwise is
 * wrong by exactly the pipelines it cannot see: Three's texture pass utils build mipmap transfer
 * pipelines straight on the device, which is why a Bayview native capture logged 94 device
 * creations against 92 renderer events. So the device's own creation methods are observed too,
 * with creations reached through the wrapped backend attributed to their backend event rather
 * than counted twice, and a direct creation reported with the label the device was given, an
 * explicitly unknown pass and unknown provenance rather than the render object that happened to
 * be drawing when a texture uploaded.
 */

import { CORE_VERSION } from "./version.js";

export const PIPELINE_CENSUS_VERSION = 1 as const;
export const PIPELINE_CENSUS_CAPABILITY = "runtime.pipelineCensus" as const;
export const DEFAULT_PIPELINE_CENSUS_LIMIT = 512;

export type PipelineCensusStatus = "created" | "failed" | "pending";
export type PipelineCensusMode = "sync" | "async";

export interface IPipelineShaderObservation {
  readonly bytes: number;
  readonly hash: string;
}

export interface IPipelineProvenance {
  readonly material?: {
    readonly id?: number;
    readonly name?: string;
    readonly type?: string;
  };
  readonly object?: {
    readonly id?: number;
    readonly name?: string;
    readonly uuid?: string;
  };
  /** True when no stable material/object label was available at the creation boundary. */
  readonly unknown: boolean;
}

export interface IPipelineCensusEvent {
  /** Monotonic sequence, useful for detecting a dropped event in a merged native log. */
  readonly sequence: number;
  /** Three's program identity: the generated vertex/fragment source pair. */
  readonly programIdentity: string;
  /** Backend identity, separate from the program identity and from the material label. */
  readonly pipelineIdentity: string;
  readonly kind: "compute" | "render";
  readonly pass: string;
  readonly mode: PipelineCensusMode;
  readonly status: PipelineCensusStatus;
  readonly vertex?: IPipelineShaderObservation;
  readonly fragment?: IPipelineShaderObservation;
  readonly compute?: IPipelineShaderObservation;
  readonly provenance: IPipelineProvenance;
  /** The label the device was handed, when one was observed. A label is never read as a pass. */
  readonly label?: string;
  /** Structural inputs observed beside the generated shader, not a guessed reason. */
  readonly reasons: readonly string[];
  /** Host monotonic milliseconds relative to the capture origin. */
  readonly startedMs: number;
  readonly settledMs?: number;
  /** Synchronous device-call wall time; absent for an async promise. */
  readonly serviceMs?: number;
  /** Promise latency is retained as latency, never labelled native compiler time. */
  readonly promiseMs?: number;
  readonly error?: string;
  /** Number of distinct Three node-builder states first observed during this render-object call. */
  readonly nodeBuilds?: number;
  /** Whether this event settled before the first present boundary. */
  readonly beforeFirstPresent?: boolean;
  /** Whether this event settled before the explicit warm-up completion boundary. */
  readonly beforeWarmUpSettled?: boolean;
  /** The most recent streamed warm-up scope that preceded this event. */
  readonly afterWarmUpScope?: string;
}

/** A node-builder state observed even when Three reused an existing GPU pipeline. */
export interface IPipelineNodeBuild {
  readonly provenance: IPipelineProvenance;
  readonly startedMs: number;
  readonly beforeFirstPresent?: boolean;
  readonly beforeWarmUpSettled?: boolean;
  readonly afterWarmUpScope?: string;
}

export interface IPipelineCensusCounts {
  readonly lookups: number;
  readonly creations: number;
  readonly failures: number;
  readonly pending: number;
  readonly uniquePrograms: number;
  readonly uniquePipelines: number;
  readonly recordedEvents: number;
  readonly droppedEvents: number;
  readonly nodeBuilds: number;
  /**
   * Every creation seen at the device, including those attributed to a backend event. Absent
   * when the device could not be observed at all, so no reader mistakes silence for zero.
   */
  readonly deviceCreations?: number;
  /** Creations seen only at the device, never reached through the wrapped backend methods. */
  readonly directCreations?: number;
}

export interface IPipelineCensus {
  readonly version: typeof PIPELINE_CENSUS_VERSION;
  readonly complete: boolean;
  readonly overflowed: boolean;
  readonly unsupported: boolean;
  readonly limit: number;
  readonly clock: {
    readonly originMs: number;
    readonly source: "performance" | "date";
  };
  readonly build: {
    readonly identity: string;
  };
  readonly adapter: {
    readonly identity: string;
    readonly thermal: string;
  };
  readonly backend: {
    readonly kind: "webgpu" | "webgl2";
    readonly identity: string;
  };
  readonly firstPresent?: {
    readonly boundaryMs: number;
    readonly eventsSettled: number;
  };
  readonly warmUpSettled?: {
    readonly boundaryMs: number;
    readonly eventsSettled: number;
    readonly nodeBuilds: number;
    readonly renderPipelineCreations: number;
  };
  readonly warmUpScopes?: readonly {
    readonly label: string;
    readonly boundaryMs: number;
    readonly eventsSettled: number;
    readonly nodeBuilds: number;
    readonly renderPipelineCreations: number;
    readonly firstDraw?: {
      readonly nodeBuilds: number;
      readonly renderPipelineCreations: number;
    };
  }[];
  readonly counts: IPipelineCensusCounts;
  readonly events: readonly IPipelineCensusEvent[];
  readonly nodeBuilds?: readonly IPipelineNodeBuild[];
  readonly incompleteReasons: readonly string[];
}

export interface IPipelineCensusOptions {
  readonly adapterIdentity?: string;
  readonly buildIdentity?: string;
  readonly kind: "webgpu" | "webgl2";
  readonly limit?: number;
  readonly now?: () => number;
  readonly backendIdentity?: string;
  readonly thermalIdentity?: string;
}

interface IRenderObjectLike {
  readonly object?: unknown;
  readonly material?: unknown;
  readonly pipeline?: unknown;
  readonly context?: unknown;
  readonly scene?: unknown;
  readonly passId?: unknown;
}

interface IProgramLike {
  readonly code?: unknown;
  readonly id?: unknown;
  readonly stage?: unknown;
}

interface IPipelineLike {
  readonly cacheKey?: unknown;
  readonly vertexProgram?: IProgramLike;
  readonly fragmentProgram?: IProgramLike;
  readonly computeProgram?: IProgramLike;
  readonly isComputePipeline?: unknown;
}

interface IBackendLike {
  createRenderPipeline?: (...args: unknown[]) => unknown;
  createComputePipeline?: (...args: unknown[]) => unknown;
  get?: (value: unknown) => unknown;
  /** The GPU device the backend delegates to, absent until the backend has initialised. */
  device?: unknown;
}

/** The device methods that turn a descriptor into a real GPU object. */
const DEVICE_PIPELINE_METHODS = [
  ["createRenderPipeline", "render", "sync"],
  ["createRenderPipelineAsync", "render", "async"],
  ["createComputePipeline", "compute", "sync"],
  ["createComputePipelineAsync", "compute", "async"],
] as const satisfies readonly (readonly [string, "compute" | "render", PipelineCensusMode])[];

interface IInstalledDevice {
  readonly backend: IBackendLike;
  readonly device: Record<string, unknown>;
  readonly restore: readonly (() => void)[];
}

interface IActiveRenderObject {
  readonly clippingContext: unknown;
  readonly object: unknown;
  readonly material: unknown;
  readonly scene: unknown;
  readonly passId: unknown;
  nodeBuilds: number;
}

interface IMutableCensusEvent {
  sequence: number;
  programIdentity: string;
  pipelineIdentity: string;
  kind: "compute" | "render";
  pass: string;
  mode: PipelineCensusMode;
  status: PipelineCensusStatus;
  vertex?: IPipelineShaderObservation;
  fragment?: IPipelineShaderObservation;
  /** Whether the render descriptor carried a fragment stage, even when it was not observed. */
  fragmentStagePresent?: boolean;
  compute?: IPipelineShaderObservation;
  provenance: IPipelineProvenance;
  label?: string;
  reasons: readonly string[];
  startedMs: number;
  settledMs?: number;
  serviceMs?: number;
  promiseMs?: number;
  error?: string;
  nodeBuilds?: number;
  beforeFirstPresent?: boolean;
  beforeWarmUpSettled?: boolean;
  afterWarmUpScope?: string;
  /** Three's logical pipeline object, retained privately for backend data lookup. */
  backendPipeline?: unknown;
  /** Observed at the device rather than through a backend method, so it carries its own handle. */
  direct?: boolean;
  deviceHandle?: unknown;
  /** Whether this event still owns one of the pending counts, so settling releases exactly one. */
  pending?: boolean;
}

interface IInstalledBackend {
  readonly backend: IBackendLike;
  render?: (...args: unknown[]) => unknown;
  renderWrapper?: (...args: unknown[]) => unknown;
  compute?: (...args: unknown[]) => unknown;
  computeWrapper?: (...args: unknown[]) => unknown;
}

interface IRendererHookTarget {
  backend?: unknown;
  /** Three's renderer-owned node manager; absent on the WebGL2 renderer. */
  _nodes?: unknown;
  renderObject?: (...args: unknown[]) => unknown;
}

interface INodeBuilderObservation {
  readonly state: object;
  builds: number;
  reported: boolean;
}

interface IMutableWarmUpScope {
  label: string;
  boundaryMs: number;
  eventsSettled: number;
  nodeBuilds: number;
  renderPipelineCreations: number;
  firstDraw?: {
    nodeBuilds: number;
    renderPipelineCreations: number;
  };
  frameObserved: boolean;
  frameNodeBuilds: number;
  frameRenderPipelineCreations: number;
}

/**
 * Create and install a bounded census. The returned object is intentionally small: renderers own
 * lifecycle and callers only need `snapshot()`, `withRenderObject()`, and the two lifecycle
 * boundaries.
 */
export function createPipelineCensus(options: IPipelineCensusOptions): PipelineCensus {
  return new PipelineCensus(options);
}

export class PipelineCensus {
  readonly #kind: "webgpu" | "webgl2";
  readonly #limit: number;
  readonly #now: () => number;
  readonly #origin: number;
  readonly #clockSource: "performance" | "date";
  readonly #backendIdentity: string;
  readonly #buildIdentity: string;
  readonly #adapterIdentity: string;
  readonly #thermalIdentity: string;
  readonly #events: IMutableCensusEvent[] = [];
  readonly #nodeBuildEvents: IPipelineNodeBuild[] = [];
  readonly #programs = new Set<string>();
  readonly #pipelines = new Set<string>();
  readonly #installed: IInstalledBackend[] = [];
  readonly #devices: IInstalledDevice[] = [];
  readonly #pipelineIds = new WeakMap<object, string>();
  readonly #backendPipelineIds = new WeakMap<object, string>();
  /**
   * Shader identity by the object that owns the source: Three's programmable stage on the backend
   * path, the shader module on the device path. Keying by object rather than by text means one
   * hash per source instead of one per pipeline, and no capture ever retains a shader.
   */
  readonly #observations = new WeakMap<object, IPipelineShaderObservation>();
  /** Distinct node-builder states, so a repeated render-object lookup is not a graph rebuild. */
  readonly #nodeBuilderStates = new WeakSet<object>();
  /** Pending state-build counts keyed by Three's internal RenderObject for async compilation. */
  readonly #nodeBuilderObservations = new WeakMap<object, INodeBuilderObservation>();
  /** Device methods that exist but refused their hook, so their creations were never seen. */
  readonly #deviceRefusals = new Set<string>();
  #activeRenderObject: IActiveRenderObject | undefined;
  #nextSequence = 1;
  #nextBackendPipelineIdentity = 1;
  #nextLogicalPipelineIdentity = 1;
  #nextDevicePipelineIdentity = 1;
  #lookups = 0;
  #creations = 0;
  #failures = 0;
  #pending = 0;
  #dropped = 0;
  #droppedNodeBuilds = 0;
  #deviceCreations = 0;
  #directCreations = 0;
  #nodeBuilds = 0;
  #nestedDeviceCreations = 0;
  #backendDepth = 0;
  #backendDeviceCalls = 0;
  #deviceObserved = false;
  #overflowed = false;
  #unsupported = false;
  #firstPresentMs: number | undefined;
  #eventsSettledAtFirstPresent = 0;
  #warmUpSettledMs: number | undefined;
  #eventsSettledAtWarmUpSettled = 0;
  #nodeBuildsAtWarmUpSettled = 0;
  #renderPipelineCreationsAtWarmUpSettled = 0;
  readonly #warmUpScopes: IMutableWarmUpScope[] = [];
  /** Scope lists keyed weakly by streamed root, so an evicted chunk graph is not kept alive here. */
  readonly #warmUpTargets = new WeakMap<object, IMutableWarmUpScope[]>();
  /** Scopes a draw touched in the open world frame; only these reset when it closes. */
  #frameWarmUpScopes: IMutableWarmUpScope[] = [];
  #activeWarmUpScope: { label: string; boundaryMs: number } | undefined;
  #activeWorldFrame: { root: object } | undefined;
  #nodeBuilderObservationUnavailable = false;
  #cleanup: (() => void) | undefined;

  constructor(options: IPipelineCensusOptions) {
    if (!Number.isInteger(options.limit) || (options.limit ?? DEFAULT_PIPELINE_CENSUS_LIMIT) <= 0) {
      if (options.limit !== undefined)
        throw new Error(`TN_PIPELINE_CENSUS_LIMIT_INVALID: ${String(options.limit)}`);
    }
    this.#kind = options.kind;
    this.#limit = options.limit ?? DEFAULT_PIPELINE_CENSUS_LIMIT;
    this.#now = options.now ?? defaultNow;
    this.#origin = this.#now();
    this.#clockSource = typeof globalThis.performance?.now === "function" ? "performance" : "date";
    this.#backendIdentity = options.backendIdentity ?? `${options.kind}:renderer`;
    this.#buildIdentity = options.buildIdentity ?? `@threenative/core@${CORE_VERSION}`;
    this.#adapterIdentity = options.adapterIdentity ?? this.#backendIdentity;
    this.#thermalIdentity = options.thermalIdentity ?? "unavailable";
  }

  /** Install the backend creation hooks and the render-object context wrapper once. */
  install(backendValue: unknown): () => void {
    if (!isObject(backendValue)) {
      this.#unsupported = true;
      return () => undefined;
    }
    const backend = backendValue as IBackendLike;
    if (this.#installed.some((entry) => entry.backend === backend)) return () => undefined;
    const installed: IInstalledBackend = { backend };
    let changed = false;
    if (typeof backend.createRenderPipeline === "function") {
      const original = backend.createRenderPipeline;
      const wrapper = (...args: unknown[]): unknown =>
        this.#observeRenderCreation(backend, original, args);
      backend.createRenderPipeline = wrapper;
      installed.render = original;
      installed.renderWrapper = wrapper;
      changed = true;
    }
    if (typeof backend.createComputePipeline === "function") {
      const original = backend.createComputePipeline;
      const wrapper = (...args: unknown[]): unknown =>
        this.#observeComputeCreation(backend, original, args);
      backend.createComputePipeline = wrapper;
      installed.compute = original;
      installed.computeWrapper = wrapper;
      changed = true;
    }
    if (!changed) this.#unsupported = true;
    else this.#installed.push(installed);
    this.#ensureDevice(backend);
    return () => {
      this.#restoreDevices(backend);
      if (
        installed.render !== undefined &&
        backend.createRenderPipeline === installed.renderWrapper
      ) {
        backend.createRenderPipeline = installed.render;
      }
      if (
        installed.compute !== undefined &&
        backend.createComputePipeline === installed.computeWrapper
      ) {
        backend.createComputePipeline = installed.compute;
      }
      const index = this.#installed.indexOf(installed);
      if (index !== -1) this.#installed.splice(index, 1);
    };
  }

  /**
   * Install the device hooks for a backend that has one, once per device. The backend is asked
   * again on every creation because the device arrives with `init()` and is replaced on a device
   * loss; a census that only looked at install time would stop observing the moment either
   * happened. A device whose methods cannot be replaced is left alone and reported unobserved.
   *
   * Every method the device actually has must accept its hook. One accepted hook is not the
   * device: a host that binds `createRenderPipeline` as a non-writable property while leaving
   * `createComputePipeline` writable would otherwise report a complete census that never saw a
   * single render creation. A method the device does not have issues no work and is not missing.
   */
  #ensureDevice(backend: IBackendLike): void {
    if (this.#kind !== "webgpu" || !isObject(backend.device)) return;
    const device = backend.device;
    if (this.#devices.some((entry) => entry.device === device)) return;
    const restore: (() => void)[] = [];
    const refused: string[] = [];
    this.#patchIfPresent(
      device,
      "createShaderModule",
      (original) =>
        (...args: unknown[]) =>
          this.#observeShaderModule(device, original, args),
      restore,
      refused,
    );
    let observed = 0;
    for (const [name, kind, mode] of DEVICE_PIPELINE_METHODS) {
      if (
        this.#patchIfPresent(
          device,
          name,
          (original) =>
            (...args: unknown[]) =>
              this.#observeDeviceCreation(device, original, args, kind, mode),
          restore,
          refused,
        )
      )
        observed += 1;
    }
    // Nothing observable here: leave the device exactly as found and let it be reported
    // unobserved rather than partially, so a later retry can still take it.
    if (observed === 0) {
      for (const undo of restore) undo();
      return;
    }
    for (const name of refused) this.#deviceRefusals.add(name);
    this.#devices.push({ backend, device, restore });
    this.#deviceObserved = true;
  }

  /** Patch a method the device has, recording a refusal that must invalidate completeness. */
  #patchIfPresent(
    device: Record<string, unknown>,
    name: string,
    build: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
    restore: (() => void)[],
    refused: string[],
  ): boolean {
    if (typeof device[name] !== "function") return false;
    if (this.#patchMethod(device, name, build, restore)) return true;
    refused.push(name);
    return false;
  }

  #patchMethod(
    target: Record<string, unknown>,
    name: string,
    build: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
    restore: (() => void)[],
  ): boolean {
    const original = target[name];
    if (typeof original !== "function") return false;
    const previous = original as (...args: unknown[]) => unknown;
    // A browser device carries these on its prototype and a host binds them to the object itself.
    // Remember which, so teardown leaves the device exactly as it was found rather than pinning an
    // own copy of a prototype method.
    const owned = Object.hasOwn(target, name);
    const wrapper = build(previous);
    try {
      target[name] = wrapper;
    } catch {
      return false;
    }
    // A host may expose its bindings as non-writable properties; in that case the assignment is
    // silently or loudly refused and the census must report an unobserved device, not a green one.
    if (target[name] !== wrapper) return false;
    restore.push(() => {
      if (target[name] !== wrapper) return;
      if (owned) target[name] = previous;
      else delete target[name];
    });
    return true;
  }

  #restoreDevices(backend: IBackendLike): void {
    for (let index = this.#devices.length - 1; index >= 0; index -= 1) {
      const entry = this.#devices[index];
      if (entry === undefined || entry.backend !== backend) continue;
      for (const undo of entry.restore) undo();
      this.#devices.splice(index, 1);
    }
  }

  /** Install every renderer-side hook owned by this capture. */
  installRenderer(renderer: IRendererHookTarget): void {
    if (this.#cleanup !== undefined) return;
    const restoreBackend = this.install(renderer.backend);
    const restoreNodeBuilder = this.#installNodeBuilderObservation(renderer);
    const originalRenderObject = renderer.renderObject;
    let wrappedRenderObject: ((...args: unknown[]) => unknown) | undefined;
    if (originalRenderObject !== undefined) {
      const census = this;
      wrappedRenderObject = function (this: unknown, ...args: unknown[]): unknown {
        return census.withRenderObject(args, () => originalRenderObject.apply(this, args));
      };
      renderer.renderObject = wrappedRenderObject;
    }
    this.#cleanup = () => {
      restoreNodeBuilder();
      if (wrappedRenderObject !== undefined && renderer.renderObject === wrappedRenderObject)
        renderer.renderObject = originalRenderObject;
      restoreBackend();
      this.#cleanup = undefined;
    };
  }

  /** Restore private hooks while retaining the immutable capture already recorded. */
  dispose(): void {
    this.#cleanup?.();
  }

  /** Wrap Three's public render-object method so compileAsync retains the authored pass id. */
  withRenderObject<T>(args: readonly unknown[], callback: () => T): T {
    const previous = this.#activeRenderObject;
    const active: IActiveRenderObject = {
      clippingContext: args[7],
      object: args[0],
      material: args[4],
      scene: args[1],
      passId: args[8],
      nodeBuilds: 0,
    };
    this.#activeRenderObject = active;
    this.#observeWarmUpScopes(this.#matchingWarmUpScopes());
    try {
      return callback();
    } finally {
      this.#activeRenderObject = previous;
    }
  }

  #matchingWarmUpScopes(active = this.#activeRenderObject): readonly IMutableWarmUpScope[] {
    const activeObject = active?.object;
    if (
      active === undefined ||
      this.#activeWorldFrame?.root !== active.scene ||
      !isObject(activeObject) ||
      !isMainWorldPass(active.passId)
    )
      return NO_WARM_UP_SCOPES;
    return warmUpScopesOf(this.#warmUpTargets, activeObject);
  }

  #observeWarmUpScopes(scopes: readonly IMutableWarmUpScope[]): void {
    for (const scope of scopes) {
      if (scope.frameObserved) continue;
      scope.frameObserved = true;
      this.#frameWarmUpScopes.push(scope);
    }
  }

  /** Begin the outer world render that can close target-bound streamed warm-up scopes. */
  beginWorldFrame(root: object): void {
    this.#activeWorldFrame = { root };
  }

  /** Close target-bound scopes only after the complete visible world frame has returned. */
  endWorldFrame(root: object, completed: boolean): void {
    const frame = this.#activeWorldFrame;
    this.#activeWorldFrame = undefined;
    const matches = completed && frame !== undefined && frame.root === root;
    for (const scope of this.#frameWarmUpScopes) {
      if (matches && scope.firstDraw === undefined)
        scope.firstDraw = {
          nodeBuilds: scope.frameNodeBuilds,
          renderPipelineCreations: scope.frameRenderPipelineCreations,
        };
      scope.frameObserved = false;
      scope.frameNodeBuilds = 0;
      scope.frameRenderPipelineCreations = 0;
    }
    this.#frameWarmUpScopes = [];
  }

  /** Observe state creation at Three's renderer-owned NodeManager seam, never on the game Mesh. */
  #installNodeBuilderObservation(renderer: IRendererHookTarget): () => void {
    if (this.#kind !== "webgpu" || renderer.renderObject === undefined) return () => undefined;
    if (!isObject(renderer._nodes)) {
      this.#nodeBuilderObservationUnavailable = true;
      return () => undefined;
    }
    const nodes = renderer._nodes;
    const original = nodes.getForRender;
    if (typeof original !== "function") {
      this.#nodeBuilderObservationUnavailable = true;
      return () => undefined;
    }
    const census = this;
    const restore: (() => void)[] = [];
    const installed = this.#patchMethod(
      nodes,
      "getForRender",
      (method) =>
        function (this: unknown, ...args: unknown[]): unknown {
          const result = method.apply(this, args);
          return census.#observeNodeBuilderResult(args[0], result);
        },
      restore,
    );
    if (!installed) {
      this.#nodeBuilderObservationUnavailable = true;
      return () => undefined;
    }
    return () => {
      for (const undo of restore.splice(0).reverse()) undo();
    };
  }

  #observeNodeBuilderResult(renderObjectValue: unknown, result: unknown): unknown {
    if (isPromiseLike(result)) {
      return result.then((state: unknown) => {
        this.#recordNodeBuilderState(renderObjectValue, state);
        return state;
      });
    }
    this.#recordNodeBuilderState(renderObjectValue, result);
    return result;
  }

  #recordNodeBuilderState(renderObjectValue: unknown, state: unknown): void {
    if (!isObject(renderObjectValue) || !isObject(state)) {
      this.#nodeBuilderObservationUnavailable = true;
      return;
    }
    if (this.#nodeBuilderStates.has(state)) return;
    this.#nodeBuilderStates.add(state);
    this.#nodeBuilds += 1;
    const previous = this.#nodeBuilderObservations.get(renderObjectValue);
    const observation: INodeBuilderObservation =
      previous === undefined || previous.state !== state
        ? {
            state,
            builds: (previous?.builds ?? 0) + 1,
            reported: false,
          }
        : previous;
    this.#nodeBuilderObservations.set(renderObjectValue, observation);
    if (this.#activeRenderObject !== undefined) this.#activeRenderObject.nodeBuilds += 1;
    const startedMs = this.#clock();
    const matching = this.#matchingWarmUpScopes();
    this.#observeWarmUpScopes(matching);
    for (const scope of matching) scope.frameNodeBuilds += 1;
    const legacyScope =
      this.#activeWarmUpScope !== undefined && startedMs > this.#activeWarmUpScope.boundaryMs
        ? this.#activeWarmUpScope.label
        : undefined;
    const scopedLabel = matching.length === 1 ? matching[0]?.label : legacyScope;
    const record: IPipelineNodeBuild = {
      provenance: provenance(
        { object: this.#activeRenderObject?.object, material: this.#activeRenderObject?.material },
        this.#activeRenderObject,
      ),
      startedMs,
      beforeFirstPresent: this.#firstPresentMs === undefined || startedMs <= this.#firstPresentMs,
      ...(this.#warmUpSettledMs === undefined
        ? {}
        : { beforeWarmUpSettled: startedMs <= this.#warmUpSettledMs }),
      ...(scopedLabel === undefined ? {} : { afterWarmUpScope: scopedLabel }),
    };
    if (this.#nodeBuildEvents.length < this.#limit) this.#nodeBuildEvents.push(record);
    else this.#droppedNodeBuilds += 1;
  }

  #nodeBuildsFor(renderObjectValue: IRenderObjectLike | undefined): number {
    if (!isObject(renderObjectValue)) return this.#activeRenderObject?.nodeBuilds ?? 0;
    const observation = this.#nodeBuilderObservations.get(renderObjectValue);
    if (observation === undefined || observation.reported) return 0;
    observation.reported = true;
    return observation.builds;
  }

  /** Mark the first renderer render call as the first-present boundary. */
  firstPresent(): void {
    if (this.#firstPresentMs !== undefined) return;
    const boundaryMs = this.#clock();
    this.#firstPresentMs = boundaryMs;
    this.#eventsSettledAtFirstPresent = this.#events.filter(
      (event) => event.settledMs !== undefined && event.settledMs <= boundaryMs,
    ).length;
  }

  /** Mark the explicit shader warm-up as settled before the first measured world pass. */
  warmUpSettled(): void {
    if (this.#warmUpSettledMs !== undefined) return;
    const boundaryMs = this.#clock();
    this.#warmUpSettledMs = boundaryMs;
    this.#eventsSettledAtWarmUpSettled = this.#events.filter(
      (event) => event.settledMs !== undefined && event.settledMs <= boundaryMs,
    ).length;
    this.#nodeBuildsAtWarmUpSettled = this.#nodeBuilds;
    this.#renderPipelineCreationsAtWarmUpSettled = this.#events.filter(
      (event) =>
        event.kind === "render" &&
        event.status === "created" &&
        event.settledMs !== undefined &&
        event.settledMs <= boundaryMs,
    ).length;
    for (const event of this.#events) {
      if (event.settledMs !== undefined) event.beforeWarmUpSettled = event.settledMs <= boundaryMs;
    }
    for (const nodeBuild of this.#nodeBuildEvents)
      Object.assign(nodeBuild, { beforeWarmUpSettled: nodeBuild.startedMs <= boundaryMs });
  }

  /** Mark one repeatable streamed warm-up boundary; target-bound scopes close on their first world frame. */
  warmUpScopeSettled(label: string, target?: object): void {
    if (label.trim() === "") throw new Error("TN_PIPELINE_CENSUS_SCOPE_INVALID: empty label");
    const boundaryMs = this.#clock();
    const scope: IMutableWarmUpScope = {
      label,
      boundaryMs,
      eventsSettled: this.#events.filter(
        (event) => event.settledMs !== undefined && event.settledMs <= boundaryMs,
      ).length,
      nodeBuilds: this.#nodeBuilds,
      renderPipelineCreations: this.#events.filter(
        (event) =>
          event.kind === "render" &&
          event.status === "created" &&
          event.settledMs !== undefined &&
          event.settledMs <= boundaryMs,
      ).length,
      frameObserved: false,
      frameNodeBuilds: 0,
      frameRenderPipelineCreations: 0,
    };
    this.#warmUpScopes.push(scope);
    if (target !== undefined) {
      const scopes = this.#warmUpTargets.get(target);
      if (scopes === undefined) this.#warmUpTargets.set(target, [scope]);
      else scopes.push(scope);
    }
    if (target === undefined) this.#activeWarmUpScope = { label, boundaryMs };
  }

  snapshot(): IPipelineCensus {
    const incompleteReasons: string[] = [];
    if (this.#unsupported) incompleteReasons.push("backend creation observation unavailable");
    if (this.#nodeBuilderObservationUnavailable)
      incompleteReasons.push("node builder observation unavailable");
    incompleteReasons.push(...this.#deviceReasons());
    if (this.#adapterIdentity === "unavailable")
      incompleteReasons.push("adapter identity unavailable");
    if (this.#overflowed) incompleteReasons.push("bounded event buffer overflowed");
    if (this.#droppedNodeBuilds > 0) incompleteReasons.push("bounded node-build buffer overflowed");
    if (this.#pending > 0) incompleteReasons.push(`${this.#pending} pipeline event(s) are pending`);
    if (this.#failures > 0) incompleteReasons.push(`${this.#failures} pipeline creation(s) failed`);
    if (this.#creations === 0) incompleteReasons.push("no pipeline creations observed");
    for (const event of this.#events) {
      if (event.kind === "render" && event.vertex === undefined)
        incompleteReasons.push("a render pipeline is missing its vertex shader observation");
      if (
        event.kind === "render" &&
        event.fragmentStagePresent === true &&
        event.fragment === undefined
      )
        incompleteReasons.push("a render pipeline is missing its fragment shader observation");
      if (event.kind === "compute" && event.compute === undefined)
        incompleteReasons.push("a compute pipeline is missing its shader observation");
    }
    if (this.#creations !== this.#events.length + this.#dropped)
      incompleteReasons.push("observed creation count does not reconcile with recorded events");
    const events = this.#events.map((event) => freezeEvent(event));
    return {
      version: PIPELINE_CENSUS_VERSION,
      complete: incompleteReasons.length === 0 && this.#creations > 0,
      overflowed: this.#overflowed,
      unsupported: this.#unsupported,
      limit: this.#limit,
      clock: { originMs: this.#origin, source: this.#clockSource },
      backend: { kind: this.#kind, identity: this.#backendIdentity },
      build: { identity: this.#buildIdentity },
      adapter: { identity: this.#adapterIdentity, thermal: this.#thermalIdentity },
      ...(this.#firstPresentMs === undefined
        ? {}
        : {
            firstPresent: {
              boundaryMs: this.#firstPresentMs,
              eventsSettled: this.#eventsSettledAtFirstPresent,
            },
          }),
      ...(this.#warmUpSettledMs === undefined
        ? {}
        : {
            warmUpSettled: {
              boundaryMs: this.#warmUpSettledMs,
              eventsSettled: this.#eventsSettledAtWarmUpSettled,
              nodeBuilds: this.#nodeBuildsAtWarmUpSettled,
              renderPipelineCreations: this.#renderPipelineCreationsAtWarmUpSettled,
            },
          }),
      ...(this.#warmUpScopes.length === 0
        ? {}
        : {
            warmUpScopes: this.#warmUpScopes.map((scope) => ({
              label: scope.label,
              boundaryMs: scope.boundaryMs,
              eventsSettled: scope.eventsSettled,
              nodeBuilds: scope.nodeBuilds,
              renderPipelineCreations: scope.renderPipelineCreations,
              ...(scope.firstDraw === undefined ? {} : { firstDraw: { ...scope.firstDraw } }),
            })),
          }),
      counts: {
        lookups: this.#lookups,
        creations: this.#creations,
        failures: this.#failures,
        pending: this.#pending,
        uniquePrograms: this.#programs.size,
        uniquePipelines: this.#pipelines.size,
        recordedEvents: this.#events.length,
        droppedEvents: this.#dropped,
        nodeBuilds: this.#nodeBuilds,
        ...this.#deviceCounts(),
      },
      events,
      ...(this.#nodeBuildEvents.length === 0 && this.#nodeBuilds === 0
        ? {}
        : { nodeBuilds: this.#nodeBuildEvents.map((entry) => freezeNodeBuild(entry)) }),
      incompleteReasons,
    };
  }

  #clock(): number {
    return Math.max(0, this.#now() - this.#origin);
  }

  /**
   * Three creates pipelines the backend never sees, so a capture that never reached the device
   * cannot claim it counted them, however many backend events it holds. A creation nested inside
   * a backend creation is attributed to that backend event, and is reported here so the extra
   * device call is never quietly dropped from the total. A device observed through some of its
   * methods is short by whatever went through the rest, and says which method it was.
   */
  #deviceReasons(): string[] {
    const reasons: string[] = [];
    if (this.#kind === "webgpu" && !this.#deviceObserved)
      reasons.push("device creation observation unavailable");
    for (const name of [...this.#deviceRefusals].sort())
      reasons.push(`device method ${name} could not be observed`);
    if (this.#nestedDeviceCreations > 0)
      reasons.push(
        `${this.#nestedDeviceCreations} device pipeline creation(s) were nested inside a backend creation`,
      );
    return reasons;
  }

  #deviceCounts(): { deviceCreations?: number; directCreations?: number } {
    if (!this.#deviceObserved) return {};
    return { deviceCreations: this.#deviceCreations, directCreations: this.#directCreations };
  }

  #observeRenderCreation(
    backend: IBackendLike,
    original: (...args: unknown[]) => unknown,
    args: readonly unknown[],
  ): unknown {
    this.#ensureDevice(backend);
    const renderObject = isObject(args[0]) ? (args[0] as IRenderObjectLike) : {};
    const pipeline = isObject(renderObject.pipeline)
      ? (renderObject.pipeline as IPipelineLike)
      : undefined;
    const vertex = this.#programObservation(backend, pipeline?.vertexProgram);
    const fragment = this.#programObservation(backend, pipeline?.fragmentProgram);
    const event = this.#beginEvent({
      backend,
      kind: "render",
      pipeline,
      vertex,
      fragment,
      ...(pipeline === undefined
        ? {}
        : {
            fragmentStagePresent:
              pipeline.fragmentProgram !== undefined && pipeline.fragmentProgram !== null,
          }),
      renderObject,
      mode: args[1] === null ? "sync" : "async",
    });
    const started = this.#now();
    try {
      const result = this.#throughBackend(() => original.apply(backend, [...args]));
      const promises = asyncPromises(args[1]);
      if (promises.length > 0) {
        event.mode = "async";
        event.status = "pending";
        event.pending = true;
        this.#pending += 1;
        void Promise.all(promises).then(
          () => this.#settleEvent(backend, event, started, undefined),
          (error: unknown) => this.#settleEvent(backend, event, started, error),
        );
      } else {
        this.#settleEvent(backend, event, started, undefined);
      }
      return result;
    } catch (error) {
      this.#settleEvent(backend, event, started, error);
      throw error;
    }
  }

  #observeComputeCreation(
    backend: IBackendLike,
    original: (...args: unknown[]) => unknown,
    args: readonly unknown[],
  ): unknown {
    this.#ensureDevice(backend);
    const pipeline = isObject(args[0]) ? (args[0] as IPipelineLike) : undefined;
    const compute = this.#programObservation(backend, pipeline?.computeProgram);
    const event = this.#beginEvent({
      backend,
      kind: "compute",
      pipeline,
      compute,
      renderObject: undefined,
      mode: asyncPromises(args[2]).length > 0 ? "async" : "sync",
    });
    const started = this.#now();
    try {
      const result = this.#throughBackend(() => original.apply(backend, [...args]));
      // Three creates a compute pipeline asynchronously when it is handed a compilation promise
      // list, which is what `compileComputeAsync` does (src/renderers/common/Renderer.js:1359), and
      // installs the handle only when that promise resolves. Read it then, not before: three calls
      // the device synchronously in both paths, so the settle order is the only difference.
      const promises = asyncPromises(args[2]);
      if (promises.length > 0) {
        event.mode = "async";
        event.status = "pending";
        event.pending = true;
        this.#pending += 1;
        void Promise.all(promises).then(
          () => this.#settleEvent(backend, event, started, undefined),
          (error: unknown) => this.#settleEvent(backend, event, started, error),
        );
      } else {
        this.#settleEvent(backend, event, started, undefined);
      }
      return result;
    } catch (error) {
      this.#settleEvent(backend, event, started, error);
      throw error;
    }
  }

  /**
   * Run a backend creation with its device calls attributed to it. Three reaches the device
   * synchronously in both paths — `createRenderPipelineAsync` is called before the first `await`
   * of the promise it hands back — so the depth is enough to tell a delegated creation from a
   * direct one, and a second device call inside one backend creation is reported rather than lost.
   */
  #throughBackend<T>(callback: () => T): T {
    const previousCalls = this.#backendDeviceCalls;
    this.#backendDepth += 1;
    this.#backendDeviceCalls = 0;
    try {
      return callback();
    } finally {
      if (this.#backendDeviceCalls > 1) this.#nestedDeviceCreations += this.#backendDeviceCalls - 1;
      this.#backendDepth -= 1;
      this.#backendDeviceCalls = previousCalls;
    }
  }

  #observeShaderModule(
    device: Record<string, unknown>,
    original: (...args: unknown[]) => unknown,
    args: readonly unknown[],
  ): unknown {
    const result = original.apply(device, [...args]);
    const descriptor = isObject(args[0]) ? args[0] : undefined;
    const code = typeof descriptor?.code === "string" ? descriptor.code : undefined;
    if (code !== undefined && isObject(result) && !this.#observations.has(result))
      this.#observations.set(result, { bytes: utf8Bytes(code), hash: hashText(code) });
    return result;
  }

  #observeDeviceCreation(
    device: Record<string, unknown>,
    original: (...args: unknown[]) => unknown,
    args: readonly unknown[],
    kind: "compute" | "render",
    mode: PipelineCensusMode,
  ): unknown {
    this.#deviceCreations += 1;
    if (this.#backendDepth > 0) {
      this.#backendDeviceCalls += 1;
      return original.apply(device, [...args]);
    }
    const descriptor = isObject(args[0]) ? args[0] : {};
    const label = typeof descriptor.label === "string" ? descriptor.label : undefined;
    const event = this.#beginEvent({
      kind,
      pipeline: undefined,
      ...(kind === "compute"
        ? { compute: this.#stageObservation(descriptor.compute) }
        : {
            vertex: this.#stageObservation(descriptor.vertex),
            fragment: this.#stageObservation(descriptor.fragment),
            fragmentStagePresent: descriptor.fragment !== undefined && descriptor.fragment !== null,
          }),
      renderObject: undefined,
      // The mode describes what the call did, not which method was named: an async method that
      // returns no promise settled synchronously and is timed as the device call it was.
      mode: "sync",
      direct: true,
      ...(label === undefined || label.length === 0 ? {} : { label }),
    });
    this.#directCreations += 1;
    const started = this.#now();
    try {
      const result = original.apply(device, [...args]);
      const promise = mode === "async" && isPromiseLike(result) ? result : undefined;
      if (promise !== undefined) {
        event.mode = "async";
        event.status = "pending";
        event.pending = true;
        this.#pending += 1;
        void promise.then(
          (handle: unknown) => {
            event.deviceHandle = handle;
            this.#settleEvent(undefined, event, started, undefined);
          },
          (error: unknown) => this.#settleEvent(undefined, event, started, error),
        );
        return result;
      }
      event.deviceHandle = result;
      this.#settleEvent(undefined, event, started, undefined);
      return result;
    } catch (error) {
      this.#settleEvent(undefined, event, started, error);
      throw error;
    }
  }

  #beginEvent(input: {
    readonly backend?: IBackendLike;
    readonly kind: "compute" | "render";
    readonly pipeline: IPipelineLike | undefined;
    readonly vertex?: IPipelineShaderObservation;
    readonly fragment?: IPipelineShaderObservation;
    readonly fragmentStagePresent?: boolean;
    readonly compute?: IPipelineShaderObservation;
    readonly renderObject: IRenderObjectLike | undefined;
    readonly mode: PipelineCensusMode;
    readonly direct?: boolean;
    readonly label?: string;
  }): IMutableCensusEvent {
    this.#creations += 1;
    const matching =
      input.kind === "render" && input.direct !== true ? this.#matchingWarmUpScopes() : [];
    this.#observeWarmUpScopes(matching);
    for (const scope of matching) scope.frameRenderPipelineCreations += 1;
    // A direct creation has no logical Three pipeline to be identified by, and one shared
    // placeholder would make two of them look like one. Each takes its own until its handle lands.
    const pipelineIdentity =
      input.direct === true
        ? `device-pipeline-${this.#nextDevicePipelineIdentity++}`
        : this.#logicalIdentity(input.pipeline);
    const programIdentity =
      input.kind === "compute"
        ? (input.compute?.hash ?? "unknown")
        : `${input.vertex?.hash ?? "unknown"}/${input.fragment?.hash ?? "unknown"}`;
    this.#programs.add(programIdentity);
    this.#pipelines.add(pipelineIdentity);
    const event: IMutableCensusEvent = {
      sequence: this.#nextSequence++,
      programIdentity,
      pipelineIdentity,
      kind: input.kind,
      ...this.#attribution(input.kind, input.direct === true, input.renderObject),
      mode: input.mode,
      status: input.mode === "async" ? "pending" : "created",
      ...(input.vertex === undefined ? {} : { vertex: input.vertex }),
      ...(input.fragment === undefined ? {} : { fragment: input.fragment }),
      ...(input.fragmentStagePresent === undefined
        ? {}
        : { fragmentStagePresent: input.fragmentStagePresent }),
      ...(input.compute === undefined ? {} : { compute: input.compute }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.kind === "render" && input.direct !== true
        ? { nodeBuilds: this.#nodeBuildsFor(input.renderObject) }
        : {}),
      ...(matching.length === 1 && matching[0] !== undefined
        ? { afterWarmUpScope: matching[0].label }
        : {}),
      startedMs: this.#clock(),
      backendPipeline: input.pipeline,
      ...(input.direct === true ? { direct: true } : {}),
    };
    if (this.#events.length < this.#limit) this.#events.push(event);
    else {
      this.#overflowed = true;
      this.#dropped += 1;
    }
    return event;
  }

  /**
   * Who a creation belongs to. A texture can upload while a mesh is drawing, so the render object
   * in flight is not a direct creation's author: it reports what it knows — the device label it
   * already carries — and says the rest is unknown rather than borrowing a pass and a material it
   * never had.
   */
  #attribution(
    kind: "compute" | "render",
    direct: boolean,
    renderObject: IRenderObjectLike | undefined,
  ): { pass: string; provenance: IPipelineProvenance; reasons: readonly string[] } {
    if (direct)
      return {
        pass: kind === "compute" ? "compute" : "unknown",
        provenance: { unknown: true },
        reasons: ["device-direct-creation"],
      };
    return {
      pass:
        kind === "compute"
          ? "compute"
          : resolvePass(
              this.#activeRenderObject?.passId,
              this.#activeRenderObject?.material,
              this.#activeRenderObject?.clippingContext,
              renderObject?.material,
            ),
      provenance: provenance(renderObject, this.#activeRenderObject),
      reasons: structuralReasons(renderObject?.object, renderObject?.material),
    };
  }

  #settleEvent(
    backend: IBackendLike | undefined,
    event: IMutableCensusEvent,
    started: number,
    error: unknown,
  ): void {
    const settledAt = this.#clock();
    event.settledMs = settledAt;
    event.beforeFirstPresent =
      this.#firstPresentMs === undefined || settledAt <= this.#firstPresentMs;
    if (this.#warmUpSettledMs !== undefined)
      event.beforeWarmUpSettled = settledAt <= this.#warmUpSettledMs;
    if (
      event.afterWarmUpScope === undefined &&
      this.#activeWarmUpScope !== undefined &&
      settledAt > this.#activeWarmUpScope.boundaryMs
    )
      event.afterWarmUpScope = this.#activeWarmUpScope.label;
    if (event.pending === true) {
      event.pending = false;
      this.#pending = Math.max(0, this.#pending - 1);
    }
    if (event.mode === "async") event.promiseMs = Math.max(0, this.#now() - started);
    else event.serviceMs = Math.max(0, this.#now() - started);
    if (error !== undefined) {
      event.status = "failed";
      event.error = error instanceof Error ? error.message : String(error);
      this.#failures += 1;
      return;
    }
    // A direct creation carries the handle the device returned; a backend one has to be read back
    // out of Three's data map, where async data is installed before its promise resolves. Either
    // way a missing handle means nothing usable was created; do not report green.
    const pipeline =
      event.direct === true
        ? event.deviceHandle
        : this.#backendPipeline(backend, event.backendPipeline);
    if (pipeline === undefined && this.#kind === "webgpu") {
      event.status = "failed";
      event.error =
        event.direct === true
          ? `device did not return a created ${event.kind} pipeline`
          : `backend did not expose a created ${event.kind} pipeline`;
      this.#failures += 1;
      return;
    }
    if (pipeline !== undefined && this.#kind === "webgpu") {
      this.#replacePipelineIdentity(event, this.#backendPipelineIdentity(pipeline, event.kind));
    }
    // The identity is recorded, so let the GPU pipeline go; a census must not be why one stays alive.
    event.deviceHandle = undefined;
    event.status = "created";
  }

  /**
   * Shader identity for a Three programmable stage, hashed once per stage rather than per use.
   *
   * The module was already hashed when the device made it, and Three keeps that same object at
   * `backend.get(stage).module.module` — the seam `WebGPUPipelineUtils` reads to build the
   * pipeline descriptor. Reuse it and the source is never hashed twice. A backend that exposes
   * no module for the stage (WebGL2, or a device hooked after its modules were built) falls back
   * to hashing the stage source, still once, cached on the stage object rather than by its text.
   */
  #programObservation(
    backend: IBackendLike | undefined,
    program: IProgramLike | undefined,
  ): IPipelineShaderObservation | undefined {
    if (!isObject(program)) return undefined;
    const cached = this.#observations.get(program);
    if (cached !== undefined) return cached;
    const shared = this.#moduleObservation(backend, program);
    const observed = shared ?? shaderObservation(program as IProgramLike);
    if (observed !== undefined) this.#observations.set(program, observed);
    return observed;
  }

  /** The observation of the shader module Three built for a stage, when the hooks recorded one. */
  #moduleObservation(
    backend: IBackendLike | undefined,
    program: object,
  ): IPipelineShaderObservation | undefined {
    if (typeof backend?.get !== "function") return undefined;
    let stage: unknown;
    try {
      const data = backend.get(program);
      stage = isObject(data) ? data.module : undefined;
    } catch {
      return undefined;
    }
    if (!isObject(stage)) return undefined;
    // Three wraps the module as `{ module, entryPoint }`; tolerate a backend that stores it bare.
    return this.#observations.get(isObject(stage.module) ? stage.module : stage);
  }

  /** Shader identity for a device stage descriptor, absent when its module predates the hooks. */
  #stageObservation(stage: unknown): IPipelineShaderObservation | undefined {
    const module = isObject(stage) ? stage.module : undefined;
    return isObject(module) ? this.#observations.get(module) : undefined;
  }

  #backendPipeline(backend: IBackendLike | undefined, pipeline: unknown): unknown {
    // The event's identity is the logical Three pipeline, while WebGPU's DataMap carries the
    // opaque device handle. Read that data only after creation; a missing handle is a failed
    // creation, not a guessed success. WebGL's fallback has a different backend data shape and is
    // explicitly marked unsupported by the census, so it does not pretend to reconcile GPU keys.
    if (this.#kind !== "webgpu") return pipeline === undefined ? undefined : pipeline;
    if (typeof backend?.get !== "function" || pipeline === undefined) return undefined;
    this.#lookups += 1;
    try {
      const data = backend.get(pipeline);
      return isObject(data) && data.pipeline !== undefined && data.pipeline !== null
        ? data.pipeline
        : undefined;
    } catch {
      return undefined;
    }
  }

  #logicalIdentity(pipeline: IPipelineLike | undefined): string {
    const candidate = pipeline as unknown;
    if (isObject(candidate)) {
      const existing = this.#pipelineIds.get(candidate);
      if (existing !== undefined) return existing;
      const identity = `logical-pipeline-${this.#nextLogicalPipelineIdentity++}`;
      this.#pipelineIds.set(candidate, identity);
      return identity;
    }
    const cacheKey = typeof pipeline?.cacheKey === "string" ? pipeline.cacheKey : undefined;
    if (cacheKey !== undefined) return `cache-${hashText(cacheKey)}`;
    return "logical-pipeline-unknown";
  }

  #backendPipelineIdentity(pipeline: unknown, kind: "render" | "compute"): string {
    if (!isObject(pipeline)) return "backend-pipeline-unknown";
    // Native wrappers expose the same handle that their compile events report. Preserve it so
    // diagnostic tools can join exact creations, including state variants of the same program.
    const nativeId = pipeline._pipelineId;
    if (typeof nativeId === "number" && Number.isSafeInteger(nativeId) && nativeId > 0) {
      return `native-${kind}-${nativeId}`;
    }
    const existing = this.#backendPipelineIds.get(pipeline);
    if (existing !== undefined) return existing;
    const identity = `backend-pipeline-${this.#nextBackendPipelineIdentity++}`;
    this.#backendPipelineIds.set(pipeline, identity);
    return identity;
  }

  #replacePipelineIdentity(event: IMutableCensusEvent, identity: string): void {
    if (event.pipelineIdentity === identity) return;
    this.#pipelines.delete(event.pipelineIdentity);
    event.pipelineIdentity = identity;
    this.#pipelines.add(identity);
  }
}

function defaultNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shaderObservation(
  program: IProgramLike | undefined,
): IPipelineShaderObservation | undefined {
  const code = program?.code;
  if (typeof code !== "string") return undefined;
  return { bytes: utf8Bytes(code), hash: hashText(code) };
}

function utf8Bytes(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}

/** Stable non-cryptographic identity; the full shader is intentionally never retained. */
function hashText(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(value)
      : [...unescape(encodeURIComponent(value))].map((character) => character.charCodeAt(0));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === "function";
}

function isMainWorldPass(passId: unknown): boolean {
  return passId === undefined || passId === null || passId === "main";
}

const NO_WARM_UP_SCOPES: readonly IMutableWarmUpScope[] = [];

/** Scopes bound to the value, its `tnChunkRoot`, or any ancestor: O(depth) lookups per draw. */
function warmUpScopesOf(
  targets: WeakMap<object, IMutableWarmUpScope[]>,
  value: object,
): readonly IMutableWarmUpScope[] {
  const userData = (value as { userData?: unknown }).userData;
  const chunkRoot = isObject(userData) ? userData.tnChunkRoot : undefined;
  let found = addWarmUpScopes(undefined, targets.get(value));
  if (isObject(chunkRoot)) found = addWarmUpScopes(found, targets.get(chunkRoot));
  for (
    let current = (value as { parent?: unknown }).parent;
    isObject(current);
    current = (current as { parent?: unknown }).parent
  )
    found = addWarmUpScopes(found, targets.get(current));
  return found ?? NO_WARM_UP_SCOPES;
}

function addWarmUpScopes(
  found: IMutableWarmUpScope[] | undefined,
  scopes: readonly IMutableWarmUpScope[] | undefined,
): IMutableWarmUpScope[] | undefined {
  if (scopes === undefined) return found;
  const next = found ?? [];
  for (const scope of scopes) if (!next.includes(scope)) next.push(scope);
  return next;
}

function asyncPromises(value: unknown): Promise<unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice()
    .filter(
      (candidate): candidate is Promise<unknown> =>
        isObject(candidate) && typeof (candidate as { then?: unknown }).then === "function",
    );
}

function resolvePass(
  passId: unknown,
  material: unknown,
  clippingContext?: unknown,
  secondaryMaterial?: unknown,
): string {
  if (typeof passId === "string" && passId.length > 0) return passId;
  const clippingRecord = isObject(clippingContext) ? clippingContext : undefined;
  if (clippingRecord?.shadowPass === true) return "shadow";
  for (const candidate of [secondaryMaterial, material]) {
    const materialRecord = isObject(candidate) ? candidate : undefined;
    if (
      materialRecord !== undefined &&
      (materialRecord.isShadowPassMaterial === true || isShadowMaterial(materialRecord))
    )
      return "shadow";
    const name = typeof materialRecord?.name === "string" ? materialRecord.name : "";
    if (/^PMREM_/u.test(name)) return "pmrem";
    if (name === "outputColorTransform" || name === "RenderPipeline") return "output";
  }
  if (clippingContext !== undefined && clippingContext !== null) return "main-clipped";
  return "main";
}

function isShadowMaterial(material: Record<string, unknown>): boolean {
  const type = typeof material.type === "string" ? material.type : "";
  const name = typeof material.name === "string" ? material.name : "";
  return /shadow|depth/u.test(`${type} ${name}`);
}

function provenance(
  renderObject: IRenderObjectLike | undefined,
  active: IActiveRenderObject | undefined,
): IPipelineProvenance {
  const material = active?.material ?? renderObject?.material;
  const object = active?.object ?? renderObject?.object;
  const materialRecord = isObject(material) ? material : undefined;
  const objectRecord = isObject(object) ? object : undefined;
  const materialValue =
    materialRecord === undefined
      ? undefined
      : {
          ...(finiteNumber(materialRecord.id) ? { id: materialRecord.id } : {}),
          ...(typeof materialRecord.name === "string" && materialRecord.name.length > 0
            ? { name: materialRecord.name }
            : {}),
          ...(typeof materialRecord.type === "string" ? { type: materialRecord.type } : {}),
        };
  const objectValue =
    objectRecord === undefined
      ? undefined
      : {
          ...(finiteNumber(objectRecord.id) ? { id: objectRecord.id } : {}),
          ...(typeof objectRecord.name === "string" && objectRecord.name.length > 0
            ? { name: objectRecord.name }
            : {}),
          ...(typeof objectRecord.uuid === "string" ? { uuid: objectRecord.uuid } : {}),
        };
  return {
    ...(materialValue === undefined ? {} : { material: materialValue }),
    ...(objectValue === undefined ? {} : { object: objectValue }),
    unknown: materialValue === undefined && objectValue === undefined,
  };
}

function structuralReasons(object: unknown, material: unknown): string[] {
  const reasons: string[] = [];
  const objectRecord = isObject(object) ? object : undefined;
  const materialRecord = isObject(material) ? material : undefined;
  if (objectRecord?.isSkinnedMesh === true || materialRecord?.skinning === true)
    reasons.push("skinning");
  if (objectRecord?.isInstancedMesh === true) reasons.push("instancing");
  if (materialRecord !== undefined) {
    for (const [key, label] of [
      ["map", "map"],
      ["normalMap", "normal-map"],
      ["roughnessMap", "roughness-map"],
      ["metalnessMap", "metalness-map"],
      ["alphaMap", "alpha-map"],
      ["envMap", "environment-map"],
      ["clipping", "clipping"],
    ] as const) {
      if (
        materialRecord[key] !== undefined &&
        materialRecord[key] !== null &&
        materialRecord[key] !== false
      )
        reasons.push(label);
    }
  }
  if (reasons.length === 0) reasons.push("unknown-structural-difference");
  return reasons;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function freezeEvent(event: IMutableCensusEvent): IPipelineCensusEvent {
  return {
    sequence: event.sequence,
    programIdentity: event.programIdentity,
    pipelineIdentity: event.pipelineIdentity,
    kind: event.kind,
    pass: event.pass,
    mode: event.mode,
    status: event.status,
    ...(event.vertex === undefined ? {} : { vertex: { ...event.vertex } }),
    ...(event.fragment === undefined ? {} : { fragment: { ...event.fragment } }),
    ...(event.compute === undefined ? {} : { compute: { ...event.compute } }),
    provenance: {
      ...(event.provenance.material === undefined
        ? {}
        : { material: { ...event.provenance.material } }),
      ...(event.provenance.object === undefined ? {} : { object: { ...event.provenance.object } }),
      unknown: event.provenance.unknown,
    },
    ...(event.label === undefined ? {} : { label: event.label }),
    reasons: [...event.reasons],
    startedMs: event.startedMs,
    ...(event.settledMs === undefined ? {} : { settledMs: event.settledMs }),
    ...(event.serviceMs === undefined ? {} : { serviceMs: event.serviceMs }),
    ...(event.promiseMs === undefined ? {} : { promiseMs: event.promiseMs }),
    ...(event.error === undefined ? {} : { error: event.error }),
    ...(event.nodeBuilds === undefined ? {} : { nodeBuilds: event.nodeBuilds }),
    ...(event.beforeFirstPresent === undefined
      ? {}
      : { beforeFirstPresent: event.beforeFirstPresent }),
    ...(event.beforeWarmUpSettled === undefined
      ? {}
      : { beforeWarmUpSettled: event.beforeWarmUpSettled }),
    ...(event.afterWarmUpScope === undefined ? {} : { afterWarmUpScope: event.afterWarmUpScope }),
  };
}

function freezeNodeBuild(entry: IPipelineNodeBuild): IPipelineNodeBuild {
  return {
    provenance: {
      ...(entry.provenance.material === undefined
        ? {}
        : { material: { ...entry.provenance.material } }),
      ...(entry.provenance.object === undefined ? {} : { object: { ...entry.provenance.object } }),
      unknown: entry.provenance.unknown,
    },
    startedMs: entry.startedMs,
    ...(entry.beforeFirstPresent === undefined
      ? {}
      : { beforeFirstPresent: entry.beforeFirstPresent }),
    ...(entry.beforeWarmUpSettled === undefined
      ? {}
      : { beforeWarmUpSettled: entry.beforeWarmUpSettled }),
    ...(entry.afterWarmUpScope === undefined ? {} : { afterWarmUpScope: entry.afterWarmUpScope }),
  };
}
