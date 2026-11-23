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
    ["open-sea", "Open sea", part.openSea],
    ["shore-edge", "Shore foam, edge", part.shoreEdge],
    ["shore-corner", "Shore foam, corner", part.shoreCorner],
  ],
  Platforms: [
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
  ],
  Nature: [
    ["puff-tree", "Round tree", part.puffTree],
    ["puff-bush", "Round bush", part.puffBush],
    ["palm-tree", "Palm tree", part.palmTree],
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

function course(): Place[] {
  const out: Place[] = [...plateau(-6, -1, -4, 1)];
  for (let i = -3; i <= 4; i++) out.push(["tech-panel", i, 0, 1]);
  for (let i = -3; i <= 4; i++) out.push(["cliff-block", i, 0, -1]);
  out.push(
    ["boost-pad", -2, 0, 1.5],
    ["glass-panel", 5, 0, 1],
    ["glass-panel", 6, 0, 1],
    ["stairs", 7, 0, 1, 3],
    ["plastic-slab", 8, 0, 1.5],
    ["plastic-slab", 9, 0, 1.5],
    ["plastic-slab", 9, -1, 1.5],
    ["cliff-block", 8, 0, -0.5],
    ["cliff-block", 9, 0, -0.5],
    ["cliff-block", 9, -1, -0.5],
    ["cannon", 9, 0, 2],
    ["checkpoint", 8, 0, 2],
    // a lower terrace at the foot of the wall carries the pipe run and the crystal
    ...plateau(-1, 1, 3, 3, -1),
    ["pipe", 0, 2, 0],
    ["pipe", 1, 2, 0],
    ["pipe-elbow", 2, 2, 0, 1],
    ["pipe", 2, 3, 0, 1],
    ["crystal", 0, 1, 0],
    ["flowers", 1, 3, 0],
    ["puff-bush", -1, 2, 0],
    ["hover-platform", 2, -2, 1],
    ["hover-platform", 4, -3, 2],
    ["prize-box", 0, 0, 1.5],
    ["button", 3, 0, 1.5],
    ["bounce-pad", -5, 0, 1],
    ["puff-tree", -6, -1, 1],
    ["puff-bush", -6, 1, 1],
    ["boulder", -4, 1, 1],
    ["floating-island", 2, -9, 2],
    ["puff-tree", 2, -9, 5.2],
    ["cloud", -6, -8, 8],
    ["cloud", 10, -6, 11],
  );
  for (let i = -2; i <= 3; i++) out.push(["coin", i + 0.5, 0, 1.6]);
  return out;
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
  course: { pos: [10, 8, 14], target: [3, 1.5, -1] },
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
