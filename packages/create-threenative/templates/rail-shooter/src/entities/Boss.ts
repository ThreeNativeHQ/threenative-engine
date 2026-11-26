import { Group, Matrix4, Vector3 } from "three";
import { type IBossModel, createBossModel } from "../render/hulls.js";
import { BOSS, ENEMY, SHIELD } from "../tuning.js";
import type { IShipView } from "./Enemy.js";
import type { ITarget } from "./Target.js";
import type { Weapons } from "./Weapons.js";
import { interceptDirection } from "./aim.js";

const UP = new Vector3(0, 1, 0);
const _aim = new Vector3();
const _shot = new Vector3();
const _left = new Vector3();
const _basis = new Matrix4();

/** One weak point of the boss. A shot hurts it only while `armoured` is false. */
class WeakPoint implements ITarget {
  hp: number;
  /** Set once the scene has been told it fell. */
  reported = false;
  readonly position = new Vector3();
  constructor(
    readonly id: string,
    hp: number,
    readonly radius: number,
    readonly score: number,
    private readonly armoured: () => boolean,
  ) {
    this.hp = hp;
  }

  get live(): boolean {
    return this.hp > 0 && !this.armoured();
  }

  hurt(damage: number): boolean {
    if (!this.live) return false;
    this.hp = Math.max(0, this.hp - damage);
    return true;
  }
}

/** A weak point that fell: where, what it scores and whether it was the core. */
export interface IBossEvent {
  readonly at: Vector3;
  readonly score: number;
  readonly core: boolean;
}

/**
 * The Warden waits at the end of the rail. Its two gun pods are weak points; while either stands,
 * armour covers the core (phase 1). With both gone the plates open and the core takes hits
 * (phase 2); under 40 percent the core rages and fires faster, wider volleys (phase 3).
 */
export class Boss {
  readonly group = new Group();
  readonly model: IBossModel = createBossModel();
  readonly pods: readonly [WeakPoint, WeakPoint] = [
    new WeakPoint("boss.pod.left", BOSS.pod.hp, BOSS.pod.radius, BOSS.pod.score, () => false),
    new WeakPoint("boss.pod.right", BOSS.pod.hp, BOSS.pod.radius, BOSS.pod.score, () => false),
  ];
  readonly core = new WeakPoint(
    "boss.core",
    BOSS.core.hp,
    BOSS.core.radius,
    BOSS.core.score,
    () => this.podsLeft > 0,
  );
  engaged = false;
  defeated = false;
  /** Seconds since the core fell. */
  dying = 0;
  readonly #fire = [BOSS.pod.interval * 0.5, BOSS.pod.interval];
  #fireCore = 1.5;
  #clock = 0;

  constructor() {
    this.group.name = "boss";
    this.group.add(this.model.group);
    this.group.visible = false;
  }

  get podsLeft(): number {
    return this.pods.filter((pod) => pod.hp > 0).length;
  }

  /** 0 before the fight, then 1 armoured, 2 core open, 3 core raging, 4 defeated. */
  get phase(): number {
    if (!this.engaged) return 0;
    if (this.defeated) return 4;
    if (this.podsLeft > 0) return 1;
    return this.core.hp / BOSS.core.hp <= BOSS.rageShare ? 3 : 2;
  }

  get targets(): readonly ITarget[] {
    return this.engaged && !this.defeated ? [...this.pods, this.core] : [];
  }

  /**
   * `anchor` is where the boss hangs: ahead of the ship on the rail. The boss faces back down the
   * rail. Returns the weak points that fell this tick.
   */
  update(
    dt: number,
    ship: IShipView,
    anchor: Vector3,
    axes: { readonly right: Vector3; readonly up: Vector3; readonly forward: Vector3 },
    weapons: Weapons,
  ): readonly IBossEvent[] {
    if (this.defeated) {
      this.dying += dt;
      // The hull is gone once the burning has run its course.
      this.group.visible = this.dying < 1.6;
      return [];
    }
    if (!this.engaged && anchor.distanceTo(ship.position) < BOSS.engageDistance)
      this.engaged = true;
    this.group.visible = true;
    this.#clock += dt;
    const rate = BOSS.sway.speed * (this.phase === 3 ? 1.7 : 1);
    this.group.position
      .copy(anchor)
      .addScaledVector(axes.right, this.engaged ? Math.sin(this.#clock * rate) * BOSS.sway.x : 0)
      .addScaledVector(
        axes.up,
        this.engaged ? Math.sin(this.#clock * rate * 1.7) * BOSS.sway.y : 0,
      );
    this.group.quaternion.setFromRotationMatrix(
      _basis.makeBasis(_left.copy(axes.right).negate(), axes.up, axes.forward),
    );
    this.group.updateMatrixWorld(true);
    for (const [index, pod] of this.pods.entries()) {
      const part = this.model.pods[index];
      if (part === undefined) continue;
      pod.position.setFromMatrixPosition(part.matrixWorld);
      part.visible = pod.hp > 0;
    }
    this.core.position.setFromMatrixPosition(this.model.core.matrixWorld);
    // The plates slide aside once the core is exposed.
    const open = this.podsLeft === 0 ? 3.4 : 0;
    const [plateA, plateB] = this.model.plates;
    plateA.position.x += (-1.35 - open - plateA.position.x) * Math.min(1, dt * 3);
    plateB.position.x += (1.35 + open - plateB.position.x) * Math.min(1, dt * 3);

    const fallen: IBossEvent[] = [];
    for (const point of [...this.pods, this.core]) {
      if (point.hp > 0 || point.reported) continue;
      point.reported = true;
      fallen.push({ at: point.position.clone(), score: point.score, core: point === this.core });
    }
    if (this.core.hp <= 0) {
      this.defeated = true;
      this.model.core.visible = false;
      return fallen;
    }
    if (this.engaged) this.#shoot(dt, ship, weapons);
    return fallen;
  }

  #shoot(dt: number, ship: IShipView, weapons: Weapons): void {
    for (const [index, pod] of this.pods.entries()) {
      if (pod.hp <= 0) continue;
      this.#fire[index] = (this.#fire[index] ?? 0) - dt;
      if ((this.#fire[index] ?? 0) > 0) continue;
      this.#fire[index] = BOSS.pod.interval;
      this.#volley(pod.position, ship, weapons, [0]);
    }
    if (this.phase < 2) return;
    this.#fireCore -= dt;
    if (this.#fireCore > 0) return;
    const rage = this.phase === 3;
    this.#fireCore = rage ? 0.9 : 1.6;
    this.#volley(this.core.position, ship, weapons, rage ? [-2, -1, 0, 1, 2] : [-1, 0, 1]);
  }

  #volley(from: Vector3, ship: IShipView, weapons: Weapons, spreads: readonly number[]): void {
    interceptDirection(from, ship.position, ship.velocity, ENEMY.shotSpeed, _aim);
    for (const spread of spreads)
      weapons.fireEnemy(
        from,
        _shot.copy(_aim).applyAxisAngle(UP, spread * 0.11),
        SHIELD.shotDamage,
      );
  }

  debug(): Record<string, unknown> {
    return {
      coreHp: this.core.hp,
      defeated: this.defeated,
      engaged: this.engaged,
      phase: this.phase,
      podsLeft: this.podsLeft,
    };
  }
}
