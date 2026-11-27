import {
  BufferAttribute,
  CylinderGeometry,
  Group,
  MeshStandardMaterial,
  Object3D,
  Vector2,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import { buildCooperage, cooperageModules } from "./cooperage.js";
import type {
  IFurnitureWoodMaps,
  IStaticKitMaterialOptions,
  WoodFinish,
} from "./static-kit-materials.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeTavernOptions extends IStaticKitMaterialOptions<Finish> {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for board tones, grain offsets and worn edges. */
  readonly seed?: number;
  /** Six-digit CSS hex tint for the scanned timber. */
  readonly accent?: string;
  /** Uniform scale from 0.5 to 2. Use the same scale across a counter run. */
  readonly scale?: number;
  /** Width or wooden vessel diameter in metres before scale. Body height stays fixed. */
  readonly width?: number;
  /** Set the storage barrel's removable lid beside it for inspection. */
  readonly open?: boolean;
  readonly woodFinish?: WoodFinish;
}

export const tavernAccent = "#756957";
export const tavernIron = "#37322d";
export const tavernWoodRoughness = 0.88;
const tableWidth = { min: 1.45, max: 2.4, default: 1.88 };
export const tavernModules = [
  { id: "table", name: "Tavern trestle table", category: "Dining", width: tableWidth },
  {
    id: "bench",
    name: "Tavern plank bench",
    category: "Seating",
    width: { min: 1.12, max: 2.08, default: 1.62 },
  },
  {
    id: "counter",
    name: "Tavern serving counter",
    category: "Work surfaces",
    width: { min: 1.2, max: 2.4, default: 1.78 },
  },
  { id: "dining-set", name: "Tavern dining set", category: "Arrangements", width: tableWidth },
  ...cooperageModules,
] as const;

type Module = (typeof tavernModules)[number]["id"];
type Finish = "wood" | "iron";
type Part = StaticKitMesh<Finish>;
type Palette = Record<Finish, MeshStandardMaterial>;

function timber(mesh: Part, rng: RNG, size: XYZ, center: XYZ, grain = 0, rotation = 0): void {
  const bevel = Math.min(0.014, Math.min(...size) * rng.range(0.11, 0.19));
  const board = new RoundedBoxGeometry(...size, 1, bevel);
  const p = board.getAttribute("position");
  const n = board.getAttribute("normal");
  const uv = board.getAttribute("uv");
  const colors = new Float32Array(p.count * 3);
  const shiftU = rng.range(0, 1);
  const shiftV = rng.range(0, 1);
  const tone = rng.range(0.67, 1);
  for (let i = 0; i < p.count; i++) {
    const [nx, ny, nz] = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const facing = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    const end = facing === grain;
    const u = end ? (facing === 0 ? 2 : 0) : grain;
    const v = 3 - facing - u;
    uv.setXY(i, shiftU + p.getComponent(i, u) * 0.9, shiftV + p.getComponent(i, v) * 1.65);
    colors.fill(end ? tone * 0.76 : tone, i * 3, i * 3 + 3);
  }
  board.setAttribute("color", new BufferAttribute(colors, 3));
  if (rotation) board.rotateZ(rotation);
  mesh.add("wood", board.translate(...center));
}

function brace(mesh: Part, rng: RNG, from: XYZ, to: XYZ): void {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  timber(
    mesh,
    rng,
    [0.071, Math.hypot(dx, dy), 0.074],
    [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, from[2]],
    1,
    -Math.atan2(dx, dy),
  );
}

function nail(mesh: Part, x: number, y: number, z: number): void {
  mesh.add("iron", new CylinderGeometry(0.0075, 0.0075, 0.003, 8).translate(x, y, z));
}

function anchor(group: Group, name: string, center: XYZ, yaw = 0): void {
  const node = new Object3D();
  node.name = name;
  node.position.set(...center);
  node.rotation.y = yaw;
  group.add(node);
}

function table(palette: Palette, width: number, seed: number): Group {
  const rng = new RNG(seed);
  const mesh = new StaticKitMesh<Finish>();
  const top = 0.754;
  const span = width / 2 - 0.27;
  for (const z of [-0.32, -0.16, 0, 0.16, 0.32]) {
    timber(mesh, rng, [width, 0.067, 0.156], [0, top - 0.0335, z]);
    for (const x of [-span, span]) nail(mesh, x, top - 0.001, z);
  }
  for (const side of [-1, 1]) {
    const x = side * span;
    timber(mesh, rng, [0.154, 0.095, 0.68], [x, 0.0475, 0], 2);
    timber(mesh, rng, [0.139, 0.618, 0.136], [x, 0.387, 0], 1);
    timber(mesh, rng, [0.172, 0.076, 0.701], [x, 0.675, 0], 2);
    brace(mesh, rng, [x, 0.4, 0], [x - side * 0.275, 0.661, 0]);
    timber(mesh, rng, [0.026, 0.131, 0.076], [x + side * 0.095, 0.263, 0], 1, side * 0.13);
  }
  timber(mesh, rng, [2 * span + 0.239, 0.115, 0.088], [0, 0.249, 0]);
  const group = mesh.finish("tavern-table", palette);
  anchor(group, "tavern-tabletop", [0, top, 0]);
  return group;
}

function bench(palette: Palette, width: number, seed: number, prefix = "bench"): Group {
  const rng = new RNG(seed);
  const mesh = new StaticKitMesh<Finish>();
  const seat = 0.456;
  const span = width / 2 - 0.164;
  for (const z of [-0.094, 0.094]) {
    timber(mesh, rng, [width, 0.058, 0.182], [0, seat - 0.029, z]);
    for (const x of [-span, span]) nail(mesh, x, seat - 0.001, z);
  }
  for (const x of [-span, span]) {
    timber(mesh, rng, [0.117, 0.071, 0.342], [x, 0.0355, 0], 2);
    timber(mesh, rng, [0.096, 0.348, 0.097], [x, 0.231, 0], 1);
    timber(mesh, rng, [0.12, 0.065, 0.345], [x, 0.38, 0], 2);
  }
  timber(mesh, rng, [2 * span + 0.15, 0.081, 0.071], [0, 0.195, 0]);
  const group = mesh.finish(prefix, palette);
  anchor(group, `${prefix}-seat-left`, [-width / 4, seat, 0.07]);
  anchor(group, `${prefix}-seat-right`, [width / 4, seat, 0.07]);
  return group;
}

function counter(palette: Palette, width: number, seed: number): Group {
  const rng = new RNG(seed);
  const mesh = new StaticKitMesh<Finish>();
  const top = 1.042;
  const side = width / 2 - 0.061;
  const inner = width - 0.199;
  for (const z of [-0.24, -0.08, 0.08, 0.24]) {
    timber(mesh, rng, [width, 0.058, 0.157], [0, top - 0.029, z]);
    for (const x of [-side, side]) nail(mesh, x, top - 0.001, z);
  }
  for (const x of [-side, side]) {
    for (const z of [-0.242, 0.246]) timber(mesh, rng, [0.091, 0.993, 0.087], [x, 0.4965, z], 1);
    timber(mesh, rng, [0.037, 0.788, 0.461], [x, 0.519, 0.006], 1);
    timber(mesh, rng, [0.071, 0.105, 0.505], [x, 0.946, 0.004], 2);
  }
  const boards = Math.round(inner / 0.141);
  const pitch = inner / boards;
  for (let i = 0; i < boards; i++) {
    const x = (i + 0.5) * pitch - inner / 2;
    timber(mesh, rng, [pitch - 0.004, 0.758, 0.035], [x, 0.529, 0.252], 1);
  }
  timber(mesh, rng, [inner, 0.751, 0.016], [0, 0.529, 0.232]);
  for (const y of [0.168, 0.946]) {
    timber(mesh, rng, [width - 0.106, 0.105, 0.068], [0, y, 0.256]);
  }
  for (const y of [0.176, 0.487]) {
    timber(mesh, rng, [inner + 0.02, 0.045, 0.485], [0, y - 0.0225, 0]);
    for (const x of [-side, side]) timber(mesh, rng, [0.075, 0.066, 0.512], [x, y - 0.063, 0], 2);
    timber(mesh, rng, [inner + 0.056, 0.054, 0.049], [0, y - 0.059, -0.169]);
  }
  const group = mesh.finish("tavern-counter", palette);
  anchor(group, "counter-surface", [0, top, 0.064]);
  anchor(group, "counter-shelf", [0, 0.487, -0.063], Math.PI);
  anchor(group, "counter-join-left", [-width / 2, top, 0], -Math.PI / 2);
  anchor(group, "counter-join-right", [width / 2, top, 0], Math.PI / 2);
  return group;
}

export function buildTavern(
  id: Module,
  options: Required<Pick<IBakeTavernOptions, "seed" | "accent" | "scale" | "width">> &
    Pick<IBakeTavernOptions, "open">,
  scan?: IFurnitureWoodMaps,
): Group {
  const { accent, seed, scale, width } = options;
  const palette: Palette = {
    wood: new MeshStandardMaterial({
      name: "Tavern worn timber",
      color: accent,
      vertexColors: true,
      roughness: tavernWoodRoughness,
      map: scan?.color ?? null,
      normalMap: scan?.normal ?? null,
      normalScale: new Vector2(0.88, 0.88),
    }),
    iron: new MeshStandardMaterial({
      name: "Tavern forged iron",
      color: tavernIron,
      metalness: 0.56,
      roughness: 0.69,
    }),
  };
  const builders = {
    table: () => table(palette, width, seed),
    bench: () => bench(palette, width, seed),
    counter: () => counter(palette, width, seed),
    "dining-set": () => {
      const north = bench(palette, width - 0.172, seed, "north-bench");
      const south = bench(palette, width - 0.172, (seed + 1) >>> 0, "south-bench");
      north.position.z = -0.667;
      south.position.z = 0.667;
      south.rotation.y = Math.PI;
      return new Group().add(table(palette, width, seed), north, south);
    },
    barrel: () => buildCooperage("barrel", width, new RNG(seed), palette, options.open === true),
    bucket: () => buildCooperage("bucket", width, new RNG(seed), palette, false),
    tankard: () => buildCooperage("tankard", width, new RNG(seed), palette, false),
  };
  const group = builders[id]();
  group.name = `tavern-${id}`;
  group.scale.setScalar(scale);
  return group;
}
