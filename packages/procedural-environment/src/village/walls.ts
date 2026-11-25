import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Shape } from "three";
import { noise3 } from "../../vendor/stylized-biome-kit/core.js";
import type { XYZ } from "../dungeon/mesh.js";
import { door } from "./buildings.js";
import { type Face, type VillageMesh, type VillagePart, face, prism, spire } from "./kit.js";

/** Town wall modules: 4 m segments along X, outer face +Z, walkway on top at WALK. */
const SPAN = 4;
const WALK = 4.7;
const COURSE = 0.46;

/** A facing stone: a plain box with chipped corners, 12 triangles against a rounded stone's 108. */
function brick(m: VillageMesh, [x, y, z]: XYZ, [w, h, d]: XYZ, yaw: number): void {
  const shape = new BoxGeometry(w, h, d);
  const pos = shape.getAttribute("position");
  const grit = m.rng.seed() % 997;
  for (let v = 0; v < pos.count; v++) {
    const px = pos.getX(v);
    const py = pos.getY(v);
    const pz = pos.getZ(v);
    const chip = 1 - Math.max(0, noise3(px * 9, py * 9, pz * 9, grit) + 0.1) * 0.16;
    pos.setXYZ(v, px * chip, py * chip, pz);
  }
  shape.rotateY(yaw).translate(x, y, z);
  m.add(shape, m.palette.stone, "solid", 0.31, m.palette.cover * 0.8);
}

/**
 * Coursed facing stones on a face, u0..u1 by y0..y1, proud of the mortar core at v = 0.
 * `open(a, b, y)` leaves out stones that would cover a doorway or an arch.
 */
function ashlar(
  f: Face,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  open?: (a: number, b: number, y: number) => boolean,
): void {
  const rows = Math.max(1, Math.round((y1 - y0) / COURSE));
  const rh = (y1 - y0) / rows;
  const bricks = Math.max(1, Math.round((u1 - u0) / 0.85));
  for (let row = 0; row < rows; row++) {
    const y = y0 + (row + 0.5) * rh;
    const stagger = row % 2 && bricks > 1 ? 0.5 : 0;
    const segments = bricks + Math.ceil(stagger);
    let left = u0;
    for (let j = 1; j <= segments; j++) {
      const right =
        j === segments
          ? u1
          : u0 + ((u1 - u0) * (j - stagger)) / bricks + f.m.rng.range(-0.08, 0.08);
      if (!open?.(left, right, y)) {
        brick(
          f.m,
          f.at([(left + right) / 2, y, 0.07]),
          [right - left - 0.05, rh - 0.05, 0.18],
          f.yaw,
        );
      }
      left = right;
    }
  }
}

/** A crenellated parapet on corbels along X at height `y`, its outer face at `z` (+Z out). */
function battlement(m: VillageMesh, x0: number, x1: number, y: number, z: number): void {
  const p = m.palette;
  const corbels = Math.round((x1 - x0) / 0.8);
  for (let i = 0; i < corbels; i++) {
    const x = x0 + (i + 0.5) * ((x1 - x0) / corbels);
    m.block([x, y - 0.22, z - 0.02], [0.26, 0.36, 0.34], p.stone, "solid", 0.03);
    m.block([x, y - 0.44, z - 0.1], [0.22, 0.14, 0.2], p.stone, "solid", 0.02);
  }
  m.block([(x0 + x1) / 2, y + 0.3, z - 0.02], [x1 - x0, 0.6, 0.32], p.stone, "solid", 0.03);
  m.block([(x0 + x1) / 2, y + 0.04, z + 0.02], [x1 - x0 + 0.02, 0.1, 0.4], p.stone, "solid", 0.02);
  const count = Math.round((x1 - x0) / 1);
  for (let i = 0; i < count; i++) {
    const x = x0 + (i + 0.5) * ((x1 - x0) / count);
    m.block([x, y + 0.98, z - 0.02], [0.6, 0.76, 0.32], p.stone, "solid", 0.04);
    m.stone([x, y + 1.4, z - 0.02], [0.68, 0.1, 0.4], p.cover * 2.5, 0.02);
    m.block([x, y + 0.98, z + 0.15], [0.07, 0.42, 0.02], p.joint, "solid", 0.005);
  }
}

export const cityWall: VillagePart = (m) => {
  const p = m.palette;
  m.block([0, WALK / 2, 0], [SPAN, WALK, 1.5], p.joint, "solid", 0.02);
  // a battered foot on the outside, a plain footing inside
  prism(
    m,
    [
      [-0.75, 0],
      [-1.35, 0],
      [-0.75, 1.3],
    ],
    SPAN,
    [0, 0, 0],
    p.stone,
    { yaw: Math.PI / 2, cover: p.cover, wear: 0.2 },
  );
  m.block([0, 0.25, -0.8], [SPAN, 0.5, 0.25], p.stone, "solid", 0.03);
  ashlar(face(m, [0, 0, 0.75], 0), -SPAN / 2, SPAN / 2, 1.1, WALK - 0.25);
  ashlar(face(m, [0, 0, -0.75], Math.PI), -SPAN / 2, SPAN / 2, 0.5, WALK - 0.1);
  m.block([0, WALK - 0.18, 0.86], [SPAN + 0.02, 0.14, 0.3], p.stone, "solid", 0.02);
  m.block([0, WALK + 0.06, -0.06], [SPAN, 0.12, 1.5], p.stone, "solid", 0.01);
  for (let i = 0; i < 5; i++) {
    m.block([-1.6 + i * 0.8, WALK + 0.13, -0.15], [0.76, 0.02, 1.05], p.joint, "solid", 0.005);
  }
  battlement(m, -SPAN / 2, SPAN / 2, WALK + 0.1, 0.92);
  m.block([0, WALK + 0.3, -0.7], [SPAN, 0.36, 0.2], p.stone, "solid", 0.02);
};

/** Round tower: mortar drum faced with curved courses, a string course, a corbelled battlement and a tiled roof. */
function roundTower(m: VillageMesh, x: number, z: number, radius: number, height: number): void {
  const p = m.palette;
  const drum = (r0: number, r1: number, h: number, y: number, color: number, cover = 0) =>
    m.add(new CylinderGeometry(r0, r1, h, 12).translate(x, y, z), color, "solid", 0.12, cover);
  drum(radius + 0.3, radius + 0.55, 1.1, 0.55, p.stone, p.cover);
  drum(radius, radius, height, height / 2, p.joint);
  const rows = Math.round((height - 1.1) / COURSE);
  const rh = (height - 1.1) / rows;
  const count = Math.round((Math.PI * 2 * radius) / 0.85);
  const chord = 2 * (radius + 0.06) * Math.sin(Math.PI / count) - 0.05;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < count; i++) {
      const a = ((i + (row % 2) * 0.5) * Math.PI * 2) / count + m.rng.range(-0.02, 0.02);
      const y = 1.1 + (row + 0.5) * rh;
      brick(
        m,
        [x + Math.cos(a) * (radius + 0.06), y, z + Math.sin(a) * (radius + 0.06)],
        [chord, rh - 0.05, 0.18],
        -a - Math.PI / 2,
      );
    }
  }
  drum(radius + 0.2, radius + 0.2, 0.16, height * 0.55, p.stone);
  for (let i = 0; i < 14; i++) {
    const a = (i * Math.PI * 2) / 14;
    m.block(
      [x + Math.cos(a) * (radius + 0.2), height - 0.2, z + Math.sin(a) * (radius + 0.2)],
      [0.26, 0.4, 0.4],
      p.stone,
      "solid",
      0.03,
      -a - Math.PI / 2,
    );
  }
  drum(radius + 0.42, radius + 0.42, 0.7, height + 0.35, p.stone);
  drum(radius + 0.46, radius + 0.46, 0.1, height + 0.05, p.stone);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI * 2) / 12;
    const r = radius + 0.3;
    m.block(
      [x + Math.cos(a) * r, height + 1.05, z + Math.sin(a) * r],
      [0.62, 0.7, 0.3],
      p.stone,
      "solid",
      0.04,
      -a - Math.PI / 2,
    );
  }
  for (const [a, y] of [
    [0.4, height * 0.4],
    [2.2, height * 0.7],
    [3.9, height * 0.45],
    [5.3, height * 0.72],
  ] as const) {
    const r = radius + 0.17;
    m.block(
      [x + Math.cos(a) * r, y, z + Math.sin(a) * r],
      [0.34, 1.0, 0.12],
      p.stone,
      "solid",
      0.02,
      -a - Math.PI / 2,
    );
    m.block(
      [x + Math.cos(a) * (r + 0.05), y, z + Math.sin(a) * (r + 0.05)],
      [0.1, 0.72, 0.06],
      0x1f2233,
      "solid",
      0.005,
      -a - Math.PI / 2,
    );
  }
  spire(m, [x, height + 1.4, z], radius + 0.75, radius * 1.4, 12);
  const tip = height + 1.4 + radius * 1.4 + 0.5;
  m.rod([x, tip, z], [x, tip + 0.9, z], 0.03, p.iron, "solid", 0.03, 4);
  m.block([x + 0.28, tip + 0.68, z], [0.5, 0.3, 0.02], p.cloth, "solid", 0.005);
}

export const wallTower: VillagePart = (m) => {
  roundTower(m, 0, 0, 2.3, 7.2);
  door(face(m, [0, 0, -2.38], Math.PI), 0, 0.2);
};

export const gatehouse: VillagePart = (m) => {
  const p = m.palette;
  const half = 2.4;
  const top = 6.6;
  const gate = 1.6;
  const spring = 3;
  const outline = new Shape();
  outline.moveTo(-half, 0);
  outline.lineTo(-gate, 0);
  outline.lineTo(-gate, spring);
  outline.absarc(0, spring, gate, Math.PI, 0, true);
  outline.lineTo(gate, 0);
  outline.lineTo(half, 0);
  outline.lineTo(half, top);
  outline.lineTo(-half, top);
  outline.closePath();
  const body = new ExtrudeGeometry(outline, { depth: 3, bevelEnabled: false, curveSegments: 10 });
  m.add(body.translate(0, 0, -1.5), p.joint, "solid", 0.1);
  // facing stones stop where the arch opens: beside the jambs and inside the arc with its voussoirs
  const arch = (a: number, b: number, y: number) => {
    const reach =
      y < spring ? gate + 0.4 : Math.sqrt(Math.max(0, (gate + 0.5) ** 2 - (y - spring) ** 2));
    return b > -reach && a < reach && y < spring + gate + 0.5;
  };
  for (const yaw of [0, Math.PI])
    ashlar(face(m, [0, 0, yaw ? -1.5 : 1.5], yaw), -half, half, 0, top - 0.2, arch);
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (i * Math.PI) / 10;
    for (const z of [1.55, -1.55]) {
      m.block(
        [Math.cos(a) * (gate + 0.25), spring + Math.sin(a) * (gate + 0.25), z],
        [0.3, 0.5, 0.14],
        i === 5 ? p.pale : p.stone,
        "solid",
        0.03,
        0,
      );
    }
  }
  for (const side of [-1, 1]) {
    for (const z of [1.55, -1.55])
      m.block([side * (gate + 0.2), spring / 2, z], [0.4, spring, 0.14], p.stone, "solid", 0.03);
  }
  battlement(m, -half, half, top, 1.62);
  m.block([0, top + 0.06, 0], [half * 2, 0.12, 3], p.stone, "solid", 0.01);
  for (const side of [-1, 1]) roundTower(m, side * 3.4, 0.4, 1.8, 8.2);
  // the portcullis hangs half raised in the arch
  for (let x = -gate + 0.2; x < gate - 0.1; x += 0.36) {
    const ceiling = spring + Math.sqrt(Math.max(0, gate * gate - x * x)) - 0.05;
    m.rod([x, 2.1, 0.9], [x, ceiling, 0.9], 0.035, p.iron, "solid", 0.035, 4);
    m.rod([x, 2.1, 0.9], [x, 1.9, 0.9], 0.035, p.iron, "solid", 0.004, 4);
  }
  for (const y of [2.3, 2.9, 3.5, 4.1]) {
    const reach = Math.sqrt(Math.max(0, gate * gate - Math.max(0, y - spring) ** 2)) - 0.05;
    m.block([0, y, 0.9], [reach * 2, 0.06, 0.06], p.iron, "solid", 0.005);
  }
  // open gate leaves against the inner jambs, banners on the outer face
  for (const side of [-1, 1]) {
    m.block([side * (gate - 0.1), 1.45, -2.25], [0.12, 2.9, 1.5], p.door, "solid", 0.01);
    for (const y of [0.5, 2.4])
      m.block([side * (gate - 0.03), y, -2.25], [0.04, 0.1, 1.45], p.iron, "solid", 0.005);
    m.block([side * 1.25, 5.3, 1.75], [0.7, 1.5, 0.04], p.cloth, "solid", 0.005);
    m.gem([side * 1.25, 5.4, 1.78], [0.17, 0.17, 0.03], p.pale, "solid", 1);
  }
  for (let i = 0; i < 12; i++) {
    m.stone(
      [m.rng.range(-1.4, 1.4), 0.03, m.rng.range(-1.4, 1.4)],
      [0.45, 0.08, 0.4],
      0,
      0.04,
      m.rng.range(0, 3),
    );
  }
};
