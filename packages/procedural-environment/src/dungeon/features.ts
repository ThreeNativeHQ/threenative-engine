import { ExtrudeGeometry, Shape } from "three";
import { grate } from "./masonry.js";
import type { DungeonPart, XYZ } from "./mesh.js";
import { candle } from "./props.js";

export const portcullis: DungeonPart = (m) => {
  const radius = 1.21;
  const spring = 1.9;
  for (let i = -5; i <= 5; i++) {
    const x = i * 0.216;
    const y = spring + Math.sqrt(radius * radius - x * x);
    m.rod([x, 0.16, 0], [x, y, 0], 0.053, m.palette.iron, "metal", 0.044, 4);
    m.rod([x, 0.16, 0], [x, 0.005, 0], 0.054, m.palette.iron, "metal", 0.002, 4);
  }
  for (const y of [0.28, 0.82, 1.38, 1.93, 2.45]) {
    const w = y <= spring ? 2.43 : Math.sqrt(radius * radius - (y - spring) ** 2) * 2;
    m.block([0, y, 0], [w, 0.103, 0.121], m.palette.iron, "metal", 0.012);
    for (let x = -1.08; x <= 1.09; x += 0.216) {
      if (Math.abs(x) < w / 2) m.gem([x, y, 0.078], [0.024, 0.025, 0.019], 0x93919a, "metal");
    }
  }
  for (const x of [-1.21, 1.21])
    m.block([x, 1.06, 0], [0.086, 2.12, 0.096], m.palette.iron, "metal");
};

export const lever: DungeonPart = (m) => {
  m.stone([0, 0.15, 0], [0.98, 0.3, 0.85], 0.61);
  m.stone([0, 0.39, 0], [0.78, 0.22, 0.65], 0.36);
  for (const x of [-0.18, 0.18]) m.block([x, 0.56, 0], [0.17, 0.29, 0.54], m.palette.iron, "metal");
  m.rod([-0.3, 0.6, 0], [0.3, 0.6, 0], 0.08, m.palette.iron, "metal", 0.08, 10);
  for (const z of [-0.09, 0.09]) {
    m.rod([0, 0.57, z], [0, 1.3, z - 0.3], 0.039, m.palette.iron, "metal", 0.028);
  }
  m.rod([-0.21, 1.3, -0.3], [0.21, 1.3, -0.3], 0.075, m.palette.wood, "solid", 0.075, 9);
};

export const spikeTrap: DungeonPart = (m) => {
  grate(m, 2.1, 0.102);
  m.block([0, 0.075, 0], [2.04, 0.1, 2.04], m.palette.joint, "solid", 0.011);
  for (const x of [-0.69, -0.35, 0, 0.35, 0.69])
    for (const z of [-0.69, -0.35, 0, 0.35, 0.69]) {
      m.rod(
        [x, 0.16, z],
        [x + m.rng.range(-0.033, 0.033), m.rng.range(0.48, 0.82), z],
        0.085,
        0x78727d,
        "metal",
        0.001,
        5,
      );
    }
};

export const pressurePlate: DungeonPart = (m) => {
  m.stone([0, 0.075, 0], [1.83, 0.15, 1.83], 0.55);
  m.block([0, 0.166, 0], [1.52, 0.082, 1.52], m.palette.iron, "metal");
  m.stone([0, 0.225, 0], [1.32, 0.12, 1.32], 0.18, 0.045);
  for (const x of [-0.69, 0.69])
    for (const z of [-0.69, 0.69]) m.gem([x, 0.218, z], [0.041, 0.023, 0.041], 0x9c865c, "metal");
};

export const woodenBridge: DungeonPart = (m) => {
  for (const x of [-0.94, 0.94]) m.block([x, -0.22, 0], [0.18, 0.27, 4], m.palette.wood);
  for (let i = 0; i < 12; i++)
    m.block(
      [0, -0.068, (i - 5.5) / 3],
      [m.rng.range(2.19, 2.31), 0.14, 0.311],
      m.palette.wood,
      "solid",
      0.018,
    );
  for (const x of [-1.06, 1.06]) {
    const points = [-1.86, 0, 1.86];
    for (const z of points) {
      m.rod([x, -0.19, z], [x, 0.83, z], 0.094, m.palette.wood, "solid", 0.083, 6);
      m.rod([x, 0.58, z], [x, 0.646, z], 0.103, 0x9b7951, "solid", 0.104, 10);
    }
    for (let i = 0; i < 16; i++) {
      const point = (t: number): XYZ => [
        x,
        0.68 - Math.sin(((t / 8) * Math.PI) % Math.PI) * 0.23,
        -1.86 + (t * 3.72) / 16,
      ];
      m.rod(point(i), point(i + 1), 0.033, 0x9b7951, "solid", 0.033, 6);
    }
  }
};

export const stoneBridge: DungeonPart = (m) => {
  for (let i = 0; i < 8; i++) {
    const z = i * 0.5 - 1.75;
    const arch = 0.31 + (Math.abs(z) / 1.95) ** 2 * 0.7;
    for (const x of [-0.81, 0, 0.81]) m.stone([x, -arch / 2, z], [0.82, arch, 0.49], 0.57, 0.046);
    for (const x of [-1.26, 1.26]) m.stone([x, 0.28, z], [0.26, 0.56, 0.51], 0.52);
  }
  for (const x of [-1.28, 1.28])
    for (const z of [-1.81, 1.81]) {
      m.stone([x, 0.41, z], [0.4, 0.82, 0.38], 0.7);
      m.stone([x, 0.9, z], [0.54, 0.18, 0.53], 0.61);
    }
};

export { statue } from "./statue.js";

export const altar: DungeonPart = (m) => {
  m.stone([0, 0.14, 0], [2.49, 0.28, 1.24], 0.62);
  m.stone([0, 0.69, 0], [2.14, 0.86, 0.89], 0.35);
  for (const x of [-0.825, 0.825]) m.stone([x, 0.66, 0.43], [0.45, 0.83, 0.25], 0.6);
  m.stone([0, 1.19, 0], [2.56, 0.28, 1.23], 0.32);
  m.block([0, 1.34, 0.022], [0.75, 0.029, 1.27], m.palette.cloth, "solid", 0.012);
  m.block([0, 0.97, 0.659], [0.75, 0.74, 0.027], m.palette.cloth, "solid", 0.012);
  m.block([0, 0.64, 0.675], [0.72, 0.045, 0.018], m.palette.pale, "solid", 0.006);
  for (const [x, z, height] of [
    [-0.93, 0.02, 0.32],
    [-0.69, -0.25, 0.24],
    [-0.57, 0.18, 0.18],
    [0.91, 0.17, 0.4],
    [0.72, -0.13, 0.21],
    [0.48, 0.25, 0.23],
  ] as const)
    candle(m, x, 1.33, z, height);
  m.fireLight([0, 1.71, 0.24], 11);
};

export const sarcophagus: DungeonPart = (m) => {
  m.stone([0, 0.11, 0], [2.67, 0.22, 1.37], 0.8);
  m.stone([0, 0.48, 0], [2.49, 0.62, 1.22], 0.33);
  m.stone([0, 0.84, 0], [2.65, 0.26, 1.37], 0.31);
  const lid = new Shape();
  lid.moveTo(-1.03, -0.48);
  lid.lineTo(0.83, -0.48);
  lid.lineTo(1.15, -0.29);
  lid.lineTo(1.15, 0.29);
  lid.lineTo(0.83, 0.48);
  lid.lineTo(-1.03, 0.48);
  lid.closePath();
  m.add(
    new ExtrudeGeometry(lid, {
      depth: 0.13,
      bevelSize: 0.051,
      bevelThickness: 0.04,
      bevelSegments: 1,
    })
      .rotateX(-Math.PI / 2)
      .translate(0, 0.98, 0),
    m.palette.stone,
  );
  m.gem([0.62, 1.19, 0], [0.185, 0.105, 0.19], m.palette.stone, "solid", 1);
  m.gem([-0.14, 1.14, 0], [0.65, 0.083, 0.32], m.palette.stone, "solid", 1);
  for (const side of [-1, 1])
    for (const x of [-0.92, -0.47, 0, 0.47, 0.92]) {
      m.stone([x, 0.47, side * 0.62], [0.13, 0.38, 0.09], 0.33);
    }
};
