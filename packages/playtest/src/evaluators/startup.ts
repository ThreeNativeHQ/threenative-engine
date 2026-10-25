import type { IEvaluationContext } from "./context.js";

const MB = 1_000_000;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Bytes the reveal waited for that the spawn camera does not show.
 *
 * The runtime measures it and decides whether it is a warning (most of the wait bought nothing on
 * screen); this only reports it. A run with no ceiling asserted still gets the warning, because the
 * game that needs it is the one that never wrote the assertion. A ceiling fails closed when the
 * runtime reported no measurement or could size nothing it awaited.
 */
function emitOffscreenBytes(ctx: IEvaluationContext): void {
  const ceiling = ctx.scenarioAssertions.startup?.maxOffscreenBytes;
  const observed = ctx.input.report.observations?.startup?.offscreenBytes;
  const unsized = observed !== undefined && observed.awaitedBytes === 0 && observed.unsizedFiles > 0;
  if (ceiling !== undefined) {
    const measured = observed !== undefined && !unsized;
    const pass = measured && observed.offscreenBytes <= ceiling;
    ctx.assertions.push({
      details: { expected: ceiling, observed: measured ? observed.offscreenBytes : undefined },
      id: "startup.offscreenBytes",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: measured ? "TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES" : "TN_PLAYTEST_STARTUP_UNOBSERVABLE",
        message: measured
          ? `The reveal waited for ${mb(observed.offscreenBytes)} the spawn camera does not show (${observed.top.map((file) => `${file.path} ${mb(file.bytes)} ${file.reason}`).join(", ")}), past the asserted ceiling of ${mb(ceiling)}.`
          : observed === undefined
            ? "Off-screen startup bytes were not observed: the runtime reported no measurement."
            : `Off-screen startup bytes were not observable: the runtime awaited ${observed.unsizedFiles} file(s) and the asset manifest records no size for any of them.`,
        observedRuntimePath: "observations.json/startup/offscreenBytes",
        severity: "error",
        suggestion: measured
          ? observed.fix
          : "Build the game's assets with the asset pipeline so the manifest records each file's bytes, and keep the playtest bridge installed before startup.",
      });
      return;
    }
  }
  if (observed?.warn !== true) return;
  ctx.diagnostics.push({
    code: "TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES",
    message: `Most of the reveal's wait bought nothing on screen: ${mb(observed.offscreenBytes)} of ${mb(observed.awaitedBytes)} awaited is not shown by the spawn camera (${observed.top.map((file) => `${file.path} ${mb(file.bytes)} ${file.reason}`).join(", ")}).`,
    observedRuntimePath: "observations.json/startup/offscreenBytes",
    severity: "warning",
    suggestion: observed.fix,
  });
}

const MILESTONES = {
  maxCompileSettledMs: "compileSettledMs",
  maxEnteredMs: "enteredMs",
  maxReadyMs: "readyMs",
} as const;

/**
 * Startup time as an observation: each asserted ceiling is checked against the milestone the
 * runtime stamped. A milestone the runtime never reached fails closed — a run that observed a
 * game which never entered its world cannot vouch for how fast it did.
 */
export function emitStartup(ctx: IEvaluationContext): void {
  emitOffscreenBytes(ctx);
  const assertion = ctx.scenarioAssertions.startup;
  if (assertion === undefined) return;
  const timeline = ctx.input.report.observations?.startup?.timeline;
  for (const [ceilingKey, milestone] of Object.entries(MILESTONES) as [keyof typeof MILESTONES, (typeof MILESTONES)[keyof typeof MILESTONES]][]) {
    const ceiling = assertion[ceilingKey];
    if (ceiling === undefined) continue;
    const observed = timeline?.[milestone];
    const pass = typeof observed === "number" && Number.isFinite(observed) && observed <= ceiling;
    ctx.assertions.push({
      details: { expected: ceiling, observed },
      id: `startup.${milestone}`,
      pass,
    });
    if (pass) continue;
    ctx.diagnostics.push({
      code: observed === undefined ? "TN_PLAYTEST_STARTUP_UNOBSERVABLE" : "TN_PLAYTEST_STARTUP_TOO_SLOW",
      message: observed === undefined
        ? `Startup milestone '${milestone}' was not observed: the runtime reported no timeline entry for it.`
        : `Startup milestone '${milestone}' happened at ${Math.round(observed)} ms, past the asserted ceiling of ${ceiling} ms.`,
      observedRuntimePath: `observations.json/startup/timeline/${milestone}`,
      severity: "error",
      suggestion: observed === undefined
        ? "Keep the playtest bridge installed before startup and let the game reach that milestone inside the run; a runtime without a startup timeline cannot satisfy this assertion."
        : "Move work out of the critical startup path — load detail after enter(), share textures across models, keep first-use compilation inside its budget — or raise the ceiling with the measurement that justifies it.",
    });
  }
}
