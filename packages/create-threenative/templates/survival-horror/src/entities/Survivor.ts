import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, type Object3D, Vector3 } from "three";
import type { Inventory } from "../items.js";
import {
  Actor,
  type GameCtx,
  HALF_HEIGHT,
  HOSTILE_LAYER,
  type IMannequin,
  PLAYER_LAYER,
  RADIUS,
  WORLD_LAYER,
  headingTo,
  wrap,
} from "./Actor.js";

const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  aim: "Pistol_Aim_Neutral",
  aimUp: "Pistol_Aim_Up",
  aimDown: "Pistol_Aim_Down",
  shoot: "Pistol_Shoot",
  reload: "Pistol_Reload",
  hurt: "Hit_Chest",
  pickup: "PickUp_Table",
  death: "Death01",
} as const;

// Gaits, in m/s. Walk 1.4 and back 1.15 are the reference walk ceilings (silent-hill
// `walk-and-run-speed`); the run sits between its 3.5 slow-zone and 4.0 ordinary ceilings. The
// condition columns are this kit's: Caution loses the top of the run, Danger limps.
const GAIT = {
  fine: { walk: 1.4, back: 1.15, run: 3.6 },
  caution: { walk: 1.3, back: 1.05, run: 3 },
  danger: { walk: 0.85, back: 0.7, run: 1.7 },
} as const;
// Tank steering, rad/s. The reference body turn is 0.0418879 rad per 30 Hz update, 1.26 rad/s
// (resident-evil-4 `locomotion-walk`); a keyboard is all-or-nothing, so this kit turns 1.6x that.
// Running turns 1.1x faster (`locomotion-run`) and a raised gun 5/7 of the walk (silent-hill
// `steering-rate`: 5 aiming against 7 walking), which is why aiming feels heavy.
const TURN_WALK = 2;
const TURN_RUN = TURN_WALK * 1.1;
const TURN_AIM = (TURN_WALK * 5) / 7;
/** How fast the raised gun swings onto the auto-target, rad/s. */
const TURN_LOCK = 7;
/** Half a turn in half a second: the quick turn the third classic game added (down + run). */
const QUICK_TURN_TIME = 0.5;
/** The gun comes up before it can fire. */
const RAISE_TIME = 0.2;
/** Seconds between shots: one press, one round, about two a second. */
const FIRE_INTERVAL = 0.5;
export const MAGAZINE = 15;
/** After a release the zombie that held you cannot take you again at once. */
const GRAB_IMMUNITY = 1.2;

export type Condition = "fine" | "caution" | "danger";
export type AimPitch = "neutral" | "up" | "down";
export type SurvivorState = "free" | "aim" | "quickturn" | "reload" | "held" | "busy" | "dead";

/** What the scene reads off the keyboard this frame, after menus took what they needed. */
export interface ISurvivorInput {
  readonly forward: number;
  readonly turn: number;
  readonly run: boolean;
  readonly runPressed: boolean;
  readonly backPressed: boolean;
  readonly aim: boolean;
  readonly fire: boolean;
  readonly reload: boolean;
}

/** Something the gun can point at. */
export interface ITarget {
  readonly mesh: Object3D;
}

export interface ISurvivorHooks {
  /** The best target in front of the gun for this pitch, or none. */
  readonly acquire: (pitch: AimPitch) => ITarget | undefined;
  /** Whether a held target can still be shot at this pitch: a body that fell is lost to a level gun. */
  readonly keeps: (target: ITarget, pitch: AimPitch) => boolean;
  /** A round left the barrel. The scene resolves what it hit. */
  readonly shot: (pitch: AimPitch, target: ITarget | undefined) => void;
  /** The trigger clicked on an empty gun with nothing to reload. */
  readonly dry: () => void;
  readonly hurt: (amount: number) => void;
  readonly died: () => void;
}

export function conditionOf(health: number): Condition {
  return health > 66 ? "fine" : health > 33 ? "caution" : "danger";
}

export class Survivor extends Actor {
  readonly body: CharacterBody3D;
  readonly maxHealth = 100;
  health: number;
  magazine: number;
  state: SurvivorState = "free";
  pitch: AimPitch = "neutral";
  target: ITarget | undefined;
  /** What holds the survivor while `state` is `"held"`. */
  holder: ITarget | undefined;
  speed = 0;
  running = false;
  shots = 0;
  reloads = 0;
  quickTurns = 0;
  #timer = 0;
  #fireCooldown = 0;
  #immunity = 0;
  #quickTurnFrom = 0;
  #hooks: ISurvivorHooks;
  #inventory: Inventory;
  #forward = new Vector3();

  constructor(
    ctx: GameCtx,
    model: IMannequin,
    weapon: Object3D,
    inventory: Inventory,
    hooks: ISurvivorHooks,
    spawn: {
      readonly position: Vector3;
      readonly heading: number;
      readonly health: number;
      readonly magazine: number;
    },
  ) {
    super(ctx, model, Object.values(CLIPS), { weapon });
    this.#hooks = hooks;
    this.#inventory = inventory;
    this.health = spawn.health;
    this.magazine = spawn.magazine;
    this.heading = spawn.heading;
    this.mesh.position.copy(spawn.position);
    this.play(CLIPS.idle, { fade: 0 });
    this.body = new CharacterBody3D({
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER | HOSTILE_LAYER,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  get condition(): Condition {
    return conditionOf(this.health);
  }

  get reserve(): number {
    return this.#inventory.count("ammo");
  }

  get dead(): boolean {
    return this.state === "dead";
  }

  /** A zombie may take hold only of a free survivor it has not just let go of. */
  get grabbable(): boolean {
    return this.#immunity <= 0 && this.state !== "dead" && this.state !== "held";
  }

  /** Teleport through a door: the body, the heading, and nothing still in motion. */
  place(position: Vector3, heading: number): void {
    this.body.teleport(position);
    this.body.velocity.set(0, 0, 0);
    this.heading = heading;
    // A moment to see the room before anything waiting at the door can take hold.
    this.#immunity = GRAB_IMMUNITY;
    if (this.state !== "dead") this.#toFree();
  }

  update(ctx: GameCtx, dt: number, input: ISurvivorInput): void {
    this.#fireCooldown = Math.max(0, this.#fireCooldown - dt);
    this.#immunity = Math.max(0, this.#immunity - dt);
    this.#timer -= dt;
    // Footsteps are heard only while the survivor is actually running; `#free` sets it again.
    this.running = false;
    let speed = 0;
    switch (this.state) {
      case "free":
        speed = this.#free(dt, input);
        break;
      case "aim":
        this.#aim(dt, input);
        break;
      case "quickturn": {
        const progress = MathUtils.clamp(1 - this.#timer / QUICK_TURN_TIME, 0, 1);
        this.heading = wrap(this.#quickTurnFrom + Math.PI * MathUtils.smoothstep(progress, 0, 1));
        if (this.#timer <= 0) this.#toFree();
        break;
      }
      case "reload":
        if (this.#timer <= 0) {
          this.magazine += this.#inventory.take("ammo", MAGAZINE - this.magazine);
          this.reloads += 1;
          this.#toFree();
        }
        break;
      case "held":
        if (this.holder !== undefined)
          this.turnToward(headingTo(this.mesh.position, this.holder.mesh.position), TURN_LOCK, dt);
        break;
      case "busy":
        if (this.#timer <= 0) this.#toFree();
        break;
      case "dead":
        break;
    }
    this.speed = Math.abs(speed);
    this.facingVector(this.#forward);
    this.body.velocity.x = this.#forward.x * speed;
    this.body.velocity.z = this.#forward.z * speed;
    if (this.state !== "dead") this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
    this.animate(dt);
  }

  #free(dt: number, input: ISurvivorInput): number {
    if (input.aim) {
      this.state = "aim";
      this.#timer = RAISE_TIME;
      this.pitch = pitchOf(input.forward);
      this.target = this.#hooks.acquire(this.pitch);
      this.#playAim();
      return 0;
    }
    if (input.reload && this.#startReload()) return 0;
    // Down + run, in either order, is the quick turn.
    if (input.forward < -0.5 && (input.runPressed || (input.run && input.backPressed))) {
      this.state = "quickturn";
      this.#timer = QUICK_TURN_TIME;
      this.#quickTurnFrom = this.heading;
      this.quickTurns += 1;
      this.play(CLIPS.idle, { fade: 0.1 });
      return 0;
    }
    const gait = GAIT[this.condition];
    this.running = input.run && input.forward > 0.5;
    if (input.turn !== 0)
      this.heading = wrap(this.heading - input.turn * (this.running ? TURN_RUN : TURN_WALK) * dt);
    const speed =
      input.forward > 0.1
        ? this.running
          ? gait.run
          : gait.walk
        : input.forward < -0.1
          ? -gait.back
          : 0;
    this.play(speed === 0 ? CLIPS.idle : this.running ? CLIPS.run : CLIPS.walk, { fade: 0.2 });
    return speed;
  }

  #aim(dt: number, input: ISurvivorInput): void {
    if (!input.aim) {
      this.#toFree();
      return;
    }
    if (input.reload && this.#startReload()) return;
    const pitch = pitchOf(input.forward);
    if (this.target !== undefined && !this.#hooks.keeps(this.target, pitch)) {
      // The lock moves on when its target falls, dies or gets up: the next one in the cone.
      this.target = this.#hooks.acquire(pitch);
    }
    if (pitch !== this.pitch) {
      this.pitch = pitch;
      // A new pitch searches again: aiming low is how a body on the floor is found.
      this.target = this.#hooks.acquire(pitch);
      this.#playAim();
    }
    if (input.turn !== 0) {
      // Turning by hand lets go of the lock, as the classic auto-aim did.
      this.target = undefined;
      this.heading = wrap(this.heading - input.turn * TURN_AIM * dt);
    } else if (this.target !== undefined) {
      this.turnToward(headingTo(this.mesh.position, this.target.mesh.position), TURN_LOCK, dt);
    }
    if (this.#timer <= 0 && this.clip === CLIPS.shoot && this.#fireCooldown < FIRE_INTERVAL * 0.4)
      this.#playAim();
    if (!input.fire || this.#timer > 0 || this.#fireCooldown > 0) return;
    if (this.magazine === 0) {
      // An empty gun reloads itself when there is ammunition in the case, and clicks when not.
      if (!this.#startReload()) {
        this.#fireCooldown = FIRE_INTERVAL;
        this.#hooks.dry();
      }
      return;
    }
    this.magazine -= 1;
    this.shots += 1;
    this.#fireCooldown = FIRE_INTERVAL;
    this.play(CLIPS.shoot, { fade: 0.04, mode: "once", restart: true });
    this.#hooks.shot(this.pitch, this.target);
  }

  #startReload(): boolean {
    if (this.magazine >= MAGAZINE || this.reserve === 0) return false;
    this.state = "reload";
    // The whole clip plays: a reload cut short is a reload the player did not see finish.
    this.#timer = this.duration(CLIPS.reload);
    this.play(CLIPS.reload, { fade: 0.08, mode: "once", restart: true });
    return true;
  }

  #playAim(): void {
    const clip =
      this.pitch === "up" ? CLIPS.aimUp : this.pitch === "down" ? CLIPS.aimDown : CLIPS.aim;
    this.play(clip, { fade: 0.1, mode: "once" });
  }

  #toFree(): void {
    this.state = "free";
    this.target = undefined;
    this.holder = undefined;
    this.pitch = "neutral";
    this.play(CLIPS.idle, { fade: 0.2 });
  }

  /** A picked-up item: the figure bends to the table and cannot move until it has. */
  pickup(): void {
    if (this.state !== "free") return;
    this.state = "busy";
    this.#timer = this.duration(CLIPS.pickup);
    this.play(CLIPS.pickup, { fade: 0.08, mode: "once", restart: true });
  }

  /** A zombie took hold. The scene passes it; `release` gives the survivor back. */
  grab(holder: ITarget): void {
    if (!this.grabbable) return;
    this.state = "held";
    this.holder = holder;
    this.target = undefined;
    this.play(CLIPS.hurt, { fade: 0.05, mode: "once", restart: true });
  }

  release(): void {
    if (this.state !== "held") return;
    this.#immunity = GRAB_IMMUNITY;
    this.#toFree();
  }

  /** Recoil of a struggle press: the body jerks against the hold. */
  struggle(): void {
    if (this.state === "held") this.play(CLIPS.hurt, { fade: 0.03, mode: "once", restart: true });
  }

  takeDamage(amount: number): void {
    if (this.state === "dead" || !(amount > 0)) return;
    this.health = Math.max(0, this.health - amount);
    this.#hooks.hurt(amount);
    if (this.health > 0) {
      this.play(CLIPS.hurt, { fade: 0.04, mode: "once", restart: true });
      return;
    }
    this.state = "dead";
    this.holder = undefined;
    this.body.velocity.set(0, 0, 0);
    this.play(CLIPS.death, { fade: 0.08, mode: "once" });
    this.#hooks.died();
  }

  heal(amount: number): void {
    if (this.state !== "dead") this.health = Math.min(this.maxHealth, this.health + amount);
  }

  debug(): Record<string, unknown> {
    return {
      action: this.clip,
      animation: this.animation,
      condition: this.condition,
      groundClearance: this.conventions.groundSnap.clearance,
      headingDegrees:
        Math.round(MathUtils.radToDeg(MathUtils.euclideanModulo(this.heading, Math.PI * 2))) % 360,
      health: this.health,
      magazine: this.magazine,
      normaliseFactor: this.conventions.normaliseFactor,
      pitch: this.pitch,
      position: this.mesh.position.toArray(),
      quickTurns: this.quickTurns,
      reloads: this.reloads,
      reserve: this.reserve,
      running: this.running,
      shots: this.shots,
      speed: Math.round(this.speed * 100) / 100,
      state: this.state,
      targeted: this.target !== undefined,
      weaponBone: this.conventions.attachedBone,
    };
  }
}

function pitchOf(forward: number): AimPitch {
  return forward > 0.5 ? "up" : forward < -0.5 ? "down" : "neutral";
}
