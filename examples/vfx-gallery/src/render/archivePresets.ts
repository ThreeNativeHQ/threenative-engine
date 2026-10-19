/**
 * Appearance and motion data ported from the checked-in donor ZIP. This is game-owned render
 * source: it carries the donor's emitter values, curves, and layer composition, while the engine
 * supplies only the existing GPUParticles3D/IComputeDriven lifecycle.
 */
export type ArchiveVec3 = readonly [number, number, number];
export type ArchiveVec4 = readonly [number, number, number, number];

type ScalarPoint = readonly [number, number];
type ColorPoint = readonly [number, readonly [number, number, number] | ArchiveVec4];
type Shape =
  | { type: "point" }
  | { type: "disc"; radius: number }
  | { type: "sphere"; radius: number }
  | { type: "sphereSurface"; radius: number }
  | { type: "box"; extents: ArchiveVec3 }
  | { type: "line"; start: ArchiveVec3; end: ArchiveVec3 };

type Velocity = {
  mode?: "directional" | "radial" | "cone";
  direction?: ArchiveVec3;
  origin?: ArchiveVec3;
  speed: readonly [number, number];
  angle?: number;
};

export type ArchiveLayer = {
  id: string;
  name?: string;
  capacity: number;
  spawnRate?: number;
  burstCount?: number;
  lifetime: readonly [number, number];
  position?: ArchiveVec3;
  shape: Shape;
  velocity: Velocity;
  color: ArchiveVec4;
  size: number;
  style: number;
  texture?: string;
  blend: "additive" | "alpha" | "premultiplied" | "masked";
  renderer?: "sprite" | "ribbon" | "mesh";
  ribbonWidth?: number;
  acceleration?: readonly ArchiveVec3[];
  drag?: number;
  curl?: { strength: number; frequency: number };
  attractor?: { position: ArchiveVec3; strength: number };
  vortex?: { center: ArchiveVec3; axis: ArchiveVec3; strength: number };
  colorCurve?: readonly ColorPoint[];
  alphaCurve?: readonly ScalarPoint[];
  sizeCurve?: readonly ScalarPoint[];
  rotation?: readonly [number, number];
  angularVelocity?: readonly [number, number];
  floor?: { height: number; bounce: number; friction: number };
};

type PresetFactory = (position: ArchiveVec3) => ArchiveLayer[];

const SMOKE_SPRITE_TEXTURE = "smoke";
const GLOW_SPRITE_TEXTURE = "glow";

const pos = (base: ArchiveVec3, delta: ArchiveVec3 = [0, 0, 0]): ArchiveVec3 => [
  base[0] + delta[0],
  base[1] + delta[1],
  base[2] + delta[2],
];
const scaledSize = (
  base: number,
  start: number,
  end: number,
  points: readonly ScalarPoint[],
): readonly ScalarPoint[] =>
  points.map(([t, value]) => [t, base * (start + (end - start) * t) * value] as const);
const constantSize = (base: number, start: number, end: number): readonly ScalarPoint[] => [
  [0, base * start],
  [1, base * end],
];

const FIRE_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.08, 0.55],
  [0.18, 1],
  [0.7, 0.92],
  [1, 0],
];
const FIRE_COLOR: readonly ColorPoint[] = [
  [0, [1, 0.957, 0.749]],
  [0.12, [1, 0.945, 0.541]],
  [0.45, [1, 0.612, 0.184]],
  [0.82, [1, 0.294, 0.071]],
  [1, [0.322, 0.078, 0]],
];
const FIRE_SIZE: readonly ScalarPoint[] = [
  [0, 1],
  [1, 1],
];
const SMOKE_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.1, 0.72],
  [0.26, 1],
  [0.72, 0.62],
  [1, 0],
];
const SMOKE_COLOR: readonly ColorPoint[] = [
  [0, [0.28, 0.29, 0.31]],
  [0.45, [0.48, 0.49, 0.5]],
  [1, [0.7, 0.71, 0.73]],
];
const SMOKE_SIZE: readonly ScalarPoint[] = [
  [0, 0.55],
  [0.2, 0.78],
  [0.58, 1.25],
  [1, 2.05],
];
const DUST_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.08, 0.44],
  [0.22, 0.82],
  [0.7, 0.48],
  [1, 0],
];
const DUST_COLOR: readonly ColorPoint[] = [
  [0, [0.72, 0.68, 0.56]],
  [0.4, [0.62, 0.58, 0.49]],
  [1, [0.45, 0.42, 0.36]],
];
const DUST_SIZE: readonly ScalarPoint[] = [
  [0, 0.48],
  [0.22, 0.82],
  [0.65, 1.32],
  [1, 1.86],
];
const STEAM_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.14, 0.32],
  [0.4, 0.58],
  [0.82, 0.22],
  [1, 0],
];
const STEAM_COLOR: readonly ColorPoint[] = [
  [0, [0.84, 0.86, 0.88]],
  [0.45, [0.72, 0.75, 0.78]],
  [1, [0.58, 0.61, 0.64]],
];
const STEAM_SIZE: readonly ScalarPoint[] = [
  [0, 0.62],
  [0.28, 0.94],
  [0.7, 1.46],
  [1, 1.94],
];
const ASH_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.08, 0.52],
  [0.24, 0.86],
  [0.76, 0.34],
  [1, 0],
];
const ASH_COLOR: readonly ColorPoint[] = [
  [0, [0.24, 0.24, 0.25]],
  [0.42, [0.36, 0.36, 0.37]],
  [1, [0.5, 0.5, 0.51]],
];
const ASH_SIZE: readonly ScalarPoint[] = [
  [0, 0.44],
  [0.22, 0.74],
  [0.7, 1.18],
  [1, 1.7],
];
const EXP_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.04, 0.7],
  [0.18, 1],
  [0.56, 0.68],
  [1, 0],
];
const EXP_COLOR: readonly ColorPoint[] = [
  [0, [0.54, 0.46, 0.34]],
  [0.24, [0.34, 0.31, 0.28]],
  [0.68, [0.2, 0.2, 0.21]],
  [1, [0.1, 0.11, 0.12]],
];
const EXP_SIZE: readonly ScalarPoint[] = [
  [0, 0.52],
  [0.16, 0.92],
  [0.56, 1.52],
  [1, 2.18],
];
const SPARK_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.03, 1],
  [0.36, 0.92],
  [0.76, 0.4],
  [1, 0],
];
const SPARK_COLOR: readonly ColorPoint[] = [
  [0, [1, 0.96, 0.78]],
  [0.24, [1, 0.72, 0.26]],
  [0.72, [1, 0.28, 0.04]],
  [1, [0.28, 0.08, 0.02]],
];
const SPARK_SIZE: readonly ScalarPoint[] = [
  [0, 0.55],
  [0.14, 1],
  [0.72, 0.42],
  [1, 0.12],
];
const MAGIC_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.06, 0.62],
  [0.2, 1],
  [0.72, 0.74],
  [1, 0],
];
const MAGIC_COLOR: readonly ColorPoint[] = [
  [0, [0.58, 1, 0.95]],
  [0.32, [0.22, 0.96, 0.82]],
  [0.7, [0.12, 0.72, 0.74]],
  [1, [0.04, 0.24, 0.3]],
];
const MAGIC_SIZE: readonly ScalarPoint[] = [
  [0, 0.34],
  [0.18, 0.76],
  [0.68, 1.08],
  [1, 0.56],
];
const EMBER_ALPHA: readonly ScalarPoint[] = [
  [0, 0],
  [0.04, 1],
  [0.3, 0.94],
  [0.82, 0.32],
  [1, 0],
];
const EMBER_COLOR: readonly ColorPoint[] = [
  [0, [1, 0.96, 0.72]],
  [0.18, [1, 0.66, 0.2]],
  [0.62, [0.88, 0.24, 0.04]],
  [1, [0.22, 0.06, 0.01]],
];
const EMBER_SIZE: readonly ScalarPoint[] = [
  [0, 0.64],
  [0.14, 1],
  [0.7, 0.34],
  [1, 0.08],
];
const DARK_SMOKE_COLOR: readonly ColorPoint[] = [
  [0, [0.2, 0.18, 0.17]],
  [1, [0.42, 0.4, 0.38]],
];

function webgpuFactories(): Record<string, PresetFactory> {
  return {
    fire: (b) => [
      {
        id: "fire",
        capacity: 1000,
        spawnRate: 380,
        lifetime: [1.247, 2.15],
        shape: { type: "disc", radius: 0.06 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.773, 1.38], angle: 0.13 },
        color: [1, 1, 1, 1],
        size: 0.32,
        style: 0,
        blend: "additive",
        acceleration: [
          [0, 0.42, 0],
          [0.12, 0, 0.04],
        ],
        drag: 0.24,
        curl: { strength: 0.36, frequency: 1.55 },
        colorCurve: FIRE_COLOR,
        alphaCurve: FIRE_ALPHA,
        sizeCurve: scaledSize(0.32, 0.76, 2.15, FIRE_SIZE),
        position: b,
      },
    ],
    "jet-flame": (b) => [
      {
        id: "jet-flame",
        capacity: 520,
        spawnRate: 420,
        lifetime: [0.269, 0.48],
        shape: { type: "disc", radius: 0.05 },
        velocity: { mode: "cone", direction: [0, 0, 1], speed: [1.904, 2.8], angle: Math.PI / 9 },
        color: [1, 1, 1, 1],
        size: 0.2,
        style: 0,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.052,
        acceleration: [[0, 0.02, 0.08]],
        drag: 0.16,
        curl: { strength: 0.08, frequency: 0.7 },
        colorCurve: FIRE_COLOR,
        alphaCurve: FIRE_ALPHA,
        sizeCurve: constantSize(0.2, 0.72, 1.36),
        position: b,
      },
    ],
    "burst-flash": (b) => [
      {
        id: "burst-flash",
        capacity: 220,
        burstCount: 95,
        lifetime: [0.286, 0.42],
        shape: { type: "disc", radius: 0.08 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.04, 0.24], angle: 0.65 },
        color: [1, 0.94, 0.76, 1],
        size: 0.16,
        style: 4,
        blend: "additive",
        drag: 0.44,
        acceleration: [[0.02, 0, 0.01]],
        colorCurve: [
          [0, [1, 0.98, 0.88]],
          [0.28, [1, 0.78, 0.34]],
          [0.72, [1, 0.34, 0.08]],
          [1, [0.3, 0.08, 0.02]],
        ],
        alphaCurve: [
          [0, 0],
          [0.04, 1],
          [0.22, 0.9],
          [0.56, 0.24],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.16, 0.72, 1.08, [
          [0, 0.58],
          [0.16, 1],
          [0.62, 0.86],
          [1, 0.3],
        ]),
        position: b,
      },
    ],
    "muzzle-flash": (b) => [
      {
        id: "muzzle-flash",
        capacity: 180,
        burstCount: 84,
        lifetime: [0.112, 0.16],
        shape: { type: "disc", radius: 0.05 },
        velocity: {
          mode: "cone",
          direction: [0, 0.12, 1],
          speed: [0.08, 0.34],
          angle: Math.PI / 8,
        },
        color: [1, 0.95, 0.79, 1],
        size: 0.22,
        style: 4,
        blend: "additive",
        drag: 0.62,
        acceleration: [[0.01, 0, 0.02]],
        colorCurve: [
          [0, [1, 0.99, 0.92]],
          [0.18, [1, 0.86, 0.42]],
          [0.56, [1, 0.44, 0.08]],
          [1, [0.22, 0.06, 0.01]],
        ],
        alphaCurve: [
          [0, 0],
          [0.03, 1],
          [0.16, 0.96],
          [0.46, 0.38],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.22, 0.84, 1.36, [
          [0, 0.7],
          [0.12, 1],
          [0.52, 0.84],
          [1, 0.18],
        ]),
        position: b,
      },
    ],
    smoke: (b) => [
      {
        id: "smoke",
        capacity: 650,
        spawnRate: 115,
        lifetime: [2.394, 3.8],
        shape: { type: "sphere", radius: 0.28 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.24, 0.62], angle: 0.4 },
        color: [1, 1, 1, 1],
        size: 0.52,
        style: 1,
        blend: "alpha",
        acceleration: [[0.08, 0.02, 0.03]],
        drag: 0.12,
        curl: { strength: 0.04, frequency: 0.8 },
        colorCurve: SMOKE_COLOR,
        alphaCurve: SMOKE_ALPHA,
        sizeCurve: scaledSize(0.52, 0.82, 1.75, SMOKE_SIZE),
        position: b,
      },
    ],
    "dust-cloud": (b) => [
      {
        id: "dust-cloud",
        capacity: 520,
        spawnRate: 92,
        lifetime: [1.953, 3.1],
        shape: { type: "sphere", radius: 0.2 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.1, 0.34], angle: 0.65 },
        color: [0.84, 0.77, 0.61, 1],
        size: 0.48,
        style: 1,
        blend: "alpha",
        acceleration: [[0.05, 0.01, 0.02]],
        drag: 0.18,
        curl: { strength: 0.018, frequency: 0.56 },
        colorCurve: DUST_COLOR,
        alphaCurve: DUST_ALPHA,
        sizeCurve: scaledSize(0.48, 0.74, 1.78, DUST_SIZE),
        position: b,
      },
    ],
    "steam-plume": (b) => [
      {
        id: "steam-plume",
        capacity: 520,
        spawnRate: 126,
        lifetime: [2.646, 4.2],
        shape: { type: "disc", radius: 0.08 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.18, 0.48], angle: 0.22 },
        color: [0.85, 0.86, 0.88, 1],
        size: 0.46,
        style: 1,
        blend: "alpha",
        acceleration: [[0.03, 0.01, 0.01]],
        drag: 0.1,
        curl: { strength: 0.024, frequency: 0.66 },
        colorCurve: STEAM_COLOR,
        alphaCurve: STEAM_ALPHA,
        sizeCurve: scaledSize(0.46, 0.82, 1.92, STEAM_SIZE),
        position: b,
      },
    ],
    "ash-plume": (b) => [
      {
        id: "ash-plume",
        capacity: 540,
        spawnRate: 98,
        lifetime: [1.89, 3.5],
        shape: { type: "sphere", radius: 0.16 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.24, 0.72], angle: 0.38 },
        color: [0.36, 0.36, 0.37, 1],
        size: 0.38,
        style: 1,
        blend: "alpha",
        acceleration: [[0.06, 0.01, 0.02]],
        drag: 0.15,
        curl: { strength: 0.028, frequency: 0.92 },
        colorCurve: ASH_COLOR,
        alphaCurve: ASH_ALPHA,
        sizeCurve: scaledSize(0.38, 0.68, 1.62, ASH_SIZE),
        position: b,
      },
    ],
    "explosion-cloud": (b) => [
      {
        id: "explosion-cloud",
        capacity: 420,
        burstCount: 75,
        lifetime: [1.323, 2.1],
        shape: { type: "sphere", radius: 0.18 },
        velocity: { mode: "radial", origin: b, speed: [0.3, 0.96] },
        color: [0.54, 0.46, 0.34, 1],
        size: 0.62,
        style: 1,
        blend: "alpha",
        acceleration: [
          [0, 0.32, 0],
          [0.05, 0.01, 0.02],
        ],
        drag: 0.13,
        curl: { strength: 0.06, frequency: 1.1 },
        colorCurve: EXP_COLOR,
        alphaCurve: EXP_ALPHA,
        sizeCurve: scaledSize(0.62, 0.72, 2.36, EXP_SIZE),
        position: b,
      },
    ],
    "impact-dust": (b) => [
      {
        id: "impact-dust",
        capacity: 260,
        burstCount: 60,
        lifetime: [0.882, 1.4],
        shape: { type: "disc", radius: 0.18 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.28, 0.86], angle: 1.05 },
        color: [0.78, 0.69, 0.54, 1],
        size: 0.42,
        style: 1,
        blend: "alpha",
        acceleration: [
          [0, 0.24, 0],
          [0.04, 0.01, 0.02],
        ],
        drag: 0.2,
        curl: { strength: 0.024, frequency: 0.72 },
        colorCurve: DUST_COLOR,
        alphaCurve: [
          [0, 0],
          [0.06, 0.5],
          [0.22, 0.9],
          [0.62, 0.46],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.42, 0.72, 1.64, [
          [0, 0.56],
          [0.18, 0.88],
          [0.52, 1.28],
          [1, 1.82],
        ]),
        position: b,
      },
    ],
    "ground-mist": (b) => [
      {
        id: "ground-mist",
        capacity: 780,
        spawnRate: 120,
        lifetime: [3.024, 4.8],
        shape: { type: "box", extents: [1.2, 0.03, 1.2] },
        velocity: { mode: "directional", direction: [1, 0.04, 0.3], speed: [0.02, 0.12] },
        color: [0.78, 0.82, 0.86, 0.55],
        size: 0.58,
        style: 1,
        blend: "alpha",
        acceleration: [[0.03, 0, 0.01]],
        drag: 0.08,
        curl: { strength: 0.01, frequency: 0.38 },
        colorCurve: [
          [0, [0.78, 0.82, 0.86]],
          [0.48, [0.66, 0.71, 0.76]],
          [1, [0.48, 0.54, 0.6]],
        ],
        alphaCurve: [
          [0, 0],
          [0.1, 0.34],
          [0.28, 0.6],
          [0.76, 0.44],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.58, 0.9, 1.64, [
          [0, 0.78],
          [0.18, 0.96],
          [0.62, 1.28],
          [1, 1.74],
        ]),
        position: b,
      },
    ],
    "poison-cloud": (b) => [
      {
        id: "poison-cloud",
        capacity: 520,
        spawnRate: 94,
        lifetime: [2.268, 3.6],
        shape: { type: "sphere", radius: 0.22 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.12, 0.44], angle: 0.52 },
        color: [0.49, 0.8, 0.34, 1],
        size: 0.54,
        style: 1,
        blend: "alpha",
        acceleration: [[0.02, 0.01, 0.04]],
        drag: 0.1,
        curl: { strength: 0.032, frequency: 0.94 },
        colorCurve: [
          [0, [0.72, 0.96, 0.48]],
          [0.44, [0.38, 0.7, 0.22]],
          [1, [0.16, 0.34, 0.08]],
        ],
        alphaCurve: [
          [0, 0],
          [0.08, 0.54],
          [0.24, 0.88],
          [0.72, 0.52],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.54, 0.8, 1.82, [
          [0, 0.62],
          [0.18, 0.9],
          [0.64, 1.42],
          [1, 1.94],
        ]),
        position: b,
      },
    ],
    rain: (b) => [
      {
        id: "rain",
        capacity: 1200,
        spawnRate: 520,
        lifetime: [0.518, 0.72],
        shape: { type: "box", extents: [1.6, 0.05, 1.6] },
        velocity: { mode: "directional", direction: [0, -1, 0], speed: [0.01, 0.08] },
        color: [0.75, 0.84, 0.92, 0.8],
        size: 0.045,
        style: 2,
        blend: "alpha",
        renderer: "ribbon",
        ribbonWidth: 0.022,
        acceleration: [
          [0, -18, 0],
          [0.05, 0, 0.02],
        ],
        drag: 0.01,
        colorCurve: [
          [0, [0.88, 0.94, 0.98]],
          [0.44, [0.72, 0.84, 0.92]],
          [1, [0.56, 0.7, 0.82]],
        ],
        alphaCurve: [
          [0, 0],
          [0.04, 0.68],
          [0.16, 0.92],
          [0.72, 0.82],
          [1, 0],
        ],
        position: b,
      },
    ],
    snow: (b) => [
      {
        id: "snow",
        capacity: 900,
        spawnRate: 130,
        lifetime: [3.528, 5.6],
        shape: { type: "box", extents: [1.5, 0.05, 1.5] },
        velocity: { mode: "directional", direction: [0, -1, 0], speed: [0, 0.06] },
        color: [0.97, 0.98, 1, 1],
        size: 0.18,
        style: 5,
        blend: "alpha",
        acceleration: [
          [0, -0.26, 0],
          [0.04, 0, 0.02],
        ],
        drag: 0.04,
        curl: { strength: 0.012, frequency: 0.44 },
        colorCurve: [
          [0, [1, 1, 1]],
          [0.52, [0.92, 0.96, 1]],
          [1, [0.84, 0.9, 0.96]],
        ],
        alphaCurve: [
          [0, 0],
          [0.08, 0.54],
          [0.28, 0.82],
          [0.8, 0.62],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.18, 0.62, 0.44, [
          [0, 0.78],
          [0.26, 1],
          [0.72, 0.94],
          [1, 0.7],
        ]),
        position: b,
      },
    ],
    "spark-streaks": (b) => [
      {
        id: "spark-streaks",
        capacity: 650,
        spawnRate: 170,
        lifetime: [0.386, 0.92],
        shape: { type: "disc", radius: 0.24 },
        velocity: {
          mode: "cone",
          direction: [0.18, 1, 0.08],
          speed: [3.074, 5.8],
          angle: Math.PI / 2.2,
        },
        color: [1, 0.96, 0.8, 1],
        size: 0.11,
        style: 2,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.035,
        acceleration: [
          [0, -4.2, 0],
          [0.04, 0, 0.02],
        ],
        drag: 0.18,
        colorCurve: SPARK_COLOR,
        alphaCurve: SPARK_ALPHA,
        sizeCurve: scaledSize(0.11, 0.82, 0.36, SPARK_SIZE),
        floor: { height: b[1], bounce: 0.34, friction: 0.12 },
        position: b,
      },
    ],
    "impact-sparks": (b) => [
      {
        id: "impact-sparks",
        capacity: 260,
        burstCount: 49,
        lifetime: [0.23, 0.64],
        shape: { type: "disc", radius: 0.08 },
        velocity: {
          mode: "cone",
          direction: [0.05, 1, 0.04],
          speed: [5.704, 9.2],
          angle: Math.PI / 1.75,
        },
        color: [1, 0.95, 0.82, 1],
        size: 0.09,
        style: 2,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.03,
        acceleration: [
          [0, -8.5, 0],
          [0.02, 0, 0.01],
        ],
        drag: 0.22,
        colorCurve: [
          [0, [1, 0.98, 0.86]],
          [0.2, [1, 0.8, 0.32]],
          [0.6, [1, 0.34, 0.06]],
          [1, [0.18, 0.05, 0.01]],
        ],
        alphaCurve: [
          [0, 0],
          [0.03, 1],
          [0.28, 0.94],
          [0.62, 0.34],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.09, 0.92, 0.22, [
          [0, 0.9],
          [0.16, 1],
          [0.56, 0.42],
          [1, 0.06],
        ]),
        floor: { height: b[1], bounce: 0.28, friction: 0.18 },
        position: b,
      },
    ],
    "ember-fountain": (b) => [
      {
        id: "ember-fountain",
        capacity: 420,
        spawnRate: 190,
        lifetime: [0.63, 1.4],
        shape: { type: "disc", radius: 0.05 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [1.976, 3.8], angle: 0.64 },
        color: [1, 0.95, 0.75, 1],
        size: 0.08,
        style: 2,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.026,
        acceleration: [
          [0, -3.4, 0],
          [0.05, 0, 0.03],
        ],
        drag: 0.12,
        colorCurve: EMBER_COLOR,
        alphaCurve: EMBER_ALPHA,
        sizeCurve: scaledSize(0.08, 0.74, 0.26, EMBER_SIZE),
        floor: { height: b[1], bounce: 0.32, friction: 0.16 },
        position: b,
      },
    ],
    "magic-wisp": (b) => [
      {
        id: "magic-wisp",
        capacity: 420,
        spawnRate: 118,
        lifetime: [1.512, 2.8],
        shape: { type: "disc", radius: 0.1 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.22, 0.84], angle: 0.4 },
        color: [0.49, 1, 0.95, 1],
        size: 0.18,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.05,
        acceleration: [[0.03, 0.01, 0.04]],
        drag: 0.1,
        curl: { strength: 0.22, frequency: 1.3 },
        colorCurve: MAGIC_COLOR,
        alphaCurve: MAGIC_ALPHA,
        sizeCurve: scaledSize(0.18, 0.52, 0.86, MAGIC_SIZE),
        position: b,
      },
    ],
    "magic-orb": (b) => [
      {
        id: "magic-orb",
        capacity: 240,
        spawnRate: 74,
        lifetime: [1.872, 2.6],
        shape: { type: "sphereSurface", radius: 0.12 },
        velocity: { mode: "radial", origin: b, speed: [0.18, 0.56] },
        color: [0.54, 1, 0.95, 1],
        size: 0.24,
        style: 3,
        blend: "additive",
        attractor: { position: pos(b, [0, 0.3, 0]), strength: 1.1 },
        curl: { strength: 0.18, frequency: 1.1 },
        drag: 0.06,
        colorCurve: [
          [0, [0.68, 1, 0.98]],
          [0.38, [0.3, 0.98, 0.88]],
          [0.78, [0.08, 0.52, 0.58]],
          [1, [0.03, 0.16, 0.2]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 0.52],
          [0.22, 0.92],
          [0.78, 0.72],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.24, 0.86, 0.66, [
          [0, 0.82],
          [0.24, 1],
          [0.62, 0.9],
          [1, 0.54],
        ]),
        position: b,
      },
    ],
    "magic-beam": (b) => [
      {
        id: "magic-beam",
        capacity: 240,
        spawnRate: 96,
        lifetime: [0.704, 1.1],
        shape: { type: "line", start: [0, 0, -0.18], end: [0, 0, 0.18] },
        velocity: { mode: "directional", direction: [1, 0.04, 0], speed: [0.52, 1.2] },
        color: [0.53, 1, 0.96, 1],
        size: 0.14,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.065,
        acceleration: [[0, 0.01, 0.02]],
        drag: 0.04,
        curl: { strength: 0.12, frequency: 1.4 },
        colorCurve: [
          [0, [0.74, 1, 0.98]],
          [0.28, [0.34, 0.96, 0.88]],
          [0.72, [0.12, 0.54, 0.62]],
          [1, [0.02, 0.14, 0.18]],
        ],
        alphaCurve: [
          [0, 0],
          [0.05, 0.68],
          [0.22, 1],
          [0.72, 0.66],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.14, 0.88, 0.54, [
          [0, 0.84],
          [0.18, 1],
          [0.66, 0.72],
          [1, 0.22],
        ]),
        position: b,
      },
    ],
    "healing-aura": (b) => [
      {
        id: "healing-aura",
        capacity: 320,
        spawnRate: 86,
        lifetime: [1.632, 2.4],
        shape: { type: "sphereSurface", radius: 0.18 },
        velocity: { mode: "radial", origin: b, speed: [0.12, 0.46] },
        color: [0.55, 1, 0.61, 1],
        size: 0.2,
        style: 3,
        blend: "additive",
        attractor: { position: pos(b, [0, 0.2, 0]), strength: 0.62 },
        curl: { strength: 0.18, frequency: 1.05 },
        drag: 0.06,
        colorCurve: [
          [0, [0.84, 1, 0.9]],
          [0.32, [0.56, 0.98, 0.62]],
          [0.74, [0.18, 0.62, 0.24]],
          [1, [0.06, 0.24, 0.08]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 0.44],
          [0.22, 0.92],
          [0.78, 0.66],
          [1, 0],
        ],
        sizeCurve: scaledSize(0.2, 0.58, 0.72, [
          [0, 0.74],
          [0.18, 1],
          [0.64, 0.84],
          [1, 0.42],
        ]),
        position: b,
      },
    ],
  };
}

const webFactories = webgpuFactories();

const cyan: readonly ColorPoint[] = [
  [0, [0.92, 1, 1]],
  [0.28, [0.45, 0.86, 1]],
  [0.72, [0.16, 0.42, 1]],
  [1, [0.03, 0.08, 0.3]],
];
const iceAlpha: readonly ScalarPoint[] = [
  [0, 0],
  [0.05, 1],
  [0.52, 0.82],
  [1, 0],
];
const holyColor: readonly ColorPoint[] = [
  [0, [1, 1, 0.9]],
  [0.3, [1, 0.94, 0.5]],
  [0.74, [0.62, 0.8, 1]],
  [1, [0.2, 0.35, 0.72]],
];

function getWebFactory(id: string): PresetFactory {
  const factory = webFactories[id];
  if (factory === undefined) {
    throw new Error(`Missing donor factory: ${id}`);
  }
  return factory;
}

function effekseerFactories(): Record<string, PresetFactory> {
  const fire = getWebFactory("fire");
  const sparks = getWebFactory("ember-fountain");
  const smoke = getWebFactory("smoke");
  const impact = getWebFactory("impact-sparks");
  const dust = getWebFactory("impact-dust");
  return {
    "effekseer-fire01": (b) =>
      fire(b).map((x, i) => ({
        ...x,
        id: `ef-fire01-${i}`,
        capacity: 700,
        spawnRate: 260,
        size: 0.28,
        curl: { strength: 0.28, frequency: 1.35 },
      })),
    "effekseer-fire02": (b) => [
      ...fire(b).map((x, i) => ({
        ...x,
        id: `ef-fire02-flame-${i}`,
        capacity: 950,
        spawnRate: 330,
        size: 0.34,
      })),
      ...sparks(b).map((x, i) => ({
        ...x,
        id: `ef-fire02-embers-${i}`,
        capacity: 260,
        spawnRate: 105,
        size: 0.06,
      })),
    ],
    "effekseer-fire03": (b) => [
      ...fire(b).map((x, i) => ({
        ...x,
        id: `ef-fire03-flame-${i}`,
        capacity: 1200,
        spawnRate: 460,
        size: 0.39,
        curl: { strength: 0.44, frequency: 1.8 },
      })),
      ...smoke(pos(b, [0, 0.35, 0])).map((x, i) => ({
        ...x,
        id: `ef-fire03-smoke-${i}`,
        capacity: 360,
        spawnRate: 55,
        size: 0.42,
        colorCurve: DARK_SMOKE_COLOR,
      })),
      ...sparks(b).map((x, i) => ({
        ...x,
        id: `ef-fire03-embers-${i}`,
        capacity: 320,
        spawnRate: 125,
      })),
    ],
    "effekseer-lightning01": (b) => [
      {
        id: "ef-lightning01",
        capacity: 180,
        burstCount: 80,
        lifetime: [0.12, 0.34],
        shape: { type: "line", start: [0, -0.15, 0], end: [0, 0.15, 0] },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [4, 8], angle: 0.55 },
        color: [0.7, 0.9, 1, 1],
        size: 0.06,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.045,
        curl: { strength: 2.6, frequency: 4.2 },
        drag: 0.08,
        colorCurve: cyan,
        alphaCurve: iceAlpha,
        position: b,
      },
    ],
    "effekseer-lightning02": (b) => [
      {
        id: "ef-lightning02-core",
        capacity: 260,
        spawnRate: 90,
        lifetime: [0.18, 0.52],
        shape: { type: "disc", radius: 0.07 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [3.2, 6.2], angle: 0.8 },
        color: [0.82, 0.95, 1, 1],
        size: 0.07,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.055,
        curl: { strength: 3.1, frequency: 5.2 },
        drag: 0.06,
        colorCurve: cyan,
        alphaCurve: [
          [0, 0],
          [0.04, 1],
          [0.7, 0.7],
          [1, 0],
        ],
        position: b,
      },
    ],
    "effekseer-lightning03": (b) => [
      {
        id: "ef-lightning03-arc",
        capacity: 340,
        spawnRate: 120,
        lifetime: [0.25, 0.75],
        shape: { type: "sphereSurface", radius: 0.22 },
        velocity: { mode: "radial", origin: b, speed: [1.4, 3.8] },
        color: [0.72, 0.86, 1, 1],
        size: 0.08,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.06,
        vortex: { center: b, axis: [0, 1, 0], strength: 4.8 },
        curl: { strength: 2.2, frequency: 4.4 },
        drag: 0.12,
        colorCurve: cyan,
        alphaCurve: iceAlpha,
        position: b,
      },
    ],
    "effekseer-ice01": (b) => [
      {
        id: "ef-ice01-frost",
        capacity: 220,
        burstCount: 120,
        lifetime: [0.5, 1.3],
        shape: { type: "sphereSurface", radius: 0.1 },
        velocity: { mode: "radial", origin: b, speed: [0.7, 2.8] },
        color: [0.78, 0.94, 1, 1],
        size: 0.18,
        style: 5,
        blend: "additive",
        acceleration: [[0, -0.2, 0]],
        drag: 0.2,
        colorCurve: cyan,
        alphaCurve: iceAlpha,
        sizeCurve: [
          [0, 0.05],
          [0.18, 0.22],
          [1, 0.06],
        ],
        position: b,
      },
    ],
    "effekseer-ice02": (b) => [
      {
        id: "ef-ice02-aura",
        capacity: 420,
        spawnRate: 100,
        lifetime: [1.4, 3],
        shape: { type: "sphereSurface", radius: 0.3 },
        velocity: { mode: "radial", origin: b, speed: [0.08, 0.28] },
        color: [0.76, 0.94, 1, 0.8],
        size: 0.15,
        style: 5,
        blend: "alpha",
        vortex: { center: b, axis: [0, 1, 0], strength: 0.8 },
        curl: { strength: 0.16, frequency: 0.9 },
        drag: 0.08,
        colorCurve: cyan,
        alphaCurve: [
          [0, 0],
          [0.12, 0.65],
          [0.75, 0.5],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.08],
          [0.5, 0.2],
          [1, 0.1],
        ],
        position: b,
      },
    ],
    "effekseer-ice03": (b) => [
      {
        id: "ef-ice03-shards",
        capacity: 300,
        burstCount: 180,
        lifetime: [0.35, 1.2],
        shape: { type: "disc", radius: 0.08 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [2.8, 7.5], angle: 1.2 },
        color: [0.8, 0.96, 1, 1],
        size: 0.07,
        style: 5,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.035,
        acceleration: [[0, -4.8, 0]],
        drag: 0.08,
        colorCurve: cyan,
        alphaCurve: iceAlpha,
        floor: { height: b[1], bounce: 0.42, friction: 0.08 },
        position: b,
      },
    ],
    "effekseer-holy01": (b) => [
      {
        id: "ef-holy01-glow",
        capacity: 360,
        spawnRate: 110,
        lifetime: [1.2, 2.8],
        shape: { type: "sphereSurface", radius: 0.26 },
        velocity: { mode: "radial", origin: b, speed: [0.12, 0.42] },
        color: [1, 0.95, 0.65, 1],
        size: 0.2,
        style: 3,
        blend: "additive",
        attractor: { position: pos(b, [0, 0.4, 0]), strength: 0.75 },
        vortex: { center: b, axis: [0, 1, 0], strength: 1.25 },
        drag: 0.06,
        colorCurve: holyColor,
        alphaCurve: MAGIC_ALPHA,
        sizeCurve: [
          [0, 0.08],
          [0.3, 0.24],
          [0.75, 0.18],
          [1, 0.06],
        ],
        position: b,
      },
      {
        id: "ef-holy01-rays",
        capacity: 160,
        spawnRate: 42,
        lifetime: [0.7, 1.6],
        shape: { type: "disc", radius: 0.18 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.8, 2.3], angle: 0.22 },
        color: [1, 0.95, 0.72, 1],
        size: 0.06,
        style: 4,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.025,
        drag: 0.05,
        colorCurve: holyColor,
        alphaCurve: SPARK_ALPHA,
        position: b,
      },
    ],
    "effekseer-hit01": (b) => [
      ...impact(b).map((x, i) => ({
        ...x,
        id: `ef-hit01-spark-${i}`,
        capacity: 220,
        burstCount: 70,
      })),
      ...dust(b).map((x, i) => ({
        ...x,
        id: `ef-hit01-dust-${i}`,
        capacity: 130,
        burstCount: 34,
        size: 0.28,
      })),
    ],
    "effekseer-hit02": (b) => [
      {
        id: "ef-hit02-flash",
        capacity: 120,
        burstCount: 60,
        lifetime: [0.08, 0.22],
        shape: { type: "sphere", radius: 0.05 },
        velocity: { mode: "radial", origin: b, speed: [0.2, 0.9] },
        color: [1, 0.82, 0.48, 1],
        size: 0.2,
        style: 4,
        blend: "additive",
        colorCurve: FIRE_COLOR,
        alphaCurve: [
          [0, 0],
          [0.04, 1],
          [0.3, 0.8],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.05],
          [0.2, 0.32],
          [1, 0.02],
        ],
        position: b,
      },
      ...impact(b).map((x, i) => ({
        ...x,
        id: `ef-hit02-spark-${i}`,
        burstCount: 95,
        capacity: 300,
      })),
    ],
    "effekseer-wind01": (b) => [
      {
        id: "ef-wind01",
        capacity: 380,
        spawnRate: 92,
        lifetime: [1.4, 2.8],
        shape: { type: "line", start: [-1.1, 0, 0], end: [1.1, 0, 0] },
        velocity: { mode: "directional", direction: [1, 0.05, 0.2], speed: [0.7, 1.7] },
        color: [0.76, 0.9, 0.92, 0.36],
        size: 0.16,
        style: 1,
        blend: "alpha",
        renderer: "ribbon",
        ribbonWidth: 0.04,
        curl: { strength: 0.4, frequency: 0.9 },
        drag: 0.03,
        colorCurve: [
          [0, [0.8, 0.94, 0.94]],
          [1, [0.5, 0.72, 0.76]],
        ],
        alphaCurve: [
          [0, 0],
          [0.15, 0.42],
          [0.7, 0.28],
          [1, 0],
        ],
        position: b,
      },
    ],
    "effekseer-wind02": (b) => [
      {
        id: "ef-wind02",
        capacity: 520,
        spawnRate: 128,
        lifetime: [1.8, 3.6],
        shape: { type: "disc", radius: 0.6 },
        velocity: { mode: "cone", direction: [1, 0.08, 0], speed: [0.45, 1.25], angle: 0.38 },
        color: [0.82, 0.92, 0.9, 0.34],
        size: 0.3,
        style: 6,
        blend: "alpha",
        vortex: { center: b, axis: [0, 1, 0], strength: 1.2 },
        curl: { strength: 0.32, frequency: 0.72 },
        drag: 0.04,
        colorCurve: [
          [0, [0.82, 0.94, 0.9]],
          [1, [0.46, 0.68, 0.64]],
        ],
        alphaCurve: [
          [0, 0],
          [0.12, 0.38],
          [0.68, 0.25],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.12],
          [0.5, 0.42],
          [1, 0.5],
        ],
        position: b,
      },
    ],
    "effekseer-wind03": (b) => [
      {
        id: "ef-wind03",
        capacity: 620,
        spawnRate: 155,
        lifetime: [2.2, 4.2],
        shape: { type: "sphereSurface", radius: 0.7 },
        velocity: { mode: "radial", origin: b, speed: [0.18, 0.6] },
        color: [0.74, 0.9, 0.86, 0.3],
        size: 0.28,
        style: 6,
        blend: "alpha",
        vortex: { center: b, axis: [0, 1, 0], strength: 2.6 },
        curl: { strength: 0.5, frequency: 1.1 },
        drag: 0.05,
        colorCurve: [
          [0, [0.76, 0.92, 0.88]],
          [1, [0.38, 0.62, 0.58]],
        ],
        alphaCurve: [
          [0, 0],
          [0.12, 0.34],
          [0.72, 0.22],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.08],
          [0.4, 0.32],
          [1, 0.5],
        ],
        position: b,
      },
    ],
  };
}

const effFactories = effekseerFactories();

function additionalDonorFactories(): Record<string, PresetFactory> {
  const cyan: readonly ColorPoint[] = [
    [0, [0.78, 0.98, 1]],
    [1, [0.22, 0.72, 0.94]],
  ];
  const red: readonly ColorPoint[] = [
    [0, [1, 0.22, 0.22]],
    [0.56, [0.7, 0.06, 0.08]],
    [1, [0.22, 0, 0.02]],
  ];
  return {
    "kenney-slash-arc": (b) => [
      {
        id: "kenney-slash-arc-ribbon",
        capacity: 180,
        burstCount: 90,
        lifetime: [0.12, 0.28],
        shape: { type: "line", start: pos(b, [-0.5, 0.12, -0.18]), end: pos(b, [0.5, 0.28, 0.18]) },
        velocity: { mode: "directional", direction: [0, 0.2, 0], speed: [0.15, 0.55] },
        color: [1, 0.98, 0.92, 1],
        size: 0.08,
        style: 4,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.05,
        drag: 0.18,
        colorCurve: [
          [0, [1, 1, 1]],
          [0.2, [1, 0.82, 0.42]],
          [1, [1, 0.32, 0.08]],
        ],
        alphaCurve: [
          [0, 0],
          [0.02, 1],
          [0.5, 0.84],
          [1, 0],
        ],
        position: b,
      },
      {
        id: "kenney-slash-arc-flash",
        capacity: 64,
        burstCount: 24,
        lifetime: [0.08, 0.16],
        shape: { type: "disc", radius: 0.05 },
        velocity: { mode: "radial", origin: b, speed: [0.08, 0.28] },
        color: [1, 0.92, 0.7, 1],
        size: 0.16,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "additive",
        drag: 0.7,
        colorCurve: [
          [0, [1, 1, 0.96]],
          [1, [1, 0.48, 0.1]],
        ],
        alphaCurve: [
          [0, 0],
          [0.03, 1],
          [0.36, 0.55],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.12],
          [0.2, 0.36],
          [1, 0.02],
        ],
        position: b,
      },
    ],
    "kenney-confetti-burst": (b) => [
      {
        id: "kenney-confetti-red",
        capacity: 120,
        burstCount: 45,
        lifetime: [1.2, 2.1],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [1.6, 4.2] },
        color: [1, 0.2, 0.2, 1],
        size: 0.05,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, -3.8, 0]],
        drag: 0.04,
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-5, 5],
        colorCurve: [
          [0, [1, 0.26, 0.22]],
          [1, [0.8, 0.08, 0.08]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 1],
          [0.88, 0.95],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.9],
          [1, 0.72],
        ],
        position: b,
      },
      {
        id: "kenney-confetti-blue",
        capacity: 120,
        burstCount: 45,
        lifetime: [1.2, 2.1],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [1.6, 4.2] },
        color: [0.2, 0.72, 1, 1],
        size: 0.05,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, -3.8, 0]],
        drag: 0.04,
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-5, 5],
        colorCurve: [
          [0, [0.22, 0.76, 1]],
          [1, [0.08, 0.32, 0.88]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 1],
          [0.88, 0.95],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.9],
          [1, 0.72],
        ],
        position: b,
      },
      {
        id: "kenney-confetti-yellow",
        capacity: 120,
        burstCount: 45,
        lifetime: [1.2, 2.1],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [1.6, 4.2] },
        color: [1, 0.92, 0.24, 1],
        size: 0.05,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, -3.8, 0]],
        drag: 0.04,
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-5, 5],
        colorCurve: [
          [0, [1, 0.94, 0.34]],
          [1, [0.86, 0.62, 0.08]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 1],
          [0.88, 0.95],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.9],
          [1, 0.72],
        ],
        position: b,
      },
      {
        id: "kenney-confetti-green",
        capacity: 120,
        burstCount: 45,
        lifetime: [1.2, 2.1],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [1.6, 4.2] },
        color: [0.26, 1, 0.44, 1],
        size: 0.05,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, -3.8, 0]],
        drag: 0.04,
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-5, 5],
        colorCurve: [
          [0, [0.28, 1, 0.48]],
          [1, [0.08, 0.7, 0.18]],
        ],
        alphaCurve: [
          [0, 0],
          [0.06, 1],
          [0.88, 0.95],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.9],
          [1, 0.72],
        ],
        position: b,
      },
    ],
    "kenney-leaf-swirl": (b) => [
      {
        id: "kenney-leaf-swirl-green",
        capacity: 340,
        spawnRate: 88,
        lifetime: [2.4, 4.2],
        shape: { type: "sphereSurface", radius: 0.7 },
        velocity: { mode: "radial", origin: b, speed: [0.18, 0.56] },
        color: [0.38, 0.72, 0.26, 0.75],
        size: 0.12,
        style: 1,
        texture: SMOKE_SPRITE_TEXTURE,
        blend: "alpha",
        vortex: { center: b, axis: [0, 1, 0], strength: 2.1 },
        acceleration: [
          [0, -0.36, 0],
          [0.02, 0, 0.01],
        ],
        drag: 0.05,
        curl: { strength: 0.16, frequency: 0.85 },
        colorCurve: [
          [0, [0.44, 0.76, 0.32]],
          [1, [0.24, 0.46, 0.16]],
        ],
        alphaCurve: [
          [0, 0],
          [0.12, 0.72],
          [0.72, 0.42],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.2],
          [0.5, 0.42],
          [1, 0.24],
        ],
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-1.8, 1.8],
        position: b,
      },
      {
        id: "kenney-leaf-swirl-brown",
        capacity: 220,
        spawnRate: 58,
        lifetime: [2.4, 4.2],
        shape: { type: "sphereSurface", radius: 0.68 },
        velocity: { mode: "radial", origin: b, speed: [0.14, 0.48] },
        color: [0.62, 0.46, 0.22, 0.7],
        size: 0.1,
        style: 1,
        texture: SMOKE_SPRITE_TEXTURE,
        blend: "alpha",
        vortex: { center: b, axis: [0, 1, 0], strength: 1.8 },
        acceleration: [
          [0, -0.4, 0],
          [0.02, 0, 0.01],
        ],
        drag: 0.05,
        curl: { strength: 0.12, frequency: 0.78 },
        colorCurve: [
          [0, [0.7, 0.54, 0.24]],
          [1, [0.42, 0.28, 0.12]],
        ],
        alphaCurve: [
          [0, 0],
          [0.1, 0.66],
          [0.7, 0.38],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.18],
          [0.5, 0.36],
          [1, 0.22],
        ],
        rotation: [-Math.PI, Math.PI],
        angularVelocity: [-1.6, 1.6],
        position: b,
      },
    ],
    "pixi-bubble-stream": (b) => [
      {
        id: "pixi-bubble-stream",
        capacity: 260,
        spawnRate: 72,
        lifetime: [1.6, 2.8],
        shape: { type: "disc", radius: 0.14 },
        velocity: { mode: "cone", direction: [0, 1, 0], speed: [0.24, 0.64], angle: 0.34 },
        color: [0.82, 0.96, 1, 0.62],
        size: 0.12,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [
          [0, 0.12, 0],
          [0.01, 0, 0.01],
        ],
        drag: 0.03,
        curl: { strength: 0.05, frequency: 0.6 },
        colorCurve: cyan,
        alphaCurve: [
          [0, 0],
          [0.08, 0.46],
          [0.6, 0.34],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.1],
          [0.18, 0.16],
          [1, 0.22],
        ],
        position: b,
      },
    ],
    "pixi-cartoon-smoke-blast": (b) => [
      {
        id: "pixi-cartoon-smoke",
        capacity: 280,
        burstCount: 76,
        lifetime: [0.8, 1.8],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [0.4, 1.6] },
        color: [0.62, 0.62, 0.62, 1],
        size: 0.32,
        style: 1,
        texture: SMOKE_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, 0.2, 0]],
        drag: 0.11,
        curl: { strength: 0.08, frequency: 0.95 },
        colorCurve: [
          [0, [0.84, 0.84, 0.84]],
          [0.52, [0.62, 0.62, 0.62]],
          [1, [0.34, 0.34, 0.34]],
        ],
        alphaCurve: [
          [0, 0],
          [0.05, 0.86],
          [0.2, 1],
          [0.74, 0.48],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.4],
          [0.24, 0.9],
          [1, 1.7],
        ],
        position: b,
      },
    ],
    "godot-fireflies": (b) => [
      {
        id: "godot-fireflies",
        capacity: 220,
        spawnRate: 36,
        lifetime: [2.6, 4.8],
        shape: { type: "box", extents: [1.2, 0.8, 1.2] },
        velocity: { mode: "cone", direction: [0, 0.12, 0], speed: [0.02, 0.12], angle: Math.PI },
        color: [1, 0.98, 0.52, 1],
        size: 0.06,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "additive",
        attractor: { position: pos(b, [0, 0.4, 0]), strength: 0.12 },
        drag: 0.12,
        curl: { strength: 0.12, frequency: 0.8 },
        colorCurve: [
          [0, [1, 1, 0.7]],
          [0.6, [0.82, 1, 0.36]],
          [1, [0.5, 0.78, 0.18]],
        ],
        alphaCurve: [
          [0, 0],
          [0.1, 0.25],
          [0.16, 0.95],
          [0.82, 0.82],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.04],
          [0.18, 0.08],
          [1, 0.04],
        ],
        position: b,
      },
    ],
    "godot-portal-vortex": (b) => [
      {
        id: "godot-portal-vortex-ring",
        capacity: 300,
        spawnRate: 84,
        lifetime: [1.8, 3.2],
        shape: { type: "sphereSurface", radius: 0.46 },
        velocity: { mode: "radial", origin: b, speed: [0.04, 0.16] },
        color: [0.34, 0.78, 1, 0.86],
        size: 0.16,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "additive",
        vortex: { center: b, axis: [0, 1, 0], strength: 2.8 },
        drag: 0.06,
        curl: { strength: 0.12, frequency: 1.2 },
        colorCurve: [
          [0, [0.56, 0.94, 1]],
          [0.5, [0.26, 0.7, 1]],
          [1, [0.08, 0.18, 0.46]],
        ],
        alphaCurve: [
          [0, 0],
          [0.08, 0.5],
          [0.26, 0.92],
          [0.82, 0.44],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.12],
          [0.4, 0.24],
          [1, 0.1],
        ],
        position: b,
      },
      {
        id: "godot-portal-vortex-ribbons",
        capacity: 180,
        spawnRate: 44,
        lifetime: [1.2, 2.4],
        shape: { type: "sphereSurface", radius: 0.38 },
        velocity: { mode: "radial", origin: b, speed: [0.18, 0.52] },
        color: [0.72, 0.92, 1, 1],
        size: 0.06,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.026,
        vortex: { center: b, axis: [0, 1, 0], strength: 3.2 },
        drag: 0.04,
        colorCurve: [
          [0, [0.76, 0.98, 1]],
          [1, [0.1, 0.38, 0.86]],
        ],
        alphaCurve: [
          [0, 0],
          [0.08, 1],
          [0.74, 0.6],
          [1, 0],
        ],
        position: b,
      },
    ],
    "godot-blood-splash": (b) => [
      {
        id: "godot-blood-splash",
        capacity: 320,
        burstCount: 96,
        lifetime: [0.36, 1.2],
        shape: { type: "disc", radius: 0.08 },
        velocity: { mode: "cone", direction: [0, 0.62, 0], speed: [1.2, 4.2], angle: 1.35 },
        color: [0.92, 0.08, 0.08, 1],
        size: 0.08,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [[0, -5.6, 0]],
        drag: 0.06,
        colorCurve: red,
        alphaCurve: [
          [0, 0],
          [0.04, 0.92],
          [0.72, 0.7],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.08],
          [0.2, 0.1],
          [1, 0.06],
        ],
        floor: { height: b[1], bounce: 0.08, friction: 0.62 },
        position: b,
      },
    ],
    "godot-shield-break": (b) => [
      {
        id: "godot-shield-break-core",
        capacity: 180,
        burstCount: 68,
        lifetime: [0.14, 0.42],
        shape: { type: "sphere", radius: 0.06 },
        velocity: { mode: "radial", origin: b, speed: [0.18, 0.82] },
        color: [0.62, 0.94, 1, 1],
        size: 0.18,
        style: 3,
        texture: GLOW_SPRITE_TEXTURE,
        blend: "additive",
        drag: 0.38,
        colorCurve: cyan,
        alphaCurve: [
          [0, 0],
          [0.03, 1],
          [0.3, 0.78],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.12],
          [0.18, 0.4],
          [1, 0.02],
        ],
        position: b,
      },
      {
        id: "godot-shield-break-shards",
        capacity: 220,
        burstCount: 74,
        lifetime: [0.34, 0.92],
        shape: { type: "sphere", radius: 0.08 },
        velocity: { mode: "radial", origin: b, speed: [2.4, 6.4] },
        color: [0.78, 0.96, 1, 1],
        size: 0.06,
        style: 3,
        blend: "additive",
        renderer: "ribbon",
        ribbonWidth: 0.03,
        acceleration: [[0, -1.6, 0]],
        drag: 0.08,
        colorCurve: cyan,
        alphaCurve: [
          [0, 0],
          [0.03, 1],
          [0.62, 0.58],
          [1, 0],
        ],
        floor: { height: b[1], bounce: 0.24, friction: 0.18 },
        position: b,
      },
    ],
    "godot-waterfall-mist": (b) => [
      {
        id: "godot-waterfall-mist",
        capacity: 520,
        spawnRate: 116,
        lifetime: [2.1, 4.2],
        shape: { type: "box", extents: [0.7, 1.2, 0.24] },
        velocity: { mode: "cone", direction: [0.48, 0.18, 0], speed: [0.08, 0.36], angle: 0.46 },
        color: [0.84, 0.9, 0.96, 0.56],
        size: 0.34,
        style: 1,
        texture: SMOKE_SPRITE_TEXTURE,
        blend: "alpha",
        acceleration: [
          [0, 0.08, 0],
          [0.04, 0, 0.01],
        ],
        drag: 0.08,
        curl: { strength: 0.06, frequency: 0.7 },
        colorCurve: [
          [0, [0.92, 0.96, 1]],
          [1, [0.72, 0.8, 0.9]],
        ],
        alphaCurve: [
          [0, 0],
          [0.08, 0.28],
          [0.32, 0.52],
          [0.82, 0.24],
          [1, 0],
        ],
        sizeCurve: [
          [0, 0.42],
          [0.36, 0.94],
          [1, 1.52],
        ],
        position: b,
      },
    ],
  };
}
const extraFactories = additionalDonorFactories();

function donorFactory(
  factories: Readonly<Record<string, PresetFactory>>,
  id: string,
): PresetFactory {
  const factory = factories[id];
  if (factory === undefined) throw new Error(`Missing donor recipe: ${id}`);
  return factory;
}

// Named source functions keep the gallery's render modules explicit. There is deliberately no
// runtime string-keyed catalog: each effect module chooses the donor recipe it owns and supplies
// its seed to the shared GPU particle mechanism.
export const fireLayers = donorFactory(webFactories, "fire");
export const jetFlameLayers = donorFactory(webFactories, "jet-flame");
export const burstFlashLayers = donorFactory(webFactories, "burst-flash");
export const muzzleFlashLayers = donorFactory(webFactories, "muzzle-flash");
export const smokeLayers = donorFactory(webFactories, "smoke");
export const dustCloudLayers = donorFactory(webFactories, "dust-cloud");
export const steamPlumeLayers = donorFactory(webFactories, "steam-plume");
export const ashPlumeLayers = donorFactory(webFactories, "ash-plume");
export const explosionCloudLayers = donorFactory(webFactories, "explosion-cloud");
export const impactDustLayers = donorFactory(webFactories, "impact-dust");
export const groundMistLayers = donorFactory(webFactories, "ground-mist");
export const poisonCloudLayers = donorFactory(webFactories, "poison-cloud");
export const rainLayers = donorFactory(webFactories, "rain");
export const snowLayers = donorFactory(webFactories, "snow");
export const sparkStreaksLayers = donorFactory(webFactories, "spark-streaks");
export const impactSparksLayers = donorFactory(webFactories, "impact-sparks");
export const emberFountainLayers = donorFactory(webFactories, "ember-fountain");
export const magicWispLayers = donorFactory(webFactories, "magic-wisp");
export const magicOrbLayers = donorFactory(webFactories, "magic-orb");
export const magicBeamLayers = donorFactory(webFactories, "magic-beam");
export const healingAuraLayers = donorFactory(webFactories, "healing-aura");
export const effekseerFire01Layers = donorFactory(effFactories, "effekseer-fire01");
export const effekseerFire02Layers = donorFactory(effFactories, "effekseer-fire02");
export const effekseerFire03Layers = donorFactory(effFactories, "effekseer-fire03");
export const effekseerLightning01Layers = donorFactory(effFactories, "effekseer-lightning01");
export const effekseerLightning02Layers = donorFactory(effFactories, "effekseer-lightning02");
export const effekseerLightning03Layers = donorFactory(effFactories, "effekseer-lightning03");
export const effekseerIce01Layers = donorFactory(effFactories, "effekseer-ice01");
export const effekseerIce02Layers = donorFactory(effFactories, "effekseer-ice02");
export const effekseerIce03Layers = donorFactory(effFactories, "effekseer-ice03");
export const effekseerHoly01Layers = donorFactory(effFactories, "effekseer-holy01");
export const effekseerHit01Layers = donorFactory(effFactories, "effekseer-hit01");
export const effekseerHit02Layers = donorFactory(effFactories, "effekseer-hit02");
export const effekseerWind01Layers = donorFactory(effFactories, "effekseer-wind01");
export const effekseerWind02Layers = donorFactory(effFactories, "effekseer-wind02");
export const effekseerWind03Layers = donorFactory(effFactories, "effekseer-wind03");
export const kenneySlashArcLayers = donorFactory(extraFactories, "kenney-slash-arc");
export const kenneyConfettiBurstLayers = donorFactory(extraFactories, "kenney-confetti-burst");
export const kenneyLeafSwirlLayers = donorFactory(extraFactories, "kenney-leaf-swirl");
export const pixiBubbleStreamLayers = donorFactory(extraFactories, "pixi-bubble-stream");
export const pixiCartoonSmokeBlastLayers = donorFactory(extraFactories, "pixi-cartoon-smoke-blast");
export const godotFirefliesLayers = donorFactory(extraFactories, "godot-fireflies");
export const godotPortalVortexLayers = donorFactory(extraFactories, "godot-portal-vortex");
export const godotBloodSplashLayers = donorFactory(extraFactories, "godot-blood-splash");
export const godotShieldBreakLayers = donorFactory(extraFactories, "godot-shield-break");
export const godotWaterfallMistLayers = donorFactory(extraFactories, "godot-waterfall-mist");
