import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, type Mesh, type Object3D, Vector3 } from "three";
import type { AlertDirector } from "../ai/phase.js";
import {
  CLOSE_SENSE,
  type ClearLine,
  EYE_HEIGHT,
  GUARD_HALF_ANGLE,
  GUARD_RANGE,
  type ITarget,
  type IViewer,
  type NoiseBus,
  SUSPICION_DECAY,
  SUSPICION_RISE,
  SUSPICIOUS_AT,
  angleBetween,
  sightStrength,
} from "../ai/perception.js";
import { COMPOUND, type Patrol } from "../level.js";
import {
  RIFLE_HOLD,
  createMoodMarker,
  createRifle,
  createTracer,
  createViewCone,
  dress,
  guardMaterial,
  tintViewCone,
} from "../render/props.js";
import type { AlertPhase } from "../state.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

export const WORLD_LAYER = 1;
export const PLAYER_LAYER = 2;
export const GUARD_LAYER = 4;

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  check: "Interact",
  down: "Death01",
  hit: "Hit_Head",
  idle: "Rifle_Idle",
  shoot: "Rifle_Shoot",
  walk: "Rifle_Walk",
} as const;

export type GuardState =
  | "patrol"
  | "suspicious"
  | "investigate"
  | "alert"
  | "search"
  | "held"
  | "down"
  | "checkBody";

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const PATROL_SPEED = 1.4;
/** Caution patrols walk faster and look wider: the base knows something is up. */
const CAUTION_SPEED = 2;
const CAUTION_ANGLE = 1.2;
const ALERT_SPEED = 3.4;
/** How fast a guard turns its head and body in place, radians per second. */
const TURN_RATE = 4;
/** Seconds a suspicious guard stares at the point of interest before walking over. */
const STARE_TIME = 1.2;
/** Seconds it looks around once it arrives. */
const LOOK_TIME = 3;
/** Alert fire: one burst every this many seconds while it has a line of sight within reach. */
const FIRE_INTERVAL = 0.75;
/** Guards fire inside this reach and close in from farther out; within the 10 m sight range. */
const FIRE_RANGE = 9;
const SHOT_DAMAGE = 9;
/** Hit chance at point blank and at `FIRE_RANGE`; a moving target halves it. */
const HIT_NEAR = 0.7;
const HIT_FAR = 0.2;
/**
 * The choke hold. Reference: metal-gear-solid-1 `choke-chain` — a hold lives 90 frames (3 s at
 * 30 Hz) unless pumped, a release grace of 9 frames, ten chokes to finish. A starter kit knocks out
 * instead of killing, and five pumps are enough to read as a struggle.
 */
export const HOLD_TIME = 3;
export const PUMPS_TO_KNOCK_OUT = 5;
/** Seconds a knocked-out guard stays down before it wakes and walks back to its route. */
export const KNOCKOUT_TIME = 40;
/** How far a search point may fall from the last known position, metres. */
const SEARCH_RADIUS = 5;
/** Walking that covers less than this share of its intended distance counts as blocked. */
const STUCK_PROGRESS = 0.25;
/** Seconds of blocked walking before the guard gives up on the point and treats it as reached. */
const STUCK_TIME = 1.5;
/** Within this angle of the player the guard fires; wider, it turns first. */
const AIM_TOLERANCE = 0.25;
/** Seconds a shot's tracer stays on screen. */
const TRACER_TIME = 0.07;

export interface IGuardHooks {
  readonly clear: ClearLine;
  /** A shot landed on the player. */
  readonly hitPlayer: (damage: number) => void;
  /** Deterministic randomness from the game's seed. */
  readonly random: () => number;
}

export class Guard extends Fighter {
  readonly id: string;
  readonly cone: Mesh;
  readonly tags = ["guard", "hostile"];
  state: GuardState = "patrol";
  /** 0..1: how sure this guard is that someone is there. 1 means seen. */
  suspicion = 0;
  /** This tick's sight strength on the player, 0..1. */
  sight = 0;
  /** Shots this guard fired and hits it scored, for the HUD and the playtests. */
  shots = 0;
  hits = 0;
  #route: Patrol["route"];
  #routeIndex = 0;
  #pause = 0;
  #lookBase = 0;
  #timer = 0;
  #fireTimer = FIRE_INTERVAL;
  readonly #interest = new Vector3();
  readonly #eye = new Vector3();
  readonly #toward = new Vector3();
  readonly #lastPosition = new Vector3();
  #lastStep = 0;
  #stuck = 0;
  /** True on the tick `#walkTo` gave up on an unreachable point. */
  #blocked = false;
  readonly #tracer = createTracer();
  #tracerTimer = 0;
  readonly #marker = createMoodMarker();
  #rifle: Object3D;
  #downTimer = 0;
  #bodyTarget: Guard | undefined;
  #hooks: IGuardHooks;
  #heldClip = "";
  #caution = false;
  /** How many downed guards this one has found. */
  bodiesFound = 0;

  constructor(ctx: GameCtx, model: IMannequin, patrol: Patrol, hooks: IGuardHooks) {
    const rifle = createRifle();
    super(ctx, model, CLIPS, { halfExtent: HALF_HEIGHT + RADIUS, weapon: rifle });
    this.#rifle = rifle;
    this.id = patrol.id;
    this.#route = patrol.route;
    this.#hooks = hooks;
    dress(this.character.root, guardMaterial);
    const start = patrol.route[0];
    if (start === undefined) throw new Error(`Patrol ${patrol.id} has no points.`);
    this.mesh.position.set(start.x, HALF_HEIGHT + RADIUS, start.z);
    this.#routeIndex = patrol.route.length > 1 ? 1 : 0;
    this.#face(this.#routeIndex);
    this.cone = createViewCone(GUARD_RANGE, GUARD_HALF_ANGLE);
    this.figure.add(this.cone);
    // The cone lies on the floor: cancel both the body's height and the figure's own drop.
    this.cone.position.y = 0.03 - (HALF_HEIGHT + RADIUS) - this.figure.position.y;
    this.#marker.root.position.y = 2.15;
    this.mesh.add(this.#marker.root);
    this.#ctx = ctx;
    this.#body = this.#createBody();
    ctx.add(this.#tracer.line);
  }

  #ctx: GameCtx;
  #body: CharacterBody3D | undefined;

  /**
   * The capsule. A knocked-out guard has none — a standing collider over a body on the floor is an
   * invisible wall — and gets a new one when it wakes.
   */
  get body(): CharacterBody3D {
    this.#body ??= this.#createBody();
    return this.#body;
  }

  #createBody(): CharacterBody3D {
    return new CharacterBody3D({
      collisionLayer: GUARD_LAYER,
      collisionMask: WORLD_LAYER | PLAYER_LAYER | GUARD_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: this.#ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  /** Facing yaw, three.js convention (0 faces +z). */
  get yaw(): number {
    return this.figure.rotation.y;
  }

  get halfAngle(): number {
    return this.#caution ? GUARD_HALF_ANGLE * CAUTION_ANGLE : GUARD_HALF_ANGLE;
  }

  readonly #view = {
    closeSense: CLOSE_SENSE,
    eye: this.#eye,
    halfAngle: 0,
    range: GUARD_RANGE,
    yaw: 0,
  };

  #viewer(): IViewer {
    this.#view.halfAngle = this.halfAngle;
    this.#view.yaw = this.yaw;
    return this.#view;
  }

  get conscious(): boolean {
    return this.state !== "down" && this.state !== "held";
  }

  /**
   * One tick. `phase` is the base-wide phase the director holds; `others` are the rest of the
   * guards, so this one can notice a body on the floor.
   */
  update(
    ctx: GameCtx,
    dt: number,
    player: ITarget,
    director: AlertDirector,
    phase: AlertPhase,
    noises: NoiseBus,
    others: readonly Guard[],
  ): void {
    this.#caution = phase === "caution";
    if (this.state === "down") {
      this.#downTimer -= dt;
      if (this.#downTimer <= 0) this.#wake();
      this.#present(dt, 0);
      return;
    }
    if (this.state === "held") {
      this.#present(dt, 0);
      return;
    }

    this.#eye.copy(this.mesh.position);
    this.#eye.y = EYE_HEIGHT;
    this.sight = sightStrength(this.#viewer(), player, this.#hooks.clear);

    // React to the base-wide phase first: an alert pulls every conscious guard in.
    if (phase === "alert" && this.state !== "alert") {
      this.state = "alert";
      this.#bodyTarget = undefined;
    } else if (phase === "evasion" && (this.state === "alert" || this.state === "patrol")) {
      // Evasion is base-wide: every guard on patrol searches the last known spot, including a
      // body that was just kicked awake. A guard already checking a noise finishes that first.
      this.#startSearch(director);
    } else if (
      (phase === "caution" || phase === "infiltration") &&
      (this.state === "alert" || this.state === "search")
    ) {
      this.#returnToRoute();
    }

    if (this.sight > 0) {
      const rise = SUSPICION_RISE * this.sight * dt * (this.#caution ? 1.3 : 1);
      this.suspicion = Math.min(1, this.suspicion + rise);
      this.#interest.copy(player.position);
    } else {
      this.suspicion = Math.max(0, this.suspicion - SUSPICION_DECAY * dt);
    }
    if (this.suspicion >= 1 || (this.state === "alert" && this.sight > 0)) {
      this.suspicion = 1;
      director.spotted(player.position.x, player.position.z);
      if (this.state !== "alert") this.state = "alert";
    } else if (
      this.suspicion >= SUSPICIOUS_AT &&
      (this.state === "patrol" || this.state === "search")
    ) {
      this.#becomeSuspicious(this.#interest);
    }

    if (this.state !== "alert") {
      for (const noise of noises.noises) {
        const distance = Math.hypot(noise.x - this.mesh.position.x, noise.z - this.mesh.position.z);
        if (distance > noise.radius) continue;
        this.suspicion = Math.max(this.suspicion, SUSPICIOUS_AT);
        this.#becomeSuspicious(this.#toward.set(noise.x, 0, noise.z));
      }
      if (this.state !== "checkBody") this.#lookForBodies(others);
    }

    let speed = 0;
    switch (this.state) {
      case "patrol":
        speed = this.#patrol(dt);
        break;
      case "suspicious":
        this.#timer -= dt;
        this.#turnToward(this.#interest, dt);
        if (this.#timer <= 0) {
          this.state = "investigate";
          this.#timer = 0;
        }
        break;
      case "investigate":
        speed = this.#walkTo(this.#interest, PATROL_SPEED, dt, 0.8);
        // Cannot get there: look from here instead of walking into the wall again.
        if (this.#blocked) this.#interest.copy(this.mesh.position);
        if (speed === 0) {
          if (this.#timer === 0) this.#lookBase = this.yaw;
          this.#timer += dt;
          this.#lookAround(dt, this.#timer);
          if (this.#timer >= LOOK_TIME) this.#returnToRoute();
        }
        break;
      case "search":
        speed = this.#walkTo(this.#interest, CAUTION_SPEED, dt, 0.8);
        if (this.#blocked) this.#interest.copy(this.mesh.position);
        if (speed === 0) {
          if (this.#timer === 0) this.#lookBase = this.yaw;
          this.#timer += dt;
          this.#lookAround(dt, this.#timer);
          if (this.#timer >= 2) this.#pickSearchPoint(director);
        }
        break;
      case "alert":
        speed = this.#alert(ctx, dt, player, director);
        break;
      case "checkBody":
        speed = this.#checkBody(dt, director);
        break;
    }
    this.#present(dt, speed);
  }

  /** Start a choke hold: the guard is pinned in front of the player and stops seeing or hearing. */
  grab(): void {
    this.state = "held";
    this.suspicion = 0;
    this.velocityStop();
    this.play("hit", { fade: 0.06, hold: Number.POSITIVE_INFINITY });
  }

  /** The hold ran out with too few pumps: the guard shakes free and has seen the player. */
  breakFree(director: AlertDirector, x: number, z: number): void {
    this.state = "alert";
    this.suspicion = 1;
    this.play("idle", { fade: 0.15 });
    director.spotted(x, z);
  }

  /** Enough pumps: out cold for `KNOCKOUT_TIME` seconds. */
  knockOut(): void {
    this.state = "down";
    this.#downTimer = KNOCKOUT_TIME;
    this.suspicion = 0;
    this.#body?.dispose();
    this.#body = undefined;
    this.play("down", { fade: 0.1, hold: Number.POSITIVE_INFINITY });
  }

  /** Hold the guard at a world point (the choke pins it, a drag pulls the body along). */
  place(x: number, z: number, yaw: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.figure.rotation.y = yaw;
    if (this.#body === undefined) return;
    this.#body.velocity.set(0, 0, 0);
    this.#body.teleport(this.mesh.position);
  }

  /** Play is over (won or lost): stand where it is, tracer off. */
  rest(dt: number): void {
    this.#tracerTimer = 0;
    if (this.#body !== undefined) {
      this.#body.velocity.set(0, 0, 0);
      this.#body.moveAndSlide(dt);
    }
    this.#present(dt, 0);
  }

  velocityStop(): void {
    this.#body?.velocity.set(0, 0, 0);
  }

  #present(dt: number, speed: number): void {
    this.#tracerTimer = Math.max(0, this.#tracerTimer - dt);
    this.#tracer.line.visible = this.#tracerTimer > 0;
    const mood =
      this.state === "alert"
        ? "alert"
        : this.state === "suspicious" ||
            this.state === "investigate" ||
            this.state === "search" ||
            this.state === "checkBody"
          ? "suspicious"
          : "none";
    this.#marker.set(mood);
    this.cone.visible = this.conscious;
    // Caution widens the eyes (`halfAngle`); stretch the drawn fan so its edges match exactly.
    this.cone.scale.x = this.#caution
      ? Math.tan(GUARD_HALF_ANGLE * CAUTION_ANGLE) / Math.tan(GUARD_HALF_ANGLE)
      : 1;
    tintViewCone(this.cone, mood === "none" ? "patrol" : mood);
    if (this.state === "down" || this.state === "held") this.animateStill(dt);
    else
      this.animateRig(
        dt,
        speed > 0 ? Math.atan2(this.body.velocity.x, this.body.velocity.z) : undefined,
        speed,
      );
    const clip = this.character.current ?? "";
    if (clip !== this.#heldClip) {
      this.#heldClip = clip;
      const hold = RIFLE_HOLD[clip];
      if (hold !== undefined)
        this.#rifle.rotation.set(
          MathUtils.degToRad(hold[0]),
          MathUtils.degToRad(hold[1]),
          MathUtils.degToRad(hold[2]),
        );
    }
  }

  #patrol(dt: number): number {
    if (this.#pause > 0) {
      this.#pause -= dt;
      this.#lookAround(dt, this.#pause);
      this.body.velocity.set(0, 0, 0);
      this.body.moveAndSlide(dt);
      return 0;
    }
    const point = this.#route[this.#routeIndex];
    if (point === undefined) return 0;
    const speed = this.#walkTo(
      this.#toward.set(point.x, 0, point.z),
      this.#caution ? CAUTION_SPEED : PATROL_SPEED,
      dt,
      0.25,
    );
    if (speed === 0) {
      this.#pause = point.pause;
      this.#lookBase = this.yaw;
      this.#routeIndex = (this.#routeIndex + 1) % this.#route.length;
    }
    return speed;
  }

  /** Walk toward a point; returns the speed moved, 0 once within `arrive` metres. */
  #walkTo(target: Vector3, speed: number, dt: number, arrive: number): number {
    // Blocked by a wall or a crate the straight line runs into: after `STUCK_TIME` the point
    // counts as reached, so a lured or searching guard looks around and moves on instead of
    // walking into the wall forever. A navmesh would route around it; this kit keeps it simple.
    const moved = this.mesh.position.distanceTo(this.#lastPosition);
    this.#stuck =
      this.#lastStep > 0 && moved < this.#lastStep * STUCK_PROGRESS ? this.#stuck + dt : 0;
    this.#lastPosition.copy(this.mesh.position);
    this.#lastStep = 0;
    const dx = target.x - this.mesh.position.x;
    const dz = target.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    this.#blocked = this.#stuck >= STUCK_TIME;
    if (distance <= arrive || this.#blocked) {
      this.#stuck = 0;
      this.body.velocity.set(0, 0, 0);
      this.body.moveAndSlide(dt);
      return 0;
    }
    // Turn before walking: a guard facing away pivots in place first (metal-gear-solid-1
    // `turn-before-run`), so its cone sweeps the way it is about to go.
    const heading = Math.atan2(dx, dz);
    if (Math.abs(angleBetween(heading, this.yaw)) > 0.6) {
      this.#turnTo(heading, dt);
      this.body.velocity.set(0, 0, 0);
      this.body.moveAndSlide(dt);
      return 0.0001;
    }
    this.body.velocity.set((dx / distance) * speed, 0, (dz / distance) * speed);
    this.body.moveAndSlide(dt);
    this.#lastStep = speed * dt;
    return speed;
  }

  #alert(ctx: GameCtx, dt: number, player: ITarget, director: AlertDirector): number {
    this.#fireTimer -= dt;
    const dx = player.position.x - this.mesh.position.x;
    const dz = player.position.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    if (this.sight > 0 && distance <= FIRE_RANGE) {
      const heading = Math.atan2(dx, dz);
      this.#turnTo(heading, dt);
      this.body.velocity.set(0, 0, 0);
      this.body.moveAndSlide(dt);
      const aimed = Math.abs(angleBetween(heading, this.yaw)) <= AIM_TOLERANCE;
      if (aimed && this.#fireTimer <= 0 && ctx.startup.compileSettled) {
        this.#fireTimer = FIRE_INTERVAL;
        this.shots += 1;
        this.play("shoot", { fade: 0.05, hold: 0.35 });
        const chance =
          MathUtils.lerp(HIT_NEAR, HIT_FAR, Math.min(1, distance / FIRE_RANGE)) *
          (player.running ? 0.5 : 1);
        const hit = this.#hooks.random() < chance;
        // A miss still shows: the round passes a little to the side of the player.
        const spread = hit ? 0 : this.#hooks.random() < 0.5 ? -0.6 : 0.6;
        this.#tracer.aim(
          this.mesh.position.x + Math.sin(this.yaw) * 0.6,
          1.3,
          this.mesh.position.z + Math.cos(this.yaw) * 0.6,
          player.position.x + Math.cos(heading) * spread,
          1.1,
          player.position.z - Math.sin(heading) * spread,
        );
        this.#tracerTimer = TRACER_TIME;
        if (hit) {
          this.hits += 1;
          this.#hooks.hitPlayer(SHOT_DAMAGE);
        }
      }
      return 0;
    }
    // Out of sight: the next sighting needs a beat to aim, so rounding a corner is not instant death.
    this.#fireTimer = Math.max(this.#fireTimer, FIRE_INTERVAL * 0.6);
    // No shot: close on the last place anyone saw the player.
    return this.#walkTo(
      this.#toward.set(director.lastKnown.x, 0, director.lastKnown.z),
      ALERT_SPEED,
      dt,
      1.5,
    );
  }

  #becomeSuspicious(point: Vector3): void {
    if (this.state === "suspicious" || this.state === "investigate") {
      // A new noise moves the spot; an investigation restarts its walk toward it.
      this.#interest.copy(point);
      if (this.state === "investigate") this.#timer = 0;
      return;
    }
    this.state = "suspicious";
    this.#interest.copy(point);
    this.#timer = STARE_TIME;
  }

  #startSearch(director: AlertDirector): void {
    this.state = "search";
    this.#pickSearchPoint(director);
  }

  #pickSearchPoint(director: AlertDirector): void {
    const angle = this.#hooks.random() * Math.PI * 2;
    const reach = this.#hooks.random() * SEARCH_RADIUS;
    const insideX = COMPOUND.halfWidth - 1;
    const insideZ = COMPOUND.halfDepth - 1;
    this.#interest.set(
      MathUtils.clamp(director.lastKnown.x + Math.sin(angle) * reach, -insideX, insideX),
      0,
      MathUtils.clamp(director.lastKnown.z + Math.cos(angle) * reach, -insideZ, insideZ),
    );
    this.#timer = 0;
  }

  #returnToRoute(): void {
    // Rejoin at the nearest route point, not the one it left: a long walk back reads as a bug.
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.#route.length; index += 1) {
      const point = this.#route[index];
      if (point === undefined) continue;
      const distance = Math.hypot(point.x - this.mesh.position.x, point.z - this.mesh.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    this.#routeIndex = best;
    this.state = "patrol";
    this.#pause = 0;
  }

  #lookForBodies(others: readonly Guard[]): void {
    for (const other of others) {
      if (other === this || other.state !== "down") continue;
      const dx = other.mesh.position.x - this.mesh.position.x;
      const dz = other.mesh.position.z - this.mesh.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > GUARD_RANGE * 0.8) continue;
      if (Math.abs(angleBetween(Math.atan2(dx, dz), this.yaw)) > this.halfAngle) continue;
      this.#toward.set(other.mesh.position.x, 0.3, other.mesh.position.z);
      if (!this.#hooks.clear(this.#eye, this.#toward)) continue;
      this.state = "checkBody";
      this.#bodyTarget = other;
      this.#timer = 0;
      return;
    }
  }

  #checkBody(dt: number, director: AlertDirector): number {
    const body = this.#bodyTarget;
    if (body === undefined || body.state !== "down") {
      this.#returnToRoute();
      return 0;
    }
    const speed = this.#walkTo(body.mesh.position, ALERT_SPEED * 0.8, dt, 1.1);
    if (speed > 0) return speed;
    if (this.#blocked) {
      // The body lies behind cover this guard cannot walk round: radio it in and search.
      director.disturbance(body.mesh.position.x, body.mesh.position.z);
      this.bodiesFound += 1;
      this.#bodyTarget = undefined;
      this.#startSearch(director);
      return 0;
    }
    if (this.#timer === 0) {
      this.play("check", { fade: 0.1, hold: 1.5 });
      director.disturbance(body.mesh.position.x, body.mesh.position.z);
      this.bodiesFound += 1;
    }
    this.#timer += dt;
    if (this.#timer >= 1.5) {
      // A kick and a shout: the body gets up, and both of them start searching.
      body.#wake();
      this.#bodyTarget = undefined;
      this.#startSearch(director);
    }
    return 0;
  }

  #wake(): void {
    this.state = "patrol";
    this.#downTimer = 0;
    this.play("idle", { fade: 0.6 });
    this.#returnToRoute();
  }

  #lookAround(dt: number, clock: number): void {
    this.#turnTo(this.#lookBase + Math.sin(clock * 1.6) * 0.9, dt);
  }

  #turnToward(point: Vector3, dt: number): void {
    this.#turnTo(Math.atan2(point.x - this.mesh.position.x, point.z - this.mesh.position.z), dt);
  }

  #turnTo(heading: number, dt: number): void {
    const difference = angleBetween(heading, this.yaw);
    const step = Math.sign(difference) * Math.min(Math.abs(difference), TURN_RATE * dt);
    this.figure.rotation.y += step;
  }

  #face(index: number): void {
    const point = this.#route[index];
    if (point === undefined) return;
    this.figure.rotation.y = Math.atan2(
      point.x - this.mesh.position.x,
      point.z - this.mesh.position.z,
    );
    this.#lookBase = this.figure.rotation.y;
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      bodiesFound: this.bodiesFound,
      hits: this.hits,
      position: this.mesh.position.toArray(),
      shots: this.shots,
      sight: Math.round(this.sight * 1000) / 1000,
      state: this.state,
      suspicion: Math.round(this.suspicion * 1000) / 1000,
      yaw: Math.round(this.yaw * 1000) / 1000,
    };
  }

  dispose(): void {
    this.#body?.dispose();
    this.#body = undefined;
    this.mesh.removeFromParent();
  }
}
