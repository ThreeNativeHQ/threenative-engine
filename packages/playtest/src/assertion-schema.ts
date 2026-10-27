import { TONE_METRICS } from "./tone.js";
import type { IPlaytestScenario, PlaytestTarget } from "./scenario.js";
import type { PlaytestCapability } from "./capabilities.js";
import { resolveDiagnosticsPolicy } from "./assertion-report.js";

export interface IPlaytestAssertionSchemaField {
  description: string;
  name: string;
  required?: boolean;
  type: string;
}

export interface IPlaytestAssertionSchemaEntry {
  cardinality: "array" | "object";
  description: string;
  example: unknown;
  fields: IPlaytestAssertionSchemaField[];
  kind: keyof NonNullable<IPlaytestScenario["assert"]>;
  observationPath: string;
  requiredCapabilities: readonly PlaytestCapability[];
  resultIdPrefix: string;
  supportedOn: readonly PlaytestTarget[];
  triviality: "not-applicable" | "reject-initial-value";
  trivialityRationale: string;
}

export const PLAYTEST_ASSERTION_REGISTRY: readonly IPlaytestAssertionSchemaEntry[] = [
  {
    description: "Bounds display-referred luminance from a captured PNG frame, using a shared 256-bin histogram.",
    example: { tone: [{ atStep: "landed", mean: { min: 60, max: 140 }, p99: { min: 150 } }] },
    fields: [
      { description: "Capture after this named step; omit for the final frame.", name: "atStep", type: "non-empty string" },
      { description: "Exact decoded PNG physical-pixel rectangle; non-negative safe-integer x/y, positive safe-integer width/height. No clipping or scaling.", name: "region", type: "{ x: number, y: number, width: number, height: number }" },
      { description: "Same-capture primary minus reference region metric must reach minDelta; requires primary region.", name: "compare", type: "{ region: object, metric: string, minDelta: number }" },
      ...TONE_METRICS.map((name) => ({ description: "Inclusive finite bounds; luminance is 0..255 and fractions are 0..1. At least one bound is required.", name, type: "{ min?: number, max?: number }" })),
    ],
    cardinality: "array",
    kind: "tone",
    observationPath: "tone",
    requiredCapabilities: ["browser.screenshot"],
    resultIdPrefix: "tone.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The host decodes actual captured pixels; a missing capture fails closed.",
  },
  {
    description: "Reports the device's thermal, power and battery state around the run and judges whether the run is comparable with a cool one.",
    example: { deviceMetrics: { maxTemperatureRiseC: 5, notThermallyConfounded: true } },
    fields: [
      { description: "Ceiling on the battery temperature climb from the first to the last sample, in \u00b0C.", name: "maxTemperatureRiseC", type: "finite non-negative number" },
      { description: "Ceiling on the highest Android thermal status observed during the run; 0 is NONE.", name: "maxThermalStatus", type: "non-negative integer 0..6" },
      { description: "Requires a run the harness judged comparable with a cool one: not started hot, not already throttled, no thermal-status rise, not charging.", name: "notThermallyConfounded", type: "true" },
    ],
    cardinality: "object",
    kind: "deviceMetrics",
    observationPath: "deviceMetrics",
    requiredCapabilities: ["device.metrics"],
    resultIdPrefix: "deviceMetrics.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The observation is measured by the host from the device around the run; there is no initial in-scene value that could satisfy it.",
  },
  {
    description: "Samples the framebuffer on every render frame inside a labeled loading window and requires every coarse-grid RGB sample to match the declared backdrop.",
    example: {
      framebufferCoverage: {
        backdrop: [5, 7, 11],
        grid: { columns: 32, rows: 18 },
        tolerance: 8,
        window: { endStep: "loading-end", startStep: "loading-start" },
      },
    },
    fields: [
      { description: "Backdrop RGB byte channels every sampled pixel must match.", name: "backdrop", required: true, type: "[integer 0..255, integer 0..255, integer 0..255]" },
      { description: "Coarse sample grid. Defaults to 32x18, which catches the loading leak while limiting synchronous readback work.", name: "grid", type: "{ columns: positive integer <= 256, rows: positive integer <= 256 }" },
      { description: "Maximum absolute difference allowed for each RGB channel.", name: "tolerance", required: true, type: "integer 0..255" },
      { description: "Inclusive labeled-step boundaries for the loading-covered interval.", name: "window", required: true, type: "{ startStep: string, endStep: string }" },
    ],
    cardinality: "object",
    kind: "framebufferCoverage",
    observationPath: "framebufferCoverage",
    requiredCapabilities: ["browser.screenshot"],
    resultIdPrefix: "framebufferCoverage",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It samples a window-wide framebuffer over a labeled loading interval; a static initial value cannot satisfy the temporal pixel-evidence contract.",
  },
  {
    description: "Checks every consecutive platform against a measured static movement-envelope fit; it does not simulate traversal, walls, ceilings, run-up, or air control.",
    example: { reachability: { artifact: "artifacts/character-envelope/player.json", entities: ["platform.a", "platform.b"] } },
    fields: [
      { description: "Project-relative character envelope artifact emitted by tn character envelope.", name: "artifact", required: true, type: "string" },
      { description: "Ordered platform entity ids forming the critical path.", name: "entities", required: true, type: "string[] (minimum 2)" },
    ],
    cardinality: "object",
    kind: "reachability",
    observationPath: "entityTransforms",
    requiredCapabilities: ["entity.observe"],
    resultIdPrefix: "reachability.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It compares authored platform geometry with a measured movement envelope; no runtime initial value is asserted.",
  },
  {
    description: "Proves aerodynamic force telemetry and signed control-surface delivery for a flight entity.",
    example: { aerodynamics: [{ controls: [{ sign: "negative", surface: "elevator" }], entity: "aircraft", minForceSamples: 4 }] },
    fields: [
      { description: "Aerodynamic entity id.", name: "entity", required: true, type: "string" },
      { description: "Minimum physics-debug samples containing finite aerodynamic force vectors.", name: "minForceSamples", type: "positive integer" },
      { description: "Signed surface values required in physics.aerodynamics.setInputs calls.", name: "controls", type: "Array<{ surface: string, sign: 'negative' | 'positive', minAbs?: number }>" },
      { description: "Signed net aerodynamic torque, optionally relative to another labeled step.", name: "torques", type: "Array<{ label: string, relativeToLabel?: string, axis: 'x' | 'y' | 'z', sign: 'negative' | 'positive', minAbs?: number }>" },
    ],
    cardinality: "array",
    kind: "aerodynamics",
    observationPath: "physicsDebugSeries",
    requiredCapabilities: ["runtime.fixedStep", "runtime.physics"],
    resultIdPrefix: "aerodynamics.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It requires force telemetry and signed control delivery across samples; no held initial scalar can satisfy the proof.",
  },
  {
    description: "Proves screenshot change, populated coordinate or DOM element-bound regions, dark-pixel bounds, and sustained projected entity visibility.",
    example: { visual: [{ frameDiff: { baselineImage: "artifacts/baseline.png", minChangedPixelRatio: 0.01 }, entityVisible: { entity: "board.e4", minProjectedPixels: 20, throughoutFrames: true }, region: { element: { id: "error" }, minNonblankPixelRatio: 0.002 } }] },
    fields: [
      { description: "Before/after or baseline-image changed-pixel ratio bounds.", name: "frameDiff", type: "{ baselineImage?: project-relative PNG, minChangedPixelRatio?: number, maxChangedPixelRatio?: number }" },
      { description: "Static pixel bounds, or a DOM element whose bounds are captured beside the screenshot; the latter accepts exactly one id or selector. Both forms accept nonblank, dark-pixel, and luminance thresholds. A static region also takes `minSharpness` (a ratio, start at 0.3): the share of luminance detail that survives at full resolution against half resolution in the final frame. In-focus frames read 0.39-0.61, a frame a post stage smears reads 0.21-0.24.", name: "region", type: "static bounds { x: number, y: number, width: number, height: number, minSharpness?: number, minNonblankPixelRatio?: number, maxDarkPixelRatio?: number, minDarkPixelRatio?: number, maxLuminance?: number } or element bounds { element: { id?: string, selector?: string }, minNonblankPixelRatio?: number, maxDarkPixelRatio?: number, minDarkPixelRatio?: number, maxLuminance?: number }" },
      { description: "Entity projected-pixel floor, optionally across all captured samples.", name: "entityVisible", type: "{ entity: string, minProjectedPixels: number, throughoutFrames?: boolean }" },
    ],
    cardinality: "array",
    kind: "visual",
    observationPath: "visual",
    requiredCapabilities: ["browser.screenshot"],
    resultIdPrefix: "visual.",
    supportedOn: ["web"],
    triviality: "not-applicable",
    trivialityRationale: "It requires screenshot evidence from a capture; the initial scene alone cannot satisfy its frame-difference or region contract.",
  },
  {
    description: "Proves the subject moved, reached a minimum velocity, or changed rotation during held input.",
    example: { movement: { entity: "player", minDistance: 0.5, minVelocity: 0.01, rotationChanged: true } },
    fields: [
      { description: "Optional entity id to measure; when omitted, choose an observed mover.", name: "entity", type: "string" },
      { description: "Require distance to a fixed world position to decrease by at least min.", name: "closesDistanceToPosition", type: "{ position: [number, number, number], min: number }" },
      { description: "Maximum yaw error from resolved movement direction.", name: "facesMovementWithinDegrees", type: "number" },
      { description: "Expected movement axis: x, y, or z.", name: "axis", type: "string" },
      { description: "Minimum signed movement on a specific axis, for example { axis: '+y', min: 0.2 }.", name: "minAxisDelta", type: "{ axis: string, min: number }" },
      { description: "Minimum signed resolved character.move displacement on a specific axis, for example { axis: '+y', min: 0.2 }.", name: "minResolvedAxisDelta", type: "{ axis: string, min: number }" },
      { description: "Maximum final pitch/roll tilt from world up, in degrees; yaw is ignored.", name: "maxTiltDegrees", type: "number in [0, 180]" },
      { description: "Minimum distance moved over the scenario.", name: "minDistance", type: "number" },
      { description: "Maximum distance allowed; use for blocked-movement proof.", name: "maxDistance", type: "number" },
      { description: "Minimum distance per frame.", name: "minVelocity", type: "number" },
      { description: "Minimum accumulated path length; use with minDistance to catch movement that cancels out.", name: "pathLength", type: "number" },
      { description: "Require the final facing to differ from another entity by at least minDegrees.", name: "notFacing", type: "{ entity: string, minDegrees: number }" },
      { description: "Require the final facing to differ from a fixed world position by at least minDegrees.", name: "notFacingPosition", type: "{ position: [number, number, number], minDegrees: number }" },
      { description: "Require a resolved character position to come within maxDistance of a fixed world position, optionally within one labeled step.", name: "reachesPositionWithin", type: "{ position: [number, number, number], maxDistance: number, atStep?: string }" },
      { description: "Require any observed rotation delta.", name: "rotationChanged", type: "boolean" },
    ],
    cardinality: "object",
    kind: "movement",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["entity.observe"],
    resultIdPrefix: "movement.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It measures transform displacement under scenario input; an initial pose cannot itself prove movement.",
  },
  {
    description: "Proves a camera follows an entity or keeps a target in view.",
    example: { camera: { entity: "camera.main", follows: "player", within: 10, targetInViewport: true } },
    fields: [
      { description: "Camera entity id.", name: "entity", type: "string" },
      { description: "Entity the camera should follow.", name: "follows", type: "string" },
      { description: "Maximum allowed separation.", name: "within", type: "number" },
      { description: "Require the target to be visible in the viewport.", name: "targetInViewport", type: "boolean" },
    ],
    cardinality: "object",
    kind: "camera",
    observationPath: "runtimeDiagnostics",
    requiredCapabilities: ["camera.observe", "entity.observe"],
    resultIdPrefix: "camera",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It checks a camera-to-target relationship from runtime observations; the registry keeps this relationship outside the held-value guard.",
  },
  {
    description: "Proves a live entity component value after the scenario or at named steps.",
    example: { components: [{ component: "Camera", entity: "camera.main", path: "fovY", equals: 22, changed: true }] },
    fields: [
      { description: "Entity id carrying the component.", name: "entity", required: true, type: "string" },
      { description: "Component name as emitted in the runtime world.", name: "component", required: true, type: "string" },
      { description: "Optional dot path inside the component snapshot.", name: "path", type: "string" },
      { description: "Exact expected value.", name: "equals", type: "json" },
      { description: "Minimum numeric value.", name: "gte", type: "number" },
      { description: "Maximum numeric value.", name: "lte", type: "number" },
      { description: "Require before and after values to differ or remain equal.", name: "changed", type: "boolean" },
      { description: "Expected values at named scenario-step samples.", name: "atSteps", type: "Array<{ label: string, equals: json }>" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "components",
    observationPath: "components",
    requiredCapabilities: ["runtime.components"],
    resultIdPrefix: "component.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "A component comparator can pass on its initial snapshot, so initial satisfaction must be rejected unless a written held-invariant reason is recorded.",
  },
  {
    description: "Proves resource state after the scenario through equals, gte, lte, textIncludes, or changed checks.",
    example: { resources: [{ id: "GameState", path: "score", gte: 1, changed: true }] },
    fields: [
      { description: "Resource id.", name: "id", required: true, type: "string" },
      { description: "Optional dot path inside the resource snapshot.", name: "path", type: "string" },
      { description: "Exact expected value.", name: "equals", type: "json" },
      { description: "Minimum numeric value.", name: "gte", type: "number" },
      { description: "Maximum numeric value.", name: "lte", type: "number" },
      { description: "Substring expected in the observed value.", name: "textIncludes", type: "string" },
      { description: "Require before and after values to differ or remain equal.", name: "changed", type: "boolean" },
      { description: "Require the value assertion after every labeled scenario step.", name: "throughoutSteps", type: "boolean" },
      { description: "Expected values at named scenario-step samples.", name: "atSteps", type: "Array<{ label: string, equals?: json, lte?: number, textIncludes?: string }>" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
      { description: "Require at least one alternative path assertion on this resource id.", name: "anyOf", type: "Array<{ path: string, equals?: json, gte?: number, lte?: number, textIncludes?: string, changed?: boolean }>" },
    ],
    cardinality: "array",
    kind: "resources",
    observationPath: "resources",
    requiredCapabilities: ["runtime.resources"],
    resultIdPrefix: "resource.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "A resource comparator can pass on its initial snapshot, so initial satisfaction must be rejected unless a written held-invariant reason is recorded.",
  },
  {
    description: "Proves the final count of entities carrying a bounded runtime tag.",
    example: { tags: [{ tag: "coin", count: 10 }] },
    fields: [
      { description: "Entity tag to count.", name: "tag", required: true, type: "string" },
      { description: "Exact expected entity count.", name: "count", type: "non-negative integer" },
      { description: "Minimum expected entity count.", name: "gte", type: "non-negative integer" },
      { description: "Maximum expected entity count.", name: "lte", type: "non-negative integer" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "tags",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.tags"],
    resultIdPrefix: "tags.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "A tag count can already equal its expected initial count; the scenario must prove a transition or document why that count is intentionally held.",
  },
  {
    description: "Proves a named Godot signal was emitted by the application during the run or at a labeled step.",
    example: { signals: [{ name: "collected", entity: "player", minCount: 3, atStep: "last-coin" }] },
    fields: [
      { description: "Retained step label to inspect instead of the full signal history.", name: "atStep", type: "string" },
      { description: "Entity id that emitted the signal.", name: "entity", type: "string" },
      { description: "Maximum number of matching signals; use zero to prove separation.", name: "maxCount", type: "non-negative integer" },
      { description: "Minimum number of matching signals.", name: "minCount", type: "non-negative integer" },
      { description: "Godot signal name emitted by the application.", name: "name", required: true, type: "string" },
    ],
    cardinality: "array",
    kind: "signals",
    observationPath: "signals",
    requiredCapabilities: ["runtime.events"],
    resultIdPrefix: "signal.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It requires an emitted signal event; an initial state contains no matching event evidence to satisfy the assertion.",
  },
  {
    description: "Proves an observed entity's final runtime-owned state-machine state.",
    example: { states: [{ equals: "completed" }] },
    fields: [
      { description: "Optional entity id; when omitted, choose an observed state candidate.", name: "entity", type: "string" },
      { description: "Expected current state name.", name: "equals", required: true, type: "string" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "states",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.state"],
    resultIdPrefix: "states.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "An entity can already be in the expected state at step zero; the scenario must prove a transition or document why the state is held.",
  },
  {
    description: "Proves retained UI/HUD text or values after the scenario.",
    example: { hud: [{ id: "score-label", textIncludes: "Score" }] },
    fields: [
      { description: "UI node id.", name: "id", required: true, type: "string" },
      { description: "Optional dot path inside the UI snapshot.", name: "path", type: "string" },
      { description: "Exact expected value.", name: "equals", type: "json" },
      { description: "Minimum numeric value.", name: "gte", type: "number" },
      { description: "Maximum numeric value.", name: "lte", type: "number" },
      { description: "Substring expected in the observed value.", name: "textIncludes", type: "string" },
      { description: "Require before and after values to differ or remain equal.", name: "changed", type: "boolean" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
      { description: "Require the node to have a non-zero rendered box and be the topmost element at its viewport centre.", name: "visible", type: "boolean" },
    ],
    cardinality: "array",
    kind: "hud",
    observationPath: "hud",
    requiredCapabilities: ["browser.dom"],
    resultIdPrefix: "hud.",
    supportedOn: ["web"],
    triviality: "reject-initial-value",
    trivialityRationale: "A HUD value can satisfy its comparator before input, so initial satisfaction must be rejected unless a written held-invariant reason is recorded.",
  },
  {
    description: "Proves DOM state inside a same-origin webview overlay iframe.",
    example: { overlayNodes: [{ attribute: "data-aiming", equals: "true", overlayId: "game-ui", selector: "[data-testid=fps-crosshair]", visible: false }] },
    fields: [
      { description: "Declared overlay id.", name: "overlayId", required: true, type: "string" },
      { description: "CSS selector inside the overlay document.", name: "selector", required: true, type: "string" },
      { description: "Optional attribute to read instead of text content.", name: "attribute", type: "string" },
      { description: "Exact expected attribute or text value.", name: "equals", type: "json" },
      { description: "Substring expected in text content.", name: "textIncludes", type: "string" },
      { description: "Expected computed visibility.", name: "visible", type: "boolean" },
    ],
    cardinality: "array",
    kind: "overlayNodes",
    observationPath: "overlayNodes",
    requiredCapabilities: ["browser.dom"],
    resultIdPrefix: "overlayNode.",
    supportedOn: ["web"],
    triviality: "not-applicable",
    trivialityRationale: "It reads a declared overlay DOM snapshot; the registry does not treat browser overlay setup state as a gameplay held invariant.",
  },
  {
    description: "Proves console, network, runtime, and readiness diagnostics stayed clean.",
    example: { diagnostics: { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true, runtimeReady: true } },
    fields: [
      { description: "Fail on captured console errors.", name: "noConsoleErrors", type: "boolean" },
      { description: "Fail on captured network errors.", name: "noNetworkErrors", type: "boolean" },
      { description: "Fail on runtime diagnostics.", name: "noRuntimeDiagnostics", type: "boolean" },
      { description: "Required bounded justification when noConsoleErrors is false.", name: "consoleErrorsOptOutReason", type: "non-empty string" },
      { description: "Required bounded justification when noNetworkErrors is false.", name: "networkErrorsOptOutReason", type: "non-empty string" },
      { description: "Required bounded justification when noRuntimeDiagnostics is false.", name: "runtimeDiagnosticsOptOutReason", type: "non-empty string" },
      { description: "Require runtime readiness.", name: "runtimeReady", type: "boolean" },
    ],
    cardinality: "object",
    kind: "diagnostics",
    observationPath: "runtimeDiagnostics",
    requiredCapabilities: ["browser.console", "browser.network", "runtime.diagnostics"],
    resultIdPrefix: "diagnostics",
    supportedOn: ["web", "desktop"],
    triviality: "not-applicable",
    trivialityRationale: "It evaluates captured error and readiness channels across the run; no initial scalar value can satisfy those diagnostics by itself.",
  },
  {
    description: "Proves a live render sample exists and optionally bounds frame time, an fps floor, per-phase frame budget, whole-frame or per-pass draw calls and triangles.",
    example: { performance: { maxPassDrawCalls: { shadow: 400 }, maxPhaseMsP95: { render: 12 }, minFps: 30 } },
    fields: [
      { description: "Maximum nearest-rank 95th-percentile frame time in milliseconds. Unset, the budget is 16.7 ms (one 60 Hz frame, 60 fps) on every tier; a software adapter is unmeasurable and fails closed. On the runner's virtual display the bound judges the engine's own cost (update plus render, or GPU time when larger) and reports the rAF interval as `gated: false`; on a real display (`TN_PLAYTEST_HOST_DISPLAY=1`) the interval and the cost must both hold. A missing CPU split or GPU reading fails closed. `frameBudget` in the `performance.samples` details reports which applied. A value above 16.7 is an override and needs `maxFrameMsReason`.", name: "maxFrameMsP95", type: "number" },
      { description: "Why this scenario cannot hold 60 fps. Required when `maxFrameMsP95` is above 16.7; printed in the report.", name: "maxFrameMsReason", type: "non-empty string" },
      { description: "Minimum sustained frames per second, from the median sampled frame.", name: "minFps", type: "number" },
      { description: "Per-phase millisecond ceilings at nearest-rank p95. Phases: hostGap, update, render, overlay, residual.", name: "maxPhaseMsP95", type: "{ [phase]: number }" },
      { description: "Maximum observed renderer draw-call count across every pass combined.", name: "maxDrawCalls", type: "number" },
      { description: "Per-pass draw-call ceilings, keyed by pass kind: main, shadow, reflection, nested. Fails closed when a sampled frame carries no pass split or omits the declared kind.", name: "maxPassDrawCalls", type: "{ [pass: 'main' | 'shadow' | 'reflection' | 'nested']: number }" },
      { description: "Per-pass triangle ceilings, keyed by pass kind: main, shadow, reflection, nested. Fails closed when a sampled frame carries no pass split or omits the declared kind.", name: "maxPassTriangles", type: "{ [pass: 'main' | 'shadow' | 'reflection' | 'nested']: number }" },
      { description: "Maximum observed renderer triangle count across every pass combined.", name: "maxTriangles", type: "number" },
    ],
    cardinality: "object",
    kind: "performance",
    observationPath: "performanceSeries",
    requiredCapabilities: ["runtime.performance"],
    resultIdPrefix: "performance.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It reads aggregate render samples such as frame time and draw calls; an initial value cannot stand in for the measured series.",
  },
  {
    description: "PRD-222 Tier 2: proves the fps ratio of a parity pair — the same scene on the same device, once in the browser and once native. Lives in the second run and names the first run's saved report; refuses a pair whose halves ran on different devices, a thermally confounded half, or a missing series on either side.",
    example: { parity: { minFpsRatio: 0.85, referenceReport: "reports/native.json", referenceSide: "native" } },
    fields: [
      { description: "Floor on nativeFps ÷ webFps. Tier 2's Floor is 0.85, Target 0.95.", name: "minFpsRatio", type: "positive number" },
      { description: "Optional floor on the inverted render-phase p95 ratio; fails closed when either side lacks the phase split.", name: "minRenderParity", type: "positive number" },
      { description: "Path to the other half's saved run report JSON, resolved against the project.", name: "referenceReport", type: "non-empty string" },
      { description: "Which side of the pair the reference is; the directed ratio needs it.", name: "referenceSide", type: "'browser' or 'native'" },
      { description: "Hydrated from the reference report at load; never written by hand.", name: "reference", type: "object" },
    ],
    cardinality: "object",
    kind: "parity",
    observationPath: "performanceSeries",
    requiredCapabilities: ["runtime.performance"],
    resultIdPrefix: "parity.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It compares two measured run series; no initial in-scene value can satisfy a cross-run ratio.",
  },
  {
    description: "Proves projected entity visibility in the viewport.",
    example: { visibility: [{ entity: "player", minProjectedPixels: 1200, maxOffscreenRatio: 0.05 }] },
    fields: [
      { description: "Entity id. Defaults to scenario subject.", name: "entity", type: "string" },
      { description: "Minimum projected pixel area.", name: "minProjectedPixels", type: "number" },
      { description: "Maximum allowed offscreen ratio.", name: "maxOffscreenRatio", type: "number" },
      { description: "Require the entity to be registered in the sampled scene.", name: "present", type: "boolean" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "visibility",
    observationPath: "runtimeDiagnostics",
    requiredCapabilities: ["entity.bounds"],
    resultIdPrefix: "visibility.",
    supportedOn: ["web"],
    triviality: "reject-initial-value",
    trivialityRationale: "An entity can be present and in-frame before input; the scenario must prove visibility after its setup or document why that presence is held.",
  },
  {
    description: "Proves which labelled audio cues the game actually played, and how often.",
    example: { audio: [{ cue: "speech:p01", maxPlays: 1 }] },
    fields: [
      { description: "Cue label the game passed to AudioBus.play/playAt.", name: "cue", required: true, type: "string" },
      { description: "Fewest plays required. Defaults to 1, so naming a cue asserts it was heard.", name: "minPlays", type: "non-negative integer" },
      { description: "Most plays allowed; 0 proves silence and 1 proves a one-shot stayed one.", name: "maxPlays", type: "non-negative integer" },
      { description: "Fewest milliseconds between this cue and the cue played before it, so one line cannot cut another.", name: "minGapMs", type: "non-negative integer" },
    ],
    cardinality: "array",
    kind: "audio",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.audio"],
    resultIdPrefix: "audio.",
    supportedOn: ["web", "desktop"],
    triviality: "not-applicable",
    trivialityRationale: "A cue count starts at zero and only a played cue moves it, so there is no initial value to reject.",
  },
  {
    description: "Proves runtime world metadata exposed by the application bridge.",
    example: { world: { seed: 90210 } },
    fields: [
      { description: "Expected configured deterministic seed, or null when unseeded.", name: "seed", required: true, type: "json" },
      { description: "Expected deterministic replay runtime fingerprint.", name: "runtime", type: "object" },
    ],
    cardinality: "object",
    kind: "world",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.world"],
    resultIdPrefix: "world.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It checks configured world identity and runtime fingerprint data; those environment facts are not a mutable assertion value.",
  },
  {
    description: "Proves contact or trigger evidence appeared in the effect log.",
    example: { contacts: [{ entity: "player", with: "pickup", kind: "trigger", minCount: 1 }] },
    fields: [
      { description: "Retained step label to inspect instead of the full observation history.", name: "atStep", type: "string" },
      { description: "Optional entity id; when omitted, choose an observed contact candidate.", name: "entity", type: "string" },
      { description: "Other entity or tag token expected in the contact evidence.", name: "with", type: "string" },
      { description: "Contact kind token, such as contact or trigger.", name: "kind", type: "string" },
      { description: "Minimum number of matching observations.", name: "minCount", type: "number" },
      { description: "Maximum number of matching observations; use zero to prove separation.", name: "maxCount", type: "non-negative integer" },
      { description: "Targets on which the contact assertion is required.", name: "requiredOn", type: "Array<'web' | 'desktop' | 'bevy'>" },
    ],
    cardinality: "array",
    kind: "contacts",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.contacts"],
    resultIdPrefix: "contact.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It requires retained contact evidence from the run; a pre-existing value cannot manufacture an emitted contact event.",
  },
  {
    description: "Proves an observed cohort of matching physics bodies is asleep in a retained physics-debug sample.",
    example: { settled: [{ atStep: "fall-and-settle", minBodies: 15 }] },
    fields: [
      { description: "Optional exact entity id or stable entity-id prefix; when omitted, choose an observed cohort.", name: "entity", type: "string" },
      { description: "Optional labeled step whose physics-debug sample must be used.", name: "atStep", type: "string" },
      { description: "Minimum number of matching bodies required.", name: "minBodies", type: "positive integer" },
      { description: "Optional earlier labeled step whose matching body positions are compared.", name: "compareToStep", type: "string" },
      { description: "Minimum mean body-position distance from compareToStep, in metres.", name: "minMeanPoseDistance", type: "positive number" },
      { description: "Targets on which the settled assertion is required.", name: "requiredOn", type: "Array<'web' | 'desktop' | 'bevy'>" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "settled",
    observationPath: "physicsDebugSeries",
    triviality: "reject-initial-value",
    trivialityRationale: "A body can begin asleep and already satisfy the settled bounds; the scenario must prove settling or document why the rest state is held.",
    requiredCapabilities: ["runtime.physics"],
    resultIdPrefix: "settled.",
    supportedOn: ["web", "desktop", "bevy"],
  },
  {
    description: "Proves rendered scene geometry occludes the segment between an origin entity and target.",
    example: { occluded: [{ entity: "listener", target: "emitter" }] },
    fields: [
      { description: "Optional origin/listener entity token expected in the raycast request.", name: "entity", type: "string" },
      { description: "Optional target/emitter entity token expected in the raycast request.", name: "target", type: "string" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "occluded",
    observationPath: "effectLog",
    requiredCapabilities: ["runtime.physics"],
    resultIdPrefix: "occluded.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "A static scene can already produce the requested occlusion; the scenario must prove the ray result or document why the occlusion is held.",
  },
  {
    description: "Proves animation evidence appeared in the effect log or runtime observation.",
    example: { animation: [{ entity: "player", clip: "run", entered: true, advancedFrames: 5, finished: false }] },
    fields: [
      { description: "Entity id. Defaults to scenario subject.", name: "entity", type: "string" },
      { description: "Animation clip id or name.", name: "clip", type: "string" },
      { description: "Labeled step whose animation report is judged; default is the last sample.", name: "atStep", type: "string" },
      { description: "Require entering the animation state.", name: "entered", type: "boolean" },
      { description: "Require animation advancement evidence.", name: "advancedFrames", type: "number" },
      { description: "Require the observed clip to report its completion state.", name: "finished", type: "boolean" },
      { description: "Ceiling on how far the feet and the ground disagree, as |feet - ground| / ground. Fails closed when the producer reports no stride.", name: "maxFootSlide", type: "number" },
      { description: "Require the stride convention to be applied (true) or deliberately overridden (false).", name: "strideSynced", type: "boolean" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "array",
    kind: "animation",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.animation"],
    resultIdPrefix: "animation.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "reject-initial-value",
    trivialityRationale: "A clip can already be playing at the first sample; an entered assertion must prove a transition or document why the clip is held.",
  },
  {
    description: "Bounds the room the game is played in — the lights, materials, fog and camera framing the renderer was handed. Fails closed on a bridge that does not report the scene.",
    example: { scene: { litMaterialsAreLit: true, minVisibleLights: 1 } },
    fields: [
      { description: "Fail when the camera's far plane cuts the scene it is pointed at.", name: "cameraClearsScene", type: "boolean" },
      { description: "Fail when a linear fog reaches full colour in front of the scene it is fogging.", name: "fogClearsScene", type: "boolean" },
      { description: "Fail when lit materials are mounted and no light in the scene is visible.", name: "litMaterialsAreLit", type: "boolean" },
      { description: "Floor on how many lights in the scene are visible to the renderer.", name: "minVisibleLights", type: "number" },
      { description: "Written reason for a held invariant whose initial value intentionally satisfies the assertion.", name: "allowTrivial", type: "triviality reason" },
    ],
    cardinality: "object",
    kind: "scene",
    observationPath: "scene",
    requiredCapabilities: ["scene.observe"],
    resultIdPrefix: "scene.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The room is a property of the scene as built, not of anything the scenario drives; a scene that is already lit is the assertion holding, not a trivial pass.",
  },
  {
    cardinality: "array",
    description:
      "Bounds on named nodes of the scene graph — where an object is, whether it is on screen, whether its textures loaded.",
    example: { sceneNodes: [{ inFrustum: true, select: { nameContains: "crate" }, texturesLoaded: true, visible: true }] },
    fields: [
      { description: "Which nodes to bound, by name, nameContains, pathContains or type.", name: "select", type: "object" },
      { description: "Require every matched node visible with every ancestor visible too.", name: "visible", type: "boolean" },
      { description: "Require every matched node's world bounds inside the active camera's frustum.", name: "inFrustum", type: "boolean" },
      { description: "Require every bound texture slot on every matched node to carry pixels.", name: "texturesLoaded", type: "boolean" },
      { description: "Require every matched node to carry animation clips, or none to.", name: "animated", type: "boolean" },
      { description: "Floor on how many nodes the selector must match. Defaults to 1.", name: "minCount", type: "number" },
      { description: "Ceiling on how many nodes the selector may match. Zero asserts absence.", name: "maxCount", type: "number" },
      { description: "Floor on the summed triangle count across the matched nodes.", name: "minTriangles", type: "number" },
    ],
    kind: "sceneNodes",
    observationPath: "sceneNodes",
    requiredCapabilities: ["scene.nodes"],
    resultIdPrefix: "sceneNodes",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "A node's presence, visibility, framing and texture state are properties of the scene as built; a crate that is already on screen is the assertion holding, not a trivial pass.",
  },
  {
    cardinality: "array",
    description:
      "Bounds how far a planted foot slides while the subject moves, measured every tick from named foot nodes' world positions, so it holds a procedural rig to the feet-meet-the-floor convention as well as a clip. Browser target only; another target fails it as unobserved.",
    example: { footSlip: [{ atStep: "run", feet: ["footL", "footR"], maxSlip: 0.35 }] },
    fields: [
      { description: "Label of the input step to measure; it is advanced one tick at a time and must move the subject at least 0.5 m.", name: "atStep", type: "string" },
      { description: "Exact Object3D names of the nodes at the soles, one per foot.", name: "feet", type: "Array<string>" },
      { description: "Ceiling on planted-foot travel over body travel while a foot is in the lowest quarter of its lift below the body: 0 is planted, 1 skates with the body, above 1 the legs cycle faster than the ground moves. Set this, `maxSlideSpeed`, or both.", name: "maxSlip", type: "positive number" },
      { description: "Ceiling on a planted foot's world speed in metres per second (planted-foot travel over planted time), independent of the body's speed and of the game's own stride report. A starter-kit character holds 1.", name: "maxSlideSpeed", type: "positive number" },
      { description: "Seconds per fixed tick, which turns planted ticks into planted time for `maxSlideSpeed`. Default 1/60, the engine's default `step`; name it when the game sets another.", name: "stepSeconds", type: "positive number" },
      { description: "The moving entity; defaults to the scenario subject.", name: "entity", type: "string" },
    ],
    kind: "footSlip",
    observationPath: "footSlip",
    requiredCapabilities: ["entity.observe", "scene.nodes"],
    resultIdPrefix: "footSlip",
    supportedOn: ["web"],
    triviality: "not-applicable",
    trivialityRationale: "The measurement needs the subject to cover ground during the step, so a standing subject fails as unmeasured instead of passing.",
  },
  {
    cardinality: "object",
    description:
      "Bounds the share of the run in which solid geometry stood between the camera and the subject's world bounds centre, so a camera that clips through a pillar or a wall that eats the framing fails. Browser target only; another target fails it as unobserved.",
    example: { sightLine: { maxBlockedRatio: 0.02 } },
    fields: [
      { description: "The entity whose world bounds centre the camera should see; defaults to the scenario subject.", name: "entity", type: "string" },
      { description: "Share of samples, 0..1, that may have any solid between the lens and the subject before the run fails; 0 requires a clear line on every sample.", name: "maxBlockedRatio", required: true, type: "number" },
    ],
    kind: "sightLine",
    observationPath: "sightLine",
    requiredCapabilities: ["camera.observe", "entity.observe"],
    resultIdPrefix: "sightLine",
    supportedOn: ["web"],
    triviality: "not-applicable",
    trivialityRationale: "The measurement needs the runtime camera and subject to stay framed over time; an initial pose cannot satisfy a temporal share of clear lines.",
  },
  {
    cardinality: "object",
    description:
      "Audits the text the page draws for the player: developer left-overs such as debug, TODO, placeholder or an unresolved undefined, and text whose colour is too close to its backing colour. Browser target only; another target fails it as unobserved.",
    example: { hudAudit: { minContrast: 3, noDebugText: true } },
    fields: [
      { description: "WCAG 2.x contrast ratio, 1..21, that every text item over a real backing colour must reach; text drawn straight on the canvas is counted as unjudged.", name: "minContrast", type: "number" },
      { description: "Require that no text reads like developer copy. Only true is accepted.", name: "noDebugText", type: "true" },
    ],
    kind: "hudAudit",
    observationPath: "hudAudit",
    requiredCapabilities: ["browser.dom"],
    resultIdPrefix: "hudAudit.",
    supportedOn: ["web"],
    triviality: "not-applicable",
    trivialityRationale: "The audit reads the live document the player sees, so an initial value cannot prove that developer text never appeared or that a colour stays readable.",
  },
  {
    cardinality: "array",
    description:
      "Relates a tick-stamped effect to the tick-stamped cause that must precede it — the 'because' a terminal state needs.",
    example: {
      causedBy: [
        {
          cause: { contact: { entity: "player", kind: "trigger", with: "seal" } },
          effect: { becomes: "won", path: "state.status" },
          neverBefore: true,
          withinTicks: 4,
        },
      ],
    },
    fields: [
      { description: "The event that must happen first: a contact, or another transition.", name: "cause", type: "object" },
      { description: "The published value whose change is being explained: path and becomes.", name: "effect", type: "object" },
      { description: "Fail when the effect is ever observed before the first matching cause.", name: "neverBefore", type: "boolean" },
      { description: "Ceiling on effectTick minus causeTick.", name: "withinTicks", type: "number" },
    ],
    kind: "causedBy",
    observationPath: "runtimeObservations",
    requiredCapabilities: ["runtime.transitions"],
    resultIdPrefix: "causedBy",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "It relates two tick-stamped observations the run produced; a pre-existing value cannot manufacture an ordering, and a value already at the asserted state never transitions to it.",
  },
  {
    description: "Bounds when the application's startup milestones happened: the world entered, first-use compilation settled, readiness reached — in milliseconds since navigation, from the runtime's own startup timeline.",
    example: { startup: { maxEnteredMs: 2500, maxReadyMs: 8000 } },
    fields: [
      { description: "Ceiling on when the start scene's enter() returned, in ms since navigation.", name: "maxEnteredMs", type: "number" },
      { description: "Ceiling on when first-use compilation settled or its budget expired, in ms since navigation.", name: "maxCompileSettledMs", type: "number" },
      { description: "Ceiling on when startup readiness resolved, in ms since navigation.", name: "maxReadyMs", type: "number" },
      { description: "Ceiling on the bytes the reveal waited for through ctx.assets that the spawn camera does not show, from the runtime's own measurement; 0 asserts everything awaited is in view.", name: "maxOffscreenBytes", type: "number" },
      { description: "true: every frame the browser presented between navigation and readiness matches the last one before readiness (the loading cover), so a black, blank or page-background frame fails, and no frame between readiness and the first world frame shows page UI (a HUD) over the cover. Browser target only; elsewhere it fails as unobserved.", name: "steadyCover", type: "boolean" },
    ],
    cardinality: "object",
    kind: "startup",
    observationPath: "startup",
    requiredCapabilities: ["runtime.startup"],
    resultIdPrefix: "startup.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The timeline is stamped by the runtime as milestones happen; a missing milestone fails the ceiling rather than passing it.",
  },
  {
    description: "Bounds node-builder state builds and render-pipeline creations after a complete runtime capture proves that explicit shader warm-up settled; a named streamed scope must also prove its target-bound first visible world frame, and missing, incomplete, or malformed census evidence fails closed.",
    example: { pipelineCensus: { maxNodeBuildsAfterWarmUpSettled: 0, maxRenderPipelineCreationsAfterWarmUpSettled: 0 } },
    fields: [
      { description: "Ceiling on distinct node-builder states first observed after warm-up settled.", name: "maxNodeBuildsAfterWarmUpSettled", type: "non-negative integer" },
      { description: "Ceiling on render-pipeline creations observed after warm-up settled.", name: "maxRenderPipelineCreationsAfterWarmUpSettled", type: "non-negative integer" },
      { description: "Label of a repeatable streamed warm-up scope.", name: "warmUpScope", type: "string" },
      { description: "Ceiling on node-builder state builds after the named warm-up scope.", name: "maxNodeBuildsAfterWarmUpScope", type: "non-negative integer" },
      { description: "Ceiling on render-pipeline creations after the named warm-up scope.", name: "maxRenderPipelineCreationsAfterWarmUpScope", type: "non-negative integer" },
    ],
    cardinality: "object",
    kind: "pipelineCensus",
    observationPath: "pipelineCensus",
    requiredCapabilities: ["runtime.pipelineCensus"],
    resultIdPrefix: "pipelineCensus.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The runtime stamps a separate warm-up boundary and counts later observations; an initial scene value cannot satisfy a post-boundary ceiling.",
  },
  {
    description: "Proves the render chain reports its quality tier, authored stage ids/order, graph-output changes for named stages, and, when asserted, a bounded temporal-history rejection fraction.",
    example: { renderChain: { tier: "high", stages: { includes: ["outline", "kuwahara", "watercolor"], order: ["outline", "kuwahara", "watercolor"] }, contributions: { graphOutputChanged: ["outline", "kuwahara", "watercolor"] } } },
    fields: [
      { description: "Exact render-chain quality tier required after the chain applies.", name: "tier", type: "string" },
      { description: "Stage ids to include, exclude, or find as an ordered subsequence in the applied chain.", name: "stages", type: "object" },
      { description: "Applied stage ids whose build returned a different graph node than its input; this is graph evidence, not pixel attribution.", name: "contributions", type: "object" },
      { description: "Temporal history rejection ceiling as a fraction from 0 to 1.", name: "velocity", type: "object" },
      { description: "What the chain must be on each adapter class (hardware, software) and each GPU family (discrete, integrated, mobile-high, mobile-mid, mobile-low) the harness classified from its own adapter.info reading; a family row overrides hardware only when the observed fields prove the family, and an unclassifiable adapter fails rather than matching any branch.", name: "perAdapter", type: "object" },
    ],
    cardinality: "object",
    kind: "renderChain",
    observationPath: "renderChain",
    requiredCapabilities: ["runtime.renderChain"],
    resultIdPrefix: "renderChain.",
    supportedOn: ["web", "desktop", "bevy"],
    triviality: "not-applicable",
    trivialityRationale: "The runtime reports the installed chain and its measured rejection fraction; an initial scene value cannot substitute for that evidence.",
  },
] as const;

export interface IPlaytestSetupSchemaEntry {
  description: string;
  kind: keyof NonNullable<IPlaytestScenario["setup"]>;
  requiredCapabilities: readonly PlaytestCapability[];
}

export const PLAYTEST_SETUP_REGISTRY: readonly IPlaytestSetupSchemaEntry[] = [
  {
    description: "Overrides the subject player-start position before input.",
    kind: "spawn",
    requiredCapabilities: ["entity.setup"],
  },
  {
    description: "Overrides the subject player-start aim before input.",
    kind: "aim",
    requiredCapabilities: ["entity.setup"],
  },
  {
    description: "Applies bounded transforms to registered entities before input.",
    kind: "entities",
    requiredCapabilities: ["entity.setup"],
  },
  {
    description: "Places named entities at explicit world transforms before input.",
    kind: "place",
    requiredCapabilities: ["entity.setup"],
  },
  {
    description: "Writes bounded JSON-safe application state before input.",
    kind: "resources",
    requiredCapabilities: ["runtime.resources"],
  },
] as const;

export function requiredPlaytestCapabilities(
  scenario: IPlaytestScenario,
  target?: string,
): PlaytestCapability[] {
  const required = new Set<PlaytestCapability>();
  if (scenario.startTick !== undefined) required.add("runtime.fixedStep");
  if (scenario.steps.some((step) => step.waitForResource !== undefined)) {
    required.add("runtime.resources");
  }
  if (scenario.steps.some((step) => step.kind !== "wait" && (step.press !== undefined || step.pointerPosition !== undefined || step.pointers !== undefined))) {
    required.add("browser.input");
  }
  // An aimAt step steers the subject through the bridge's setup channel.
  if (scenario.steps.some((step) => step.kind === "aimAt")) {
    required.add("entity.setup");
  }
  // The geometry request carries no registry entry, so its capability requirement is added here;
  // without it a bridge that never armed a capture would answer with no observation, silently.
  if (scenario.assert?.geometry !== undefined) {
    required.add("runtime.geometry");
  }
  if (scenario.artifacts?.screenshots !== false) {
    required.add("browser.screenshot");
  }
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    if (scenario.assert?.[entry.kind] !== undefined) {
      if (entry.kind === "diagnostics") {
        // Capability preflight and evaluation must use the same effective policy. In particular,
        // an omitted network field defaults on in a browser and is waived on a network-blind
        // native target; an explicit true remains required everywhere.
        const policy = resolveDiagnosticsPolicy(scenario.assert.diagnostics, target);
        if (policy.noConsoleErrors) required.add("browser.console");
        if (policy.noNetworkErrors) required.add(target === "desktop" ? "runtime.network" : "browser.network");
        if (policy.noRuntimeDiagnostics) required.add("runtime.diagnostics");
      } else {
        entry.requiredCapabilities.forEach((capability) => required.add(capability));
      }
    }
  }
  if (target === "desktop" && resolveDiagnosticsPolicy(scenario.assert?.diagnostics, target).noNetworkErrors) required.add("runtime.network");
  for (const entry of PLAYTEST_SETUP_REGISTRY) {
    if (scenario.setup?.[entry.kind] !== undefined) {
      entry.requiredCapabilities.forEach((capability) => required.add(capability));
    }
  }
  return [...required].sort();
}
