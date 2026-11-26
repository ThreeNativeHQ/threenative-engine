import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  type Group,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import type { IStaticKitMaterialOptions } from "./static-kit-materials.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeMechanismOptions extends IStaticKitMaterialOptions<Finish> {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for finish variation. Default 1. */
  readonly seed?: number;
  /** Six-digit CSS hex color for the painted parts. */
  readonly accent?: string;
  /** Uniform scale multiplier from 0.5 to 2. Default 1. */
  readonly scale?: number;
  /** Light the emitter, receiver or cell socket indicators. Default false. */
  readonly active?: boolean;
}

export const mechanismAccent = "#dd8c37";
export const mechanismModules = [
  { id: "emitter", name: "Signal emitter", category: "Signal puzzles" },
  { id: "receiver", name: "Signal receiver", category: "Signal puzzles" },
  { id: "reflector", name: "Signal reflector", category: "Signal puzzles" },
  { id: "conveyor", name: "Modular conveyor belt", category: "Transport" },
  { id: "turntable", name: "Rotating transport deck", category: "Transport" },
  { id: "socket", name: "Power cell socket", category: "Sockets" },
] as const;
export const litMechanismModules = ["emitter", "receiver", "socket"];

type Module = (typeof mechanismModules)[number]["id"];
type Finish = "base" | "panel" | "rubber" | "accent" | "signal" | "steel" | "mark";
type Part = StaticKitMesh<Finish>;

const signalHeight = 0.72;
const beltHeight = 0.34;

function materials(
  accent: string,
  seed: number,
  active: boolean,
): Record<Finish, MeshStandardMaterial> {
  const tone = new RNG(seed).range(0.88, 1);
  const paint = (name: string, color: Color | number, metalness = 0, roughness = 0.64) =>
    new MeshStandardMaterial({ name, color, roughness, metalness });
  return {
    base: paint("Mechanism structural frame", new Color(0x404e5b).multiplyScalar(tone), 0.18),
    panel: paint("Mechanism light shell", 0xd6dadd),
    rubber: paint("Mechanism charcoal rubber", 0x1b2731, 0, 0.92),
    accent: paint("Mechanism accent paint", new Color(accent)),
    steel: paint("Mechanism polished steel", 0xaecad1, 0.45, 0.26),
    mark: paint("Mechanism direction markings", 0xffd98e),
    signal: new MeshStandardMaterial({
      name: "Mechanism signal",
      color: active ? 0x66e5b1 : 0x345461,
      roughness: 0.38,
      emissive: active ? 0x239c79 : 0,
      emissiveIntensity: 1.25,
    }),
  };
}

function drum(mesh: Part, finish: Finish, at: XYZ, radius: number, depth: number, face = false) {
  const shape = new CylinderGeometry(radius, radius, depth, 20);
  if (face) shape.rotateX(Math.PI / 2);
  mesh.add(finish, shape.translate(...at));
}

function anchor(group: Group, name: string, position: XYZ): void {
  const node = new Object3D();
  node.name = name;
  node.position.set(...position);
  group.add(node);
}

function signalStand(mesh: Part, mastZ = 0): void {
  mesh.block("base", [0.86, 0.14, 0.78], [0, 0.07, 0], 0.07);
  mesh.block("accent", [0.62, 0.065, 0.56], [0, 0.15, 0], 0.024);
  mesh.block("base", [0.22, 0.42, 0.25], [0, 0.36, mastZ], 0.042);
  for (const x of [-0.18, 0.18]) mesh.block("steel", [0.09, 0.12, 0.24], [x, 0.211, 0], 0.025);
}

function emitter(mesh: Part): void {
  signalStand(mesh);
  mesh.block("panel", [0.5, 0.39, 0.47], [0, signalHeight, -0.023], 0.058);
  drum(mesh, "base", [0, signalHeight, 0.212], 0.188, 0.095, true);
  drum(mesh, "accent", [0, signalHeight, 0.258], 0.155, 0.047, true);
  drum(mesh, "rubber", [0, signalHeight, 0.278], 0.12, 0.024, true);
  drum(mesh, "signal", [0, signalHeight, 0.291], 0.084, 0.026, true);
  mesh.block("accent", [0.16, 0.045, 0.025], [0, signalHeight, -0.258], 0.009);
}

function receiver(mesh: Part): void {
  signalStand(mesh);
  mesh.block("base", [0.55, 0.58, 0.26], [0, signalHeight, -0.015], 0.052);
  mesh.block("accent", [0.51, 0.52, 0.06], [0, signalHeight, 0.104], 0.026);
  mesh.block("rubber", [0.405, 0.413, 0.048], [0, signalHeight, 0.141], 0.02);
  mesh.block("signal", [0.31, 0.29, 0.032], [0, signalHeight, 0.17], 0.023);
  for (const x of [-0.091, 0, 0.091])
    mesh.block("base", [0.018, 0.198, 0.008], [x, signalHeight, 0.184], 0.004);
}

function reflector(mesh: Part): void {
  signalStand(mesh, -0.06);
  mesh.block("base", [0.75, 0.58, 0.13], [0, signalHeight, 0.03], 0.055);
  mesh.block("accent", [0.69, 0.51, 0.05], [0, signalHeight, 0.09], 0.023);
  mesh.block("steel", [0.56, 0.394, 0.032], [0, signalHeight, 0.118], 0.015);
  for (const x of [-0.337, 0.337])
    mesh.block("panel", [0.055, 0.2, 0.052], [x, signalHeight, 0.105], 0.016);
}

function conveyor(mesh: Part): void {
  for (const z of [-0.71, 0.71]) mesh.block("base", [1.02, 0.09, 0.25], [0, 0.045, z], 0.035);
  mesh.block("base", [1.08, 0.2, 1.984], [0, 0.205, 0], 0.015);
  mesh.block("rubber", [0.79, 0.064, 2], [0, 0.308, 0], 0.01);
  for (const x of [-0.478, 0.478]) mesh.block("accent", [0.1, 0.13, 2], [x, 0.292, 0], 0.015);
  for (let i = 0; i < 10; i++) {
    const z = -0.9 + i * 0.2;
    mesh.block("base", [0.76, 0.012, 0.025], [0, 0.337, z], 0.003);
  }
  for (const z of [-0.59, 0, 0.59]) {
    const arm = 0.19;
    for (const side of [-1, 1]) {
      const shape = new BoxGeometry(0.051, 0.013, arm);
      mesh.add("mark", shape.rotateY((side * Math.PI) / 4).translate(-side * 0.066, beltHeight, z));
    }
  }
}

function turntableBase(mesh: Part): void {
  drum(mesh, "base", [0, 0.115, 0], 0.88, 0.23);
  mesh.add(
    "accent",
    new TorusGeometry(0.827, 0.034, 8, 28).rotateX(-Math.PI / 2).translate(0, 0.228, 0),
  );
}

function turntableDeck(mesh: Part): void {
  drum(mesh, "rubber", [0, 0.045, 0], 0.735, 0.13);
  for (const x of [-0.38, 0.38]) mesh.block("mark", [0.052, 0.016, 0.91], [x, 0.109, 0], 0.005);
  mesh.block("steel", [0.3, 0.018, 0.13], [0, 0.108, 0], 0.016);
}

function socket(mesh: Part): void {
  mesh.block("base", [1.05, 0.18, 1.01], [0, 0.09, 0], 0.063);
  mesh.block("steel", [0.66, 0.09, 0.66], [0, 0.209, 0], 0.035);
  for (const x of [-0.391, 0.391]) {
    mesh.block("accent", [0.17, 0.19, 0.72], [x, 0.225, 0], 0.045);
    mesh.block("rubber", [0.125, 0.051, 0.61], [x, 0.311, 0], 0.02);
  }
  for (const z of [-0.411, 0.423]) mesh.block("signal", [0.31, 0.043, 0.05], [0, 0.181, z], 0.014);
}

const parts = { emitter, receiver, reflector, conveyor, turntable: turntableBase, socket };

export function buildMechanism(
  id: Module,
  { seed, accent, scale, active }: { seed: number; accent: string; scale: number; active: boolean },
): Group {
  const palette = materials(accent, seed, active);
  const mesh = new StaticKitMesh<Finish>();
  parts[id](mesh);
  const group = mesh.finish(`mechanism-${id}`, palette);
  group.scale.setScalar(scale);
  switch (id) {
    case "emitter":
      anchor(group, "signal-output", [0, signalHeight, 0.304]);
      break;
    case "receiver":
      anchor(group, "signal-input", [0, signalHeight, 0.189]);
      break;
    case "reflector":
      anchor(group, "signal-reflector", [0, signalHeight, 0.134]);
      break;
    case "conveyor":
      anchor(group, "belt-start", [0, beltHeight, -1]);
      anchor(group, "belt-end", [0, beltHeight, 1]);
      break;
    case "socket":
      anchor(group, "cell-dock", [0, 0.254, 0]);
      break;
    case "turntable": {
      const top = new StaticKitMesh<Finish>();
      turntableDeck(top);
      const deck = top.finish("turntable-deck", palette);
      deck.position.y = 0.23;
      group.add(deck);
      break;
    }
  }
  return group;
}
