/**
 * The crown radius that shades the ground under each tree, metres. The bake paints the canopy cover
 * map from these rows; a species absent here shades nothing. Alpine crowns are smaller than the
 * forest's spruce: the trees are shorter and the light is flatter.
 */
export const CANOPY_CROWN: Readonly<Record<string, number>> = {
  spruce: 6,
  scotspine: 5,
  blackspruce: 4.5,
  sapling: 2.5,
};
