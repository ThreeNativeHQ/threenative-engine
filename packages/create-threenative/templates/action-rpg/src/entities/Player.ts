import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, type Object3D, Vector3 } from "three";
import { createSword } from "../render/props.js";
import type { ITouchInput } from "../render/touch-controls.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

export const WORLD_LAYER = 1;
export const PLAYER_LAYER = 2;
export const HOSTILE_LAYER = 4;

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  ability: "Spell_Simple_Shoot",
  attack: "Sword_Attack",
  death: "Death01",
  dodge: "Roll",
  hit: "Hit_Chest",
  idle: "Sword_Idle",
  pickup: "PickUp_Table",
  walk: "Jog_Fwd_Loop",
} as const;

const MOVE_SPEED = 4.8;
const DODGE_SPEED = 9;
/** Capsule for a 1.8 m figure: 0.38 m half-height plus a 0.34 m radius at each end. */
const HALF_HEIGHT = 0.38;
const RADIUS = 0.34;
/**
 * How long a swing, a cast and a roll keep the legs from taking over the clip. The swing and the
 * roll are fitted: their whole clip (`Sword_Attack` 1.53 s, `Roll` 1.47 s) plays inside the hold, so
 * the follow-through is never cut, and a new swing waits for it.
 */
const SWING = 0.8;
/** When the blade crosses the front of the figure in `Sword_Attack`, in clip seconds: the hand peaks at 0.40 s. */
const SWING_CONTACT = 0.4;
const CAST = 0.7;
const ROLL = 0.7;
const DODGE_COOLDOWN = 1;
const REACH = 0.9;

export class Player extends Fighter {
  readonly body: CharacterBody3D;
  readonly maxHealth = 100;
  health: number;
  dead = false;
  #bodyDisposed = false;
  #equippedItem = "";
  #sword: Object3D;
  /** The landing half of the swing in progress: damage waits for the blade, not the key. */
  #swing: { remaining: number; land: () => void } | undefined;
  #dodgeCooldown = 0;
  #dodgeRemaining = 0;
  #rollDirection = new Vector3();
  #rollDirectionChosen = false;
  #forward = new Vector3();
  #origin = new Vector3();
  #onDamage: (amount: number) => void;
  #onDeath: () => void;

  constructor(
    ctx: GameCtx,
    model: IMannequin,
    spawn: Vector3,
    health: number,
    onDamage: (amount: number) => void,
    onDeath: () => void,
  ) {
    const sword = createSword();
    super(ctx, model, CLIPS, { halfExtent: HALF_HEIGHT + RADIUS, weapon: sword });
    this.#sword = sword;
    this.equippedItem = "";
    this.health = Math.max(0, Math.min(this.maxHealth, health));
    this.mesh.position.copy(spawn);
    this.#onDamage = onDamage;
    this.#onDeath = onDeath;
    this.body = new CharacterBody3D({
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER | HOSTILE_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  update(ctx: GameCtx, dt: number, touch?: ITouchInput): void {
    if (this.dead) {
      this.animateStill(dt);
      return;
    }
    const move = ctx.input.vector("move");
    if (touch !== undefined) {
      move.x += touch.move.x;
      move.y += touch.move.y;
      move.clampLength(0, 1);
    }
    this.#dodgeCooldown = Math.max(0, this.#dodgeCooldown - dt);
    this.#dodgeRemaining = Math.max(0, this.#dodgeRemaining - dt);
    if (this.#dodgeRemaining > 0 && !this.#rollDirectionChosen) {
      this.#rollDirectionChosen = true;
      this.#rollDirection.set(move.x, 0, -move.y);
      if (this.#rollDirection.lengthSq() > 0.01) this.#rollDirection.normalize();
      else this.facingVector(this.#rollDirection);
      this.figure.rotation.y = Math.atan2(this.#rollDirection.x, this.#rollDirection.z);
    }
    const speed =
      this.#dodgeRemaining > 0 ? DODGE_SPEED * (this.#dodgeRemaining / ROLL) : MOVE_SPEED;
    if (this.#dodgeRemaining > 0)
      this.body.velocity.copy(this.#rollDirection).multiplyScalar(speed);
    else this.body.velocity.set(move.x * speed, 0, -move.y * speed);
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
    const heading = this.busy ? undefined : Math.atan2(this.body.velocity.x, this.body.velocity.z);
    this.animateRig(dt, heading, Math.hypot(this.body.velocity.x, this.body.velocity.z));
    const swing = this.#swing;
    if (swing === undefined) return;
    swing.remaining -= dt;
    if (swing.remaining > 0) return;
    this.#swing = undefined;
    // A cast or a roll that took the clip over took the blade with it.
    if (this.action === "attack") swing.land();
  }

  /** The hand holds the blade only while a weapon is equipped, so the figure and the HUD agree. */
  get equippedItem(): string {
    return this.#equippedItem;
  }

  set equippedItem(itemId: string) {
    this.#equippedItem = itemId;
    this.#sword.visible = itemId !== "";
  }

  /**
   * The swing, the cast and the roll: three inputs, three clips, one state machine. `land` runs
   * when the blade reaches the front of the figure; a press during a swing is ignored, so the
   * clip and the hits it deals stay one to one.
   */
  strike(land: () => void): boolean {
    if (this.dead || (this.action === "attack" && this.busy)) return false;
    const rate = this.play("attack", { fade: 0.05, fit: true, hold: SWING });
    this.#swing = { land, remaining: SWING_CONTACT / rate };
    return true;
  }

  cast(): void {
    this.play("ability", { fade: 0.08, hold: CAST });
  }

  dodge(): boolean {
    if (this.busy || this.#dodgeCooldown > 0) return false;
    this.#dodgeCooldown = DODGE_COOLDOWN;
    this.#dodgeRemaining = ROLL;
    this.#rollDirectionChosen = false;
    this.play("dodge", { fade: 0.05, hold: ROLL, fit: true });
    return true;
  }

  takeDamage(amount: number): void {
    if (this.dead || !Number.isFinite(amount) || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.#onDamage(amount);
    if (this.health > 0) {
      if (!this.busy) this.play("hit", { fade: 0.04, hold: 0.3 });
      return;
    }
    this.dead = true;
    // The body stops blocking the room, but the figure stays where it fell: the death clip is
    // the only feedback the run ending gets, and a body that blinks out hides it.
    this.#disposeBody();
    this.play("death", { fade: 0.05, hold: Number.POSITIVE_INFINITY });
    this.#onDeath();
  }

  /** Loot and a full bag both read the same way to the player: the figure bends to the floor. */
  pickup(): void {
    this.play("pickup", { fade: 0.08, hold: 0.5 });
  }

  /**
   * Where a swing lands, in world space: a metre out along the direction the figure is facing.
   * Written into a scratch vector the caller reads synchronously — this runs per attack, not per
   * frame, but the level it sits in allocates nothing.
   */
  attackOrigin(): Vector3 {
    this.facingVector(this.#forward);
    return this.#origin
      .copy(this.mesh.position)
      .addScaledVector(this.#forward, REACH)
      .setY(this.mesh.position.y + 0.8);
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      dead: this.dead,
      equippedItem: this.equippedItem,
      facingDegrees:
        Math.round(
          MathUtils.radToDeg(MathUtils.euclideanModulo(this.figure.rotation.y, Math.PI * 2)),
        ) % 360,
      groundClearance: this.conventions.groundSnap.clearance,
      health: this.health,
      normaliseFactor: this.conventions.normaliseFactor,
      position: this.mesh.position.toArray(),
      skeletonBones: this.conventions.boneNames,
      weaponBone: this.conventions.attachedBone,
      weaponVisible: this.#sword.visible,
    };
  }

  #disposeBody(): void {
    if (this.#bodyDisposed) return;
    this.#bodyDisposed = true;
    this.body.dispose();
  }

  dispose(): void {
    this.#disposeBody();
    this.mesh.removeFromParent();
  }
}
