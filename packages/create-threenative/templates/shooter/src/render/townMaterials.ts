// Bayview's surfaces, in the engine's default look: a light metre grid for the
// ground, a dark metre grid for everything built, and one saturated blue for
// the props you can push, hide behind or shoot.
//
// ## Why there is no texture in this file
//
// The town used to be dressed in Bayview's own colour / normal / roughness /
// AO photographs, sampled triplanar from world position so a tile was the same
// size on every wall. That is a good look and it is not this template's look:
// it shipped ~23 MB of images with every scaffolded project, and a first-person
// shooter is judged on whether it runs, not on whether its stucco has relief.
//
// So the whole texture branch is gone. What remains is three materials from
// `./materials.js` — the same ones `minimal` opens every project with — and
// `worldGridUVs`, which is what makes one grid tile one metre on a face of any
// size. The geometry is unchanged: same buildings, same quay, same decks, same
// routes. Only the dressing moved.
//
// ## What still exists, and why
//
//   * The three grid materials are SHARED across the town, so `town.ts` and
//     `facade.ts` still hand every solid one of a small set of materials and
//     the projection keeps batching them.
//   * Water, palms, fronds and the scoring plates keep their own flat
//     materials. A metre grid across the sea reads as a bug, and a target that
//     looks like a wall is not a target. They are content, not dressing.
//   * `worldGridUVs` has to be called on geometry that is already in world
//     space, which is what `facade.ts` and `vehicles.ts` do before merging and
//     what `town.ts` does per solid. Calling it on a shared unit box would give
//     every solid in the town the same tile, so those meshes now carry their
//     own geometry.
import { BoxGeometry, type BufferGeometry, DoubleSide, MeshStandardMaterial } from "three";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { palette } from "./palette.js";

/** Every surface role the town, the facades and the props read by name. */
export type TownMaterials = {
  /** Street deck and lanes. */
  readonly ground: MeshStandardMaterial;
  /** Building walls. */
  readonly plaster: (longestSideMetres: number) => MeshStandardMaterial;
  /** The aged accent buildings, which share the wall material. */
  readonly brick: (longestSideMetres: number) => MeshStandardMaterial;
  /** Painted band along the foot of a lane wall. */
  readonly dadoBand: MeshStandardMaterial;
  readonly plasterTrim: MeshStandardMaterial;
  readonly brickTrim: MeshStandardMaterial;
  readonly doorBlue: MeshStandardMaterial;
  readonly shutter: MeshStandardMaterial;
  readonly rollerSteel: MeshStandardMaterial;
  readonly awningCanvas: MeshStandardMaterial;
  readonly awningStripe: MeshStandardMaterial;
  readonly water: MeshStandardMaterial;
  readonly shallow: MeshStandardMaterial;
  readonly crate: MeshStandardMaterial;
  readonly deckWood: MeshStandardMaterial;
  readonly barrel: MeshStandardMaterial;
  readonly palmTrunk: MeshStandardMaterial;
  readonly frond: MeshStandardMaterial;
  readonly siteMark: MeshStandardMaterial;
  readonly plateFace: MeshStandardMaterial;
  readonly plateHit: MeshStandardMaterial;
  readonly plateFrame: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  readonly steelPost: MeshStandardMaterial;
  readonly steelMast: MeshStandardMaterial;
  readonly tankDark: MeshStandardMaterial;
  readonly quay: MeshStandardMaterial;
  readonly plazaWarm: MeshStandardMaterial;
  readonly plazaCool: MeshStandardMaterial;
  readonly plazaPale: MeshStandardMaterial;
};

/**
 * A tinted clone of one of the three grid materials, so a role the town needs
 * to read differently from its neighbours still costs one material rather than
 * a bitmap. The grid stays one metre because the UVs come from
 * `worldGridUVs`, not from the map's repeat.
 */
function tinted(
  source: MeshStandardMaterial,
  colour: number,
  roughness: number,
): MeshStandardMaterial {
  const material = source.clone();
  material.color.setHex(colour);
  material.roughness = roughness;
  return material;
}

/** Ground and streets read as one continuous light grid; the plazas are a shade cooler. */
export function createTownMaterials(): TownMaterials {
  const anySize = (material: MeshStandardMaterial) => (): MeshStandardMaterial => material;
  return {
    ground: floorMaterial,
    plaster: anySize(structureMaterial),
    brick: anySize(structureMaterial),
    dadoBand: tinted(structureMaterial, palette.structure, 0.9),
    plasterTrim: tinted(structureMaterial, palette.structure, 0.55),
    brickTrim: tinted(structureMaterial, palette.structure, 0.6),
    // Joinery is the one thing a player reads at a distance to find a way in,
    // so doors and shutters wear the saturated prop colour rather than the grid.
    doorBlue: propMaterial,
    shutter: propMaterial,
    rollerSteel: tinted(propMaterial, palette.prop, 0.6),
    awningCanvas: tinted(structureMaterial, palette.floor, 0.8),
    awningStripe: propMaterial,
    // The sea is not a surface with a metre grid. It is the one flat material in
    // the town, and its roughness is what makes it take the sky.
    water: new MeshStandardMaterial({ color: 0x1f5f88, roughness: 0.24, metalness: 0.34 }),
    shallow: new MeshStandardMaterial({ color: 0x3a7f97, roughness: 0.45, metalness: 0.1 }),
    // Crates, drums and decking are what you fight around, so they are the
    // prop colour: the one saturated thing in the palette, and the only
    // geometry a player can mistake for cover.
    crate: propMaterial,
    // The structure map already carries `palette.structure`; tinting by it again squared the albedo
    // (0.032 against the intended 0.178), so every deck underside read as black.
    deckWood: tinted(structureMaterial, 0xffffff, 0.75),
    barrel: propMaterial,
    palmTrunk: tinted(structureMaterial, palette.structure, 0.9),
    frond: new MeshStandardMaterial({ color: 0x4a803c, roughness: 0.78, side: DoubleSide }),
    siteMark: propMaterial,
    // A scoring plate has to read as a target from across the town, so it
    // keeps a lit face and a struck face that swaps lighter.
    plateFace: new MeshStandardMaterial({
      color: 0xff5252,
      emissive: 0xff0000,
      emissiveIntensity: 0.16,
      roughness: 0.9,
      side: DoubleSide,
    }),
    plateHit: new MeshStandardMaterial({ color: 0xff8d7f, roughness: 0.9, side: DoubleSide }),
    plateFrame: structureMaterial,
    steel: structureMaterial,
    steelPost: structureMaterial,
    // Kept a plain material on purpose: town.ts draws the overhead wires with
    // this, and a THREE.Line cannot take a grid map.
    steelMast: new MeshStandardMaterial({ color: 0x8a8f95, roughness: 0.45, metalness: 0.65 }),
    tankDark: tinted(structureMaterial, palette.structure, 0.55),
    quay: structureMaterial,
    plazaWarm: floorMaterial,
    plazaCool: tinted(floorMaterial, palette.floor, 0.7),
    plazaPale: tinted(floorMaterial, palette.floor, 0.55),
  };
}

/**
 * One metre of grid on a solid, in world space.
 *
 * The town's boxes used to be a shared unit geometry scaled per mesh, which is
 * what let the projection instance them. A grid cannot ride that: a shared unit
 * box has one set of UVs, so every solid would show the same single tile. This
 * builds the box at its real size, puts it where it belongs, and projects the
 * grid — which is why the town now draws a few more times and measures cheaper
 * than a texture fetch per pixel ever did.
 */
export function gridSolid(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
): BufferGeometry {
  return worldGridUVs(new BoxGeometry(size[0], size[1], size[2]).translate(at[0], at[1], at[2]));
}
