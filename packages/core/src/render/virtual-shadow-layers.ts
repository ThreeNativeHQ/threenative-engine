/**
 * The object layers a virtual shadow draws on, and the clip ladder its levels sit at.
 *
 * One owner for the numbers: the node renders the maps, `WorldCells` mints the casters on these
 * bits, and the chunk proxies stand in for merged geometry. A copy that drifts puts the world's
 * casters on a layer no level camera reads, and no error says so — the shadow is simply missing.
 */

/**
 * The object layer tracked casters are enabled on, so each level's mover camera sees only them.
 * Keep it free of other uses; the main camera never needs it (tracked objects keep layer 0).
 */
export const VIRTUAL_SHADOW_MOVER_LAYER = 29;
/**
 * The object layer a shadow-only caster is put on, so each level's own shadow camera renders it and
 * the main camera never sees it. The level cameras have it enabled already; an object that exists
 * only as a shadow caster calls `object.layers.set(VIRTUAL_SHADOW_CASTER_LAYER)`.
 */
// The layer a shadow-only object is put on: a level's own shadow camera renders it, the main
// camera never sees it. Three skips an object whose layers do not meet the camera's, and it
// overwrites a shadow camera's mask with the main camera's whenever that mask is layer 0 and
// nothing else — so enabling this bit on the level cameras is also what pins their mask, and a
// caster that lives only on it is reachable from the cascade and from nothing else. 28 is below the
// mover layer and off the main camera, which renders layer 0.
export const VIRTUAL_SHADOW_CASTER_LAYER = 28;
/**
 * The wide counterpart of {@link VIRTUAL_SHADOW_CASTER_LAYER}: one caster mesh per
 * `asset:level:part` holding every resident cell's records, for the levels whose window covers the
 * whole resident ring. A level renders exactly one of the two caster layers — whichever submits
 * fewer draws, counted off the meshes themselves, because a cluster per square is a draw per square
 * for the same pixels once the window holds the ring. `WorldCells` writes both halves of every key,
 * so whichever a level picks is there; the main camera renders neither.
 */
export const VIRTUAL_SHADOW_WIDE_CASTER_LAYER = 27;
/**
 * The wide half of short assets: ferns, grass and bushes. `WorldCells` classifies assets by
 * `shadows.smallCasterMetres`; every level then applies its measured texel gate, so a resolved
 * shadow survives the fine window's edge. The main camera never draws this internal layer.
 */
export const VIRTUAL_SHADOW_SMALL_CASTER_LAYER = 26;
/**
 * The counterpart of both caster layers for a GPU-driven map: one mesh per `asset:level:part`
 * drawing that key's shadow twin, so a level submits one indirect draw per key instead of one per
 * grid square. `WorldCells` mints these instead of the two caster halves when a shadow level draws
 * from the GPU scene (`?tnShadowGpuKeys=1`), and every level camera carries this bit, which is why
 * it is not one half of a choice: a key is the whole of what a keyed map draws of the world.
 */
export const VIRTUAL_SHADOW_KEY_LAYER = 25;
export const DEFAULT_CLIP_EXTENTS: readonly number[] = [16, 48, 144];
export const DEFAULT_MAX_LEVEL_RATIO = 2;

/**
 * Levels with no step wider than `maxRatio`, and for each the authored level it came from (an
 * inserted level names the authored level it leads into).
 */
export function clipLadder(
  authored: readonly number[],
  maxRatio: number,
): { readonly extents: number[]; readonly source: number[] } {
  const extents: number[] = [];
  const source: number[] = [];
  authored.forEach((extent, index) => {
    const previous = authored[index - 1];
    if (previous !== undefined && previous > 0 && extent / previous > maxRatio) {
      const steps = Math.ceil(Math.log(extent / previous) / Math.log(maxRatio));
      const ratio = (extent / previous) ** (1 / steps);
      for (let step = 1; step < steps; step += 1) {
        extents.push(previous * ratio ** step);
        source.push(index);
      }
    }
    extents.push(extent);
    source.push(index);
  });
  return { extents, source };
}
