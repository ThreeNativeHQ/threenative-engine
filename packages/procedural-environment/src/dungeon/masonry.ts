import { ExtrudeGeometry, Shape } from "three";
import type { DungeonMesh, DungeonPart, XYZ } from "./mesh.js";

export const GRID = 4;
const HALF = GRID / 2;
const HEIGHT = 3.6;
const BLOCK = 0.34;

function courses(
  m: DungeonMesh,
  from: number,
  to: number,
  offset: number,
  height: number,
  yaw = 0,
  bottom = 0,
): void {
  const width = to - from;
  const rows = Math.max(1, Math.round(height / BLOCK));
  const rowHeight = height / rows;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  m.block(
    [
      ((from + to) / 2) * cos + offset * sin,
      bottom + height / 2,
      -((from + to) / 2) * sin + offset * cos,
    ],
    [width, height, 0.51],
    m.palette.joint,
    "solid",
    0.008,
    yaw,
  );
  for (let row = 0; row < rows; row++) {
    const bricks = Math.max(1, Math.round(width / 0.76));
    const stagger = row % 2 === 1 && bricks > 2 ? 0.5 : 0;
    const segments = bricks + Math.ceil(stagger);
    let left = from;
    for (let j = 1; j <= segments; j++) {
      const right =
        j === segments ? to : from + (width * (j - stagger)) / bricks + m.rng.range(-0.11, 0.11);
      const x = (left + right) / 2;
      const depth = m.rng.range(0.55, 0.63);
      m.stone(
        [x * cos + offset * sin, bottom + (row + 0.5) * rowHeight, -x * sin + offset * cos],
        [right - left - 0.018, rowHeight - 0.02, depth],
        0.85 - (row / rows) * 0.65,
        0.035,
        yaw,
      );
      left = right;
    }
  }
}

export const wall: DungeonPart = (m) => courses(m, -HALF, HALF, 0, HEIGHT);
export const corner: DungeonPart = (m) => {
  courses(m, -0.3, HALF, 0, HEIGHT);
  courses(m, 0.3, HALF, 0, HEIGHT, -Math.PI / 2);
};
export const tee: DungeonPart = (m) => {
  wall(m);
  courses(m, 0.3, HALF, 0, HEIGHT, -Math.PI / 2);
};
export const cross: DungeonPart = (m) => {
  tee(m);
  courses(m, -HALF, -0.3, 0, HEIGHT, -Math.PI / 2);
};

export const collapsedWall: DungeonPart = (m) => {
  const level = [3.3, 2.9, 2.2, 1.32, 0.65];
  for (const [i, height] of level.entries()) {
    courses(m, -2 + 0.8 * i, -1.2 + 0.8 * i, 0, height);
    m.gem(
      [m.rng.range(-1.8, 1.8), 0.14, m.rng.range(0.39, 0.78)],
      [0.26, 0.17, 0.24],
      m.palette.stone,
      "solid",
      0,
      m.rng.range(0, Math.PI),
    );
  }
};

function masonryWedge(
  m: DungeonMesh,
  inner: number,
  outer: number,
  a: number,
  b: number,
  depth: number,
  y: number,
  z = 0,
  yaw = 0,
): void {
  const shape = new Shape();
  shape.moveTo(inner * Math.cos(a), inner * Math.sin(a) + y);
  shape.lineTo(outer * Math.cos(a), outer * Math.sin(a) + y);
  shape.absarc(0, y, outer, a, b, false);
  shape.lineTo(inner * Math.cos(b), inner * Math.sin(b) + y);
  shape.absarc(0, y, inner, b, a, true);
  const stone = new ExtrudeGeometry(shape, {
    depth: depth - 0.054,
    curveSegments: 3,
    bevelSegments: 1,
    bevelThickness: 0.027,
    bevelSize: 0.021,
    steps: 1,
  });
  stone
    .translate(0, 0, -depth / 2 + 0.027)
    .rotateY(yaw)
    .translate(0, 0, z);
  m.add(stone, m.palette.stone, "solid", 0.33, 0.62);
}

function ring(
  m: DungeonMesh,
  radius: number,
  thickness: number,
  spring: number,
  depth: number,
  yaw = 0,
  missing = -1,
  z = 0,
): void {
  const blocks = Math.ceil(radius * 7) | 1;
  for (let i = 0; i < blocks; i++) {
    if (i === missing) continue;
    const start = (Math.PI * i) / blocks + 0.016;
    const end = (Math.PI * (i + 1)) / blocks - 0.016;
    const top = i === blocks >> 1 ? thickness * 1.15 : thickness * m.rng.range(0.88, 1.08);
    masonryWedge(
      m,
      radius,
      radius + top,
      start,
      end,
      depth * m.rng.range(0.94, 1.07),
      spring,
      z,
      yaw,
    );
  }
}

function arch(
  m: DungeonMesh,
  width: number,
  opening: number,
  spring: number,
  ruined = false,
): void {
  const radius = opening / 2;
  const thickness = (width - opening) / 3.7;
  const depth = width > GRID ? 0.88 : 0.7;
  courses(m, -width / 2, -radius, 0, spring);
  courses(m, radius, width / 2, 0, spring);
  m.stone([-(width + opening) / 4, spring, 0], [width / 2 - radius, 0.2, depth + 0.11], 0.35);
  m.stone([(width + opening) / 4, spring, 0], [width / 2 - radius, 0.2, depth + 0.11], 0.35);
  ring(m, radius, thickness, spring, depth, 0, ruined ? 2 : -1);
  if (ruined) {
    for (const x of [0.36, 0.72, 1.14, 1.37])
      m.gem([x, 0.16, 0.39 + m.rng.next() * 0.47], [0.25, 0.17, 0.24], m.palette.stone);
  }
}

export const archway: DungeonPart = (m) => arch(m, GRID, 2.52, 1.9);
export const largeArch: DungeonPart = (m) => arch(m, 6, 4.45, 2.4);
export const ruinedArch: DungeonPart = (m) => arch(m, GRID, 2.52, 1.9, true);

function doorway(m: DungeonMesh, window: boolean): void {
  const open = window ? 1.06 : 1.16;
  const top = window ? 2.91 : 2.66;
  for (const side of [-1, 1]) {
    if (side < 0) courses(m, -HALF, -open, 0, top);
    else courses(m, open, HALF, 0, top);
  }
  courses(m, -HALF, HALF, 0, HEIGHT - top, 0, top);
  m.stone([0, top + 0.02, 0], [open * 2 + 0.28, 0.28, 0.7], 0.21, 0.02);
  if (!window) return;
  courses(m, -open, open, 0, 1.11);
  m.stone([0, 1.1, 0], [2.39, 0.2, 0.76], 0.4);
  for (const x of [-0.91, -0.61, -0.3, 0, 0.3, 0.61, 0.91]) {
    m.rod([x, 1.12, 0], [x, 2.86, 0], 0.041, m.palette.iron, "metal", 0.041, 4);
  }
  for (const y of [1.53, 2.03, 2.53])
    m.block([0, y, 0], [2.12, 0.075, 0.073], m.palette.iron, "metal");
}

export const doorFrame: DungeonPart = (m) => doorway(m, false);
export const barredWindow: DungeonPart = (m) => doorway(m, true);

export function paving(m: DungeonMesh, moss: number, cracked = false): void {
  m.block([0, -0.24, 0], [GRID, 0.42, GRID], m.palette.joint, "solid", 0.014);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = i - 1.5;
      const z = j - 1.5;
      if (cracked && (i + j * 2) % 3 === 0) {
        for (const shift of [-0.255, 0.255]) {
          m.stone([x + shift, -0.091, z], [0.455, 0.18, 0.95], moss, 0.045, shift * 0.13);
        }
      } else {
        m.stone([x, -0.09, z], [0.975, 0.18, 0.975], moss, 0.036);
      }
    }
  }
}

export const floor: DungeonPart = (m) => paving(m, 0.23);
export const crackedFloor: DungeonPart = (m) => paving(m, 0.5, true);
export const mossyFloor: DungeonPart = (m) => paving(m, 1.05);

export function grate(m: DungeonMesh, size = GRID, y = -0.08): void {
  const edge = size / 2 - 0.08;
  for (const sign of [-1, 1]) {
    m.block([sign * edge, y, 0], [0.16, 0.17, size], m.palette.iron, "metal");
    m.block([0, y, sign * edge], [size, 0.17, 0.16], m.palette.iron, "metal");
  }
  for (let i = -3; i <= 3; i++) {
    m.block([(i * size) / 8, y, 0], [0.087, 0.12, size - 0.22], m.palette.iron, "metal", 0.012);
    m.block([0, y, (i * size) / 8], [size - 0.22, 0.086, 0.087], m.palette.iron, "metal", 0.012);
  }
}

function tread(
  m: DungeonMesh,
  step: number,
  width: number,
  yaw: number,
  x: number,
  z: number,
): void {
  const h = (step + 1) * 0.25;
  const transverse = Math.sin(yaw);
  const longitudinal = Math.cos(yaw);
  m.block([x, h / 2, z], [width, h, 0.5], m.palette.joint, "solid", 0.008, yaw);
  for (let j = 0; j < width; j++) {
    const offset = j - (width - 1) / 2;
    m.stone(
      [x + offset * longitudinal, h - 0.07, z - offset * transverse],
      [0.964, 0.14, 0.49],
      0.45,
      0.041,
      yaw,
    );
  }
}

export function stairs(m: DungeonMesh, cornered = false): void {
  if (!cornered) {
    for (let i = 0; i < 8; i++) tread(m, i, GRID, 0, 0, 1.75 - i * 0.5);
    return;
  }
  for (let i = 0; i < 4; i++) {
    tread(m, i, 2, 0, -1, 1.75 - i * 0.5);
    tread(m, i + 4, 2, Math.PI / 2, 0.25 + i * 0.5, -1);
  }
  m.block([-1, 0.48, -1], [2, 0.96, 2], m.palette.joint, "solid", 0.01);
  for (const x of [-1.5, -0.5])
    for (const z of [-1.5, -0.5]) m.stone([x, 0.934, z], [0.97, 0.132, 0.97], 0.46);
}

export const ramp: DungeonPart = (m) => {
  const shape = new Shape();
  shape.moveTo(-HALF, 0);
  shape.lineTo(HALF, 0);
  shape.lineTo(HALF, 2);
  shape.closePath();
  m.add(
    new ExtrudeGeometry(shape, { depth: GRID, bevelEnabled: false })
      .translate(0, 0, -HALF)
      .rotateY(Math.PI / 2),
    m.palette.joint,
  );
  const tilt = Math.atan(0.5);
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 4; j++) {
      const z = 1.75 - i * 0.5;
      m.stone([j - 1.5, 1 - z * 0.5 - 0.022, z], [0.98, 0.112, 0.543], 0.46, 0.035, 0, tilt);
    }
};

export const platform: DungeonPart = (m) => {
  for (const x of [-1.53, 1.53])
    for (const z of [-1.53, 1.53]) {
      m.stone([x, 0.5, z], [0.65, 1, 0.65], 0.8);
      m.stone([x, 0.1, z], [0.85, 0.2, 0.85], 0.88);
    }
  m.block([0, 0.99, 0], [GRID, 0.24, GRID], m.palette.joint);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) m.stone([i - 1.5, 1.15, j - 1.5], [0.98, 0.16, 0.98], 0.58);
};

export function pillar(m: DungeonMesh, broken = false): void {
  const cap = broken ? 1.74 : 3.42;
  m.stone([0, 0.12, 0], [1.25, 0.24, 1.25], 0.87);
  m.stone([0, 0.31, 0], [1.03, 0.17, 1.03], 0.69);
  for (let y = 0.54; y < cap; y += 0.36) {
    m.stone([0, y, 0], [0.74, 0.36, 0.74], 0.63 - y * 0.12, 0.045, m.rng.range(-0.025, 0.025));
  }
  if (broken) {
    m.gem([-0.13, 1.79, 0], [0.39, 0.39, 0.38], m.palette.stone, "solid", 0, 0.55);
    m.gem([0.62, 0.22, 0.27], [0.26, 0.22, 0.23], m.palette.stone);
  } else {
    m.stone([0, 3.37, 0], [1.04, 0.2, 1.04], 0.27);
    m.stone([0, 3.54, 0], [1.25, 0.16, 1.25], 0.23);
  }
}

export const vault: DungeonPart = (m) => {
  for (const yaw of [-Math.PI / 4, Math.PI / 4]) ring(m, 2.65, 0.23, 0, 0.22, yaw);
  for (const z of [-1.92, 1.92]) ring(m, 1.97, 0.27, 0, 0.24, 0, -1, z);
  for (let row = -3; row <= 3; row++) {
    const z = row * 0.55;
    const rise = Math.sqrt(1 - (z / 2.03) ** 2);
    for (let col = -3; col <= 3; col++) {
      const x = col * 0.55;
      const y = Math.max(rise, Math.sqrt(1 - (x / 2.03) ** 2)) * 1.95;
      m.stone([x, y, z], [0.55, 0.26, 0.55], 0.31, 0.043);
    }
  }
};

export const beam: DungeonPart = (m) => {
  m.block([0, 1.63, 0], [GRID, 0.43, 0.43], m.palette.wood);
  for (const x of [-1.67, 1.67]) {
    m.block([x, 0.79, 0], [0.32, 1.6, 0.34], m.palette.wood);
    m.rod([x, 0.82, 0], [x * 0.57, 1.47, 0], 0.14, m.palette.wood, "solid", 0.14, 4);
    for (const y of [1.51, 1.76])
      m.block([x, y, 0.235], [0.11, 0.11, 0.035], m.palette.iron, "metal");
  }
};
