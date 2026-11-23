import { CylinderGeometry } from "three";
import type { XYZ } from "../dungeon/mesh.js";
import { candle, flame } from "../dungeon/props.js";
import { OVERHANG, PLINTH, chimney, timbers, window } from "./buildings.js";
import { type Face, type VillageMesh, face, gable, roof } from "./kit.js";

const THICK = 0.25;

interface IOpening {
  u: number;
  width: number;
  bottom: number;
  top: number;
}

/** A wall slab behind a face (inside is -v) with rectangular holes cut for doors and windows. */
function slab(f: Face, length: number, y0: number, h: number, holes: IOpening[]): void {
  const color = f.m.palette.plaster;
  const piece = (u0: number, u1: number, b: number, t: number) => {
    if (u1 - u0 > 0.01 && t - b > 0.01)
      f.block([(u0 + u1) / 2, y0 + (b + t) / 2, -THICK / 2], [u1 - u0, t - b, THICK], color, 0.01);
  };
  let start = -length / 2;
  for (const hole of [...holes].sort((a, b) => a.u - b.u)) {
    const a = hole.u - hole.width / 2;
    const b = hole.u + hole.width / 2;
    piece(start, a, 0, h);
    piece(a, b, 0, hole.bottom);
    piece(a, b, hole.top, h);
    start = b;
  }
  piece(start, length / 2, 0, h);
}

interface IHall {
  width: number;
  depth: number;
  wall: number;
  rise: number;
  windows: number[];
  backWindows?: number[];
  sideWindows?: number[];
  cutaway: boolean;
}

/**
 * An enterable single-room building: hollow walls, an open front door at u = 0, a plank floor and
 * tie beams. `cutaway` leaves off the gables and roof so the room reads from above.
 * Returns the floor height.
 */
function hall(m: VillageMesh, o: IHall): number {
  const p = m.palette;
  const { width: w, depth: d, wall, rise } = o;
  const floor = PLINTH;
  m.block([0, PLINTH / 2, 0], [w + 0.24, PLINTH, d + 0.24], p.stone, "solid", 0.04);
  const boards = Math.round((d - THICK * 2) / 0.32);
  for (let i = 0; i < boards; i++) {
    const z = -d / 2 + THICK + (i + 0.5) * ((d - THICK * 2) / boards);
    m.block(
      [0, floor + 0.02, z],
      [w - THICK * 2, 0.04, (d - THICK * 2) / boards - 0.02],
      p.wood,
      "solid",
      0.005,
    );
  }
  const windowHole = (u: number): IOpening => ({
    u,
    width: 0.82,
    bottom: wall * 0.55 - 0.46,
    top: wall * 0.55 + 0.46,
  });
  const sides: [Face, number, IOpening[], boolean][] = [
    [
      face(m, [0, 0, d / 2], 0),
      w,
      [{ u: 0, width: 1.3, bottom: 0, top: 2.3 }, ...o.windows.map(windowHole)],
      true,
    ],
    [face(m, [0, 0, -d / 2], Math.PI), w, (o.backWindows ?? o.windows).map(windowHole), false],
    [
      face(m, [w / 2, 0, 0], Math.PI / 2),
      d - THICK * 2,
      (o.sideWindows ?? []).map(windowHole),
      false,
    ],
    [
      face(m, [-w / 2, 0, 0], -Math.PI / 2),
      d - THICK * 2,
      (o.sideWindows ?? []).map(windowHole),
      false,
    ],
  ];
  for (const [f, length, holes, front] of sides) {
    slab(f, length, floor, wall, holes);
    timbers(f, front || length === w ? length : length + THICK * 2, floor, wall, 3);
    for (const hole of holes) {
      if (hole.bottom === 0) continue;
      window(f, hole.u, floor + wall * 0.55);
      f.block(
        [hole.u, floor + hole.bottom - 0.03, -THICK - 0.06],
        [0.95, 0.06, 0.16],
        p.wood,
        0.01,
      );
    }
  }
  const front = sides[0]?.[0];
  if (front) {
    for (const u of [-0.7, 0.7]) front.block([u, floor + 1.17, 0.02], [0.14, 2.34, 0.16], p.wood);
    front.block([0, floor + 2.36, 0.02], [1.6, 0.16, 0.16], p.wood);
    const swing = 1.35;
    const hinge: XYZ = [-0.62, floor + 1.0, -THICK];
    const leaf = front.at([
      hinge[0] + Math.cos(swing) * 0.6,
      hinge[1],
      hinge[2] - Math.sin(swing) * 0.6,
    ]);
    m.block(leaf, [1.2, 2.0, 0.07], p.door, "solid", 0.01, front.yaw + swing);
    front.stone([0, PLINTH / 2, 0.45], [1.5, PLINTH, 0.6], 0.2);
  }
  if (o.cutaway) return floor;
  for (let x = -w / 2 + 1.4; x < w / 2 - 0.8; x += 1.6) {
    m.block([x, floor + wall - 0.12, 0], [0.18, 0.2, d - 0.1], p.wood, "solid", 0.02);
  }
  const top = floor + wall;
  for (const side of [-1, 1])
    gable(m, [side * (w / 2 - 0.1), top, 0], d, rise, p.plaster, Math.PI / 2);
  const drop = (rise * OVERHANG) / (d / 2);
  roof(m, [0, top - drop, 0], d + OVERHANG * 2, rise + drop, w + OVERHANG * 1.5, {
    yaw: Math.PI / 2,
    rows: Math.max(4, Math.round(rise * 2.4)),
  });
  return floor;
}

function table(m: VillageMesh, [x, y, z]: XYZ, w: number, d: number, h = 0.78): void {
  const p = m.palette;
  m.block([x, y + h, z], [w, 0.07, d], p.wood, "solid", 0.015);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      m.block(
        [x + sx * (w / 2 - 0.1), y + h / 2, z + sz * (d / 2 - 0.1)],
        [0.08, h, 0.08],
        p.wood,
        "solid",
        0.01,
      );
    }
}

function stool(m: VillageMesh, [x, y, z]: XYZ, h = 0.5): void {
  const p = m.palette;
  m.add(new CylinderGeometry(0.2, 0.2, 0.06, 8).translate(x, y + h, z), p.wood);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    m.rod(
      [x + Math.cos(a) * 0.2, y, z + Math.sin(a) * 0.2],
      [x + Math.cos(a) * 0.1, y + h, z + Math.sin(a) * 0.1],
      0.025,
      p.wood,
      "solid",
      0.025,
      4,
    );
  }
}

function mug(m: VillageMesh, [x, y, z]: XYZ): void {
  m.add(new CylinderGeometry(0.05, 0.045, 0.12, 6).translate(x, y + 0.06, z), m.palette.wood);
  m.add(new CylinderGeometry(0.042, 0.042, 0.01, 6).translate(x, y + 0.118, z), m.palette.pale);
}

function bottle(m: VillageMesh, [x, y, z]: XYZ, color: number): void {
  m.add(new CylinderGeometry(0.045, 0.05, 0.2, 6).translate(x, y + 0.1, z), color, "solid", 0.06);
  m.rod([x, y + 0.2, z], [x, y + 0.29, z], 0.018, color, "solid", 0.018, 5);
}

function shelves(
  m: VillageMesh,
  x0: number,
  x1: number,
  z: number,
  y: number,
  levels: number,
  fill: (x: number, y: number) => void,
): void {
  const p = m.palette;
  for (const x of [x0, x1])
    m.block(
      [x, y + levels * 0.24 + 0.2, z],
      [0.06, levels * 0.48 + 0.4, 0.34],
      p.wood,
      "solid",
      0.01,
    );
  for (let i = 0; i < levels; i++) {
    const level = y + 0.4 + i * 0.48;
    m.block([(x0 + x1) / 2, level, z], [x1 - x0, 0.05, 0.34], p.wood, "solid", 0.01);
    for (let x = x0 + 0.18; x < x1 - 0.12; x += 0.16 + m.rng.range(0, 0.08)) fill(x, level + 0.025);
  }
}

function hangingLamp(m: VillageMesh, [x, y, z]: XYZ): void {
  const p = m.palette;
  m.rod([x, y + 0.6, z], [x, y + 0.15, z], 0.012, p.iron, "solid", 0.012, 3);
  m.block([x, y, z], [0.24, 0.3, 0.24], p.iron, "solid", 0.02);
  m.block([x, y, z], [0.27, 0.22, 0.2], p.pale, "glow", 0.01);
  m.block([x, y, z], [0.2, 0.22, 0.27], p.pale, "glow", 0.01);
  m.fireLight([x, y - 0.2, z], 7);
}

function hangingSign(
  m: VillageMesh,
  f: Face,
  u: number,
  y: number,
  emblem: (at: XYZ) => void,
): void {
  const p = m.palette;
  f.rod([u, y, 0.05], [u, y, 1.15], 0.05, p.iron, 4);
  for (const v of [0.75, 1.05]) f.rod([u, y, v], [u, y - 0.22, v], 0.015, p.iron, 4);
  f.block([u, y - 0.55, 0.9], [0.08, 0.64, 0.86], p.wood, 0.03);
  for (const side of [-1, 1]) emblem(f.at([u + side * 0.05, y - 0.55, 0.9]));
}

/** A fireplace on the inside of the +X wall of a `width` building, centred on `z`, chimney outside. */
function hearth(m: VillageMesh, width: number, y: number, z: number, chimneyTop: number): void {
  const p = m.palette;
  const fx = width / 2 - THICK;
  m.block([fx - 0.15, y + 0.9, z], [0.3, 1.8, 2.0], p.stone, "solid", 0.04);
  for (const dz of [-0.75, 0.75])
    m.block([fx - 0.5, y + 0.6, z + dz], [0.7, 1.2, 0.4], p.stone, "solid", 0.04);
  m.block([fx - 0.5, y + 1.3, z], [0.8, 0.25, 1.9], p.stone, "solid", 0.03);
  m.block([fx - 0.5, y + 0.05, z], [0.7, 0.1, 1.1], p.joint, "solid", 0.01);
  m.block([fx - 0.48, y + 1.48, z], [1.0, 0.12, 2.2], p.wood, "solid", 0.02);
  flame(m, [fx - 0.5, y + 0.1, z], 0.75);
  m.fireLight([fx - 1.0, y + 0.6, z], 18);
  chimney(m, width / 2 + 0.42, z, chimneyTop);
}

function chair(m: VillageMesh, [x, y, z]: XYZ, facing: number): void {
  const p = m.palette;
  m.block([x, y + 0.46, z], [0.46, 0.06, 0.44], p.wood, "solid", 0.01);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      m.block([x + sx * 0.18, y + 0.23, z + sz * 0.17], [0.05, 0.46, 0.05], p.wood, "solid", 0.005);
  const bx = x - Math.sin(facing) * 0.2;
  const bz = z - Math.cos(facing) * 0.2;
  m.block([bx, y + 0.78, bz], [0.46, 0.6, 0.05], p.wood, "solid", 0.01, facing);
}

/** An enterable home: bed, chest and wardrobe, a dining table with chairs, a kitchen hearth with a cauldron. */
export function home(m: VillageMesh, cutaway = false): void {
  const p = m.palette;
  const W = 6.4;
  const D = 5.2;
  const y = hall(m, {
    width: W,
    depth: D,
    wall: 2.6,
    rise: 2.1,
    windows: [-1.9, 1.9],
    backWindows: [-0.7],
    cutaway,
  });
  const back = -D / 2 + THICK;
  const left = -W / 2 + THICK;
  // bed in the back left corner, a chest at its foot
  m.block([left + 0.55, y + 0.22, back + 1.05], [1.05, 0.3, 2.0], p.wood, "solid", 0.03);
  m.block([left + 0.55, y + 0.42, back + 1.1], [0.95, 0.14, 1.85], p.pale, "solid", 0.04);
  m.block([left + 0.55, y + 0.5, back + 1.45], [1.0, 0.1, 1.2], p.cloth, "solid", 0.04);
  m.gem([left + 0.55, y + 0.56, back + 0.38], [0.36, 0.08, 0.18], p.pale, "solid", 1);
  m.block([left + 0.55, y + 0.55, back + 0.05], [1.1, 1.0, 0.08], p.wood, "solid", 0.02);
  m.block([left + 0.55, y + 0.26, back + 2.35], [0.85, 0.5, 0.48], p.wood, "solid", 0.03);
  m.block([left + 0.55, y + 0.52, back + 2.35], [0.88, 0.06, 0.5], p.ridge, "solid", 0.01);
  // wardrobe against the left wall near the door
  m.block([left + 0.32, y + 0.95, D / 2 - THICK - 0.75], [0.6, 1.9, 1.1], p.wood, "solid", 0.03);
  for (const dz of [-0.27, 0.27])
    m.block(
      [left + 0.63, y + 1.0, D / 2 - THICK - 0.75 + dz],
      [0.03, 1.6, 0.48],
      p.door,
      "solid",
      0.005,
    );
  // dining table, chairs, plates and a candle
  table(m, [0.4, y, 0.1], 1.3, 0.85);
  chair(m, [0.4 - 0.95, y, 0.1], Math.PI / 2);
  chair(m, [0.4 + 0.95, y, 0.1], -Math.PI / 2);
  for (const dx of [-0.35, 0.35])
    m.add(new CylinderGeometry(0.15, 0.12, 0.03, 8).translate(0.4 + dx, y + 0.83, 0.1), p.pale);
  m.add(new CylinderGeometry(0.13, 0.09, 0.1, 8).translate(0.4, y + 0.87, -0.2), p.wood);
  candle(m, 0.4, y + 0.82, 0.25, 0.16);
  m.fireLight([0.4, y + 1.3, 0.25], 3);
  m.block([0.4, y + 0.05, 0.1], [2.6, 0.02, 1.8], p.cloth, "solid", 0.005);
  // kitchen hearth with a cauldron on the right wall, crockery shelf at the back
  hearth(m, W, y, -0.9, y + 2.6 + 2.2);
  m.add(
    new CylinderGeometry(0.26, 0.2, 0.32, 10).translate(W / 2 - THICK - 0.5, y + 0.28, -0.9),
    p.iron,
  );
  m.add(
    new CylinderGeometry(0.22, 0.22, 0.02, 10).translate(W / 2 - THICK - 0.5, y + 0.44, -0.9),
    p.water,
  );
  m.rod(
    [W / 2 - THICK - 0.5, y + 0.44, -0.9],
    [W / 2 - THICK - 0.5, y + 1.2, -0.9],
    0.012,
    p.iron,
    "solid",
    0.012,
    3,
  );
  shelves(m, 0.4, 1.9, back + 0.2, y + 0.9, 2, (x, level) => {
    if (m.rng.next() < 0.5)
      m.add(
        new CylinderGeometry(0.11, 0.11, 0.03, 8)
          .rotateX(Math.PI / 2)
          .translate(x, level + 0.11, back + 0.12),
        p.pale,
      );
    else bottle(m, [x, level, back + 0.2], m.rng.next() < 0.5 ? p.glass : p.leaf);
  });
  // a water barrel by the door, a broom against the wall
  m.rod(
    [W / 2 - THICK - 0.4, y, D / 2 - THICK - 0.5],
    [W / 2 - THICK - 0.4, y + 0.75, D / 2 - THICK - 0.5],
    0.3,
    p.wood,
    "solid",
    0.28,
    10,
  );
  m.add(
    new CylinderGeometry(0.26, 0.26, 0.02, 10).translate(
      W / 2 - THICK - 0.4,
      y + 0.74,
      D / 2 - THICK - 0.5,
    ),
    p.water,
  );
  m.rod(
    [-1.1, y + 0.05, D / 2 - THICK - 0.15],
    [-1.25, y + 1.4, D / 2 - THICK - 0.08],
    0.025,
    p.wood,
    "solid",
    0.025,
    4,
  );
  m.add(
    new CylinderGeometry(0.04, 0.14, 0.35, 6).translate(-1.08, y + 0.17, D / 2 - THICK - 0.16),
    p.hay,
  );
}

/** An enterable inn: bar, kegs and shelves of bottles, tables, a fireplace and lamps. */
export function inn(m: VillageMesh, cutaway = false): void {
  const p = m.palette;
  const W = 9;
  const D = 7;
  const y = hall(m, {
    width: W,
    depth: D,
    wall: 3,
    rise: 2.8,
    windows: [-2.9, 2.9],
    backWindows: [2.9],
    sideWindows: [-1.6],
    cutaway,
  });
  const back = -D / 2 + THICK;
  // the bar, along the back left
  m.block([-2.3, y + 0.52, back + 1.6], [3.6, 1.04, 0.55], p.wood, "solid", 0.02);
  m.block([-2.3, y + 1.07, back + 1.6], [3.8, 0.07, 0.7], p.ridge, "solid", 0.015);
  for (let i = 0; i < 6; i++)
    m.block([-3.85 + i * 0.62, y + 0.52, back + 1.89], [0.5, 0.8, 0.03], p.door, "solid", 0.005);
  shelves(m, -4.2, -0.4, back + 0.2, y + 0.8, 3, (x, level) =>
    bottle(
      m,
      [x, level, back + 0.2],
      [p.glass, p.leaf, p.flower, p.pale][Math.floor(x * 7) & 3] ?? p.glass,
    ),
  );
  for (let i = 0; i < 3; i++) {
    const x = -3.6 + i * 0.95;
    m.rod([x, y + 0.42, back + 0.75], [x, y + 0.42, back + 1.25], 0.36, p.wood, "solid", 0.36, 10);
    m.rod([x, y + 0.42, back + 1.25], [x, y + 0.42, back + 1.33], 0.02, p.iron, "solid", 0.02, 4);
  }
  for (let i = 0; i < 4; i++) stool(m, [-3.7 + i * 0.95, y, back + 2.35], 0.72);
  for (let i = 0; i < 4; i++)
    mug(m, [-3.4 + i * 0.85 + m.rng.range(-0.1, 0.1), y + 1.11, back + 1.6]);
  // tables with stools and mugs
  for (const [x, z] of [
    [1.6, -1.2],
    [2.2, 1.7],
    [-1.4, 1.9],
  ] as const) {
    table(m, [x, y, z], 1.2, 0.9);
    for (const [dx, dz] of [
      [-0.8, 0],
      [0.8, 0],
      [0, 0.7],
    ] as const)
      stool(m, [x + dx, y, z + dz]);
    mug(m, [x - 0.25, y + 0.82, z + 0.1]);
    mug(m, [x + 0.3, y + 0.82, z - 0.15]);
    m.add(new CylinderGeometry(0.16, 0.13, 0.03, 8).translate(x, y + 0.83, z), p.pale);
  }
  m.block([0.6, y + 0.05, 0.2], [3.2, 0.02, 2.2], p.cloth, "solid", 0.005);
  const fx = W / 2 - THICK;
  hearth(m, W, y, 0.3, y + 3 + 2.6);
  for (const dz of [-0.6, 0.5, 0.9]) bottle(m, [fx - 0.45, y + 1.54, 0.3 + dz], p.pale);
  hangingLamp(m, [-1.5, y + 2.3, 0]);
  hangingLamp(m, [2, y + 2.3, 0.3]);
  hangingSign(m, face(m, [0, 0, D / 2], 0), 2.2, y + 2.85, (at) =>
    m.gem(at, [0.03, 0.17, 0.17], p.pale, "solid", 1),
  );
}

/** An enterable shop: counter with scales, wall shelves of goods, a display table, stock in the corner. */
export function shop(m: VillageMesh, cutaway = false): void {
  const p = m.palette;
  const W = 7;
  const D = 6;
  const y = hall(m, {
    width: W,
    depth: D,
    wall: 2.8,
    rise: 2.4,
    windows: [-2.1, 2.1],
    backWindows: [],
    sideWindows: [0],
    cutaway,
  });
  const back = -D / 2 + THICK;
  m.block([-0.4, y + 0.5, back + 1.3], [3.6, 1.0, 0.6], p.wood, "solid", 0.02);
  m.block([-0.4, y + 1.03, back + 1.3], [3.8, 0.06, 0.72], p.ridge, "solid", 0.01);
  // scales, ledger and coins on the counter
  m.rod([0.6, y + 1.06, back + 1.3], [0.6, y + 1.5, back + 1.3], 0.025, p.iron, "solid", 0.025, 5);
  m.rod([0.3, y + 1.5, back + 1.3], [0.9, y + 1.5, back + 1.3], 0.015, p.iron, "solid", 0.015, 4);
  for (const x of [0.3, 0.9])
    m.add(new CylinderGeometry(0.11, 0.07, 0.03, 8).translate(x, y + 1.3, back + 1.3), p.pale);
  m.block([-1.3, y + 1.09, back + 1.3], [0.42, 0.06, 0.3], p.cloth, "solid", 0.01);
  for (let i = 0; i < 6; i++)
    m.gem(
      [-0.5 + m.rng.range(-0.1, 0.1), y + 1.08 + i * 0.015, back + 1.25 + m.rng.range(-0.08, 0.08)],
      [0.05, 0.012, 0.05],
      0xf2c84b,
      "solid",
      0,
    );
  // wall shelves: jars, bottles, bolts of cloth
  const goods = [p.flower, p.glass, p.leaf, p.cloth, p.hay, p.door];
  shelves(m, -3.1, 3.1, back + 0.2, y + 0.4, 4, (x, level) => {
    const color = goods[Math.floor(m.rng.next() * goods.length)] ?? p.pale;
    if (m.rng.next() < 0.5) bottle(m, [x, level, back + 0.2], color);
    else
      m.add(
        new CylinderGeometry(0.07, 0.07, 0.16, 7).translate(x, level + 0.08, back + 0.2),
        color,
        "solid",
        0.06,
      );
  });
  for (let i = 0; i < 4; i++) {
    const z = -0.8 + i * 0.32;
    m.rod(
      [-W / 2 + THICK + 0.2, y + 0.18, z],
      [-W / 2 + THICK + 1.0, y + 0.18, z],
      0.14,
      goods[i] ?? p.cloth,
      "solid",
      0.14,
      8,
    );
  }
  // display table with baskets of produce
  table(m, [1.3, y, 0.9], 1.6, 0.9);
  for (const [dx, color] of [
    [-0.45, p.flower],
    [0, p.hay],
    [0.45, p.leaf],
  ] as const) {
    m.add(new CylinderGeometry(0.2, 0.15, 0.14, 8).translate(1.3 + dx, y + 0.89, 0.9), p.wood);
    for (let k = 0; k < 4; k++)
      m.gem(
        [1.3 + dx + m.rng.range(-0.08, 0.08), y + 0.99, 0.9 + m.rng.range(-0.08, 0.08)],
        [0.07, 0.06, 0.07],
        color,
        "solid",
        1,
      );
  }
  // stock: barrels, a sack pile and crates by the left wall
  const sx = -W / 2 + THICK + 0.45;
  m.rod([sx, y, back + 2.3], [sx, y + 0.8, back + 2.3], 0.32, p.wood, "solid", 0.3, 10);
  m.rod([sx + 0.7, y, back + 2.5], [sx + 0.7, y + 0.8, back + 2.5], 0.3, p.wood, "solid", 0.28, 10);
  for (let i = 0; i < 3; i++)
    m.gem(
      [sx + 0.2 + i * 0.3, y + 0.25, 1.5 + m.rng.range(-0.1, 0.1)],
      [0.25, 0.27, 0.22],
      0xa68a62,
      "solid",
      1,
    );
  m.block([sx + 0.2, y + 0.3, 2.1], [0.6, 0.6, 0.6], p.wood, "solid", 0.03);
  m.block([sx + 0.25, y + 0.85, 2.1], [0.45, 0.5, 0.45], p.wood, "solid", 0.03);
  hangingLamp(m, [0, y + 2.1, 0.2]);
  hangingSign(m, face(m, [0, 0, D / 2], 0), 1.6, y + 2.65, (at) =>
    m.gem(at, [0.03, 0.16, 0.16], 0xf2c84b, "solid", 1),
  );
}
