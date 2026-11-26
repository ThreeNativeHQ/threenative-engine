import { PathFollow3D } from "@threenative/core";
import { Group, Quaternion, Vector3 } from "three";
import { createGunshipModel, createScoutModel } from "../render/hulls.js";
import type { EnemyKind } from "../level.js";
import { ENEMY, SHIELD } from "../tuning.js";
import type { ITarget } from "./Target.js";
import type { Weapons } from "./Weapons.js";

const _forward = new Vector3(0, 0, -1);
const _quaternion = new Quaternion();
const _lead = new Vector3();
const _aim = new Vector3();
const _side = new Vector3();
const UP = new Vector3(0, 1, 0);
const _sample = { point: new Vector3(), progress: 0, tangent: new Vector3() };

/** What an enemy reads of the ship each tick. */
export interface IShipView {
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly forward: Vector3;
}

export interface IEnemyOptions {
  readonly id: string;
  readonly kind: EnemyKind;
  /** World points of the path it flies, from far ahead to behind the ship. */
  readonly path?: readonly Vector3[];
  /** A test dummy that rides ahead of the ship at a fixed offset and never fires. */
  readonly pinned?: { readonly ahead: number; readonly x: number; readonly y: number };
  /** Seconds before it appears, so a wave arrives in a line. */
  readonly delay?: number;
}

/**
 * A fighter on a spline. It flies its path, fires at the ship while it is ahead of it and inside
 * the firing band, and dies after `hp` hits. The hit count is the whole damage model.
 */
export class Enemy implements ITarget {
  readonly id: string;
  readonly kind: EnemyKind;
  readonly group = new Group();
  readonly radius: number;
  hp: number;
  /** True from the first tick it is in the world until it dies or leaves. */
  live = false;
  /** Set once it has died, so the scene scores it exactly once. */
  killed = false;
  /** Set once it has left the path without dying. */
  escaped = false;
  readonly #path: PathFollow3D | undefined;
  readonly #speed: number;
  readonly #interval: number;
  readonly #pinned: IEnemyOptions["pinned"];
  #delay: number;
  #fire: number;

  constructor(options: IEnemyOptions) {
    this.id = options.id;
    this.kind = options.kind;
    const spec = ENEMY[options.kind];
    this.hp = spec.hp;
    this.radius = spec.radius;
    this.#speed = spec.speed;
    this.#interval = spec.interval;
    this.#pinned = options.pinned;
    this.#delay = options.delay ?? 0;
    this.#fire = spec.interval * 0.6 + (options.delay ?? 0) * 0.1;
    this.#path = options.path === undefined ? undefined : new PathFollow3D({ points: [...options.path] });
    this.group.name = this.id;
    this.group.add(options.kind === "scout" ? createScoutModel() : createGunshipModel());
    this.group.visible = false;
  }

  get position(): Vector3 {
    return this.group.position;
  }

  hurt(damage: number): boolean {
    if (!this.live) return false;
    this.hp -= damage;
    if (this.hp <= 0) {
      this.live = false;
      this.killed = true;
    }
    return true;
  }

  update(dt: number, ship: IShipView, rig: { readonly world: (ahead: number, x: number, y: number, out: Vector3) => Vector3 }, weapons: Weapons): void {
    if (this.killed || this.escaped) return;
    if (this.#delay > 0) {
      this.#delay -= dt;
      if (this.#delay > 0) return;
    }
    this.live = true;
    this.group.visible = true;
    if (this.#pinned !== undefined) {
      rig.world(this.#pinned.ahead, this.#pinned.x, this.#pinned.y, this.group.position);
      this.group.quaternion.setFromUnitVectors(_forward, _aim.copy(ship.forward).negate());
      return;
    }
    const path = this.#path;
    if (path === undefined) return;
    path.progressTo(path.progress + this.#speed * dt);
    path.sample(path.progress, _sample);
    this.group.position.copy(_sample.point);
    // Face the way it flies, and roll a little into the bend.
    _quaternion.setFromUnitVectors(_forward, _sample.tangent);
    this.group.quaternion.slerp(_quaternion, 1 - Math.exp(-8 * dt));
    if (path.completed) {
      this.live = false;
      this.escaped = true;
      this.group.visible = false;
      return;
    }
    this.#shoot(dt, ship, weapons);
  }

  /** Fires an aimed shot, led to where the ship will be when it arrives, while the ship is ahead. */
  #shoot(dt: number, ship: IShipView, weapons: Weapons): void {
    this.#fire -= dt;
    if (this.#fire > 0) return;
    const to = _aim.subVectors(ship.position, this.group.position);
    const distance = to.length();
    const ahead = -to.dot(ship.forward);
    // The ship looks down +forward, so an enemy in front of it has ship - enemy pointing back along forward.
    if (distance < ENEMY.fireNear || distance > ENEMY.fireFar || ahead < 5) return;
    this.#fire = this.#interval;
    _lead.copy(ship.position).addScaledVector(ship.velocity, distance / ENEMY.shotSpeed);
    const direction = _lead.sub(this.group.position).normalize();
    for (const spread of this.kind === "gunship" ? [-1, 0, 1] : [0])
      weapons.fireEnemy(
        this.group.position,
        _side.copy(direction).applyAxisAngle(UP, spread * 0.09),
        SHIELD.shotDamage,
      );
  }

  dispose(): void {
    this.group.removeFromParent();
  }

  debug(): Record<string, unknown> {
    return { hp: this.hp, kind: this.kind, live: this.live, position: this.group.position.toArray() };
  }
}
