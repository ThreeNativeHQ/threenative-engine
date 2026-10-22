// The shadow tier at run time (PRD-652): the tier names the filter taps a game starts at (`shadowPreset`),
// and `ShadowFilterBudget` moves it when the GPU time of the shadow passes stays over the tier's budget. The
// engine measures and decides when; this file says what each tier costs and applies a step.
import { ShadowFilterBudget, type ShadowFilterTier } from "@threenative/core";
import { shadowPreset } from "./quality.js";

interface IShadowScene {
  readonly renderer: { readonly raw: unknown };
  readonly beforeRender: (callback: () => void) => () => void;
}

/**
 * Watches the frame time of a scene and applies a step to its lights. The scene fixes the tier (`explicit`)
 * unless the URL asks for `shadowAuto=1`: a capture must draw the tier it names, and a perf run must be free
 * to move. Only the shadow passes' own GPU time moves the tier, so a frame the gather or the post chain made slow
 * keeps its shadows (PRD-652 `## Decisions`, 2026-10-22).
 */
export function watchShadowTier(
  scene: IShadowScene,
  options: {
    readonly tier: ShadowFilterTier;
    readonly apply: (tier: ShadowFilterTier) => void;
  },
): ShadowFilterBudget {
  const auto = new URLSearchParams(location.search).get("shadowAuto") === "1";
  const budget = new ShadowFilterBudget({
    budgetMs: {
      high: shadowPreset("high").budgetMs,
      low: shadowPreset("low").budgetMs,
      medium: shadowPreset("medium").budgetMs,
    },
    explicit: !auto,
    frameBudgetMs: 1000 / 60,
    onStep: (tier) => options.apply(tier),
    tier: options.tier,
  });
  scene.beforeRender(() => {
    budget.observeRenderer(scene.renderer.raw);
  });
  return budget;
}
