import { BoxGeometry, type BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RNG } from "../vendor/stylized-biome-kit/core.js";

export interface IBakeStationOptions {
  /** Module id from environmentElements({ kind: "station" }). */
  readonly module: string;
  /** Directory to write the GLB to. */
  readonly out: string;
  /** Unsigned 32-bit seed for subtle paint variation. Default 1. */
  readonly seed?: number;
  /** Six-digit CSS hex color for paint and fixtures. Default "#25b9c8". */
  readonly accent?: string;
  /** Fit overhead panels to corridor tiles and the assembled layout. Default false. */
  readonly roof?: boolean;
}

const DIRECTIONS = ["north", "east", "south", "west"] as const;
type Direction = (typeof DIRECTIONS)[number];

const CORRIDORS = {
  straight: ["north", "south"],
  elbow: ["north", "east"],
  tee: ["north", "east", "west"],
  cross: DIRECTIONS,
} satisfies Record<string, readonly Direction[]>;

export const stationModules = [
  { id: "floor", name: "Station deck floor", category: "Architecture" },
  { id: "wall", name: "Station service wall", category: "Architecture" },
  { id: "bulkhead", name: "Station bulkhead doorway", category: "Architecture" },
  { id: "ceiling", name: "Station ceiling panel", category: "Architecture" },
  { id: "straight", name: "Station straight corridor", category: "Corridors" },
  { id: "elbow", name: "Station corridor elbow", category: "Corridors" },
  { id: "tee", name: "Station corridor T-junction", category: "Corridors" },
  { id: "cross", name: "Station four-way corridor", category: "Corridors" },
  { id: "cargo", name: "Station cargo case", category: "Props" },
  { id: "terminal", name: "Station control terminal", category: "Props" },
  { id: "power-cell", name: "Station power cell", category: "Props" },
  { id: "layout", name: "Station maintenance junction", category: "Scenes" },
] as const;

type Module = (typeof stationModules)[number]["id"];
type Finish = "hull" | "panel" | "inset" | "rubber" | "accent" | "stripe" | "light";
type XYZ = [number, number, number];
export const stationRoofModules = [
  ...Object.keys(CORRIDORS).map((id) => `station-${id}`),
  "station-layout",
];
export const stationAccent = "#25b9c8";

function squareBlock(size: XYZ): BufferGeometry {
  const indexed = new BoxGeometry(...size);
  const shape = indexed.toNonIndexed();
  indexed.dispose();
  return shape;
}

function stationMaterials(accent: string, seed: number): Record<Finish, MeshStandardMaterial> {
  const tint = new Color(accent);
  const rng = new RNG(seed);
  const painted = (name: string, color: number | Color, metalness = 0.15, roughness = 0.65) =>
    new MeshStandardMaterial({ name, color, metalness, roughness });
  return {
    hull: painted("Station structural alloy", 0x566878, 0.4),
    panel: painted("Station ceramic paint", new Color(0xd6dfe2).multiplyScalar(rng.range(0.85, 1))),
    inset: painted("Station graphite panels", 0x283748, 0.28),
    rubber: painted("Station rubber and gaskets", 0x151f2b, 0, 0.87),
    accent: painted("Station accent enamel", tint),
    stripe: painted("Station safety markings", 0xf8b748),
    light: new MeshStandardMaterial({
      name: "Station light strips",
      color: tint.clone().lerp(new Color(0xffffff), 0.65),
      emissive: tint,
      emissiveIntensity: 1.5,
      roughness: 0.4,
    }),
  };
}

class StationMesh {
  private readonly parts = new Map<Finish, BufferGeometry[]>();

  block(finish: Finish, size: XYZ, center: XYZ, bevel = 0.035, tilt = 0): void {
    const shape = bevel > 0.018 ? new RoundedBoxGeometry(...size, 1, bevel) : squareBlock(size);
    if (tilt) shape.rotateZ(tilt);
    shape.translate(...center);
    const bucket = this.parts.get(finish);
    if (bucket) bucket.push(shape);
    else this.parts.set(finish, [shape]);
  }

  finish(name: string, materials: Record<Finish, MeshStandardMaterial>): Group {
    const group = new Group();
    group.name = name;
    for (const [finish, shapes] of this.parts) {
      const geometry = mergeGeometries(shapes);
      for (const shape of shapes) shape.dispose();
      if (!geometry) throw new Error(`Could not merge ${name} ${finish}`);
      const mesh = new Mesh(geometry, materials[finish]);
      mesh.name = materials[finish].name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

function floor(mesh: StationMesh): void {
  mesh.block("hull", [4, 0.18, 4], [0, 0.09, 0], 0.015);
  for (const x of [-1.5, -0.5, 0.5, 1.5]) {
    for (const z of [-1.5, -0.5, 0.5, 1.5])
      mesh.block("inset", [0.96, 0.07, 0.96], [x, 0.215, z], 0.015);
  }
  for (const side of [-1, 1]) {
    for (const lane of [-0.88, 0.88]) {
      mesh.block("stripe", [0.075, 0.02, 0.26], [lane, 0.244, side * 1.8], 0.005);
      mesh.block("stripe", [0.26, 0.02, 0.075], [side * 1.8, 0.244, lane], 0.005);
    }
  }
}

/** Wall face along X. Centered on its depth, with details facing +Z. */
function wall(mesh: StationMesh): void {
  mesh.block("hull", [4, 3.2, 0.24], [0, 1.6, 0]);
  mesh.block("rubber", [3.92, 0.34, 0.29], [0, 0.23, 0.04]);
  mesh.block("inset", [3.68, 0.55, 0.13], [0, 0.72, 0.15]);
  mesh.block("accent", [3.72, 0.105, 0.065], [0, 1.11, 0.151], 0.015);
  for (const x of [-1.31, 0, 1.31]) {
    mesh.block("panel", [1.25, 1.42, 0.17], [x, 1.92, 0.14], 0.08);
    mesh.block("inset", [0.88, 0.12, 0.015], [x, 1.4, 0.23], 0.007);
    mesh.block("inset", [1.19, 1.94, 0.06], [x, 1.59, -0.12], 0.025);
  }
  mesh.block("inset", [3.72, 0.31, 0.13], [0, 2.92, 0.16], 0.045);
  for (const x of [-1.24, 1.24]) mesh.block("light", [0.71, 0.07, 0.03], [x, 2.92, 0.232], 0.01);
}

function bulkhead(mesh: StationMesh): void {
  mesh.block("hull", [4, 0.48, 0.38], [0, 2.96, 0], 0.05);
  mesh.block("accent", [2.83, 0.18, 0.08], [0, 2.96, 0.21]);
  mesh.block("light", [0.84, 0.07, 0.03], [0, 2.96, 0.26], 0.01);
  for (const side of [-1, 1]) {
    const x = side * 1.7;
    mesh.block("hull", [0.6, 2.72, 0.38], [x, 1.36, 0], 0.065);
    mesh.block("panel", [0.36, 2.24, 0.1], [x, 1.54, 0.21], 0.045);
    mesh.block("rubber", [0.2, 0.46, 0.045], [x, 0.54, 0.27], 0.018);
    for (const y of [0.43, 0.54, 0.65])
      mesh.block("stripe", [0.15, 0.042, 0.02], [x, y, 0.298], 0.008, side * 0.38);
    mesh.block("light", [0.052, 0.58, 0.023], [x, 1.89, 0.27], 0.01);
  }
}

function ceiling(mesh: StationMesh): void {
  mesh.block("hull", [4, 0.18, 4], [0, 0.17, 0]);
  mesh.block("inset", [1.38, 0.14, 3.98], [0, 0.08, 0]);
  for (const x of [-0.95, 0.95]) {
    mesh.block("panel", [0.43, 0.18, 3.84], [x, 0.135, 0]);
    mesh.block("light", [0.15, 0.05, 3.68], [x, 0.025, 0], 0.015);
    mesh.block("inset", [0.58, 0.07, 3.72], [x, 0.28, 0], 0.03);
    for (const z of [-1.38, 1.38]) mesh.block("accent", [0.47, 0.025, 0.15], [x, 0.32, z], 0.007);
  }
}

function cargo(mesh: StationMesh): void {
  mesh.block("accent", [1.14, 0.7, 0.77], [0, 0.37, 0], 0.095);
  for (const y of [0.08, 0.68]) mesh.block("inset", [1.22, 0.16, 0.84], [0, y, 0], 0.05);
  for (const x of [-0.43, 0.43]) mesh.block("panel", [0.09, 0.55, 0.81], [x, 0.37, 0], 0.04);
  mesh.block("rubber", [0.49, 0.23, 0.054], [0, 0.38, 0.395], 0.025);
  mesh.block("stripe", [0.27, 0.04, 0.025], [0, 0.42, 0.43], 0.007);
  mesh.block("hull", [0.17, 0.035, 0.025], [-0.05, 0.35, 0.43], 0.007);
}

function terminal(mesh: StationMesh): void {
  mesh.block("rubber", [0.64, 0.14, 0.49], [0, 0.07, 0], 0.055);
  mesh.block("hull", [0.36, 0.97, 0.29], [0, 0.57, -0.065], 0.06);
  mesh.block("panel", [0.65, 0.49, 0.4], [0, 1.11, 0], 0.07);
  mesh.block("inset", [0.5, 0.31, 0.027], [0, 1.16, 0.213], 0.014);
  mesh.block("accent", [0.43, 0.24, 0.017], [0, 1.16, 0.232], 0.007);
  mesh.block("light", [0.24, 0.022, 0.01], [-0.062, 1.21, 0.245], 0.005);
  mesh.block("inset", [0.16, 0.016, 0.01], [-0.105, 1.15, 0.245], 0.004);
  for (const x of [-0.14, 0, 0.14])
    mesh.block("stripe", [0.06, 0.029, 0.02], [x, 0.935, 0.227], 0.009);
}

function powerCell(mesh: StationMesh): void {
  mesh.block("inset", [0.51, 0.81, 0.51], [0, 0.45, 0], 0.11);
  for (const y of [0.08, 0.82]) mesh.block("hull", [0.56, 0.16, 0.56], [0, y, 0], 0.071);
  for (const side of [-1, 1]) {
    mesh.block("light", [0.19, 0.43, 0.04], [0, 0.45, side * 0.265], 0.018);
    mesh.block("light", [0.04, 0.43, 0.19], [side * 0.265, 0.45, 0], 0.018);
  }
  mesh.block("stripe", [0.32, 0.06, 0.22], [0, 0.91, 0], 0.03);
}

const PIECES = { floor, wall, bulkhead, ceiling, cargo, terminal, "power-cell": powerCell };
type Corridor = keyof typeof CORRIDORS;

export function buildStation(
  id: Module,
  { seed, accent, roof }: { seed: number; accent: string; roof: boolean },
): Group {
  const palette = stationMaterials(accent, seed);
  const prototypes = new Map<keyof typeof PIECES, Group>();
  const piece = (part: keyof typeof PIECES) => {
    const known = prototypes.get(part);
    if (known) return known.clone();
    const mesh = new StationMesh();
    PIECES[part](mesh);
    const group = mesh.finish(`station-${part}`, palette);
    prototypes.set(part, group);
    return group.clone();
  };
  const corridor = (part: Corridor) => {
    const root = new Group();
    root.name = `station-${part}`;
    const sockets: readonly Direction[] = CORRIDORS[part];
    root.userData = { sockets, tileSize: 4, deckHeight: 0.25, doorwayWidth: 2.8 };
    root.add(piece("floor"));
    for (const [index, side] of DIRECTIONS.entries()) {
      const open = sockets.includes(side);
      const edge = piece(open ? "bulkhead" : "wall");
      const inset = open ? 1.79 : 1.71;
      const angle = (index * Math.PI) / 2;
      edge.position.set(
        Math.round(Math.sin(angle)) * inset,
        0,
        -Math.round(Math.cos(angle)) * inset,
      );
      edge.rotation.y = -angle;
      root.add(edge);
    }
    if (roof) {
      const cover = piece("ceiling");
      cover.position.y = 3.2;
      root.add(cover);
    }
    return root;
  };

  if (id === "layout") {
    const root = new Group();
    root.name = "station-layout";
    root.rotation.y = Math.PI;
    const center = corridor("tee");
    const north = corridor("straight");
    north.position.z = -4;
    const east = corridor("elbow");
    east.position.x = 4;
    east.rotation.y = Math.PI / 2;
    const west = corridor("straight");
    west.position.x = -4;
    west.rotation.y = Math.PI / 2;
    root.add(center, north, east, west);
    const crate = piece("cargo");
    crate.position.set(-1.2, 0.25, 1.11);
    const console = piece("terminal");
    console.position.set(0.8, 0.25, 1.25);
    console.rotation.y = Math.PI;
    const cell = piece("power-cell");
    cell.position.set(-1.24, 0.25, -3.2);
    root.add(crate, console, cell);
    return root;
  }
  return Object.hasOwn(CORRIDORS, id) ? corridor(id as Corridor) : piece(id as keyof typeof PIECES);
}
