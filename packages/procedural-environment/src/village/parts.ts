import { door, timbers, window } from "./buildings.js";
import { type VillageMesh, type VillagePart, face, prism } from "./kit.js";

/** Village modules are 4 m long, run along X like the dungeon walls, and stand on y = 0. */
const SPAN = 4;
const WALL = 2.6;

function framedWall(m: VillageMesh, opening?: "window" | "door"): void {
  const p = m.palette;
  m.block([0, 0.15, 0], [SPAN, 0.3, 0.42], p.stone, "solid", 0.03);
  m.block([0, 0.3 + WALL / 2, 0], [SPAN, WALL, 0.3], p.plaster, "solid", 0.02);
  for (const yaw of [0, Math.PI]) {
    const f = face(m, [0, 0, yaw ? -0.15 : 0.15], yaw);
    timbers(f, SPAN, 0.3, WALL, 2);
    if (opening === "window") window(f, 0, 0.3 + WALL * 0.55, yaw === 0);
    if (opening === "door" && yaw === 0) door(f, 0, 0.3);
    if (opening === "door" && yaw !== 0) f.block([0, 1.36, 0.03], [1.2, 2.12, 0.1], p.wood);
  }
}

export const timberWall: VillagePart = (m) => framedWall(m);
export const windowWall: VillagePart = (m) => framedWall(m, "window");
export const doorWall: VillagePart = (m) => framedWall(m, "door");

export const gardenWall: VillagePart = (m) => {
  for (let course = 0; course < 3; course++) {
    let x = -SPAN / 2;
    while (x < SPAN / 2 - 0.05) {
      const length = Math.min(m.rng.range(0.38, 0.7), SPAN / 2 - x);
      const h = m.rng.range(0.22, 0.3);
      m.stone(
        [x + length / 2, 0.14 + course * 0.27, m.rng.range(-0.03, 0.03)],
        [length - 0.03, h, 0.52 - course * 0.05],
        0.1,
      );
      x += length;
    }
  }
  for (let i = 0; i < 8; i++) {
    m.stone(
      [-SPAN / 2 + (i + 0.5) * (SPAN / 8), 0.88, 0],
      [0.48, 0.16, 0.5],
      m.palette.cover * 2.2,
      0.05,
      m.rng.range(-0.1, 0.1),
    );
  }
};

export const picketFence: VillagePart = (m) => {
  const p = m.palette;
  for (const x of [-SPAN / 2, 0, SPAN / 2]) m.block([x, 0.55, -0.04], [0.14, 1.1, 0.14], p.wood);
  for (const y of [0.3, 0.78]) m.block([0, y, -0.06], [SPAN, 0.08, 0.06], p.wood, "solid", 0.01);
  for (let i = 0; i < 16; i++) {
    const x = -SPAN / 2 + (i + 0.5) * (SPAN / 16);
    const h = 0.92 + m.rng.range(-0.04, 0.03);
    prism(
      m,
      [
        [-0.07, 0],
        [0.07, 0],
        [0.07, h],
        [0, h + 0.11],
        [-0.07, h],
      ],
      0.04,
      [x, 0, 0],
      p.pale,
      { wear: 0.1 },
    );
  }
};

export const railFence: VillagePart = (m) => {
  const p = m.palette;
  for (const x of [-SPAN / 2, 0, SPAN / 2]) {
    m.rod([x, 0, 0], [x + m.rng.range(-0.04, 0.04), 1.2, 0], 0.09, p.wood, "solid", 0.08, 6);
  }
  for (const y of [0.45, 0.95]) {
    for (const [a, b] of [
      [-SPAN / 2, 0],
      [0, SPAN / 2],
    ] as const) {
      m.rod(
        [a, y + m.rng.range(-0.04, 0.04), 0.09],
        [b, y + m.rng.range(-0.04, 0.04), 0.09],
        0.06,
        p.wood,
        "solid",
        0.06,
        5,
      );
    }
  }
};

export const gate: VillagePart = (m) => {
  const p = m.palette;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) m.stone([side * 1.6, 0.21 + i * 0.4, 0], [0.62, 0.38, 0.62], 0.05);
    m.block([side * 1.6, 1.66, 0], [0.72, 0.12, 0.72], p.stone, "solid", 0.03);
    m.gem([side * 1.6, 1.85, 0], [0.18, 0.2, 0.18], p.stone, "solid", 1);
  }
  for (const side of [-1, 1]) {
    const x0 = side * 1.27;
    const x1 = side * 0.03;
    for (let i = 0; i < 6; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / 6;
      m.block([x, 0.72, 0], [0.18, 1.12, 0.05], p.wood, "solid", 0.01);
    }
    for (const y of [0.35, 1.1])
      m.block([(x0 + x1) / 2, y, 0.05], [1.26, 0.1, 0.05], p.wood, "solid", 0.01);
    m.rod([x0, 0.35, 0.08], [x1, 1.1, 0.08], 0.04, p.wood, "solid", 0.04, 4);
    m.block([x0, 0.72, 0.04], [0.06, 1.2, 0.08], p.iron, "solid", 0.01);
  }
};

function paving(m: VillageMesh, size: number, fill: number): void {
  const cells = Math.round(size / 0.5);
  for (let i = 0; i < cells; i++)
    for (let k = 0; k < cells; k++) {
      if (m.rng.next() > fill) continue;
      const x = -size / 2 + (i + 0.5) * (size / cells) + m.rng.range(-0.04, 0.04);
      const z = -size / 2 + (k + 0.5) * (size / cells) + m.rng.range(-0.04, 0.04);
      const w = size / cells - m.rng.range(0.05, 0.1);
      m.stone(
        [x, 0.03, z],
        [w, 0.1, w * m.rng.range(0.8, 1)],
        m.palette.cover,
        0.04,
        m.rng.range(-0.2, 0.2),
      );
    }
}

export const cobblePath: VillagePart = (m) => {
  m.block([0, -0.02, 0], [SPAN, 0.04, SPAN], m.palette.path, "solid", 0.005);
  paving(m, SPAN, 0.97);
};

export const steppingStones: VillagePart = (m) => {
  for (let i = 0; i < 6; i++) {
    const z = -1.75 + i * 0.7;
    const size = m.rng.range(0.42, 0.62);
    m.stone(
      [m.rng.range(-0.25, 0.25), 0.03, z],
      [size, 0.1, size * 0.8],
      m.palette.cover,
      0.06,
      m.rng.range(0, 3),
    );
  }
};
