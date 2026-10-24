import type { Group, PerspectiveCamera, Vector3 } from "three";
import { Box3, MathUtils, Vector3 as V3 } from "three";
import { createReticle } from "../render/creatures.js";

/** Anything Wren can lock onto and cut: Mosslings, the Warden, the practice dummies. */
export interface ITarget {
  readonly id: string;
  readonly mesh: Group;
  readonly alive: boolean;
  /** Body radius, so reach is measured to the surface. */
  readonly radius: number;
  /** The physics body the slash query reports. */
  readonly bodyId: number | undefined;
  /** Returns true when the hit did damage. */
  hurt(damage: number, from: Vector3): boolean;
}

const RANGE = 12;
/** The acquisition cone around the camera's view, full angle. */
const CONE = (60 * Math.PI) / 180;
/** A release and a press inside this window moves the lock to the next target. */
const SWITCH_WINDOW = 0.3;
/** A hostile this close locks from any side: the one at Wren's back is the one that matters. */
const CLOSE = 3;
/** The marker's tip floats this far over the target's top, before the bob and the height scale. */
const LIFT = 0.45;
/** Past this camera distance the marker grows, so it stays readable across a room. */
const READABLE_AT = 12;

/**
 * Z-targeting, game-owned: no engine capability locks on, so this file picks and holds a target.
 *
 * Holding `target` locks the nearest living hostile inside 12 m and the camera's 60° cone (or
 * within 3 m on any side), and keeps it while held. Releasing drops the lock; pressing again
 * within 0.3 s moves it to the next nearest hostile instead. The lock also drops when the target dies or leaves range. The camera and
 * the hero read `target`; neither picks one.
 */
export class LockOn {
  target: ITarget | undefined;
  /** True on the one step a target was acquired, so the hero can record the strafe distance. */
  justAcquired = false;
  readonly reticle: Group = createReticle();
  /** How far the marker's lowest point floats over the locked target's top (m); 0 while unlocked. */
  markerLift = 0;
  #released: ITarget | undefined;
  #window = 0;
  #spin = 0;
  readonly #view = new V3();
  readonly #to = new V3();
  readonly #bounds = new Box3();
  readonly #marker = new Box3();

  update(
    dt: number,
    held: boolean,
    pressed: boolean,
    hero: Vector3,
    camera: PerspectiveCamera,
    targets: readonly ITarget[],
  ): void {
    this.justAcquired = false;
    this.#window = Math.max(0, this.#window - dt);
    const current = this.target;
    if (
      current !== undefined &&
      (!current.alive || current.mesh.position.distanceTo(hero) > RANGE + 1)
    )
      this.target = undefined;
    if (!held && this.target !== undefined) {
      this.#released = this.target;
      this.#window = SWITCH_WINDOW;
      this.target = undefined;
    }
    if (pressed && this.target === undefined) {
      const skip = this.#window > 0 ? this.#released : undefined;
      this.target = this.#pick(hero, camera, targets, skip);
      this.justAcquired = this.target !== undefined;
    }
    const target = this.target;
    this.reticle.visible = target !== undefined;
    this.markerLift = 0;
    if (target !== undefined) {
      // The target's live bounds, not a fixed offset: a rearing Warden or a hopping Mossling keeps
      // the arrow over its real top.
      const box = this.#bounds.setFromObject(target.mesh);
      const tall = MathUtils.clamp((box.max.y - box.min.y) / 1.8, 0.75, 1.25);
      this.#spin += dt * 1.6;
      const lift = LIFT + 0.05 * tall + Math.sin(this.#spin * 2.5) * 0.06;
      this.reticle.position.set(
        (box.min.x + box.max.x) / 2,
        box.max.y + lift,
        (box.min.z + box.max.z) / 2,
      );
      this.reticle.rotation.set(0, this.#spin, 0);
      const far = this.reticle.position.distanceTo(camera.position) / READABLE_AT;
      this.reticle.scale.setScalar(tall * Math.max(1, far));
      // Measured, not assumed: the gap from the target's top to the marker's own lowest point.
      this.markerLift = this.#marker.setFromObject(this.reticle).min.y - box.max.y;
    }
  }

  /**
   * The nearest living target in range. A fresh lock also needs the camera's cone; a switch takes
   * the nearest one that is not the target just released, wherever it stands.
   */
  #pick(
    hero: Vector3,
    camera: PerspectiveCamera,
    targets: readonly ITarget[],
    skip: ITarget | undefined,
  ): ITarget | undefined {
    camera.getWorldDirection(this.#view).setY(0).normalize();
    let best: ITarget | undefined;
    let bestDistance = RANGE;
    for (const candidate of targets) {
      if (!candidate.alive || candidate === skip) continue;
      this.#to.subVectors(candidate.mesh.position, hero).setY(0);
      const distance = this.#to.length();
      if (distance > bestDistance) continue;
      const ahead = this.#view.dot(this.#to.normalize()) >= Math.cos(CONE / 2);
      if (skip === undefined && !ahead && distance > CLOSE) continue;
      best = candidate;
      bestDistance = distance;
    }
    return best;
  }
}
