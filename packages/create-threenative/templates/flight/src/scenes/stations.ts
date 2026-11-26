// Playtest stations: each key puts the craft at a fixed spot so one scenario proves one mechanic in
// a few ticks instead of a scripted flight across the island. They answer only under a playtest
// runner (`UNDER_PLAYTEST` in `Play.ts`), never in a real build. Delete them with the playtests.
import { type IRing, PAD, type Vehicle, groundHeight, windAt } from "../sim/world.js";

export interface IStation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Direction of flight, three.js yaw. */
  readonly heading: number;
  /** Glider bank, radians. */
  readonly bank?: number;
  /** Belt tank at the start, 0..1. */
  readonly fuel?: number;
}

/** Glider speed through the air at the stations, m/s: the trim speed of `Attempt`. */
const SPEED = 18;
const BODY = 1.6;

/** Where to start so a glider flying `distance` metres at the ring's heading crosses its centre. */
function approach(ring: IRing, distance: number, sideways = 0): { x: number; z: number } {
  const nx = Math.sin(ring.yaw);
  const nz = Math.cos(ring.yaw);
  const seconds = distance / SPEED;
  const wind = windAt(0);
  return {
    x: ring.x - nx * distance - wind.x * seconds + nz * sideways,
    z: ring.z - nz * distance - wind.z * seconds - nx * sideways,
  };
}

export function stationFor(vehicle: Vehicle, name: string, course: readonly IRing[]): IStation | undefined {
  const first = course[0];
  const second = course[1];
  const last = course[course.length - 1];
  if (first === undefined || second === undefined || last === undefined) return undefined;
  const padGround = groundHeight(PAD.x, PAD.z);
  const glider = vehicle === "glider";
  switch (name) {
    // Open air, above every thermal and far from the ground.
    case "station1":
      return glider
        ? { heading: 0, x: 300, y: 380, z: 100 }
        : { heading: 0, x: 300, y: groundHeight(300, 100) + 30, z: 100 };
    // The middle of the first thermal, 60 m up.
    case "station2":
      return glider
        ? { heading: 0, x: -45, y: groundHeight(-45, -40) + 60, z: -40 }
        : { fuel: 0.1, heading: 0, x: PAD.x, y: padGround + 22, z: PAD.z };
    // On the line to the first ring, then the same line shifted 22 m sideways (outside its opening).
    case "station3":
      return { ...approach(first, glider ? 45 : 14), heading: first.yaw, y: first.y + (glider ? 5 : 0) };
    case "station4":
      return { ...approach(first, glider ? 45 : 14, 22), heading: first.yaw, y: first.y + (glider ? 5 : 0) };
    // On the line to the second ring: the first is skipped.
    case "station5":
      return { ...approach(second, glider ? 45 : 14), heading: second.yaw, y: second.y + (glider ? 5 : 0) };
    // Short final, on the line to the pad, low enough to touch down near its centre.
    case "station6":
      return glider
        ? { ...approach({ ...last, x: PAD.x, z: PAD.z }, 62), heading: last.yaw, y: padGround + BODY + 6.5 }
        : { heading: 0, x: PAD.x, y: padGround + 8, z: PAD.z };
    // High over the pad: a dive from here is too fast to survive; a belt with no fuel falls the same way.
    case "station7":
      return glider
        ? { heading: last.yaw, x: PAD.x, y: padGround + BODY + 70, z: PAD.z }
        : { fuel: 0, heading: 0, x: PAD.x, y: padGround + 25, z: PAD.z };
    // Low over the pad, on its back.
    case "station8":
      return glider
        ? { bank: 3, heading: last.yaw, x: PAD.x, y: padGround + BODY + 1.5, z: PAD.z }
        : undefined;
    default:
      return undefined;
  }
}
