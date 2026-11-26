import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, Vector3 } from "three";
import { CLASS_ATTACK, type IStats } from "../content.js";
import type { IActorSpec, Team } from "../level.js";
import { createWeapon, dress } from "../render/props.js";
import { abilityModifier, defenseOf } from "../rules/d20.js";
import { ActionQueue } from "../rules/queue.js";
import { type Skills, meleeBonus, newSkills, runSpeed, walkSpeed } from "../rules/skills.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

export const WORLD_LAYER = 1;
export const ACTOR_LAYER = 2;

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  attack: "Sword_Attack",
  death: "Death01",
  heal: "Interact",
  hit: "Hit_Chest",
  idle: "Idle_Loop",
  ready: "Sword_Idle",
  run: "Jog_Fwd_Loop",
  walk: "Walk_Loop",
} as const;

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
/** How long a swing keeps the legs from taking the rig over. `Sword_Attack` is fitted into it. */
export const SWING_HOLD = 0.8;
const FLINCH = 0.3;

/** What a round needs to know about whoever it hits: a person, or a placeable like the post. */
export interface ICombatant {
  readonly id: string;
  readonly name: string;
  readonly team: Team | "object";
  readonly position: Vector3;
  readonly defense: number;
  readonly alive: boolean;
  receiveDamage(amount: number): void;
}

export type ActorState = "idle" | "move" | "swing" | "down";

export class Actor extends Fighter implements ICombatant {
  readonly id: string;
  readonly name: string;
  /** The dialogue tree a talk opens; "" for someone with nothing to say. */
  readonly treeId: string;
  team: Team;
  readonly stats: IStats;
  readonly skills: Skills;
  readonly queue = new ActionQueue();
  readonly body: CharacterBody3D;
  hp: number;
  state: ActorState = "idle";
  /** Metres run since the last Athletics gain was collected. */
  runMetres = 0;
  /** What the actor is doing this tick; "running" when it moves at run speed. */
  running = false;
  /** Set by every move or rest; the scene rests whoever did neither, so each rig advances once a tick. */
  acted = false;
  /** True from the moment a round holds the actor in place until it ends. */
  locked = false;
  readonly #from = new Vector3();

  constructor(ctx: GameCtx, model: IMannequin, spec: IActorSpec, stats: IStats) {
    super(ctx, model, CLIPS, {
      halfExtent: HALF_HEIGHT + RADIUS,
      facing: spec.yaw,
      ...(stats.weapon.dice === 0 ? {} : { weapon: createWeapon(stats.weapon.name) }),
    });
    this.id = spec.id;
    this.name = spec.name;
    this.treeId = spec.tree ?? "";
    this.team = spec.team;
    this.stats = stats;
    this.skills = newSkills(stats.skills);
    this.hp = stats.maxHp;
    dress(this.character.root, spec.tint);
    this.mesh.position.set(spec.x, HALF_HEIGHT + RADIUS, spec.z);
    this.body = new CharacterBody3D({
      collisionLayer: ACTOR_LAYER,
      collisionMask: WORLD_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  get alive(): boolean {
    return this.state !== "down";
  }

  get maxHp(): number {
    return this.stats.maxHp;
  }

  /** The d20 defense: ten plus the Dexterity modifier. */
  get defense(): number {
    return defenseOf(this.stats.abilities);
  }

  /** Class table plus the Strength modifier plus one per ten Melee points. */
  get attackBonus(): number {
    return (
      (CLASS_ATTACK[this.stats.level - 1] ?? 0) +
      abilityModifier(this.stats.abilities.str) +
      meleeBonus(this.skills)
    );
  }

  get damageModifier(): number {
    return abilityModifier(this.stats.abilities.str);
  }

  /** Run speed in metres per second, from the Speed attribute and the Athletics skill. */
  get runSpeed(): number {
    return runSpeed(this.stats.speed, this.skills.athletics.level);
  }

  get walkSpeed(): number {
    return walkSpeed(this.stats.speed);
  }

  /** Skill levels, read by the playtests by name. */
  get melee(): number {
    return this.skills.melee.level;
  }

  get athletics(): number {
    return this.skills.athletics.level;
  }

  get persuasion(): number {
    return this.skills.persuasion.level;
  }

  /** The first queued action, as a short word, for the playtest. */
  get queued(): string {
    return this.queue.labels[0] ?? "";
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** The clip family the rig idles in: weapons up while a fight is on. */
  setStance(inCombat: boolean): void {
    this.idleAction = inCombat && this.team !== "villager" ? "ready" : "idle";
  }

  /** Turn to face a point. */
  face(x: number, z: number, dt: number): void {
    const dx = x - this.mesh.position.x;
    const dz = z - this.mesh.position.z;
    if (Math.hypot(dx, dz) < 0.05) return;
    const turn = MathUtils.euclideanModulo(
      Math.atan2(dx, dz) - this.figure.rotation.y + Math.PI,
      Math.PI * 2,
    );
    this.figure.rotation.y += (turn - Math.PI) * Math.min(1, dt * 10);
  }

  /** Walk or run toward a point. Returns the metres left. A locked or fallen actor stays put. */
  stepToward(x: number, z: number, run: boolean, dt: number): number {
    this.acted = true;
    const dx = x - this.mesh.position.x;
    const dz = z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    if (!this.alive || this.locked || distance < 1e-3) {
      this.rest(dt);
      return distance;
    }
    const speed = Math.min(run ? this.runSpeed : this.walkSpeed, distance / dt);
    this.#from.copy(this.mesh.position);
    this.body.velocity.set((dx / distance) * speed, 0, (dz / distance) * speed);
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
    const moved = Math.hypot(
      this.mesh.position.x - this.#from.x,
      this.mesh.position.z - this.#from.z,
    );
    this.running = run;
    this.state = "move";
    if (run) this.runMetres += moved;
    this.walkAction = run ? "run" : "walk";
    this.animateRig(dt, Math.atan2(dx, dz), speed);
    return distance;
  }

  /** Stand still: the locomotion clip falls back to idle, or the swing finishes. */
  rest(dt: number): void {
    this.acted = true;
    if (!this.alive) {
      this.animateStill(dt);
      return;
    }
    this.body.velocity.set(0, 0, 0);
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
    this.running = false;
    if (this.state === "move") this.state = "idle";
    this.animateRig(dt, undefined, 0);
  }

  swing(): void {
    this.state = "swing";
    this.play("attack", { fade: 0.08, fit: true, hold: SWING_HOLD });
  }

  heal(): void {
    this.play("heal", { fade: 0.1, hold: 1 });
  }

  /** Called once per tick before locomotion: a finished swing returns the actor to idle. */
  settle(): void {
    if (this.state === "swing" && !this.busy) this.state = "idle";
  }

  receiveDamage(amount: number): void {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp > 0) {
      if (!this.busy) this.play("hit", { fade: 0.05, hold: FLINCH });
      return;
    }
    this.fall();
  }

  restore(amount: number): void {
    if (this.alive) this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** Down for good: the collider goes, so the body is not an invisible wall. */
  fall(): void {
    this.hp = 0;
    this.state = "down";
    this.locked = false;
    this.queue.clear();
    this.body.dispose();
    this.play("death", { fade: 0.05, hold: Number.POSITIVE_INFINITY });
  }
}
