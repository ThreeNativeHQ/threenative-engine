import { Vector3 } from "three";
import { type ClearLine, type ITarget, sightStrength } from "../ai/perception.js";
import type { CAMERAS } from "../level.js";
import { createSecurityCamera, createViewCone, tintViewCone } from "../render/props.js";
import type { GameCtx } from "./Fighter.js";

/** Sweep speed, radians per second, and the pause at each end of the sweep, seconds. */
const SWEEP_RATE = 0.45;
const END_PAUSE = 1.2;
const HALF_ANGLE = 0.38;
const RANGE = 9;
/** A camera does not wonder: it fills fast, and at 1 the base goes to Alert. */
const RISE = 3.2;
const DECAY = 0.8;
/** The floor right under the camera, metres from the wall: it looks out, not down. */
const BLIND_SPOT = 1.2;

/**
 * A wall camera: it sweeps between two yaws, pauses at each end, and calls the alert itself. It
 * sees a crouched player — crouching shrinks the silhouette, it does not make you invisible — but
 * it never hears, and it cannot be choked.
 */
export class SecurityCamera {
  readonly id: string;
  readonly tags = ["camera", "hostile"];
  readonly eye = new Vector3();
  suspicion = 0;
  sight = 0;
  #centre: number;
  #sweep: number;
  #yaw: number;
  #direction = 1;
  #pause = 0;
  readonly #view = {
    eye: this.eye,
    halfAngle: HALF_ANGLE,
    minRange: BLIND_SPOT,
    range: RANGE,
    yaw: 0,
  };
  readonly #pivot;
  readonly #cone;

  constructor(ctx: GameCtx, spec: (typeof CAMERAS)[number]) {
    this.id = spec.id;
    this.#centre = spec.yaw;
    this.#sweep = spec.sweep;
    this.#yaw = spec.yaw - spec.sweep;
    const { root, pivot } = createSecurityCamera();
    root.position.set(spec.x, spec.height, spec.z);
    this.#pivot = pivot;
    this.#cone = createViewCone(RANGE, HALF_ANGLE);
    this.#cone.position.set(spec.x, 0.04, spec.z);
    ctx.add(root);
    ctx.add(this.#cone);
    this.eye.set(spec.x, spec.height, spec.z);
    this.#apply();
  }

  get yaw(): number {
    return this.#yaw;
  }

  get halfAngle(): number {
    return HALF_ANGLE;
  }

  get range(): number {
    return RANGE;
  }

  /** One tick; returns true on the tick the camera has seen enough to call Alert. */
  update(dt: number, player: ITarget, clear: ClearLine): boolean {
    if (this.#pause > 0) this.#pause -= dt;
    else {
      this.#yaw += this.#direction * SWEEP_RATE * dt;
      const offset = this.#yaw - this.#centre;
      if (Math.abs(offset) >= this.#sweep) {
        this.#yaw = this.#centre + Math.sign(offset) * this.#sweep;
        this.#direction = -this.#direction;
        this.#pause = END_PAUSE;
      }
    }
    // The camera looks down from the wall: its eye is high, so a crouched player behind a low
    // crate is still covered, and one in the open is not. It has no close sense, and the floor
    // within `BLIND_SPOT` of its wall is out of its view.
    this.#view.yaw = this.#yaw;
    this.sight = sightStrength(this.#view, player, clear);
    const before = this.suspicion;
    this.suspicion =
      this.sight > 0
        ? Math.min(1, this.suspicion + RISE * Math.max(this.sight, 0.4) * dt)
        : Math.max(0, this.suspicion - DECAY * dt);
    this.#apply();
    return this.suspicion >= 1 && before < 1;
  }

  #apply(): void {
    this.#pivot.rotation.y = this.#yaw;
    this.#cone.rotation.y = this.#yaw;
    tintViewCone(
      this.#cone,
      this.suspicion >= 1 ? "alert" : this.suspicion > 0 ? "suspicious" : "patrol",
    );
  }

  debug(): Record<string, unknown> {
    return {
      sight: Math.round(this.sight * 1000) / 1000,
      suspicion: Math.round(this.suspicion * 1000) / 1000,
      yaw: Math.round(this.#yaw * 1000) / 1000,
    };
  }
}
