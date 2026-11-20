import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { DungeonMesh, DungeonPart, XYZ } from "./mesh.js";

const TAU = Math.PI * 2;
const LIMESTONE = 0x797b72;
const SHADE = 0x4e5450;
const EDGE = 0x99988b;

function surface(rows: XYZ[][], closed = true): BufferGeometry {
  const stride = rows[0]?.length ?? 0;
  const data = rows.flat(2);
  const ix: number[] = [];
  const columns = closed ? stride : stride - 1;
  for (let y = 0; y < rows.length - 1; y++) {
    for (let x = 0; x < columns; x++) {
      const a = y * stride + x;
      const b = y * stride + ((x + 1) % stride);
      ix.push(a, b, a + stride, b, b + stride, a + stride);
    }
  }
  const mesh = new BufferGeometry();
  mesh.setAttribute("position", new Float32BufferAttribute(data, 3));
  mesh.setIndex(ix);
  mesh.computeVertexNormals();
  return mesh;
}

function mantle(m: DungeonMesh): void {
  const layers = [
    [0.48, 0.53, 0.35, -0.05, 0.5],
    [0.81, 0.5, 0.33, -0.048, 0.43],
    [1.23, 0.43, 0.29, -0.031, 0.27],
    [1.62, 0.34, 0.27, -0.025, 0.16],
    [1.85, 0.405, 0.27, -0.036, 0.15],
    [2.13, 0.49, 0.256, -0.046, 0.22],
    [2.25, 0.37, 0.23, -0.039, 0.3],
    [2.37, 0.24, 0.199, -0.02, 0.45],
  ] as const;
  const rows = layers.map(([y, w, d, back, opening], layer) =>
    Array.from({ length: 49 }, (_, i): XYZ => {
      const a = opening + (i / 48) * (TAU - opening * 2);
      const forward = Math.max(0, Math.cos(a)) ** 2;
      const drape = Math.cos(a * 11 + y * 2.25) ** 5 * (layer < 4 ? 0.039 : 0.023);
      const tuck = Math.sin(a * 5 + layer * 0.62) * 0.017;
      const hem = Math.max(0, 1.36 - y) * forward * 0.79;
      return [
        Math.sin(a) * (w + drape + tuck) + Math.sin(y * 1.8) * 0.039,
        y + hem + tuck + Math.max(0, layer - 4) * Math.sin(a * 2) * 0.012,
        back + Math.cos(a) * (d + drape + tuck),
      ];
    }),
  );
  m.add(surface(rows, false), LIMESTONE, "solid", 0.128, 0.27);
  for (const side of [-1, 1]) {
    const edge = rows.map((row) => (side < 0 ? row.at(-1) : row[0]) as XYZ);
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1] as XYZ;
      const b = edge[i] as XYZ;
      m.rod(a, b, 0.031, EDGE, "solid", 0.029, 7);
    }
  }
}

function hood(m: DungeonMesh): void {
  const sections = [
    [0.12, 0.157, 0.224, 2.56],
    [0.256, 0.177, 0.248, 2.58],
    [0.275, 0.194, 0.29, 2.593],
    [0.214, 0.237, 0.316, 2.59],
    [0.07, 0.25, 0.302, 2.57],
    [-0.082, 0.229, 0.267, 2.53],
    [-0.187, 0.18, 0.205, 2.5],
    [-0.237, 0.097, 0.123, 2.489],
    [-0.263, 0.006, 0.006, 2.483],
  ] as const;
  const wrap = sections.map(([z, w, h, y], index) =>
    Array.from({ length: 40 }, (_, i): XYZ => {
      const a = (i / 40) * TAU;
      const cos = Math.cos(a);
      const narrow = 1 - 0.38 * Math.max(0, cos) ** 4 - 0.28 * Math.max(0, -cos) ** 3;
      const crease = Math.cos(a * 9 + index * 0.63) * 0.009;
      return [
        Math.sin(a) * (w + crease) * narrow,
        y + h * cos,
        z + cos * 0.058 + Math.sin(a * 3) * 0.012,
      ];
    }),
  );
  m.add(surface(wrap), EDGE, "solid", 0.126, 0.1);
  m.gem([0, 2.536, 0.047], [0.164, 0.239, 0.126], SHADE, "solid", 2);
  const face = [
    [2.412, 0.048, 0.177, 0.189],
    [2.444, 0.089, 0.173, 0.205],
    [2.49, 0.108, 0.178, 0.216],
    [2.54, 0.121, 0.184, 0.205],
    [2.578, 0.129, 0.174, 0.193],
    [2.627, 0.13, 0.184, 0.217],
    [2.684, 0.114, 0.173, 0.214],
    [2.714, 0.082, 0.156, 0.185],
  ] as const;
  m.add(
    surface(
      face.map(([y, w, edge, ridge]) => [
        [-w, y, edge],
        [-w * 0.53, y, edge * 0.53 + ridge * 0.47],
        [0, y, ridge],
        [w * 0.53, y, edge * 0.53 + ridge * 0.47],
        [w, y, edge],
      ]),
      false,
    ),
    0x85867c,
    "solid",
    0.08,
  );
  m.gem([0, 2.544, 0.216], [0.034, 0.061, 0.027], EDGE, "solid", 0, 0.04);
  for (const side of [-1, 1]) {
    const x = side * 0.062;
    m.rod(
      [x - 0.039, 2.596, 0.199],
      [x + 0.039, 2.598 + side * 0.012, 0.206],
      0.014,
      SHADE,
      "solid",
      0.008,
      5,
    );
    m.rod(
      [x - 0.041, 2.618, 0.217],
      [x + 0.041, 2.621 + side * 0.013, 0.222],
      0.019,
      LIMESTONE,
      "solid",
      0.008,
      5,
    );
  }
  m.rod([-0.042, 2.46, 0.207], [0.038, 2.46, 0.208], 0.007, SHADE, "solid", 0.008, 5);
}

function sleeve(m: DungeonMesh, side: number): void {
  const sections = [
    [0.27, 2.19, -0.04, 0.117],
    [0.382, 2.13, -0.007, 0.145],
    [0.464, 2.012, 0.028, 0.166],
    [0.49, 1.845, 0.079, 0.149],
    [0.46, 1.736, 0.14, 0.153],
    [0.32, 1.687, 0.248, 0.125],
    [0.175, 1.632, 0.337, 0.101],
    [0.123, 1.604, 0.381, 0.091],
  ] as const;
  const centers = sections.map(([x, y, z]) => new Vector3(x * side, y, z));
  const rows = sections.map(([, , , radius], j) => {
    const center = centers[j] as Vector3;
    const before = centers[Math.max(j - 1, 0)] as Vector3;
    const after = centers[Math.min(j + 1, centers.length - 1)] as Vector3;
    const axis = before.clone().sub(after).normalize();
    const u = new Vector3(0, 0, 1).cross(axis).normalize();
    const v = axis.clone().cross(u);
    return Array.from({ length: 20 }, (_, i): XYZ => {
      const t = (i / 20) * TAU;
      const fold = radius * (1 + 0.097 * Math.sin(5 * t + 0.36 * j));
      return center
        .clone()
        .addScaledVector(u, Math.cos(t) * fold)
        .addScaledVector(v, -Math.sin(t) * fold)
        .toArray();
    });
  });
  m.add(surface(rows), LIMESTONE, "solid", 0.14);
}

function limbsAndBlade(m: DungeonMesh): void {
  for (const side of [-1, 1]) {
    const x = side * 0.18;
    m.rod([x, 0.46, 0.021], [x * 1.12, 1.26, 0.055], 0.119, SHADE, "solid", 0.152, 8);
    m.gem([x, 0.504, 0.17], [0.139, 0.108, 0.23], LIMESTONE, "solid", 1, side * 0.11);
    sleeve(m, side);
    m.rod(
      [side * 0.203, 1.648, 0.317],
      [side * 0.147, 1.616, 0.358],
      0.113,
      EDGE,
      "solid",
      0.104,
      9,
    );
    m.gem([side * 0.079, 1.596, 0.399], [0.095, 0.077, 0.082], EDGE, "solid", 1, side * 0.22);
    for (let finger = 0; finger < 3; finger++) {
      const dx = side * (0.028 + finger * 0.029);
      m.rod([dx, 1.604, 0.449], [dx * 0.81, 1.553, 0.451], 0.014, LIMESTONE, "solid", 0.012, 5);
    }
  }
  const z = 0.455;
  m.rod([0, 0.45, z], [0, 1.485, z], 0.015, EDGE, "solid", 0.086, 4);
  m.block([0, 1.493, z], [0.435, 0.067, 0.085], LIMESTONE, "solid", 0.023);
  m.rod([0, 1.485, z], [0, 1.699, z], 0.044, SHADE, "solid", 0.039, 8);
  m.gem([0, 1.707, z], [0.057, 0.041, 0.048], EDGE, "solid", 1);
  m.gem([0.042, 2.082, 0.253], [0.081, 0.086, 0.041], EDGE, "solid", 1);
}

export const statue: DungeonPart = (m) => {
  m.stone([0, 0.139, 0], [1.44, 0.278, 1.23], 0.55, 0.094);
  m.stone([0, 0.314, 0], [1.31, 0.13, 1.08], 0.34, 0.055);
  m.stone([0, 0.417, 0], [1.19, 0.14, 1.01], 0.33, 0.062);
  m.block([0, 0.154, 0.603], [0.59, 0.146, 0.027], SHADE, "solid", 0.026);
  for (const x of [-0.13, 0.13])
    m.rod([x, 0.112, 0.625], [x * 0.31, 0.19, 0.625], 0.013, EDGE, "solid", 0.013, 4);
  m.gem([0.027, 1.66, -0.057], [0.396, 0.733, 0.271], SHADE, "solid", 2, 0);
  m.gem([0, 2.31, -0.012], [0.188, 0.196, 0.185], SHADE, "solid", 1);
  mantle(m);
  hood(m);
  limbsAndBlade(m);
};
