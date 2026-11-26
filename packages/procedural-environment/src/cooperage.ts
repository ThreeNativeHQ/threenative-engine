import {
  BufferAttribute,
  type BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  LatheGeometry,
  MathUtils,
  type MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";
import type { RNG } from "../vendor/stylized-biome-kit/core.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export const cooperageModules = [
  {
    id: "barrel",
    name: "Tavern storage barrel",
    category: "Storage",
    width: { min: 0.56, max: 0.86, default: 0.68 },
    widthLabel: "Body diameter",
  },
  {
    id: "bucket",
    name: "Tavern wooden bucket",
    category: "Utility props",
    width: { min: 0.24, max: 0.36, default: 0.3 },
    widthLabel: "Rim diameter",
  },
  {
    id: "tankard",
    name: "Tavern wooden tankard",
    category: "Tableware",
    width: { min: 0.088, max: 0.128, default: 0.105 },
    widthLabel: "Rim diameter",
    widthStep: 0.001,
  },
] as const;

type Vessel = (typeof cooperageModules)[number]["id"];
type Finish = "wood" | "iron";
type Parts = StaticKitMesh<Finish>;

const vessels = {
  barrel: { height: 0.842, waist: 0.82, depth: 0.026, bottom: 0.067, staves: 20, band: 0.041 },
  bucket: { height: 0.278, waist: 0.78, depth: 0.014, bottom: 0.025, staves: 14, band: 0.019 },
  tankard: { height: 0.132, waist: 0.83, depth: 0.0065, bottom: 0.011, staves: 11, band: 0.008 },
};

function anchor(name: string, x: number, y: number): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, 0);
  return node;
}

function disk(parts: Parts, radius: number, depth: number, bottom: number): void {
  const shape = new CylinderGeometry(radius, radius, depth, 64).translate(0, bottom + depth / 2, 0);
  solidWood(parts, shape, 0.82);
}

function solidWood(parts: Parts, shape: BufferGeometry, tone: number): void {
  const colors = new Float32Array(shape.getAttribute("position").count * 3).fill(tone);
  shape.setAttribute("color", new BufferAttribute(colors, 3));
  parts.add("wood", shape);
}

function staves(
  parts: Parts,
  rng: RNG,
  profile: Vector2[],
  count: number,
  thickness: number,
): void {
  const turn = (Math.PI * 2) / count;
  for (let stave = 0; stave < count; stave++) {
    const shape = new LatheGeometry(profile, 4, stave * turn, turn);
    const positions = shape.getAttribute("position");
    const uv = shape.getAttribute("uv");
    const colors = new Float32Array(positions.count * 3);
    const tone = rng.range(0.72, 1);
    const u = rng.range(0, 1);
    const v = rng.range(0, 1);
    for (let i = 0; i < positions.count; i++) {
      const t = uv.getX(i);
      const [x, y, z] = [positions.getX(i), positions.getY(i), positions.getZ(i)];
      const radius = Math.hypot(x, z);
      const edge = t === 0 || t === 1;
      const scale = edge ? 1 - (thickness * 0.09) / radius : 1;
      positions.setXYZ(i, x * scale, y, z * scale);
      uv.setXY(i, u + y * 1.35, v + t * turn * radius * 2);
      colors.fill(tone * (edge ? 0.73 : 1), i * 3, i * 3 + 3);
    }
    shape.setAttribute("color", new BufferAttribute(colors, 3));
    shape.computeVertexNormals();
    parts.add("wood", shape);
  }
}

function handle(parts: Parts, points: XYZ[], thickness: number): void {
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
  parts.add("iron", new TubeGeometry(curve, 18, thickness, 8, false));
}

function radiusAtHeight(profile: [Vector2, ...Vector2[]], y: number): number {
  let last = profile[0];
  if (y <= last.y) return last.x;
  for (const point of profile) {
    if (y < point.y) return MathUtils.lerp(last.x, point.x, (y - last.y) / (point.y - last.y));
    last = point;
  }
  return last.x;
}

function hoop(parts: Parts, radiusAt: (y: number) => number, y: number, width: number): void {
  const low = y - width / 2;
  const high = y + width / 2;
  const bevel = width * 0.13;
  const profile = [
    new Vector2(radiusAt(low) - bevel * 0.3, low),
    new Vector2(radiusAt(low + bevel) + bevel, low + bevel),
    new Vector2(radiusAt(high - bevel) + bevel, high - bevel),
    new Vector2(radiusAt(high) - bevel * 0.3, high),
  ];
  parts.add("iron", new LatheGeometry(profile, 64));
  const stud = radiusAt(y) + bevel * 0.92;
  for (const angle of [0.16, Math.PI + 0.16]) {
    parts.add(
      "iron",
      new SphereGeometry(width * 0.18, 8, 5).translate(
        Math.sin(angle) * stud,
        y,
        Math.cos(angle) * stud,
      ),
    );
  }
}

function barrelLid(radius: number): Parts {
  const lid = new StaticKitMesh<Finish>();
  disk(lid, radius, 0.023, 0);
  for (const z of [-radius * 0.35, radius * 0.35]) {
    const length = 2 * Math.sqrt(radius ** 2 - z ** 2) - 0.003;
    solidWood(
      lid,
      new PlaneGeometry(length, 0.0024).rotateX(-Math.PI / 2).translate(0, 0.0234, z),
      0.43,
    );
  }
  handle(
    lid,
    [
      [-0.058, 0.022, 0],
      [-0.044, 0.05, 0],
      [0.044, 0.05, 0],
      [0.058, 0.022, 0],
    ],
    0.005,
  );
  return lid;
}

function tankardLoop(parts: Parts, radius: number, radiusAt: (y: number) => number): void {
  handle(
    parts,
    [
      [radiusAt(0.109) - 0.003, 0.109, 0],
      [radius + 0.025, 0.113, 0],
      [radius + 0.036, 0.081, 0],
      [radius + 0.025, 0.046, 0],
      [radiusAt(0.039) - 0.003, 0.039, 0],
    ],
    0.0045,
  );
  for (const y of [0.039, 0.109]) {
    parts.add(
      "iron",
      new SphereGeometry(0.0085, 8, 6).scale(0.57, 1, 0.83).translate(radiusAt(y), y, 0),
    );
  }
}

export function buildCooperage(
  id: Vessel,
  width: number,
  rng: RNG,
  palette: Record<Finish, MeshStandardMaterial>,
  open: boolean,
) {
  const body = new StaticKitMesh<Finish>();
  const { height, waist, depth, bottom, staves: count, band } = vessels[id];
  const radius = width / 2;
  const barrel = id === "barrel";
  // Cross-section rings are [fraction of height, fraction of the largest radius].
  const rings: [number, number][] = barrel
    ? [
        [0.035, waist],
        [0.18, 0.924],
        [0.35, 0.986],
        [0.5, 1],
        [0.65, 0.986],
        [0.82, 0.924],
        [0.965, waist],
        [1, waist - 0.023],
      ]
    : [
        [0.028, waist],
        [0.5, (1 + waist) / 2],
        [0.978, 1],
        [1, 0.994],
      ];
  const outer: [Vector2, ...Vector2[]] = [
    new Vector2((waist - (barrel ? 0.023 : 0.015)) * radius, 0),
    ...rings.map(([rise, width]) => new Vector2(width * radius, rise * height)),
  ];
  const inner = outer.map(({ x, y }) => new Vector2(x - depth, y)).reverse();
  const radiusAt = (y: number) => radiusAtHeight(outer, y);
  staves(body, rng, [...outer, ...inner], count, depth);
  disk(body, radiusAt(bottom) - depth + 0.001, bottom, 0);

  const hoopCenters = barrel ? [0.105, 0.277, 0.565, 0.737] : [height * 0.18, height * 0.8];
  for (const y of hoopCenters) hoop(body, radiusAt, y, band);

  if (id === "tankard") tankardLoop(body, radius, radiusAt);
  const mount = height * 0.8;
  const span = radiusAt(mount) + 0.01;
  if (id === "bucket") {
    for (const side of [-1, 1]) {
      body.add("iron", new SphereGeometry(0.009, 8, 6).translate(side * (span - 0.004), mount, 0));
    }
  }
  const group = body.finish(`tavern-${id}`, palette);
  group.add(anchor(`${id}-mouth`, 0, height));

  if (barrel) {
    const lidRadius = radiusAt(height) - depth + 0.002;
    const moving = barrelLid(lidRadius).finish("barrel-lid", palette);
    moving.position.set(open ? radius + lidRadius + 0.045 : 0, open ? 0 : height - 0.025, 0);
    moving.add(anchor("barrel-lid-grip", 0, 0.053));
    group.add(moving);
  } else if (id === "bucket") {
    const bail = new StaticKitMesh<Finish>();
    const rise = span * 0.93;
    handle(
      bail,
      [
        [-span, 0, 0],
        [-span * 0.81, rise * 0.67, 0],
        [0, rise, 0],
        [span * 0.81, rise * 0.67, 0],
        [span, 0, 0],
      ],
      0.004,
    );
    const grip = new CylinderGeometry(0.0125, 0.0125, 0.078, 16)
      .rotateZ(Math.PI / 2)
      .translate(0, rise - 0.004, 0);
    solidWood(bail, grip, 0.84);
    const moving = bail.finish("bucket-handle", palette);
    moving.position.y = mount;
    moving.rotation.x = -0.15;
    moving.add(anchor("bucket-grip", 0, rise));
    group.add(moving);
  } else {
    const grip = anchor("tankard-grip", radius + 0.036, 0.081);
    grip.rotation.y = Math.PI / 2;
    group.add(grip);
  }
  return group;
}
