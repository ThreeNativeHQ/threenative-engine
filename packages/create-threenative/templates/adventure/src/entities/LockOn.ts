import { Billboard3D } from "@threenative/core";
import type { Group, PerspectiveCamera, Vector3 } from "three";
import { Vector3 as V3 } from "three";
import { createReticle } from "../render/creatures.js";

/** Anything Wren can lock onto and cut: Mosslings, the Warden, the practice dummies. */
export interface ITarget {
  readonly id: string;
  readonly mesh: Group;
  readonly alive: boolean;
  /** Body radius, so reach is measured to the surface. */
  readonly radius: number;
  /** Where the reticle floats, above the origin. */
  readonly height: number;
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

/**
 * Z-targeting, game-owned: no engine capability locks on, so this file picks and holds a target.
 *
 * Holding `target` locks the nearest living hostile inside 12 m and the camera's 60° cone, and
 * keeps it while held. Releasing drops the lock; pressing again within 0.3 s moves it to the next
 * nearest hostile instead. The lock also drops when the target dies or leaves range. The camera and
 * the hero read `target`; neither picks one.
 */
export class LockOn {
  target: ITarget | undefined;
  /** True on the one step a target was acquired, so the hero can record the strafe distance. */
  justAcquired = false;
  readonly reticle: Group;
  readonly #billboard: Billboard3D;
  #released: ITarget | undefined;
  #window = 0;
  #spin = 0;
  readonly #view = new V3();
  readonly #to = new V3();

  constructor(camera: PerspectiveCamera) {
    this.reticle = createReticle();
    this.#billboard = new Billboard3D(this.reticle, { camera });
  }

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
    if (target !== undefined) {
      this.#spin += dt * 2;
      this.reticle.position.copy(target.mesh.position);
      this.reticle.position.y += target.height;
      this.#billboard.update();
      this.reticle.rotateZ(this.#spin);
      this.reticle.scale.setScalar(1 + Math.sin(this.#spin * 3) * 0.06);
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
      if (skip === undefined && this.#view.dot(this.#to.normalize()) < Math.cos(CONE / 2)) continue;
      best = candidate;
      bestDistance = distance;
    }
    return best;
  }
}
