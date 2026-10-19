export type { IToneMetrics, IPlaytestToneObservation } from "./tone.js";
/**
 * Validate and inspect playtest capability declarations.
 * @situation check whether a scenario's required capabilities are installed
 * @situation report unknown or missing playtest capabilities
 * @example const missing = missingPlaytestCapabilities(required, available);
 */
export {
  PLAYTEST_CAPABILITY_REGISTRY,
  missingPlaytestCapabilities,
  unknownPlaytestCapabilities,
} from "./capabilities.js";
/**
 * Evaluate rich semantic assertions against captured observations.
 * @situation assert movement, visibility, or diagnostics in a playtest
 * @situation turn a scenario observation into a pass or failure
 * @constraint malformed or empty assertions fail closed
 * @example const result = evaluateRichPlaytestAssertions(input);
 */
export {
  PLAYTEST_ASSERTION_REGISTRY,
  requiredPlaytestCapabilities,
} from "./assertion-schema.js";
/**
 * Evaluate rich semantic assertions against captured observations.
 * @situation assert movement, visibility, or diagnostics in a playtest
 * @situation turn a scenario observation into a pass or failure
 * @constraint malformed or empty assertions fail closed
 * @example const result = evaluateRichPlaytestAssertions(input);
 */
export { evaluateRichPlaytestAssertions } from "./assertion-evaluators.js";
/**
 * Resolve the effective diagnostics policy for a run, with fail-closed defaults applied.
 * @situation judge captured console, network, or runtime diagnostics for a playtest
 * @constraint absent policy fields default to rejecting errors
 * @example const policy = resolveDiagnosticsPolicy(scenario.assert?.diagnostics);
 */
export { resolveDiagnosticsPolicy } from "./assertion-report.js";
export type {
  IPlaytestAssertionResult,
  IPlaytestDiagnostic,
  IPlaytestFramebufferCoverageObservation,
  IPlaytestVisualElementRegionObservation,
  IPlaytestObservations,
} from "./assertion-report.js";
/**
 * Measure and judge device thermal, power and battery state around a device playtest run.
 * @situation find out whether an Android run was throttled or started hot
 * @situation read battery temperature, current draw or per-rail power for a run
 * @constraint a reading the device does not expose reports unavailable, never zero
 * @constraint a run that started hot or whose thermal status rose is flagged as confounded
 * @example const verdict = summarizeDeviceMetrics(observation.samples);
 */
export {
  DEVICE_METRICS_CADENCE_MS,
  DEVICE_METRICS_MAX_SAMPLES,
  DeviceMetricsError,
  DeviceMetricsRecorder,
  HOT_START_TEMPERATURE_C,
  parseDeviceBattery,
  parseDeviceCurrent,
  parseDevicePowerRails,
  parseDeviceThermal,
  summarizeDeviceMetrics,
} from "./runner/deviceMetrics.js";
export type {
  IPlaytestDeviceBattery,
  IPlaytestDeviceMetricsObservation,
  IPlaytestDeviceMetricsSample,
  IPlaytestDeviceMetricsVerdict,
  IPlaytestDeviceThermal,
  PlaytestDeviceMeasurement,
  PlaytestDevicePowerRails,
} from "./runner/deviceMetrics.js";
/**
 * Create a structured playtest diagnostic.
 * @situation report a named runtime diagnostic to a scenario
 * @situation explain why a playtest assertion cannot pass
 * @example playtestDiagnostic("TN_PLAYTEST_CAPABILITY_MISSING", "body missing", "register rapier() before adding bodies");
 */
export { playtestDiagnostic } from "./diagnostics.js";
export type { IPlaytestProtocolDiagnostic } from "./diagnostics.js";
/**
 * Validate JSON-safe bridge messages and protocol sizes.
 * @situation send a safe observation over the playtest bridge
 * @situation reject an oversized or cyclic playtest payload
 * @constraint bridge values must be JSON-shaped
 * @example assertJsonSafe({ score: 10 });
 */
export {
  PLAYTEST_BRIDGE_GLOBAL,
  PLAYTEST_FROZEN_MARKER,
  PLAYTEST_ADVANCE_TICK_BUDGET_MS,
  PLAYTEST_STARTUP_COMPILE_BUDGET_MS,
  PLAYTEST_FRAME_PASS_KINDS,
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  PLAYTEST_STARTUP_READY_TIMEOUT_MS,
  assertJsonSafe,
  jsonByteLength,
} from "./protocol.js";
export type {
  IPlaytestBridgeDescription,
  IPlaytestBridgeReady,
  IPlaytestBridgeV1,
  IPlaytestContactObservation,
  IPlaytestDeviceRequest,
  IPlaytestDeviceResponse,
  IPlaytestFramePassSample,
  IPlaytestGameplayObservation,
  IPlaytestObservationSnapshot,
  IPlaytestPerformanceObservation,
  IPlaytestRenderChainObservation,
  IPlaytestCameraObservation,
  IPlaytestFogObservation,
  IPlaytestLightObservation,
  IPlaytestRuntimeDiagnosticsSample,
  IPlaytestSampleRequest,
  IPlaytestSceneObservation,
  IPlaytestSetupConfirmation,
  IPlaytestSetupRequest,
  IPlaytestStartupObservation,
  IPlaytestStartupTimeline,
  IPlaytestStrideObservation,
  IPlaytestWorldObservation,
  IPlaytestWorldRuntimeObservation,
  JsonValue,
  PlaytestFramePassKind,
} from "./protocol.js";
// The replay wire protocol moved to @threenative/core (PRD-181); playtest no longer ships
// its own copy. Import it from `@threenative/core` if a harness needs the parser.
export type {
  IPlaytestCaptureProvenance,
  IPlaytestDiagnosticsPolicy,
  IPlaytestReport,
  IPlaytestSetupApplication,
  IPlaytestSetupRecord,
  IPlaytestTrivialityOptOut,
  PlaytestVec3,
} from "./report.js";
/**
 * Carry a structured scenario validation diagnostic as an error.
 * @situation catch a structured playtest scenario validation error
 * @constraint the diagnostic describes a failed load, not a successfully executed scenario
 * @example import { PlaytestScenarioError } from "@threenative/playtest";
 * const error = new PlaytestScenarioError({ code: "TN_PLAYTEST_SCENARIO_INVALID", message: "Invalid fixture", severity: "error", suggestion: "Fix the fixture" });
 */
export { PlaytestScenarioError } from "./scenario.js";
/**
 * Construct a named invalid-scenario error without loading or executing a scenario.
 * @situation construct a validation error for malformed scenario input
 * @constraint returns an error; the caller must throw it
 * @example import { invalidScenario } from "@threenative/playtest";
 * throw invalidScenario("smoke.playtest.json", "Expected a non-empty assertion set");
 */
export { invalidScenario } from "./scenario.js";
/**
 * Load and validate a scenario and its referenced evidence before running it.
 * @situation create a browser or device playtest scenario
 * @situation load a deterministic tick-based playtest scenario
 * @constraint unknown scenario keys and missing referenced evidence fail closed
 * @constraint loading validates the fixture; use the runner to execute it
 * @example import { loadPlaytestScenario } from "@threenative/playtest";
 * const scenario = await loadPlaytestScenario(process.cwd(), "playtests/smoke.playtest.json");
 */
export { loadPlaytestScenario } from "./scenario.js";
/**
 * Read a validated step's input-hold duration in simulation ticks.
 * @situation read the deterministic number of ticks to hold a playtest input
 * @constraint reads the duration only; the runner advances the simulation
 * @example import { playtestStepHoldTicks } from "@threenative/playtest";
 * const ticks = playtestStepHoldTicks({ kind: "input", press: "KeyW", holdTicks: 30, release: true });
 */
export { playtestStepHoldTicks } from "./scenario.js";
/**
 * Read a validated step's no-input duration in simulation ticks.
 * @situation wait or hold a game for a deterministic number of ticks
 * @constraint reads the wait duration only; the runner advances the simulation
 * @example import { playtestStepWaitTicks } from "@threenative/playtest";
 * const ticks = playtestStepWaitTicks({ kind: "wait", waitTicks: 30, release: true });
 */
export { playtestStepWaitTicks } from "./scenario.js";
/**
 * Reject object keys outside the explicitly allowed scenario fields.
 * @situation reject an unknown field while validating a scenario object
 * @constraint throws an invalid-scenario error on the first unknown key
 * @example import { rejectUnknownKeys } from "@threenative/playtest";
 * rejectUnknownKeys({ name: "smoke" }, ["name"], "smoke.playtest.json", "scenario");
 */
export { rejectUnknownKeys } from "./scenario.js";
export type {
  IPlaytestArtifactRequest,
  IPlaytestPathAssertion,
  IPlaytestFramebufferCoverageAssertion,
  IPlaytestPerformanceAssertion,
  IPlaytestRenderChainAssertion,
  IPlaytestStartupAssertion,
  IPlaytestPointer,
  IPlaytestResourceWait,
  IPlaytestScenario,
  IPlaytestSignalAssertion,
  IPlaytestStep,
  IPlaytestVisualAssertion,
  IPlaytestToneAssertion,
  IPlaytestVisualElementRegion,
  IPlaytestVisualRegion,
  IPlaytestVisualRegionBounds,
  IPlaytestVisualRegionTarget,
  IPlaytestMedia,
  IPlaytestWheel,
  IPlaytestWorldRuntimeAssertion,
} from "./scenario.js";
