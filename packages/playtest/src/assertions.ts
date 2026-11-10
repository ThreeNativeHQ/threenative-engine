/**
 * Compatibility facade for the assertion module split (P2-3).
 *
 * The monolith that lived here now reads, in dependency order:
 * - `assertion-schema.ts` — the assertion/setup registries and capability preflight;
 * - `assertion-report.ts` — result/diagnostic types, policy resolution and shared serializers;
 * - `assertion-evaluators.ts` — family dispatch and evaluation.
 *
 * Every name this module exported before the split is re-exported unchanged; existing importers
 * (`scenario.ts`, `report.ts`, the public entry) keep working without edits.
 */
export {
  PLAYTEST_ASSERTION_REGISTRY,
  PLAYTEST_SETUP_REGISTRY,
  requiredPlaytestCapabilities,
} from "./assertion-schema.js";
export type {
  IPlaytestAssertionSchemaEntry,
  IPlaytestAssertionSchemaField,
  IPlaytestSetupSchemaEntry,
} from "./assertion-schema.js";
export { evaluateRichPlaytestAssertions } from "./assertion-evaluators.js";
export { resolveDiagnosticsPolicy } from "./assertion-report.js";
export type {
  IPlaytestAssertionResult,
  IPlaytestDiagnostic,
  IPlaytestFramebufferCoverageObservation,
  IPlaytestVisualElementRegionObservation,
  IPlaytestObservations,
} from "./assertion-report.js";
