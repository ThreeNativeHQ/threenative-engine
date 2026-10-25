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
/** A hostile this close locks from any side, nearest first: the near one is the one that matters. */
const CLOSE = 6;
/** The marker's tip floats this far over the target's top, before the bob and the height scale. */
const LIFT = 0.45;
/** The arrow's own height (m) at scale 1, from `createReticle`. */
const ARROW_HEIGHT = 0.42;
/** The arrow never draws shorter than this share of the view's height: ~26 px at 720 p. */
const MIN_SCREEN_SHARE = 0.036;

/**
 * Z-targeting, game-owned: no engine capability locks on, so this file picks and holds a target.
 *
 * Pressing `lock` (Tab, middle click) locks the nearest hostile the same way and keeps it with no
 * button held; pressing it again moves to the next nearest, and after the last one it drops. The
 * hold path below stays on Q and the left trigger.
 *
 * Holding `target` locks the nearest living hostile within 6 m on any side, or else the nearest
 * inside 12 m and the camera's 60° cone, and keeps it while held. Releasing drops the lock;
 * pressing again within 0.3 s moves it to the next nearest hostile instead. The lock also drops
 * when the target dies or leaves range. The camera and the hero read `target`; neither picks one.
 */
export class LockOn {
  target: ITarget | undefined;
  /** True on the one step a target was acquired, so the hero can record the strafe distance. */
  justAcquired = false;
  readonly reticle: Group = createReticle();
  /** How far the marker's lowest point floats over the locked target's top (m); 0 while unlocked. */
  markerLift = 0;
  /** The locked target's live bounds: the camera frames them and the playtests measure them. */
  readonly bounds = new Box3();
  /** The marker's top (m), for the camera's framing; 0 while unlocked. */
  markerTop = 0;
  /** A target taken by the `lock` toggle stays locked when no button is held. */
  #sticky = false;
  #released: ITarget | undefined;
  #window = 0;
  #spin = 0;
  readonly #view = new V3();
  readonly #to = new V3();
  readonly #marker = new Box3();

  update(
    dt: number,
    held: boolean,
    pressed: boolean,
    toggled: boolean,
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
    if (held || this.target === undefined) this.#sticky = false;
    if (!held && !this.#sticky && this.target !== undefined) {
      this.#released = this.target;
      this.#window = SWITCH_WINDOW;
      this.target = undefined;
    }
    if (pressed && this.target === undefined) {
      const skip = this.#window > 0 ? this.#released : undefined;
      this.target = this.#pick(hero, camera, targets, skip);
      this.justAcquired = this.target !== undefined;
    }
    if (toggled && !held) {
      this.target = this.#cycle(hero, camera, targets);
      this.#sticky = this.target !== undefined;
      this.justAcquired = this.target !== undefined;
    }
    const target = this.target;
    this.reticle.visible = target !== undefined;
    this.markerLift = 0;
    this.markerTop = 0;
    if (target !== undefined) {
      // The target's live bounds, not a fixed offset: a rearing Warden or a hopping Mossling keeps
      // the arrow over its real top.
      const box = this.bounds.setFromObject(target.mesh);
      const tall = MathUtils.clamp((box.max.y - box.min.y) / 1.8, 0.75, 1.25);
      this.#spin += dt * 1.6;
      const lift = LIFT + 0.05 * tall + Math.sin(this.#spin * 2.5) * 0.06;
      this.reticle.position.set(
        (box.min.x + box.max.x) / 2,
        box.max.y + lift,
        (box.min.z + box.max.z) / 2,
      );
      this.reticle.rotation.set(0, this.#spin, 0);
      // Far away, it grows so its height on screen never drops under MIN_SCREEN_SHARE.
      const span =
        2 *
        this.reticle.position.distanceTo(camera.position) *
        Math.tan(MathUtils.degToRad(camera.fov / 2));
      this.reticle.scale.setScalar(Math.max(tall, (MIN_SCREEN_SHARE * span) / ARROW_HEIGHT));
      // Measured, not assumed: the gap from the target's top to the marker's own lowest point.
      const marker = this.#marker.setFromObject(this.reticle);
      this.markerLift = marker.min.y - box.max.y;
      this.markerTop = marker.max.y;
    }
  }

  /**
   * The toggle's next target: with none locked, the same pick a hold makes; with one locked, the
   * next farther hostile in range, and `undefined` (drop) after the farthest.
   */
  #cycle(
    hero: Vector3,
    camera: PerspectiveCamera,
    targets: readonly ITarget[],
  ): ITarget | undefined {
    const current = this.target;
    if (current === undefined) return this.#pick(hero, camera, targets, undefined);
    const distance = (candidate: ITarget): number =>
      this.#to.subVectors(candidate.mesh.position, hero).setY(0).length();
    const near = distance(current);
    let next: ITarget | undefined;
    let nextDistance = RANGE;
    for (const candidate of targets) {
      if (!candidate.alive || candidate === current) continue;
      const apart = distance(candidate);
      if (apart < near || (apart === near && candidate.id < current.id)) continue;
      if (apart <= nextDistance) {
        next = candidate;
        nextDistance = apart;
      }
    }
    return next;
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
