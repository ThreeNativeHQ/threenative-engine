import { PLAYTEST_ASSERTION_REGISTRY } from "../assertion-schema.js";

export const STANDALONE_PLAYTEST_OBSERVATION_FIELDS = [
  "components",
  "componentSeries",
  "console",
  "effectLogBefore",
  "framebufferCoverage",
  "geometry",
  "hud",
  "network",
  "physicsDebugSeries",
  "performanceSeries",
  "pipelineCensus",
  "renderChain",
  "physicsDebugBefore",
  "resources",
  "resourceSeries",
  "runtimeDiagnostics",
  "runtimeDiagnosticsBefore",
  "runtimeObservations",
  "scene",
  "sceneNodes",
  "signals",
  "signalSeries",
  "startup",
  "visual",
] as const;

/**
 * Observations the *host* measures about the device rather than the game measuring about itself.
 * The bridge is not their producer, so the standalone-runner availability check must not judge
 * them; the evaluator fails closed and names the target that supplies them instead.
 *
 * The registry names them: an entry with `observationSource: "host"` puts its path here.
 * `deviceLifecycle` is no assertion kind, so it is listed by hand.
 */
export const HOST_PLAYTEST_OBSERVATION_FIELDS: readonly string[] = [
  "deviceLifecycle",
  ...PLAYTEST_ASSERTION_REGISTRY.filter(({ observationSource }) => observationSource === "host").map(
    ({ observationPath }) => observationPath,
  ),
];

/**
 * The registry entries whose observation no runner produces. Such a kind passes the schema, the
 * docs and the evaluator and then fails every scenario that declares it, which is how `startup`
 * shipped and how `occluded`, `overlayNodes` and `reachability` stayed until PRD-835 removed them.
 * `scripts/generate-assertion-validators.ts` throws on a non-empty answer.
 */
export function unproducedAssertionKinds(
  entries: readonly { kind: string; observationPath: string }[] = PLAYTEST_ASSERTION_REGISTRY,
): string[] {
  const produced = new Set<string>([...STANDALONE_PLAYTEST_OBSERVATION_FIELDS, ...HOST_PLAYTEST_OBSERVATION_FIELDS]);
  return entries.filter(({ observationPath }) => !produced.has(observationPath)).map(({ kind, observationPath }) => `${kind} -> ${observationPath}`);
}
