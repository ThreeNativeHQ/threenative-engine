export const PLAYTEST_BRIDGE_GLOBAL = "__THREENATIVE_PLAYTEST_BRIDGE__";
export const PLAYTEST_PROTOCOL_VERSION = 1 as const;

/**
 * userData key the setup channel sets on an entity placed with `frozen: true`. Games read
 * this marker and suppress physics motion for the entity — placement stays data the game
 * interprets, never a runner-side per-frame teleport.
 */
export const PLAYTEST_FROZEN_MARKER = "__threenativeFrozen";

/**
 * How much wall clock one advanced tick may take before the runner calls the page hung.
 *
 * `operationTimeoutMs` bounds a request/response round trip, which is the right shape for every
 * bridge call except one: `advance` is bulk work whose duration scales with the ticks asked for,
 * so a fixed budget is wrong for it by construction. A scenario advancing 600 ticks in a single
 * call exceeded 5 s on a two-core CI runner and was reported as a timed-out operation — the page
 * was not hung, it was doing exactly what it was told, slowly.
 *
 * 250 ms is about 2.5x the ~100 ms per tick measured on the slowest lane this repository runs
 * (SwiftShader on a two-core runner). It is a hang detector, not a schedule: no measurement
 * anywhere reads it, and a run that needs it is already reporting its own tick counts.
 */
export const PLAYTEST_ADVANCE_TICK_BUDGET_MS = 250;

/**
 * Core's own bound on first-use compilation, restated here because `playtest` must not depend on
 * `core`. Kept equal to `STARTUP_COMPILE_BUDGET_MS` in `packages/core/src/startup-readiness.ts`;
 * an advance that can overlap that work has to allow for it.
 */
export const PLAYTEST_STARTUP_COMPILE_BUDGET_MS = 15_000;

export const PLAYTEST_PROTOCOL_LIMITS = {
  maxEntitiesPerSample: 100,
  maxEventsPerDrain: 1_000,
  maxPayloadBytes: 1_000_000,
  operationTimeoutMs: 5_000,
} as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type PlaytestClockMode = "fixed-step" | "render-frame" | "wall-clock";

/**
 * The clock a consumer asks this game to run on, named in this protocol's own vocabulary.
 *
 * Set before the game module evaluates — the production profile injects it into the instrumentation
 * it puts ahead of the bundle, and the browser runner puts it in an `addInitScript` ahead of every
 * page script — and read by the producer that owns the loop. It lives here, next to the mode it
 * names, because a request the producer cannot read is how a live loop came to be judged a
 * fixed-step one.
 */
export const PLAYTEST_CLOCK_GLOBAL = "__THREENATIVE_PLAYTEST_CLOCK__";

/**
 * The clock the host asked for, or `undefined` for the default deterministic run.
 *
 * `wall-clock` is the production profile's opt-in and the only one this protocol has. An
 * unrecognised value throws instead of falling back, because a misspelling that quietly left the
 * loop frozen would publish a frame rate for a game that was not playing.
 *
 * Read at the moment it is needed rather than once at install: a request that arrives after the
 * producer was installed is still a request, and a producer that missed it would judge a live
 * frame pump by a count it never asked for.
 * @situation report which clock a playtest producer is really running on, before judging its ticks
 * @constraint throws on an unrecognised value instead of falling back to a fixed-step run
 * @example if (requestedPlaytestClockMode() === "wall-clock") host.pumpDrivesTheSimulation();
 */
export function requestedPlaytestClockMode(): PlaytestClockMode | undefined {
  const requested = (globalThis as Record<string, unknown>)[PLAYTEST_CLOCK_GLOBAL];
  if (requested === undefined) return undefined;
  if (requested === "wall-clock") return "wall-clock";
  throw new Error(
    `TN_PLAYTEST_CLOCK_UNSUPPORTED: '${PLAYTEST_CLOCK_GLOBAL}' is ${JSON.stringify(requested)}; this protocol knows 'wall-clock' and nothing else.`,
  );
}

export interface IPlaytestBridgeDescription {
  capabilities: readonly string[];
  limits: typeof PLAYTEST_PROTOCOL_LIMITS;
  name: string;
  protocolVersion: typeof PLAYTEST_PROTOCOL_VERSION;
}

/**
 * How far the application is through its own first-use startup work.
 *
 * A fixed-step runner advances ticks as fast as the machine allows, so a scenario can finish
 * before a loading screen has closed — and everything a game gates on startup (compute
 * dispatch, the first world present) then never happens inside the run. Reported so the runner
 * can wait for the world instead of photographing the loader and asserting against a frozen
 * simulation.
 */
/**
 * When the application's startup milestones happened, in milliseconds on the host's monotonic
 * clock (since navigation on the web, since process start on native). Absent members have not
 * happened yet.
 */
export interface IPlaytestStartupTimeline {
  loadStartedMs?: number;
  enteredMs?: number;
  compileSettledMs?: number;
  readyMs?: number;
}

export interface IPlaytestStartupObservation {
  phase: "observing" | "collapsing" | "ready";
  /** 0 while first-use work is pending, then 1. */
  progress: number;
  /** Candidate and backend observation counts from the most recent engine warm-up. */
  warmup?: {
    attempted?: number;
    candidates?: number;
    observed?: {
      created: number;
      failed: number;
      pending: number;
      status: "complete" | "incomplete" | "unavailable";
      uniquePipelines: number;
      uniquePrograms: number;
    };
    status: "complete" | "incomplete" | "unavailable";
  };
  /**
   * Whether first-use compilation has settled, which happens strictly before `phase` reaches
   * `"ready"`: readiness additionally requires a sustained in-budget frame window. Reported
   * separately because that window is a player-experience gate, and a lane that has been told
   * the machine has no GPU has already conceded it is not measuring that.
   */
  compileSettled?: boolean;
  /** Present when the application records its startup milestones. */
  timeline?: IPlaytestStartupTimeline;
  /** The frames the page presented before readiness; recorded by the browser runner on request. */
  cover?: IPlaytestStartupCoverObservation;
}

/**
 * The compositor frames from navigation to readiness, each compared with the last one before
 * readiness. A frame differs when more than a quarter of its pixels moved past the tolerance.
 */
export interface IPlaytestStartupCoverObservation {
  /** Frames recorded between navigation and readiness. */
  frames: number;
  /** Mean colour of the reference frame, the last before readiness, 0-255. */
  reference: [number, number, number];
  /** Every differing frame: ms since navigation, its mean colour and its differing pixel share. */
  differing: Array<{ ms: number; mean: [number, number, number]; share: number }>;
}

/**
 * How long a run will wait for an application to finish its own first-use startup work.
 *
 * Derived, not picked. Core bounds its own launch twice — `STARTUP_COMPILE_BUDGET_MS` (15s) for
 * first-use compilation, then `STARTUP_STABLE_WINDOW_MS` (10s) for the sustained-frame window,
 * which resolves anyway — so the readiness gate itself is bounded at 25s. Measured end to end on
 * a real SwiftShader adapter, a starter scenario took ~57s to report ready, because the scene
 * build and first-use work that happen *before* that gate opens are not inside those budgets.
 *
 * This deadline is a backstop for a page that has hung, not a schedule anything should approach,
 * so it is set at roughly 3x that measured software launch and >7x the gate's own bound. A margin
 * of a few seconds over a worst case measured on one machine is a coin flip, not headroom.
 *
 * Pinned against core's constants by packages/core/__tests__/startup-ready-bound.spec.ts, which
 * fails if either budget is raised past it.
 */
export const PLAYTEST_STARTUP_READY_TIMEOUT_MS = 180_000;

export interface IPlaytestBridgeReady {
  ready: boolean;
  reason?: string;
  /** Present only when the application advertises `runtime.startup`. */
  startup?: IPlaytestStartupObservation;
}

export interface IPlaytestEntityTransform {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface IPlaytestSetupRequest {
  entities?: Array<{
    entity: string;
    /** Marks the placed entity with {@link PLAYTEST_FROZEN_MARKER} for the game to read. */
    frozen?: boolean;
    transform: IPlaytestEntityTransform;
  }>;
  resources?: Array<{ id: string; path?: string; value: JsonValue }>;
}

/**
 * One armed per-object geometry capture request. `limit`, `sort` and `timeoutMs` mirror the
 * runtime collector's own request shape so the runner adds no second vocabulary for it.
 */
export interface IPlaytestGeometryCaptureRequest {
  /** Rows to return, 1 to 500. */
  readonly limit?: number;
  readonly sort?: "triangles" | "draws" | "projected";
  readonly timeoutMs?: number;
}

export interface IPlaytestSampleRequest {
  entities?: readonly string[];
  geometry?: IPlaytestGeometryCaptureRequest;
  include?: readonly string[];
  /** Scenario-step label for providers that retain labelled observation series. */
  label?: string;
  resources?: readonly string[];
  /** Scene-graph selectors to report, one observation per selector, in request order. */
  sceneNodes?: readonly IPlaytestSceneNodeSelector[];
}

export interface IPlaytestEntityObservation {
  bounds?: { height: number; width: number; x: number; y: number };
  id: string;
  transform?: IPlaytestEntityTransform;
  visible?: boolean;
}

/**
 * What the feet are doing against what the body is doing, for the clip currently playing.
 *
 * The stride convention is on by default and has a named override, so its measurement has to
 * cross the bridge whether or not it is applied — a game that turned it off otherwise has no way
 * to see what that cost, and a scenario has no way to catch a character skating across the floor.
 * Every member is the producer's own measurement; nothing here is derived by the runner.
 */
export interface IPlaytestStrideObservation {
  /** Metres of ground the clip carries per clip-second at rate 1. Zero when it travels none. */
  clipGroundSpeed: number;
  /** Metres per second the body actually covered, as the producer smoothed it. */
  groundSpeed: number;
  /**
   * True when the clip carries no root motion and its stride came from the feet. With a zero
   * `clipGroundSpeed` it says no foot plant was found, which is why stride sync is not active.
   */
  inPlace?: boolean;
  /** True when a rate was measured and deliberately not applied. */
  overridden: boolean;
  /** The playback rate those two imply, after the producer's own clamping. */
  rate: number;
  /** True when that rate is being applied to the action. */
  synced: boolean;
}

export interface IPlaytestAnimationObservation {
  advancedFrames: number;
  clip: string;
  finished?: boolean;
  /** Present only when the producer measures stride. Absent is unobserved, never zero. */
  stride?: IPlaytestStrideObservation;
}

/**
 * One light in the scene, as the renderer will read it.
 *
 * Counted rather than judged: a light's colour and intensity decide how the game looks, and this
 * harness never owns the look. It reports what is there so a black frame can be told from a lit
 * one without a human opening the page.
 */
export interface IPlaytestLightObservation {
  /** `#rrggbb`, or `unobserved` when the light carries no readable colour. */
  color: string;
  /** Absent when the light reports no finite intensity. Never an unmeasured zero. */
  intensity?: number;
  /** The light's constructor name — `DirectionalLight`, `AmbientLight`, and so on. */
  type: string;
  visible: boolean;
}

/**
 * The scene's distance fade, if it has one. Absent means no fog, never "fog at zero".
 */
export interface IPlaytestFogObservation {
  color: string;
  /** Present for `FogExp2`. */
  density?: number;
  /** Present for linear `Fog`. */
  far?: number;
  /** Present for linear `Fog`. */
  near?: number;
  type: "exponential" | "linear";
}

/**
 * Where the camera is and what it can see, which is the framing an entity transform cannot say.
 */
export interface IPlaytestCameraObservation {
  /** Absent on a bare `Camera`, which carries no clip planes. */
  far?: number;
  /** Unit world-space forward vector. */
  forward: [number, number, number];
  /** Vertical field of view in degrees. Absent for an orthographic camera. */
  fov?: number;
  /** Absent on a bare `Camera`, which carries no clip planes. */
  near?: number;
  position: [number, number, number];
  /** The camera's constructor name. */
  type: string;
}

/**
 * The room the game is being played in — lights, materials, fog, background and camera framing.
 *
 * `doctor --url` used to list all of this under "not observed", which meant an agent debugging a
 * washed-out or black frame had no instrument at all and went to screenshots. Round 9's visual
 * column was lost to a fog whose far plane sat in front of the sky dome; nothing in the harness
 * could say so. Counts and names only: every value here is read off the scene, and none of it
 * decides how anything looks.
 */
export interface IPlaytestSceneObservation {
  /** `none`, `color:#rrggbb`, or the background object's constructor name. */
  background: string;
  camera: IPlaytestCameraObservation;
  fog?: IPlaytestFogObservation;
  lights: IPlaytestLightObservation[];
  /**
   * How many materials of each constructor name are mounted in the scene, counted per distinct
   * material rather than per mesh.
   */
  materials: Record<string, number>;
  /** Objects the walk visited. */
  objects: number;
  /**
   * True when the walk stopped at its cap, so every count above is a floor rather than a total.
   * Reported instead of silently truncating, because a partial count read as a total is the
   * confident-number-with-nothing-behind-it this harness exists to prevent.
   */
  truncated: boolean;
  /** World-space extent of everything the walk visited, or absent when the scene is empty. */
  worldExtent?: { max: [number, number, number]; min: [number, number, number] };
}

/**
 * One node of the scene graph, read as numbers instead of looked at.
 *
 * `scene.observe` reports the room as counts — how many lights, how many materials of each
 * constructor. That answers "is anything lit" and cannot answer "is the crate on screen", "did
 * the seal plate load its texture", "is this mesh inside the wall". Those are the questions an
 * agent otherwise takes a screenshot for, and a screenshot cannot say why. Every field here is
 * read off the object the renderer will draw; nothing is inferred and nothing decides how the
 * game looks.
 */
export interface IPlaytestSceneNodeObservation {
  /** Clips mounted on this node's mixer, and which of them are advancing. */
  animation?: { clips: string[]; playing: string[] };
  /** World-space axis-aligned bounds, absent when the node encloses nothing. */
  bounds?: { max: [number, number, number]; min: [number, number, number] };
  geometry?: { attributes: string[]; triangles: number; vertices: number };
  /** Whether the node's world bounds intersect the active camera's frustum. */
  inFrustum?: boolean;
  /** Instance count for an InstancedMesh or BatchedMesh. */
  instances?: number;
  materials?: IPlaytestSceneNodeMaterial[];
  name: string;
  /** Slash-joined path from the scene root, the same shape `entity.observe` reports. */
  path: string;
  position: [number, number, number];
  scale: [number, number, number];
  skinned?: { bones: number };
  type: string;
  /** The node's own visible flag. */
  visible: boolean;
  /** The node's flag and every ancestor's — what the renderer actually acts on. */
  visibleInTree: boolean;
}

/**
 * A material as mounted, including the two facts that make a mesh render black while every
 * count above it reads healthy: a map slot bound to a texture that never loaded, and a lit
 * material in a scene with nothing to light it.
 */
export interface IPlaytestSceneNodeMaterial {
  color?: string;
  emissive?: string;
  /** True when the material reads scene lighting, so an unlit scene renders it black. */
  lit: boolean;
  /** Map slots bound to a texture, by property name. */
  maps: string[];
  /** Bound slots whose texture carries no image — the black-texture case a count cannot show. */
  mapsUnloaded: string[];
  metalness?: number;
  name: string;
  opacity?: number;
  roughness?: number;
  transparent: boolean;
  type: string;
  visible: boolean;
}

/**
 * Which nodes to report. An absent field does not filter; every present field must match.
 * A selector that matches nothing is reported as `matched: 0`, never as an empty success.
 */
export interface IPlaytestSceneNodeSelector {
  /** Ceiling on reported nodes. The walk still counts every match, so `matched` is a total. */
  limit?: number;
  /** Exact `Object3D.name`. */
  name?: string;
  /** Case-insensitive substring of `Object3D.name`. */
  nameContains?: string;
  /** Case-insensitive substring of the slash-joined path. */
  pathContains?: string;
  /** Exact `Object3D.type` — `Mesh`, `SkinnedMesh`, `PointLight`, `Group`. */
  type?: string;
}

export interface IPlaytestSceneNodesObservation {
  /** Total nodes the selector matched, before `limit` was applied. */
  matched: number;
  nodes: IPlaytestSceneNodeObservation[];
  selector: IPlaytestSceneNodeSelector;
  /** True when `limit` or the walk cap cut the list, so `nodes` is a sample and not the set. */
  truncated: boolean;
}

export interface IPlaytestContactObservation {
  entity: string;
  kind: string;
  /**
   * The tick the contact happened on, when the producer drains its contact log per tick. Absent
   * from a producer that drains only at sample time, and an assertion that needs it fails closed
   * rather than falling back to step granularity — the two are not the same measurement.
   */
  tick?: number;
  with: string;
}

/**
 * A published value changing, and the tick it changed on.
 *
 * Without this a run can say *a contact happened* and *the state reads `won`*, and nothing relates
 * them. Comparing at step boundaries cannot separate a win that arrived with the contact from one
 * that arrived 199 ticks later in the same step — which is the signature of a timer or a distance
 * check that happens to land near a contact.
 */
export interface IPlaytestTransitionObservation {
  from: JsonPrimitive;
  /** `states.<entity>` for a registered entity, or `state.<field>` for a published field. */
  path: string;
  tick: number;
  to: JsonPrimitive;
}

export interface IPlaytestTagObservation {
  count: number;
}

export interface IPlaytestPerformanceObservation {
  drawCalls?: number;
  triangles?: number;
}

export interface IPlaytestRenderChainObservation {
  contributions?: Array<{ graphOutputChanged: boolean; name: string }>;
  dropped: Array<{ name: string; reason: string }>;
  requested: string[];
  source: "pinned" | "auto";
  stages: string[];
  tier: "high" | "medium" | "low" | "off";
  velocity: {
    measurementFrame?: number;
    provisioned: boolean;
    required: boolean;
    rejectionFraction?: number;
    source: "mrt" | "per-object" | null;
  };
}

export interface IPlaytestWorldRuntimeObservation {
  agent: string;
  core: string;
  randomState: number;
  rapier: string | null;
  step: number;
}

export interface IPlaytestWorldObservation {
  runtime?: IPlaytestWorldRuntimeObservation;
  seed: number | null;
}

export interface IPlaytestGameplayObservation {
  animation: Record<string, IPlaytestAnimationObservation>;
  contacts?: IPlaytestContactObservation[];
  states: Record<string, string>;
  tags?: Record<string, IPlaytestTagObservation>;
  /** Tick-stamped changes to published values. Absent from a run whose loop never ticked. */
  transitions?: IPlaytestTransitionObservation[];
  world?: IPlaytestWorldObservation;
}

/** Per-render samples shared by the browser and native playtest bridges. */
/**
 * The named parts of one presented frame. Closed on purpose: a budget naming anything else is a
 * typo, and a typo that evaluated no bound would report green on a ceiling nobody checked.
 */
export const PLAYTEST_FRAME_BUDGET_PHASES = ["hostGap", "overlay", "render", "residual", "update"] as const;

export type PlaytestFramePhase = (typeof PLAYTEST_FRAME_BUDGET_PHASES)[number];

/**
 * Where a frame's milliseconds went, by phase. Every phase optional so a producer that measures
 * only some of them is describable; a ceiling on a phase the producer omitted fails naming the
 * missing evidence rather than passing on nothing.
 */
export type PlaytestFramePhaseSample = Partial<Record<PlaytestFramePhase, number>>;

/**
 * The named render-pass kinds a budget can bound. Deliberately the same closed set the engine's
 * `RenderPassBudget` emits, spelled out here rather than imported: this package must run against
 * plain Three.js with zero ThreeNative dependency, exactly as it does for the phase names.
 */
export const PLAYTEST_FRAME_PASS_KINDS = ["main", "shadow", "reflection", "nested"] as const;

export type PlaytestFramePassKind = (typeof PLAYTEST_FRAME_PASS_KINDS)[number];

/** One render pass's own submissions, attributed to the innermost active render call. */
export interface IPlaytestFramePassSample {
  readonly draws: number;
  readonly kind: PlaytestFramePassKind;
  readonly triangles: number;
}

export interface IPlaytestRuntimeDiagnosticsSample {
  drawCalls?: number;
  frameMs: number;
  /**
   * Supplied by an engine that measures its own frame — `@threenative/core` fills it from the
   * frame budget. Absent for a plain Three.js bridge.
   */
  phases?: PlaytestFramePhaseSample;
  /**
   * Draw calls and triangles per render pass, so a shadow or reflection pass is bounded rather
   * than folded into the whole-frame draw count. Absent when the producer measures no split.
   */
  passes?: readonly IPlaytestFramePassSample[];
  triangles?: number;
}

export interface IPlaytestObservationSnapshot {
  clock: {
    mode: PlaytestClockMode;
    tick?: number;
    timeMs?: number;
  };
  diagnostics?: JsonValue[];
  components?: Record<string, Record<string, JsonValue>>;
  entities?: IPlaytestEntityObservation[];
  gameplay?: IPlaytestGameplayObservation;
  /** The per-object geometry capture report, present only when the request asked for one. */
  geometry?: JsonValue;
  physicsDebugSeries?: Array<{ label: string; snapshot: JsonValue; tick: number }>;
  /**
   * Steps the physics simulation completed, counted by the plugin that owns it at its own
   * `simulation.step`. Not the game loop's tick: a frame can render with no step, and a step can be
   * refused. Only present when a physics plugin installed, which is what advertises
   * `runtime.physics`.
   */
  physicsSteps?: number;
  network?: { requests: number; entries: Array<{ method: string; url: string }> };
  performance?: IPlaytestPerformanceObservation;
  /** Bounded shader/pipeline creation capture supplied by the engine when diagnostics are enabled. */
  pipelineCensus?: JsonValue;
  renderChain?: IPlaytestRenderChainObservation;
  runtimeDiagnosticsSeries?: IPlaytestRuntimeDiagnosticsSample[];
  resources?: Record<string, JsonValue>;
  scene?: IPlaytestSceneObservation;
  sceneNodes?: IPlaytestSceneNodesObservation[];
}

/**
 * What the bridge says it actually applied, as opposed to what the runner asked for.
 *
 * The setup contract used to rest entirely on the bridge throwing: `applied` was assigned the
 * *requested* records, so a bridge that partially applied and resolved reported full application
 * and `applied === requested` always. A bridge that returns this instead lets the report show the
 * difference, and lets the runner fail on a request nobody confirmed.
 *
 * `entities` and `resources` are the ids the bridge applied. Returning nothing at all is still
 * accepted — the runner then records that the evidence is the throw contract and not a read-back,
 * rather than claiming a confirmation it never received.
 */
export interface IPlaytestSetupConfirmation {
  entities?: readonly string[];
  resources?: readonly string[];
}

export interface IPlaytestAdvanceResult {
  clock: IPlaytestObservationSnapshot["clock"];
  ticks: number;
}

export interface IPlaytestBridgeV1 {
  /** A core bridge draws a driven frame only when asked (`render: true`), as a measurement that couples updates to draws does. */
  advance?(ticks: number, options?: { render?: boolean }): Promise<IPlaytestAdvanceResult>;
  applySetup?(request: IPlaytestSetupRequest): Promise<IPlaytestSetupConfirmation | void>;
  describe(): IPlaytestBridgeDescription | Promise<IPlaytestBridgeDescription>;
  drainEvents?(limit?: number): Promise<JsonValue[]>;
  focus?(): boolean | Promise<boolean>;
  ready(): IPlaytestBridgeReady | Promise<IPlaytestBridgeReady>;
  /**
   * Draw the current world once without advancing it, so a capture can see a present while a
   * deterministic run's loop is driven and presents nothing between ticks. Present only when the
   * bridge advertises `runtime.renderOnly`.
   */
  renderOnly?(): number | void | Promise<number | void>;
  sample(request: IPlaytestSampleRequest): IPlaytestObservationSnapshot | Promise<IPlaytestObservationSnapshot>;
}

/** Request/response envelope used by the host-neutral device transport. */
export interface IPlaytestDeviceRequest {
  argument?: JsonValue;
  id: string;
  method: string;
}

export interface IPlaytestDeviceResponse {
  error?: { message: string };
  id: string;
  result?: JsonValue;
}

export interface IPlaytestBridgeHost {
  [PLAYTEST_BRIDGE_GLOBAL]?: IPlaytestBridgeV1;
}

/**
 * Measure a payload's wire size in bytes.
 * @situation check a runtime observation against the protocol payload limit before sampling
 * @example const bytes = jsonByteLength(observation);
 */
export function jsonByteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Reject any value that would not survive JSON serialization.
 * @situation validate entity components and gameplay observations before crossing the bridge
 * @constraint throws instead of silently dropping the offending field
 * @example assertJsonSafe(snapshot, "$.components");
 */
export function assertJsonSafe(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new TypeError(`${path} must contain only finite JSON numbers.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must be JSON-safe.`);
}
