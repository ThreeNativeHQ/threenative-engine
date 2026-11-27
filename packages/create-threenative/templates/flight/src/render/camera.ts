// The chase view: behind and above the craft, turning with its flight direction but not with its
// bank, so a turn is seen from outside and the horizon stays level.
//
// Reference: pilotwings-64-n64decomp `hang-glider` follows the glider's heading with a damped
// camera; a damped follow with a fast rate gives the same settle.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { groundHeight } from "../sim/world.js";

const DISTANCE = 15;
const HEIGHT = 4.6;
const LOOK_AHEAD = 9;
const HEADING_RATE = 2.6;
const FOLLOW_RATE = 7;
/** The lens stays this far above the ground, and the line to the craft stays this far above it. */
const GROUND_CLEARANCE = 2.5;
const LINE_CLEARANCE = 1;
const _desired = new Vector3();
const _aim = new Vector3();

export interface ICameraRig {
  readonly follow: (target: Vector3, heading: number, dt: number) => void;
  readonly snap: (target: Vector3, heading: number) => void;
}

export function createChaseCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 62;
  camera.near = 0.3;
  camera.far = 6000;
  camera.updateProjectionMatrix();
  let heading = 0;

  const place = (target: Vector3): void => {
    _desired.set(
      target.x - Math.sin(heading) * DISTANCE,
      target.y + HEIGHT,
      target.z - Math.cos(heading) * DISTANCE,
    );
    // Pull the lens in along the line to the craft until no ridge stands between them.
    const samples = 10;
    for (let step = 1; step <= samples; step += 1) {
      const share = step / samples;
      const x = target.x + (_desired.x - target.x) * share;
      const y = target.y + (_desired.y - target.y) * share;
      const z = target.z + (_desired.z - target.z) * share;
      if (y >= groundHeight(x, z) + LINE_CLEARANCE) continue;
      const kept = (step - 1) / samples;
      _desired.set(
        target.x + (_desired.x - target.x) * kept,
        target.y + (_desired.y - target.y) * kept,
        target.z + (_desired.z - target.z) * kept,
      );
      break;
    }
    _desired.y = Math.max(_desired.y, groundHeight(_desired.x, _desired.z) + GROUND_CLEARANCE);
  };
  const aim = (target: Vector3): void => {
    camera.lookAt(
      _aim.set(
        target.x + Math.sin(heading) * LOOK_AHEAD,
        target.y + 0.5,
        target.z + Math.cos(heading) * LOOK_AHEAD,
      ),
    );
  };
  return {
    follow: (target, craftHeading, dt) => {
      const turn =
        MathUtils.euclideanModulo(craftHeading - heading + Math.PI, Math.PI * 2) - Math.PI;
      heading += turn * MathUtils.damp(0, 1, HEADING_RATE, dt);
      place(target);
      camera.position.lerp(_desired, MathUtils.damp(0, 1, FOLLOW_RATE, dt));
      camera.position.y = Math.max(
        camera.position.y,
        groundHeight(camera.position.x, camera.position.z) + GROUND_CLEARANCE,
      );
      aim(target);
    },
    snap: (target, craftHeading) => {
      heading = craftHeading;
      place(target);
      camera.position.copy(_desired);
      aim(target);
    },
  };
}
