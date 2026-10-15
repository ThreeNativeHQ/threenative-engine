import { parsePipelineCapture, summarizePipelineCapture } from "../runner/pipeline-summary.js";
import type { IEvaluationContext } from "./context.js";

/** Evaluate post-warm-up pipeline work only when the capture proves its boundary and completeness. */
export function emitPipelineCensus(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.pipelineCensus;
  if (assertion === undefined) return;

  let capture: ReturnType<typeof parsePipelineCapture> | undefined;
  let summary: ReturnType<typeof summarizePipelineCapture> | undefined;
  let parseError: string | undefined;
  try {
    capture = parsePipelineCapture({
      observations: { pipelineCensus: ctx.input.report.observations?.pipelineCensus },
    });
    summary = summarizePipelineCapture(capture);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const boundary = capture?.warmUpSettled;
  const nodeBuilds = summary?.warmup.warmedNodeBuildsAfterWarmUpSettled;
  const renderPipelineCreations = summary?.warmup.warmedRenderPipelineCreationsAfterWarmUpSettled;
  const scopeLabel = assertion.warmUpScope;
  const scope = scopeLabel === undefined
    ? undefined
    : summary?.warmup.scopes.find(({ label }) => label === scopeLabel);
  const boundaryUsable = capture?.complete === true && boundary !== undefined;
  const usable = boundaryUsable
    && nodeBuilds !== undefined
    && renderPipelineCreations !== undefined;
  const unobservable = parseError
    ?? (boundary === undefined
      ? "the capture has no warm-up-settled boundary"
      : capture?.complete !== true
        ? `the capture is incomplete: ${capture?.incompleteReasons.join("; ") ?? "unknown reason"}`
        : nodeBuilds === undefined
          ? "the capture has no per-material warm-up node-build count"
          : "the capture has no per-material post-warm-up render-pipeline count");

  const checks = [
    ["maxNodeBuildsAfterWarmUpSettled", nodeBuilds, "node builds"] as const,
    ["maxRenderPipelineCreationsAfterWarmUpSettled", renderPipelineCreations, "render-pipeline creations"] as const,
  ];
  if (assertion.maxNodeBuildsAfterWarmUpScope !== undefined || assertion.maxRenderPipelineCreationsAfterWarmUpScope !== undefined) {
    const scopedUsable = capture?.complete === true && scope?.observed === true;
    const scopedChecks = [
      ["maxNodeBuildsAfterWarmUpScope", scope?.nodeBuilds, "node builds"] as const,
      ["maxRenderPipelineCreationsAfterWarmUpScope", scope?.renderPipelineCreations, "render-pipeline creations"] as const,
    ];
    for (const [key, observed, label] of scopedChecks) {
      const expected = assertion[key];
      if (expected === undefined) continue;
      const pass = scopedUsable && observed !== undefined && observed <= expected;
      const id = `pipelineCensus.${key}`;
      ctx.assertions.push({ details: { boundary, complete: capture?.complete, expected, incompleteReasons: capture?.incompleteReasons, observed, scope: scopeLabel }, id, pass });
      if (!pass)
        ctx.diagnostics.push({
          code: scopedUsable ? "TN_PLAYTEST_PIPELINE_CENSUS_CEILING_EXCEEDED" : "TN_PLAYTEST_PIPELINE_CENSUS_UNOBSERVABLE",
          message: scopedUsable
            ? `The pipeline census observed ${observed} ${label} after warm-up scope '${scopeLabel}', above the asserted ceiling of ${expected}.`
            : `The pipeline census cannot evaluate '${id}': ${scopeLabel === undefined ? "the assertion has no warm-up scope label" : `scope '${scopeLabel}' is absent or incomplete`}.`,
          observedRuntimePath: "observations.json/pipelineCensus",
          severity: "error",
          suggestion: scopedUsable ? "Move the affected first-use pipeline work into the streamed warm-up and verify the scoped census again." : "Run with runtime.pipelineCensus enabled and keep the named warm-up scope in the report.",
        });
    }
  }
  for (const [key, observed, label] of checks) {
    const expected = assertion[key];
    if (expected === undefined) continue;
    const pass = usable && observed !== undefined && observed <= expected;
    const id = `pipelineCensus.${key}`;
    ctx.assertions.push({
      details: {
        boundary,
        complete: capture?.complete,
        expected,
        incompleteReasons: capture?.incompleteReasons,
        observed,
      },
      id,
      pass,
    });
    if (pass) continue;
    ctx.diagnostics.push({
      code: usable ? "TN_PLAYTEST_PIPELINE_CENSUS_CEILING_EXCEEDED" : "TN_PLAYTEST_PIPELINE_CENSUS_UNOBSERVABLE",
      message: usable
        ? `The pipeline census observed ${observed} ${label} after warm-up settled, above the asserted ceiling of ${expected}.`
        : `The pipeline census cannot evaluate '${id}': ${unobservable}.`,
      observedRuntimePath: "observations.json/pipelineCensus",
      severity: "error",
      suggestion: usable
        ? "Move the affected first-use pipeline work into the explicit warm-up and verify the post-warm-up census again."
        : "Run with runtime.pipelineCensus enabled and keep the warm-up-settled boundary and complete capture in the report.",
    });
  }
}
