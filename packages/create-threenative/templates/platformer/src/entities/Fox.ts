import type { ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { type IFox, createFox } from "../render/fox.js";
import type { ITouchInput } from "../render/touch-layout.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/**
 * The capsule's half-height and radius, and therefore how far the rig's feet sit below the body
 * origin. A `CollisionShape3D` capsule is centred on the body's origin — at the character's waist —
 * so a rig modelled standing on its own origin has to be pushed down by exactly this much or the
 * fox floats a body-length above every surface it lands on.
 */
const CAPSULE = { halfHeight: 0.4, radius: 0.34 } as const;
const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;

/**
 * The fox's feel, in metres and seconds.
 *
 * These are the numbers the whole route is balanced around, so they live in one table where a
 * change is visible instead of scattered through the step. Coyote 0.12 s is 7 ticks at the fixed
 * step: `playtests/coyote.playtest.json` runs off the ledge at x=30, waits 4 ticks and jumps,
 * which is inside the window with margin. Change the window and change that wait with it.
 */
export const FOX_FEEL = {
  /** Air control is this fraction of ground acceleration. */
  airAcceleration: 0.55,
  blinkRate: 14,
  coyoteTime: 0.12,
  dashCooldown: 0.55,
  dashSpeed: 18,
  dashTime: 0.22,
  groundAcceleration: 60,
  gravity: -38,
  invulnerabilityTime: 1.3,
  /** The second jump, out of the air, at 88% of the first. */
  jumpBoost: 0.88,
  jumpBuffer: 0.16,
  jumpSpeed: 13.5,
  maxFallSpeed: 34,
  runSpeed: 9.5,
  /** Sideways speed is 0.75 of forward: the route is a line, not a field. */
  strafeScale: 0.75,
  stompBounce: 12,
  /** Below this the fox has fallen out of the world and the checkpoint takes over. */
  killPlane: -28,
  zMax: 5.2,
  zMin: -6.2,
} as const;

export type FoxState = "dash" | "fall" | "jump" | "run" | "idle";

export class Fox {
  /** The body object. Its origin is the fox's waist, because that is what a capsule is centred on. */
  readonly mesh: Group;
  readonly body: CharacterBody3D;
  readonly rig: IFox;
  readonly tags = ["player"];
  coyoteJumps = 0;
  dashes = 0;
  jumps = 0;
  /** The widest leg swing, in radians, on any step the fox stood still on the ground. */
  standingSwing = 0;
  state: FoxState = "idle";
  #facing = 1;
  #coyote = 0;
  #buffered = 0;
  #dashTimer = 0;
  #dashCooldown = 0;
  #airJumpUsed = false;
  /** The height of the surface the fox last stood on, measured at its feet. */
  #groundY = 0;
  #wants = new Vector3();
  #dashDirection = new Vector3();

  constructor(ctx: GameCtx, spawn: Vector3) {
    this.rig = createFox();
    this.mesh = new Group();
    this.mesh.add(this.rig.group);
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.position.copy(spawn);
    this.#groundY = spawn.y - FOOT_OFFSET;
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      collisionMask: 0xffff,
      entity: "player",
      gravity: FOX_FEEL.gravity,
      maxFallSpeed: FOX_FEEL.maxFallSpeed,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE.halfHeight, CAPSULE.radius),
      // Sticking to a downslope is what makes a dash across the islands land instead of skipping.
      snapToGround: 0.4,
    });
  }

  /** The height of the last surface the fox stood on, at its feet. */
  get groundY(): number {
    return this.#groundY;
  }

  /** The body's origin is its waist, so the fox's centre of mass is the body's origin. */
  get centre(): Vector3 {
    return this.mesh.position;
  }

  update(ctx: GameCtx, dt: number, touch?: ITouchInput): void {
    this.#dashTimer = Math.max(0, this.#dashTimer - dt);
    this.#dashCooldown = Math.max(0, this.#dashCooldown - dt);
    this.#coyote = Math.max(0, this.#coyote - dt);
    this.#buffered = Math.max(0, this.#buffered - dt);
    const move = ctx.input.vector("move");
    this.#wants.set(move.x, 0, -move.y);
    if (touch !== undefined) {
      this.#wants.x += touch.move.x;
      this.#wants.z -= touch.move.y;
    }
    if (this.#wants.lengthSq() > 1) this.#wants.normalize();
    if (this.body.grounded) {
      this.#coyote = FOX_FEEL.coyoteTime;
      this.#airJumpUsed = false;
      this.#groundY = this.mesh.position.y - FOOT_OFFSET;
    }
    if (ctx.input.justPressed("jump") || touch?.jumpPressed === true)
      this.#buffered = FOX_FEEL.jumpBuffer;
    if (
      (ctx.input.justPressed("dash") || touch?.dashPressed === true) &&
      this.#dashCooldown <= 0 &&
      this.#dashTimer <= 0
    )
      this.#startDash();

    if (this.#dashTimer > 0) this.#driveDash();
    else this.#driveWalk(dt);
    // A jump ends the dash and keeps its speed: left running, the next dash tick zeroed the rise
    // and the jump was spent without leaving the ground.
    if (this.#tryJump()) this.#dashTimer = 0;
    this.body.moveAndSlide(dt);
    // The route is a line: the authored ground is 13 m wide and the fox is not going for a walk in
    // the clouds, so the sideways axis is clamped rather than left to a wall 60 m away.
    const z = this.mesh.position.z;
    if (z < FOX_FEEL.zMin || z > FOX_FEEL.zMax)
      this.mesh.position.z = MathUtils.clamp(z, FOX_FEEL.zMin, FOX_FEEL.zMax);
    if (Math.abs(this.#wants.x) > 0.15) this.#facing = Math.sign(this.#wants.x);
    this.#face(dt);
    this.#applyState();
    this.rig.update({
      dashing: this.#dashTimer > 0,
      dt,
      drop: this.mesh.position.y - FOOT_OFFSET - this.#groundY,
      grounded: this.body.grounded,
      speed: Math.hypot(this.body.velocity.x, this.body.velocity.z),
      vy: this.body.velocity.y,
    });
    if (this.body.grounded && Math.hypot(this.body.velocity.x, this.body.velocity.z) < 0.05)
      this.standingSwing = Math.max(this.standingSwing, Math.abs(this.rig.legSwing));
  }

  /** The stomp bounce: one jump, and no coyote window for the frames it spends rising. */
  bounce(): void {
    this.body.velocity.y = FOX_FEEL.stompBounce;
    this.#coyote = 0;
    this.#buffered = 0;
  }

  teleport(position: Vector3): void {
    this.body.velocity.set(0, 0, 0);
    this.body.teleport(position);
    this.#groundY = position.y - FOOT_OFFSET;
    this.#dashTimer = 0;
    this.#dashCooldown = 0;
  }

  /** Blinks while invulnerable; the frames it does not draw are the ones that read as a flicker. */
  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  debug(): Record<string, unknown> {
    return {
      coyoteJumps: this.coyoteJumps,
      dashes: this.dashes,
      facing: this.#facing,
      grounded: this.body.grounded,
      groundY: this.#groundY,
      jumps: this.jumps,
      position: this.mesh.position.toArray(),
      speed: Math.hypot(this.body.velocity.x, this.body.velocity.z),
      standingSwing: this.standingSwing,
      state: this.state,
      velocity: this.body.velocity.toArray(),
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }

  #tryJump(): boolean {
    if (this.#buffered <= 0) return false;
    if (this.#coyote > 0) {
      this.body.velocity.y = FOX_FEEL.jumpSpeed;
      this.#buffered = 0;
      this.#coyote = 0;
      this.coyoteJumps += 1;
      this.jumps += 1;
      return true;
    }
    if (this.#airJumpUsed) return false;
    this.body.velocity.y = FOX_FEEL.jumpSpeed * FOX_FEEL.jumpBoost;
    this.#buffered = 0;
    this.#airJumpUsed = true;
    this.jumps += 1;
    return true;
  }

  #startDash(): void {
    if (this.#wants.lengthSq() > 0.01) this.#dashDirection.copy(this.#wants);
    else this.#dashDirection.set(this.#facing, 0, 0);
    this.#dashTimer = FOX_FEEL.dashTime;
    this.#dashCooldown = FOX_FEEL.dashCooldown;
    this.dashes += 1;
  }

  #driveDash(): void {
    this.body.velocity.set(
      this.#dashDirection.x * FOX_FEEL.dashSpeed,
      0,
      this.#dashDirection.z * FOX_FEEL.dashSpeed,
    );
  }

  #driveWalk(dt: number): void {
    const acceleration =
      FOX_FEEL.groundAcceleration * (this.body.grounded ? 1 : FOX_FEEL.airAcceleration) * dt;
    this.body.velocity.x = approach(
      this.body.velocity.x,
      this.#wants.x * FOX_FEEL.runSpeed,
      acceleration,
    );
    this.body.velocity.z = approach(
      this.body.velocity.z,
      this.#wants.z * FOX_FEEL.runSpeed * FOX_FEEL.strafeScale,
      acceleration,
    );
  }

  /**
   * `yaw` is the lean away from straight ahead, never the heading itself: the branch below already
   * owns left versus right. Feeding the facing into the atan2 as well applied the flip twice, so a
   * pure-left stick turned the fox to face the camera instead of left.
   */
  #face(dt: number): void {
    const yaw = Math.atan2(this.body.velocity.z, Math.max(0.001, Math.abs(this.body.velocity.x)));
    const target = this.#facing > 0 ? -yaw * 0.5 : Math.PI + yaw * 0.5;
    this.rig.group.rotation.y = MathUtils.damp(this.rig.group.rotation.y, target, 8, dt);
  }

  #applyState(): void {
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    this.state =
      this.#dashTimer > 0
        ? "dash"
        : !this.body.grounded
          ? this.body.velocity.y > 0.2
            ? "jump"
            : "fall"
          : speed > 0.6
            ? "run"
            : "idle";
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  return Math.abs(delta) <= maxDelta ? target : current + Math.sign(delta) * maxDelta;
}
