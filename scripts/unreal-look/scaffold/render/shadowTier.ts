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

/**
 * The factor on the sun's angular radius that gives Unreal's penumbra. Unreal builds the disc of a shadow ray from
 * `cross(N, x)` and `cross(that, N)` and does not normalise them (`GetRandomDirectionalLightRayDir`,
 * UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionDirectional.ush:153-164), so the disc is
 * the source radius times the sine of the angle between the sun and Unreal's X axis. The harness X is Unreal's X
 * (`to_unreal`, tools/unreal-reference/build_level.py), so a sun at azimuth 90 and elevation 15 casts 0.26 of the
 * nominal penumbra, and a sun overhead casts all of it.
 */
export const unrealSunDiscScale = (sun: { readonly x: number }): number =>
  Math.sqrt(Math.max(0, 1 - sun.x * sun.x));
