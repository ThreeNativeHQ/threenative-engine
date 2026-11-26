// Generated for you. Camera framing is yours to edit.
//
// A chase camera behind the car (reference card carmageddon/chase-camera): the view swings toward
// the car's heading at a limited rate, faster while the car spins; the distance grows with speed;
// and a wall between the car and the lens pulls the lens in.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

export const RIG = {
  /** Metres behind the car at rest, plus this much per m/s (car.c:5429 uses the square root of zoom). */
  distance: 7.4,
  extraPerMs: 0.07,
  height: 2.9,
  aim: 1.0,
  /** The swing starts at 0.03 degrees per millisecond and rises to 0.1 while spinning (car.c:5631, 5642). */
  swingRate: MathUtils.degToRad(0.03 * 1000),
  swingCeiling: MathUtils.degToRad(0.1 * 1000),
  /** The height follows the car at 5 per second (car.c:5475). */
  heightFollow: 5,
} as const;
const WALL_MARGIN = 0.4;

/** Metres from `from` toward `to` to the first wall, or undefined when the way is clear. */
export type WallProbe = (from: Vector3, to: Vector3) => number | undefined;

const _aim = new Vector3();
const _desired = new Vector3();

export class ChaseCamera {
  /** Heading the lens looks along: forward is `(-sin yaw, 0, -cos yaw)`. */
  yaw = 0;
  #height = 0;

  constructor(readonly camera: PerspectiveCamera) {
    camera.fov = 62;
    camera.near = 0.1;
    camera.far = 20_000;
    camera.updateProjectionMatrix();
  }

  /** Snaps behind the car, as after a restart or a station. */
  snap(heading: number, subject: Vector3): void {
    this.yaw = heading;
    this.#height = subject.y;
  }

  update(dt: number, subject: Vector3, heading: number, speed: number, probe: WallProbe): void {
    const delta = MathUtils.euclideanModulo(heading - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    // Nearly stopped: no swing at all, so the lens does not wander round a parked car (car.c:5419).
    if (Math.abs(speed) > 0.5) {
      const rate = Math.min(RIG.swingCeiling, RIG.swingRate + Math.abs(delta) * 2.2);
      this.yaw += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
    }
    this.#height = MathUtils.damp(this.#height, subject.y, RIG.heightFollow, dt);
    const distance = RIG.distance + Math.abs(speed) * RIG.extraPerMs;
    _aim.copy(subject);
    _aim.y += RIG.aim;
    _desired.set(
      subject.x + Math.sin(this.yaw) * distance,
      this.#height + RIG.height,
      subject.z + Math.cos(this.yaw) * distance,
    );
    const wall = probe(subject, _desired);
    if (wall !== undefined) {
      const room = Math.max(0.8, wall - WALL_MARGIN);
      _desired.sub(subject).setLength(room).add(subject);
      _desired.y = Math.max(_desired.y, subject.y + 3.2);
    }
    if (wall !== undefined || this.camera.position.distanceTo(_desired) > 10)
      this.camera.position.copy(_desired);
    else this.camera.position.lerp(_desired, Math.min(1, dt * 14));
    this.camera.lookAt(_aim);
  }
}
