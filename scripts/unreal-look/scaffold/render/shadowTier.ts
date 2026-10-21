// The shadow tier at run time (PRD-652): the tier names the filter taps a game starts at (`shadowPreset`),
// and `ShadowFilterBudget` moves it when the frame stays over its period. The engine measures and decides
// when; this file says what each tier draws and applies a step.
import { ShadowFilterBudget, type ShadowFilterTier } from "@threenative/core";
import { GI_STAGES } from "./giTier.js";

interface IShadowScene {
  readonly renderer: { readonly raw: unknown };
  readonly beforeRender: (callback: () => void) => () => void;
}

/**
 * Watches the frame time of a scene and applies a step to its lights. The scene fixes the tier (`explicit`)
 * unless the URL asks for `shadowAuto=1`: a capture must draw the tier it names, and a perf run must be free
 * to move. The gather's GPU time is left out of the frame, because the GI watcher answers for it.
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
    excludeStages: GI_STAGES,
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
