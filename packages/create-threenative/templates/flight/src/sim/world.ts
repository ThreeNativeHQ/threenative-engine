// The island, its air and its course, as plain numbers. Nothing here draws (it takes only the `MathUtils`
// helpers from Three.js), so the terrain, the wind and the thermals answer the same on every target and in a headless check.
//
// Reference: pilotwings-64-n64decomp `air-volumes` (`src/app/thermals.c:206`, `wind.c:485`,
// `environment.c:307`): a thermal lifts by the square root of the remaining radial fraction and
// fades near its bottom and top; the ambient wind wanders slowly around its mean.

import { MathUtils } from "three";

export const GRAVITY = 9.8;
/** Sea level, metres. The seabed is below it and the sea plane is drawn at this height. */
export const SEA_LEVEL = 0;

export interface IVec3 {
  x: number;
  y: number;
  z: number;
}

export const smoothstep = (from: number, to: number, value: number): number =>
  MathUtils.smoothstep(value, from, to);

const bump = (
  x: number,
  z: number,
  cx: number,
  cz: number,
  sigma: number,
  height: number,
): number => height * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * sigma * sigma));

/** The landing pad: a flat disc on the south-east shore. */
export const PAD = { x: 170, z: 130, radius: 18, height: 3 } as const;
/** Where the glider starts: on the lip of the launch hill, already flying toward the pad. */
export const LAUNCH = { x: -250, z: -180, heading: Math.atan2(PAD.x + 250, PAD.z + 180) } as const;
/** The rocket belt starts on the ground at the foot of the same pad, facing the first ring. */
export const BELT_START = { x: 120, z: 78, heading: Math.atan2(30, 30) } as const;

/** Ground height in metres at a point. Below `SEA_LEVEL` it is seabed. */
export function groundHeight(x: number, z: number): number {
  const island = 1 - smoothstep(350, 440, Math.hypot(x, z));
  const rolling = 1.6 * Math.sin(x * 0.031) * Math.sin(z * 0.027);
  const hills =
    bump(x, z, LAUNCH.x, LAUNCH.z, 85, 92) +
    bump(x, z, 40, -215, 55, 38) +
    bump(x, z, -150, 150, 60, 24);
  const land = island * (4 + rolling + hills) - (1 - island) * 9;
  // The pad is flat so a landing is judged on the pilot, not on a slope.
  const flat = 1 - smoothstep(PAD.radius + 6, PAD.radius + 40, Math.hypot(x - PAD.x, z - PAD.z));
  return land + (PAD.height - land) * flat;
}

/** The ambient wind at time `t`, metres per second: a steady breeze with a slow gust. */
export const WIND_MEAN = { x: 2.6, z: -1.6 } as const;
export function windAt(t: number, out: IVec3 = { x: 0, y: 0, z: 0 }): IVec3 {
  const gust = 1 + 0.22 * Math.sin(t * 0.37) + 0.1 * Math.sin(t * 0.91 + 1.3);
  out.x = WIND_MEAN.x * gust;
  out.y = 0;
  out.z = WIND_MEAN.z * gust;
  return out;
}

export interface IThermal {
  readonly x: number;
  readonly z: number;
  /** Radius of the column, metres. */
  readonly radius: number;
  /** Updraft at the centre, metres per second. */
  readonly peak: number;
  /** Height of the column's top above the sea, metres. */
  readonly top: number;
}

export const THERMALS: readonly IThermal[] = [
  { x: -45, z: -40, radius: 62, peak: 7, top: 230 },
  { x: 95, z: -150, radius: 55, peak: 6.5, top: 200 },
];

/** Vertical air speed of one thermal at a point, metres per second. */
export function thermalLift(thermal: IThermal, x: number, y: number, z: number): number {
  const ground = groundHeight(thermal.x, thermal.z);
  const radial = Math.hypot(x - thermal.x, z - thermal.z) / thermal.radius;
  if (radial >= 1) return 0;
  // The column grows out of the ground and thins out under its top, as the reference's two bands.
  const bottom = smoothstep(ground, ground + 20, y);
  const top = 1 - smoothstep(thermal.top - 40, thermal.top, y);
  return thermal.peak * Math.sqrt(1 - radial) * bottom * top;
}

/** The air's own velocity at a point: the wind plus every thermal's lift. */
export function airAt(
  x: number,
  y: number,
  z: number,
  t: number,
  out: IVec3 = { x: 0, y: 0, z: 0 },
): IVec3 {
  windAt(t, out);
  for (const thermal of THERMALS) out.y += thermalLift(thermal, x, y, z);
  return out;
}

export interface IRing {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radius of the opening, metres. Reference: `ring-gates` size classes 7.5, 12.5 and 25. */
  readonly radius: number;
  /** Direction the pilot must cross it in: the face normal's yaw, radians (0 faces +z). */
  readonly yaw: number;
}

const ring = (
  x: number,
  y: number,
  z: number,
  radius: number,
  toward: { x: number; z: number },
): IRing => ({
  radius,
  x,
  y,
  z,
  yaw: Math.atan2(toward.x - x, toward.z - z),
});

/** The glider's course, in order. Heights are metres above the sea. */
export const GLIDER_RINGS: readonly IRing[] = [
  ring(-170, 86, -122, 14, { x: -100, z: -70 }),
  ring(-100, 74, -70, 14, { x: -45, z: -30 }),
  ring(-45, 96, -40, 14, { x: 20, z: 5 }),
  ring(30, 82, 12, 14, { x: 80, z: 50 }),
  ring(100, 52, 64, 14, { x: PAD.x, z: PAD.z }),
];

/** The rocket belt's course: low and tight, around the pad. */
export const BELT_RINGS: readonly IRing[] = [
  ring(136, 14, 96, 9, { x: 160, z: 120 }),
  ring(176, 26, 158, 9, { x: 210, z: 140 }),
  ring(214, 16, 118, 9, { x: 180, z: 90 }),
];

export type Vehicle = "glider" | "belt";
export const COURSES: Readonly<Record<Vehicle, readonly IRing[]>> = {
  belt: BELT_RINGS,
  glider: GLIDER_RINGS,
};
