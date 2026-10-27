import type { ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import {
  BoxGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  Vector3,
} from "three";
import {
  FIRST_PERSON,
  applyFirstPerson,
  configureFirstPerson,
  firstPersonFov,
} from "../render/camera.js";
import { scale } from "../render/scale.js";
import type { GameState } from "../state.js";
import type { TouchFrame } from "./TouchControls.js";
import { type IStairView, groundMove, stairView } from "./movement.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

export const EYE_HEIGHT = scale.eyeHeight;
export const WALK_SPEED = 5.6;
export const SPRINT_SPEED = 8.2;
/** Crouched movement, and how far the eye drops. A crouch that only slows you reads as a bug. */
const CROUCH_SPEED = 2.6;
const CROUCH_EYE_DROP = scale.eyeHeight * 0.34;
/** Seconds-ish to fold and unfold; fast enough to dodge with, slow enough to see. */
const CROUCH_RATE = 11;
const LOOK_SENSITIVITY = 0.0022;
const CAPSULE_RADIUS = scale.shoulderWidth / 2;
const CAPSULE_HALF = (scale.humanHeight - CAPSULE_RADIUS * 2) / 2;
const BODY_Y = scale.humanHeight / 2;
/** T spawn centre, facing north into the town (see docs/bayview-design.md). */
const SPAWN = { x: 0, y: BODY_Y, z: 32 } as const;

/**
 * Yaw and pitch, integrated from the `look` action. The action is bound
 * `pointerRelative`, so `ctx.input.vector("look")` is the mouse delta for the tick
 * in canvas pixels — the framework owns the pointer lock and the native equivalent,
 * and nothing here touches the DOM.
 */
class Look {
  yaw = 0;
  pitch = 0;

  /** Touch look, which has no lock to earn. Applied on top of the mouse path below. */
  applyDelta(dx: number, dy: number, scale: number): void {
    if (dx === 0 && dy === 0) return;
    this.yaw -= dx * LOOK_SENSITIVITY * scale;
    this.pitch = MathUtils.clamp(
      this.pitch - dy * LOOK_SENSITIVITY * scale,
      FIRST_PERSON.pitchMin,
      FIRST_PERSON.pitchMax,
    );
  }

  consume(ctx: GameCtx, scale: number): void {
    if (!ctx.input.raw.pointer.captured) return;
    const delta = ctx.input.vector("look");
    this.yaw -= delta.x * LOOK_SENSITIVITY * scale;
    this.pitch = MathUtils.clamp(
      this.pitch - delta.y * LOOK_SENSITIVITY * scale,
      FIRST_PERSON.pitchMin,
      FIRST_PERSON.pitchMax,
    );
  }
}

export class FpsPlayer {
  readonly mesh: Mesh;
  readonly body: CharacterBody3D;
  readonly look = new Look();
  health = 100;
  distanceMoved = 0;
  aiming = false;
  crouching = false;
  /** Shift, or a thumb on the stick rim, and neither aiming nor crouching. Read by the rifle. */
  sprinting = false;
  /** This tick's thumb input, set by the scene before `update`. Undefined on desktop. */
  touch: TouchFrame | undefined;
  /**
   * Worst gap, in metres, between where the camera was placed and where the body actually was
   * when the frame drew. Sampled at the top of `update`, before anything moves: the camera still
   * holds the position it was rendered from, and `eye` now reads the transform physics wrote
   * after that render. Any difference is error the player saw. It is a peak, not an instant, so a
   * scenario that samples every few hundred frames still catches a single bad step.
   */
  cameraLagPeak = 0;
  /**
   * Fastest climb of the eye in one tick while on the ground, in metres. The body steps up a stair
   * in a few ticks and then stops; an eye welded to it climbs in jolts. A peak, like the lag above.
   */
  viewRisePeak = 0;
  /** 0 standing, 1 fully folded; eased so the eye slides rather than teleports. */
  #crouch = 0;
  /** The body height the eye shows, smoothed over stair steps; undefined until the first sync. */
  #view: IStairView | undefined;
  /** The smoothed height minus the body's, when the camera was last placed. */
  #viewOffset = 0;
  #tickDt = 0;
  /** Set by the scene: fired each time a stride completes, so footsteps keep pace with speed. */
  onFootstep: ((sprinting: boolean) => void) | undefined;
  #camera: PerspectiveCamera;
  #fov: number = FIRST_PERSON.hipFov;
  #lastX: number = SPAWN.x;
  #lastZ: number = SPAWN.z;
  /** Metres accumulated since the last planted foot, measured like `distanceMoved`. */
  #strideAccumulated = 0;
  #shake = 0;
  #shakePeak = 0;
  #shakePhase = 0;
  #lastFiringDirection: Vector3 | undefined;
  #lastFiringCameraDirection: Vector3 | undefined;

  constructor(ctx: GameCtx, camera: PerspectiveCamera) {
    this.#camera = camera;
    this.mesh = new Mesh(
      new BoxGeometry(CAPSULE_RADIUS * 2, BODY_Y * 2, CAPSULE_RADIUS * 2),
      new MeshBasicMaterial({ visible: false }),
    );
    this.mesh.name = "player";
    this.mesh.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.45, minWidth: 0.2 },
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE_RADIUS, CAPSULE_HALF),
    });
    // Face down range with the nearest centre-lane plate on the crosshair.
    this.look.yaw = 0;
    this.look.pitch = 0;
    configureFirstPerson(camera);
    this.syncCamera();
  }

  get eye(): { x: number; y: number; z: number } {
    return {
      x: this.mesh.position.x,
      y: this.mesh.position.y + scale.eyeHeight - BODY_Y - this.#crouch * CROUCH_EYE_DROP,
      z: this.mesh.position.z,
    };
  }

  /** The camera basis is the single source of aim truth, including hit shake. */
  aimRay(): { origin: Vector3; direction: Vector3 } {
    this.#camera.updateMatrixWorld(true);
    return {
      origin: this.#camera.getWorldPosition(new Vector3()),
      direction: this.#camera.getWorldDirection(new Vector3()).normalize(),
    };
  }

  /** Capture the direction actually used for a shot and the camera basis at that same instant. */
  recordFiringDirection(direction: Vector3): void {
    this.#camera.updateMatrixWorld(true);
    this.#lastFiringDirection = direction.clone().normalize();
    this.#lastFiringCameraDirection = this.#camera.getWorldDirection(new Vector3()).normalize();
  }

  syncCamera(): void {
    const eye = this.eye;
    const bodyY = this.mesh.position.y;
    const before = this.#view?.y;
    this.#view = stairView(this.#view, bodyY, this.body.grounded, this.#tickDt);
    if (before !== undefined && this.body.grounded) {
      this.viewRisePeak = Math.max(this.viewRisePeak, Math.abs(this.#view.y - before));
    }
    this.#viewOffset = this.#view.y - bodyY;
    applyFirstPerson(this.#camera, {
      ...eye,
      y: eye.y + this.#viewOffset,
      yaw: this.look.yaw,
      pitch: this.look.pitch,
      shake: this.#shake,
      phase: this.#shakePhase,
    });
  }

  update(ctx: GameCtx, dt: number, canAim: boolean): void {
    this.#tickDt = dt;
    // The stair offset is deliberate; what is left is the body moving after the camera was placed.
    const renderedLag = Math.abs(this.#camera.position.y - this.eye.y - this.#viewOffset);
    if (renderedLag > this.cameraLagPeak) this.cameraLagPeak = renderedLag;
    const touch = this.touch;
    this.aiming = canAim && (ctx.input.pressed("aim") || touch?.aim === true);
    // Eased rather than switched: an eye that teleports down 20 cm reads as a glitch, and the
    // same easing is what lets a player peek by tapping it.
    this.crouching = ctx.input.pressed("crouch") || touch?.crouch === true;
    this.#crouch = MathUtils.damp(this.#crouch, this.crouching ? 1 : 0, CROUCH_RATE, dt);
    // Mouse look is half as sensitive down the sights.
    const lookScale = this.aiming ? 0.5 : 1;
    this.look.consume(ctx, lookScale);
    if (touch !== undefined) this.look.applyDelta(touch.lookX, touch.lookY, lookScale);

    const keyboardMove = ctx.input.vector("move");
    const move = {
      x: MathUtils.clamp(keyboardMove.x + (touch?.moveX ?? 0), -1, 1),
      y: MathUtils.clamp(keyboardMove.y + (touch?.moveY ?? 0), -1, 1),
    };
    // The stick-push sprint arrives as its own flag rather than as a bigger move vector, so the
    // same two vetoes below apply to a thumb and to Shift alike.
    const sprintAsked = ctx.input.pressed("sprint") || touch?.sprint === true;
    const sprinting = sprintAsked && !this.aiming && !this.crouching;
    this.sprinting = sprinting;
    // Crouch wins over sprint: holding both should not sprint at a crouch-walk's silhouette.
    const speed = this.crouching ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED;
    // `vector().y` is +up; forward on this ground plane is -z.
    const forwardX = -Math.sin(this.look.yaw);
    const forwardZ = -Math.cos(this.look.yaw);
    const rightX = Math.cos(this.look.yaw);
    const rightZ = -Math.sin(this.look.yaw);
    let wishX = forwardX * move.y + rightX * move.x;
    let wishZ = forwardZ * move.y + rightZ * move.x;
    const length = Math.hypot(wishX, wishZ);
    if (length > 1e-4) {
      wishX /= length;
      wishZ /= length;
    } else {
      wishX = 0;
      wishZ = 0;
    }
    // The backend writes the solved transform after the step, so measuring the
    // mesh either side of `moveAndSlide` in one frame always reads zero. Compare
    // against the previous frame's written position instead.
    const strideDelta = Math.hypot(
      this.mesh.position.x - this.#lastX,
      this.mesh.position.z - this.#lastZ,
    );
    this.distanceMoved += strideDelta;
    // Footsteps are distance-driven, so sprint cadence comes out naturally faster.
    this.#strideAccumulated += strideDelta;
    if (length > 1e-4 && this.#strideAccumulated >= (sprinting ? 0.95 : 0.78)) {
      this.#strideAccumulated = 0;
      this.onFootstep?.(sprinting);
    }
    this.#lastX = this.mesh.position.x;
    this.#lastZ = this.mesh.position.z;
    // Friction, then acceleration toward the wished speed (see `movement.ts`): the body takes a
    // tenth of a second to reach speed and about a third to stop, instead of one tick for both.
    groundMove(this.body.velocity, wishX, wishZ, length > 1e-4 ? speed : 0, dt);
    this.body.moveAndSlide(dt);

    this.#shake = Math.max(0, this.#shake - dt * 3.2);
    this.#shakePhase += dt;

    this.#fov = firstPersonFov(this.#fov, this.aiming, dt);
    if (Math.abs(this.#camera.fov - this.#fov) > 0.01) {
      this.#camera.fov = this.#fov;
      this.#camera.updateProjectionMatrix();
    }
    // Deliberately NOT syncing the camera here.
    //
    // `moveAndSlide` above only queues the motion; the rapier plugin steps the world and writes
    // the solved transform after this method returns, so reading `mesh.position` now yields last
    // step's position. Placing the camera from it left the eye one physics step behind the body —
    // invisible on flat ground, and a third of a metre low on a 0.32 m stair step, which is how a
    // shot aimed at a soldier ended up in the tread underfoot. `Play` now drives `syncCamera`
    // from the post-physics hook instead, where the position is real.
  }

  hurt(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.#shake = Math.min(1, this.#shake + 0.55);
    this.#shakePeak = Math.max(this.#shakePeak, this.#shake);
  }

  /** Horizontal speed in m/s, the one the rifle's bob and clip follow. */
  get speed(): number {
    return Math.hypot(this.body.velocity.x, this.body.velocity.z);
  }

  debug(): {
    cameraLagPeak: number;
    viewRisePeak: number;
    speed: number;
    crouching: number;
    health: number;
    position: number[];
    positionY: number;
    yaw: number;
    pitch: number;
    aimDivergenceDeg: number;
    damageShake: number;
    damageShakePeak: number;
  } {
    const firingDirection = this.#lastFiringDirection;
    const cameraDirection = this.#lastFiringCameraDirection;
    return {
      cameraLagPeak: this.cameraLagPeak,
      viewRisePeak: this.viewRisePeak,
      speed: this.speed,
      crouching: this.crouching ? 1 : 0,
      health: this.health,
      position: this.mesh.position.toArray(),
      positionY: this.mesh.position.y,
      yaw: this.look.yaw,
      pitch: this.look.pitch,
      damageShake: this.#shake,
      damageShakePeak: this.#shakePeak,
      // A shot is required before this metric can pass. Comparing `aimRay()` to the camera
      // here would compare the camera to itself and make the negative control meaningless.
      aimDivergenceDeg:
        firingDirection === undefined || cameraDirection === undefined
          ? 180
          : MathUtils.radToDeg(firingDirection.angleTo(cameraDirection)),
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
