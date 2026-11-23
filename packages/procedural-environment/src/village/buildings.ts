import { CylinderGeometry } from "three";
import type { XYZ } from "../dungeon/mesh.js";
import { flame } from "../dungeon/props.js";
import {
  type Face,
  type VillageMesh,
  type VillagePart,
  face,
  gable,
  prism,
  roof,
  spire,
} from "./kit.js";

export const PLINTH = 0.35;
export const OVERHANG = 0.4;

/** Timber framing on one face: corner posts, sill, plate, studs between window bays, corner braces. */
export function timbers(f: Face, width: number, y0: number, h: number, bays: number): void {
  const { wood } = f.m.palette;
  const half = width / 2;
  for (const u of [-half, half]) f.block([u, y0 + h / 2, 0.02], [0.2, h, 0.1], wood);
  for (const y of [y0 + 0.08, y0 + h - 0.09]) f.block([0, y, 0.025], [width, 0.16, 0.1], wood);
  for (let i = 1; i < bays; i++) {
    f.block([-half + (i * width) / bays, y0 + h / 2, 0.02], [0.14, h - 0.2, 0.08], wood);
  }
  for (const side of [-1, 1]) {
    f.rod(
      [side * (half - 0.12), y0 + 0.2, 0.03],
      [side * (half - 0.75), y0 + h * 0.62, 0.03],
      0.055,
      wood,
      4,
    );
  }
}

export function window(f: Face, u: number, y: number, planter = false): void {
  const p = f.m.palette;
  f.block([u, y, 0.04], [0.86, 0.98, 0.12], p.wood);
  f.block([u, y, 0.1], [0.66, 0.78, 0.02], p.glass, 0.005);
  f.block([u, y, 0.12], [0.06, 0.78, 0.03], p.wood, 0.005);
  f.block([u, y + 0.02, 0.12], [0.66, 0.06, 0.03], p.wood, 0.005);
  for (const side of [-1, 1]) {
    f.block([u + side * 0.6, y, 0.07], [0.32, 0.96, 0.05], p.door);
    f.block([u + side * 0.6, y + 0.25, 0.1], [0.24, 0.05, 0.02], p.ridge, 0.005);
  }
  f.block([u, y - 0.54, 0.1], [1.0, 0.08, 0.24], p.stone, 0.02);
  if (!planter) return;
  f.block([u, y - 0.7, 0.2], [0.92, 0.22, 0.26], p.wood);
  for (let i = 0; i < 6; i++) {
    const x = u - 0.36 + i * 0.145;
    f.gem([x, y - 0.55, 0.22], [0.12, 0.1, 0.11], p.leaf, 1);
    f.gem([x + 0.04, y - 0.48, 0.28], [0.06, 0.06, 0.06], p.flower);
  }
}

export function door(f: Face, u: number, y0: number, wide = 1): void {
  const p = f.m.palette;
  f.block([u, y0 + 1.06, 0.03], [1.2 * wide, 2.12, 0.12], p.wood);
  f.block([u, y0 + 0.99, 0.08], [0.94 * wide, 1.96, 0.06], p.door);
  for (const k of [-1, 1])
    f.block([u + k * 0.24 * wide, y0 + 0.99, 0.11], [0.04, 1.9, 0.02], p.ridge, 0.005);
  for (const y of [0.45, 1.55]) f.block([u, y0 + y, 0.12], [0.9 * wide, 0.08, 0.03], p.iron, 0.01);
  f.gem([u + 0.3 * wide, y0 + 1.0, 0.15], [0.05, 0.05, 0.04], p.pale);
  f.stone([u, -0.02 + y0 * 0.5, 0.45], [1.3 * wide, Math.max(0.12, y0), 0.6], 0.2);
}

function quoins(f: Face, width: number, y0: number, h: number): void {
  const courses = Math.round(h / 0.42);
  for (let i = 0; i < courses; i++) {
    const long = i % 2 === 0;
    for (const side of [-1, 1]) {
      const size = long ? 0.62 : 0.38;
      f.stone(
        [side * (width / 2 - size / 2 + 0.04), y0 + (i + 0.5) * (h / courses), 0.04],
        [size, h / courses - 0.03, 0.14],
      );
    }
  }
}

export function chimney(m: VillageMesh, x: number, z: number, top: number): void {
  const courses = Math.ceil(top / 0.46);
  for (let i = 0; i < courses; i++) {
    m.stone([x + m.rng.range(-0.03, 0.03), 0.23 + i * 0.46, z], [0.82, 0.44, 0.82], 0.05);
  }
  m.block([x, courses * 0.46 + 0.06, z], [0.98, 0.12, 0.98], m.palette.stone, "solid", 0.03);
  m.block([x, courses * 0.46 + 0.14, z], [0.5, 0.06, 0.5], m.palette.joint, "solid", 0.01);
}

interface IHouse {
  width: number;
  depth: number;
  wall: number;
  rise: number;
  storeys?: number;
  stoneGround?: boolean;
  bays?: number;
  planters?: boolean;
  chimneys?: number[];
}

/** A gabled house: ridge along X, door on +Z. Returns the eave height. */
export function house(m: VillageMesh, o: IHouse): number {
  const { width, depth, wall, rise, storeys = 1, bays = 2 } = o;
  const p = m.palette;
  m.block([0, PLINTH / 2, 0], [width + 0.24, PLINTH, depth + 0.24], p.stone, "solid", 0.04);
  let y = PLINTH;
  let w = width;
  let d = depth;
  for (let storey = 0; storey < storeys; storey++) {
    const stone = o.stoneGround === true && storey === 0 && storeys > 1;
    if (storey > 0) {
      w += 0.3;
      d += 0.3;
      m.block([0, y + 0.06, 0], [w + 0.08, 0.14, d + 0.08], p.wood, "solid", 0.02);
    }
    m.block([0, y + wall / 2, 0], [w, wall, d], stone ? p.stone : p.plaster, "solid", 0.03);
    const faces: [Face, number, number][] = [
      [face(m, [0, 0, d / 2], 0), w, bays],
      [face(m, [0, 0, -d / 2], Math.PI), w, bays],
      [face(m, [w / 2, 0, 0], Math.PI / 2), d, 1],
      [face(m, [-w / 2, 0, 0], -Math.PI / 2), d, 1],
    ];
    faces.forEach(([f, span, count], index) => {
      if (stone) quoins(f, span, y, wall);
      else timbers(f, span, y, wall, count === 1 ? 2 : count);
      const front = index === 0 && storey === 0;
      for (let i = 0; i < count; i++) {
        let u = -span / 2 + ((i + 0.5) * span) / count;
        if (front && Math.abs(u) < 0.95) continue;
        if (front) u = Math.sign(u) * Math.max(Math.abs(u), 1.6); // shutters clear the door
        window(f, u, y + wall * 0.55, o.planters === true && storey === 0);
      }
      if (front) door(f, 0, y);
    });
    y += wall;
  }
  for (const side of [-1, 1])
    gable(m, [side * (w / 2 - 0.1), y, 0], d, rise, p.plaster, Math.PI / 2);
  for (const side of [-1, 1]) {
    const f = face(m, [side * (w / 2), 0, 0], (side * Math.PI) / 2);
    f.block([0, y + rise * 0.42, 0.06], [0.5, 0.5, 0.06], p.wood);
    f.block([0, y + rise * 0.42, 0.1], [0.34, 0.34, 0.02], p.glass, 0.005);
  }
  const drop = (rise * OVERHANG) / (d / 2);
  roof(m, [0, y - drop, 0], d + OVERHANG * 2, rise + drop, w + OVERHANG * 1.5, {
    yaw: Math.PI / 2,
    rows: Math.max(4, Math.round(rise * 2.4)),
  });
  for (const x of o.chimneys ?? []) chimney(m, x, -d * 0.22, y + rise * 0.95);
  return y;
}

export const cottage: VillagePart = (m) => {
  house(m, { width: 5, depth: 4, wall: 2.4, rise: 1.9, bays: 2, planters: true, chimneys: [1.7] });
};

export const townhouse: VillagePart = (m) => {
  house(m, {
    width: 5,
    depth: 4.4,
    wall: 2.3,
    rise: 2.2,
    storeys: 2,
    stoneGround: true,
    bays: 2,
    chimneys: [-1.6],
  });
};

export const tavern: VillagePart = (m) => {
  const p = m.palette;
  house(m, {
    width: 8,
    depth: 5,
    wall: 2.5,
    rise: 2.5,
    storeys: 2,
    stoneGround: true,
    bays: 3,
    chimneys: [-3, 3],
  });
  const f = face(m, [0, 0, 2.65], 0);
  f.rod([2.9, 3.4, 0.05], [2.9, 3.4, 1.15], 0.05, p.iron, 4);
  for (const x of [0.75, 1.05]) f.rod([2.9, 3.4, x], [2.9, 3.18, x], 0.015, p.iron, 4);
  f.block([2.9, 2.85, 0.9], [0.08, 0.64, 0.86], p.wood, 0.03);
  for (const side of [-1, 1]) f.gem([2.9 + side * 0.05, 2.85, 0.9], [0.03, 0.2, 0.2], p.pale, 1);
  f.gem([2.9, 2.85, 0.9], [0.08, 0.12, 0.12], p.cloth, 1);
};

export const barn: VillagePart = (m) => {
  const p = m.palette;
  const width = 6;
  const depth = 7.5;
  const wall = 3;
  m.block([0, PLINTH / 2, 0], [width + 0.24, PLINTH, depth + 0.24], p.stone, "solid", 0.04);
  m.block([0, PLINTH + wall / 2, 0], [width - 0.1, wall, depth - 0.1], p.ridge, "solid", 0.02);
  const planks = (f: Face, span: number, h: number) => {
    const count = Math.round(span / 0.34);
    for (let i = 0; i < count; i++) {
      const u = -span / 2 + (i + 0.5) * (span / count);
      f.block([u, PLINTH + h / 2, 0.02], [span / count - 0.03, h, 0.08], p.wood, 0.01);
    }
    for (const u of [-span / 2, span / 2])
      f.block([u, PLINTH + h / 2, 0.06], [0.22, h, 0.12], p.wood);
  };
  planks(face(m, [width / 2, 0, 0], Math.PI / 2), depth, wall);
  planks(face(m, [-width / 2, 0, 0], -Math.PI / 2), depth, wall);
  for (const side of [-1, 1]) {
    const f = face(m, [0, 0, (side * depth) / 2], side > 0 ? 0 : Math.PI);
    planks(f, width, wall);
    gable(m, [0, PLINTH + wall, side * (depth / 2 - 0.1)], width, 2.6, p.wood);
    f.block([0, PLINTH + wall + 0.9, 0.14], [0.9, 0.9, 0.08], p.door);
    f.block([0, PLINTH + wall + 0.9, 0.18], [0.66, 0.66, 0.02], p.hay, 0.005);
    if (side < 0) continue;
    for (const k of [-1, 1]) {
      const u = k * 0.72;
      f.block([u, PLINTH + 1.2, 0.12], [1.36, 2.4, 0.08], p.door);
      f.rod([u - 0.6, PLINTH + 0.15, 0.17], [u + 0.6, PLINTH + 2.25, 0.17], 0.05, p.pale, 4);
      f.rod([u + 0.6, PLINTH + 0.15, 0.17], [u - 0.6, PLINTH + 2.25, 0.17], 0.05, p.pale, 4);
      f.block([u, PLINTH + 2.38, 0.16], [1.4, 0.1, 0.06], p.pale, 0.01);
    }
  }
  const drop = (2.6 * OVERHANG) / (width / 2);
  roof(m, [0, PLINTH + wall - drop, 0], width + OVERHANG * 2, 2.6 + drop, depth + 0.7, { rows: 6 });
};

export const watchtower: VillagePart = (m) => {
  const p = m.palette;
  const shaft = 6;
  m.block([0, shaft / 2, 0], [2.6, shaft, 2.6], p.stone, "solid", 0.04);
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const f = face(m, [Math.sin(yaw) * 1.3, 0, Math.cos(yaw) * 1.3], yaw);
    quoins(f, 2.6, 0, shaft);
    f.block([0, shaft * 0.62, 0.03], [0.22, 0.8, 0.08], p.glass, 0.01);
    if (yaw === 0) door(f, 0, 0.15);
  }
  m.block([0, shaft + 0.1, 0], [3.6, 0.2, 3.6], p.wood, "solid", 0.03);
  for (const x of [-1.6, 1.6])
    for (const z of [-1.6, 1.6]) {
      m.block([x, shaft + 1.1, z], [0.18, 2, 0.18], p.wood);
      m.rod([x * 0.4, shaft - 1.2, z * 0.4], [x, shaft, z], 0.06, p.wood, "solid", 0.06, 4);
    }
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const f = face(m, [Math.sin(yaw) * 1.6, 0, Math.cos(yaw) * 1.6], yaw);
    for (const y of [0.45, 0.95]) f.block([0, shaft + y, 0], [3.2, 0.09, 0.08], p.wood, 0.01);
  }
  spire(m, [0, shaft + 2.1, 0], 2.75, 2, 4, Math.PI / 4);
  m.rod([0, shaft + 4.05, 0], [0, shaft + 4.7, 0], 0.03, p.iron, "solid", 0.03, 4);
  prism(
    m,
    [
      [0, 0],
      [0.5, 0.12],
      [0, 0.26],
    ],
    0.02,
    [0, shaft + 4.4, 0],
    p.cloth,
  );
};

export const windmill: VillagePart = (m) => {
  const p = m.palette;
  // Eight sides turned by π/8 so a flat side, not a corner, faces the door.
  const drum = (top: number, bottom: number, h: number, y: number, color: number, cover = 0) =>
    m.add(
      new CylinderGeometry(top, bottom, h, 8).rotateY(Math.PI / 8).translate(0, y, 0),
      color,
      "solid",
      0.12,
      cover,
    );
  drum(2.3, 2.45, 0.7, 0.35, p.stone, p.cover);
  drum(1.75, 2.1, 5.6, 3.5, p.plaster);
  drum(2.16, 2.16, 0.2, 0.9, p.wood);
  drum(1.82, 1.82, 0.2, 6.25, p.wood);
  spire(m, [0, 6.35, 0], 1.95, 2.1, 8, Math.PI / 8);
  door(face(m, [0, 0, 1.86], 0), 0, 0.7);
  const upper = face(m, [0, 0, 1.7], 0);
  upper.block([0, 3.9, 0], [0.62, 0.8, 0.12], p.wood);
  upper.block([0, 3.9, 0.06], [0.44, 0.6, 0.02], p.glass, 0.005);
  const hub: XYZ = [0, 6.6, 2.0];
  m.rod([0, 6.6, 1.2], hub, 0.16, p.wood, "solid", 0.16, 8);
  m.gem([0, 6.6, 2.05], [0.22, 0.22, 0.14], p.iron, "solid", 1);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.35;
    const dir = [Math.cos(a), Math.sin(a)] as const;
    const side = [-dir[1], dir[0]] as const;
    const tip = 4.6;
    m.rod(
      hub,
      [hub[0] + dir[0] * tip, hub[1] + dir[1] * tip, 2.05],
      0.07,
      p.wood,
      "solid",
      0.05,
      4,
    );
    const at = (r: number, s: number): [number, number] => [
      dir[0] * r + side[0] * s,
      dir[1] * r + side[1] * s,
    ];
    prism(
      m,
      [at(0.7, 0.08), at(tip, 0.08), at(tip, 0.95), at(0.7, 0.85)],
      0.04,
      [hub[0], hub[1], 2.12],
      p.pale,
      { wear: 0.06 },
    );
    for (let k = 1; k < 5; k++) {
      const r = 0.7 + (k * (tip - 0.7)) / 5;
      const [ax, ay] = at(r, 0.05);
      const [bx, by] = at(r, 0.92);
      m.rod(
        [hub[0] + ax, hub[1] + ay, 2.16],
        [hub[0] + bx, hub[1] + by, 2.16],
        0.03,
        p.wood,
        "solid",
        0.03,
        4,
      );
    }
  }
};

export const forge: VillagePart = (m) => {
  const p = m.palette;
  m.block([0, 0.1, 0], [5, 0.2, 4], p.stone, "solid", 0.03);
  for (const x of [-2.3, 2.3])
    for (const z of [-1.8, 1.8]) m.block([x, 1.5, z], [0.24, 2.8, 0.24], p.wood);
  for (const z of [-1.8, 1.8]) m.block([0, 2.84, z], [4.9, 0.22, 0.24], p.wood);
  roof(m, [0, 2.8, 0], 5.6, 1.4, 5.8, { yaw: Math.PI / 2, rows: 4 });
  m.block([-1.2, 0.55, -1.1], [1.9, 0.9, 1.3], p.stone, "solid", 0.05);
  m.block([-1.2, 1.02, -1.1], [1.5, 0.08, 0.95], p.joint, "solid", 0.01);
  flame(m, [-1.2, 1.04, -1.1], 0.9);
  m.fireLight([-1.2, 1.6, -0.8], 26);
  chimney(m, -1.2, -1.5, 4.9);
  m.rod([0.9, 0.2, 0.4], [0.9, 0.62, 0.4], 0.3, p.wood, "solid", 0.32, 9);
  prism(
    m,
    [
      [-0.42, 0],
      [0.42, 0],
      [0.42, 0.1],
      [0.62, 0.22],
      [0.42, 0.32],
      [-0.36, 0.32],
      [-0.36, 0.1],
    ],
    0.26,
    [0.9, 0.62, 0.4],
    p.iron,
    { wear: 0.08 },
  );
  m.block([1.6, 0.35, -1.2], [1.4, 0.5, 0.7], p.wood, "solid", 0.03);
  m.block([1.6, 0.58, -1.2], [1.2, 0.04, 0.5], p.water, "solid", 0.005);
  for (let i = 0; i < 4; i++) {
    const x = -0.4 + i * 0.32;
    m.rod([x, 1.2, -1.75], [x, 2.1, -1.75], 0.025, p.wood, "solid", 0.025, 4);
    m.block([x, 1.15, -1.73], [0.12, 0.2, 0.04], p.iron, "solid", 0.01);
  }
};

export const marketStall: VillagePart = (m) => {
  const p = m.palette;
  for (const x of [-1.4, 1.4]) {
    m.block([x, 1.2, 0.9], [0.14, 2.4, 0.14], p.wood);
    m.block([x, 1.5, -0.9], [0.14, 3, 0.14], p.wood);
  }
  m.block([0, 0.5, 0.55], [3, 1, 0.9], p.wood, "solid", 0.03);
  m.block([0, 1.03, 0.55], [3.1, 0.07, 1], p.pale, "solid", 0.01);
  const stripes = 7;
  for (let i = 0; i < stripes; i++) {
    const x = -1.6 + (i + 0.5) * (3.2 / stripes);
    const color = i % 2 ? p.pale : p.cloth;
    prism(
      m,
      [
        [-1.25, 3.05],
        [1.35, 2.45],
        [1.35, 2.41],
        [-1.25, 3.01],
      ],
      3.2 / stripes,
      [x, 0, 0],
      color,
      { yaw: -Math.PI / 2, wear: 0.05 },
    );
    prism(
      m,
      [
        [-0.23, 0],
        [0.23, 0],
        [0, -0.28],
      ],
      0.04,
      [x, 2.43, 1.36],
      color,
      { wear: 0.05 },
    );
  }
  const produce = [p.flower, p.hay, p.leaf, p.cloth];
  for (let i = 0; i < 4; i++) {
    const x = -1.1 + i * 0.73;
    m.block([x, 1.15, 0.55], [0.6, 0.18, 0.6], p.wood, "solid", 0.02);
    for (let k = 0; k < 5; k++) {
      m.gem(
        [x + m.rng.range(-0.18, 0.18), 1.3, 0.55 + m.rng.range(-0.18, 0.18)],
        [0.1, 0.09, 0.1],
        produce[i] ?? p.hay,
        "solid",
        1,
      );
    }
  }
};

export const well: VillagePart = (m) => {
  const p = m.palette;
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI * 2) / 12;
    m.stone(
      [Math.cos(a) * 0.95, 0.4, Math.sin(a) * 0.95],
      [0.52, 0.8, 0.36],
      p.cover,
      0.05,
      -a + Math.PI / 2,
    );
  }
  m.add(new CylinderGeometry(0.8, 0.8, 0.05, 12).translate(0, 0.55, 0), p.water, "solid", 0.02);
  for (const x of [-1.05, 1.05]) m.block([x, 1.3, 0], [0.16, 1.9, 0.16], p.wood);
  m.rod([-1.15, 1.85, 0], [1.3, 1.85, 0], 0.07, p.wood, "solid", 0.07, 7);
  m.rod([1.3, 1.85, 0], [1.3, 1.6, 0.2], 0.03, p.iron, "solid", 0.03, 4);
  m.rod([0, 1.85, 0], [0, 1.25, 0], 0.012, p.pale, "solid", 0.012, 3);
  m.add(new CylinderGeometry(0.16, 0.12, 0.26, 8).translate(0, 1.12, 0), p.wood, "solid", 0.1);
  roof(m, [0, 2.2, 0], 2, 0.75, 2.6, { yaw: Math.PI / 2, rows: 3, thick: 0.08 });
};
