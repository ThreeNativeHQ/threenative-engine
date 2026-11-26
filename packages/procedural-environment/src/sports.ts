import {
  Box3,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import type { IStaticKitMaterialOptions } from "./static-kit-materials.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeSportsOptions extends IStaticKitMaterialOptions<Finish> {
  readonly module: string;
  readonly out: string;
  readonly seed?: number;
  /** Six-digit CSS hex color for the painted frame or ball panels. */
  readonly accent?: string;
  /** Uniform scale multiplier from 0.5 to 2. */
  readonly scale?: number;
  /** Clear goal width or distance between court net post centers, in metres before scaling. */
  readonly span?: number;
  /** Clear goal height, basketball rim height, or court net center height before scaling. */
  readonly height?: number;
}

export const sportsModules = [
  { id: "goal", name: "Soccer goal and net", category: "Equipment", accent: "#e9eef0" },
  { id: "hoop", name: "Basketball hoop and backboard", category: "Equipment", accent: "#257288" },
  { id: "net", name: "Tennis and volleyball court net", category: "Equipment", accent: "#248377" },
  { id: "soccer-ball", name: "Soccer ball", category: "Balls", accent: "#263847" },
  { id: "basketball", name: "Basketball", category: "Balls", accent: "#d9692b" },
  { id: "tennis-ball", name: "Tennis ball", category: "Balls", accent: "#c5db45" },
] as const;

type Module = (typeof sportsModules)[number]["id"];
type Dimension = "span" | "height";
type Finish = "accent" | "white" | "cord" | "base" | "orange";
type Part = StaticKitMesh<Finish>;

interface ISportDimension {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export const sportsDimensions: Partial<
  Record<Module, Partial<Record<Dimension, ISportDimension>>>
> = {
  goal: {
    span: { label: "Opening width", min: 3, max: 9, default: 6 },
    height: { label: "Opening height", min: 1.2, max: 3.2, default: 2.3 },
  },
  hoop: { height: { label: "Rim height", min: 1.75, max: 3.3, default: 3.05 } },
  net: {
    span: { label: "Net span", min: 3, max: 12, default: 8 },
    height: { label: "Net height", min: 0.65, max: 2.5, default: 0.95 },
  },
};

function materials(seed: number, accent: string): Record<Finish, MeshStandardMaterial> {
  const color = new Color(accent).multiplyScalar(new RNG(seed).range(0.94, 1.04));
  return {
    accent: new MeshStandardMaterial({ name: "Sports accent", color, roughness: 0.7 }),
    white: new MeshStandardMaterial({ name: "Sports ivory", color: 0xefeee3, roughness: 0.72 }),
    cord: new MeshStandardMaterial({ name: "Sports net cord", color: 0xd0d6d0, roughness: 0.92 }),
    base: new MeshStandardMaterial({
      name: "Sports dark fittings",
      color: 0x283641,
      roughness: 0.68,
    }),
    orange: new MeshStandardMaterial({
      name: "Sports rim paint",
      color: 0xd24424,
      roughness: 0.56,
    }),
  };
}

function anchor(group: Group, name: string, position: XYZ): void {
  const node = new Object3D();
  node.name = name;
  node.position.set(...position);
  group.add(node);
}

function rod(mesh: Part, finish: Finish, a: XYZ, b: XYZ, radius: number): void {
  const start = new Vector3(...a);
  const end = new Vector3(...b);
  const axis = end.clone().sub(start);
  const cord = finish === "cord";
  const geometry = new CylinderGeometry(radius, radius, axis.length(), cord ? 4 : 8, 1, cord);
  geometry.applyQuaternion(
    new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis.normalize()),
  );
  mesh.add(finish, geometry.translate(...start.lerp(end, 0.5).toArray()));
}

function soccerGoal(mesh: Part, span: number, height: number): [string, XYZ][] {
  const half = span / 2;
  const depth = 0.55 * height + 0.35;
  const back = (y: number) => -depth * (1 - 0.48 * (y / height));
  mesh.block("accent", [span + 0.24, 0.12, 0.12], [0, height + 0.06, 0], 0.024);
  for (const side of [-1, 1]) {
    const postX = side * (half + 0.06);
    mesh.block("accent", [0.12, height, 0.12], [postX, height / 2, 0], 0.022);
    rod(mesh, "base", [postX, 0.045, 0], [postX, 0.045, -depth], 0.04);
    rod(mesh, "base", [postX, 0.045, -depth], [postX, height, back(height)], 0.035);
    rod(mesh, "accent", [postX, height + 0.01, 0], [postX, height + 0.01, back(height)], 0.038);
  }
  rod(mesh, "base", [-half - 0.06, 0.042, -depth], [half + 0.06, 0.042, -depth], 0.04);
  const columns = Math.ceil(span / 0.28);
  for (let i = 0; i <= columns; i++) {
    const x = -half + (i * span) / columns;
    rod(mesh, "cord", [x, 0.04, back(0.04)], [x, height, back(height)], 0.009);
    rod(mesh, "cord", [x, height, back(height)], [x, height, 0], 0.009);
  }
  const rows = Math.ceil(height / 0.26);
  for (let i = 0; i <= rows; i++) {
    const y = 0.04 + ((height - 0.04) * i) / rows;
    rod(mesh, "cord", [-half, y, back(y)], [half, y, back(y)], 0.009);
    for (const x of [-half, half]) rod(mesh, "cord", [x, y, 0], [x, y, back(y)], 0.009);
  }
  for (const x of [-half, half]) {
    for (const t of [0.24, 0.49, 0.74]) {
      rod(mesh, "cord", [x, 0.04, t * back(0.04)], [x, height, t * back(height)], 0.009);
    }
  }
  for (const t of [0.33, 0.66]) {
    rod(mesh, "cord", [-half, height, t * back(height)], [half, height, t * back(height)], 0.009);
  }
  return [
    ["goal-center", [0, 0, 0]],
    ["goal-left-post", [-half, 0, 0]],
    ["goal-right-post", [half, 0, 0]],
    ["goal-crossbar", [0, height, 0]],
  ];
}

function basketballHoop(mesh: Part, height: number): [string, XYZ][] {
  const z = 0.59;
  mesh.block("base", [0.72, 0.13, 0.66], [0, 0.065, -0.55], 0.035);
  mesh.block("accent", [0.17, height + 0.3, 0.17], [0, (height + 0.3) / 2, -0.55], 0.04);
  mesh.block("base", [0.18, 0.2, 0.91], [0, height + 0.24, -0.18], 0.036);
  mesh.block("accent", [1.72, 1.09, 0.11], [0, height + 0.37, 0.24], 0.051);
  mesh.block("white", [1.62, 0.99, 0.035], [0, height + 0.37, 0.305], 0.022);
  for (const dx of [-0.282, 0.282]) {
    mesh.block("accent", [0.034, 0.36, 0.012], [dx, height + 0.235, 0.328], 0.008);
  }
  for (const y of [height + 0.058, height + 0.412]) {
    mesh.block("accent", [0.595, 0.034, 0.012], [0, y, 0.328], 0.008);
  }
  mesh.block("orange", [0.16, 0.06, 0.12], [0, height - 0.019, 0.35], 0.018);
  mesh.add(
    "orange",
    new TorusGeometry(0.233, 0.015, 8, 40).rotateX(Math.PI / 2).translate(0, height, z),
  );
  const point = (i: number, ring: number): XYZ => {
    const theta = (i * Math.PI) / 7;
    const radius = [0.228, 0.179, 0.137][ring] ?? 0.137;
    return [radius * Math.cos(theta), height - ring * 0.18 - 0.02, z + radius * Math.sin(theta)];
  };
  for (let i = 0; i < 14; i++) {
    const middle = point(i + 0.5, 1);
    rod(mesh, "cord", point(i, 0), middle, 0.008);
    rod(mesh, "cord", point(i + 1, 0), middle, 0.008);
    rod(mesh, "cord", middle, point(i, 2), 0.008);
    rod(mesh, "cord", middle, point(i + 1, 2), 0.008);
    rod(mesh, "cord", point(i, 2), point(i + 1, 2), 0.008);
  }
  return [
    ["rim-center", [0, height, z]],
    ["backboard-target", [0, height + 0.235, 0.334]],
  ];
}

function courtNet(mesh: Part, span: number, height: number): [string, XYZ][] {
  const half = span / 2;
  const sag = (x: number) => height + 0.12 * (x / half) ** 2;
  const bottom = height - Math.min(0.83, height - 0.08);
  const upper = (x: number): XYZ => [x, sag(x), 0];
  const columns = Math.ceil(span / 0.225);
  for (const x of [-half, half]) {
    mesh.block("base", [0.44, 0.09, 0.45], [x, 0.045, 0], 0.04);
    mesh.block("accent", [0.105, height + 0.19, 0.105], [x, (height + 0.19) / 2, 0], 0.026);
    mesh.block("white", [0.132, 0.06, 0.132], [x, height + 0.18, 0], 0.022);
  }
  for (let i = 0; i <= columns; i++) {
    const x = -half + (span * i) / columns;
    rod(mesh, "cord", [x, bottom, 0], upper(x), 0.008);
    if (i > 0) rod(mesh, "white", upper(x - span / columns), upper(x), 0.024);
  }
  const rows = 5;
  for (let i = 0; i <= rows; i++) {
    const y = bottom + ((height - 0.055 - bottom) * i) / rows;
    rod(mesh, "cord", [-half, y, 0], [half, y, 0], 0.009);
  }
  return [
    ["net-left", upper(-half)],
    ["net-center", upper(0)],
    ["net-right", upper(half)],
  ];
}

function panelSurface(corners: Vector3[], radius: number): BufferGeometry {
  const center = corners
    .reduce((sum, corner) => sum.add(corner), new Vector3())
    .divideScalar(corners.length);
  const detail = 4;
  const positions: number[] = [];
  const normals: number[] = [];
  for (const [index, corner] of corners.entries()) {
    const next = corners[(index + 1) % corners.length];
    if (!next) throw new Error("Soccer panel is missing a corner");
    const first = corner.clone().sub(center);
    const second = next.clone().sub(center);
    const point = (a: number, b: number) => {
      const normal = center
        .clone()
        .addScaledVector(first, (0.97 * a) / detail)
        .addScaledVector(second, (0.97 * b) / detail)
        .normalize();
      normals.push(...normal.toArray());
      positions.push(...normal.multiplyScalar(radius).toArray());
    };
    for (let a = 0; a < detail; a++) {
      for (let b = 0; a + b < detail; b++) {
        point(a, b);
        point(a + 1, b);
        point(a, b + 1);
        if (a + b === detail - 1) continue;
        point(a + 1, b);
        point(a + 1, b + 1);
        point(a, b + 1);
      }
    }
  }
  return new BufferGeometry()
    .setAttribute("position", new Float32BufferAttribute(positions, 3))
    .setAttribute("normal", new Float32BufferAttribute(normals, 3))
    .setAttribute(
      "uv",
      new Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2),
    );
}

function soccerBall(mesh: Part): void {
  const radius = 0.11;
  const ico = new IcosahedronGeometry(1);
  const position = ico.getAttribute("position");
  const unique = new Map<string, Vector3>();
  const vertices = Array.from({ length: position.count }, (_, index) => {
    const vertex = new Vector3().fromBufferAttribute(position, index);
    const key = vertex
      .toArray()
      .map((value) => Math.round(value * 1e5))
      .join(",");
    const known = unique.get(key) ?? vertex;
    unique.set(key, known);
    return known;
  });
  ico.dispose();
  const neighbors = new Map([...unique.values()].map((vertex) => [vertex, new Set<Vector3>()]));
  const cut = (a: Vector3, b: Vector3) => a.clone().lerp(b, 1 / 3);
  for (let i = 0; i < vertices.length; i += 3) {
    const [a, b, c] = vertices.slice(i, i + 3);
    if (!a || !b || !c) throw new Error("Incomplete icosahedron face");
    neighbors.get(a)?.add(b).add(c);
    neighbors.get(b)?.add(c).add(a);
    neighbors.get(c)?.add(a).add(b);
    mesh.add(
      "white",
      panelSurface([cut(a, b), cut(b, a), cut(b, c), cut(c, b), cut(c, a), cut(a, c)], radius),
    );
  }
  for (const [corner, ring] of neighbors) {
    const points = [...ring].map((end) => cut(corner, end));
    const first = points[0];
    if (!first) throw new Error("Incomplete icosahedron vertex");
    const u = first.clone().addScaledVector(corner, -first.dot(corner)).normalize();
    const v = new Vector3().crossVectors(corner, u);
    const angle = (p: Vector3) => Math.atan2(p.dot(v), p.dot(u));
    points.sort((a, b) => angle(a) - angle(b));
    mesh.add("accent", panelSurface(points, radius));
  }
  mesh.add("base", new SphereGeometry(radius * 0.985, 24, 16));
}

function ballLoop(
  mesh: Part,
  finish: Finish,
  radius: number,
  tube: number,
  sample: (t: number) => XYZ,
): void {
  const points = Array.from({ length: 48 }, (_, i) =>
    new Vector3(...sample((i * Math.PI) / 24)).normalize().multiplyScalar(radius - 0.65 * tube),
  );
  mesh.add(finish, new TubeGeometry(new CatmullRomCurve3(points, true), 64, tube, 5, true));
}

function basketball(mesh: Part): void {
  const radius = 0.12;
  mesh.add("accent", new SphereGeometry(radius, 40, 24));
  ballLoop(mesh, "base", radius, 0.0023, (t) => [Math.cos(t), 0, Math.sin(t)]);
  ballLoop(mesh, "base", radius, 0.0023, (t) => [0, Math.cos(t), Math.sin(t)]);
  for (const side of [-1, 1]) {
    ballLoop(mesh, "base", radius, 0.0023, (t) => [
      side * (0.64 - 0.36 * Math.sin(t) ** 2),
      Math.cos(t),
      Math.sin(t),
    ]);
  }
}

function tennisBall(mesh: Part): void {
  const radius = 0.034;
  mesh.add("accent", new SphereGeometry(radius, 40, 24));
  ballLoop(mesh, "white", radius, 0.0012, (t) => [
    Math.cos(t),
    0.85 * Math.sin(2 * t),
    Math.sin(t),
  ]);
}

export function buildSports(
  id: Module,
  options: Required<Pick<IBakeSportsOptions, "seed" | "accent" | "scale">> &
    Pick<IBakeSportsOptions, "span" | "height">,
): Group {
  const mesh = new StaticKitMesh<Finish>();
  const palette = materials(options.seed, options.accent);
  const dimensions = sportsDimensions[id];
  const span = options.span ?? dimensions?.span?.default ?? 0;
  const height = options.height ?? dimensions?.height?.default ?? 0;
  const equipment = {
    goal: soccerGoal,
    hoop: (part: Part, _span: number, y: number) => basketballHoop(part, y),
    net: courtNet,
  };
  const ball = { "soccer-ball": soccerBall, basketball, "tennis-ball": tennisBall };
  const group = new Group();
  group.name = `sports-${id}`;
  if (id === "goal" || id === "net" || id === "hoop") {
    const anchors = equipment[id](mesh, span, height);
    group.add(mesh.finish("frame", palette));
    for (const [name, position] of anchors) anchor(group, name, position);
  } else {
    ball[id](mesh);
    const shell = mesh.finish("ball-shell", palette);
    shell.position.y = -new Box3().setFromObject(shell).min.y;
    group.add(shell);
    anchor(group, "ball-center", [0, shell.position.y, 0]);
  }
  group.scale.setScalar(options.scale);
  return group;
}
