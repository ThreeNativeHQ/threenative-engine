import { AnimationPlayer, type ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { type IHero, createHero } from "../render/hero.js";
import type { ITouchInput } from "../render/touch-layout.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/**
 * The capsule, and so how far the rig's feet sit below the body origin. A `CollisionShape3D`
 * capsule is centred on the body's origin — the hero's waist — so the rig is pushed down by
 * `halfHeight + radius` or the hero floats a body-length above everything it lands on.
 */
const CAPSULE = { halfHeight: 0.45, radius: 0.35 } as const;
export const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;
/** The physics layer of the static world. Probes scan only it, so they never hit the hero. */
export const WORLD_LAYER = 1;
const HERO_LAYER = 2;

/**
 * The whole feel, in metres and seconds, from the 30 Hz reference (1 unit = 1 cm: units/frame
 * × 0.3 = m/s, units/frame² × 9 = m/s²). The course is laid out from this table, never the other
 * way round: change a number here and the gaps in `level/Course.ts` change their meaning.
 */
export const HERO_FEEL = {
  /** Target ground speed at full stick, and the speed nothing but a long jump or dive exceeds. */
  runCap: 9.6,
  hardCap: 14.4,
  /** Ground acceleration toward the stick target: `runAccel - runDrag · speed` m/s². */
  runAccel: 9.9,
  runDrag: 0.7,
  /** Slowing down to a lower target. */
  overspeedDecel: 9,
  /** Stopping with the stick released (kit value: the reference's coast is longer). */
  stopDecel: 18,
  /** Face yaw approaches the stick yaw at this rate, rad/s (337.5 °/s). */
  turnRate: (337.5 * Math.PI) / 180,
  /** A stick this far from the facing, at speed, is a turn-around skid. */
  skidAngle: (100 * Math.PI) / 180,
  skidMinSpeed: 4.8,
  skidDecel: 36,
  gravity: 36,
  terminalFall: 22.5,
  /** Letting go of jump while still rising faster than this cuts the rise to a quarter. */
  jumpCutSpeed: 6,
  jumpCutFactor: 0.25,
  jumpSpeed: 12.6,
  /** Each running jump adds this share of forward speed to its rise, and keeps 0.8 of it. */
  jumpForwardLift: 0.25,
  jumpForwardKeep: 0.8,
  doubleJumpSpeed: 15.6,
  tripleJumpSpeed: 20.7,
  tripleMinSpeed: 6,
  /** A landing from a single or double jump opens the next jump of the chain for this long. */
  chainWindow: 0.167,
  backflipSpeed: 18.6,
  backflipBack: 4.8,
  sideflipSpeed: 18.6,
  sideflipForward: 2.4,
  /** Crouch at speed starts a slide; jump inside the window at speed is a long jump. */
  crouchSlideMinSpeed: 3,
  crouchSlideDecel: 6,
  longJumpWindow: 0.5,
  longJumpSpeed: 9,
  longJumpScale: 1.5,
  longJumpGravity: 18,
  /** A wall hit above this speed bounces the hero off and opens the wall-kick window. */
  wallBonkSpeed: 4.8,
  wallKickWindow: 0.167,
  wallKickSpeed: 18.6,
  wallKickForward: 7.2,
  diveBoost: 4.5,
  diveMinSpeed: 4.8,
  diveHop: 4.5,
  diveSlideDecel: 9,
  poundHang: 0.25,
  poundSpeed: 15,
  poundRecover: 0.3,
  /** Air steering acceleration; the hero cannot steer past `runCap` in the air. */
  airAccel: 13.5,
  /** The ledge probe: 0.6 m past the wall, from 1.6 m above the feet down to 1.0 m above them. */
  ledgeAhead: 0.6,
  ledgeTop: 1.6,
  ledgeBottom: 1.0,
  /** Hang time before a forward press climbs, so the grab reads before the climb. */
  ledgeHangMin: 0.25,
  ledgeClimbTime: 0.3,
  /** Below this the hero has fallen into the sea and the checkpoint takes over. */
  killPlane: -6,
} as const;

export type HeroAction =
  | "idle"
  | "run"
  | "skid"
  | "crouch"
  | "crouchSlide"
  | "diveSlide"
  | "poundLand"
  | "single"
  | "double"
  | "triple"
  | "backflip"
  | "sideflip"
  | "longJump"
  | "wallKick"
  | "dive"
  | "groundPound"
  | "fall"
  | "ledgeHang"
  | "ledgeClimb";

const GROUND: ReadonlySet<HeroAction> = new Set([
  "idle",
  "run",
  "skid",
  "crouch",
  "crouchSlide",
  "diveSlide",
  "poundLand",
]);
/** Airborne actions a wall can stop and a ledge can catch. */
const WALL_AIR: ReadonlySet<HeroAction> = new Set([
  "single",
  "double",
  "triple",
  "backflip",
  "sideflip",
  "longJump",
  "wallKick",
  "fall",
]);
/** Jumps whose rise the jump button controls. */
const VARIABLE: ReadonlySet<HeroAction> = new Set(["single", "double"]);
/** Jumps a scenario measures: apex above take-off and ground distance along the take-off facing. */
const MEASURED = ["single", "double", "triple", "backflip", "sideflip", "longJump", "wallKick"];

export interface IWallHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
}

/** A ray against the static world: the hit point and normal, or undefined. */
export type WorldRay = (
  from: Vector3,
  to: Vector3,
) => { position: Vector3; normal: Vector3 } | undefined;

const _from = new Vector3();
const _to = new Vector3();

function forwardOf(yaw: number, target: Vector3): Vector3 {
  return target.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

function angleTo(from: number, to: number): number {
  return MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
}

/**
 * Pip, the hero: one action state machine on a `CharacterBody3D`, driven by a camera-relative
 * stick and three buttons (jump, crouch, attack). Ground motion is a speed along the facing, as in
 * the reference; air motion is a horizontal velocity the stick nudges. The wall and ledge are found
 * with rays against the static world, because `moveAndSlide` reports the floor and not the wall.
 */
export class Hero {
  /** The body object. Its origin is the hero's waist, because that is what a capsule is centred on. */
  readonly mesh: Group;
  readonly body: CharacterBody3D;
  readonly rig: IHero;
  readonly tags = ["player"];
  action: HeroAction = "idle";
  yaw = 0;
  landings = 0;
  wallHits = 0;
  /** Ground speed along `yaw`. */
  #speed = 0;
  readonly #air = new Vector3();
  #actionTime = 0;
  #chainStage = 0;
  #chainTimer = 0;
  #wallTimer = 0;
  #wallKickRise = 0;
  #wallKickFrom = 0;
  readonly #wall: { nx: number; nz: number } = { nx: 0, nz: 0 };
  readonly #ledge = new Vector3();
  #cut = false;
  #groundY = 0;
  readonly #takeoff = new Vector3();
  #takeoffYaw = 0;
  #takeoffSpeed = 0;
  #peak = 0;
  #airKind: HeroAction = "fall";
  #stickYaw = 0;
  readonly #counts: Record<string, number> = {};
  readonly #apex: Record<string, number> = {};
  readonly #distance: Record<string, number> = {};
  readonly #takeoffSpeeds: Record<string, number> = {};
  #sideflipFacingError = 0;
  #wallKicks = 0;
  #ledgeGrabs = 0;
  #pounds = 0;
  readonly #ray: WorldRay;
  readonly #intended = new Vector3();
  readonly #scratch = new Vector3();
  readonly #anim: AnimationPlayer;
  /** Metres the planted sole slid over the ground while running, and the seconds it was planted. */
  #slid = 0;
  #plantedTime = 0;
  #planted = -1;
  readonly #sole = new Vector3();
  /** Seconds the hero is still invulnerable after a hit. */
  hurtTimer = 0;

  constructor(ctx: GameCtx, spawn: Vector3, ray: WorldRay) {
    this.#ray = ray;
    this.rig = createHero();
    this.mesh = new Group();
    this.mesh.add(this.rig.group);
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.position.copy(spawn);
    this.#groundY = spawn.y - FOOT_OFFSET;
    ctx.add(this.mesh);
    // `strideRoot` is the body: the walk and run play at the rate the ground it covers asks for.
    this.#anim = new AnimationPlayer({
      clips: this.rig.clips,
      root: this.rig.group,
      strideRoot: this.mesh,
    });
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.3, minWidth: 0.2 },
      collisionLayer: HERO_LAYER,
      collisionMask: 0xffff,
      entity: "player",
      gravity: -HERO_FEEL.gravity,
      maxFallSpeed: HERO_FEEL.terminalFall,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE.halfHeight, CAPSULE.radius),
      snapToGround: 0.3,
    });
  }

  get grounded(): boolean {
    return GROUND.has(this.action);
  }

  /** The height of the last surface the hero stood on, at its feet. */
  get groundY(): number {
    return this.#groundY;
  }

  get speed(): number {
    return this.grounded ? Math.abs(this.#speed) : Math.hypot(this.#air.x, this.#air.z);
  }

  /** Puts the hero at `position` facing `yaw`, standing still. */
  teleport(position: Vector3, yaw: number): void {
    this.body.teleport(position);
    this.mesh.quaternion.identity();
    this.yaw = yaw;
    this.#speed = 0;
    this.#air.set(0, 0, 0);
    this.#groundY = position.y - FOOT_OFFSET;
    this.#enter("fall");
  }

  /** A stomp's rebound: a fresh single-jump rise with no chain. */
  bounce(): void {
    this.#launch("single", HERO_FEEL.jumpSpeed, this.speed);
    this.#cut = true;
  }

  /** A walker hit: knocked back off `from`, and briefly unhittable. */
  knockBack(from: Vector3): void {
    const away = this.#scratch.subVectors(this.mesh.position, from).setY(0);
    if (away.lengthSq() < 1e-6) forwardOf(this.yaw, away).negate();
    away.normalize().multiplyScalar(6);
    this.#launch("fall", 7, 0);
    this.#air.set(away.x, 0, away.z);
    this.hurtTimer = 1.5;
  }

  update(ctx: GameCtx, dt: number, cameraYaw: number, touch?: ITouchInput): void {
    const input = ctx.input;
    const move = input.vector("move");
    let stickX = move.x;
    let stickY = move.y;
    if (touch !== undefined) {
      stickX += touch.move.x;
      stickY += touch.move.y;
    }
    // Camera-relative: up on the stick is the direction the camera looks along the ground.
    const forward = forwardOf(cameraYaw, this.#scratch);
    this.#intended.set(
      forward.x * stickY - forward.z * stickX,
      0,
      forward.z * stickY + forward.x * stickX,
    );
    const magnitude = Math.min(1, this.#intended.length());
    if (magnitude > 0.05) this.#stickYaw = Math.atan2(-this.#intended.x, -this.#intended.z);
    const jumpPressed = input.justPressed("jump") || touch?.jumpPressed === true;
    const jumpHeld = input.pressed("jump") || touch?.jumpHeld === true;
    const crouchPressed = input.justPressed("crouch") || touch?.crouchPressed === true;
    const crouchHeld = input.pressed("crouch") || touch?.crouchHeld === true;
    const attackPressed = input.justPressed("attack") || touch?.attackPressed === true;

    this.#actionTime += dt;
    this.#chainTimer = Math.max(0, this.#chainTimer - dt);
    this.#wallTimer = Math.max(0, this.#wallTimer - dt);
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    const grounded = this.body.grounded;

    if (this.action === "ledgeHang" || this.action === "ledgeClimb") {
      this.#ledgeStep(magnitude, jumpPressed, crouchPressed);
    } else if (GROUND.has(this.action)) {
      if (!grounded) this.#leaveGround();
      else this.#groundStep(dt, magnitude, jumpPressed, crouchPressed, crouchHeld, attackPressed);
    } else {
      if (grounded && this.body.velocity.y <= 0) this.#land();
      else this.#airStep(dt, magnitude, jumpPressed, jumpHeld, crouchPressed, attackPressed);
    }

    if (GROUND.has(this.action)) {
      forwardOf(this.yaw, this.#scratch);
      this.body.velocity.x = this.#scratch.x * this.#speed;
      this.body.velocity.z = this.#scratch.z * this.#speed;
      this.#groundY = this.mesh.position.y - FOOT_OFFSET;
    } else if (this.action !== "ledgeHang" && this.action !== "ledgeClimb") {
      this.body.velocity.x = this.#air.x;
      this.body.velocity.z = this.#air.z;
      this.#peak = Math.max(this.#peak, this.mesh.position.y);
    }
    this.body.moveAndSlide(dt);
    this.rig.group.rotation.y = MathUtils.damp(
      this.rig.group.rotation.y,
      this.rig.group.rotation.y + angleTo(this.rig.group.rotation.y, this.yaw),
      20,
      dt,
    );
    this.#animate(dt);
    this.rig.update({
      action: this.action,
      actionTime: this.#actionTime,
      drop: this.grounded ? 0 : Math.max(0, this.mesh.position.y - FOOT_OFFSET - this.#groundY),
      dt,
      speed: this.speed,
      vy: this.body.velocity.y,
    });
    this.#measureSkate(dt);
  }

  /**
   * A sole within 10 cm of the feet line is planted; the ground it covers over consecutive planted
   * frames is how far it slid. Zero means the run cycle matches the ground the body covers.
   */
  #measureSkate(dt: number): void {
    const feet = this.mesh.position.y - FOOT_OFFSET;
    let planted = -1;
    this.rig.soles.forEach((sole, i) => {
      if (planted < 0 && sole.getWorldPosition(_to).y - feet < 0.1) planted = i;
    });
    if (this.action !== "run" || this.#speed < 5.5 || planted < 0 || dt <= 0) {
      this.#planted = -1;
      return;
    }
    if (planted === this.#planted) {
      this.#slid += Math.hypot(_to.x - this.#sole.x, _to.z - this.#sole.z);
      this.#plantedTime += dt;
    }
    this.#planted = planted;
    this.#sole.copy(_to);
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      apex: { ...this.#apex },
      counts: { ...this.#counts },
      distance: { ...this.#distance },
      groundY: this.#groundY,
      grounded: this.grounded,
      landings: this.landings,
      ledgeGrabs: this.#ledgeGrabs,
      pounds: this.#pounds,
      position: this.mesh.position.toArray(),
      sideflipFacingError: this.#sideflipFacingError,
      speed: this.speed,
      stride: this.#strideReport(),
      takeoffSpeed: { ...this.#takeoffSpeeds },
      velocity: this.body.velocity.toArray(),
      wallHits: this.wallHits,
      wallKickRise: this.#wallKickRise,
      wallKicks: this.#wallKicks,
      yaw: this.yaw,
    };
  }

  dispose(): void {
    this.#anim.dispose();
    this.body.dispose();
    this.mesh.removeFromParent();
  }

  /**
   * Standing and running blend idle, walk and run by ground speed; every other action holds the
   * neutral "air" pose that `render/hero.ts` bends procedurally.
   */
  #animate(dt: number): void {
    if (this.action === "idle" || this.action === "run") {
      const speed = Math.abs(this.#speed);
      const moving = MathUtils.smoothstep(speed, 0.2, 1);
      const running = MathUtils.smoothstep(speed, 1.5, 5);
      this.#anim.playWeighted(
        [
          { clip: "idle", weight: 1 - moving },
          { clip: "walk", weight: moving * (1 - running) },
          { clip: "run", weight: moving * running },
        ],
        { transition: 0.15 },
      );
    } else this.#anim.playWeighted([{ clip: "air", weight: 1 }], { transition: 0.08 });
    this.#anim.update(dt);
  }

  /** The stride report, and the foot speed it implies over the ground speed: 1 is no skating. */
  #strideReport(): Record<string, unknown> {
    const stride = this.#anim.stride;
    const feet = stride.clipGroundSpeed * stride.rate;
    const footRatio = stride.groundSpeed > 0.5 ? feet / stride.groundSpeed : 1;
    return {
      ...stride,
      clip: this.#anim.current ?? "none",
      footRatio,
      skate: this.#plantedTime > 0 ? this.#slid / this.#plantedTime : 0,
      plantedTime: this.#plantedTime,
      inBand: Math.abs(footRatio - 1) <= 0.1,
    };
  }

  #enter(action: HeroAction): void {
    this.action = action;
    this.#actionTime = 0;
    this.body.gravity = -(action === "longJump" ? HERO_FEEL.longJumpGravity : HERO_FEEL.gravity);
  }

  /** Leaves the ground as `action` with vertical speed `vy` and `forward` m/s along the facing. */
  #launch(action: HeroAction, vy: number, forward: number): void {
    this.#enter(action);
    forwardOf(this.yaw, this.#air).multiplyScalar(forward);
    this.body.velocity.y = vy;
    this.#cut = false;
    this.#airKind = action;
    this.#takeoff.copy(this.mesh.position);
    this.#takeoffYaw = this.yaw;
    this.#takeoffSpeed = this.speed;
    this.#peak = this.mesh.position.y;
    this.#counts[action] = (this.#counts[action] ?? 0) + 1;
  }

  #groundStep(
    dt: number,
    magnitude: number,
    jumpPressed: boolean,
    crouchPressed: boolean,
    crouchHeld: boolean,
    attackPressed: boolean,
  ): void {
    const feel = HERO_FEEL;
    if (this.action === "poundLand") {
      this.#speed = 0;
      if (this.#actionTime >= feel.poundRecover) this.#enter("idle");
      return;
    }
    if (jumpPressed && this.action !== "diveSlide") {
      this.#jumpFromGround(magnitude);
      return;
    }
    if (attackPressed && this.#speed >= feel.diveMinSpeed) {
      this.#launch("dive", feel.diveHop, Math.min(feel.hardCap, this.#speed + feel.diveBoost));
      return;
    }
    switch (this.action) {
      case "diveSlide":
        this.#speed = Math.max(0, this.#speed - feel.diveSlideDecel * dt);
        if (this.#speed === 0) this.#enter("idle");
        return;
      case "crouchSlide":
        this.#speed = Math.max(0, this.#speed - feel.crouchSlideDecel * dt);
        if (this.#speed === 0 || !crouchHeld) this.#enter(crouchHeld ? "crouch" : "idle");
        return;
      case "crouch":
        this.#speed = Math.max(0, this.#speed - feel.stopDecel * dt);
        if (!crouchHeld) this.#enter("idle");
        return;
      case "skid":
        this.#speed = Math.max(0, this.#speed - feel.skidDecel * dt);
        if (this.#speed === 0) {
          this.yaw = this.#stickYaw;
          this.#enter("run");
        }
        return;
      default:
        break;
    }
    if (crouchPressed || crouchHeld) {
      this.#enter(this.#speed >= feel.crouchSlideMinSpeed ? "crouchSlide" : "crouch");
      return;
    }
    if (magnitude > 0.05) {
      const turn = angleTo(this.yaw, this.#stickYaw);
      if (this.#speed < 0.5) this.yaw = this.#stickYaw;
      else if (Math.abs(turn) > feel.skidAngle && this.#speed >= feel.skidMinSpeed) {
        this.#enter("skid");
        return;
      } else this.yaw += MathUtils.clamp(turn, -feel.turnRate * dt, feel.turnRate * dt);
      const target = magnitude * feel.runCap;
      if (this.#speed <= target)
        this.#speed = Math.min(
          target,
          this.#speed + (feel.runAccel - feel.runDrag * this.#speed) * dt,
        );
      else this.#speed = Math.max(target, this.#speed - feel.overspeedDecel * dt);
      if (this.action !== "run") this.#enter("run");
    } else {
      this.#speed = Math.max(0, this.#speed - feel.stopDecel * dt);
      if (this.#speed === 0 && this.action !== "idle") this.#enter("idle");
    }
  }

  #jumpFromGround(magnitude: number): void {
    const feel = HERO_FEEL;
    const speed = this.#speed;
    if (this.action === "skid") {
      this.yaw = this.#stickYaw;
      this.#launch("sideflip", feel.sideflipSpeed, feel.sideflipForward);
      return;
    }
    if (this.action === "crouchSlide") {
      if (this.#actionTime <= feel.longJumpWindow && speed >= feel.crouchSlideMinSpeed) {
        this.#launch(
          "longJump",
          feel.longJumpSpeed,
          Math.min(feel.hardCap, speed * feel.longJumpScale),
        );
        return;
      }
    } else if (this.action === "crouch") {
      this.#launch("backflip", feel.backflipSpeed, -feel.backflipBack);
      return;
    }
    if (magnitude > 0.05 && speed < 0.5) this.yaw = this.#stickYaw;
    const chained = this.#chainTimer > 0;
    const lift = feel.jumpForwardLift * speed;
    const forward = speed * feel.jumpForwardKeep;
    if (chained && this.#chainStage === 2 && speed > feel.tripleMinSpeed)
      this.#launch("triple", feel.tripleJumpSpeed, forward);
    else if (chained && this.#chainStage === 1)
      this.#launch("double", feel.doubleJumpSpeed + lift, forward);
    else this.#launch("single", feel.jumpSpeed + lift, forward);
    this.#chainTimer = 0;
  }

  #leaveGround(): void {
    // Walked off an edge: a fall that keeps the ground speed as air speed.
    forwardOf(this.yaw, this.#air).multiplyScalar(this.#speed);
    this.#enter("fall");
    this.#airKind = "fall";
    this.#peak = this.mesh.position.y;
  }

  #airStep(
    dt: number,
    magnitude: number,
    jumpPressed: boolean,
    jumpHeld: boolean,
    crouchPressed: boolean,
    attackPressed: boolean,
  ): void {
    const feel = HERO_FEEL;
    const vy = this.body.velocity.y;
    if (VARIABLE.has(this.action) && !this.#cut && !jumpHeld && vy > feel.jumpCutSpeed) {
      this.body.velocity.y = vy * feel.jumpCutFactor;
      this.#cut = true;
    }
    if (this.action === "groundPound") {
      this.#air.set(0, 0, 0);
      this.body.gravity = 0;
      this.body.velocity.y = this.#actionTime < feel.poundHang ? 0 : -feel.poundSpeed;
      return;
    }
    if (jumpPressed && this.#wallTimer > 0) {
      this.#wallKick();
      return;
    }
    if (crouchPressed && this.action !== "dive") {
      this.#enter("groundPound");
      this.#airKind = "groundPound";
      this.#air.set(0, 0, 0);
      return;
    }
    if (attackPressed && this.action !== "dive" && this.speed >= feel.diveMinSpeed * 0.5) {
      const speed = Math.min(feel.hardCap, this.speed + feel.diveBoost);
      this.#enter("dive");
      this.#airKind = "dive";
      this.#counts.dive = (this.#counts.dive ?? 0) + 1;
      forwardOf(this.yaw, this.#air).multiplyScalar(speed);
      return;
    }
    // Air steering: the stick nudges the horizontal velocity, never past the run cap.
    if (magnitude > 0.05 && this.#wallTimer === 0) {
      const before = Math.hypot(this.#air.x, this.#air.z);
      this.#air.addScaledVector(this.#intended, (feel.airAccel * dt) / Math.max(1, magnitude));
      const after = Math.hypot(this.#air.x, this.#air.z);
      const cap = Math.max(before, feel.runCap);
      if (after > cap) this.#air.multiplyScalar(cap / after);
    }
    if (WALL_AIR.has(this.action)) this.#probeWall();
  }

  /** One ray along the travel direction at waist height finds a wall; a second finds its ledge. */
  #probeWall(): void {
    const feel = HERO_FEEL;
    const speed = Math.hypot(this.#air.x, this.#air.z);
    const direction = this.#scratch;
    if (speed > 0.3) direction.set(this.#air.x / speed, 0, this.#air.z / speed);
    else forwardOf(this.yaw, direction);
    const centre = this.mesh.position;
    _from.copy(centre);
    _to.copy(centre).addScaledVector(direction, CAPSULE.radius + 0.15);
    const hit = this.#ray(_from, _to);
    if (hit === undefined || Math.abs(hit.normal.y) > 0.3) return;
    const nx = hit.normal.x;
    const nz = hit.normal.z;
    const n = Math.hypot(nx, nz);
    const wallX = nx / n;
    const wallZ = nz / n;
    // Ledge: falling, and floor 1.0-1.6 m above the feet just past the wall.
    if (this.body.velocity.y <= 0) {
      const feet = centre.y - FOOT_OFFSET;
      _from.set(
        hit.position.x - wallX * feel.ledgeAhead,
        feet + feel.ledgeTop,
        hit.position.z - wallZ * feel.ledgeAhead,
      );
      _to.set(_from.x, feet + feel.ledgeBottom, _from.z);
      const ledge = this.#ray(_from, _to);
      if (ledge !== undefined && ledge.normal.y > 0.7) {
        this.#grabLedge(hit.position, wallX, wallZ, ledge.position);
        return;
      }
    }
    // Only the speed into the wall counts: a glancing contact slides along it. `#air` is this
    // file's own vector, so the part pushing into the wall is removed here, or the stick would
    // keep adding to it while the body stands still against the wall.
    const into = -(this.#air.x * wallX + this.#air.z * wallZ);
    if (into < feel.wallBonkSpeed || this.#wallTimer > 0) {
      if (into > 0) this.#air.addScaledVector(_from.set(wallX, 0, wallZ), into);
      return;
    }
    // A fast hit: bounce off a little, and open the wall-kick window.
    this.wallHits += 1;
    this.#wallTimer = feel.wallKickWindow;
    this.#wall.nx = wallX;
    this.#wall.nz = wallZ;
    this.#air.set(wallX * 1.2, 0, wallZ * 1.2);
    if (this.body.velocity.y > 0) this.body.velocity.y = 0;
    this.#enter("fall");
  }

  #wallKick(): void {
    const feel = HERO_FEEL;
    // Face away from the wall: the facing becomes the wall's normal.
    this.yaw = Math.atan2(-this.#wall.nx, -this.#wall.nz);
    this.#wallTimer = 0;
    this.#wallKicks += 1;
    this.#wallKickFrom = this.mesh.position.y;
    this.#launch("wallKick", feel.wallKickSpeed, feel.wallKickForward);
  }

  #grabLedge(wall: { x: number; z: number }, nx: number, nz: number, top: Vector3): void {
    this.#enter("ledgeHang");
    this.#ledgeGrabs += 1;
    this.#ledge.copy(top);
    this.yaw = Math.atan2(nx, nz);
    this.#air.set(0, 0, 0);
    this.body.gravity = 0;
    this.body.velocity.set(0, 0, 0);
    this.body.teleport(
      _to.set(
        wall.x + nx * (CAPSULE.radius + 0.02),
        top.y - 1.3 + FOOT_OFFSET,
        wall.z + nz * (CAPSULE.radius + 0.02),
      ),
    );
  }

  #ledgeStep(magnitude: number, jumpPressed: boolean, crouchPressed: boolean): void {
    const feel = HERO_FEEL;
    this.body.velocity.set(0, 0, 0);
    if (this.action === "ledgeClimb") {
      if (this.#actionTime < feel.ledgeClimbTime) return;
      // Stand on the ledge, one step past its lip.
      this.body.teleport(_to.set(this.#ledge.x, this.#ledge.y + FOOT_OFFSET + 0.05, this.#ledge.z));
      this.#speed = 0;
      this.#groundY = this.#ledge.y;
      this.#enter("idle");
      this.landings += 1;
      return;
    }
    if (crouchPressed) {
      this.#enter("fall");
      this.#airKind = "fall";
      return;
    }
    if (this.#actionTime < feel.ledgeHangMin) return;
    const towardWall = Math.abs(angleTo(this.yaw, this.#stickYaw)) < Math.PI / 2;
    if (jumpPressed || (magnitude > 0.5 && towardWall)) this.#enter("ledgeClimb");
  }

  #land(): void {
    const feel = HERO_FEEL;
    const kind = this.#airKind;
    this.landings += 1;
    if (MEASURED.includes(kind)) {
      this.#apex[kind] = this.#peak - this.#takeoff.y;
      const travelled = this.#scratch.subVectors(this.mesh.position, this.#takeoff).setY(0);
      forwardOf(this.#takeoffYaw, _from);
      this.#distance[kind] = travelled.dot(_from);
      this.#takeoffSpeeds[kind] = this.#takeoffSpeed;
      if (kind === "sideflip")
        this.#sideflipFacingError = Math.abs(angleTo(this.yaw, this.#stickYaw));
      if (kind === "wallKick") this.#wallKickRise = this.#peak - this.#wallKickFrom;
    }
    forwardOf(this.yaw, _from);
    this.#speed = Math.max(0, this.#air.x * _from.x + this.#air.z * _from.z);
    this.#chainStage = kind === "single" ? 1 : kind === "double" ? 2 : 0;
    this.#chainTimer = this.#chainStage > 0 ? feel.chainWindow : 0;
    this.#air.set(0, 0, 0);
    if (kind === "groundPound") {
      this.#pounds += 1;
      this.#speed = 0;
      this.#enter("poundLand");
    } else if (kind === "dive") this.#enter("diveSlide");
    else if (kind === "backflip") {
      this.#speed = 0;
      this.#enter("idle");
    } else this.#enter(this.#speed > 0 ? "run" : "idle");
    this.#airKind = "fall";
  }
}
