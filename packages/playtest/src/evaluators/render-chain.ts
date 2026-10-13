import type {
  IPlaytestRenderChainAssertion,
  IPlaytestRenderChainExpectation,
  PlaytestAdapterClass,
} from "../scenario/schema-base.js";
import type { IEvaluationContext } from "./context.js";
import { type IAdapterClassification, classifyAdapter } from "./adapter-class.js";

export function emitRenderChain(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.renderChain;
  if (assertion === undefined) return;
  const observed = ctx.input.report.observations?.renderChain;
  const selected = selectExpectation(ctx, assertion);
  const expected = selected.expectation;

  if (expected.tier !== undefined) {
    const pass = observed?.tier === expected.tier;
    ctx.assertions.push({
      details: { ...selected.provenance, expected: expected.tier, observed: observed?.tier },
      id: "renderChain.tier",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: observed === undefined
          ? "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE"
          : "TN_PLAYTEST_RENDER_CHAIN_TIER_FAILED",
        message: observed === undefined
          ? "Render-chain tier was not observed because the TN_RENDER_CHAIN marker was absent."
          : `Render-chain tier '${observed.tier}' did not match the asserted tier '${expected.tier}'.`,
        observedRuntimePath: "observations.json/renderChain/tier",
        severity: "error",
        suggestion: "Install the RenderChain through the renderer seam and keep its marker callback connected to the playtest bridge.",
      });
    }
  }

  const stageAssertion = expected.stages;
  if (stageAssertion !== undefined) {
    const observedStages = observed?.stages;
    if (stageAssertion.includes !== undefined) {
      emitStageCheck(
        ctx,
        selected.provenance,
        observedStages,
        "includes",
        stageAssertion.includes,
        observedStages !== undefined && stageAssertion.includes.every((stage) => observedStages.includes(stage)),
      );
    }
    if (stageAssertion.excludes !== undefined) {
      emitStageCheck(
        ctx,
        selected.provenance,
        observedStages,
        "excludes",
        stageAssertion.excludes,
        observedStages !== undefined && stageAssertion.excludes.every((stage) => !observedStages.includes(stage)),
      );
    }
    if (stageAssertion.order !== undefined) {
      emitStageCheck(
        ctx,
        selected.provenance,
        observedStages,
        "order",
        stageAssertion.order,
        observedStages !== undefined && isOrderedSubsequence(stageAssertion.order, observedStages),
      );
    }
  }

  const contributionAssertion = expected.contributions;
  if (contributionAssertion !== undefined) {
    const observedContributions = observed?.contributions;
    const pass = Array.isArray(observedContributions)
      && contributionAssertion.graphOutputChanged.every((name) =>
        observedContributions.some((entry) => entry.name === name && entry.graphOutputChanged === true),
      );
    ctx.assertions.push({
      details: {
        ...selected.provenance,
        expected: contributionAssertion.graphOutputChanged,
        observed: observedContributions,
      },
      id: "renderChain.contributions.graphOutputChanged",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: observed === undefined || observedContributions === undefined
          ? "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE"
          : "TN_PLAYTEST_RENDER_CHAIN_CONTRIBUTIONS_FAILED",
        message: observed === undefined
          ? "Render-chain contributions were not observed because the TN_RENDER_CHAIN marker was absent."
          : observedContributions === undefined
            ? "Render-chain stage contributions were not observed on the TN_RENDER_CHAIN marker."
            : "One or more authored stages did not report a changed graph output.",
        observedRuntimePath: "observations.json/renderChain/contributions",
        severity: "error",
        suggestion: "Publish one graphOutputChanged marker per applied stage; this is graph evidence, not pixel attribution.",
      });
    }
  }

  if (expected.velocity !== undefined) {
    const rejectionFraction = observed?.velocity.rejectionFraction;
    const measurementFrame = observed?.velocity.measurementFrame;
    const hasMeasurement = rejectionFraction !== undefined
      && Number.isFinite(rejectionFraction)
      && typeof measurementFrame === "number"
      && Number.isInteger(measurementFrame)
      && measurementFrame >= 0;
    const pass = hasMeasurement
      && rejectionFraction !== undefined
      && rejectionFraction <= expected.velocity.maxRejectionFraction;
    ctx.assertions.push({
      details: {
        ...selected.provenance,
        expected: expected.velocity.maxRejectionFraction,
        measurementFrame,
        observed: rejectionFraction,
      },
      id: "renderChain.velocity.rejectionFraction",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: observed === undefined || !hasMeasurement
          ? "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE"
          : "TN_PLAYTEST_RENDER_CHAIN_REJECTION_FAILED",
        message: observed === undefined
          ? "Render-chain velocity rejection was not observed because the TN_RENDER_CHAIN marker was absent."
          : !hasMeasurement
            ? "Render-chain velocity was provisioned without a fresh completed-frame history-rejection measurement."
            : `Render-chain history rejection fraction ${rejectionFraction ?? "missing"} exceeded the asserted ceiling ${expected.velocity.maxRejectionFraction}.`,
        observedRuntimePath: "observations.json/renderChain/velocity/rejectionFraction",
        severity: "error",
        suggestion: "Publish the temporal stage's measured rejection fraction on the same render-chain marker used for tier reporting.",
      });
    }
  }

  // A scenario that chose a policy per adapter class asked a question this run cannot answer when
  // the adapter named itself in no known field, and the branches above each failed on their own
  // terms against the flat fallback. This names the missing observation once. A scenario with no
  // `perAdapter` made no such choice — its flat expectation was always the expectation — so it is
  // not failed here.
  if (assertion.perAdapter !== undefined && selected.classification === undefined) {
    ctx.assertions.push({
      details: { ...selected.provenance, expected: Object.keys(assertion.perAdapter) },
      id: "renderChain.adapterClass",
      pass: false,
    });
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_RENDER_CHAIN_ADAPTER_UNCLASSIFIED",
      message: "No adapter.info field named a software rasteriser, so this run is not proven to be either adapter class and was held to the flat render-chain expectation.",
      observedRuntimePath: "observations.json/capture/adapter",
      severity: "error",
      suggestion: "Run on a lane that reports adapter.info, or drop perAdapter and assert one policy for every adapter.",
    });
  }
}

interface ISelectedExpectation {
  /** The independently observed adapter class; `provenance.gpuFamily` names a proven family. */
  readonly classification: PlaytestAdapterClass | undefined;
  readonly expectation: IPlaytestRenderChainExpectation;
  /** Independent of the game: what the harness read out of `adapter.info` itself. */
  readonly provenance: IAdapterClassification;
}

/**
 * Which policy this run is held to.
 *
 * The class comes from the harness's own `adapter.info` reading, never from the tier the game
 * chose — a game that answered `low` on a hardware adapter is a defect, and selecting its
 * expectation from its own answer would hide exactly that. A `perAdapter` branch replaces the flat
 * expectation for the classified class and for nothing else; an unclassified adapter falls back to
 * the flat form and is failed by the `renderChain.adapterClass` row beside it.
 */
function selectExpectation(ctx: IEvaluationContext, assertion: IPlaytestRenderChainAssertion): ISelectedExpectation {
  const flat: IPlaytestRenderChainExpectation = {
    ...(assertion.tier === undefined ? {} : { tier: assertion.tier }),
    ...(assertion.stages === undefined ? {} : { stages: assertion.stages }),
    ...(assertion.contributions === undefined ? {} : { contributions: assertion.contributions }),
    ...(assertion.velocity === undefined ? {} : { velocity: assertion.velocity }),
  };
  const provenance = classifyAdapter(ctx.input.report);
  const { adapterClass, gpuFamily } = provenance;
  // A family row beats the generic class row only for the family the observed fields proved; with no
  // proven family, or no row for it, the `hardware` / `software` selection is exactly what it was.
  const branch =
    adapterClass === undefined
      ? undefined
      : ((gpuFamily === undefined ? undefined : assertion.perAdapter?.[gpuFamily]) ??
        assertion.perAdapter?.[adapterClass]);
  return {
    classification: adapterClass,
    expectation: branch ?? flat,
    provenance,
  };
}

function emitStageCheck(
  ctx: IEvaluationContext,
  provenance: ISelectedExpectation["provenance"],
  observed: string[] | undefined,
  kind: "includes" | "excludes" | "order",
  expected: string[],
  pass: boolean,
): void {
  ctx.assertions.push({
    details: { ...provenance, expected, observed },
    id: `renderChain.stages.${kind}`,
    pass,
  });
  if (pass) return;
  ctx.diagnostics.push({
    code: observed === undefined
      ? "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE"
      : "TN_PLAYTEST_RENDER_CHAIN_STAGES_FAILED",
    message: observed === undefined
      ? "Render-chain stages were not observed because the TN_RENDER_CHAIN marker was absent."
      : `Render-chain stage ${kind} assertion did not match the observed stage order.`,
    observedRuntimePath: "observations.json/renderChain/stages",
    severity: "error",
    suggestion: "Keep each authored stage in the renderer chain and publish its id on TN_RENDER_CHAIN.",
  });
}

function isOrderedSubsequence(expected: string[], observed: string[]): boolean {
  let cursor = 0;
  for (const stage of expected) {
    const found = observed.indexOf(stage, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}
