// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import type { IEvaluationContext } from "./context.js";

export function emitFramebufferCoverage(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  if (scenarioAssertions.framebufferCoverage !== undefined) {
    const observation = input.report.observations?.framebufferCoverage;
    const started = observation?.windowStarted === true;
    const completed = observation?.windowCompleted === true;
    const framesObserved = (observation?.frameCount ?? 0) > 0;
    const readable = observation?.unreadableReason === undefined;
    const violation = observation?.firstViolation;
    const evidenceComplete = violation === undefined
      || (violation.grid.samples.length
        === violation.grid.columns * violation.grid.rows
        && violation.screenshotPath.length > 0);
    const pass = started
      && completed
      && framesObserved
      && readable
      && violation === undefined
      && evidenceComplete;
    assertions.push({
      details: {
        boundarySource: observation?.boundarySource ?? null,
        evidenceComplete,
        firstViolation: violation ?? null,
        frameCount: observation?.frameCount ?? 0,
        unreadableReason: observation?.unreadableReason ?? null,
        windowCompleted: completed,
        windowStarted: started,
      },
      id: "framebufferCoverage",
      pass,
    });
    if (!readable) {
      diagnostics.push({
        code: "TN_PLAYTEST_FRAMEBUFFER_PIXELS_UNREADABLE",
        message: `Framebuffer pixels could not be read: ${observation?.unreadableReason}.`,
        severity: "error",
        suggestion: "On headless Linux, prefix the command with sh scripts/xvfb.sh.",
      });
    } else if (!started || !completed) {
      diagnostics.push({
        code: "TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED",
        message: !started
          ? "The run never reached the declared framebuffer coverage window."
          : "The run entered but never completed the declared framebuffer coverage window.",
        severity: "error",
        suggestion: "Check the assertion's startStep/endStep labels and keep the run alive through the complete loading interval.",
      });
    } else if (!framesObserved) {
      diagnostics.push({
        code: "TN_PLAYTEST_FRAMEBUFFER_FRAMES_MISSING",
        message: "The framebuffer coverage window completed without observing any render frames.",
        severity: "error",
        suggestion: "Keep at least one requestAnimationFrame-driven frame inside the labeled loading window.",
      });
    } else if (violation !== undefined) {
      diagnostics.push({
        artifactPath: violation.screenshotPath,
        code: evidenceComplete
          ? "TN_PLAYTEST_FRAMEBUFFER_COVERAGE_FAILED"
          : "TN_PLAYTEST_FRAMEBUFFER_EVIDENCE_MISSING",
        message: evidenceComplete
          ? `Framebuffer coverage first diverged from the declared backdrop at frame ${violation.frameIndex}.`
          : `Framebuffer coverage diverged at frame ${violation.frameIndex}, but its grid or screenshot evidence is incomplete.`,
        observedRuntimePath: "observations.json/framebufferCoverage/firstViolation/grid",
        severity: "error",
        suggestion: "Inspect the violating-frame screenshot and RGB sample grid; fix the render pass that drew during the loading-covered window.",
      });
    }
  }
}
