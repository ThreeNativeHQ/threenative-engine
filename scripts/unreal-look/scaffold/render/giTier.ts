// The GI tier at run time (PRD-644): the tier names the method a game runs (`giPreset`), and it holds
// that method as Unreal's Lumen holds its scalability level. `GIBudget` reports the GI share of the GPU
// frame against the frame period. A frame over its period gets cheaper through the primary resolution
// scale, and the GI pass follows the lower resolution.
import { GIBudget } from "@threenative/core";
import type { FinalGatherMethod } from "./quality.js";

/** The passes three names for the screen-space gather. Its denoise passes carry the gather's label. */
export const GI_STAGES = ["SSGI"];

interface IGiScene {
  readonly renderer: { readonly raw: unknown };
  readonly beforeRender: (callback: () => void) => () => void;
}

/** Watches the GI cost of a scene and reports it against the frame period. It never changes the method. */
export function watchGi(
  scene: IGiScene,
  options: {
    readonly tier: string;
    readonly method: FinalGatherMethod;
    /** The harness lane holds a 60 Hz period; a game passes its own display target. */
    readonly framePeriodMs?: number;
  },
): GIBudget {
  const gi = new GIBudget({
    framePeriodMs: options.framePeriodMs ?? 1000 / 60,
    method: options.method,
    stages: GI_STAGES,
    tier: options.tier,
  });
  scene.beforeRender(() => {
    gi.observeRenderer(scene.renderer.raw);
  });
  return gi;
}
