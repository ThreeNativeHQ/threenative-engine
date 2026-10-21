// The GI tier at run time (PRD-644): the tier names the method a game starts at (`giPreset`), and
// `GIBudget` moves it when the GPU time of the GI passes says the machine cannot hold it. The engine
// measures and decides when; this file says what each method costs and what a step does.
import { GIBudget } from "@threenative/core";
import type { FinalGatherMethod } from "./quality.js";

/**
 * GPU milliseconds each method may cost at 1920 x 1080 on the RTX 2080: Unreal 5.8.3's own GI time at the
 * matching `sg.GlobalIlluminationQuality`, read from `ProfileGPU` (PRD-644 `## Decisions`). PROVISIONAL until
 * that profile is recorded for Low and Medium: `screenProbeGather` is the top of Unreal Epic's measured
 * 3.09 to 5.79 ms (PRD-640 `## Decisions`), and `irradianceField` is a placeholder. Irradiance field gathers
 * inside the colour pass, so no named pass carries its cost: its budget is the whole GI share Unreal spends
 * at Medium, which the colour pass must leave room for.
 */
export const GI_BUDGET_MS: Readonly<Record<FinalGatherMethod, number>> = {
  irradianceField: 1.5,
  none: 0,
  screenProbeGather: 6,
};

/** The passes three names for the screen-space gather. Its denoise passes carry the gather's label. */
export const GI_STAGES = ["SSGI"];

interface IGiScene {
  readonly renderer: { readonly raw: unknown };
  readonly beforeRender: (callback: () => void) => () => void;
}

/**
 * Watches the GI cost of a scene and rebuilds its chain on a step. A method the scene baked a cache for
 * can step between `irradianceField` and `screenProbeGather`; a scene that started at `none` baked nothing
 * and holds. The scene fixes the method (`explicit`) unless the URL asks for `giAuto=1`: a capture must
 * draw the tier it names, and a perf run must be free to move.
 */
export function watchGi(
  scene: IGiScene,
  options: {
    readonly tier: string;
    readonly method: FinalGatherMethod;
    readonly rebuild: (method: FinalGatherMethod) => void;
    readonly frameBudgetMs?: number;
  },
): GIBudget {
  const auto = new URLSearchParams(location.search).get("giAuto") === "1";
  const gi = new GIBudget({
    budgetMs: GI_BUDGET_MS,
    explicit: !auto,
    method: options.method,
    methods: options.method === "none" ? ["none"] : ["irradianceField", "screenProbeGather"],
    onStep: (method) => options.rebuild(method),
    stages: GI_STAGES,
    tier: options.tier,
    ...(options.frameBudgetMs === undefined ? {} : { frameBudgetMs: options.frameBudgetMs }),
  });
  scene.beforeRender(() => {
    gi.observeRenderer(scene.renderer.raw);
  });
  return gi;
}
