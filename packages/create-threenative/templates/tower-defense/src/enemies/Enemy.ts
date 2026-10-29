import { type IPathFollow3DSample, PathFollow3D } from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { Group, type Mesh, type Quaternion, Vector3 } from "three";
import { ENEMIES, type EnemyKind } from "../balance.js";
import { ENEMY_LAYER } from "../physics.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { palette } from "../render/palette.js";
import { enemy as enemyModel, healthBar } from "../render/shapes.js";

/** Where a parked enemy waits: far below the board, where no tower's query can find it. */
const PARKED = new Vector3(0, -80, 0);
/** Bastion's sizes read small from this far back, so every walker is drawn twice as large. */
const SIZE = 2;

/**
 * One walker. Built once per pool slot and reused: `reset` puts it back on the road at full health,
 * and dying or reaching the reactor parks it out of every range query. It follows the same
 * `PathFollow3D` curve the road is drawn from, so the enemy can never leave the road it is drawn on.
 */
export class Enemy {
  readonly entityId: string;
  readonly kind: EnemyKind;
  /** The root: position only. The model inside it turns to face the road. */
  readonly mesh = new Group();
  readonly tags = ["enemy", "hostile"];
  id: string;
  /** Where it fell, kept because it is parked the same instant. */
  readonly deathPoint = new Vector3();
  hp = 0;
  maxHp = 0;
  readonly #body: RigidBody3D;
  readonly #model: Group;
  readonly #legs: readonly Mesh[];
  readonly #bar: ReturnType<typeof healthBar>;
  readonly #path: PathFollow3D;
  readonly #sample: IPathFollow3DSample = {
    point: new Vector3(),
    progress: 0,
    tangent: new Vector3(0, 0, 1),
  };
  readonly #onDefeated: (enemy: Enemy) => void;
  readonly #onLeak: (enemy: Enemy) => void;
  #dead = true;
  #escaped = false;
  #slow = 1;
  #slowTimer = 0;
  #phase = 0;

  constructor(options: {
    readonly id: string;
    readonly kind: EnemyKind;
    readonly points: readonly Vector3[];
    readonly physics: IPhysicsContext;
    readonly onDefeated: (enemy: Enemy) => void;
    readonly onLeak: (enemy: Enemy) => void;
  }) {
    this.entityId = options.id;
    this.id = options.id;
    this.kind = options.kind;
    this.#onDefeated = options.onDefeated;
    this.#onLeak = options.onLeak;
    const definition = ENEMIES[options.kind];
    this.#path = new PathFollow3D({ points: options.points, speed: definition.speed });
    const model = enemyModel(options.kind);
    this.#model = model.group;
    this.#legs = model.legs;
    this.#model.scale.setScalar(definition.scale * SIZE);
    this.mesh.add(this.#model);
    this.#bar = healthBar(options.kind === "titan" ? 2.1 : 1.25);
    this.#bar.group.position.y = 1.35 * definition.scale * SIZE + 0.45;
    this.#bar.group.visible = false;
    this.mesh.add(this.#bar.group);
    this.mesh.visible = false;
    this.mesh.position.copy(PARKED);
    this.#body = new RigidBody3D({
      collisionLayer: ENEMY_LAYER,
      collisionMask: 0,
      entity: this.entityId,
      object: this.mesh,
      physics: options.physics,
      shape: CollisionShape3D.sphere(0.5 * definition.scale * SIZE),
      type: "kinematic",
    });
  }

  get dead(): boolean {
    return this.#dead;
  }

  get escaped(): boolean {
    return this.#escaped;
  }

  /** On the road and fighting: neither killed nor arrived. */
  get active(): boolean {
    return !this.#dead && !this.#escaped;
  }

  /** Metres walked along the road. "First" targeting is the largest of these. */
  get progress(): number {
    return this.#path.progress;
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  get chilled(): boolean {
    return this.#slow < 1;
  }

  reset(id: string, hp: number): void {
    this.id = id;
    this.hp = this.maxHp = hp;
    this.#dead = false;
    this.#escaped = false;
    this.#slow = 1;
    this.#slowTimer = 0;
    this.#phase = 0;
    this.#path.progressTo(0);
    this.#bar.group.visible = false;
    this.#bar.fill.scale.x = 1;
    // A walker that died chilled comes back unchilled, so its bar must lose the chill tint too.
    this.#bar.fillMaterial.color.setHex(palette.effects.barFull);
    this.mesh.visible = true;
    this.#place(this.#path.sample(0, this.#sample));
  }

  takeDamage(amount: number): void {
    if (!this.active) return;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enemy damage must be positive.");
    this.hp = Math.max(0, this.hp - amount);
    this.#bar.group.visible = true;
    this.#bar.fill.scale.x = this.hp / this.maxHp;
    if (this.hp > 0) return;
    this.#dead = true;
    this.deathPoint.copy(this.mesh.position).setY(0.5);
    this.#retire();
    this.#onDefeated(this);
    emitPlaytestEvent({ entity: this.id, name: "defeated" });
  }

  /** Slows the walker to `multiplier` of its speed for `seconds`. The strongest chill wins. */
  chill(multiplier: number, seconds: number): void {
    if (!this.active) return;
    this.#slow = this.#slowTimer > 0 ? Math.min(this.#slow, multiplier) : multiplier;
    this.#slowTimer = seconds;
    this.#bar.fillMaterial.color.setHex(palette.effects.barChilled);
  }

  /** Turns the health bar to face the camera. The root never rotates, so the camera's own turn is right. */
  faceCamera(quaternion: Quaternion): void {
    this.#bar.group.quaternion.copy(quaternion);
  }

  update(dt: number): void {
    if (!this.active) return;
    if (this.#slowTimer > 0) {
      this.#slowTimer -= dt;
      if (this.#slowTimer <= 0) {
        this.#slow = 1;
        this.#bar.fillMaterial.color.setHex(palette.effects.barFull);
      }
    }
    this.#path.speed = ENEMIES[this.kind].speed * this.#slow;
    this.#place(this.#path.advance(dt, this.#sample));
    this.#phase += dt * this.#path.speed * 5;
    for (const [index, leg] of this.#legs.entries())
      leg.scale.y = 1 + 0.18 * Math.sin(this.#phase + (index % 2) * Math.PI);
    if (!this.#path.completed) return;
    this.#escaped = true;
    this.#retire();
    this.#onLeak(this);
    emitPlaytestEvent({ entity: this.id, name: "leaked" });
  }

  /** The bar wears the chill tint exactly while the walker is chilled. */
  get barTintMatches(): boolean {
    const tinted = this.#bar.fillMaterial.color.getHex() === palette.effects.barChilled;
    return tinted === this.chilled;
  }

  debug(): Record<string, unknown> {
    return {
      barTintMatches: this.barTintMatches,
      hp: this.hp,
      kind: this.kind,
      position: this.mesh.position.toArray(),
      progress: this.#path.progress,
    };
  }

  dispose(): void {
    this.#body.dispose();
    this.mesh.removeFromParent();
  }

  #retire(): void {
    this.mesh.visible = false;
    this.mesh.position.copy(PARKED);
  }

  #place(sample: IPathFollow3DSample): void {
    this.mesh.position.copy(sample.point).setY(0);
    this.#model.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
  }
}
