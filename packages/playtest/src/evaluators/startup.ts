import type { IEvaluationContext } from "./context.js";

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
  if (assertion.steadyCover === true) emitSteadyCover(ctx);
}

/** Every frame before readiness matched the cover; no recorded frame fails as unobserved. */
function emitSteadyCover(ctx: IEvaluationContext): void {
  const cover = ctx.input.report.observations?.startup?.cover;
  const observed = cover !== undefined && cover.frames > 0;
  const pass = observed && cover.differing.length === 0;
  ctx.assertions.push({
    details: observed
      ? { differing: cover.differing.length, first: cover.differing.slice(0, 5), frames: cover.frames, reference: cover.reference }
      : { frames: cover?.frames ?? 0 },
    id: "startup.steadyCover",
    pass,
  });
  if (pass) return;
  const first = cover?.differing[0];
  ctx.diagnostics.push({
    code: observed ? "TN_PLAYTEST_STARTUP_COVER_BROKEN" : "TN_PLAYTEST_STARTUP_COVER_UNOBSERVED",
    message: observed && first !== undefined
      ? `${cover.differing.length} of ${cover.frames} frames before readiness differ from the loading cover (mean rgb ${cover.reference.join(",")}); the first at ${first.ms} ms has mean rgb ${first.mean.join(",")}.`
      : "No frame presented before readiness was recorded: the browser runner records them only on the browser target, and only when the runtime stamps readyMs.",
    observedRuntimePath: "observations.json/startup/cover",
    severity: "error",
    suggestion: observed
      ? "Paint the cover on every frame the page presents before readiness: the page background in the cover's colour, and a repaint after any draw made outside the frame loop."
      : "Run the scenario on the browser target with the playtest bridge installed before startup.",
  });
}
