import { CylinderGeometry, TorusGeometry } from "three";
import type { XYZ } from "../dungeon/mesh.js";
import { flame } from "../dungeon/props.js";
import { type VillageMesh, type VillagePart, prism } from "./kit.js";

function wheel(m: VillageMesh, [x, y, z]: XYZ, radius: number): void {
  const p = m.palette;
  m.add(new TorusGeometry(radius, 0.06, 5, 12).rotateY(Math.PI / 2).translate(x, y, z), p.wood);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    m.rod(
      [x, y, z],
      [x, y + Math.sin(a) * radius, z + Math.cos(a) * radius],
      0.03,
      p.wood,
      "solid",
      0.03,
      4,
    );
  }
  m.rod([x - 0.08, y, z], [x + 0.08, y, z], 0.09, p.iron, "solid", 0.09, 8);
}

export const cart: VillagePart = (m) => {
  const p = m.palette;
  m.block([0, 0.72, 0], [1.3, 0.1, 2.1], p.wood, "solid", 0.02);
  for (const side of [-1, 1]) {
    m.block([side * 0.62, 0.95, 0], [0.06, 0.38, 2.1], p.wood, "solid", 0.01);
    m.block([0, 0.95, side * 1.02], [1.3, 0.38, 0.06], p.wood, "solid", 0.01);
    wheel(m, [side * 0.75, 0.52, -0.2], 0.52);
    m.rod([side * 0.4, 0.68, 1.05], [side * 0.35, 0.45, 2.4], 0.04, p.wood, "solid", 0.04, 4);
  }
  for (let i = 0; i < 5; i++) {
    m.gem(
      [m.rng.range(-0.35, 0.35), 0.95, m.rng.range(-0.7, 0.7)],
      [0.32, 0.22, 0.3],
      p.hay,
      "solid",
      1,
    );
  }
};

export const haystack: VillagePart = (m) => {
  const p = m.palette;
  m.gem([0, 0.75, 0], [1.25, 0.95, 1.2], p.hay, "solid", 1);
  m.gem([0, 1.45, 0], [0.8, 0.6, 0.78], p.hay, "solid", 1, 0.5);
  m.rod([0, 1.8, 0], [0.05, 2.25, 0.02], 0.04, p.wood, "solid", 0.03, 4);
  for (let i = 0; i < 10; i++) {
    const a = m.rng.range(0, Math.PI * 2);
    m.rod(
      [Math.cos(a) * 1.15, 0.05, Math.sin(a) * 1.15],
      [Math.cos(a) * 1.25, 0.32, Math.sin(a) * 1.25],
      0.025,
      p.hay,
      "solid",
      0.005,
      3,
    );
  }
};

export const woodpile: VillagePart = (m) => {
  const p = m.palette;
  const rows = [5, 4, 3];
  rows.forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * 0.3;
      const y = 0.15 + row * 0.26;
      const r = m.rng.range(0.12, 0.15);
      m.rod([x, y, -0.7], [x, y, 0.7], r, p.wood, "solid", r, 7);
      for (const z of [-0.7, 0.7])
        m.rod([x, y, z], [x, y, z + Math.sign(z) * 0.01], r * 0.92, p.pale, "solid", r * 0.92, 7);
    }
  });
  m.rod([0.95, 0, 0.3], [0.95, 0.32, 0.3], 0.22, p.wood, "solid", 0.22, 8);
  m.rod([0.85, 0.3, 0.3], [1.15, 0.75, 0.35], 0.025, p.wood, "solid", 0.025, 4);
  prism(
    m,
    [
      [0, 0],
      [0.18, 0.02],
      [0.2, 0.12],
      [0, 0.1],
    ],
    0.03,
    [1.04, 0.48, 0.32],
    p.iron,
  );
};

export const lampPost: VillagePart = (m) => {
  const p = m.palette;
  m.rod([0, 0, 0], [0, 0.25, 0], 0.18, p.stone, "solid", 0.15, 8);
  m.rod([0, 0.25, 0], [0, 2.9, 0], 0.06, p.iron, "solid", 0.05, 6);
  m.rod([0, 2.8, 0], [0.5, 2.85, 0], 0.035, p.iron, "solid", 0.035, 4);
  m.rod([0.5, 2.85, 0], [0.5, 2.7, 0], 0.012, p.iron, "solid", 0.012, 3);
  m.block([0.5, 2.48, 0], [0.32, 0.4, 0.32], p.iron, "solid", 0.02);
  m.block([0.5, 2.48, 0], [0.36, 0.3, 0.26], p.pale, "glow", 0.01);
  m.block([0.5, 2.48, 0], [0.26, 0.3, 0.36], p.pale, "glow", 0.01);
  m.add(
    new CylinderGeometry(0.02, 0.26, 0.16, 4).rotateY(Math.PI / 4).translate(0.5, 2.76, 0),
    p.iron,
  );
  m.fireLight([0.5, 2.4, 0], 9);
};

export const signpost: VillagePart = (m) => {
  const p = m.palette;
  m.rod([0, 0, 0], [0, 2.2, 0], 0.07, p.wood, "solid", 0.06, 6);
  const arrows: [number, number][] = [
    [1.85, 0.4],
    [1.55, 2.6],
    [1.25, -1.2],
  ];
  for (const [y, yaw] of arrows) {
    const board: [number, number][] = [
      [0.05, -0.12],
      [0.75, -0.12],
      [0.92, 0],
      [0.75, 0.12],
      [0.05, 0.12],
    ];
    prism(m, board, 0.05, [0, y, 0], m.rng.next() > 0.5 ? p.pale : p.wood, { yaw, wear: 0.1 });
  }
};

export const planter: VillagePart = (m) => {
  const p = m.palette;
  m.block([0, 0.25, 0], [1.4, 0.5, 0.6], p.wood, "solid", 0.03);
  m.block([0, 0.48, 0], [1.3, 0.04, 0.5], p.joint, "solid", 0.01);
  for (let i = 0; i < 7; i++) {
    const x = -0.55 + i * 0.18;
    m.gem([x, 0.62, m.rng.range(-0.1, 0.1)], [0.16, 0.18, 0.16], p.leaf, "solid", 1);
    m.gem([x + 0.05, 0.8, m.rng.range(-0.12, 0.12)], [0.07, 0.07, 0.07], i % 3 ? p.flower : p.pale);
  }
};

export const pumpkins: VillagePart = (m) => {
  const p = m.palette;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + m.rng.range(-0.3, 0.3);
    const r = i ? m.rng.range(0.4, 0.75) : 0;
    const s = m.rng.range(0.22, 0.34);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    m.gem([x, s * 0.75, z], [s * 1.2, s * 0.85, s * 1.2], 0xf08a24, "solid", 1);
    m.rod([x, s * 1.5, z], [x + 0.04, s * 1.5 + 0.12, z], 0.025, p.leaf, "solid", 0.02, 4);
    m.gem([x + s * 0.6, s * 0.2, z], [0.14, 0.03, 0.1], p.leaf, "solid", 0, a);
  }
};

export const laundryLine: VillagePart = (m) => {
  const p = m.palette;
  for (const x of [-1.6, 1.6]) {
    m.rod([x, 0, 0], [x, 1.9, 0], 0.05, p.wood, "solid", 0.05, 5);
    m.rod([x, 1.85, -0.2], [x, 1.85, 0.2], 0.03, p.wood, "solid", 0.03, 4);
  }
  m.rod([-1.6, 1.82, 0], [1.6, 1.78, 0], 0.008, p.pale, "solid", 0.008, 3);
  const cloth = [p.cloth, p.pale, p.door, p.flower];
  let x = -1.3;
  for (let i = 0; i < 4; i++) {
    const w = m.rng.range(0.45, 0.7);
    const h = m.rng.range(0.5, 0.85);
    m.block([x + w / 2, 1.78 - h / 2, 0], [w, h, 0.02], cloth[i] ?? p.pale, "solid", 0.005);
    x += w + 0.12;
  }
};

export const scarecrow: VillagePart = (m) => {
  const p = m.palette;
  m.rod([0, 0, 0], [0, 2.2, 0], 0.05, p.wood, "solid", 0.05, 5);
  m.rod([-0.85, 1.55, 0], [0.85, 1.55, 0], 0.04, p.wood, "solid", 0.04, 5);
  m.block([0, 1.3, 0], [0.62, 0.7, 0.26], p.cloth, "solid", 0.06);
  for (const side of [-1, 1]) {
    m.block([side * 0.55, 1.5, 0], [0.55, 0.18, 0.18], p.cloth, "solid", 0.04);
    m.rod([side * 0.82, 1.45, 0], [side * 0.92, 1.3, 0.04], 0.03, p.hay, "solid", 0.005, 3);
  }
  m.gem([0, 2.0, 0], [0.22, 0.24, 0.2], 0xc9a36a, "solid", 1);
  m.add(new CylinderGeometry(0.42, 0.42, 0.04, 10).translate(0, 2.18, 0), p.hay);
  m.add(new CylinderGeometry(0.12, 0.2, 0.28, 10).translate(0, 2.33, 0), p.hay);
};

export const campfire: VillagePart = (m) => {
  const p = m.palette;
  for (let i = 0; i < 9; i++) {
    const a = (i * Math.PI * 2) / 9;
    m.stone([Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62], [0.3, 0.2, 0.24], 0, 0.05, -a);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.4;
    m.rod(
      [Math.cos(a) * 0.42, 0.06, Math.sin(a) * 0.42],
      [Math.cos(a) * 0.05, 0.38, Math.sin(a) * 0.05],
      0.06,
      p.wood,
      "solid",
      0.05,
      6,
    );
  }
  flame(m, [0, 0.12, 0], 1.0);
  m.fireLight([0, 0.6, 0], 22);
  for (const x of [-1.3, 1.3]) m.rod([x, 0.2, -0.4], [x, 0.2, 0.4], 0.2, p.wood, "solid", 0.2, 8);
};

export const trough: VillagePart = (m) => {
  const p = m.palette;
  for (const x of [-0.85, 0.85]) m.block([x, 0.22, 0], [0.12, 0.44, 0.7], p.wood, "solid", 0.02);
  m.block([0, 0.5, 0], [2, 0.08, 0.6], p.wood, "solid", 0.02);
  for (const z of [-0.29, 0.29]) m.block([0, 0.68, z], [2, 0.36, 0.06], p.wood, "solid", 0.02);
  for (const x of [-0.97, 0.97]) m.block([x, 0.68, 0], [0.06, 0.36, 0.6], p.wood, "solid", 0.02);
  m.block([0, 0.78, 0], [1.88, 0.04, 0.5], p.water, "solid", 0.005);
};
