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
import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  DoubleSide,
  type Material,
  MeshStandardMaterial,
} from "three";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { palette } from "./palette.js";
import { type ISurfaceOptions, type Surface, surfaced } from "./surface.js";

/** Every surface role the town, the facades and the props read by name. */
export type TownMaterials = {
  /** Street deck and lanes. */
  readonly ground: Material;
  /** Building walls. */
  readonly plaster: (longestSideMetres: number) => Material;
  /** The aged accent buildings, which share the wall material. */
  readonly brick: (longestSideMetres: number) => Material;
  /** Painted band along the foot of a lane wall. */
  readonly dadoBand: Material;
  readonly plasterTrim: Material;
  readonly brickTrim: Material;
  readonly doorBlue: Material;
  readonly shutter: Material;
  readonly rollerSteel: Material;
  readonly awningCanvas: MeshStandardMaterial;
  readonly awningStripe: MeshStandardMaterial;
  readonly water: MeshStandardMaterial;
  readonly shallow: MeshStandardMaterial;
  readonly crate: Material;
  readonly deckWood: Material;
  readonly barrel: Material;
  readonly palmTrunk: MeshStandardMaterial;
  readonly frond: MeshStandardMaterial;
  readonly siteMark: Material;
  readonly plateFace: MeshStandardMaterial;
  readonly plateHit: MeshStandardMaterial;
  readonly plateFrame: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  readonly steelPost: Material;
  readonly steelMast: MeshStandardMaterial;
  readonly tankDark: Material;
  readonly quay: Material;
  readonly plazaWarm: Material;
  readonly plazaCool: Material;
  readonly plazaPale: Material;
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

/**
 * A generated surface (`surface.ts`) in the colour a grid material shows — its tint times the
 * grid's own base — and its roughness, or that grid material when the surfaces did not load. The
 * albedo, and so the colour balance, stays the one the grid look had.
 */
function dressed(
  fallback: MeshStandardMaterial,
  surface: Surface,
  options: Partial<ISurfaceOptions> = {},
): Material {
  const shown = fallback.color.clone();
  if (fallback.map === floorMaterial.map) shown.multiply(new Color(palette.floor));
  if (fallback.map === structureMaterial.map) shown.multiply(new Color(palette.structure));
  return (
    surfaced(shown, surface, {
      roughness: fallback.roughness,
      metalness: fallback.metalness,
      ...options,
    }) ?? fallback
  );
}

/** Ground and streets read as one continuous pavement; the plazas are a shade cooler. */
export function createTownMaterials(): TownMaterials {
  const plaster = dressed(structureMaterial, "plaster", { strength: 0.8, grime: 0.22, bump: 0.8 });
  const anySize = (material: Material) => (): Material => material;
  const ground = dressed(floorMaterial, "pavement", { strength: 1.6, bump: 1, patches: 0.6 });
  const prop = dressed(propMaterial, "wood", { strength: 0.12, bump: 0.15, patches: 0.1 });
  return {
    ground,
    plaster: anySize(plaster),
    brick: anySize(plaster),
    dadoBand: dressed(tinted(structureMaterial, palette.structure, 0.9), "plaster", { grime: 0.3 }),
    plasterTrim: dressed(tinted(structureMaterial, palette.structure, 0.55), "plaster", {
      strength: 0.5,
    }),
    brickTrim: dressed(tinted(structureMaterial, palette.structure, 0.6), "plaster", {
      strength: 0.6,
    }),
    // Joinery is the one thing a player reads at a distance to find a way in,
    // so doors and shutters wear the saturated prop colour: painted boards.
    doorBlue: prop,
    shutter: prop,
    rollerSteel: dressed(tinted(propMaterial, palette.prop, 0.6), "metal", {
      strength: 0.5,
      metalness: 0.3,
    }),
    awningCanvas: tinted(structureMaterial, palette.floor, 0.8),
    awningStripe: propMaterial,
    // The sea is not a surface with a metre grid. It is the one flat material in
    // the town, and its roughness is what makes it take the sky.
    water: new MeshStandardMaterial({ color: 0x1f5f88, roughness: 0.24, metalness: 0.34 }),
    shallow: new MeshStandardMaterial({ color: 0x3a7f97, roughness: 0.45, metalness: 0.1 }),
    // Crates, drums and decking are what you fight around, so they are the
    // prop colour: the one saturated thing in the palette, and the only
    // geometry a player can mistake for cover.
    crate: prop,
    // The structure map already carries `palette.structure`; tinting by it again squared the albedo
    // (0.032 against the intended 0.178), so every deck underside read as black.
    deckWood: dressed(tinted(structureMaterial, 0xffffff, 0.75), "wood", {
      strength: 0.18,
      bump: 0.15,
      patches: 0.3,
      fade: 8,
    }),
    barrel: prop,
    palmTrunk: tinted(structureMaterial, palette.structure, 0.9),
    frond: new MeshStandardMaterial({ color: 0x4a803c, roughness: 0.78, side: DoubleSide }),
    siteMark: prop,
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
    steelPost: dressed(structureMaterial, "metal", {
      strength: 0.6,
      roughness: 0.5,
      metalness: 0.4,
    }),
    // Kept a plain material on purpose: town.ts draws the overhead wires with
    // this, and a THREE.Line cannot take a grid map.
    steelMast: new MeshStandardMaterial({ color: 0x8a8f95, roughness: 0.45, metalness: 0.65 }),
    tankDark: dressed(tinted(structureMaterial, palette.structure, 0.55), "metal", {
      strength: 0.6,
    }),
    quay: dressed(structureMaterial, "ground", { strength: 0.8, grime: 0.15 }),
    plazaWarm: ground,
    plazaCool: dressed(tinted(floorMaterial, palette.floor, 0.7), "ground", { strength: 1.2 }),
    plazaPale: dressed(tinted(floorMaterial, palette.floor, 0.55), "ground", { strength: 1.2 }),
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
