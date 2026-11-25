import { Group, type Object3D } from "three";
import type { IStylizedScene } from "../../vendor/stylized-biome-kit/scenes.js";
import { ToyMesh, type ToyPart, type XYZ } from "./kit.js";
import * as part from "./parts.js";

type Entry = [id: string, name: string, build: ToyPart];

const sections: Record<string, Entry[]> = {
  "Terrain blocks": [
    ["grass-block", "Grass block, 1 m", part.grassBlock1],
    ["grass-block-tall", "Grass block, 2 m", part.grassBlock2],
    ["grass-edge", "Grass edge, collar", part.grassEdge],
    ["grass-corner", "Grass corner, rounded", part.grassCorner],
    ["grass-ramp", "Grass ramp", part.grassRamp],
    ["cliff-block", "Cliff block", part.cliffBlock],
    ["pond-block", "Pond block", part.pondBlock],
    ["ruin-block", "Carved ruin block", part.ruinBlock],
    ["open-sea", "Open sea", part.openSea],
    ["shore-edge", "Shore foam, edge", part.shoreEdge],
    ["shore-corner", "Shore foam, corner", part.shoreCorner],
  ],
  Platforms: [
    ["stone-platform", "Cut-stone platform", part.stonePlatform],
    ["stone-pillar", "Stepping pillar", part.stonePillar],
    ["stone-float", "Floating stone raft", part.stoneFloat],
    ["slider-platform", "Sliding stone raft", part.sliderPlatform],
    ["plastic-slab", "Plastic slab", part.plasticSlab],
    ["tech-panel", "Circuit deck panel", part.techPanel],
    ["glass-panel", "Glass floor panel", part.glassPanel],
    ["checker-pad", "Checkered launch pad", part.checkerPad],
    ["hover-platform", "Hover platform", part.hoverPlatform],
    ["stairs", "Stairs", part.stairs],
    ["bridge", "Bridge", part.bridge],
    ["rail", "Guard rail", part.rail],
    ["pipe", "Pipe", part.pipe],
    ["pipe-elbow", "Pipe elbow", part.pipeElbow],
    ["wood-deck", "Pier deck", part.woodDeck],
    ["stone-arch", "Stone gateway", part.stoneArch],
  ],
  Props: [
    ["crate", "Crate", part.crate],
    ["barrel", "Barrel", part.barrel],
  ],
  Gameplay: [
    ["coin", "Coin", part.coin],
    ["prize-box", "Prize box", part.prizeBox],
    ["bounce-pad", "Bounce pad", part.bouncePad],
    ["boost-pad", "Boost pad", part.boostPad],
    ["button", "Floor button", part.button],
    ["checkpoint", "Checkpoint beacon", part.checkpoint],
    ["cannon", "Cannon", part.cannon],
    ["spinner", "Spinner bar", part.spinner],
    ["spike-trap", "Spike trap", part.spikeTrap],
    ["goal-gate", "Goal gate", part.goalGate],
  ],
  Nature: [
    ["puff-tree", "Round tree", part.puffTree],
    ["puff-bush", "Round bush", part.puffBush],
    ["palm-tree", "Palm tree", part.palmTree],
    ["tier-tree", "Canopy tree", part.tierTree],
    ["glyph-pillar", "Glyph pillar", part.glyphPillar],
    ["fruit-pile", "Fruit pile", part.fruitPile],
    ["tulips", "Tulips", part.tulips],
    ["flowers", "Flower patch", part.flowers],
    ["spiky-plant", "Spiky rosette", part.spikyPlant],
    ["leafy-plant", "Broadleaf plant", part.leafyPlant],
    ["hanging-vines", "Hanging vines", part.hangingVines],
    ["boulder", "Boulder", part.boulder],
    ["rock-pile", "Rock pile", part.rockPile],
    ["crystal", "Crystal cluster", part.crystal],
    ["waterfall", "Waterfall", part.waterfall],
    ["cloud", "Cloud", part.cloud],
    ["floating-island", "Floating island", part.floatingIsland],
  ],
};

export const toyboxEntries = Object.entries(sections).flatMap(([category, entries]) =>
  entries.map(([id, name, build]) => ({ id, name, category, build })),
);
const recipes = new Map(toyboxEntries.map(({ id, build }) => [id, build]));

export function buildToyboxPart(id: string, seed: number, theme: number): Group {
  const make = recipes.get(id);
  if (!make) throw new Error(`Unknown toybox asset "${id}"`);
  const mesh = new ToyMesh(seed, theme);
  make(mesh);
  return mesh.finish(id);
}

export const toyboxScenes = {
  garden: "Sky garden",
  course: "Obstacle course",
  cove: "Island cove",
} as const;

// The sky panorama lights each theme from above and below, so the hemisphere only adds the
// colour that bounces off the theme's own ground: lawn green, snow blue, sand orange.
export const toyboxEnv: IStylizedScene["env"][] = [
  {
    skyTop: 0x3f8fe6,
    horizon: 0xcfeaff,
    fog: [0xd8ecff, 90, 320],
    sun: { dir: [-0.55, 0.75, 0.38], color: 0xfff0d6, intensity: 3.3 },
    hemi: { sky: 0xbfe0ff, ground: 0x86b85a, intensity: 0.5 },
    shadow: 30,
  },
  {
    skyTop: 0x4a8fe0,
    horizon: 0xe6f2ff,
    fog: [0xe4f0ff, 80, 300],
    sun: { dir: [0.5, 0.7, 0.45], color: 0xfff6ea, intensity: 3 },
    hemi: { sky: 0xcfe4ff, ground: 0x9cc0f0, intensity: 0.55 },
    shadow: 30,
  },
  {
    skyTop: 0x2f8ae6,
    horizon: 0xf0e2c8,
    fog: [0xf6e2c4, 90, 320],
    sun: { dir: [-0.5, 0.72, 0.45], color: 0xffe6c0, intensity: 3.4 },
    hemi: { sky: 0xdce8ff, ground: 0xe09a50, intensity: 0.55 },
    shadow: 30,
  },
];

/** Cell `[i, k]` on the 2 m grid, `level` metres up, turned by quarter turns. */
type Place = [id: string, i: number, k: number, level?: number, quarter?: number];

function assemble(places: Place[], seed: number, theme: number): Group {
  const group = new Group();
  places.forEach(([id, i, k, level = 0, quarter = 0], n) => {
    const piece: Object3D = buildToyboxPart(id, seed * 131 + n, theme);
    piece.position.set(i * part.CELL, level, k * part.CELL);
    piece.rotation.y = (quarter * Math.PI) / 2;
    group.add(piece);
  });
  return group;
}

/**
 * Quarter turns of the rim piece for a plateau cell, by where it sits on X and on Z ("+" far
 * side, "-" near side, "" inside): two signs make a rounded corner, one makes an edge.
 */
const RIM: Record<string, number> = {
  "+,+": 0,
  "+,-": 1,
  "-,-": 2,
  "-,+": 3,
  ",+": 0,
  "+,": 1,
  ",-": 2,
  "-,": 3,
};

/** A rectangle of blocks from cell (i0, k0) to (i1, k1), ringed by collar edges and rounded corners. */
function plateau(i0: number, k0: number, i1: number, k1: number, level = 0): Place[] {
  const out: Place[] = [];
  const side = (v: number, lo: number, hi: number) => (v === hi ? "+" : v === lo ? "-" : "");
  for (let i = i0; i <= i1; i++)
    for (let k = k0; k <= k1; k++) {
      const x = side(i, i0, i1);
      const z = side(k, k0, k1);
      const turn = RIM[`${x},${z}`];
      if (turn === undefined) out.push(["grass-block", i, k, level]);
      else out.push([x && z ? "grass-corner" : "grass-edge", i, k, level, turn]);
    }
  return out;
}

/** Shore foam round a plateau that stands in the sea: edge strips and rounded corners. */
const shore = (i0: number, k0: number, i1: number, k1: number): Place[] =>
  plateau(i0, k0, i1, k1)
    .filter(([id]) => id !== "grass-block")
    .map(([id, i, k, , turn]) => [
      id === "grass-corner" ? "shore-corner" : "shore-edge",
      i,
      k,
      0,
      turn,
    ]);

function garden(): Place[] {
  return [
    ...plateau(-4, -2, -1, 2).filter(([, i, k]) => !(i === -3 && k === 1)),
    ["pond-block", -3, 1],
    ["cliff-block", -3, -2, 1],
    ["waterfall", -3, -1, 1],
    ["grass-block", -2, -2, 1],
    ["grass-ramp", -2, -1, 1],
    ["puff-tree", -4, 0, 1],
    ["puff-tree", -2, 2, 1],
    ["puff-bush", -4, 1, 1],
    ["flowers", -3, 0, 1],
    ["flowers", -2, 1, 1],
    ["checkpoint", -1, 1, 1],
    ["rail", -2, 2.45, 1.1],
    ["bridge", 0.5, 0.5],
    ...plateau(2, -1, 4, 1),
    ["prize-box", 3, -1, 1],
    ["prize-box", 3.55, -1, 1],
    ["bounce-pad", 3, 1, 1],
    ["puff-tree", 4, -1, 1],
    ["rock-pile", 2, 1, 1],
    ["tech-panel", 5, 0],
    ["tech-panel", 6, 0],
    ["tech-panel", 7, 0],
    ["boost-pad", 6, 0, 0.5],
    ["checker-pad", 8, 0],
    ["hover-platform", 7, -3, 1],
    ["hover-platform", 5, -4, 2],
    ["crystal", 3, 0, 1],
    ["floating-island", -1, -9, 3],
    ["puff-tree", -2, -9, 6.2],
    ["puff-tree", 0, -8, 6.2],
    ["flowers", -1, -10, 6.2],
    ...[-0.5, 0, 0.5, 1, 1.5].map(
      (i): Place => ["coin", i, 0.5, 1.5 + (1 - ((i - 0.5) * 1.1) ** 2) * 0.5],
    ),
    ["cloud", -8, -6, 9],
    ["cloud", 6, -10, 12],
    ["cloud", 12, 4, 7],
  ];
}

/**
 * A full run along +X through temple ruins in the sky: a garden start, a cut-stone causeway,
 * stepping pillars over a drop, a carved temple top with a spinner, a spike corridor, a sliding
 * raft over a gap, a bounce up to floating rafts, a hover hop, and a goal plateau with the gate.
 */
function course(): Place[] {
  const lane = (id: string, from: number, to: number, level = 0): Place[] =>
    Array.from({ length: to - from + 1 }, (_, n): Place => [id, from + n, 0, level]);
  const coins = (from: number, to: number, y: number): Place[] =>
    Array.from({ length: (to - from) * 2 + 1 }, (_, n): Place => ["coin", from + n / 2, 0, y]);
  return [
    // start garden
    ...plateau(-12, -1, -10, 1),
    ["checkpoint", -11, 0, 1],
    ["tier-tree", -12, -1, 1],
    ["puff-bush", -12, 1, 1],
    ["tulips", -11, 1, 1],
    ["tulips", -10, -1, 1],
    ["fruit-pile", -10, 1, 1],
    // cut-stone causeway, then stepping pillars over the drop
    ...lane("stone-platform", -9, -8),
    ...coins(-9, -8, 1.6),
    ["stone-pillar", -7, 0, -0.5],
    ["stone-pillar", -6, 0, -0.2],
    ["stone-pillar", -5, 0, 0],
    ["coin", -7, 0, 2.1],
    ["coin", -6, 0, 2.4],
    ["coin", -5, 0, 2.6],
    // the temple top: carved ruin blocks, glyph pillars, a spinner to jump
    ...[-4, -3, -2].flatMap((i) => [-1, 0, 1].map((k): Place => ["ruin-block", i, k])),
    ["spinner", -3, 0, 2],
    ["glyph-pillar", -4, -1, 2],
    ["glyph-pillar", -2, -1, 2],
    ["tier-tree", -4, 1, 2],
    ["fruit-pile", -2, 1, 2],
    ["hanging-vines", -3, 1],
    ["hanging-vines", -3, 1, 1],
    // down the steps to the spike corridor
    ["stone-platform", -1, 0],
    ["stairs", -1, 0, 1, 1],
    ...lane("stone-platform", 0, 3),
    ["spike-trap", 1, 0, 1],
    ["spike-trap", 3, 0, 1],
    ["rail", 2, -0.47, 1],
    ["rail", 2, 0.47, 1],
    ...coins(0, 3, 1.7),
    // the sliding raft over a two-cell gap
    ["slider-platform", 5, 0],
    ["stone-pillar", 4, -1, -0.8],
    // landing garden, bounce up to the floating rafts
    ...plateau(7, -1, 9, 1),
    ["bounce-pad", 9, 0, 1],
    ["tulips", 7, -1, 1],
    ["tier-tree", 7, 1, 1],
    ["prize-box", 8, -1, 1],
    ["stone-float", 10, 0, 2],
    ["stone-float", 11, -1, 2.6],
    ["stone-float", 12, 0, 3.2],
    ["coin", 10, 0, 3.8],
    ["coin", 11, -1, 4.4],
    ["coin", 12, 0, 5],
    ["hover-platform", 13, 0, 3],
    // goal: a temple plateau with the gate
    ...[14, 15, 16].flatMap((i) => [-1, 0, 1].map((k): Place => ["ruin-block", i, k])),
    ["goal-gate", 16, 0, 2, 1],
    ["glyph-pillar", 14, -1, 2],
    ["fruit-pile", 15, 1, 2],
    ["tier-tree", 14, 1, 2],
    ["crystal", 15, -1, 2],
    // scenery
    ["floating-island", -4, -10, 2],
    ["tier-tree", -4, -10, 5.2],
    ["floating-island", 9, -11, 4],
    ["glyph-pillar", 9, -11, 7.2],
    ["cloud", -10, -8, 8],
    ["cloud", 6, -8, 11],
    ["cloud", 18, -6, 9],
  ];
}

/** Two islands in a sea, joined by a pier through a stone gateway. */
function cove(): Place[] {
  const land: Place[] = [
    ...plateau(-6, -2, -3, 1),
    ...plateau(2, -2, 4, 1),
    ["grass-block", -5, -2, 1],
    ["grass-block", -4, -2, 1],
    ["cliff-block", 4, -2, 1],
  ];
  const pier: Place[] = [-2, -1, 0, 1].map((i): Place => ["wood-deck", i, 0]);
  return [
    ["open-sea", 0, 0],
    ...shore(-6, -2, -3, 1),
    ...shore(2, -2, 4, 1),
    ...land,
    ...pier,
    // vines hang on straight edges only: a corner is rounded
    ["hanging-vines", -5, 1],
    ["hanging-vines", -4, 1],
    ["hanging-vines", 3, 1],
    ["hanging-vines", -4, -2, 1],
    ["stone-arch", 2, 0, 1, 1],
    ["palm-tree", -6, -2, 1],
    ["puff-tree", -5, -2, 2],
    ["palm-tree", -6, 1, 1],
    ["leafy-plant", -5.5, 0.5, 1],
    ["leafy-plant", -3.4, -1, 1],
    ["spiky-plant", -4, 1, 1],
    ["spiky-plant", -3, 1, 1],
    ["flowers", -5, 0, 1],
    ["checkpoint", -5, -1, 1],
    ["crate", -3, -1.6, 1],
    ["barrel", -2.6, -1.1, 1],
    ["barrel", -0.5, -0.25, 1],
    ["crate", 3, -1, 1],
    ["crate", 3, -1, 2],
    ["crate", 3.55, -1.5, 1],
    ["barrel", 2.5, -1.6, 1],
    ["prize-box", 3, 1, 1],
    ["bounce-pad", 4, 0, 1],
    ["palm-tree", 4, 1, 1],
    ["leafy-plant", 2, 1, 1],
    ["spiky-plant", 4, -2, 3],
    ["puff-bush", 3, -2, 1],
    ["rock-pile", -1, 2, 0],
    ["boulder", 0, -2, -0.2],
    ["rock-pile", 6, 1, 0],
    ["floating-island", 0, -10, 3],
    ["waterfall", 4, -1, 1],
    ...[-1.5, -1, -0.5, 0, 0.5, 1].map(
      (i): Place => ["coin", i, 0, 1.6 + (1 - ((i + 0.25) * 0.75) ** 2) * 0.4],
    ),
    ["cloud", -9, -7, 9],
    ["cloud", 8, -9, 11],
  ];
}

const VIEWS: Record<keyof typeof toyboxScenes, { pos: XYZ; target: XYZ }> = {
  garden: { pos: [11, 8.5, 15], target: [2, 1.5, -2] },
  course: { pos: [6, 22, 44], target: [5, 1.5, -2] },
  cove: { pos: [9, 8, 15], target: [-1, 1, -1] },
};
const LAYOUTS = { garden, course, cove };

export function buildToyboxScene(id: keyof typeof toyboxScenes, seed: number, theme: number) {
  const env = toyboxEnv[theme];
  if (!env) throw new Error(`Invalid toybox theme variant ${theme}`);
  const group = assemble(LAYOUTS[id](), seed, theme);
  group.name = `toybox-${id}`;
  return { group, env, view: VIEWS[id] };
}
