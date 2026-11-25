import {
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
} from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeFrontierOptions {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for material tone and the ore cluster. Default 1. */
  readonly seed?: number;
  /** Team paint as a six-digit CSS hex color. Default "#e6a44b". */
  readonly accent?: string;
  /** Uniform scale multiplier from 0.5 to 2. Default 1. */
  readonly scale?: number;
}

export const frontierAccent = "#e6a44b";
export const frontierModules = [
  { id: "command", name: "Frontier command headquarters", category: "Buildings" },
  { id: "depot", name: "Frontier supply depot", category: "Buildings" },
  { id: "processor", name: "Frontier ore processor", category: "Buildings" },
  { id: "generator", name: "Frontier power generator", category: "Utilities" },
  { id: "relay", name: "Frontier communications relay", category: "Utilities" },
  { id: "ore", name: "Frontier crystal ore deposit", category: "Resources" },
  { id: "landing-pad", name: "Frontier landing pad", category: "Utilities" },
  { id: "outpost", name: "Frontier logistics outpost", category: "Scenes" },
] as const;

type Module = (typeof frontierModules)[number]["id"];
type Finish = "base" | "panel" | "dark" | "accent" | "window" | "crystal" | "rock" | "decal";
type Hull = StaticKitMesh<Finish>;

function materials(accent: string, rng: RNG): Record<Finish, MeshStandardMaterial> {
  const paint = (name: string, color: Color | number, metalness = 0.14) =>
    new MeshStandardMaterial({ name, color, roughness: 0.65, metalness });
  return {
    base: paint("Frontier structural metal", 0x4c5761, 0.35),
    panel: paint("Frontier ceramic panels", new Color(0xd8d0bf).multiplyScalar(rng.range(0.87, 1))),
    dark: paint("Frontier graphite equipment", 0x253039),
    accent: paint("Frontier team paint", new Color(accent)),
    window: new MeshStandardMaterial({
      name: "Frontier blue windows",
      color: 0x58a6b5,
      roughness: 0.34,
      emissive: 0x336b8e,
      emissiveIntensity: 0.62,
    }),
    crystal: new MeshStandardMaterial({
      name: "Frontier cobalt ore",
      color: 0x29abc4,
      flatShading: true,
      roughness: 0.38,
      emissive: 0x153d58,
      emissiveIntensity: 0.45,
    }),
    rock: paint("Frontier slate aggregate", 0x414a50, 0),
    decal: paint("Frontier ivory wayfinding", 0xffedcc, 0),
  };
}

function drum(mesh: Hull, finish: Finish, center: XYZ, radius: number, height: number, sides = 12) {
  mesh.add(finish, new CylinderGeometry(radius, radius, height, sides).translate(...center));
}

function footing(mesh: Hull, width: number, depth: number): void {
  mesh.block("base", [width, 0.36, depth], [0, 0.18, 0], 0.14);
  mesh.block("dark", [width * 0.92, 0.16, depth * 0.9], [0, 0.39, 0], 0.06);
}

function command(mesh: Hull): void {
  footing(mesh, 7.8, 6.4);
  mesh.block("panel", [6.6, 2.38, 5.35], [0, 1.6, -0.05], 0.28);
  mesh.block("base", [4.5, 1.15, 3.85], [0, 3.12, -0.55], 0.21);
  mesh.block("dark", [4, 0.64, 0.15], [0, 3.28, 1.38], 0.045);
  for (const x of [-1.35, 0, 1.35]) mesh.block("window", [1.15, 0.4, 0.11], [x, 3.28, 1.48], 0.045);
  mesh.block("accent", [4.9, 0.26, 4.06], [0, 3.79, -0.53], 0.05);
  mesh.block("dark", [2.38, 1.58, 0.22], [0, 1.22, 2.65], 0.08);
  mesh.block("base", [2.12, 0.2, 0.44], [0, 0.42, 2.98], 0.06);
  for (const x of [-2.45, 2.45]) {
    mesh.block("accent", [0.68, 2.1, 0.6], [x, 1.46, 2.63], 0.09);
    mesh.block("dark", [0.74, 0.61, 1.44], [x, 2.88, -1.74], 0.08);
  }
  mesh.block("base", [4.8, 0.71, 0.2], [0, 1.1, -2.74], 0.06);
  for (const x of [-1.52, 0, 1.52]) {
    mesh.block("dark", [0.96, 0.36, 0.11], [x, 1.08, -2.87], 0.05);
    mesh.block("panel", [0.7, 0.045, 0.045], [x, 1.09, -2.94], 0.008);
  }
  drum(mesh, "base", [1.16, 4.16, -1.45], 0.39, 0.53, 8);
  drum(mesh, "dark", [1.16, 4.69, -1.45], 0.085, 1.09, 8);
  drum(mesh, "window", [1.16, 5.25, -1.45], 0.17, 0.15, 8);
}

function depot(mesh: Hull): void {
  footing(mesh, 5.85, 5);
  for (const x of [-1.34, 1.34]) {
    mesh.block("accent", [2.22, 1.64, 3.82], [x, 1.19, 0], 0.11);
    mesh.block("dark", [2.08, 0.29, 3.92], [x, 1.97, 0], 0.08);
    mesh.block("panel", [1.88, 1.1, 0.13], [x, 1.18, 1.94], 0.04);
    mesh.block("dark", [0.075, 0.9, 0.08], [x, 1.18, 2.025], 0.012);
    for (const z of [-1.2, 0, 1.2]) mesh.block("base", [2.28, 0.18, 0.19], [x, 2.12, z], 0.035);
  }
}

function processor(mesh: Hull): void {
  footing(mesh, 6.25, 5.2);
  mesh.block("panel", [4.85, 1.74, 3.3], [-0.27, 1.26, 0.23], 0.19);
  mesh.block("dark", [2.1, 1.17, 0.25], [-0.48, 1.04, 1.96], 0.09);
  mesh.block("accent", [2.5, 0.22, 0.52], [-0.48, 1.77, 1.98], 0.06);
  mesh.block("base", [1.24, 0.24, 1.54], [-0.48, 0.48, 1.66], 0.06);
  for (const x of [-1.63, 0.78]) {
    drum(mesh, "base", [x, 2.18, -0.64], 0.89, 0.54);
    drum(mesh, "panel", [x, 2.93, -0.64], 0.76, 1.1);
    drum(mesh, "accent", [x, 3.36, -0.64], 0.79, 0.22);
    drum(mesh, "dark", [x, 3.58, -0.64], 0.55, 0.2);
  }
  drum(mesh, "dark", [2.35, 2.45, -1.53], 0.29, 3.98, 8);
  drum(mesh, "accent", [2.35, 4.47, -1.53], 0.36, 0.21, 8);
}

function generator(mesh: Hull): void {
  footing(mesh, 4.4, 4.32);
  drum(mesh, "dark", [0, 0.69, 0], 1.77, 0.55);
  drum(mesh, "base", [0, 1.31, 0], 1.4, 1.16);
  for (const y of [1.02, 1.37, 1.72]) drum(mesh, "window", [0, y, 0], 1.43, 0.13);
  drum(mesh, "base", [0, 1.98, 0], 1.61, 0.27);
  drum(mesh, "accent", [0, 2.17, 0], 1.27, 0.22);
  drum(mesh, "panel", [0, 2.34, 0], 0.93, 0.2);
  for (const x of [-1.56, 1.56]) mesh.block("accent", [0.48, 0.62, 1.72], [x, 0.64, 0], 0.09);
}

function relay(mesh: Hull): void {
  footing(mesh, 3.26, 3.26);
  drum(mesh, "panel", [0, 0.97, 0], 0.96, 1.1, 8);
  drum(mesh, "accent", [0, 1.53, 0], 0.98, 0.22, 8);
  const mast = new CylinderGeometry(0.19, 0.43, 3.2, 6).translate(0, 3.04, 0);
  mesh.add("base", mast);
  mesh.block("accent", [2.26, 0.28, 0.44], [0, 4.02, 0], 0.06);
  for (const x of [-0.98, 0.98]) {
    mesh.block("panel", [0.38, 1.35, 0.16], [x, 4.03, 0.1], 0.065);
    mesh.block("dark", [0.1, 1.17, 0.05], [x, 4.03, 0.19], 0.012);
  }
  drum(mesh, "window", [0, 4.73, 0], 0.26, 0.24, 8);
}

function ore(mesh: Hull, rng: RNG): void {
  const bed = new IcosahedronGeometry(1, 1).scale(1.48, 0.48, 1.35);
  const points = bed.getAttribute("position");
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const z = points.getZ(i);
    const ridge = Math.sin(x * 7 + z * 4);
    points.setXYZ(i, x * (1 + ridge * 0.13), Math.max(0, points.getY(i) + 0.01), z);
  }
  bed.computeVertexNormals();
  mesh.add("rock", bed);
  const ground = new Mesh(bed);
  const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
  const foot = new Vector3();
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.39;
    const radius = Math.sqrt(i / 7) * 1.18;
    const length = rng.range(0.5, 1.05) * (i === 0 ? 1.45 : 1);
    const gem = new IcosahedronGeometry(1)
      .scale(0.26, length, 0.25)
      .rotateZ(rng.range(-0.32, 0.32))
      .rotateY(angle)
      .translate(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    const crystal = gem.getAttribute("position");
    let bottom = 0;
    for (let v = 1; v < crystal.count; v++) if (crystal.getY(v) < crystal.getY(bottom)) bottom = v;
    foot.fromBufferAttribute(crystal, bottom);
    const distance = Math.hypot(foot.x, foot.z);
    const reach = Math.min(1, 1.04 / distance);
    ray.ray.origin.set(foot.x * reach, 2, foot.z * reach);
    const contact = ray.intersectObject(ground)[0];
    if (!contact) throw new Error("Frontier ore crystal is outside the rock bed");
    gem.translate(
      contact.point.x - foot.x,
      Math.max(0.005, contact.point.y - 0.25) - foot.y,
      contact.point.z - foot.z,
    );
    mesh.add("crystal", gem);
    const chip = new IcosahedronGeometry(1)
      .scale(rng.range(0.33, 0.57), rng.range(0.2, 0.34), rng.range(0.29, 0.49))
      .rotateY(angle + 0.7)
      .translate(Math.cos(angle) * 1.24, 0.08, Math.sin(angle) * 1.2);
    const vertices = chip.getAttribute("position");
    for (let v = 0; v < vertices.count; v++) vertices.setY(v, Math.max(0, vertices.getY(v)));
    chip.computeVertexNormals();
    mesh.add("rock", chip);
  }
}

function landingPad(mesh: Hull): void {
  drum(mesh, "base", [0, 0.21, 0], 3.78, 0.42, 8);
  drum(mesh, "dark", [0, 0.425, 0], 3.44, 0.16, 8);
  for (const x of [-0.65, 0.65]) mesh.block("decal", [0.23, 0.035, 2.08], [x, 0.517, 0], 0);
  mesh.block("decal", [1.07, 0.035, 0.23], [0, 0.517, 0], 0);
  for (const sign of [-1, 1]) {
    mesh.block("accent", [1.6, 0.038, 0.19], [0, 0.52, sign * 2.78], 0);
    mesh.block("window", [0.19, 0.062, 0.74], [sign * 2.9, 0.513, 0], 0.015);
  }
}

const pieces = { command, depot, processor, generator, relay, ore, "landing-pad": landingPad };

export function buildFrontier(
  id: Module,
  { seed, accent, scale }: { seed: number; accent: string; scale: number },
): Group {
  const rng = new RNG(seed);
  const palette = materials(accent, rng);
  const piece = (name: keyof typeof pieces) => {
    const mesh = new StaticKitMesh<Finish>();
    pieces[name](mesh, rng);
    return mesh.finish(`frontier-${name}`, palette);
  };
  if (id !== "outpost") {
    const asset = piece(id);
    asset.scale.setScalar(scale);
    return asset;
  }
  const layout = new Group();
  layout.name = "frontier-outpost";
  layout.scale.setScalar(scale);
  const placements = [
    ["command", 0, -4.75, 0],
    ["depot", -7.3, -2.1, 0],
    ["processor", 7.1, -3, 0],
    ["generator", 6.5, 3.25, 0],
    ["relay", -5.7, 3.25, Math.PI / 4],
    ["landing-pad", 0, 5.5, 0],
    ["ore", 10.3, 1.6, 0],
  ] as const;
  for (const [name, x, z, yaw] of placements) {
    const asset = piece(name);
    asset.position.set(x, 0, z);
    asset.rotation.y = yaw;
    layout.add(asset);
  }
  const paths = new StaticKitMesh<Finish>();
  paths.block("base", [8.38, 0.07, 1.35], [-0.18, 0.035, -0.38], 0);
  paths.block("base", [1.54, 0.07, 0.49], [0, 0.035, -1.3], 0);
  paths.block("base", [1.54, 0.07, 1.43], [0, 0.035, 1.01], 0);
  for (const x of [-3.4, -2.52, -1.64, 1.56, 2.44, 3.32])
    paths.block("decal", [0.34, 0.013, 0.056], [x, 0.07, -0.38], 0);
  paths.block("accent", [0.056, 0.013, 0.62], [0, 0.07, 0.91], 0);
  layout.add(paths.finish("frontier-service-lanes", palette));
  return layout;
}
