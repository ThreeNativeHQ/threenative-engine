import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  type Group,
  MeshStandardMaterial,
  Object3D,
} from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import type { IStaticKitMaterialOptions } from "./static-kit-materials.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeRailOptions extends IStaticKitMaterialOptions<Finish> {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for timber and chassis finish variation. Default 1. */
  readonly seed?: number;
  /** Six-digit CSS hex color for the cart, bridge and buffer paint. */
  readonly accent?: string;
  /** Uniform scale multiplier from 0.5 to 2. Use the same scale across a route. */
  readonly scale?: number;
}

export const railAccent = "#ce7038";
export const railModules = [
  { id: "straight", name: "Straight railway track", category: "Track" },
  { id: "curve", name: "Quarter-turn railway track", category: "Track" },
  { id: "ramp", name: "Raised railway approach", category: "Track" },
  { id: "bridge", name: "Railway trestle bridge", category: "Track" },
  { id: "stop", name: "Railway buffer stop", category: "Track" },
  { id: "cart", name: "Open minecart", category: "Rolling stock" },
] as const;

type Module = (typeof railModules)[number]["id"];
type Finish = "wood" | "lightWood" | "iron" | "running" | "paint" | "mark" | "tread";
type Part = StaticKitMesh<Finish>;
type Track = (fraction: number) => { x: number; y: number; z: number; yaw: number };

const halfGauge = 0.49;
const railTop = 0.24;
const straight: Track = (t) => ({ x: 0, y: 0, z: 4 * t - 2, yaw: 0 });
const tracks: Record<Exclude<Module, "cart">, Track> = {
  straight,
  curve: (t) => {
    const yaw = t * Math.PI * 0.5;
    return { x: 4 - 4 * Math.cos(yaw), y: 0, z: -2 + 4 * Math.sin(yaw), yaw };
  },
  ramp: (t) => ({ ...straight(t), y: t * t * (3 - 2 * t) }),
  bridge: (t) => ({ ...straight(t), y: 1 }),
  stop: straight,
};

function materials(seed: number, accent: string): Record<Finish, MeshStandardMaterial> {
  const rng = new RNG(seed);
  const wood = new Color(0x69402a).multiplyScalar(rng.range(0.84, 1.17));
  const iron = new Color(0x37444a).multiplyScalar(rng.range(0.85, 1.15));
  const finish = (name: string, color: Color | number, metalness = 0.05, roughness = 0.74) =>
    new MeshStandardMaterial({ name, color, metalness, roughness });
  return {
    wood: finish("Rail dark timber", wood),
    lightWood: finish("Rail light timber", wood.clone().multiplyScalar(1.42)),
    iron: finish("Rail structural iron", iron, 0.28),
    running: finish("Rail running surface", 0xb1c1c5, 0.42, 0.34),
    paint: finish("Rail painted metal", new Color(accent), 0.18, 0.53),
    mark: finish("Rail buffer markings", 0xf4ce83),
    tread: finish("Rail wheel tread", 0x647581, 0.42, 0.48),
  };
}

function quad(positions: number[], a: XYZ, b: XYZ, c: XYZ, d: XYZ): void {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function faceted(positions: number[]): BufferGeometry {
  const shape = new BufferGeometry();
  shape.setAttribute("position", new Float32BufferAttribute(positions, 3));
  shape.setAttribute(
    "uv",
    new Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2),
  );
  shape.computeVertexNormals();
  return shape;
}

// Sweep the same cross-section along either track so rail ends share a profile.
function beam(
  track: Track,
  steps: number,
  offset: number,
  width: number,
  bottom: number,
  top: number,
): BufferGeometry {
  const section = (t: number): [XYZ, XYZ, XYZ, XYZ] => {
    const { x, y, z, yaw } = track(t);
    const edge = (dx: number, dy: number): XYZ => [
      x + (offset + dx) * Math.cos(yaw),
      Math.max(0, y + dy),
      z - (offset + dx) * Math.sin(yaw),
    ];
    return [
      edge(-width / 2, bottom),
      edge(width / 2, bottom),
      edge(width / 2, top),
      edge(-width / 2, top),
    ];
  };

  const positions: number[] = [];
  let [a, b, c, d] = section(0);
  quad(positions, d, c, b, a);
  for (let step = 1; step <= steps; step++) {
    const [e, f, g, h] = section(step / steps);
    quad(positions, a, b, f, e);
    quad(positions, b, c, g, f);
    quad(positions, c, d, h, g);
    quad(positions, d, a, e, h);
    [a, b, c, d] = [e, f, g, h];
  }
  quad(positions, a, b, c, d);
  return faceted(positions);
}

function buildTrack(mesh: Part, id: Exclude<Module, "cart">): void {
  const track = tracks[id];
  const steps = id === "curve" ? 24 : id === "ramp" ? 20 : 1;
  const sleepers = id === "curve" ? 12 : 8;
  for (let i = 0; i < sleepers; i++) {
    const t = (i + 0.5) / sleepers;
    const { x, y, z, yaw } = track(t);
    const pitch = id === "ramp" ? -Math.atan(1.5 * t * (1 - t)) : 0;
    const tie = new BoxGeometry(1.54, 0.116, 0.218)
      .rotateX(pitch)
      .rotateY(yaw)
      .translate(x, y + 0.058, z);
    mesh.add(i % 3 === 1 ? "lightWood" : "wood", tie);
    for (const side of [-halfGauge, halfGauge]) {
      mesh.add(
        "iron",
        new BoxGeometry(0.19, 0.031, 0.164)
          .rotateX(pitch)
          .rotateY(yaw)
          .translate(x + side * Math.cos(yaw), y + 0.12, z - side * Math.sin(yaw)),
      );
    }
  }
  for (const offset of [-halfGauge, halfGauge]) {
    mesh.add("iron", beam(track, steps, offset, 0.067, 0.123, 0.199));
    mesh.add("running", beam(track, steps, offset, 0.11, 0.194, railTop));
  }
}

function trestle(mesh: Part, ramp: boolean): void {
  const track = ramp ? tracks.ramp : tracks.bridge;
  for (const x of [-0.65, 0.65]) {
    mesh.add("wood", beam(track, ramp ? 20 : 1, x, 0.22, -0.14, 0.019));
  }
  for (const t of ramp ? [0.34, 0.59, 0.86] : [0.18, 0.82]) {
    const { y, z } = track(t);
    const height = y - 0.1;
    mesh.block("iron", [1.55, 0.075, 0.36], [0, 0.0375, z], 0.017);
    mesh.block("paint", [1.5, 0.12, 0.26], [0, y - 0.156, z], 0.014);
    for (const x of [-0.65, 0.65]) {
      mesh.block("wood", [0.18, height, 0.18], [x, height / 2, z], 0.014);
      if (!ramp) mesh.block("wood", [0.105, 0.96, 0.105], [x * 0.5, 0.43, z], 0.013, -x);
    }
  }
}

function buffer(mesh: Part): void {
  for (const x of [-0.58, 0.58]) {
    mesh.block("iron", [0.2, 0.48, 0.28], [x, 0.306, 1.54], 0.032);
    mesh.add("iron", new BoxGeometry(0.15, 0.17, 0.8).rotateX(-0.47).translate(x, 0.267, 1.18));
  }
  mesh.block("paint", [1.49, 0.24, 0.2], [0, 0.55, 1.52], 0.048);
  for (const x of [-0.49, 0, 0.49]) {
    mesh.block("mark", [0.18, 0.07, 0.026], [x, 0.55, 1.41], 0.01, 0.55);
  }
}

const wheelRadius = 0.2;

function axle(mesh: Part): void {
  const wheel = (finish: Finish, x: number, radius: number, width: number) =>
    mesh.add(
      finish,
      new CylinderGeometry(radius, radius, width, 20).rotateZ(Math.PI / 2).translate(x, 0, 0),
    );
  wheel("iron", 0, 0.058, 1.23);
  for (const side of [-1, 1]) {
    wheel("tread", side * halfGauge, wheelRadius, 0.19);
    wheel("iron", side * 0.59, 0.154, 0.035);
    wheel("paint", side * 0.625, 0.071, 0.037);
  }
}

const loadHeight = 0.535;

function hopper(mesh: Part): void {
  const corners = (x: number, y: number, z: number): [XYZ, XYZ, XYZ, XYZ] => [
    [-x, y, -z],
    [-x, y, z],
    [x, y, z],
    [x, y, -z],
  ];
  const base = corners(0.45, 0.445, 0.72);
  const rim = corners(0.6, 1.01, 0.88);
  const opening = corners(0.544, 1.01, 0.82);
  const floor = corners(0.415, loadHeight, 0.682);
  const shell: number[] = [];
  for (const [i, next] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ] as const) {
    quad(shell, base[i], base[next], rim[next], rim[i]);
    quad(shell, rim[i], rim[next], opening[next], opening[i]);
    quad(shell, opening[i], opening[next], floor[next], floor[i]);
  }
  quad(shell, base[3], base[2], base[1], base[0]);
  mesh.add("paint", faceted(shell));
  const deck: number[] = [];
  quad(deck, floor[0], floor[1], floor[2], floor[3]);
  mesh.add("iron", faceted(deck));
  mesh.block("iron", [1.025, 0.22, 1.5], [0, 0.345, 0], 0.05);
  for (const side of [-1, 1]) {
    mesh.block("iron", [0.11, 0.088, 1.8], [side * 0.577, 1.01, 0], 0.022);
    mesh.block("iron", [1.064, 0.088, 0.11], [0, 1.01, side * 0.846], 0.022);
    mesh.add(
      "mark",
      new BoxGeometry(0.27, 0.067, 0.018).rotateX(side * 0.276).translate(0, 0.78, side * 0.82),
    );
    for (const z of [-0.49, 0.49]) {
      mesh.block("iron", [0.041, 0.44, 0.15], [side * 0.539, 0.743, z], 0.015, -side * 0.26);
    }
  }
}

export function buildRail(
  id: Module,
  { seed, accent, scale }: { seed: number; accent: string; scale: number },
): Group {
  const palette = materials(seed, accent);
  const mesh = new StaticKitMesh<Finish>();
  if (id === "cart") {
    hopper(mesh);
    const cart = mesh.finish("rail-cart", palette);
    for (const [end, z] of [
      ["front", 0.47],
      ["rear", -0.47],
    ] as const) {
      const wheels = new StaticKitMesh<Finish>();
      axle(wheels);
      const group = wheels.finish(`cart-${end}-axle`, palette);
      group.position.set(0, wheelRadius, z);
      cart.add(group);
    }
    const load = new Object3D();
    load.name = "cart-load";
    load.position.y = loadHeight;
    cart.add(load);
    cart.scale.setScalar(scale);
    return cart;
  }

  buildTrack(mesh, id);
  if (id === "ramp" || id === "bridge") trestle(mesh, id === "ramp");
  if (id === "stop") buffer(mesh);
  const group = mesh.finish(`rail-${id}`, palette);
  for (const [name, t] of [
    ["track-in", 0],
    ["track-out", 1],
  ] as const) {
    if (id === "stop" && t === 1) break;
    const { x, y, z, yaw } = tracks[id](t);
    const socket = new Object3D();
    socket.name = name;
    socket.position.set(x, y + railTop, z);
    socket.rotation.y = yaw;
    group.add(socket);
  }
  group.scale.setScalar(scale);
  return group;
}
