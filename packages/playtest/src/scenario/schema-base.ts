import type { IToneMetrics, IToneRegion, IToneComparison } from "../tone.js";
import type { IPlaytestGeometryCaptureRequest, PlaytestFramePassKind, PlaytestFramePhase } from "../protocol.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PLAYTEST_ASSERTION_REGISTRY } from "../assertions.js";

export const NUMERIC_COMPARISON_KEYS = ["gte", "lte"] as const;
export const MIN_TRIVIALITY_REASON_LENGTH = 20;

export type PlaytestTarget = "web" | "desktop" | "bevy";
export type PlaytestInputDelivery = "deterministic" | "focused-dom";

export interface IPlaytestViewport {
  height: number;
  width: number;
}

export interface IPlaytestPointer {
  buttons?: number;
  id: number;
  x: number;
  y: number;
}

export interface IPlaytestWheel {
  deltaX?: number;
  deltaY: number;
  /** Normalized viewport point the wheel turns over (both or neither); the viewport centre when absent. */
  x?: number;
  y?: number;
}

/** Emulated media features, Playwright's `emulateMedia` vocabulary; an absent key keeps its value. */
export interface IPlaytestMedia {
  colorScheme?: "dark" | "light";
  reducedMotion?: "no-preference" | "reduce";
}

export type IPlaytestResourceWait =
  | { equals: unknown; gte?: never; id: string; lte?: never; path: string }
  | { equals?: never; gte: number; id: string; lte?: never; path: string }
  | { equals?: never; gte?: never; id: string; lte: number; path: string };

export interface IPlaytestStep {
  kind?: "aimAt" | "click" | "input" | "lifecycle" | "wait";
  /** @deprecated Use holdTicks. Fixed-step bridges treat this as a tick alias. */
  holdFrames?: number;
  holdTicks?: number;
  /** A viewport-pixel click target, resolved directly or from a registered entity's bounds. */
  at?: IPlaytestClickTarget;
  label?: string;
  /** Emulate media features from this step on (browser, and the desktop native-css UI). */
  media?: IPlaytestMedia;
  /**
   * One device-lifecycle operation the runner drives through the platform driver, so the phases it
   * then reports are read off the device rather than asserted by the game about itself.
   */
  lifecycle?: IPlaytestLifecycleStep;
  overlayMessage?: {
    overlayId: string;
    payload: unknown;
    type: string;
  };
  pitch?: number;
  pointerPosition?: {
    buttons?: number;
    x: number;
    y: number;
  };
  /** The complete held-pointer set for this step, in arrival order. */
  pointers?: readonly IPlaytestPointer[];
  /** A string presses one key; an array describes the complete held-key set. */
  press?: string | readonly string[];
  release: boolean;
  screenshot?: string;
  /** Runner-native aim: yaw/pitch are computed from the sampled subject position. */
  target?: IPlaytestAimTarget;
  timeoutMs?: number;
  /** @deprecated Use waitTicks. Fixed-step bridges treat this as a tick alias. */
  waitFrames?: number;
  waitForResource?: IPlaytestResourceWait;
  waitTicks?: number;
  /** A browser/native wheel sample; negative DOM deltaY is the conventional toward-user gesture. */
  wheel?: IPlaytestWheel;
  window?: {
    height?: number;
    operation: "minimize" | "resize" | "restore";
    width?: number;
  };
}

/** Where an aimAt step points: a world xz position or another registered entity. */
export type IPlaytestAimTarget = { entity: string } | { x: number; z: number };

/**
 * The device operations a `lifecycle` step names.
 *
 * `rotate` is the only one that carries an argument, and the `?: never` arms are what stop a
 * scenario from writing `{ operation: "background", rotation: 1 }` and having the rotation
 * silently dropped.
 */
export type IPlaytestLifecycleStep =
  | { operation: "background"; rotation?: never }
  | { operation: "foreground"; rotation?: never }
  | { operation: "rotate"; rotation: number };

/**
 * Where a click lands: viewport pixels, a registered entity's screen bounds, or (browser only) the
 * centre of a DOM element by `id` or CSS `selector`. Pixels depend on the page's layout, which
 * depends on the fonts a machine has; an element target does not.
 */
export type IPlaytestClickTarget =
  | { entity: string }
  | { element: IPlaytestVisualRegionTarget }
  | { x: number; y: number };

export interface IPlaytestMovementAssertion {
  axis?: string;
  closesDistanceToPosition?: { position: [number, number, number]; min: number };
  entity?: string;
  facesMovementWithinDegrees?: number;
  minAxisDelta?: {
    axis: string;
    min: number;
  };
  minResolvedAxisDelta?: {
    axis: string;
    min: number;
  };
  maxTiltDegrees?: number;
  minDistance?: number;
  minVelocity?: number;
  maxDistance?: number;
  pathLength?: number;
  notFacing?: { entity: string; minDegrees: number };
  notFacingPosition?: { position: [number, number, number]; minDegrees: number };
  reachesPositionWithin?: {
    atStep?: string;
    position: [number, number, number];
    maxDistance: number;
  };
  rotationChanged?: boolean;
}

export interface IPlaytestCameraAssertion {
  entity?: string;
  follows?: string;
  targetInViewport?: boolean;
  within?: number;
}

export interface IPlaytestPathAssertion {
  atSteps?: Array<{
    equals?: unknown;
    label: string;
    textIncludes?: string;
  }>;
  changed?: boolean;
  equals?: unknown;
  gte?: number;
  id: string;
  lte?: number;
  allowTrivial?: string;
  path?: string;
  textIncludes?: string;
  throughoutSteps?: boolean;
  /** Require a DOM node to occupy pixels above the page at the sampled viewport centre. */
  visible?: boolean;
}

export interface IPlaytestResourcePathAlternative {
  changed?: boolean;
  equals?: unknown;
  gte?: number;
  lte?: number;
  path: string;
  textIncludes?: string;
}

export interface IPlaytestResourcePathAssertion extends IPlaytestPathAssertion {
  anyOf?: never;
}

export interface IPlaytestResourceAnyOfAssertion {
  anyOf: IPlaytestResourcePathAlternative[];
  atSteps?: never;
  changed?: never;
  equals?: never;
  gte?: never;
  id: string;
  lte?: never;
  allowTrivial?: never;
  path?: never;
  textIncludes?: never;
  throughoutSteps?: never;
}

export type IPlaytestResourceAssertion =
  | IPlaytestResourceAnyOfAssertion
  | IPlaytestResourcePathAssertion;

export interface IPlaytestComponentAssertion extends Omit<IPlaytestPathAssertion, "id" | "textIncludes" | "throughoutSteps"> {
  component: string;
  entity: string;
}

export interface IPlaytestContactAssertion {
  atStep?: string;
  entity?: string;
  kind?: string;
  maxCount?: number;
  minCount?: number;
  requiredOn?: PlaytestTarget[];
  with?: string;
}

export interface IPlaytestSignalAssertion {
  atStep?: string;
  entity?: string;
  maxCount?: number;
  minCount?: number;
  name: string;
}

export interface IPlaytestSettledAssertion {
  atStep?: string;
  allowTrivial?: string;
  compareToStep?: string;
  entity?: string;
  minBodies?: number;
  minMeanPoseDistance?: number;
  requiredOn?: PlaytestTarget[];
}

export interface IPlaytestOccludedAssertion {
  allowTrivial?: string;
  entity?: string;
  target?: string;
}

export interface IPlaytestOverlayNodeAssertion {
  attribute?: string;
  equals?: unknown;
  overlayId: string;
  selector: string;
  textIncludes?: string;
  visible?: boolean;
}

/**
 * Bounds on the room the game is played in — what a screenshot would have shown, as numbers.
 *
 * Every member fails closed on an unobserved scene: a bridge that does not report `scene.observe`
 * has not reported a well-lit one.
 */
export interface IPlaytestSceneAssertion {
  allowTrivial?: string;
  /** Fail when the camera's far plane cuts the scene it is pointed at. */
  cameraClearsScene?: boolean;
  /** Fail when a linear fog reaches full colour in front of the scene it is fogging. */
  fogClearsScene?: boolean;
  /** Fail when lit materials are mounted and no light in the scene is visible. */
  litMaterialsAreLit?: boolean;
  /** Floor on how many lights the renderer will actually see. */
  minVisibleLights?: number;
}

/**
 * Bounds how far a planted foot slides, measured from the feet's world positions every tick of one
 * step. A clip reports its own stride; a procedural rig reports nothing, so this measures what the
 * screen shows instead of what the game says. Browser target only; elsewhere it fails unobserved.
 */
export interface IPlaytestFootSlipAssertion {
  atStep: string;
  entity?: string;
  feet: string[];
  /** Ceiling on planted-foot travel over body travel. At least one of this and `maxSlideSpeed` is required. */
  maxSlip?: number;
  /** Ceiling on a planted foot's world speed in m/s, whatever the body's speed is. */
  maxSlideSpeed?: number;
  /** Seconds per fixed tick, for `maxSlideSpeed`; the engine's own default step is 1/60. */
  stepSeconds?: number;
}

/**
 * Bounds on named nodes of the scene graph — the questions a screenshot gets taken for.
 *
 * `scene` bounds the room as a whole: is anything lit, does the fog clear the world. This bounds
 * one object: is the crate where the game says it is, is it inside the camera's frustum, did its
 * texture load, is the character's mesh actually visible once every ancestor's flag is taken into
 * account. Each is a frame-destroying failure that leaves every count healthy.
 *
 * `select` is required and every other member is optional, but an assertion that sets only
 * `select` throws at load: selecting nodes and bounding nothing is the vacuous pass this package
 * refuses. Every bound fails closed — a run whose bridge reported no scene nodes has not reported
 * a visible crate, it has reported nothing.
 */
export interface IPlaytestSceneNodesAssertion {
  allowTrivial?: string;
  /** Require every matched node to have at least one clip mounted, or none to. */
  animated?: boolean;
  /** Require every matched node's world bounds to intersect the active camera's frustum. */
  inFrustum?: boolean;
  /** Ceiling on how many nodes the selector may match. Zero asserts absence. */
  maxCount?: number;
  /** Floor on how many nodes the selector must match. Defaults to 1 when absent. */
  minCount?: number;
  /** Floor on the summed triangle count of every matched node. */
  minTriangles?: number;
  /** Which nodes to bound. A selector that matches fewer than `minCount` fails. */
  select: IPlaytestSceneNodeSelectorSpec;
  /** Require every bound texture slot on every matched node to carry pixels. */
  texturesLoaded?: boolean;
  /** Require every matched node to be visible with every ancestor visible too. */
  visible?: boolean;
}

/**
 * Which nodes an assertion is about. Every present field must match; an absent field does not
 * filter. At least one field is required — a selector that filters nothing selects the whole
 * scene graph and bounds nothing in particular.
 */
export interface IPlaytestSceneNodeSelectorSpec {
  limit?: number;
  name?: string;
  nameContains?: string;
  pathContains?: string;
  type?: string;
}

/**
 * "It happened **because** of that, and never before it."
 *
 * The one sentence a proof of a physics puzzle actually has to make, and the one this harness
 * could not make. A run could already say *a contact happened* and *the state reads `won`*, and
 * `atSteps` could order them at step boundaries — where a win arriving one tick after the contact
 * and a win arriving 199 ticks later inside the same step are the same observation. That is the
 * signature of a terminal state driven by a timer or a distance check that merely lands near a
 * contact, and it is what a sealed proof exists to refuse.
 *
 * Both sides are tick-stamped by the producer. A run whose contacts or transitions carry no ticks
 * fails closed and names which side was unstamped; it never falls back to step granularity, which
 * is a different measurement wearing the same name.
 */
export interface IPlaytestCausedByAssertion {
  allowTrivial?: string;
  cause: IPlaytestCauseSpec;
  effect: IPlaytestEffectSpec;
  /**
   * Fail when the effect is ever observed before the first matching cause. This is the frame-one
   * fake win: a goal volume overlapping the floor reports `won` before anything touched it.
   */
  neverBefore?: boolean;
  /** Ceiling on `effectTick - causeTick`. A win long after the contact was not caused by it. */
  withinTicks?: number;
}

/** What must have happened first. */
export interface IPlaytestCauseSpec {
  contact?: { entity: string; kind?: string; with: string };
  /** A published value reaching a given value, named the same way an effect is. */
  transition?: IPlaytestEffectSpec;
}

/** The published value whose change is being explained. */
export interface IPlaytestEffectSpec {
  /** `states.<entity>` or `state.<field>`, exactly as the transition log reports it. */
  path: string;
  /** The value the path must reach. */
  becomes: boolean | number | string;
}

export interface IPlaytestAnimationAssertion {
  advancedFrames?: number;
  allowTrivial?: string;
  clip?: string;
  entered?: boolean;
  entity?: string;
  finished?: boolean;
  /**
   * Ceiling on |feet − ground| / ground for the observed clip. A run whose producer reports no
   * stride fails closed: the convention is on by default, so silence is a missing observation,
   * not agreement.
   */
  maxFootSlide?: number;
  /** Require the stride convention to be applied (`true`) or deliberately overridden (`false`). */
  strideSynced?: boolean;
}

export interface IPlaytestTagCountAssertion {
  allowTrivial?: string;
  count?: number;
  gte?: number;
  lte?: number;
  tag: string;
}

export interface IPlaytestStateAssertion {
  allowTrivial?: string;
  entity?: string;
  equals: string;
}

export interface IPlaytestVisibilityAssertion {
  allowTrivial?: string;
  entity?: string;
  maxOffscreenRatio?: number;
  minProjectedPixels?: number;
  present?: boolean;
}

export interface IPlaytestDiagnosticsAssertion {
  noConsoleErrors?: boolean;
  noNetworkErrors?: boolean;
  noRuntimeDiagnostics?: boolean;
  consoleErrorsOptOutReason?: string;
  networkErrorsOptOutReason?: string;
  runtimeDiagnosticsOptOutReason?: string;
  runtimeReady?: boolean;
}

export interface IPlaytestPerformanceAssertion {
  maxDrawCalls?: number;
  maxFrameMsP95?: number;
  /** Required when `maxFrameMsP95` is above 16.7 ms: why this scenario cannot hold 60 fps. The report prints it. */
  maxFrameMsReason?: string;
  maxTriangles?: number;
  /** Frame-budget floor: the median presented frame must sustain at least this many frames a second. */
  minFps?: number;
  /**
   * Per-phase ceilings in milliseconds, nearest-rank p95 across the sampled frames. The phase
   * names are the engine's frame-budget phases: hostGap, update, render, overlay, residual.
   */
  maxPhaseMsP95?: Readonly<Partial<Record<PlaytestFramePhase, number>>>;
  /**
   * Per-pass draw-call ceilings, keyed by pass kind: main, shadow, reflection, nested. The bound
   * is the largest draw count that kind submitted in a sampled frame, so a shadow lane folded into
   * the whole-frame `maxDrawCalls` is bounded on its own.
   */
  maxPassDrawCalls?: Readonly<Partial<Record<PlaytestFramePassKind, number>>>;
  /** Per-pass triangle ceilings, keyed by pass kind: main, shadow, reflection, nested. */
  maxPassTriangles?: Readonly<Partial<Record<PlaytestFramePassKind, number>>>;
}

/** The stage expectations a render-chain assertion can hold, without its own per-adapter branches. */
export interface IPlaytestRenderChainExpectation {
  contributions?: {
    graphOutputChanged: string[];
  };
  tier?: "high" | "medium" | "low" | "off";
  stages?: {
    includes?: string[];
    excludes?: string[];
    /** Ordered subsequence of applied stage ids, not necessarily the complete chain. */
    order?: string[];
  };
  velocity?: {
    maxRejectionFraction: number;
  };
}

export interface IPlaytestRenderChainAssertion extends IPlaytestRenderChainExpectation {
  /**
   * What the chain must look like on each adapter the run's own `adapter.info` classified, chosen
   * by the harness's software-adapter detector rather than by anything the game reported. A lane
   * whose adapter cannot be classified is a failed observation, not a hardware one: a missing
   * branch is not a licence to pass.
   */
  perAdapter?: Partial<Record<PlaytestAdapterClass | PlaytestGpuFamily, IPlaytestRenderChainExpectation>>;
}

/** What the harness read out of `adapter.info` for this run, before any game code answered. */
export type PlaytestAdapterClass = "hardware" | "software";

/**
 * The GPU family the same `adapter.info` fields prove on a hardware run. A family row beside
 * `hardware` is how a scenario holds an iGPU or a phone to the tier a template starts that family
 * at; it overrides `hardware` only when the observed fields prove the family.
 */
export const PLAYTEST_GPU_FAMILIES = ["discrete", "integrated", "mobile-high", "mobile-low", "mobile-mid"] as const;
export type PlaytestGpuFamily = (typeof PLAYTEST_GPU_FAMILIES)[number];

/** Every key a `perAdapter` assertion accepts. */
export const PLAYTEST_PER_ADAPTER_KEYS = ["hardware", "software", ...PLAYTEST_GPU_FAMILIES] as const;

/** Ceilings on the application's startup milestones, in milliseconds since navigation. */
export interface IPlaytestStartupAssertion {
  /** The start scene's `enter()` returned: a controllable world exists. */
  maxEnteredMs?: number;
  /** First-use compilation settled or its budget expired. */
  maxCompileSettledMs?: number;
  /** `whenReady()` resolved: the world is safe to show. */
  maxReadyMs?: number;
  /**
   * Ceiling on the bytes the reveal waited for that the spawn camera does not show, from the
   * runtime's own measurement. `0` asserts that everything awaited is in view.
   */
  maxOffscreenBytes?: number;
  /**
   * Every frame the page presented between navigation and readiness looks like the last one
   * before readiness (the loading cover): no black, blank or page-background frame in between.
   */
  steadyCover?: true;
}

/** Ceilings on work observed after the runtime's explicit shader warm-up settled. */
export interface IPlaytestPipelineCensusAssertion {
  maxNodeBuildsAfterWarmUpSettled?: number;
  maxRenderPipelineCreationsAfterWarmUpSettled?: number;
  warmUpScope?: string;
  maxNodeBuildsAfterWarmUpScope?: number;
  maxRenderPipelineCreationsAfterWarmUpScope?: number;
}

export interface IPlaytestFramebufferCoverageAssertion {
  backdrop: [number, number, number];
  grid?: {
    columns: number;
    rows: number;
  };
  tolerance: number;
  window: {
    endStep: string;
    startStep: string;
  };
}

export interface IPlaytestVisualRegionTarget {
  id?: string;
  selector?: string;
}

export interface IPlaytestVisualRegionBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface IPlaytestVisualRegionThresholds {
  maxDarkPixelRatio?: number;
  maxLuminance?: number;
  minDarkPixelRatio?: number;
  minNonblankPixelRatio?: number;
}

export interface IPlaytestVisualStaticRegion extends IPlaytestVisualRegionBounds, IPlaytestVisualRegionThresholds {
  /** Floor on `regionSharpness` (Laplacian variance at full over half resolution); a smeared frame drops it. */
  minSharpness?: number;
}

export interface IPlaytestVisualElementRegion extends IPlaytestVisualRegionThresholds {
  element: IPlaytestVisualRegionTarget;
}

export type IPlaytestVisualRegion = IPlaytestVisualStaticRegion | IPlaytestVisualElementRegion;

export interface IPlaytestVisualAssertion {
  entityVisible?: { entity: string; minProjectedPixels: number; throughoutFrames?: boolean };
  frameDiff?: { baselineImage?: string; maxChangedPixelRatio?: number; minChangedPixelRatio?: number };
  region?: IPlaytestVisualRegion;
}

export interface IPlaytestAerodynamicsAssertion {
  controls?: Array<{
    minAbs?: number;
    sign: "negative" | "positive";
    surface: string;
  }>;
  entity: string;
  minForceSamples?: number;
  torques?: Array<{
    axis: "x" | "y" | "z";
    label: string;
    minAbs?: number;
    relativeToLabel?: string;
    sign: "negative" | "positive";
  }>;
}

export interface IPlaytestReachabilityAssertion {
  artifact: string;
  entities: string[];
  /** Loaded from artifact by loadPlaytestScenario; not authored in scenario JSON. */
  envelope?: { fallDistanceToGround: number; forwardReach: number; maxRise: number };
}

export interface IPlaytestWorldRuntimeAssertion {
  agent: string;
  core: string;
  portable?: boolean;
  randomState: number;
  rapier: string | null;
  step: number;
}

export interface IPlaytestWorldAssertion {
  runtime?: IPlaytestWorldRuntimeAssertion;
  seed: number | null;
}

/**
 * Thermal, power and battery state measured around the run itself. Its point is comparability:
 * a run that started hot, or whose thermal status rose while it ran, is not evidence against a
 * cool baseline, and this is how a scenario says so out loud.
 */
export interface IPlaytestDeviceMetricsAssertion {
  /** Ceiling on the battery temperature climb from the first to the last sample, in °C. */
  maxTemperatureRiseC?: number;
  /** Ceiling on the highest Android thermal status observed during the run (0 is NONE). */
  maxThermalStatus?: number;
  /** Requires a run the harness judged comparable with a cool one. */
  notThermallyConfounded?: boolean;
}

/**
 * What the game actually played, by cue label.
 *
 * Every other audio check in this repository is about a *file* — it exists, it decodes, it is
 * inside its byte budget, its loop seam is clean. All of them stay green while a game says its
 * one-shot general-quarters call a second time in the middle of a match, or plays the same line
 * twice at once, because neither is a property of the clip. This reads the runtime ledger
 * (`runtime.audio`), which a game fills by passing `cue` to `AudioBus.play`/`playAt`.
 */
export interface IPlaytestAudioAssertion {
  /** The cue label the game passed. */
  cue: string;
  /** Fewest times it must have sounded. Defaults to 1, so naming a cue asserts it was heard. */
  minPlays?: number;
  /** Most times it may have sounded. `0` proves silence; `1` proves a one-shot stayed one. */
  maxPlays?: number;
  /**
   * Fewest milliseconds that must separate this cue from the cue before it.
   *
   * One loudspeaker cannot say two things at once. A game whose urgent line cuts another 250 ms
   * in sounds broken rather than urgent, and nothing but the gap between two plays shows it.
   */
  minGapMs?: number;
}

export interface IPlaytestToneAssertion extends Partial<Record<keyof IToneMetrics, { min?: number; max?: number }>> {
  region?: IToneRegion;
  compare?: IToneComparison;
  /** Omit to bound the final capture, otherwise capture after this named step. */
  atStep?: string;
}

export interface IPlaytestScenarioAssertions {
  tone?: IPlaytestToneAssertion[];
  aerodynamics?: IPlaytestAerodynamicsAssertion[];
  audio?: IPlaytestAudioAssertion[];
  animation?: IPlaytestAnimationAssertion[];
  camera?: IPlaytestCameraAssertion;
  components?: IPlaytestComponentAssertion[];
  contacts?: IPlaytestContactAssertion[];
  deviceMetrics?: IPlaytestDeviceMetricsAssertion;
  diagnostics?: IPlaytestDiagnosticsAssertion;
  framebufferCoverage?: IPlaytestFramebufferCoverageAssertion;
  /**
   * Arms one per-object geometry capture and reports it as the `geometry` observation. This is a
   * request rather than a comparison: it bounds nothing, and the report is read from
   * `observations.geometry`, exactly as `pipelineCensus` is read from `observations.pipelineCensus`.
   */
  geometry?: IPlaytestGeometryCaptureRequest;
  hud?: IPlaytestPathAssertion[];
  movement?: IPlaytestMovementAssertion;
  occluded?: IPlaytestOccludedAssertion[];
  overlayNodes?: IPlaytestOverlayNodeAssertion[];
  parity?: IPlaytestParityAssertion;
  performance?: IPlaytestPerformanceAssertion;
  pipelineCensus?: IPlaytestPipelineCensusAssertion;
  renderChain?: IPlaytestRenderChainAssertion;
  reachability?: IPlaytestReachabilityAssertion;
  resources?: IPlaytestResourceAssertion[];
  settled?: IPlaytestSettledAssertion[];
  signals?: IPlaytestSignalAssertion[];
  scene?: IPlaytestSceneAssertion;
  causedBy?: IPlaytestCausedByAssertion[];
  sceneNodes?: IPlaytestSceneNodesAssertion[];
  footSlip?: IPlaytestFootSlipAssertion[];
  startup?: IPlaytestStartupAssertion;
  states?: IPlaytestStateAssertion[];
  tags?: IPlaytestTagCountAssertion[];
  visibility?: IPlaytestVisibilityAssertion[];
  visual?: IPlaytestVisualAssertion[];
  world?: IPlaytestWorldAssertion;
}

export interface IPlaytestParityConfig {
  animation?: Array<{ clip?: string; entity: string; requiredOn?: PlaytestTarget[] }>;
  axisDelta?: Partial<Record<"x" | "y" | "z", number>>;
  contacts?: { minSharedCount?: number };
  movementDistance?: { maxDelta: number };
  resources?: string[];
  targets?: PlaytestTarget[];
}

/** What the parity reference's saved run report yielded, extracted at scenario load. */
export interface IPlaytestParityReference {
  /** Frames per second of the reference run: 1000 ÷ the median frame time of its series. */
  fps: number;
  /** Render-phase p95 of the reference run, when its series carries the phase split. */
  renderP95?: number;
  /** The device the reference run executed on, when it measured one. */
  serial?: string;
  /** The reference run's own thermal verdict, when it measured one. */
  thermallyConfounded?: boolean;
}

/**
 * PRD-222 Tier 2: the same scene on the same device, twice — once in the platform's browser,
 * once on the native host. The assertion lives in the second run of the pair and names the
 * first run's saved report.
 *
 * It proves what the artifacts can prove: the same device (both halves' `deviceMetrics.serial`),
 * a thermally comparable pair, and the directed fps ratio. Which scene the reference ran is the
 * pair protocol the operator owns — the report format carries no scene identity — so this
 * assertion never claims it did.
 */
export interface IPlaytestParityAssertion {
  /** Floor on nativeFps ÷ webFps. Tier 2's Floor is 0.85; Target 0.95. */
  minFpsRatio: number;
  /** Optional floor on the inverted render-phase p95 ratio; fails closed when either side's series lacks the split. */
  minRenderParity?: number;
  /** Path to the other half's saved run report JSON, resolved against the project. */
  referenceReport: string;
  /** Which side of the pair the reference report is; the directed ratio needs it. */
  referenceSide: "browser" | "native";
  /** Hydrated from the reference report at scenario load; never set by hand. */
  reference?: IPlaytestParityReference;
}

export interface IPlaytestArtifactRequest {
  console?: boolean;
  contactSheet?: boolean;
  effectLog?: "focused" | boolean;
  network?: boolean;
  runtimeTrace?: boolean;
  /** `true` captures like `"after"`; only `false` and `"before-after"` change the runner. */
  screenshots?: "before-after" | "after" | boolean;
}

export interface IPlaytestSetupEntityTransform {
  entity: string;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

/** Overrides the subject player start. y is optional and preserves the game's own height when absent. */
export interface IPlaytestSpawnRequest {
  x: number;
  y?: number;
  z: number;
}

/** Overrides the subject player-start aim; both angles are radians (Three.js convention). */
export interface IPlaytestAimRequest {
  pitch: number;
  yaw: number;
}

/**
 * Places a named entity at an explicit world transform before input. Orientation comes
 * from facing yaw or a lookAt point (never both); frozen delivers the placed-frozen
 * marker the game reads to suppress physics motion — placement is data, not teleports.
 */
export interface IPlaytestPlaceRequest {
  at: { x: number; y: number; z: number };
  entity: string;
  facing?: { yaw: number };
  frozen?: boolean;
  lookAt?: { x: number; y: number; z: number };
}

export interface IPlaytestSetupResource {
  id: string;
  path?: string;
  value: unknown;
}

export interface IPlaytestScenarioSetup {
  aim?: IPlaytestAimRequest;
  entities?: IPlaytestSetupEntityTransform[];
  place?: IPlaytestPlaceRequest[];
  resources?: IPlaytestSetupResource[];
  spawn?: IPlaytestSpawnRequest;
}

/**
 * A browser-only network profile applied before the page loads, so a scenario can prove what a
 * real link costs. Throughput is in kilobits per second, one direction, as a user reads a plan.
 */
export interface IPlaytestNetworkProfile {
  readonly downloadKbps: number;
  readonly latencyMs: number;
}

export interface IPlaytestScenario {
  acceptanceId?: string;
  artifacts?: IPlaytestArtifactRequest;
  assert?: IPlaytestScenarioAssertions;
  /** Test-only browser seam that makes the renderer's no-adapter boot path deterministic. */
  bootFailure?: "renderer-no-adapter";
  /**
   * Wait for the application to finish its own startup before the first observation. Default
   * true, because a fixed-step run otherwise observes a game that has not finished loading.
   * Set false only when the launch *is* the subject — a loading-screen scenario has to be
   * allowed to look at the loading screen.
   */
  awaitStartup?: boolean;
  inputDelivery?: PlaytestInputDelivery;
  name: string;
  /** Browser-only: throttle the page before navigation. See {@link IPlaytestNetworkProfile}. */
  network?: IPlaytestNetworkProfile;
  parity?: IPlaytestParityConfig;
  /**
   * Browser-only: run this scenario on the wall clock, as `--live-clock` does for a whole run. A
   * performance scenario needs it, because counted ticks advance faster than frames draw and a window
   * then holds a few GPU samples. Tick counts keep their meaning; the other scenarios of one glob run stay counted.
   */
  clock?: "wall-clock";
  /**
   * Browser-only: open the page with `prefers-reduced-motion: reduce` emulated, so a game that
   * honours the preference can prove it. Applied before navigation, so the first read sees it.
   */
  reducedMotion?: "reduce";
  schemaVersion: 1;
  setup?: IPlaytestScenarioSetup;
  sourcePath?: string;
  /** Absolute fixed-step tick reached after startup and warmup, before baseline and input. */
  startTick?: number;
  steps: IPlaytestStep[];
  subject?: string;
  target: PlaytestTarget;
  viewport: IPlaytestViewport;
  warmupFrames: number;
}


export interface IPlaytestScenarioDiagnostic {
  code: "TN_PLAYTEST_SCENARIO_INVALID" | "TN_PLAYTEST_SCENARIO_NOT_FOUND" | "TN_PLAYTEST_SCENARIO_STEP_INVALID";
  fix?: {
    docs?: string;
    instruction: string;
    snippet?: string;
  };
  message: string;
  severity: "error";
  suggestion?: string;
}
