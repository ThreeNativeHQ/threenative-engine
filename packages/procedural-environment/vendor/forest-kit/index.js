// forest-kit — the forest-floor generators: deadwood, leaf litter, stone and the cover Arbor lacks.
// Vendored from the owner-authored MIT forest-kit (see ../../../LICENSES/forest-kit-MIT.txt) with
// three removed: GeoBuilder keeps its arrays and drops `build()`, and `rock` uses the local
// icosphere instead of THREE.IcosahedronGeometry. The kits' Terrain, Sky, Water, ScatterSystem and
// foliage material stay out; see PRD-889's Decisions.

import { branch, leafLitter, log, rock, stump, twig } from "./debris.js";
import { reedClump, seedGrass, tussock } from "./grass.js";
import { cloverPatch, dockSpike, plumeStalk } from "./plants.js";

/**
 * Every preset this kit bakes. `part` is the GLB primitive it belongs in: debris is opaque wood or
 * stone and rides the `bark` primitive, cover is a single-sided strip and rides the alpha-masked,
 * double-sided `foliage` primitive.
 */
export const PRESETS = {
  branch: { name: "Fallen branch", kind: "debris", part: "bark", generate: branch },
  clover: { name: "Clover patch", kind: "cover", part: "leaves", generate: cloverPatch },
  dock: { name: "Dock seed spike", kind: "cover", part: "leaves", generate: dockSpike },
  leaflitter: { name: "Leaf litter", kind: "debris", part: "bark", generate: leafLitter },
  log: { name: "Fallen mossy log", kind: "debris", part: "bark", generate: log },
  plume: { name: "Plume stalk", kind: "cover", part: "leaves", generate: plumeStalk },
  reeds: {
    name: "Reeds and cattails",
    kind: "cover",
    part: "leaves",
    // Cattails ship on by default: a reed stand read at one frame without them is just tall grass.
    generate: (options) => reedClump({ ...options, cattails: 3 }),
  },
  rock: {
    name: "Mossy boulder",
    kind: "debris",
    part: "bark",
    // forest-kit calls the subdivision `detail`, the bake calls it a level of detail.
    generate: ({ seed, lod }) => rock({ seed, detail: Math.max(0, 2 - lod) }),
  },
  seedgrass: { name: "Seeding grass", kind: "cover", part: "leaves", generate: seedGrass },
  // forest-kit builds the stump's splintered top at one density, so every lod writes the same mesh.
  stump: { name: "Tree stump", kind: "debris", part: "bark", generate: stump },
  tussock: { name: "Sedge tussock", kind: "cover", part: "leaves", generate: tussock },
  twig: { name: "Fallen twig", kind: "debris", part: "bark", generate: twig },
};

export default { PRESETS };
