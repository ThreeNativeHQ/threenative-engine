import {
  Box2,
  Box3,
  type Camera,
  type CoordinateSystem,
  CubeCamera,
  Mesh,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
} from "three";
import {
  Fn,
  clamp,
  cubeTexture,
  float,
  floor,
  int,
  normalWorld,
  normalize,
  positionWorld,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportCoordinate,
} from "three/tsl";
import {
  ClampToEdgeWrapping,
  CubeRenderTarget,
  Data3DTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NodeMaterial,
  RGBAFormat,
  RenderTarget,
  RenderTarget3D,
} from "three/webgpu";
import type { Node } from "three/webgpu";
import type { IComputeDriven } from "../compute-driven.js";
import type { IRendererLike } from "../renderer.js";

/** The atlas has one copied edge texel on either side of each packed SH sub-volume. */
export const ATLAS_PADDING = 1;

/** The machine-readable marker emitted whenever the probe state changes. */
export const PROBE_VOLUME_MARKER = "TN_PROBE_VOLUME";

const SH_COEFFICIENT_COUNT = 9;
const SH_CHANNEL_COUNT = 3;
const PACKED_SUB_VOLUME_COUNT = 7;
const CUBE_FACE_COUNT = 6;
const CAPTURE_WORK_ITEMS_PER_PROBE = CUBE_FACE_COUNT + 2;
// The upstream shader ABI always samples a one-texel-padded layout. Keeping this independent from
// the storage constant makes a storage mutation observable at the public sampling boundary.
const SAMPLE_ATLAS_PADDING = 1;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;
const BYTES_PER_TEXEL = 4 * BYTES_PER_FLOAT;
const BAKE_BUDGET_SLACK_MS = 0.5;
const SCENE_WARMUP_TIMEOUT_MS = 2_000;

type IVector3Like = { readonly x: number; readonly y: number; readonly z: number };
type IProbePosition = Vector3 | Node<"vec3">;

/** One RGB L2 spherical-harmonic coefficient, in the upstream probe ordering. */
export interface IProbeVolumeCoefficient {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Probe density in probes per world unit, either isotropic or per-axis. */
export type ProbeVolumeDensity = number | readonly [number, number, number] | IVector3Like;

export interface IProbeVolumeOptions {
  /** World-space bounds; the volume does not move with the object after construction. */
  readonly bounds: Box3 | { readonly min: IVector3Like; readonly max: IVector3Like };
  /** Probe spacing expressed as probes per world unit. */
  readonly density: ProbeVolumeDensity;
  /** Optional device limit supplied by a host that knows it before construction. */
  readonly maxTextureDimension3D?: number;
  /** Alias for integrations that expose the WebGPU limit under a device-oriented name. */
  readonly deviceTextureLimit?: number;
  /** Maximum wall-clock work per render phase, in milliseconds. */
  readonly bakeBudgetMs?: number;
  /** Additional guard that keeps a clock-less host from processing an unbounded queue. */
  readonly maxWorkItemsPerFrame?: number;
  /** Resolution of each captured cube face. The static-lighting default is intentionally small. */
  readonly cubemapSize?: number;
  readonly near?: number;
  readonly far?: number;
  /** Additional indirect passes after the direct-light pass. */
  readonly bounces?: number;
  /** Injectable clock for deterministic scheduling tests. */
  readonly now?: () => number;
  readonly report?: (line: string) => void;
}

export interface IProbeVolumeBakeProgress {
  readonly completed: number;
  readonly total: number;
  readonly fraction: number;
  readonly probesCompleted: number;
  readonly probesTotal: number;
  readonly pass: number;
  readonly passes: number;
}

export interface IProbeVolumeObservation {
  readonly marker: typeof PROBE_VOLUME_MARKER;
  readonly status: "unbaked" | "baking" | "ready";
  readonly stale: boolean;
  readonly unbaked: boolean;
  /** `null` means no completed bake has established an age yet. */
  readonly stalenessFrames: number | null;
  readonly probeCount: number;
  readonly atlasBytes: number;
  readonly atlas: { readonly width: number; readonly height: number; readonly depth: number };
  readonly bakeProgress: IProbeVolumeBakeProgress;
  /** Wall-clock time spent by the most recent incremental render-phase slice. */
  readonly bakeCostMs: number;
  readonly bakeBudgetMs: number;
  /** True while pass zero samples a black texture instead of a previous bake. */
  readonly samplingIsolated: boolean;
}

/** Read a complete marker-shaped observation without accepting malformed data. */
export function readProbeVolumeObservation(value: unknown): IProbeVolumeObservation | undefined {
  return isProbeVolumeObservation(value) ? value : undefined;
}

interface IProbeRenderer {
  readonly autoClear?: boolean;
  readonly compileAsync?: (scene: Object3D, camera: Camera) => Promise<void>;
  readonly coordinateSystem?: CoordinateSystem;
  readonly backend?: {
    readonly device?: { readonly limits?: Record<string, unknown> };
  };
  readonly device?: { readonly limits?: Record<string, unknown> };
  readonly shadowMap?: { autoUpdate: boolean; needsUpdate: boolean };
  readonly toneMapping?: number;
  readonly toneMappingExposure?: number;
  readonly getRenderTarget?: () => unknown;
  readonly getActiveCubeFace?: () => number;
  readonly getActiveMipmapLevel?: () => number;
  readonly reversedDepthBuffer?: boolean;
  readonly clearDepth?: () => void;
  readonly render: (scene: Object3D, camera: Camera) => void;
  readonly copyTextureToTexture?: (
    source: unknown,
    destination: unknown,
    sourceRegion?: unknown,
    destinationPosition?: unknown,
  ) => void;
  readonly setRenderTarget: (
    target: unknown,
    activeCubeFace?: number,
    activeMipmapLevel?: number,
  ) => void;
  readonly xr?: { enabled: boolean };
}

interface IPendingBake {
  readonly scene: Scene;
  passes: number;
  pass: number;
  phase: "capture" | "project" | "copy" | "repack";
  cubeFaceIndex: number;
  probeIndex: number;
  repackIndex: number;
  completedWork: number;
  completedProbes: number;
  totalWork: number;
}

interface IBakePromise {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface ISceneState {
  readonly scene: Scene;
  readonly matrixWorldAutoUpdate: boolean;
  readonly shadowAutoUpdate?: boolean;
}

const PACKED_CHANNELS: readonly (readonly [number, number] | null)[] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [2, 0],
  [2, 1],
  [2, 2],
  [3, 0],
  [3, 1],
  [3, 2],
  [4, 0],
  [4, 1],
  [4, 2],
  [5, 0],
  [5, 1],
  [5, 2],
  [6, 0],
  [6, 1],
  [6, 2],
  [7, 0],
  [7, 1],
  [7, 2],
  [8, 0],
  [8, 1],
  [8, 2],
  null,
];

/**
 * A WebGPU irradiance probe volume.
 *
 * The volume owns placement, GPU bake scheduling and a single padded atlas. It owns no light,
 * material or colour: every coefficient comes from the scene rendered by its cube cameras. Add it
 * through `ctx.add()` so `process()` runs in the render phase measured by `FrameBudget`.
 *
 * Bakes are static-lighting-first and explicit. Call `requestBake(scene)` after lights and static
 * geometry are authored; a completed bake is reused until the game requests another one.
 */
export class ProbeVolume extends Object3D implements IComputeDriven {
  readonly isProbeVolume = true;
  readonly processCadence = "render" as const;
  readonly warmupNodes: readonly unknown[] = [];
  readonly boundingBox: Box3;
  readonly resolution: Vector3;
  readonly #boundsSize: Vector3;
  readonly #density: Vector3;
  readonly #atlasDepth: number;
  readonly #atlasBytes: number;
  readonly #probeCount: number;
  readonly #atlasData: Float32Array;
  readonly #coefficients: Float32Array;
  readonly #atlasNode;
  readonly #emptyAtlasTexture: Data3DTexture;
  readonly #boundsMinNode;
  readonly #boundsSizeNode;
  readonly #report: (line: string) => void;
  readonly #now: () => number;
  readonly #bakeBudgetMs: number;
  readonly #maxWorkItemsPerFrame: number;
  readonly #cubemapSize: number;
  readonly #near: number;
  readonly #far: number;
  readonly #bounces: number;
  #bakePasses: number;
  #atlasTexture: Data3DTexture;
  #renderer: IRendererLike | undefined;
  #cubeRenderTarget: CubeRenderTarget | undefined;
  #cubeCamera: CubeCamera | undefined;
  #projectionTarget: RenderTarget | undefined;
  #batchTarget: RenderTarget | undefined;
  #atlasTarget: RenderTarget3D | undefined;
  #quadScene: Scene | undefined;
  #quadCamera: OrthographicCamera | undefined;
  #quadMesh: Mesh | undefined;
  #projectionMaterial: NodeMaterial | undefined;
  #repackMaterials: NodeMaterial[] | undefined;
  #repackSlice = uniform(0, "int");
  #batchTextureNode: ReturnType<typeof texture> | undefined;
  #gpuWarmupStarted = false;
  #gpuWarmupSettled = true;
  #sceneWarmupStarted = false;
  #sceneWarmupSettled = true;
  #pending: IPendingBake | undefined;
  #bakePromise: IBakePromise | undefined;
  #sceneState: ISceneState | undefined;
  #status: IProbeVolumeObservation["status"] = "unbaked";
  #stalenessFrames: number | null = null;
  #lastBakeCostMs = 0;
  #maxWorkItemCostMs = 0;
  #samplingIsolated = false;
  #lastReported = "";
  #released = false;

  constructor(options: IProbeVolumeOptions) {
    super();
    this.#report = options.report ?? ((line) => console.info(line));
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#bakeBudgetMs = positiveNumber(options.bakeBudgetMs ?? 2, "bakeBudgetMs");
    this.#maxWorkItemsPerFrame = positiveInteger(
      options.maxWorkItemsPerFrame ?? 1,
      "maxWorkItemsPerFrame",
    );
    this.#cubemapSize = positiveInteger(options.cubemapSize ?? 8, "cubemapSize");
    this.#near = positiveNumber(options.near ?? 0.1, "near");
    this.#far = positiveNumber(options.far ?? 100, "far");
    if (this.#far <= this.#near) throw new Error("ProbeVolume far must be greater than near.");
    this.#bounces = nonNegativeInteger(options.bounces ?? 0, "bounces");
    this.#bakePasses = this.#bounces + 1;

    const normalizedBounds = normalizeBounds(options.bounds);
    this.boundingBox = normalizedBounds;
    this.#boundsSize = normalizedBounds.max.clone().sub(normalizedBounds.min);
    this.#density = normalizeDensity(options.density);
    this.resolution = new Vector3(
      resolutionForAxis(this.#boundsSize.x, this.#density.x, "x"),
      resolutionForAxis(this.#boundsSize.y, this.#density.y, "y"),
      resolutionForAxis(this.#boundsSize.z, this.#density.z, "z"),
    );
    this.#atlasDepth = checkedAtlasDepth(this.resolution.z);
    const maximumDimension = Math.max(this.resolution.x, this.resolution.y, this.#atlasDepth);
    const suppliedLimit = options.maxTextureDimension3D ?? options.deviceTextureLimit;
    if (suppliedLimit !== undefined) {
      validateTextureLimit(suppliedLimit);
      assertTextureLimit(maximumDimension, suppliedLimit);
    }
    this.#probeCount = checkedIntegerProduct(
      this.resolution.x,
      this.resolution.y,
      this.resolution.z,
      "probe count",
    );
    const texelCount = checkedIntegerProduct(
      this.resolution.x,
      this.resolution.y,
      this.#atlasDepth,
      "atlas texel count",
    );
    this.#atlasBytes = texelCount * BYTES_PER_TEXEL;
    this.#atlasData = new Float32Array(texelCount * 4);
    this.#coefficients = new Float32Array(
      this.#probeCount * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT,
    );
    this.#atlasTexture = createCpuAtlas(this.#atlasData, this.resolution, this.#atlasDepth);
    this.#emptyAtlasTexture = createCpuAtlas(new Float32Array(4), new Vector3(1, 1, 1), 1);
    this.#atlasNode = texture3D(this.#atlasTexture);
    this.#boundsMinNode = uniform(this.boundingBox.min.clone());
    this.#boundsSizeNode = uniform(this.#boundsSize.clone());
    this.#publish(true);
  }

  get texture(): Data3DTexture {
    return this.#atlasTexture;
  }

  get atlasDepth(): number {
    return this.#atlasDepth;
  }

  get atlasBytes(): number {
    return this.#atlasBytes;
  }

  get probeCount(): number {
    return this.#probeCount;
  }

  get released(): boolean {
    return this.#released;
  }

  get atlasData(): Float32Array {
    return this.#atlasData.slice();
  }

  get observation(): IProbeVolumeObservation {
    const progress = this.#pending;
    const total = progress?.totalWork ?? this.totalWork;
    const completed = progress?.completedWork ?? (this.#status === "ready" ? total : 0);
    return {
      atlas: {
        depth: this.#atlasDepth,
        height: this.resolution.y,
        width: this.resolution.x,
      },
      atlasBytes: this.#atlasBytes,
      bakeBudgetMs: this.#bakeBudgetMs,
      bakeCostMs: this.#lastBakeCostMs,
      bakeProgress: {
        completed,
        fraction: total === 0 ? 1 : completed / total,
        pass: progress?.pass ?? (this.#status === "ready" ? this.#bakePasses - 1 : 0),
        passes: this.#bakePasses,
        probesCompleted:
          progress?.completedProbes ?? (this.#status === "ready" ? this.#probeCount : 0),
        probesTotal: this.#probeCount * this.#bakePasses,
        total,
      },
      marker: PROBE_VOLUME_MARKER,
      probeCount: this.#probeCount,
      samplingIsolated: this.#samplingIsolated,
      stale: this.#status !== "ready",
      stalenessFrames: this.#stalenessFrames,
      status: this.#status,
      unbaked: this.#status === "unbaked",
    };
  }

  /** Attach the active renderer; only WebGPU has the 3D render-target contract this class needs. */
  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("ProbeVolume.attachRenderer called after detach().");
    if (renderer.kind !== "webgpu") {
      throw new Error(`ProbeVolume requires a WebGPURenderer, received ${renderer.kind}.`);
    }
    if (this.#renderer !== undefined && this.#renderer !== renderer) {
      throw new Error("ProbeVolume cannot attach to two renderers.");
    }
    this.#renderer = renderer;
    const raw = renderer.raw as IProbeRenderer;
    const deviceLimit = readTextureLimit(raw);
    if (deviceLimit !== undefined) assertTextureLimit(this.maximumDimension, deviceLimit);
    this.#ensureGpuResources();
    if (this.#pending !== undefined) this.#prepareBake(this.#pending.scene, this.#pending.passes);
  }

  /** Start or coalesce an incremental static bake for a scene. */
  requestBake(scene: Scene, options: { readonly bounces?: number } = {}): Promise<void> {
    if (this.#released) throw new Error("ProbeVolume.requestBake called after detach().");
    if (!(scene instanceof Scene)) throw new Error("ProbeVolume.requestBake requires a Scene.");
    const bounces = options.bounces ?? this.#bounces;
    nonNegativeInteger(bounces, "bounces");
    if (this.#pending !== undefined && this.#bakePromise !== undefined)
      return this.#bakePromise.promise;
    this.#bakePasses = bounces + 1;
    this.#maxWorkItemCostMs = 0;
    this.#status = "baking";
    this.#stalenessFrames = this.#stalenessFrames === null ? null : this.#stalenessFrames;
    this.#bakePromise = deferred();
    this.#pending = {
      completedProbes: 0,
      completedWork: 0,
      cubeFaceIndex: 0,
      pass: 0,
      passes: bounces + 1,
      phase: "capture",
      probeIndex: 0,
      repackIndex: 0,
      scene,
      totalWork:
        (bounces + 1) *
        (this.#probeCount * CAPTURE_WORK_ITEMS_PER_PROBE +
          PACKED_SUB_VOLUME_COUNT * this.paddedSlices),
    };
    this.#clearPreviousBake();
    this.#setSamplingIsolated(true);
    this.#publish(true);
    if (this.#renderer !== undefined) this.#prepareBake(scene, bounces + 1);
    return this.#bakePromise.promise;
  }

  /** Alias that reads naturally at call sites that want an awaitable bake request. */
  bake(scene: Scene, options?: { readonly bounces?: number }): Promise<void>;
  bake(
    renderer: IRendererLike,
    scene: Scene,
    options?: { readonly bounces?: number },
  ): Promise<void>;
  bake(
    rendererOrScene: IRendererLike | Scene,
    sceneOrOptions?: Scene | { readonly bounces?: number },
    suppliedOptions: { readonly bounces?: number } = {},
  ): Promise<void> {
    if (isRendererLike(rendererOrScene)) {
      this.attachRenderer(rendererOrScene);
      return this.requestBake(sceneOrOptions as Scene, suppliedOptions);
    }
    return this.requestBake(
      rendererOrScene,
      (sceneOrOptions as { readonly bounces?: number }) ?? {},
    );
  }

  /**
   * Return the L2 irradiance node for a world position and world normal.
   *
   * `sample()` with no arguments is the material-friendly form and reads `positionWorld` and
   * `normalWorld`. Passing numeric vectors is reserved for diagnostics and deterministic tests;
   * it evaluates the same SH coefficients held by the atlas packer.
   */
  sample(): Node<"vec3">;
  sample(position: Vector3, normal: Vector3): Vector3;
  sample(position: IProbePosition, normal?: Vector3 | Node<"vec3">): Vector3 | Node<"vec3">;
  sample(
    position: IProbePosition = positionWorld,
    normal: Vector3 | Node<"vec3"> = normalWorld,
  ): Vector3 | Node<"vec3"> {
    if (position instanceof Vector3 && normal instanceof Vector3) {
      return this.sampleIrradiance(position, normal);
    }
    return this.sampleNode(position as Node<"vec3">, normal as Node<"vec3">);
  }

  sampleIrradiance(position: Vector3, normal: Vector3): Vector3 {
    if (!(position instanceof Vector3) || !(normal instanceof Vector3)) {
      throw new Error("ProbeVolume.sampleIrradiance requires Vector3 position and normal values.");
    }
    const coefficients = this.#samplePackedCoefficients(position);
    const direction = normal.clone().normalize();
    const result = new Vector3();
    result.x = evaluateShChannel(coefficients, 0, direction);
    result.y = evaluateShChannel(coefficients, 1, direction);
    result.z = evaluateShChannel(coefficients, 2, direction);
    return result.max(new Vector3());
  }

  /** The GPU graph used by `sample`; exposed so generated materials can compose it explicitly. */
  sampleNode(
    position: Node<"vec3"> = positionWorld,
    normal: Node<"vec3"> = normalWorld,
  ): Node<"vec3"> {
    const local = clamp(vec3(position).sub(this.#boundsMinNode).div(this.#boundsSizeNode), 0, 1);
    const atlasX = local.x
      .mul(this.resolution.x - 1)
      .add(0.5)
      .div(this.resolution.x);
    const atlasY = local.y
      .mul(this.resolution.y - 1)
      .add(0.5)
      .div(this.resolution.y);
    const sliceStride = this.resolution.z + 2 * SAMPLE_ATLAS_PADDING;
    const atlasZ = (subVolume: number) =>
      local.z
        .mul(this.resolution.z - 1)
        .add(SAMPLE_ATLAS_PADDING + 0.5 + subVolume * sliceStride)
        .div(this.#atlasDepth);
    const packed = (subVolume: number) =>
      this.#atlasNode.sample(vec3(atlasX, atlasY, atlasZ(subVolume)));
    const packedValues = Array.from({ length: PACKED_SUB_VOLUME_COUNT }, (_, index) =>
      packed(index),
    );
    const packedAt = (index: number) => valueAt(packedValues, index, "packed probe value");
    const coefficients = [
      vec3(packedAt(0).x, packedAt(0).y, packedAt(0).z),
      vec3(packedAt(0).w, packedAt(1).x, packedAt(1).y),
      vec3(packedAt(1).z, packedAt(1).w, packedAt(2).x),
      vec3(packedAt(2).y, packedAt(2).z, packedAt(2).w),
      vec3(packedAt(3).x, packedAt(3).y, packedAt(3).z),
      vec3(packedAt(3).w, packedAt(4).x, packedAt(4).y),
      vec3(packedAt(4).z, packedAt(4).w, packedAt(5).x),
      vec3(packedAt(5).y, packedAt(5).z, packedAt(5).w),
      vec3(packedAt(6).x, packedAt(6).y, packedAt(6).z),
    ];
    const direction = normalize(vec3(normal));
    const coefficientAt = (index: number) => valueAt(coefficients, index, "SH coefficient");
    const irradiance = coefficientAt(0)
      .mul(0.886227)
      .add(coefficientAt(1).mul(direction.y).mul(1.023328))
      .add(coefficientAt(2).mul(direction.z).mul(1.023328))
      .add(coefficientAt(3).mul(direction.x).mul(1.023328))
      .add(coefficientAt(4).mul(direction.x.mul(direction.y)).mul(0.858086))
      .add(coefficientAt(5).mul(direction.y.mul(direction.z)).mul(0.858086))
      .add(coefficientAt(6).mul(direction.z.mul(direction.z).mul(0.743125).sub(0.247708)))
      .add(coefficientAt(7).mul(direction.x.mul(direction.z)).mul(0.858086))
      .add(
        coefficientAt(8)
          .mul(direction.x.mul(direction.x).sub(direction.y.mul(direction.y)))
          .mul(0.429043),
      );
    return irradiance.max(0);
  }

  /** Internal data seam used by unit/conformance fixtures to seed a known SH atlas without a GPU. */
  setProbeCoefficients(
    ix: number,
    iy: number,
    iz: number,
    coefficients: readonly IProbeVolumeCoefficient[],
  ): void {
    if (this.#pending !== undefined)
      throw new Error("ProbeVolume cannot edit coefficients during a bake.");
    validateProbeIndex(ix, this.resolution.x, "ix");
    validateProbeIndex(iy, this.resolution.y, "iy");
    validateProbeIndex(iz, this.resolution.z, "iz");
    if (coefficients.length !== SH_COEFFICIENT_COUNT) {
      throw new Error(`ProbeVolume coefficients must contain ${SH_COEFFICIENT_COUNT} entries.`);
    }
    const probe = ix + iy * this.resolution.x + iz * this.resolution.x * this.resolution.y;
    const offset = probe * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT;
    coefficients.forEach((value, coefficientIndex) => {
      for (let channel = 0; channel < SH_CHANNEL_COUNT; channel += 1) {
        const key = valueAt(["r", "g", "b"] as const, channel, "SH channel");
        const channelValue = value[key];
        if (!Number.isFinite(channelValue)) {
          throw new Error(`ProbeVolume coefficient ${coefficientIndex}.${key} must be finite.`);
        }
        this.#coefficients[offset + coefficientIndex * SH_CHANNEL_COUNT + channel] = channelValue;
      }
    });
    this.#packCpuAtlas();
    this.#setSamplingIsolated(false);
    this.#status = "ready";
    this.#stalenessFrames = 0;
    this.#publish(true);
  }

  /** One bounded render-phase slice. The game loop calls this through IComputeDriven. */
  process(renderer: IRendererLike): void {
    this.#assertProcessRenderer(renderer);
    if (this.#renderer === undefined) this.attachRenderer(renderer);
    if (this.#renderer !== renderer)
      throw new Error("ProbeVolume.process received a different renderer.");
    if (this.#pending === undefined) {
      this.#publishIdleFrame();
      return;
    }
    if (!this.#gpuWarmupSettled || !this.#sceneWarmupSettled) {
      this.#lastBakeCostMs = 0;
      this.#publish(false);
      return;
    }
    if (this.#sceneState === undefined)
      this.#prepareBake(this.#pending.scene, this.#pending.passes);
    this.#processPending(this.#pending);
  }

  #assertProcessRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("ProbeVolume.process called after detach().");
    if (renderer.kind !== "webgpu") {
      throw new Error(`ProbeVolume requires a WebGPURenderer, received ${renderer.kind}.`);
    }
  }

  #publishIdleFrame(): void {
    if (this.#status === "ready" && this.#stalenessFrames !== null) this.#stalenessFrames += 1;
    this.#lastBakeCostMs = 0;
    this.#publish(false);
  }

  #processPending(pending: IPendingBake): void {
    const started = this.#now();
    let workItems = 0;
    try {
      while (this.#pending !== undefined && workItems < this.#maxWorkItemsPerFrame) {
        const elapsedBefore = Math.max(0, this.#now() - started);
        if (workItems > 0 && elapsedBefore + this.#maxWorkItemCostMs > this.#bakeBudgetMs) break;
        const itemStarted = this.#now();
        this.#runWorkItem(pending);
        const itemCostMs = Math.max(0, this.#now() - itemStarted);
        this.#maxWorkItemCostMs = Math.max(this.#maxWorkItemCostMs, itemCostMs);
        const elapsed = Math.max(0, this.#now() - started);
        if (itemCostMs > this.#bakeBudgetMs + BAKE_BUDGET_SLACK_MS) {
          throw new Error(
            `ProbeVolume bake work item cost ${itemCostMs}ms exceeds bakeBudgetMs ${this.#bakeBudgetMs}ms plus ${BAKE_BUDGET_SLACK_MS}ms scheduling slack.`,
          );
        }
        if (elapsed > this.#bakeBudgetMs + BAKE_BUDGET_SLACK_MS) {
          throw new Error(
            `ProbeVolume bake frame cost ${elapsed}ms exceeds bakeBudgetMs ${this.#bakeBudgetMs}ms plus ${BAKE_BUDGET_SLACK_MS}ms scheduling slack.`,
          );
        }
        workItems += 1;
        if (elapsed >= this.#bakeBudgetMs) break;
      }
    } catch (error) {
      this.#failBake(error);
      throw error;
    }
    this.#lastBakeCostMs = Math.max(0, this.#now() - started);
    this.#publish(true);
  }

  detach(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#pending !== undefined) {
      this.#bakePromise?.reject(new Error("ProbeVolume detached while a bake was pending."));
      this.#pending = undefined;
      this.#bakePromise = undefined;
    }
    this.#restoreSceneState();
    this.#cubeRenderTarget?.dispose();
    this.#projectionTarget?.dispose();
    this.#batchTarget?.dispose();
    this.#atlasTarget?.dispose();
    this.#emptyAtlasTexture.dispose();
    this.#projectionMaterial?.dispose();
    for (const material of this.#repackMaterials ?? []) material.dispose();
    this.#quadMesh?.geometry.dispose();
    this.#atlasTexture.dispose();
    this.#cubeRenderTarget = undefined;
    this.#projectionTarget = undefined;
    this.#batchTarget = undefined;
    this.#atlasTarget = undefined;
    this.#projectionMaterial = undefined;
    this.#repackMaterials = undefined;
    this.#atlasTexture = createCpuAtlas(this.#atlasData, this.resolution, this.#atlasDepth);
  }

  get paddedSlices(): number {
    return this.resolution.z + 2 * ATLAS_PADDING;
  }

  get maximumDimension(): number {
    return Math.max(this.resolution.x, this.resolution.y, this.#atlasDepth);
  }

  get totalWork(): number {
    return (
      this.#bakePasses *
      (this.#probeCount * CAPTURE_WORK_ITEMS_PER_PROBE +
        PACKED_SUB_VOLUME_COUNT * this.paddedSlices)
    );
  }

  #ensureGpuResources(): void {
    if (this.#cubeRenderTarget !== undefined) return;
    this.#cubeRenderTarget = new CubeRenderTarget(this.#cubemapSize, {
      depthBuffer: true,
      generateMipmaps: false,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      type: HalfFloatType,
    });
    this.#cubeCamera = new CubeCamera(this.#near, this.#far, this.#cubeRenderTarget);
    this.#projectionTarget = new RenderTarget(9, 1, {
      depthBuffer: false,
      generateMipmaps: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type: FloatType,
    });
    this.#batchTarget = new RenderTarget(9, this.#probeCount, {
      depthBuffer: false,
      generateMipmaps: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type: FloatType,
    });
    this.#atlasTarget = new RenderTarget3D(this.resolution.x, this.resolution.y, this.#atlasDepth, {
      depthBuffer: false,
      generateMipmaps: false,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      type: FloatType,
    });
    this.#atlasTexture = this.#atlasTarget.texture as Data3DTexture;
    this.#atlasTexture.format = RGBAFormat;
    this.#setSamplingIsolated(this.#samplingIsolated);
    this.#quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.#quadMesh = new Mesh(new PlaneGeometry(2, 2));
    this.#quadScene = new Scene();
    this.#quadScene.add(this.#quadMesh);
    this.#projectionMaterial = createProjectionMaterial(this.#cubeRenderTarget, this.#cubemapSize);
    this.#batchTextureNode = texture(this.#batchTarget.texture);
    this.#repackMaterials = createRepackMaterials(
      this.#batchTextureNode,
      this.#repackSlice,
      this.resolution,
      this.#probeCount,
    );
    this.#startGpuWarmup();
  }

  /** Compile the private projection/repack graphs outside the presented frame budget. */
  #startGpuWarmup(): void {
    if (this.#gpuWarmupStarted) return;
    const projectionTarget = this.#projectionTarget;
    const projectionMaterial = this.#projectionMaterial;
    const atlasTarget = this.#atlasTarget;
    const repackMaterials = this.#repackMaterials;
    if (
      projectionTarget === undefined ||
      projectionMaterial === undefined ||
      atlasTarget === undefined ||
      repackMaterials === undefined
    )
      throw new Error("ProbeVolume warm-up resources were not initialized.");
    this.#gpuWarmupStarted = true;
    // First-use shader work belongs to scene entry, before bounded bake slices are presented.
    this.#renderQuad(projectionTarget, projectionMaterial);
    repackMaterials.forEach((material, index) => {
      this.#renderQuad(atlasTarget, material, index * this.paddedSlices);
    });
  }

  /** Compile every scene material through the six cube-camera views before the first capture. */
  #startSceneWarmup(scene: Scene): void {
    if (this.#sceneWarmupStarted) return;
    this.#sceneWarmupStarted = true;
    const renderer = this.#renderer;
    const raw = renderer?.raw as IProbeRenderer | undefined;
    const cubeCamera = this.#cubeCamera;
    if (
      renderer === undefined ||
      typeof renderer.compileAsync !== "function" ||
      cubeCamera === undefined
    )
      return;
    const coordinateSystem = raw?.coordinateSystem;
    if (coordinateSystem !== undefined && cubeCamera.coordinateSystem !== coordinateSystem) {
      cubeCamera.coordinateSystem = coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }
    const cameras = cubeCamera.children.filter(
      (child): child is Camera => (child as Camera).isCamera === true,
    );
    if (cameras.length === 0) return;
    this.#sceneWarmupSettled = false;
    void (async () => {
      try {
        const compile = (async () => {
          for (const camera of cameras) await renderer.compileAsync(scene, camera);
        })();
        await Promise.race([
          compile,
          new Promise<void>((resolve) => setTimeout(resolve, SCENE_WARMUP_TIMEOUT_MS)),
        ]);
      } catch {
        // A failed warm-up is not a failed bake. The first bounded capture surfaces the renderer
        // error, while a host without a settling compile promise still reaches the same path.
      } finally {
        this.#sceneWarmupSettled = true;
      }
    })();
  }

  #prepareBake(scene: Scene, passes: number): void {
    if (this.#sceneState !== undefined) return;
    this.#ensureGpuResources();
    const raw = this.#rawRenderer();
    const matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
    if (matrixWorldAutoUpdate) {
      scene.updateMatrixWorld(true);
      scene.matrixWorldAutoUpdate = false;
    }
    const shadowAutoUpdate = raw.shadowMap?.autoUpdate;
    if (raw.shadowMap !== undefined) {
      raw.shadowMap.autoUpdate = false;
      raw.shadowMap.needsUpdate = true;
    }
    this.#sceneState = {
      matrixWorldAutoUpdate,
      scene,
      ...(shadowAutoUpdate === undefined ? {} : { shadowAutoUpdate }),
    };
    this.#startSceneWarmup(scene);
    if (this.#pending !== undefined && this.#pending.passes !== passes) {
      throw new Error("ProbeVolume cannot change bake passes after a bake has started.");
    }
  }

  #runWorkItem(pending: IPendingBake): void {
    if (pending.phase === "capture") {
      this.#runCaptureWorkItem(pending);
    } else if (pending.phase === "project") {
      this.#runProjectWorkItem(pending);
    } else if (pending.phase === "copy") {
      this.#runCopyWorkItem(pending);
    } else if (this.#runRepackWorkItem(pending)) {
      return;
    }
    pending.completedWork += 1;
  }

  #runCaptureWorkItem(pending: IPendingBake): void {
    this.#captureProbeFace(pending.scene, pending.probeIndex, pending.cubeFaceIndex);
    pending.cubeFaceIndex += 1;
    if (pending.cubeFaceIndex >= CUBE_FACE_COUNT) pending.phase = "project";
  }

  #runProjectWorkItem(pending: IPendingBake): void {
    this.#projectProbe();
    pending.phase = "copy";
  }

  #runCopyWorkItem(pending: IPendingBake): void {
    this.#copyProjectedProbe(pending.probeIndex);
    pending.probeIndex += 1;
    pending.completedProbes += 1;
    if (pending.probeIndex >= this.#probeCount) {
      pending.phase = "repack";
      pending.repackIndex = 0;
    } else {
      pending.phase = "capture";
      pending.cubeFaceIndex = 0;
    }
  }

  #runRepackWorkItem(pending: IPendingBake): boolean {
    this.#repackSliceToAtlas(pending.repackIndex);
    pending.repackIndex += 1;
    if (pending.repackIndex < PACKED_SUB_VOLUME_COUNT * this.paddedSlices) return false;
    if (pending.pass + 1 < pending.passes) {
      pending.pass += 1;
      pending.phase = "capture";
      pending.cubeFaceIndex = 0;
      pending.probeIndex = 0;
      if (pending.pass === 1) this.#setSamplingIsolated(false);
      return false;
    }
    this.#finishBake();
    return true;
  }

  #captureProbeFace(scene: Scene, probeIndex: number, cubeFaceIndex: number): void {
    const ix = probeIndex % this.resolution.x;
    const iy = Math.floor(probeIndex / this.resolution.x) % this.resolution.y;
    const iz = Math.floor(probeIndex / (this.resolution.x * this.resolution.y));
    const position = this.probePosition(ix, iy, iz);
    const cubeCamera = this.#cubeCamera;
    const cubeTarget = this.#cubeRenderTarget;
    if (cubeCamera === undefined || cubeTarget === undefined) {
      throw new Error("ProbeVolume bake resources were not initialized.");
    }
    cubeCamera.position.copy(position);
    cubeCamera.updateMatrixWorld(true);
    const raw = this.#rawRenderer();
    if (
      raw.coordinateSystem !== undefined &&
      cubeCamera.coordinateSystem !== raw.coordinateSystem
    ) {
      cubeCamera.coordinateSystem = raw.coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }
    const camera = valueAt(
      cubeCamera.children.filter((child): child is Camera => (child as Camera).isCamera === true),
      cubeFaceIndex,
      "cube camera face",
    );
    const previousTarget = raw.getRenderTarget?.() ?? null;
    const previousFace = raw.getActiveCubeFace?.() ?? 0;
    const previousMip = raw.getActiveMipmapLevel?.() ?? 0;
    const previousXr = raw.xr?.enabled;
    if (raw.xr !== undefined) raw.xr.enabled = false;
    raw.setRenderTarget(cubeTarget, cubeFaceIndex, cubeCamera.activeMipmapLevel);
    try {
      if (raw.reversedDepthBuffer === true && raw.autoClear === false) raw.clearDepth?.();
      raw.render(scene, camera);
    } finally {
      raw.setRenderTarget(previousTarget, previousFace, previousMip);
      if (raw.xr !== undefined && previousXr !== undefined) raw.xr.enabled = previousXr;
    }
    if (cubeFaceIndex === CUBE_FACE_COUNT - 1) cubeTarget.texture.needsPMREMUpdate = true;
  }

  #projectProbe(): void {
    const projectionTarget = this.#projectionTarget;
    const projectionMaterial = this.#projectionMaterial;
    if (projectionTarget === undefined || projectionMaterial === undefined) {
      throw new Error("ProbeVolume projection resources were not initialized.");
    }
    this.#renderQuad(projectionTarget, projectionMaterial);
  }

  #copyProjectedProbe(probeIndex: number): void {
    const projectionTarget = this.#projectionTarget;
    const batchTarget = this.#batchTarget;
    if (projectionTarget === undefined || batchTarget === undefined) {
      throw new Error("ProbeVolume copy resources were not initialized.");
    }
    const raw = this.#rawRenderer();
    if (raw.copyTextureToTexture === undefined) {
      throw new Error(
        "ProbeVolume requires WebGPU texture-to-texture copies for its staging rows.",
      );
    }
    raw.copyTextureToTexture(
      projectionTarget.texture,
      batchTarget.texture,
      new Box2(new Vector2(0, 0), new Vector2(9, 1)),
      new Vector2(0, probeIndex),
    );
  }

  #repackSliceToAtlas(repackIndex: number): void {
    const atlasTarget = this.#atlasTarget;
    const materials = this.#repackMaterials;
    if (atlasTarget === undefined || materials === undefined) {
      throw new Error("ProbeVolume repack resources were not initialized.");
    }
    const subVolume = Math.floor(repackIndex / this.paddedSlices);
    const localSlice = repackIndex % this.paddedSlices;
    const sourceSlice = Math.min(this.resolution.z - 1, Math.max(0, localSlice - ATLAS_PADDING));
    this.#repackSlice.value = sourceSlice;
    atlasTarget.viewport.set(0, 0, this.resolution.x, this.resolution.y);
    atlasTarget.scissorTest = false;
    this.#renderQuad(
      atlasTarget,
      valueAt(materials, subVolume, "repack material"),
      subVolume * this.paddedSlices + localSlice,
    );
  }

  #renderQuad(target: RenderTarget | RenderTarget3D, material: NodeMaterial, slice?: number): void {
    const raw = this.#rawRenderer();
    const previousTarget = raw.getRenderTarget?.() ?? null;
    const previousFace = raw.getActiveCubeFace?.() ?? 0;
    const previousMip = raw.getActiveMipmapLevel?.() ?? 0;
    const mesh = this.#quadMesh;
    const camera = this.#quadCamera;
    const scene = this.#quadScene;
    if (mesh === undefined || camera === undefined || scene === undefined) {
      throw new Error("ProbeVolume quad resources were not initialized.");
    }
    mesh.material = material;
    raw.setRenderTarget(target, slice ?? 0, 0);
    try {
      raw.render(scene, camera);
    } finally {
      raw.setRenderTarget(previousTarget, previousFace, previousMip);
    }
  }

  #finishBake(): void {
    this.#restoreSceneState();
    this.#setSamplingIsolated(false);
    this.#status = "ready";
    this.#stalenessFrames = 0;
    const promise = this.#bakePromise;
    this.#pending = undefined;
    this.#bakePromise = undefined;
    promise?.resolve();
  }

  #failBake(error: unknown): void {
    this.#restoreSceneState();
    this.#pending = undefined;
    const promise = this.#bakePromise;
    this.#bakePromise = undefined;
    promise?.reject(error);
    this.#status = "unbaked";
    this.#publish(true);
  }

  #restoreSceneState(): void {
    const state = this.#sceneState;
    if (state === undefined) return;
    state.scene.matrixWorldAutoUpdate = state.matrixWorldAutoUpdate;
    const raw = this.#renderer === undefined ? undefined : (this.#renderer.raw as IProbeRenderer);
    if (raw?.shadowMap !== undefined && state.shadowAutoUpdate !== undefined) {
      raw.shadowMap.autoUpdate = state.shadowAutoUpdate;
    }
    this.#sceneState = undefined;
  }

  #rawRenderer(): IProbeRenderer {
    if (this.#renderer === undefined)
      throw new Error("ProbeVolume needs an attached WebGPURenderer.");
    return this.#renderer.raw as IProbeRenderer;
  }

  #clearPreviousBake(): void {
    this.#coefficients.fill(0);
    this.#atlasData.fill(0);
    if (this.#atlasTarget === undefined) this.#atlasTexture.needsUpdate = true;
  }

  #setSamplingIsolated(isolated: boolean): void {
    this.#samplingIsolated = isolated;
    this.#atlasNode.value = isolated ? this.#emptyAtlasTexture : this.#atlasTexture;
  }

  #publish(force: boolean): void {
    const observation = this.observation;
    const line = `${PROBE_VOLUME_MARKER}:${JSON.stringify(observation)}`;
    if (!force && line === this.#lastReported) return;
    this.#lastReported = line;
    this.#report(line);
  }

  #packCpuAtlas(): void {
    for (let subVolume = 0; subVolume < PACKED_SUB_VOLUME_COUNT; subVolume += 1) {
      packCpuSubVolume(
        this.#atlasData,
        this.#coefficients,
        this.resolution,
        this.paddedSlices,
        subVolume,
      );
    }
    this.#atlasTexture.image.data = this.#atlasData;
    this.#atlasTexture.needsUpdate = true;
  }

  #samplePackedCoefficients(position: Vector3): Float32Array {
    const local = normalizedPosition(position, this.boundingBox.min, this.#boundsSize);
    const atlasX = (local.x * (this.resolution.x - 1) + 0.5) / this.resolution.x;
    const atlasY = (local.y * (this.resolution.y - 1) + 0.5) / this.resolution.y;
    const sampleStride = this.resolution.z + 2 * SAMPLE_ATLAS_PADDING;
    const packed = Array.from({ length: PACKED_SUB_VOLUME_COUNT }, (_, subVolume) =>
      sampleAtlas(
        this.#atlasData,
        this.resolution.x,
        this.resolution.y,
        this.#atlasDepth,
        atlasX,
        atlasY,
        (local.z * (this.resolution.z - 1) +
          SAMPLE_ATLAS_PADDING +
          0.5 +
          subVolume * sampleStride) /
          this.#atlasDepth,
      ),
    );
    const result = new Float32Array(SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT);
    for (let subVolume = 0; subVolume < PACKED_SUB_VOLUME_COUNT; subVolume += 1) {
      const texel = valueAt(packed, subVolume, "sampled atlas sub-volume");
      for (let channel = 0; channel < 4; channel += 1) {
        const packedChannel = valueAt(PACKED_CHANNELS, subVolume * 4 + channel, "packed channel");
        if (packedChannel !== null) {
          const [coefficient, component] = packedChannel;
          result[coefficient * SH_CHANNEL_COUNT + component] = valueAt(
            texel,
            channel,
            "sampled atlas channel",
          );
        }
      }
    }
    return result;
  }

  probePosition(ix: number, iy: number, iz: number, target = new Vector3()): Vector3 {
    return target.set(
      this.boundingBox.min.x + (ix * this.#boundsSize.x) / (this.resolution.x - 1),
      this.boundingBox.min.y + (iy * this.#boundsSize.y) / (this.resolution.y - 1),
      this.boundingBox.min.z + (iz * this.#boundsSize.z) / (this.resolution.z - 1),
    );
  }
}

function packCpuSubVolume(
  atlasData: Float32Array,
  coefficients: Float32Array,
  resolution: Vector3,
  paddedSlices: number,
  subVolume: number,
): void {
  const nx = resolution.x;
  const ny = resolution.y;
  const nz = resolution.z;
  const base = subVolume * paddedSlices;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const probe = x + y * nx + z * nx * ny;
        writeAtlasTexel(
          atlasData,
          nx,
          ny,
          base + ATLAS_PADDING + z,
          x,
          y,
          packedCoefficients(coefficients, probe, subVolume),
        );
      }
    }
  }
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const first = packedCoefficients(coefficients, x + y * nx, subVolume);
      const lastProbe = x + y * nx + (nz - 1) * nx * ny;
      const last = packedCoefficients(coefficients, lastProbe, subVolume);
      for (let pad = 0; pad < ATLAS_PADDING; pad += 1) {
        writeAtlasTexel(atlasData, nx, ny, base + pad, x, y, first);
        writeAtlasTexel(atlasData, nx, ny, base + ATLAS_PADDING + nz + pad, x, y, last);
      }
    }
  }
}

function writeAtlasTexel(
  atlasData: Float32Array,
  width: number,
  height: number,
  z: number,
  x: number,
  y: number,
  values: readonly number[],
): void {
  const offset = ((z * height + y) * width + x) * 4;
  atlasData.set(values, offset);
}

function packedCoefficients(
  coefficients: Float32Array,
  probe: number,
  subVolume: number,
): number[] {
  const result = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const packedChannel = valueAt(PACKED_CHANNELS, subVolume * 4 + channel, "packed channel");
    if (packedChannel === null) continue;
    const [coefficient, component] = packedChannel;
    result[channel] =
      coefficients[
        probe * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT + coefficient * SH_CHANNEL_COUNT + component
      ] ?? 0;
  }
  return result;
}

function normalizedPosition(position: Vector3, minimum: Vector3, size: Vector3): Vector3 {
  const local = position.clone().sub(minimum);
  local.x = Math.min(1, Math.max(0, local.x / size.x));
  local.y = Math.min(1, Math.max(0, local.y / size.y));
  local.z = Math.min(1, Math.max(0, local.z / size.z));
  return local;
}

function sampleAtlas(
  data: Float32Array,
  width: number,
  height: number,
  depth: number,
  u: number,
  v: number,
  w: number,
): number[] {
  const x = clampedTextureCoordinate(u, width);
  const y = clampedTextureCoordinate(v, height);
  const z = clampedTextureCoordinate(w, depth);
  const lowerX = Math.floor(x);
  const lowerY = Math.floor(y);
  const lowerZ = Math.floor(z);
  const upperX = Math.min(width - 1, lowerX + 1);
  const upperY = Math.min(height - 1, lowerY + 1);
  const upperZ = Math.min(depth - 1, lowerZ + 1);
  const result = [0, 0, 0, 0];
  for (const sampleZ of uniquePair(lowerZ, upperZ)) {
    for (const sampleY of uniquePair(lowerY, upperY)) {
      for (const sampleX of uniquePair(lowerX, upperX)) {
        const weight =
          interpolationFactor(sampleX, lowerX, upperX, x - lowerX) *
          interpolationFactor(sampleY, lowerY, upperY, y - lowerY) *
          interpolationFactor(sampleZ, lowerZ, upperZ, z - lowerZ);
        const offset = ((sampleZ * height + sampleY) * width + sampleX) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          result[channel] =
            valueAt(result, channel, "atlas result channel") +
            (data[offset + channel] ?? 0) * weight;
        }
      }
    }
  }
  return result;
}

function clampedTextureCoordinate(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value * size - 0.5));
}

function uniquePair(lower: number, upper: number): readonly number[] {
  return lower === upper ? [lower] : [lower, upper];
}

function interpolationFactor(
  sample: number,
  lower: number,
  upper: number,
  fraction: number,
): number {
  if (lower === upper) return 1;
  return sample === lower ? 1 - fraction : fraction;
}

function createCpuAtlas(data: Float32Array, resolution: Vector3, depth: number): Data3DTexture {
  const atlas = new Data3DTexture(data, resolution.x, resolution.y, depth);
  atlas.type = FloatType;
  atlas.format = RGBAFormat;
  atlas.minFilter = LinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.wrapR = ClampToEdgeWrapping;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;
  return atlas;
}

function createProjectionMaterial(cubeTarget: CubeRenderTarget, cubemapSize: number): NodeMaterial {
  const environment = cubeTexture(cubeTarget.texture);
  const coefficientIndex = int(floor(viewportCoordinate.x));
  const projection = Fn(() => {
    const accum = Array.from({ length: SH_COEFFICIENT_COUNT }, () => vec3(0).toVar());
    const accumAt = (index: number) => valueAt(accum, index, "SH accumulation");
    const totalWeight = float(0).toVar();
    const pixelSize = 2 / cubemapSize;
    for (let face = 0; face < 6; face += 1) {
      for (let iy = 0; iy < cubemapSize; iy += 1) {
        for (let ix = 0; ix < cubemapSize; ix += 1) {
          const col = (ix + 0.5) * pixelSize - 1;
          const row = 1 - (iy + 0.5) * pixelSize;
          const coordinate = cubeFaceCoordinate(face, col, row);
          const lengthSquared =
            coordinate.x * coordinate.x + coordinate.y * coordinate.y + coordinate.z * coordinate.z;
          const weight = 4 / (Math.sqrt(lengthSquared) * lengthSquared);
          const direction = new Vector3(coordinate.x, coordinate.y, coordinate.z).normalize();
          const weighted = environment
            .sample(vec3(coordinate.x, coordinate.y, coordinate.z))
            .rgb.mul(weight);
          totalWeight.addAssign(weight);
          accumAt(0).addAssign(weighted.mul(0.282095));
          accumAt(1).addAssign(weighted.mul(0.488603 * direction.y));
          accumAt(2).addAssign(weighted.mul(0.488603 * direction.z));
          accumAt(3).addAssign(weighted.mul(0.488603 * direction.x));
          accumAt(4).addAssign(weighted.mul(1.092548 * direction.x * direction.y));
          accumAt(5).addAssign(weighted.mul(1.092548 * direction.y * direction.z));
          accumAt(6).addAssign(weighted.mul(0.315392 * (3 * direction.z * direction.z - 1)));
          accumAt(7).addAssign(weighted.mul(1.092548 * direction.x * direction.z));
          accumAt(8).addAssign(
            weighted.mul(0.546274 * (direction.x * direction.x - direction.y * direction.y)),
          );
        }
      }
    }
    const norm = float(4 * Math.PI).div(totalWeight);
    let selected: Node<"vec3"> = accumAt(8);
    for (let index = SH_COEFFICIENT_COUNT - 2; index >= 0; index -= 1) {
      selected = coefficientIndex.equal(index).select(accumAt(index), selected) as Node<"vec3">;
    }
    return vec4(selected.mul(norm), 1);
  })();
  const material = new NodeMaterial();
  material.fragmentNode = projection;
  material.toneMapped = false;
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}

function createRepackMaterials(
  batchTextureNode: ReturnType<typeof texture>,
  slice: Node<"int">,
  dimensions: Vector3,
  probeCount: number,
): NodeMaterial[] {
  const ix = floor(viewportCoordinate.x);
  const iy = floor(viewportCoordinate.y);
  const probe = ix.add(iy.mul(dimensions.x)).add(int(slice).mul(dimensions.x * dimensions.y));
  const uv = vec2(probe.add(0.5).div(probeCount), 0);
  const samples = Array.from({ length: SH_COEFFICIENT_COUNT }, (_, index) =>
    batchTextureNode.sample(vec2((index + 0.5) / SH_COEFFICIENT_COUNT, uv.x)),
  );
  const sampleAt = (index: number) => valueAt(samples, index, "repack sample");
  const values = [
    [sampleAt(0).x, sampleAt(0).y, sampleAt(0).z, sampleAt(1).x],
    [sampleAt(1).y, sampleAt(1).z, sampleAt(2).x, sampleAt(2).y],
    [sampleAt(2).z, sampleAt(3).x, sampleAt(3).y, sampleAt(3).z],
    [sampleAt(4).x, sampleAt(4).y, sampleAt(4).z, sampleAt(5).x],
    [sampleAt(5).y, sampleAt(5).z, sampleAt(6).x, sampleAt(6).y],
    [sampleAt(6).z, sampleAt(7).x, sampleAt(7).y, sampleAt(7).z],
    [sampleAt(8).x, sampleAt(8).y, sampleAt(8).z, 0],
  ];
  return values.map((value) => {
    const material = new NodeMaterial();
    material.fragmentNode = vec4(
      valueAt(value, 0, "repack red channel"),
      valueAt(value, 1, "repack green channel"),
      valueAt(value, 2, "repack blue channel"),
      valueAt(value, 3, "repack alpha channel"),
    );
    material.toneMapped = false;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
  });
}

function cubeFaceCoordinate(face: number, col: number, row: number): IVector3Like {
  if (face === 0) return { x: 1, y: row, z: -col };
  if (face === 1) return { x: -1, y: row, z: col };
  if (face === 2) return { x: col, y: 1, z: -row };
  if (face === 3) return { x: col, y: -1, z: row };
  if (face === 4) return { x: col, y: row, z: 1 };
  return { x: -col, y: row, z: -1 };
}

function evaluateShChannel(coefficients: Float32Array, channel: number, normal: Vector3): number {
  const c = (index: number) => coefficients[index * SH_CHANNEL_COUNT + channel] ?? 0;
  return (
    c(0) * 0.886227 +
    c(1) * normal.y * 1.023328 +
    c(2) * normal.z * 1.023328 +
    c(3) * normal.x * 1.023328 +
    c(4) * normal.x * normal.y * 0.858086 +
    c(5) * normal.y * normal.z * 0.858086 +
    c(6) * (normal.z * normal.z * 0.743125 - 0.247708) +
    c(7) * normal.x * normal.z * 0.858086 +
    c(8) * (normal.x * normal.x - normal.y * normal.y) * 0.429043
  );
}

function normalizeBounds(value: IProbeVolumeOptions["bounds"]): Box3 {
  const min = new Vector3(value.min.x, value.min.y, value.min.z);
  const max = new Vector3(value.max.x, value.max.y, value.max.z);
  for (const [name, vector] of [
    ["min", min],
    ["max", max],
  ] as const) {
    if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
      throw new Error(`ProbeVolume bounds.${name} must contain finite x, y, and z values.`);
    }
  }
  if (!(min.x < max.x && min.y < max.y && min.z < max.z)) {
    throw new Error(
      "ProbeVolume bounds must be non-degenerate and min must be below max on every axis.",
    );
  }
  return new Box3(min, max);
}

function normalizeDensity(value: ProbeVolumeDensity): Vector3 {
  let density: Vector3;
  if (typeof value === "number") {
    density = new Vector3(value, value, value);
  } else if ("x" in value) {
    density = new Vector3(value.x, value.y, value.z);
  } else {
    density = new Vector3(value[0] ?? Number.NaN, value[1] ?? Number.NaN, value[2] ?? Number.NaN);
  }
  if (![density.x, density.y, density.z].every((axis) => Number.isFinite(axis) && axis > 0)) {
    throw new Error("ProbeVolume density must be finite and greater than zero on every axis.");
  }
  return density;
}

function resolutionForAxis(size: number, density: number, axis: string): number {
  const resolution = Math.ceil(size * density) + 1;
  if (!Number.isSafeInteger(resolution) || resolution < 2) {
    throw new Error(`ProbeVolume density on ${axis} produces an invalid probe resolution.`);
  }
  return resolution;
}

function checkedAtlasDepth(zResolution: number): number {
  const depth = PACKED_SUB_VOLUME_COUNT * (zResolution + 2 * ATLAS_PADDING);
  if (!Number.isSafeInteger(depth)) {
    throw new Error("ProbeVolume maxTextureDimension3D would be exceeded by the atlas depth.");
  }
  return depth;
}

function checkedIntegerProduct(a: number, b: number, c: number, label: string): number {
  const result = a * b * c;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`ProbeVolume ${label} exceeds the device texture limit.`);
  }
  return result;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`ProbeVolume ${name} must be finite and positive.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`ProbeVolume ${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`ProbeVolume ${name} must be a non-negative integer.`);
  return value;
}

function validateTextureLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `ProbeVolume maxTextureDimension3D must be a positive integer, received ${String(value)}.`,
    );
  }
}

function assertTextureLimit(dimension: number, limit: number): void {
  if (dimension > limit) {
    throw new Error(
      `ProbeVolume atlas dimension ${dimension} exceeds maxTextureDimension3D device texture limit ${limit}.`,
    );
  }
}

function readTextureLimit(renderer: IProbeRenderer): number | undefined {
  const limit =
    renderer.backend?.device?.limits?.maxTextureDimension3D ??
    renderer.device?.limits?.maxTextureDimension3D;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function isProbeVolumeObservation(value: unknown): value is IProbeVolumeObservation {
  if (!isRecord(value) || value.marker !== PROBE_VOLUME_MARKER) return false;
  const atlas = value.atlas;
  const progress = value.bakeProgress;
  const status = value.status;
  const stale = value.stale;
  const unbaked = value.unbaked;
  const stalenessFrames = value.stalenessFrames;
  const probeCount = value.probeCount;
  const atlasBytes = value.atlasBytes;
  const bakeCostMs = value.bakeCostMs;
  const bakeBudgetMs = value.bakeBudgetMs;
  const samplingIsolated = value.samplingIsolated;
  if (
    !isProbeVolumeStatus(status) ||
    typeof stale !== "boolean" ||
    typeof unbaked !== "boolean" ||
    !isStalenessFrames(stalenessFrames) ||
    !isPositiveIntegerValue(probeCount) ||
    !isPositiveIntegerValue(atlasBytes) ||
    !isFiniteNonNegative(bakeCostMs) ||
    !isFinitePositive(bakeBudgetMs) ||
    typeof samplingIsolated !== "boolean"
  )
    return false;
  if (!isProbeVolumeAtlas(atlas, probeCount, atlasBytes)) return false;
  if (!isProbeVolumeBakeProgress(progress, status, probeCount, atlas.depth)) return false;
  if (stale !== (status !== "ready") || unbaked !== (status === "unbaked")) return false;
  if (status === "baking" && samplingIsolated !== (progress.pass === 0)) return false;
  return status !== "ready" || (stalenessFrames !== null && !samplingIsolated);
}

function isProbeVolumeAtlas(
  value: unknown,
  probeCount: number,
  atlasBytes: number,
): value is IProbeVolumeObservation["atlas"] {
  if (!isRecord(value)) return false;
  const width = value.width;
  const height = value.height;
  const depth = value.depth;
  if (
    !isPositiveIntegerValue(width) ||
    !isPositiveIntegerValue(height) ||
    !isPositiveIntegerValue(depth) ||
    width < 2 ||
    height < 2 ||
    depth % PACKED_SUB_VOLUME_COUNT !== 0
  )
    return false;
  const paddedSlices = depth / PACKED_SUB_VOLUME_COUNT;
  const resolutionZ = paddedSlices - 2 * ATLAS_PADDING;
  if (!isPositiveIntegerValue(resolutionZ) || resolutionZ < 2) return false;
  const expectedProbeCount = width * height * resolutionZ;
  const expectedAtlasBytes = width * height * depth * BYTES_PER_TEXEL;
  return (
    isPositiveIntegerValue(expectedProbeCount) &&
    isPositiveIntegerValue(expectedAtlasBytes) &&
    probeCount === expectedProbeCount &&
    atlasBytes === expectedAtlasBytes
  );
}

function isProbeVolumeBakeProgress(
  value: unknown,
  status: IProbeVolumeObservation["status"],
  probeCount: number,
  atlasDepth: number,
): value is IProbeVolumeBakeProgress {
  if (!isProbeVolumeBakeProgressShape(value)) return false;
  const { completed, total, fraction, probesCompleted, probesTotal, pass, passes } = value;
  const expectedProbesTotal = probeCount * passes;
  const workPerPass = probeCount * CAPTURE_WORK_ITEMS_PER_PROBE + atlasDepth;
  const expectedTotal = workPerPass * passes;
  if (
    !isPositiveIntegerValue(expectedProbesTotal) ||
    !isPositiveIntegerValue(workPerPass) ||
    !isPositiveIntegerValue(expectedTotal) ||
    total !== expectedTotal ||
    probesTotal !== expectedProbesTotal ||
    pass >= passes ||
    completed > total ||
    probesCompleted > probesTotal ||
    fraction !== completed / total
  )
    return false;
  if (status === "ready") {
    return completed === total && probesCompleted === probesTotal && pass === passes - 1;
  }
  if (status === "unbaked") {
    return completed === 0 && probesCompleted === 0 && pass === 0;
  }
  if (completed >= total) return false;
  const passWorkStart = pass * workPerPass;
  const passProbesStart = pass * probeCount;
  if (!Number.isSafeInteger(passWorkStart) || !Number.isSafeInteger(passProbesStart)) return false;
  const currentWork = completed - passWorkStart;
  const currentProbes = probesCompleted - passProbesStart;
  if (
    currentWork < 0 ||
    currentWork >= workPerPass ||
    currentProbes < 0 ||
    currentProbes > probeCount
  )
    return false;
  if (currentProbes === probeCount) return currentWork >= probeCount * CAPTURE_WORK_ITEMS_PER_PROBE;
  const minimumWork = currentProbes * CAPTURE_WORK_ITEMS_PER_PROBE;
  return (
    currentWork >= minimumWork && currentWork <= minimumWork + CAPTURE_WORK_ITEMS_PER_PROBE - 1
  );
}

function isProbeVolumeBakeProgressShape(value: unknown): value is IProbeVolumeBakeProgress {
  if (!isRecord(value)) return false;
  return (
    isProgressValue(value.completed) &&
    isProgressValue(value.total) &&
    isUnitInterval(value.fraction) &&
    isProgressValue(value.probesCompleted) &&
    isProgressValue(value.probesTotal) &&
    isProgressValue(value.pass) &&
    isPositiveIntegerValue(value.passes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbeVolumeStatus(value: unknown): value is IProbeVolumeObservation["status"] {
  return value === "unbaked" || value === "baking" || value === "ready";
}

function isStalenessFrames(value: unknown): value is number | null {
  return value === null || isProgressValue(value);
}

function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isProgressValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateProbeIndex(index: number, length: number, name: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(`ProbeVolume ${name} must be an integer in [0, ${length - 1}].`);
  }
}

function valueAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`ProbeVolume ${label} ${index} is missing.`);
  return value;
}

function deferred(): IBakePromise {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function isRendererLike(value: IRendererLike | Scene): value is IRendererLike {
  return typeof value === "object" && value !== null && "kind" in value && "raw" in value;
}
