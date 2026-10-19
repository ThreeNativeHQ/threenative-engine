import { PathFollow3D } from "@threenative/core";
// The walk. PRD-280 §2: rim → switchback → floor → up to the face, ending nose-to-surface at
// roughly 0.4 m, as a pure function of the frame index — so a slow arm and a fast arm frame the
// same triangles at frame 1200, and two runs of the same arm frame them twice.
import { Vector3 } from "three";
import { cliffSurfaceZ } from "./bodies.js";
import { floorHeight } from "./terrain.js";

/** Metres from the ground to the eye. One metre is one metre. */
export const EYE_HEIGHT = 1.7;
/** Frames the route takes end to end at the game's fixed 1/60 step: thirty seconds of walking. */
export const ROUTE_FRAMES = 1800;
/** How close the walk's last frame stands to the rock. */
export const CONTACT_DISTANCE = 0.4;

/**
 * The named frames of the route, in order. Each is a regime continuous cluster LOD is supposed to
 * behave differently in, and each is where a screenshot and a pose assertion are taken.
 */
export const ROUTE_MARKS = [
  { frame: 120, label: "rim" },
  { frame: 620, label: "switchback" },
  { frame: 1120, label: "floor" },
  { frame: 1500, label: "approach" },
  // Not the last frame: nose-on at 0.4 m the face fills the frame as one nearly flat surface,
  // which is the regime the technique cares about and a useless picture to compare arms on. The
  // walk still ends at 0.4 m; the reference frame is taken from four metres out, where the face's
  // relief is what a reader and an image difference can both see.
  { frame: 1740, label: "contact" },
] as const;

/**
 * Ground-plane control points, walked in order. The final point is placed against the rock rather
 * than at an authored z, because the face is generated and an authored number would be measuring a
 * different approach on any machine that regenerated it.
 */
const CONTROL_POINTS: readonly (readonly [number, number])[] = [
  [52, 40],
  [41, 21],
  [31, 27],
  [21, 9],
  [13, -3],
  [4, 7],
  [2, -9],
  [1.5, -18],
  [1.5, cliffSurfaceZ(1.5, EYE_HEIGHT) + CONTACT_DISTANCE],
];

const path = new PathFollow3D({
  points: CONTROL_POINTS.map(([x, z]) => new Vector3(x, floorHeight(x, z) + EYE_HEIGHT, z)),
});

export interface IRoutePose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const sample = { point: new Vector3(), progress: 0, tangent: new Vector3() };
const ahead = { point: new Vector3(), progress: 0, tangent: new Vector3() };

/**
 * Where the camera is and what it looks at on frame `frameIndex`.
 *
 * The curve gives the horizontal track; the eye height comes from the same `floorHeight` the
 * control surface's triangles came from, which is what "the camera grounds against the heightfield
 * in ten lines of game code" means here. No physics: Rapier's step is real frame time that has
 * nothing to do with what is being measured.
 */
export function routePose(frameIndex: number): IRoutePose {
  if (!Number.isInteger(frameIndex) || frameIndex < 0)
    throw new Error("routePose requires a non-negative integer frame index.");
  const fraction = Math.min(1, frameIndex / ROUTE_FRAMES);
  const distance = fraction * path.totalLength;
  path.sample(distance, sample);
  // Three metres ahead, so the gaze leads the walk. Clamped to the end so the last frames look at
  // the rock they are standing against rather than past it.
  path.sample(Math.min(path.totalLength, distance + 3), ahead);
  const position: [number, number, number] = [
    sample.point.x,
    floorHeight(sample.point.x, sample.point.z) + EYE_HEIGHT,
    sample.point.z,
  ];
  const target: [number, number, number] = [
    ahead.point.x,
    floorHeight(ahead.point.x, ahead.point.z) + EYE_HEIGHT,
    ahead.point.z,
  ];
  // Past the last control point the two samples coincide and `lookAt` has no direction to use.
  if (
    Math.abs(target[0] - position[0]) < 1e-6 &&
    Math.abs(target[2] - position[2]) < 1e-6 &&
    Math.abs(target[1] - position[1]) < 1e-6
  )
    return { position, target: [position[0], position[1], position[2] - 1] };
  return { position, target };
}
