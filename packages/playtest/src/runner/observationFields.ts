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
 */
export const HOST_PLAYTEST_OBSERVATION_FIELDS = ["deviceLifecycle", "deviceMetrics", "tone"] as const;
