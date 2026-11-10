// The behaviour half of the assertion registry (PRD-835). `PLAYTEST_ASSERTION_REGISTRY` is the data:
// kind, fields, observation path, lanes. This table binds each kind to the two functions that act on
// it, and `Record<AssertionKind, ...>` makes a kind with no row a compile error, so adding a kind is
// one registry entry plus one row here. It is separate from the registry because the registry is
// imported by the generator script and by most of the package, and attaching these functions to it
// would make it import the validators and the evaluators, which import it back.
import type { IPlaytestAssertionSchemaEntry } from "./assertion-schema.js";
import type { IEvaluationContext } from "./evaluators/context.js";
import { emitCausedBy } from "./evaluators/caused-by.js";
import { emitDeviceMetrics } from "./evaluators/device-metrics.js";
import { emitEngineCost } from "./evaluators/engine-cost.js";
import { emitEvidenceFamilies } from "./evaluators/evidence-families.js";
import { emitFootSlip } from "./evaluators/foot-slip.js";
import { emitFramebufferCoverage } from "./evaluators/framebuffer-coverage.js";
import { emitGeometry } from "./evaluators/geometry.js";
import { emitHudAudit } from "./evaluators/hud-audit.js";
import { emitMovementEvidence } from "./evaluators/movement-evidence.js";
import { emitParity } from "./evaluators/parity-evidence.js";
import { emitPerfSignalsWorld } from "./evaluators/perf-signals-world.js";
import { emitPipelineCensus } from "./evaluators/pipeline-census.js";
import { emitRenderChain } from "./evaluators/render-chain.js";
import { emitScene } from "./evaluators/scene.js";
import { emitSceneNodes } from "./evaluators/scene-nodes.js";
import { emitSightLine } from "./evaluators/sight-line.js";
import { emitStartup } from "./evaluators/startup.js";
import { emitTone } from "./evaluators/tone.js";
import { emitWorldGameplay } from "./evaluators/world-gameplay.js";
import {
  validateAnimationAssertion,
  validateCausedByAssertion,
  validateContactAssertion,
  validateDeviceMetricsAssertion,
  validateEngineCostAssertion,
  validateFootSlipAssertion,
  validateFramebufferCoverageAssertion,
  validateHudAuditAssertion,
  validateParityAssertion,
  validatePathAssertion,
  validatePerformanceAssertion,
  validatePipelineCensusAssertion,
  validateRenderChainAssertion,
  validateResourcePathAssertion,
  validateSceneAssertion,
  validateSceneNodesAssertion,
  validateSightLineAssertion,
  validateSignalAssertion,
  validateStartupAssertion,
  validateStateAssertion,
  validateTagCountAssertion,
  validateVisibilityAssertion,
  validateVisualAssertion,
} from "./scenario/schema-accessors.js";
import {
  validateAerodynamicsAssertion,
  validateAudioAssertion,
  validateCameraAssertion,
  validateComponentAssertion,
  validateDiagnosticsAssertion,
  validateGeometryCaptureRequest,
  validateMovementAssertion,
  validateSettledAssertion,
  validateToneAssertion,
  validateWorldAssertion,
} from "./scenario/schema-validate.js";

export type AssertionKind = IPlaytestAssertionSchemaEntry["kind"];
export type AssertionEmitter = (ctx: IEvaluationContext) => void;

export interface IAssertionBinding {
  /**
   * The rich evaluator that emits this kind's results. Several kinds share one emitter, and the
   * emitters run once each in row order. `undefined`: the base report evaluates it
   * (`assertionEvaluatedByBaseProbe`, `runner/camera.ts`), not the rich list.
   */
  evaluate: AssertionEmitter | undefined;
  /** A kind that must not be declared empty: the noun in "must contain at least one X assertion". */
  nonEmpty?: string;
  /** Validates one entry (array kinds) or the whole value (object kinds); returns the typed result. */
  validate: (value: never, scenarioPath: string, objectPath: string) => unknown;
}

// Row order is evaluation order: the emitters below run first-row-first, each once.
export const ASSERTION_BINDINGS: Readonly<Record<AssertionKind, IAssertionBinding>> = {
  tone: { evaluate: emitTone, nonEmpty: "tone", validate: validateToneAssertion },
  deviceMetrics: { evaluate: emitDeviceMetrics, validate: validateDeviceMetricsAssertion },
  framebufferCoverage: { evaluate: emitFramebufferCoverage, validate: validateFramebufferCoverageAssertion },
  visual: { evaluate: emitEvidenceFamilies, validate: validateVisualAssertion },
  parity: { evaluate: emitParity, validate: validateParityAssertion },
  performance: { evaluate: emitPerfSignalsWorld, validate: validatePerformanceAssertion },
  world: { evaluate: emitPerfSignalsWorld, validate: validateWorldAssertion },
  signals: { evaluate: emitPerfSignalsWorld, nonEmpty: "signal", validate: validateSignalAssertion },
  resources: { evaluate: emitPerfSignalsWorld, validate: validateResourcePathAssertion },
  audio: { evaluate: emitPerfSignalsWorld, validate: validateAudioAssertion },
  components: { evaluate: emitWorldGameplay, validate: validateComponentAssertion },
  tags: { evaluate: emitWorldGameplay, validate: validateTagCountAssertion },
  states: { evaluate: emitWorldGameplay, validate: validateStateAssertion },
  hud: { evaluate: emitWorldGameplay, validate: validatePathAssertion },
  aerodynamics: { evaluate: emitWorldGameplay, validate: validateAerodynamicsAssertion },
  renderChain: { evaluate: emitRenderChain, validate: validateRenderChainAssertion },
  pipelineCensus: { evaluate: emitPipelineCensus, validate: validatePipelineCensusAssertion },
  scene: { evaluate: emitScene, validate: validateSceneAssertion },
  sceneNodes: { evaluate: emitSceneNodes, validate: validateSceneNodesAssertion },
  footSlip: { evaluate: emitFootSlip, nonEmpty: "foot-slip", validate: validateFootSlipAssertion },
  sightLine: { evaluate: emitSightLine, validate: validateSightLineAssertion },
  hudAudit: { evaluate: emitHudAudit, validate: validateHudAuditAssertion },
  engineCost: { evaluate: emitEngineCost, validate: validateEngineCostAssertion },
  geometry: { evaluate: emitGeometry, validate: validateGeometryCaptureRequest },
  causedBy: { evaluate: emitCausedBy, validate: validateCausedByAssertion },
  startup: { evaluate: emitStartup, validate: validateStartupAssertion },
  movement: { evaluate: emitMovementEvidence, validate: validateMovementAssertion },
  visibility: { evaluate: emitMovementEvidence, validate: validateVisibilityAssertion },
  settled: { evaluate: emitMovementEvidence, validate: validateSettledAssertion },
  diagnostics: { evaluate: emitMovementEvidence, validate: validateDiagnosticsAssertion },
  contacts: { evaluate: emitMovementEvidence, validate: validateContactAssertion },
  animation: { evaluate: emitMovementEvidence, validate: validateAnimationAssertion },
  camera: { evaluate: undefined, validate: validateCameraAssertion },
};

/** Each rich emitter once, in first-row order. */
export const ASSERTION_EMITTERS: readonly AssertionEmitter[] = [
  ...new Set(Object.values(ASSERTION_BINDINGS).flatMap(({ evaluate }) => (evaluate === undefined ? [] : [evaluate]))),
];
