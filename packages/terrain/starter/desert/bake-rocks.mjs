// Run with <out dir> (the starter art's `desert_rocks/`); needs @threenative/procedural-environment.
// Bakes the desert's stones once into GLBs the species pack (`render/props/pack.ts`) and the
// formations (`render/props/formations.ts`) draw. Every Outcrop form has a row, in three tones of
// sandstone, so a hillside is not one rock repeated: chipped boulders and worn ones, bedded slabs,
// crags, fins, hoodoos, an arch, and cliff walls baked as runs of modules that join.
// Outcrop's own desert palette is cream sandstone, which drew as white loaves under the sun, so
// this file names its own colours and shapes. The same row always writes the same bytes.
// Normals are stored as int8 and colours as uint8 (KHR_mesh_quantization), positions stay float.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { normals, quantize, simplify, weld } from "@gltf-transform/functions";
import { bakeRock } from "@threenative/procedural-environment";
import { MeshoptSimplifier } from "meshoptimizer";

const out = process.argv[2];
if (!out) throw new Error("bake-rocks: pass the output folder, e.g. starter-assets/desert_rocks");

/** Rock darker than the sand it lies on; `sandColor` is the kit's sand, so a drift joins the dune. */
const RED = {
  rockA: "#7a4630",
  rockB: "#a3623f",
  accent: "#bd8258",
  banding: 0.35,
  sand: 0.25,
  sandColor: "#b96a40",
  edgeWear: 0.3,
  cavity: 0.85,
};
/** Desert varnish: the near-black crust iron and manganese leave on stone that has lain for long. */
const VARNISH = { ...RED, rockA: "#4a2c26", rockB: "#6e4031", accent: "#8f5b41", banding: 0.2 };
/** The paler cap bed the slabs break from. */
const TAN = { ...RED, rockA: "#7d5237", rockB: "#96684a", accent: "#aa7d59", banding: 0.5 };
/** Broken, angular stone: planar chips and joints, little rounding. */
const CRAG = { chipping: 0.9, fracture: 0.45, roughness: 0.35, weathering: 0.15, strata: 0.4 };
/** Stone the wind has worn: rounded shoulders, few fresh chips. */
const WORN = { chipping: 0.35, fracture: 0.25, roughness: 0.45, weathering: 0.6, strata: 0.3 };
/** A bedded wall: Outcrop's cliff module has a flat back and underside, so it sits in a slope. */
const BEDS = {
  chipping: 0.8,
  fracture: 0.6,
  roughness: 0.5,
  weathering: 0.1,
  strata: 0.9,
  layers: 7,
};
/** A flagstone: thin beds that split along their layers. */
const PLATE = { ...CRAG, chipping: 0.6, fracture: 0.5, strata: 0.9, layers: 5 };

/**
 * One wall of `count` cliff modules. A module ends in a cut face, and joins its neighbour only when
 * both share the seed and stand one width apart, so module n is baked at `offset: [n * width, 0, 0]`
 * and `formations.ts` stands them in that order.
 */
const wall = (file, seed, size, traits, surface, count = 3) =>
  Array.from({ length: count }, (_, n) => ({
    file: `${file}-${n}`,
    form: "cliff",
    seed,
    detail: 0.42,
    size,
    traits,
    surface,
    offset: [n * size[0], 0, 0],
    far: 3200,
  }));

/**
 * One rock per row; the file names are the ones `pack.ts` and `formations.ts` quote.
 * `near` and `far` are triangle counts: `near` simplifies the bake itself (Outcrop's floor is
 * 1 500 triangles), `far` also writes `<file>-far.glb` for the rocks past the near band.
 */
const ROWS = [
  // Boulders: chipped and worn, red and varnished.
  // An angular block is a thick slab: Outcrop's boulder is a ball however much it is chipped.
  {
    file: "boulder-a",
    form: "slab",
    seed: 3,
    size: [2.3, 1.6, 1.9],
    traits: { ...CRAG, fracture: 0.6 },
    near: 5000,
    far: 900,
  },
  { file: "boulder-b", form: "boulder", seed: 8, traits: WORN, near: 5000, far: 900 },
  {
    file: "boulder-c",
    form: "boulder",
    seed: 21,
    traits: { ...CRAG, chipping: 0.7, fracture: 0.6, roughness: 0.5 },
    surface: VARNISH,
    near: 5000,
    far: 900,
  },
  {
    file: "boulder-d",
    form: "slab",
    seed: 34,
    size: [3.2, 1.4, 2.3],
    traits: { ...WORN, strata: 0.7 },
    surface: VARNISH,
    near: 5000,
    far: 900,
  },
  // Slabs: fallen blocks and the flagstones a cap bed breaks into.
  {
    file: "block-a",
    form: "slab",
    seed: 5,
    traits: { ...CRAG, fracture: 0.5, strata: 0.8 },
    near: 5000,
    far: 900,
  },
  {
    file: "slab-b",
    form: "slab",
    seed: 12,
    size: [4.2, 0.6, 2.8],
    traits: PLATE,
    surface: TAN,
    near: 2600,
    far: 600,
  },
  {
    file: "slab-c",
    form: "slab",
    seed: 27,
    size: [2.8, 1.2, 2.2],
    traits: { ...PLATE, fracture: 0.7 },
    near: 2600,
    far: 600,
  },
  // Cobbles and pebbles strewn by the hundred: a few hundred triangles each.
  { file: "cobble", form: "boulder", seed: 11, detail: 0.05, traits: CRAG, near: 700 },
  {
    file: "pebble",
    form: "boulder",
    seed: 17,
    detail: 0,
    traits: { ...CRAG, fracture: 0.2 },
    near: 160,
  },
  {
    file: "pebble-b",
    form: "slab",
    seed: 9,
    detail: 0,
    traits: { ...WORN, fracture: 0.2 },
    surface: VARNISH,
    near: 160,
  },
  // Crags: the jointed cores of an outcrop.
  {
    file: "crag-a",
    form: "stack",
    seed: 5,
    detail: 0.4,
    traits: { ...CRAG, chipping: 0.8, fracture: 0.5, roughness: 0.5, strata: 0.7 },
    near: 9000,
    far: 2200,
  },
  {
    file: "crag-b",
    form: "stack",
    seed: 14,
    detail: 0.4,
    size: [5.2, 4.2, 4.2],
    traits: { ...CRAG, chipping: 1, fracture: 0.7, roughness: 0.6, strata: 0.5 },
    surface: VARNISH,
    near: 9000,
    far: 2200,
  },
  // Fins and hoodoos: what a wall leaves standing when the rock round it has gone.
  {
    file: "fin-a",
    form: "spire",
    seed: 4,
    detail: 0.4,
    size: [3.4, 7, 2],
    traits: { ...BEDS, strata: 0.8 },
    near: 8000,
    far: 2000,
  },
  {
    file: "fin-b",
    form: "spire",
    seed: 9,
    detail: 0.4,
    size: [2.2, 5, 2.2],
    traits: { ...CRAG, strata: 0.8, layers: 9 },
    surface: VARNISH,
    near: 8000,
    far: 2000,
  },
  {
    file: "hoodoo-a",
    form: "hoodoo",
    seed: 2,
    detail: 0.4,
    traits: { ...BEDS, chipping: 0.5, layers: 9 },
    near: 8000,
    far: 2000,
  },
  {
    file: "hoodoo-b",
    form: "hoodoo",
    seed: 6,
    detail: 0.4,
    size: [2.8, 4.4, 2.6],
    traits: { ...BEDS, chipping: 0.6, weathering: 0.3 },
    surface: TAN,
    near: 8000,
    far: 2000,
  },
  {
    file: "arch",
    form: "arch",
    seed: 3,
    detail: 0.5,
    traits: { ...BEDS, chipping: 0.6, layers: 9 },
    far: 5000,
  },
  // Cliff walls: a tall red wall of four modules and a low varnished rim of three.
  ...wall("wall-a", 2, [12, 6, 5], BEDS, RED, 4),
  ...wall(
    "wall-b",
    5,
    [10, 4, 4.5],
    { ...BEDS, chipping: 0.9, fracture: 0.5, roughness: 0.6, strata: 0.7, layers: 5 },
    VARNISH,
  ),
  // The landmarks on the skyline: a mesa, a butte and a spire.
  { file: "mesa", form: "mesa", seed: 7, detail: 0.6, traits: { ...BEDS, layers: 12 } },
  { file: "butte", form: "mesa", seed: 12, detail: 0.55, traits: { ...BEDS, layers: 9 } },
  { file: "spire", form: "spire", seed: 4, detail: 0.5, traits: { ...BEDS, strata: 0.8 } },
];

await mkdir(out, { recursive: true });
await MeshoptSimplifier.ready;
const scratch = await mkdtemp(join(tmpdir(), "desert-rocks-"));
try {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  /**
   * Joins the faces, collapses them to `count` when given, and shades them smooth. Flat facets
   * drew every sliver the simplifier left as a black shard, and a flipped one as a hole; the
   * scanned relief in `formations.ts` and the pack draws the fine breaks instead.
   */
  const reduce = async (doc, from, count) => {
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) prim.setAttribute("NORMAL", null);
    await doc.transform(
      weld(),
      ...(count && count < from
        ? [simplify({ simplifier: MeshoptSimplifier, ratio: count / from, error: 0.2 })]
        : []),
      normals({ overwrite: true }),
    );
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    return (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3;
  };
  for (const row of ROWS) {
    const { file, form, seed, detail = 0.3, traits, surface = RED, size, offset, near, far } = row;
    const [level] = await bakeRock({
      form,
      biome: "desert",
      seed,
      detail,
      traits,
      surface,
      ...(size ? { size } : {}),
      ...(offset ? { offset } : {}),
      out: scratch,
    });
    for (const [name, count] of [
      [`${file}.glb`, near],
      ...(far ? [[`${file}-far.glb`, far]] : []),
    ]) {
      const doc = await io.read(level.path);
      const triangles = await reduce(doc, level.triangles, count);
      await doc.transform(
        quantize({ pattern: /^(NORMAL|COLOR_0)$/, quantizeNormal: 8, quantizeColor: 8 }),
      );
      await io.write(join(out, name), doc);
      console.log(`${name}  ${form}@${seed}  ${triangles} triangles`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
