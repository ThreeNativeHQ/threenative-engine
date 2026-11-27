// Generated for you. Camera framing is yours to edit.
//
// Two rigs on one spring arm. On foot, an orbit the mouse turns, which swings back behind the
// player a moment after the mouse stops (GTA III's follow camera; MCP card
// grand-theft-auto-iii-re3/camera-yaw-switch blends offsets in 0.25 / 0.75 steps). In a car, a
// chase camera behind the car's heading that pulls back with speed. A wall between the subject and
// the lens pulls the lens in front of it.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

export const FOOT_RIG = {
  distance: 4.8,
  height: 1.5,
  aim: 0.75,
  recenterAfter: 1.4,
  recenterRate: 2.2,
} as const;
export const CAR_RIG = {
  distance: 7.2,
  extraPerMs: 0.08,
  height: 2.7,
  aim: 1.1,
  followRate: 4,
} as const;
/** Pitch limits in radians: further up than down, so the lens never digs under the road. */
const PITCH_MIN = -0.35;
/** Below this much room behind the player, the lens cranes up instead of pressing in. */
const CRANE_ROOM = 1.6;
/** How high above the body the crane goes when there is no room behind at all. */
const CRANE_HEIGHT = 2.6;
const PITCH_MAX = 0.9;
const LOOK_SENSITIVITY = 0.0028;
const WALL_MARGIN = 0.35;

/** Metres from `from` toward `to` to the first wall, or undefined when the way is clear. */
export type WallProbe = (from: Vector3, to: Vector3) => number | undefined;

const _aim = new Vector3();
const _desired = new Vector3();

export class CityCamera {
  /** Heading the lens looks along: forward is `(-sin yaw, 0, -cos yaw)`. Player input reads it. */
  yaw = 0;
  pitch = 0.22;
  #idle = 0;
  #driving = false;

  constructor(readonly camera: PerspectiveCamera) {
    camera.fov = 60;
    camera.near = 0.1;
    camera.far = 20_000;
    camera.updateProjectionMatrix();
  }

  /**
   * `look` is raw mouse motion this tick; `heading` the yaw the subject faces or drives along (the
   * same convention); `speed` the car's, in m/s, when driving.
   */
  update(
    dt: number,
    subject: Vector3,
    heading: number,
    look: { x: number; y: number },
    driving: boolean,
    speed: number,
    probe: WallProbe,
  ): void {
    const moved = Math.abs(look.x) + Math.abs(look.y) > 0.01;
    if (moved) {
      this.yaw -= look.x * LOOK_SENSITIVITY;
      this.pitch = MathUtils.clamp(this.pitch + look.y * LOOK_SENSITIVITY, PITCH_MIN, PITCH_MAX);
      this.#idle = 0;
    } else this.#idle += dt;
    // A cut on entering or leaving a car: snap behind instead of sweeping across the street.
    if (driving !== this.#driving) {
      this.#driving = driving;
      this.yaw = heading;
      this.#idle = 0;
    }
    const rig = driving ? CAR_RIG : FOOT_RIG;
    const recenter = driving ? this.#idle > 0.6 : this.#idle > FOOT_RIG.recenterAfter;
    const behind = MathUtils.euclideanModulo(heading - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    // On foot it only settles in behind a player running roughly away from the lens: a recentre
    // on a sideways or backward run would chase the heading and walk the player in circles.
    if (recenter && (driving || Math.abs(behind) < Math.PI / 4)) {
      const rate = driving
        ? CAR_RIG.followRate * Math.min(1, Math.abs(speed) / 6)
        : FOOT_RIG.recenterRate;
      const delta = MathUtils.euclideanModulo(heading - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
      this.yaw += delta * Math.min(1, rate * dt);
      if (driving) this.pitch = MathUtils.damp(this.pitch, 0.18, 2, dt);
    }
    const distance = rig.distance + (driving ? Math.abs(speed) * CAR_RIG.extraPerMs : 0);
    _aim.copy(subject);
    _aim.y += rig.aim;
    const flat = Math.cos(this.pitch) * distance;
    _desired.set(
      subject.x + Math.sin(this.yaw) * flat,
      subject.y + rig.height + Math.sin(this.pitch) * distance - 0.5,
      subject.z + Math.cos(this.yaw) * flat,
    );
    // Never below the road: a low pitch at chase distance would put the lens in the asphalt.
    _desired.y = Math.max(_desired.y, subject.y + 0.4);
    // Probe from the body, not the aim point above the head: a lens that clears a wall corner
    // for the head can still have the wall across the body. Pulled in along that ray, the line
    // from the lens to the player is the line just proven clear.
    const wall = probe(subject, _desired);
    if (wall !== undefined) {
      const room = Math.max(0.5, wall - WALL_MARGIN);
      _desired.sub(subject).setLength(room).add(subject);
      // Backed against a wall with no room behind: crane up over the head and look down, so the
      // wall stays behind the lens. A roof overhead caps the climb.
      if (room < CRANE_ROOM) {
        _desired.y = Math.max(_desired.y, subject.y + CRANE_HEIGHT - room);
        const roof = probe(subject, _desired);
        if (roof !== undefined)
          _desired
            .sub(subject)
            .setLength(Math.max(0.5, roof - WALL_MARGIN))
            .add(subject);
      }
    }
    // Ease the lens, but never lag more than a metre behind its goal.
    const gap = this.camera.position.distanceTo(_desired);
    if (wall !== undefined || gap > 8) this.camera.position.copy(_desired);
    else this.camera.position.lerp(_desired, Math.min(1, dt * 14));
    this.camera.lookAt(_aim);
  }
}
