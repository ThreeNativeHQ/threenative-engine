import { Group, PointLight } from "three";
import { CATALOG, build } from "../../vendor/stylized-biome-kit/catalog.js";
import { RNG } from "../../vendor/stylized-biome-kit/core.js";
import type { IStylizedScene } from "../../vendor/stylized-biome-kit/scenes.js";
import { buildDungeonPart } from "./catalog.js";
import { GRID } from "./masonry.js";
import { DungeonMesh, type XYZ } from "./mesh.js";

export const dungeonScenes = {
  courtyard: "The Sunken Court",
  assembly: "Modular dungeon layout",
} as const;

function staging(seed: number, theme: number) {
  const rng = new RNG(seed);
  const group = new Group();
  const parts = new Map<string, Group>();
  function place(id: string, x: number, y: number, z: number, yaw = 0, scale = 1): void {
    const variation = rng.int(1, 4);
    const key = `${id}:${variation}`;
    let source = parts.get(key);
    if (!source) {
      source = buildDungeonPart(id, seed * 97 + variation, theme);
      parts.set(key, source);
    }
    const object = source.clone();
    object.position.set(x, y, z);
    object.rotation.y = yaw;
    object.scale.setScalar(scale);
    group.add(object);
  }
  function light(x: number, y: number, z: number, strength = 21, cool = false): void {
    const color = cool ? 0x83caff : [0xffa658, 0x59b8ff, 0xff702c][theme];
    const lamp = new PointLight(color, strength, Math.sqrt(strength) * 2.15, 2);
    lamp.position.set(x, y, z);
    group.add(lamp);
  }
  function brazier(x: number, y: number, z: number): void {
    place("brazier", x, y, z);
  }
  function torch(x: number, y: number, z: number, yaw = 0): void {
    place("wall-torch", x, y, z, yaw);
  }
  return { group, place, light, brazier, torch, rng };
}

type Staging = ReturnType<typeof staging>;

function pit(stage: Staging, seed: number, theme: number, x: number, z: number): void {
  const m = new DungeonMesh(seed, theme);
  for (const side of [-1, 1]) {
    for (const tile of [-1.5, -0.5, 0.5, 1.5]) {
      m.stone([tile, -1.45, side * 1.84], [0.98, 2.35, 0.32], 0.81);
      m.stone([side * 1.84, -1.49, tile], [0.32, 2.26, 0.98], 0.75);
    }
  }
  const water = [0x375e64, 0x3e85ac, 0xf75314][theme] ?? 0x375e64;
  const liquidLevel = theme === 2 ? -0.72 : -2.62;
  m.block([0, liquidLevel, 0], [3.8, 0.11, 3.8], water, theme === 2 ? "glow" : "solid");
  const foam = [0x83bbb4, 0x90d9fd, 0xefa848][theme] ?? 0x83bbb4;
  for (let i = 0; i < 13; i++) {
    const a = m.rng.range(-1.54, 1.54);
    const b = m.rng.range(-1.56, 1.56);
    m.block(
      [a, liquidLevel + 0.07, b],
      [m.rng.range(0.16, 0.99), 0.012, 0.02],
      foam,
      "glow",
      0.003,
      m.rng.range(-0.45, 0.45),
    );
  }
  const basin = m.finish("pit");
  basin.position.set(x, 0, z);
  stage.group.add(basin);
  stage.light(x, -1.9, z, 15, theme !== 2);
}

function courtyardFloor({ place }: Staging): void {
  for (const x of [-8, -4, 0, 4, 8]) {
    for (const z of [-12, -8, -4, 0, 4, 8]) {
      if (x === 4 && z >= 0 && z < 8) continue;
      const floor = x > 0 ? "cracked-floor" : "floor";
      place((x + z) % 12 === 0 ? "mossy-floor" : floor, x, 0, z);
    }
  }
}

function courtyardStructure({ place }: Staging): void {
  for (const [index, x] of [-8, -4, 0, 4, 8].entries()) {
    place(["wall", "barred-window", "wall", "archway", "wall"][index] ?? "wall", x, 0, -14);
    place(
      ["collapsed-wall", "wall", "barred-window", "barred-window", "wall"][index] ?? "wall",
      x,
      3.6,
      -14,
    );
  }
  place("portcullis", 4, 0, -13.94);
  for (const z of [-12, -8, -4, 0]) {
    place(z === -4 ? "archway" : "wall", -10, 0, z, Math.PI / 2);
    place(z === 0 ? "collapsed-wall" : "wall", 10, 0, z, -Math.PI / 2);
  }
  for (const x of [-7.45, -2.55, 2.55, 7.45]) place("pillar", x, 0, -8.8);
  place("large-arch", -5, 0, -3.4);
  place("archway", -5, 0, -11);
  place("ruined-arch", 1.9, 0, -7.1);
  place("stairs", 8, 0, -6.02);
  for (const z of [-10, -14]) place("mossy-floor", 8, 2, z);
  place("pillar", 4.0, -1.62, -12.97);
  place("stone-bridge", 5.98, 2, -13, Math.PI / 2);
  place("vault", -8, 3.42, -9.3);
  place("wooden-bridge", 4, 0, 0, Math.PI / 2);
}

function courtyard(stage: Staging): void {
  const { place, brazier, torch, light } = stage;
  courtyardFloor(stage);
  courtyardStructure(stage);
  place("altar", -5, 0, -8.2);
  place("statue", -5, 0.08, -10.35);
  place("sarcophagus", -7.77, 0, -10.87, 0.24);
  place("shelves", 8.5, 0, 5.3, -Math.PI / 2);
  place("locked-chest", 6.62, 0, 6.0, -0.41);
  place("open-chest", -4.0, 0, -4.89, 0.3);
  place("crate", -7.8, 0, -1.4, 0.25);
  place("barrel", -7.1, 0, -1.25, 0.41);
  place("barrel", 8.68, 0, -1.4, 0.23);
  place("sack", -6.4, 0, -1.49, 0.23);
  place("bones", -1.43, 0, -0.38, 0.9);
  place("rubble", -1.6, 0, -6.2);
  place("broken-column", -8.7, 0, 2.33, 0.35);
  place("cage", -7.9, 0, -12.9);
  place("banner", -7.1, 1.52, -3.02);
  place("banner", -2.9, 1.42, -3.01);
  place("banner", 2.3, 3.48, -13.6);
  place("banner", 5.73, 3.48, -13.6);
  place("hanging-lamp", -6.55, 2.32, -6.77);
  place("broken-column", -8.1, 0, -5.86, -0.2);
  brazier(5.8, 0, 6.1);
  brazier(-2.63, 0, 2.15);
  brazier(-4.4, 0, -2.55);
  brazier(1.9, 0, -8.25);
  brazier(7.5, 2, -12.77);
  torch(-7.6, 1.07, -3.04);
  torch(-2.5, 1.07, -3.04);
  torch(-8.95, 1.2, -9.66, Math.PI / 2);
  torch(6.04, 1.48, -13.55);
  torch(1.92, 1.4, -13.55);
  light(-5.22, 2.12, -7.81, 23);
  light(-3.95, 5.1, -9.84, 41, true);
  light(1.28, 6.2, -12.4, 35, true);
}

const PLAN = [
  "..FFF......",
  "..FFF..FFF.",
  "...F...FFF.",
  ".FFF...FFF.",
  ".FFFFBFFFF.",
  ".FFF...FFF.",
  "...F...FFF.",
  "..FFF......",
  "..FFF......",
];

function layoutTile({ place, brazier }: Staging, tile: string, row: number, col: number): void {
  if (tile === ".") return;
  const x = (col - 5) * GRID;
  const z = (row - 4) * GRID;
  if (tile === "B") {
    place("wooden-bridge", x, 0, z, Math.PI / 2);
    return;
  }
  place((row + col) % 4 === 0 ? "mossy-floor" : "floor", x, 0, z);
  for (const [dr, dc, yaw] of [
    [-1, 0, 0],
    [0, -1, Math.PI / 2],
    [0, 1, Math.PI / 2],
  ] as const) {
    const neighbor = PLAN[row + dr]?.[col + dc];
    if (neighbor === "." || neighbor === undefined)
      place(row % 2 ? "wall" : "collapsed-wall", x + (dc * GRID) / 2, 0, z + (dr * GRID) / 2, yaw);
  }
  if ((row * 7 + col) % 7 === 0) brazier(x - 1, 0, z - 1);
}

function layout(stage: Staging): void {
  const { place } = stage;
  for (const [row, line] of PLAN.entries())
    for (const [col, tile] of [...line].entries()) layoutTile(stage, tile, row, col);
  for (const [x, z] of [
    [-8, -10],
    [-8, 6],
    [12, -2],
    [8, 6],
  ] as const)
    place("archway", x, 0, z);
  place("altar", -8, 0, -15.25);
  place("statue", -8, 0, -17.13);
  place("sarcophagus", 11.3, 0, -9, -0.32);
  place("spike-trap", 12, 0, 5);
  place("barrel", -15.11, 0, -0.2);
  place("open-chest", -8, 0, 16, -0.28);
  place("lever", 2.84, 0, 1.07);
  place("pillar", 1.65, 0, -1.25);
  place("pillar", -1.65, 0, -1.25);
  stage.light(-8, 2.21, -14.73, 38);
}

function climate(stage: Staging, theme: number, assembly: boolean): void {
  const m = new DungeonMesh(stage.rng.seed(), theme);
  const placements = assembly
    ? [
        [-8, -14],
        [-14, -3],
        [6.4, -5],
        [17, 0],
        [-9, 15],
      ]
    : [
        [-9.4, -9.8],
        [-6.2, -13.4],
        [-0.9, -13.4],
        [6, -10.8],
        [8.9, 3.4],
      ];
  for (const [x = 0, z = 0] of placements) {
    for (let i = 0; i < 7; i++) {
      const dx = m.rng.range(-0.85, 0.85);
      const dz = m.rng.range(-0.5, 0.5);
      const y = m.rng.range(0.17, 0.85);
      if (theme === 1) {
        m.rod(
          [x + dx, 0, z + dz],
          [x + dx * 1.4, y * 2.1, z + dz],
          y * 0.37,
          0x76a8cb,
          "solid",
          0.005,
          5,
        );
      } else {
        m.gem([x + dx, y * 0.19, z + dz], [0.39, y * 0.33, 0.37], m.palette.growth, "solid", 1);
      }
    }
  }
  stage.group.add(m.finish("theme-details"));
}

function hangingFerns(stage: Staging): void {
  const fern = CATALOG.find(({ id }) => id === "fern");
  if (!fern) throw new Error("The courtyard needs the shared fern generator");
  const ledges = [
    [-7.39, 3.45, -3.22],
    [-6.63, 4.06, -3.13],
    [-5.91, 4.65, -3.11],
    [-4.88, 4.89, -3.11],
    [-3.51, 4.29, -3.12],
    [-1.93, 3.33, -3.1],
    [-4.85, 6.94, -13.54],
    [-3.59, 7.05, -13.49],
    [-2.71, 7.01, -13.43],
    [-8.74, 2.89, -0.67],
    [-8.29, 0, 1.44],
    [6.15, 0, 1.3],
  ] as const;
  for (const [x, y, z] of ledges) {
    const fronds = build(fern, 0, {
      size: stage.rng.range(0.98, 1.57),
      fronds: 8,
      palette: "deep",
      seed: stage.rng.seed(),
    });
    fronds.position.set(x, y, z);
    fronds.rotation.set(
      y ? -0.93 : 0,
      stage.rng.range(-0.8, 0.8),
      y ? stage.rng.range(1.68, 2.68) : 0,
    );
    stage.group.add(fronds);
  }
}

function frozenArch(stage: Staging): void {
  const ice = new DungeonMesh(stage.rng.seed(), 1);
  for (let i = 0; i < 18; i++) {
    const u = -2 + (i / 17) * 4;
    const z = -3.13 + ice.rng.range(-0.2, 0.09);
    const y = 2.4 + Math.sqrt(2.22 ** 2 - u ** 2);
    const x = -5 + u;
    const length = ice.rng.range(0.34, 1.34);
    ice.rod(
      [x, y + 0.057, z],
      [x + ice.rng.range(-0.13, 0.13), y - length, z + 0.065],
      length * 0.155,
      0xa8cddd,
      "solid",
      0.005,
      5,
    );
  }
  for (let i = 0; i < 20; i++) {
    const x = -5.5 + i * 0.51 + ice.rng.range(-0.11, 0.11);
    const y = 7.15 - ice.rng.range(0, 0.13);
    const length = ice.rng.range(0.27, 1.04);
    ice.rod(
      [x, y, -13.68],
      [x + 0.053, y - length, -13.51],
      length * 0.145,
      0xa3cfed,
      "solid",
      0.003,
      6,
    );
  }
  for (const [x, z] of [
    [-7.26, 1.68],
    [6.48, 3.1],
    [2.05, -2.17],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      const dx = ice.rng.range(-0.55, 0.55);
      const dz = ice.rng.range(-0.48, 0.48);
      const h = ice.rng.range(0.25, 0.91);
      ice.rod(
        [x + dx, 0, z + dz],
        [x + dx * 1.42, h, z + dz * 1.2],
        h * 0.26,
        0x83c0df,
        "solid",
        0.003,
        5,
      );
    }
  }
  stage.group.add(ice.finish("hanging-ice"));
}

function lavaChasm(stage: Staging): void {
  const molten = new DungeonMesh(stage.rng.seed(), 2);
  for (const x of [2.08, 5.91]) {
    for (let d = 0; d < 18; d++) {
      const z = -1.28 + d * 0.42;
      const floor = -0.16 - molten.rng.range(0.02, 0.2);
      const length = molten.rng.range(0.21, 0.55);
      molten.rod(
        [x, floor, z],
        [x + (x < 4 ? 1 : -1) * length, floor - molten.rng.range(0.13, 0.42), z + 0.16],
        molten.rng.range(0.03, 0.097),
        d % 4 ? 0xe94112 : 0xffad29,
        "glow",
        0.011,
        5,
      );
    }
  }
  stage.group.add(molten.finish("lava-runoff"));
  stage.light(4.1, -0.38, 3.89, 44);
}

export function buildDungeonScene(
  id: keyof typeof dungeonScenes,
  seed: number,
  theme: number,
): IStylizedScene {
  const stage = staging(seed, theme);
  stage.group.name = `dungeon-${id}`;
  const assembly = id === "assembly";
  if (assembly) {
    layout(stage);
    pit(stage, seed, theme, 0, 0);
  } else {
    courtyard(stage);
    pit(stage, seed, theme, 4, 0);
    pit(stage, seed + 1, theme, 4, 4);
    const dressing = [hangingFerns, frozenArch, lavaChasm][theme];
    dressing?.(stage);
  }
  climate(stage, theme, assembly);
  const sky = [0x283646, 0x1b365a, 0x442222][theme] ?? 0x283646;
  const horizon = [0x192331, 0x152742, 0x301c23][theme] ?? 0x192331;
  const view: IStylizedScene["view"] = assembly
    ? { pos: [25, 33, 34], target: [0, 0, 0] }
    : { pos: [6.55, 4.15, 10.3], target: [-0.93, 2.15, -7.9] };
  if (!assembly && theme === 2) {
    view.pos = [6.9, 7.75, 13.45];
    view.target = [-0.48, 0.6, -5.2];
  }
  return {
    group: stage.group,
    view,
    env: {
      skyTop: sky,
      horizon,
      fog: [horizon, assembly ? 60 : 20, assembly ? 125 : 67],
      hemi: { sky: 0xb2c9e4, ground: 0x6a4a43, intensity: assembly ? 1.87 : 1.37 },
      sun: { dir: [-0.5, 0.71, -0.44], color: 0xabc8f4, intensity: assembly ? 2.4 : 2.52 },
      shadow: assembly ? 29 : 23,
    },
  };
}
