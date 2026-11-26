// The side view. Both fighters stay in frame: the camera pans to the middle of what they cover and
// backs off as they spread, then closes in as they come together.
//
// Reference: super-smash-bros `battle-camera-framing` — a box per fighter that reaches farther in
// front of it than behind it, a vertical margin, the union turned into a distance between fixed
// limits, and a slow pan toward the target. The margins are the card's 1000, 700 and 700 world
// units at 0.003 m each; the field of view is the card's 38 degrees.
import { MathUtils, type PerspectiveCamera } from "three";
import { UNIT } from "../sim/constants.js";
import type { IFighter } from "../sim/types.js";

const FOV = 38; // gmcamera.c:636
const FRONT_MARGIN = 1000 * UNIT; // gmcamera.c:356
const REAR_MARGIN = 700 * UNIT; // gmcamera.c:357
const VERTICAL_MARGIN = 700 * UNIT; // gmcamera.c:372
/** Extra room under the fighters so the stage top stays clear of the HUD plates. Tuned, not from the card. */
const FLOOR_ROOM = 1.6;
/** Closest and farthest the camera sits from the fight, metres. Card minimum 2500 units. */
const MIN_DISTANCE = 2500 * UNIT + 2;
const MAX_DISTANCE = 45;
/** Fraction of the remaining way covered per 60 Hz frame (gmcamera.c:545, 549). */
const PAN = 0.1;

export interface IFightCamera {
  /** Fits the frame around both fighters. `snap` jumps there at once. */
  readonly follow: (fighters: readonly IFighter[], dt: number, snap?: boolean) => void;
  readonly state: { distance: number; x: number; y: number };
}

export function createFightCamera(camera: PerspectiveCamera): IFightCamera {
  camera.fov = FOV;
  camera.updateProjectionMatrix();
  const state = { distance: 18, x: 0, y: 2 };
  const tanHalf = Math.tan(MathUtils.degToRad(FOV / 2));
  return {
    follow: (fighters, dt, snap = false) => {
      let x0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const f of fighters) {
        if (f.mode === "dead") continue;
        x0 = Math.min(x0, f.x - (f.facing === -1 ? FRONT_MARGIN : REAR_MARGIN));
        x1 = Math.max(x1, f.x + (f.facing === 1 ? FRONT_MARGIN : REAR_MARGIN));
        y0 = Math.min(y0, f.y - VERTICAL_MARGIN - FLOOR_ROOM);
        y1 = Math.max(y1, f.y + 1.8 + VERTICAL_MARGIN);
      }
      if (x0 === Number.POSITIVE_INFINITY) return;
      const aspect = camera.aspect > 0 ? camera.aspect : 16 / 9;
      const wanted = MathUtils.clamp(
        Math.max((x1 - x0) / 2 / (tanHalf * aspect), (y1 - y0) / 2 / tanHalf),
        MIN_DISTANCE,
        MAX_DISTANCE,
      );
      const k = snap ? 1 : 1 - (1 - PAN) ** (dt * 60);
      state.x += ((x0 + x1) / 2 - state.x) * k;
      state.y += ((y0 + y1) / 2 - state.y) * k;
      state.distance += (wanted - state.distance) * k;
      camera.position.set(state.x, state.y, state.distance);
      camera.lookAt(state.x, state.y, 0);
    },
    state,
  };
}
