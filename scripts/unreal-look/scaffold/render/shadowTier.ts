// The shadow tier at run time (PRD-652): the tier names the filter taps a game starts at (`shadowPreset`),
// and `ShadowFilterBudget` moves it when the whole GPU frame stays over the frame period (Unreal's
// DynamicRenderScaling rule). The engine measures and decides when; this file applies a step.
import { ShadowFilterBudget, type ShadowFilterTier } from "@threenative/core";

interface IShadowScene {
  readonly renderer: { readonly raw: unknown };
  readonly beforeRender: (callback: () => void) => () => void;
}

/**
 * Watches the frame time of a scene and applies a step to its lights. The scene fixes the tier (`explicit`)
 * unless the URL asks for `shadowAuto=1`: a capture must draw the tier it names, and a perf run must be free
 * to move. The tier steps only when the shadow passes could absorb the frame's overage, so a frame the gather or
 * the post chain made slow keeps its shadows (PRD-652 `## Decisions`).
 */
export function watchShadowTier(
  scene: IShadowScene,
  options: {
    readonly tier: ShadowFilterTier;
    readonly apply: (tier: ShadowFilterTier) => void;
    /** The harness lane holds a 60 Hz period; a game passes its own display target. */
    readonly framePeriodMs?: number;
  },
): ShadowFilterBudget {
  const auto = new URLSearchParams(location.search).get("shadowAuto") === "1";
  const budget = new ShadowFilterBudget({
    explicit: !auto,
    framePeriodMs: options.framePeriodMs ?? 1000 / 60,
    onStep: (tier) => options.apply(tier),
    tier: options.tier,
  });
  scene.beforeRender(() => {
    budget.observeRenderer(scene.renderer.raw);
  });
  return budget;
}
