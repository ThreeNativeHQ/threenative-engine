import type { Object3D } from "three";

/** How long `warmUnculled` keeps a subtree drawing whole. */
export interface IWarmUnculledOptions {
  /** World draws to spend once `when` holds before the subtree is culled again. Default 2. */
  readonly draws?: number;
  /** Counts a draw only while this holds, such as "every tile around the spawn is resident". */
  readonly when?: () => boolean;
}

/**
 * Draw `root` with frustum culling off until it has drawn `draws` times, then cull it again and
 * resolve. A pipeline is built by its first real draw (a startup warm-up compiles a different pass),
 * so content the spawn view does not see — streamed tiles behind the player, a mirror that draws only
 * when its water does — builds its pipelines after the reveal and hitches the first frames that see
 * it. Join the promise to the loading curtain to build them behind it. Objects that join `root`
 * while it warms draw unculled too.
 *
 * @situation the first frames after the loading curtain hitch on pipeline builds for content behind the camera
 * @situation streamed terrain or a lake compiles its pipelines after the reveal
 * @constraint `ctx.beforeRender` runs on every world draw, also behind the curtain; join the promise to the curtain's hold
 * @example const warm = warmUnculled(ctx, lake.mesh); ctx.startup.hold("lake", () => warm);
 */
export function warmUnculled(
  ctx: { beforeRender(callback: () => void): void },
  root: Object3D,
  options: IWarmUnculledOptions = {},
): Promise<void> {
  const draws = options.draws ?? 2;
  if (!Number.isInteger(draws) || draws < 1)
    throw new Error(
      `TN_WARM_UNCULLED_INVALID: draws must be a positive integer, received ${draws}.`,
    );
  const when = options.when ?? (() => true);
  const cull = (culled: boolean): void =>
    root.traverse((object) => {
      object.frustumCulled = culled;
    });
  return new Promise((resolve) => {
    let counted = 0; // -1 once warm
    ctx.beforeRender(() => {
      if (counted < 0) return;
      cull(false);
      if (when()) counted += 1;
      if (counted <= draws) return;
      counted = -1;
      cull(true);
      resolve();
    });
  });
}
