import type { Texture } from "three";
import { velocity as velocityAccessor } from "three/tsl";
import type { MRTNode, Node } from "three/webgpu";

import type { IFrameBudgetWindow } from "../frame-budget.js";
import type {
  IRenderOutputInstallation,
  IRenderOutputOptions,
  RenderOutputSetter,
  RendererKind,
} from "../renderer.js";
import { VELOCITY_OUTPUT_NAME, velocityTexture, withVelocityContext } from "./velocity.js";
import type { IVelocityRenderPass } from "./velocity.js";

/** The marker shared by render-chain logs, playtests, and native diagnostics. */
export const RENDER_CHAIN_MARKER = "TN_RENDER_CHAIN";

/** Canonical order for the stages a game may request. */
export const RENDER_CHAIN_STAGE_ORDER = [
  "probeVolume",
  "ambientOcclusion",
  "ssgi",
  "godRays",
  "ssr",
  "denoise",
  "temporalReproject",
  "taa",
  "traa",
  "motionBlur",
  "sharpen",
  "bloom",
  "vignette",
  "lensDistortion",
  "sparkle",
  "gradualBackground",
] as const;

export type RenderChainStageName = (typeof RENDER_CHAIN_STAGE_ORDER)[number];
/** Built-in stage names plus an opaque id owned by the game that supplied the stage. */
export type RenderChainStageId = RenderChainStageName | (string & {});
export type RenderChainTier = "high" | "medium" | "low" | "off";
export type RenderChainTierRequest = RenderChainTier | "auto";
export type RenderChainSource = "pinned" | "auto";
export type RenderChainVelocitySource = "mrt" | "per-object" | null;

export interface IRenderChainVelocityMeasurement {
  /** Monotonic frame number derived from the stage's completed velocity result. */
  readonly frame: number;
  /** Share of result pixels whose temporal history was rejected in that frame. */
  readonly rejectionFraction: number;
}

export interface IRenderChainVelocityResult {
  /** Monotonic frame number from the active temporal stage's completed result. */
  readonly frame: number;
  /** One binary value per result pixel: one means the temporal history was rejected. */
  readonly rejectionMask: ArrayLike<number>;
}

export interface IRenderChainRenderer {
  readonly kind: RendererKind;
  readonly raw: unknown;
  clearOutputNode?(expectedNode?: unknown): void;
  /** Internal renderer seam used to turn on core-owned previous-frame bookkeeping for active temporal stages. */
  setRenderChainVelocityEnabled?(enabled: boolean): void;
  /** Install a graph and identify the authored world pass that follows the rendered scene root. */
  setOutputNode: RenderOutputSetter;
}

const TIER_LEVEL: Record<RenderChainTier, number> = {
  high: 3,
  low: 1,
  medium: 2,
  off: 0,
};

/** Quality values are algorithm parameters, not appearance values. Templates own the latter. */
export const RENDER_CHAIN_TIERS = {
  high: { denoiseIterations: 3, sliceCount: 3, stepCount: 16 },
  low: { denoiseIterations: 1, sliceCount: 1, stepCount: 12 },
  medium: { denoiseIterations: 2, sliceCount: 2, stepCount: 8 },
  off: { denoiseIterations: 0, sliceCount: 0, stepCount: 0 },
} as const satisfies Record<
  RenderChainTier,
  {
    denoiseIterations: number;
    sliceCount: number;
    stepCount: number;
  }
>;

const VELOCITY_STAGES = new Set<RenderChainStageName>([
  "motionBlur",
  "taa",
  "temporalReproject",
  "traa",
]);

export interface IRenderChainVelocityRequest {
  /** The scene pass that owns the shared velocity output. */
  pass?: IVelocityRenderPass;
  /** Treat the renderer's MRT velocity output as provisioned. */
  mrt?: boolean;
  /** Treat objects carrying `userData.useVelocity === true` as provisioned. */
  objectFlags?: boolean;
  /** Alias accepted by integrations that call this route per-object velocity. */
  perObject?: boolean;
  /**
   * Compatibility source for completed temporal measurements. The stage reader wins when it
   * returns a result; this callback is consulted when an integration cannot expose that reader.
   */
  rejectionMeasurement?: () => IRenderChainVelocityMeasurement | undefined;
  /** Explicit route, useful for a native host whose MRT is not introspectable from JavaScript. */
  source?: Exclude<RenderChainVelocitySource, null>;
}

export interface IRenderChainRequest {
  /** Built-ins use canonical order; authored stages use their supplied anchor order. */
  stages?: readonly RenderChainStageId[];
  /** A fixed tier pins quality; `auto` enables the measured frame-budget ladder. */
  tier?: RenderChainTierRequest;
  velocity?: IRenderChainVelocityRequest;
}

export interface IRenderChainStageContext {
  readonly tier: RenderChainTier;
  readonly velocity: IRenderChainVelocityReport;
  /** TSL source handed to temporal stages when the request owns a scene pass. */
  readonly velocityNode?: Node;
  readonly quality: (typeof RENDER_CHAIN_TIERS)[RenderChainTier];
}

export interface IRenderChainStage {
  readonly name: RenderChainStageId;
  /** Place an authored stage immediately before this built-in or supplied stage. */
  readonly before?: RenderChainStageId;
  /** Place an authored stage immediately after this built-in or supplied stage. */
  readonly after?: RenderChainStageId;
  /**
   * This stage reads display-referred colour, so the chain installs the graph with the renderer's
   * automatic output transform switched off and the stage applies that transform itself.
   *
   * Mechanism, not look. Some effects are defined against the sRGB picture — a `.cube` table, a
   * sharpening or edge filter — and bending scene-referred light into that domain costs precision
   * instead of buying anything: measured on an 8-bit table, a bijective log shaper costs 2–4
   * 8-bit steps per channel against under 1 for the transform this names (PRD-492).
   *
   * The stage therefore runs last, and may not declare an anchor: a stage placed after it would
   * receive display-referred colour it was not written for.
   */
  readonly afterOutputTransform?: boolean;
  readonly build: (input: unknown, context: IRenderChainStageContext) => unknown;
  /** Stages below this tier are named as dropped instead of silently changing the graph. */
  readonly minimumTier?: RenderChainTier;
  /** Return a reason to drop the stage on this target, or true when it is available. */
  readonly available?: (context: IRenderChainStageContext) => boolean | string;
  /** Read the completed velocity result after rendering; the chain derives its rejection fraction. */
  readonly readVelocityResult?: (node: unknown) => IRenderChainVelocityResult | undefined;
  /** Defaults from the canonical stage name for the temporal stages. */
  readonly requiresVelocity?: boolean;
  /** Release resources allocated while building this stage's graph. */
  readonly dispose?: () => void;
}

export interface IRenderChainDroppedStage {
  readonly name: RenderChainStageId;
  readonly reason: string;
}

export interface IRenderChainVelocityReport {
  readonly provisioned: boolean;
  readonly required: boolean;
  readonly source: RenderChainVelocitySource;
  readonly rejectionFraction?: number;
  readonly measurementFrame?: number;
}

export interface IRenderChainApplied {
  readonly contributions: readonly {
    readonly graphOutputChanged: boolean;
    readonly name: RenderChainStageId;
  }[];
  readonly dropped: readonly IRenderChainDroppedStage[];
  readonly requested: readonly RenderChainStageId[];
  readonly source: RenderChainSource;
  readonly stages: readonly RenderChainStageId[];
  readonly tier: RenderChainTier;
  readonly velocity: IRenderChainVelocityReport;
}

export interface IRenderChainMarker {
  readonly applied: IRenderChainApplied;
  readonly marker: typeof RENDER_CHAIN_MARKER;
}

export interface IRenderChainBudgetWindow {
  /** Compilation-contaminated windows remain observable but cannot drive quality changes. */
  readonly surface?: Pick<NonNullable<IFrameBudgetWindow["surface"]>, "compiling">;
  readonly phases: {
    readonly render: Pick<IFrameBudgetWindow["phases"]["render"], "p95">;
  };
}

export interface IRenderChainOptions {
  readonly renderer: IRenderChainRenderer;
  readonly input?: unknown;
  /** Explicit scene pass for output retargeting; avoids traversing a composed graph to find it. */
  readonly worldPass?: unknown;
  readonly report?: (line: string) => void;
  readonly request?: IRenderChainRequest;
  readonly stages?: readonly IRenderChainStage[];
  readonly targetFps?: number;
  /** Number of consecutive over-budget windows before the automatic ladder steps down. */
  readonly dwellWindows?: number;
  /** Optional scene-like traversal for detecting `userData.useVelocity` flags. */
  readonly scene?: {
    traverse(callback: (object: { userData?: Record<string, unknown> }) => void): void;
  };
}

/**
 * Where a chain publishes its last report: a registered symbol on the renderer, not a
 * module-scoped map.
 *
 * `tsup` emits `dist/playtest.js` as its own entry with its own copy of this module, so the
 * browser bridge that reads the report is never the copy that wrote it. A `WeakMap` in module
 * scope is therefore written by one copy and read by another, and `readRenderChainObservation`
 * returned `undefined` for every installed chain — every `renderChain` assertion failed closed
 * as UNOBSERVABLE while the chain was running and printing its marker. `Symbol.for` is one key
 * across every copy of this module, and the report lives on the thing it is about.
 */
const REPORT_KEY = Symbol.for("threenative.renderChain.report");

function storedReport(target: object): IRenderChainMarker | undefined {
  return (target as Record<symbol, IRenderChainMarker | undefined>)[REPORT_KEY];
}

function storeReport(target: object, marker: IRenderChainMarker | undefined): void {
  Object.defineProperty(target, REPORT_KEY, {
    configurable: true,
    enumerable: false,
    value: marker,
    writable: true,
  });
}

/**
 * Read the last chain marker associated with a renderer or its raw renderer.
 * @situation expose the render tier and dropped-stage reasons to a playtest
 * @situation inspect whether a temporal pass received velocity
 * @constraint an absent value means no chain was installed and must fail a chain assertion
 * @example const chain = readRenderChainReport(ctx.renderer);
 */
export function readRenderChainReport(renderer: unknown): IRenderChainMarker | undefined {
  if (!isObject(renderer)) return undefined;
  const raw = readRawRenderer(renderer);
  return storedReport(renderer) ?? (isObject(raw) ? storedReport(raw) : undefined);
}

/** JSON-safe observation used by the browser and native playtest bridges. */
export function readRenderChainObservation(
  renderer: unknown,
): IRenderChainMarker["applied"] | undefined {
  return readRenderChainReport(renderer)?.applied;
}

/**
 * Compose game-provided nodes through one ordered, measured, honest render seam.
 *
 * The chain owns only stage ordering, availability, velocity provisioning and quality selection.
 * Every stage factory is supplied by the game/template, so this module never chooses a material,
 * colour, light, shader or post-processing look.
 */
export class RenderChain {
  readonly #renderer: IRenderChainRenderer;
  readonly #input: unknown;
  readonly #worldPass: unknown;
  readonly #report: (line: string) => void;
  readonly #stageDefinitions: ReadonlyMap<RenderChainStageId, IRenderChainStage>;
  readonly #requested: readonly RenderChainStageId[];
  readonly #requestVelocity: IRenderChainVelocityRequest;
  readonly #automatic: boolean;
  readonly #targetFps: number;
  readonly #dwellWindows: number;
  readonly #scene: IRenderChainOptions["scene"];
  #activeStageDefinitions: IRenderChainStage[] = [];
  #tier: RenderChainTier;
  #source: RenderChainSource;
  #overBudgetWindows = 0;
  #lastMeasurementFrame: number | undefined;
  #reportedMeasurement = false;
  #velocityResultNode: unknown = undefined;
  #velocityResultReader: ((node: unknown) => IRenderChainVelocityResult | undefined) | undefined =
    undefined;
  #ownedVelocityPass: IVelocityRenderPass | undefined = undefined;
  #ownedVelocityMrt: MRTNode | null | undefined = undefined;
  #ownedVelocityTexture: Texture | undefined = undefined;
  #disposed = false;
  #installedNode: unknown;
  #installation: IRenderOutputInstallation | undefined;
  #applied: IRenderChainApplied;

  constructor(renderer: IRenderChainRenderer, options?: Omit<IRenderChainOptions, "renderer">);
  constructor(options: IRenderChainOptions);
  constructor(
    rendererOrOptions: IRenderChainRenderer | IRenderChainOptions,
    suppliedOptions: Omit<IRenderChainOptions, "renderer"> = {},
  ) {
    const options = isRenderer(rendererOrOptions)
      ? { ...suppliedOptions, renderer: rendererOrOptions }
      : rendererOrOptions;
    this.#renderer = options.renderer;
    this.#input = options.input;
    this.#worldPass = options.worldPass;
    this.#report = options.report ?? ((line) => console.log(line));
    this.#stageDefinitions = createStageDefinitions(options.stages ?? []);
    this.#requested = normalizeRequestedStages(
      options.request?.stages ?? [],
      this.#stageDefinitions,
    );
    this.#requestVelocity = options.request?.velocity ?? {};
    this.#automatic = (options.request?.tier ?? "high") === "auto";
    this.#tier = this.#automatic ? "high" : validateTier(options.request?.tier ?? "high");
    this.#source = this.#automatic ? "auto" : "pinned";
    this.#targetFps = requirePositiveNumber(options.targetFps ?? 60, "targetFps");
    this.#dwellWindows = requirePositiveInteger(options.dwellWindows ?? 2, "dwellWindows");
    this.#scene = options.scene;
    this.#applied = emptyApplied(this.#requested, this.#tier, this.#source, false);
    this.apply();
  }

  get applied(): IRenderChainApplied {
    return this.#applied;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Rebuild and install the current tier. */
  apply(): IRenderChainApplied {
    if (this.#disposed) throw new Error("RenderChain.apply called after dispose().");
    this.#disposeActiveStages();
    this.#restoreOwnedVelocityOutput();
    this.#velocityResultNode = undefined;
    this.#velocityResultReader = undefined;
    if (this.#requested.length === 0) {
      this.#applied = emptyApplied([], this.#tier, this.#source, false);
      this.#lastMeasurementFrame = undefined;
      this.#reportedMeasurement = false;
      this.#renderer.setRenderChainVelocityEnabled?.(false);
      forgetReport(this.#renderer);
      return this.#applied;
    }

    const requiredVelocity = this.#requested.some((name) =>
      requiresVelocityFor(this.#stageDefinitions.get(name), name),
    );
    const velocity = resolveVelocity(
      this.#renderer,
      this.#requestVelocity,
      this.#scene,
      requiredVelocity,
    );
    let velocityNode: Node | undefined;
    const originalMrt = this.#requestVelocity.pass?.getMRT();
    this.#lastMeasurementFrame = undefined;
    this.#reportedMeasurement = false;
    const dropped: IRenderChainDroppedStage[] = [];
    const contributions: Array<IRenderChainApplied["contributions"][number]> = [];
    const stages: RenderChainStageId[] = [];
    const builtStageDefinitions: IRenderChainStage[] = [];
    let node = this.#input;

    for (const name of this.#requested) {
      if (this.#tier === "off") {
        dropped.push({ name, reason: "tier:off" });
        continue;
      }
      const definition = this.#stageDefinitions.get(name);
      if (definition === undefined) {
        dropped.push({ name, reason: "provider:missing" });
        continue;
      }
      if (this.#renderer.kind !== "webgpu") {
        dropped.push({ name, reason: `renderer:${this.#renderer.kind}` });
        continue;
      }
      if (
        definition.minimumTier !== undefined &&
        TIER_LEVEL[this.#tier] < TIER_LEVEL[definition.minimumTier]
      ) {
        dropped.push({ name, reason: `tier:${this.#tier}` });
        continue;
      }
      const requiresVelocity = requiresVelocityFor(definition, name);
      if (requiresVelocity && !velocity.provisioned) {
        dropped.push({ name, reason: "velocity:missing" });
        continue;
      }
      const context = stageContext(this.#tier, velocity, velocityNode);
      const availability = definition.available?.(context);
      if (availability === false) {
        dropped.push({ name, reason: `unavailable:${this.#renderer.kind}` });
        continue;
      }
      if (typeof availability === "string") {
        dropped.push({ name, reason: availability });
        continue;
      }
      try {
        if (
          requiresVelocity &&
          velocityNode === undefined &&
          velocity.source === "mrt" &&
          this.#requestVelocity.pass !== undefined
        ) {
          const pass = this.#requestVelocity.pass;
          const priorTextures = [...(pass.renderTarget?.textures ?? [])];
          velocityNode = velocityTexture(pass);
          this.#ownedVelocityPass = pass;
          this.#ownedVelocityMrt = originalMrt;
          if (originalMrt?.has(VELOCITY_OUTPUT_NAME) !== true)
            this.#ownedVelocityTexture = pass.renderTarget?.textures.find(
              (texture) =>
                texture.name === VELOCITY_OUTPUT_NAME && !priorTextures.includes(texture),
            );
        }
        const buildContext = stageContext(this.#tier, velocity, velocityNode);
        const next = definition.build(node, buildContext);
        if (next === undefined || next === null) throw new Error("stage returned no node");
        contributions.push({ graphOutputChanged: next !== node, name });
        node = next;
        stages.push(name);
        builtStageDefinitions.push(definition);
        if (requiresVelocity && definition.readVelocityResult !== undefined) {
          this.#velocityResultNode = next;
          this.#velocityResultReader = definition.readVelocityResult;
        }
      } catch (error) {
        definition.dispose?.();
        dropped.push({ name, reason: `build:${errorMessage(error)}` });
      }
    }

    const hasActiveVelocityStage = stages.some((name) =>
      requiresVelocityFor(this.#stageDefinitions.get(name), name),
    );
    // Temporal nodes jitter the scene-side velocity node (TRAANode calls setProjectionMatrix on
    // it); the pass texture is what a stage samples, so it stays on the build context only.
    if (velocityNode !== undefined && hasActiveVelocityStage)
      // TRAANode uses context.velocity to set the unjittered projection, not to sample MRT.
      // The sampled texture already travels to the factory via context.velocityNode.
      node = withVelocityContext(node, velocityAccessor);

    if (stages.length > 0) {
      try {
        // Only a stage that actually ran may take the transform away from the renderer; a
        // dropped one would leave the frame untone-mapped with nothing to have applied it.
        const outputOptions: IRenderOutputOptions[] = builtStageDefinitions.some(
          (definition) => definition.afterOutputTransform === true,
        )
          ? [{ outputColorTransform: false }]
          : [];
        const installation = this.#renderer.setOutputNode(
          node,
          this.#worldPass ?? this.#requestVelocity.pass,
          ...outputOptions,
        );
        // Historical void-style callbacks can return an ignored value (for example Array.push).
        // Only an explicit receipt upgrades that adapter to installation ownership.
        this.#installation =
          installation &&
          typeof installation.isCurrent === "function" &&
          typeof installation.dispose === "function"
            ? installation
            : undefined;
        this.#installedNode = node;
      } catch (error) {
        const reason = `install:${errorMessage(error)}`;
        dropped.push(...stages.map((name) => ({ name, reason })));
        stages.length = 0;
        contributions.length = 0;
        for (const definition of builtStageDefinitions) definition.dispose?.();
        builtStageDefinitions.length = 0;
        // A renderer may throw after partially installing this attempt. Clear that identity,
        // then the prior owned graph, without touching an unrelated replacement.
        this.#renderer.clearOutputNode?.(node);
        this.#clearOwnedOutput();
      }
    } else {
      this.#clearOwnedOutput();
    }

    const activeVelocity = stages.some((name) =>
      requiresVelocityFor(this.#stageDefinitions.get(name), name),
    );
    if (!activeVelocity) {
      this.#restoreOwnedVelocityOutput();
      this.#velocityResultNode = undefined;
      this.#velocityResultReader = undefined;
    }
    const appliedVelocity = activeVelocity
      ? velocity
      : { provisioned: false, required: velocity.required, source: null };

    this.#applied = {
      contributions,
      dropped,
      requested: this.#requested,
      source: this.#source,
      stages,
      tier: this.#tier,
      velocity: appliedVelocity,
    };
    this.#activeStageDefinitions = builtStageDefinitions;
    this.#renderer.setRenderChainVelocityEnabled?.(
      stages.some((name) => requiresVelocityFor(this.#stageDefinitions.get(name), name)),
    );
    this.#publish(true);
    return this.#applied;
  }

  /** Samples the active temporal stage's completed velocity result after rendering. */
  observeFrame(): IRenderChainApplied {
    if (this.#disposed) throw new Error("RenderChain.observeFrame called after dispose().");
    if (this.#installation?.isCurrent() === false) return this.#applied;
    const requiresMeasurement = this.#applied.stages.some((name) =>
      requiresVelocityFor(this.#stageDefinitions.get(name), name),
    );
    if (!requiresMeasurement) return this.#applied;

    const result = this.#velocityResultReader?.(this.#velocityResultNode);
    const measurement =
      result === undefined
        ? validateCompatibilityMeasurement(
            this.#requestVelocity.rejectionMeasurement?.(),
            this.#lastMeasurementFrame,
          )
        : deriveVelocityMeasurement(result, this.#lastMeasurementFrame);
    if (measurement === undefined) {
      this.#setMeasurement(undefined, false);
      return this.#applied;
    }
    this.#lastMeasurementFrame = measurement.frame;
    this.#setMeasurement(measurement, !this.#reportedMeasurement || measurement.frame % 60 === 0);
    return this.#applied;
  }

  /** Feed the chain the same render-window evidence used by the frame budget. */
  observeFrameBudget(window: IRenderChainBudgetWindow): RenderChainTier {
    if (this.#disposed) throw new Error("RenderChain.observeFrameBudget called after dispose().");
    if (!this.#automatic || this.#installation?.isCurrent() === false) return this.#tier;
    const renderP95 = window.phases.render?.p95;
    if (typeof renderP95 !== "number" || !Number.isFinite(renderP95) || renderP95 < 0) {
      throw new Error("RenderChain frame budget render.p95 must be a finite non-negative number.");
    }
    const compiling = window.surface?.compiling;
    if (compiling !== undefined && typeof compiling !== "boolean") {
      throw new Error(
        "RenderChain frame budget surface.compiling must be a boolean when observed.",
      );
    }
    if (compiling === true) {
      // Compilation is not steady-state render cost. It also retains resources that a tier
      // rebuild disposes, so only consecutive clean windows may replace the active stages.
      this.#overBudgetWindows = 0;
      return this.#tier;
    }
    const budgetMs = 1_000 / this.#targetFps;
    if (renderP95 > budgetMs) this.#overBudgetWindows += 1;
    else this.#overBudgetWindows = 0;
    if (this.#overBudgetWindows >= this.#dwellWindows) {
      this.#overBudgetWindows = 0;
      const next = nextLowerTier(this.#tier);
      if (next !== this.#tier) {
        this.#tier = next;
        this.#source = "auto";
        this.apply();
      }
    }
    return this.#tier;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeActiveStages();
    this.#restoreOwnedVelocityOutput();
    this.#renderer.setRenderChainVelocityEnabled?.(false);
    this.#clearOwnedOutput();
    forgetReport(this.#renderer);
  }

  #clearOwnedOutput(): void {
    if (this.#installation !== undefined) this.#installation.dispose();
    // Compatibility only: a void-returning adapter cannot distinguish same-node reinstalls.
    else if (this.#installedNode !== undefined)
      this.#renderer.clearOutputNode?.(this.#installedNode);
    this.#installation = undefined;
    this.#installedNode = undefined;
  }

  #setMeasurement(measurement: IRenderChainVelocityMeasurement | undefined, emit: boolean): void {
    const { provisioned, required, source } = this.#applied.velocity;
    this.#applied = {
      ...this.#applied,
      velocity: {
        provisioned,
        required,
        source,
        ...(measurement === undefined
          ? {}
          : {
              measurementFrame: measurement.frame,
              rejectionFraction: measurement.rejectionFraction,
            }),
      },
    };
    if (measurement !== undefined) this.#reportedMeasurement = true;
    this.#publish(emit);
  }

  #publish(emit: boolean): void {
    const marker: IRenderChainMarker = { applied: this.#applied, marker: RENDER_CHAIN_MARKER };
    rememberReport(this.#renderer, marker);
    if (emit) this.#report(`${RENDER_CHAIN_MARKER}:${JSON.stringify(marker)}`);
  }

  #restoreOwnedVelocityOutput(): void {
    if (this.#ownedVelocityPass !== undefined && this.#ownedVelocityMrt !== undefined) {
      this.#ownedVelocityPass.setMRT(this.#ownedVelocityMrt);
      const target = this.#ownedVelocityPass.renderTarget;
      const texture = this.#ownedVelocityTexture;
      if (target !== undefined && texture !== undefined) {
        const index = target.textures.indexOf(texture);
        if (index !== -1) {
          // Three must destroy the old GPU attachment set before the cached texture is detached.
          target.dispose();
          target.textures.splice(index, 1);
        }
      }
    }
    this.#ownedVelocityPass = undefined;
    this.#ownedVelocityMrt = undefined;
    this.#ownedVelocityTexture = undefined;
  }

  #disposeActiveStages(): void {
    for (const definition of this.#activeStageDefinitions) definition.dispose?.();
    this.#activeStageDefinitions = [];
  }
}

function createStageDefinitions(
  stages: readonly IRenderChainStage[],
): ReadonlyMap<RenderChainStageId, IRenderChainStage> {
  const definitions = new Map<RenderChainStageId, IRenderChainStage>();
  for (const stage of stages) {
    const name = requireStageId(stage.name, "render-chain stage");
    if (definitions.has(name)) throw new Error(`duplicate render-chain stage '${stage.name}'`);
    if (typeof stage.build !== "function")
      throw new Error(`render-chain stage '${name}' needs a build function`);
    const hasBefore = stage.before !== undefined;
    const hasAfter = stage.after !== undefined;
    if (stage.afterOutputTransform === true && (hasBefore || hasAfter)) {
      throw new Error(
        `render-chain stage '${name}' declares afterOutputTransform and an anchor; a stage that reads display-referred colour is last by construction, so an anchor is either ignored or wrong`,
      );
    }
    if (isBuiltInStageId(name)) {
      if (hasBefore || hasAfter) {
        throw new Error(
          `built-in render-chain stage '${name}' cannot declare before or after; its canonical order is fixed`,
        );
      }
    } else if (hasBefore === hasAfter && stage.afterOutputTransform !== true) {
      throw new Error(
        `authored render-chain stage '${name}' must declare exactly one of before or after`,
      );
    }
    if (hasBefore) requireStageId(stage.before, `render-chain stage '${name}' before anchor`);
    if (hasAfter) requireStageId(stage.after, `render-chain stage '${name}' after anchor`);
    definitions.set(name, stage);
  }
  for (const [name, stage] of definitions) {
    const anchor = stage.before ?? stage.after;
    if (anchor !== undefined && !isBuiltInStageId(anchor) && !definitions.has(anchor)) {
      throw new Error(`render-chain stage '${name}' anchor '${anchor}' is missing`);
    }
  }
  resolveStageOrder(definitions);
  return definitions;
}

function normalizeRequestedStages(
  stages: readonly RenderChainStageId[],
  definitions: ReadonlyMap<RenderChainStageId, IRenderChainStage>,
): readonly RenderChainStageId[] {
  const requested = new Set<RenderChainStageId>();
  for (const name of stages) {
    const id = requireStageId(name, "requested render-chain stage");
    if (requested.has(id)) throw new Error(`duplicate requested render-chain stage '${id}'`);
    // A built-in needs no supplied definition, the same allowance the anchor check above makes.
    // Requesting one the tier or the provider then drops is ordinary — `traa` at `tier: "off"`
    // is a dropped stage with a reason, not an unknown name — and refusing it here turned that
    // into a throw on the shipped path.
    if (!isBuiltInStageId(id) && !definitions.has(id)) {
      throw new Error(`unknown render-chain stage '${id}': no supplied definition`);
    }
    requested.add(id);
  }
  return resolveStageOrder(definitions, requested).filter((name) => requested.has(name));
}

function resolveStageOrder(
  definitions: ReadonlyMap<RenderChainStageId, IRenderChainStage>,
  additionalIds: Iterable<RenderChainStageId> = [],
): readonly RenderChainStageId[] {
  const ranks = new Map<RenderChainStageId, number>();
  const visiting: RenderChainStageId[] = [];
  const step = 1 / (definitions.size + 1);
  const rank = (id: RenderChainStageId): number => {
    const builtInIndex = RENDER_CHAIN_STAGE_ORDER.indexOf(id as RenderChainStageName);
    if (builtInIndex >= 0) return builtInIndex;
    const known = ranks.get(id);
    if (known !== undefined) return known;
    const cycleStart = visiting.indexOf(id);
    if (cycleStart >= 0) {
      const cycle = [...visiting.slice(cycleStart), id].join(" -> ");
      throw new Error(`render-chain stage anchor cycle: ${cycle}`);
    }
    const definition = definitions.get(id);
    if (definition === undefined) {
      throw new Error(`render-chain stage '${id}' has no supplied definition`);
    }
    // The output transform's own seat. No stage may follow it, so it outranks every anchor
    // without needing one, and it needs no anchor to be ordered.
    if (definition.afterOutputTransform === true) {
      ranks.set(id, RENDER_CHAIN_STAGE_ORDER.length + 1);
      return ranks.get(id) as number;
    }
    const anchor = definition.before ?? definition.after;
    if (anchor === undefined) {
      throw new Error(`authored render-chain stage '${id}' has no anchor`);
    }
    visiting.push(id);
    const anchorRank = rank(anchor);
    visiting.pop();
    const resolved = anchorRank + (definition.before === undefined ? step : -step);
    ranks.set(id, resolved);
    return resolved;
  };

  const ordered = [...new Set([...definitions.keys(), ...additionalIds])].map((id, index) => ({
    id,
    index,
    rank: rank(id),
  }));
  ordered.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return ordered.map(({ id }) => id);
}

function requireStageId(value: unknown, label: string): RenderChainStageId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} id must be a non-blank string; received ${String(value)}`);
  }
  return value as RenderChainStageId;
}

function isBuiltInStageId(value: RenderChainStageId): value is RenderChainStageName {
  return (RENDER_CHAIN_STAGE_ORDER as readonly string[]).includes(value);
}

function requiresVelocityFor(
  definition: IRenderChainStage | undefined,
  id: RenderChainStageId,
): boolean {
  return definition?.requiresVelocity ?? (isBuiltInStageId(id) && VELOCITY_STAGES.has(id));
}

function validateTier(value: unknown): RenderChainTier {
  if (value === "high" || value === "medium" || value === "low" || value === "off") return value;
  throw new Error(
    `RenderChain tier must be high, medium, low, off, or auto; received ${String(value)}.`,
  );
}

function resolveVelocity(
  renderer: IRenderChainRenderer,
  request: IRenderChainVelocityRequest,
  scene: IRenderChainOptions["scene"],
  required: boolean,
): IRenderChainVelocityReport {
  if (!required) return { provisioned: false, required: false, source: null };
  const source =
    request.source ??
    (request.pass !== undefined || request.mrt === true || hasMrtVelocity(renderer.raw)
      ? "mrt"
      : undefined) ??
    (request.objectFlags === true || request.perObject === true || hasObjectVelocityFlag(scene)
      ? "per-object"
      : null);
  return { provisioned: source !== null, required: true, source };
}

function hasMrtVelocity(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  const getMrt = raw.getMRT;
  if (typeof getMrt === "function") {
    try {
      if (containsVelocity(getMrt.call(raw))) return true;
    } catch {
      return false;
    }
  }
  return containsVelocity(raw.mrt) || containsVelocity(raw.mrtOutputs);
}

function containsVelocity(value: unknown): boolean {
  if (value instanceof Set || value instanceof Map) return value.has("velocity");
  if (Array.isArray(value)) return value.includes("velocity");
  return isObject(value) && value.velocity === true;
}

function hasObjectVelocityFlag(scene: IRenderChainOptions["scene"]): boolean {
  if (scene === undefined) return false;
  let found = false;
  scene.traverse((object) => {
    if (object.userData?.useVelocity === true) found = true;
  });
  return found;
}

function stageContext(
  tier: RenderChainTier,
  velocity: IRenderChainVelocityReport,
  velocityNode: Node | undefined,
): IRenderChainStageContext {
  return {
    quality: RENDER_CHAIN_TIERS[tier],
    tier,
    velocity,
    ...(velocityNode === undefined ? {} : { velocityNode }),
  };
}

function deriveVelocityMeasurement(
  result: IRenderChainVelocityResult,
  previousFrame: number | undefined,
): IRenderChainVelocityMeasurement {
  if (!Number.isInteger(result.frame) || result.frame < 0) {
    throw new Error(
      `RenderChain velocity result frame must be a non-negative integer, received ${String(result.frame)}.`,
    );
  }
  if (previousFrame !== undefined && result.frame <= previousFrame) {
    throw new Error(
      `RenderChain velocity result frame must advance beyond ${String(previousFrame)}, received ${String(result.frame)}.`,
    );
  }
  if (!Number.isInteger(result.rejectionMask.length) || result.rejectionMask.length <= 0) {
    throw new Error("RenderChain velocity result rejectionMask must contain at least one pixel.");
  }
  let rejected = 0;
  for (let index = 0; index < result.rejectionMask.length; index += 1) {
    const value = result.rejectionMask[index];
    if (value !== 0 && value !== 1) {
      throw new Error(
        `RenderChain velocity result rejectionMask[${String(index)}] must be 0 or 1, received ${String(value)}.`,
      );
    }
    rejected += value;
  }
  return {
    frame: result.frame,
    rejectionFraction: rejected / result.rejectionMask.length,
  };
}

function validateCompatibilityMeasurement(
  value: unknown,
  previousFrame: number | undefined,
): IRenderChainVelocityMeasurement | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value))
    throw new Error("RenderChain rejectionMeasurement must return an object or undefined.");
  const frame = value.frame;
  const rejectionFraction = value.rejectionFraction;
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0) {
    throw new Error(
      `RenderChain rejectionMeasurement frame must be a non-negative integer, received ${String(frame)}.`,
    );
  }
  if (previousFrame !== undefined && frame <= previousFrame) {
    throw new Error(
      `RenderChain rejectionMeasurement frame must advance beyond ${String(previousFrame)}, received ${String(frame)}.`,
    );
  }
  if (
    typeof rejectionFraction !== "number" ||
    !Number.isFinite(rejectionFraction) ||
    rejectionFraction < 0 ||
    rejectionFraction > 1
  ) {
    throw new Error(
      `RenderChain rejectionMeasurement rejectionFraction must be between 0 and 1, received ${String(rejectionFraction)}.`,
    );
  }
  return { frame, rejectionFraction };
}

function emptyApplied(
  requested: readonly RenderChainStageId[],
  tier: RenderChainTier,
  source: RenderChainSource,
  required: boolean,
): IRenderChainApplied {
  return {
    contributions: [],
    dropped: [],
    requested,
    source,
    stages: [],
    tier,
    velocity: { provisioned: false, required, source: null },
  };
}

function nextLowerTier(tier: RenderChainTier): RenderChainTier {
  if (tier === "high") return "medium";
  if (tier === "medium") return "low";
  if (tier === "low") return "off";
  return "off";
}

function rememberReport(renderer: IRenderChainRenderer, marker: IRenderChainMarker): void {
  if (isObject(renderer)) storeReport(renderer, marker);
  if (isObject(renderer.raw)) storeReport(renderer.raw, marker);
}

function forgetReport(renderer: IRenderChainRenderer): void {
  if (isObject(renderer)) storeReport(renderer, undefined);
  if (isObject(renderer.raw)) storeReport(renderer.raw, undefined);
}

function readRawRenderer(renderer: object): unknown {
  return "raw" in renderer ? renderer.raw : renderer;
}

function isRenderer(
  value: IRenderChainRenderer | IRenderChainOptions,
): value is IRenderChainRenderer {
  return isObject(value) && "kind" in value && "setOutputNode" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`RenderChain ${name} must be a positive integer.`);
  return value;
}

function requirePositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`RenderChain ${name} must be a finite positive number.`);
  return value;
}

export type { RendererKind };
