import { ExtrudeGeometry, LatheGeometry, Shape, TorusGeometry, Vector2 } from "three";
import type { DungeonMesh, DungeonPart, XYZ } from "./mesh.js";

const BONE = 0xc9b492;

function brace(
  m: DungeonMesh,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): void {
  for (const side of [-1, 1]) {
    m.rod(
      [x - width / 2, y - (side * height) / 2, z],
      [x + width / 2, y + (side * height) / 2, z],
      0.045,
      m.palette.wood,
      "solid",
      0.045,
      4,
    );
  }
}

export const crate: DungeonPart = (m) => {
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * 0.294;
    m.block([x, 0.56, 0], [0.278, 1.12, 1.15], m.palette.wood);
  }
  for (const side of [-1, 1]) {
    const z = side * 0.607;
    for (const y of [0.092, 1.03]) m.block([0, y, z], [1.24, 0.12, 0.11], m.palette.wood);
    for (const x of [-0.555, 0.555]) m.block([x, 0.56, z], [0.095, 1.1, 0.12], m.palette.wood);
    brace(m, 0, 0.56, z, 1.03, 0.87);
    for (const x of [-0.55, 0.55])
      for (const y of [0.09, 1.03])
        m.gem([x, y, z + side * 0.065], [0.035, 0.035, 0.024], m.palette.iron, "metal");
  }
};

export const barrel: DungeonPart = (m) => {
  const stations = [0.38, 0.46, 0.49, 0.46, 0.38];
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    for (let j = 0; j < 4; j++) {
      const radius = ((stations[j] ?? 0) + (stations[j + 1] ?? 0)) / 2;
      const stave = [Math.cos(a) * radius, 0.144 + j * 0.28, Math.sin(a) * radius] as XYZ;
      m.block(stave, [0.116, 0.344, radius * 0.52], m.palette.wood, "solid", 0.025, -a);
    }
  }
  for (const [y, radius] of [
    [0.17, 0.445],
    [0.55, 0.516],
    [0.95, 0.455],
  ] as const) {
    const hoop = new TorusGeometry(radius, 0.037, 4, 24).rotateX(-Math.PI / 2).translate(0, y, 0);
    m.add(hoop, m.palette.iron, "metal");
  }
  m.rod([0, 1.018, 0], [0, 1.08, 0], 0.407, m.palette.wood, "solid", 0.407, 12);
  for (const z of [-0.19, 0, 0.19]) m.block([0, 1.081, z], [0.72, 0.012, 0.01], m.palette.joint);
};

export const sack: DungeonPart = (m) => {
  m.gem([0, 0.35, 0], [0.43, 0.45, 0.37], 0xa68a62, "solid", 2, 0.23);
  m.gem([0.02, 0.73, 0], [0.19, 0.13, 0.16], 0xaf936b, "solid", 1);
  m.rod([0.02, 0.698, 0], [0.02, 0.757, 0], 0.142, 0x69533d, "solid", 0.141, 10);
  m.rod([0.13, 0.73, 0.06], [0.15, 0.56, 0.16], 0.025, 0x947951);
};

function chestLid(m: DungeonMesh, open: boolean): void {
  const tilt = open ? -1.83 : 0;
  function strip(start: number, end: number, x: number, width: number, strap: boolean): void {
    const angles = Array.from({ length: 4 }, (_, i) => start + ((end - start) * i) / 3);
    const point = (a: number, r: number) =>
      new Vector2(0.32 + 0.382 * r * Math.cos(a), 0.317 * r * Math.sin(a));
    const outline = [
      ...angles.map((a) => point(a, strap ? 1.075 : 1)),
      ...angles.reverse().map((a) => point(a, strap ? 1.018 : 0.862)),
    ];
    const shape = new Shape(outline);
    shape.closePath();
    const piece = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    piece
      .rotateY(-Math.PI / 2)
      .translate(x + width / 2, 0, 0)
      .rotateX(tilt)
      .translate(0, 0.63, -0.32);
    m.add(piece, strap ? 0x615951 : m.palette.wood, strap ? "metal" : "solid", 0.15);
  }
  for (let i = 0; i < 10; i++) {
    const lo = (i * Math.PI) / 10;
    const hi = ((i + 1) * Math.PI) / 10;
    strip(lo + 0.006, hi - 0.006, 0, 1.16, false);
    for (const x of [-0.485, 0.485]) strip(lo, hi, x, 0.1, true);
  }
}

export function chest(m: DungeonMesh, open = false): void {
  m.block([0, 0.105, 0], [1.17, 0.19, 0.71], m.palette.wood);
  for (const x of [-0.53, 0.53]) m.block([x, 0.35, 0], [0.14, 0.58, 0.71], m.palette.wood);
  for (const z of [-0.3, 0.3]) {
    for (const y of [0.22, 0.4, 0.58]) m.block([0, y, z], [1.12, 0.173, 0.12], m.palette.wood);
    for (const x of [-0.46, 0.46])
      m.block([x, 0.363, z * 1.22], [0.075, 0.59, 0.043], m.palette.iron, "metal");
  }
  m.block([0, 0.56, 0.383], [0.21, 0.21, 0.065], 0x9b7338, "metal");
  m.block([0, 0.55, 0.422], [0.03, 0.068, 0.015], m.palette.joint, "metal");
  chestLid(m, open);
  if (!open) return;
  for (let i = 0; i < 31; i++) {
    const x = m.rng.range(-0.46, 0.46);
    const z = m.rng.range(-0.22, 0.22);
    const y = m.rng.range(0.53, 0.66);
    m.rod(
      [x, y, z],
      [x + m.rng.range(-0.022, 0.022), y + 0.025, z],
      0.063,
      i % 3 ? 0xe4a341 : 0xffdb76,
      "metal",
      0.061,
      8,
    );
  }
  for (const x of [-0.22, 0.25]) m.gem([x, 0.67, 0.04], [0.085, 0.087, 0.082], 0xb73839, "glow");
}

export const cage: DungeonPart = (m) => {
  const w = 0.95;
  for (const x of [-w / 2, w / 2])
    for (const z of [-w / 2, w / 2]) {
      m.rod([x, 0.02, z], [x, 1.46, z], 0.051, m.palette.iron, "metal", 0.051, 4);
      m.rod([x, 1.46, z], [0, 1.78, 0], 0.035, m.palette.iron, "metal");
    }
  for (const s of [-1, 1]) {
    for (const n of [-0.25, 0, 0.25]) {
      m.rod([n, 0.05, (s * w) / 2], [n, 1.45, (s * w) / 2], 0.026, m.palette.iron, "metal");
      m.rod([(s * w) / 2, 0.05, n], [(s * w) / 2, 1.45, n], 0.026, m.palette.iron, "metal");
    }
    for (const y of [0.06, 0.78, 1.44]) {
      m.block([0, y, (s * w) / 2], [w, 0.056, 0.068], m.palette.iron, "metal");
      m.block([(s * w) / 2, y, 0], [0.068, 0.056, w], m.palette.iron, "metal");
    }
  }
  m.add(new TorusGeometry(0.095, 0.022, 5, 12).translate(0, 1.85, 0), m.palette.iron, "metal");
};

export function furniture(m: DungeonMesh, bench = false): void {
  const height = bench ? 0.45 : 0.87;
  const depth = bench ? 0.5 : 1.0;
  const width = bench ? 1.78 : 2.2;
  for (let i = 0; i < 4; i++) {
    m.block(
      [0, height, ((i - 1.5) * depth) / 4],
      [width + m.rng.range(-0.09, 0.07), 0.11, depth / 4 - 0.009],
      m.palette.wood,
    );
  }
  for (const x of [-width * 0.42, width * 0.42])
    for (const z of [-depth * 0.35, depth * 0.35]) {
      m.block([x, height / 2, z], [0.11, height, 0.12], m.palette.wood);
    }
  for (const z of [-depth * 0.37, depth * 0.37])
    m.block([0, height * 0.42, z], [width * 0.89, 0.115, 0.08], m.palette.wood);
}

function vessel(m: DungeonMesh, x: number, y: number, z: number, scale: number): void {
  m.gem(
    [x, y + 0.13 * scale, z],
    [0.135 * scale, 0.14 * scale, 0.135 * scale],
    0x86614b,
    "solid",
    1,
  );
  m.rod(
    [x, y + 0.21 * scale, z],
    [x, y + 0.31 * scale, z],
    0.06 * scale,
    0x9a7052,
    "solid",
    0.075 * scale,
  );
}

export const shelves: DungeonPart = (m) => {
  for (const x of [-0.86, 0.86])
    for (const z of [-0.2, 0.2]) m.block([x, 0.99, z], [0.12, 1.98, 0.13], m.palette.wood);
  for (const y of [0.21, 0.77, 1.34, 1.94]) {
    m.block([0, y, 0], [1.79, 0.095, 0.54], m.palette.wood);
    for (let j = 0; j < 4; j++) {
      const x = -0.69 + j * 0.45;
      if (m.rng.next() > 0.24) vessel(m, x, y + 0.05, 0, m.rng.range(0.64, 1.3));
    }
  }
};

export function weaponStand(m: DungeonMesh, rack = false): void {
  const width = rack ? 1.9 : 1.4;
  for (const x of [-width / 2, width / 2]) {
    m.block([x, 1.05, 0], [0.14, 2.06, 0.15], m.palette.wood);
    m.block([x, 0.065, 0], [0.17, 0.13, 0.72], m.palette.wood);
  }
  for (const y of rack ? [0.25, 0.88, 1.58] : [0.31, 1.4])
    m.block([0, y, -0.07], [width, 0.13, 0.13], m.palette.wood);
  const count = rack ? 6 : 4;
  for (let i = 0; i < count; i++) {
    const x = width * ((i + 0.5) / count - 0.5);
    const base = rack && i % 2 === 0 ? 0.86 : 0.13;
    const height = rack ? m.rng.range(0.66, 1.13) : m.rng.range(1.48, 1.97);
    m.rod([x, base, 0.11], [x + 0.09, base + height, 0.01], 0.027, m.palette.wood);
    m.rod(
      [x + 0.09, base + height - 0.03, 0.01],
      [x + 0.115, base + height + 0.24, -0.016],
      0.078,
      0x87818a,
      "metal",
      0.003,
      4,
    );
    if (rack)
      m.block(
        [x + 0.07, base + height - 0.13, 0.017],
        [0.23, 0.049, 0.055],
        m.palette.iron,
        "metal",
      );
  }
}

function flag(m: DungeonMesh, points: [number, number][], color: number, z: number): void {
  const path = new Shape();
  for (const [[x, y], i] of points.map((p, i) => [p, i] as const)) {
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  m.add(new ExtrudeGeometry(path, { depth: 0.025, bevelEnabled: false }).translate(0, 0, z), color);
}

export const banner: DungeonPart = (m) => {
  const gilt = m.palette.pale;
  flag(
    m,
    [
      [-0.58, 2.66],
      [0.58, 2.66],
      [0.57, 0.04],
      [0, 0.44],
      [-0.57, 0.04],
    ],
    m.palette.cloth,
    0,
  );
  for (const x of [-0.515, 0.515])
    m.block([x, 1.5, 0.029], [0.027, 2.32, 0.007], gilt, "solid", 0.002);
  flag(
    m,
    [
      [0, 2.16],
      [0.105, 1.76],
      [0.38, 1.66],
      [0.13, 1.59],
      [0, 1.05],
      [-0.13, 1.59],
      [-0.38, 1.66],
      [-0.105, 1.76],
    ],
    gilt,
    0.032,
  );
  m.rod([-0.76, 2.68, 0], [0.76, 2.68, 0], 0.046, m.palette.wood);
  for (const x of [-0.76, 0.76]) m.gem([x, 2.68, 0], [0.086, 0.077, 0.077], gilt, "metal");
};

export function flame(m: DungeonMesh, [x, y, z]: XYZ, scale: number): void {
  for (let i = 0; i < 6; i++) {
    const dx = i === 0 ? 0 : m.rng.range(-0.19, 0.19) * scale;
    const dz = i === 0 ? 0.012 : m.rng.range(-0.15, 0.15) * scale;
    const h = (i === 0 ? 0.94 : m.rng.range(0.26, 0.67)) * scale;
    const r = m.rng.range(0.073, 0.145) * scale;
    const points = [
      [0.001, 0],
      [r * 0.9, h * 0.16],
      [r, h * 0.31],
      [r * 0.71, h * 0.53],
      [r * 0.34, h * 0.74],
      [0.001, h],
    ];
    const tongue = new LatheGeometry(
      points.map(([radius = 0, height = 0]) => new Vector2(radius, height)),
      7,
    );
    const pos = tongue.getAttribute("position");
    for (let v = 0; v < pos.count; v++) {
      const t = pos.getY(v) / h;
      pos.setX(v, pos.getX(v) + (Math.sin(t * 5 + i) * 0.14 + t * dx) * h);
      pos.setZ(v, pos.getZ(v) - t * dz * 0.45);
    }
    tongue.computeVertexNormals();
    tongue.translate(x + dx, y, z + dz);
    m.add(tongue, i === 2 || i === 5 ? m.palette.pale : m.palette.fire, "glow", 0.08, 0, [y, h]);
  }
  for (let i = 0; i < 5; i++) {
    const size = scale * m.rng.range(0.012, 0.026);
    const ax = x + m.rng.range(-0.34, 0.31) * scale;
    const ay = y + m.rng.range(0.6, 1.27) * scale;
    const az = z + m.rng.range(-0.25, 0.25) * scale;
    m.rod(
      [ax, ay, az],
      [ax + size * 0.15, ay + size * 1.9, az],
      size,
      m.palette.fire,
      "glow",
      0.002,
      4,
      [y, scale * 1.25],
    );
  }
}

export const wallTorch: DungeonPart = (m) => {
  m.block([0, 0.56, -0.19], [0.24, 0.59, 0.085], m.palette.iron, "metal");
  m.rod([0, 0.08, -0.03], [0, 0.91, 0.28], 0.07, m.palette.wood, "solid", 0.1, 7);
  m.rod([0, 0.78, 0.22], [0, 0.96, 0.3], 0.12, m.palette.iron, "metal", 0.16);
  flame(m, [0, 0.94, 0.3], 0.59);
  m.fireLight([0, 1.23, 0.47], 21);
};

export const brazier: DungeonPart = (m) => {
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    m.rod(
      [Math.cos(a) * 0.48, 0.045, Math.sin(a) * 0.48],
      [Math.cos(a) * 0.25, 0.69, Math.sin(a) * 0.25],
      0.063,
      m.palette.iron,
      "metal",
    );
  }
  m.rod([0, 0.6, 0], [0, 0.82, 0], 0.19, m.palette.iron, "metal", 0.54, 14);
  m.rod([0, 0.82, 0], [0, 0.86, 0], 0.55, 0x65555a, "metal", 0.52, 14);
  m.rod([0, 0.86, 0], [0, 0.886, 0], 0.44, m.palette.fire, "glow", 0.44, 14);
  flame(m, [0, 0.88, 0], 1.25);
  m.fireLight([0, 1.23, 0], 29);
};

export function candle(m: DungeonMesh, x: number, y: number, z: number, height: number): void {
  m.rod([x, y, z], [x, y + height, z], 0.061, BONE, "solid", 0.053, 8);
  m.rod(
    [x + 0.04, y + height * 0.49, z + 0.026],
    [x + 0.04, y + height - 0.02, z + 0.025],
    0.013,
    BONE,
  );
  m.rod([x, y + height, z], [x, y + height + 0.053, z], 0.015, m.palette.iron);
  m.rod(
    [x, y + height + 0.046, z],
    [x + 0.015, y + height + 0.166, z],
    0.034,
    m.palette.pale,
    "glow",
    0.003,
    6,
    [y + height, 0.18],
  );
}

export const candles: DungeonPart = (m) => {
  m.rod([0, 0.025, 0], [0, 0.065, 0], 0.44, m.palette.iron, "metal", 0.44, 12);
  for (const [x, z, h] of [
    [0, 0, 0.53],
    [-0.14, 0.14, 0.34],
    [0.18, 0.1, 0.25],
    [0.08, -0.2, 0.37],
    [0.27, -0.075, 0.21],
    [-0.2, -0.12, 0.28],
  ] as const)
    candle(m, x, 0.065, z, h);
  m.fireLight([0, 0.59, 0], 6);
};

export const hangingLamp: DungeonPart = (m) => {
  const corners = [-0.26, 0.26];
  for (const x of corners)
    for (const z of corners) {
      m.rod([x, 0.08, z], [x, 0.64, z], 0.038, m.palette.iron, "metal");
      m.rod([x, 0.64, z], [0, 0.89, 0], 0.035, m.palette.iron, "metal");
    }
  for (const y of [0.08, 0.63]) m.block([0, y, 0], [0.56, 0.079, 0.56], m.palette.iron, "metal");
  candle(m, 0, 0.13, 0, 0.31);
  m.fireLight([0, 0.5, 0], 7);
  for (let i = 0; i < 6; i++) {
    const link = new TorusGeometry(0.075, 0.018, 5, 10)
      .rotateY((i * Math.PI) / 2)
      .translate(0, 0.93 + i * 0.106, 0);
    m.add(link, m.palette.iron, "metal");
  }
};

export const rubble: DungeonPart = (m) => {
  for (let i = 0; i < 28; i++) {
    const angle = m.rng.range(0, Math.PI * 2);
    const r = m.rng.range(0.04, 0.95);
    const size = m.rng.range(0.1, 0.35) * (1 - r * 0.55);
    m.gem(
      [Math.cos(angle) * r, size * 0.58, Math.sin(angle) * r],
      [size, size * 0.69, size * 0.81],
      m.palette.stone,
      "solid",
      0,
      angle,
    );
  }
};

export const bones: DungeonPart = (m) => {
  const x = -0.27;
  m.gem([x, 0.25, -0.09], [0.225, 0.235, 0.235], BONE, "solid", 2, 0.2);
  m.block([x, 0.097, 0.067], [0.25, 0.091, 0.233], BONE);
  for (const dx of [-0.087, 0.087])
    m.gem([x + dx, 0.247, 0.11], [0.053, 0.052, 0.048], m.palette.joint, "solid", 1);
  m.gem([x, 0.192, 0.124], [0.036, 0.044, 0.031], m.palette.joint);
  for (let i = 0; i < 6; i++)
    m.block([x + (i - 2.5) * 0.033, 0.144, 0.182], [0.025, 0.048, 0.029], BONE, "solid", 0.003);
  for (const [a, b] of [
    [
      [0.07, 0.066, 0.29],
      [0.68, 0.066, -0.04],
    ],
    [
      [0.12, 0.073, -0.17],
      [0.52, 0.073, 0.29],
    ],
    [
      [-0.51, 0.055, 0.46],
      [-0.05, 0.055, 0.37],
    ],
  ] as [XYZ, XYZ][]) {
    m.rod(a, b, 0.041, BONE);
    for (const p of [a, b]) m.gem(p, [0.081, 0.062, 0.066], BONE, "solid", 1);
  }
};
