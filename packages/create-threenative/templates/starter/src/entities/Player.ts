import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { type AnimationClip, Group, type Mesh, type Object3D, Quaternion, Vector3 } from "three";
import { type IStarterConventions, preparePlayerConventions } from "../conventions.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

// Tune these two timers for jump feel; they forgive a late or early button press.
// 0.12s is 7.2 ticks at the 1/60 step, which is what a jump scenario measures against: 3 ticks
// walking off the ledge, 5 more airborne, then the jump — the jump lands about 5 ticks after the
// player actually leaves the ground, inside the window. Change this and those two step lengths
// move with it. Tightening the airborne hold does NOT make the scenario safer: with 2 the player
// has not left the ledge yet, and the jump is counted as an ordinary one
// (`jumps: 1, coyoteJumps: 0`), which is what it measured when I tried.
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.14;
const JUMP_SPEED = 5;
const MOVE_SPEED = 2;
/** Capsule for a 1.8 m figure: 0.6 m half-height plus a 0.3 m radius at each end. */
const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const PLAYER_FOOT_OFFSET = HALF_HEIGHT + RADIUS + 0.01;
/** Where the capsule rests on a floor at y = 0: its own half-height above that surface. */
export const PLAYER_STAND_Y = HALF_HEIGHT + RADIUS;
const VISUAL_ATTACHMENT_TOLERANCE = 0.1;
const SPAWN = { x: -2, y: PLAYER_STAND_Y, z: 0 } as const;

/** The clips `assets/mannequin.glb` ships, by the name this file plays them under. */
const CLIPS = {
  idle: "Idle_Loop",
  jog: "Jog_Fwd_Loop",
  jumpStart: "Jump_Start",
  jumpLoop: "Jump_Loop",
  jumpLand: "Jump_Land",
} as const;

export interface IPlayerModel {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

export class Player {
  readonly mesh: Group;
  readonly visual: Mesh;
  readonly body: CharacterBody3D;
  readonly character: SkeletalMesh3D;
  #coyoteTime = 0;
  #jumpBuffer = 0;
  #jumps = 0;
  #coyoteJumps = 0;
  #odometer = 0;
  #landing = 0;
  #wasGrounded = true;
  #supportSurfaceY = 0;
  #heading = new Quaternion();
  #previousPosition = new Vector3();
  #bodyWorldPosition = new Vector3();
  #visualWorldPosition = new Vector3();
  #visualBodyOffsetY: number | undefined;
  #hasPreviousPosition = false;
  #conventions: IStarterConventions;

  /**
   * `model` is the loaded `mannequin.glb` — Quaternius' Universal Animation Library mannequin
   * (CC0), recoloured and cut to the locomotion clips. Swap in any rigged glTF with the same clip
   * roles by editing `CLIPS`; `requiredClips` fails the load, by name, if one is missing.
   */
  constructor(
    ctx: GameCtx,
    model: IPlayerModel,
    spawn: { readonly x: number; readonly y: number; readonly z: number } = SPAWN,
  ) {
    this.mesh = new Group();
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: Object.values(CLIPS),
      strideRoot: this.mesh,
    });
    const figure = this.character.root;
    figure.traverse((object) => {
      object.castShadow = true;
    });
    // Feet at the bottom of the capsule, sunk one centimetre so a sole never floats on the floor.
    figure.position.y = -PLAYER_FOOT_OFFSET;
    // The model faces +Z; start facing into the level, away from the camera.
    figure.rotation.y = Math.PI;
    this.mesh.add(figure);
    // `visual` is the skinned figure itself: the skinned `Mesh` at the top of the rig, so the
    // attachment and grounding readbacks below measure the geometry the player actually sees.
    this.visual = skinnedMeshOf(figure);
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
    this.#conventions = preparePlayerConventions(figure);
    this.character.play(CLIPS.idle);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  update(ctx: GameCtx, dt: number, touch?: ITouchInput): void {
    if (this.#hasPreviousPosition) {
      this.#odometer += this.mesh.position.distanceTo(this.#previousPosition);
    }
    const grounded = this.body.grounded;
    this.#coyoteTime = Math.max(0, this.#coyoteTime - dt);
    this.#jumpBuffer = Math.max(0, this.#jumpBuffer - dt);
    if (grounded) this.#coyoteTime = COYOTE_TIME;
    if (ctx.input.justPressed("jump") || touch?.jumpPressed === true)
      this.#jumpBuffer = JUMP_BUFFER;
    let jumped = false;
    if (this.#jumpBuffer > 0 && this.#coyoteTime > 0) {
      this.body.velocity.y = JUMP_SPEED;
      this.#jumpBuffer = 0;
      this.#coyoteTime = 0;
      this.#jumps += 1;
      if (!grounded) this.#coyoteJumps += 1;
      jumped = true;
    }
    const move = ctx.input.vector("move");
    if (touch !== undefined) {
      move.x += touch.move.x;
      move.y += touch.move.y;
      move.clampLength(0, 1);
    }
    this.body.velocity.x = move.x * MOVE_SPEED;
    this.body.velocity.z = -move.y * MOVE_SPEED;
    this.#previousPosition.copy(this.mesh.position);
    this.body.moveAndSlide(dt);
    this.#hasPreviousPosition = true;
    if (this.body.grounded) this.#coyoteTime = COYOTE_TIME;
    const canCorrectGrounding = this.body.grounded && this.body.velocity.y <= 0;
    // Derive the contact plane from the grounded body, including terrain outside the arena.
    if (canCorrectGrounding) this.#supportSurfaceY = this.mesh.position.y - PLAYER_FOOT_OFFSET;
    this.#conventions.groundSnap.enabled = canCorrectGrounding;
    this.#conventions.applyGrounding(this.#supportSurfaceY, dt);
    this.#captureVisualBodyOffset();
    this.#animate(dt, move.length(), jumped);
  }

  respawn(): void {
    this.body.teleport(SPAWN);
    this.#coyoteTime = 0;
    this.#jumpBuffer = 0;
    this.#hasPreviousPosition = false;
  }

  debug(): {
    coyoteJumps: number;
    grounded: boolean;
    facingZ: number;
    groundClearance: number | null;
    groundCorrectionEnabled: boolean;
    groundSurfaceY: number;
    jumps: number;
    normaliseFactor: number;
    odometer: number;
    position: number[];
    visualAttached: boolean;
    visualAttachmentDrift: number;
  } {
    const visualAttachmentDrift = this.#visualAttachmentDrift();
    return {
      coyoteJumps: this.#coyoteJumps,
      grounded: this.body.grounded,
      facingZ: this.character.root.getWorldDirection(new Vector3()).z,
      groundClearance: this.#conventions.groundSnap.clearance,
      groundCorrectionEnabled: this.#conventions.groundSnap.enabled,
      groundSurfaceY: this.#supportSurfaceY,
      jumps: this.#jumps,
      normaliseFactor: this.#conventions.normaliseFactor,
      odometer: this.#odometer,
      position: this.mesh.position.toArray(),
      visualAttached: visualAttachmentDrift <= VISUAL_ATTACHMENT_TOLERANCE,
      visualAttachmentDrift,
    };
  }

  get coyoteJumps(): number {
    return this.#coyoteJumps;
  }

  get grounded(): boolean {
    return this.body.grounded;
  }

  get jumps(): number {
    return this.#jumps;
  }

  get odometer(): number {
    return this.#odometer;
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }

  /** Faces the direction of travel and picks a clip from what the body is actually doing. */
  #animate(dt: number, speed: number, jumped: boolean): void {
    const figure = this.character.root;
    if (speed > 0.05) {
      const heading = Math.atan2(this.body.velocity.x, this.body.velocity.z);
      // Matrix decomposition can represent a half-turn with x/z Euler rotations.
      this.#heading.setFromAxisAngle(this.mesh.up, heading);
      figure.quaternion.slerp(this.#heading, Math.min(1, dt * 12));
    }
    const grounded = this.body.grounded;
    this.#landing -= dt;
    if (jumped) this.character.play(CLIPS.jumpStart, { fade: 0.08, mode: "once" });
    else if (!grounded && this.character.finished)
      this.character.play(CLIPS.jumpLoop, { fade: 0.15 });
    else if (grounded && !this.#wasGrounded) {
      this.#landing = 0.25;
      this.character.play(CLIPS.jumpLand, { fade: 0.06, mode: "once" });
    } else if (grounded && this.#landing <= 0)
      this.character.play(speed > 0.05 ? CLIPS.jog : CLIPS.idle, { fade: 0.2 });
    this.#wasGrounded = grounded;
    this.character.update(dt);
  }

  #captureVisualBodyOffset(): void {
    if (this.#visualBodyOffsetY !== undefined || !this.body.grounded || this.body.velocity.y > 0)
      return;
    this.mesh.getWorldPosition(this.#bodyWorldPosition);
    this.visual.getWorldPosition(this.#visualWorldPosition);
    this.#visualBodyOffsetY = this.#visualWorldPosition.y - this.#bodyWorldPosition.y;
  }

  #visualAttachmentDrift(): number {
    if (this.#visualBodyOffsetY === undefined) return 0;
    this.mesh.getWorldPosition(this.#bodyWorldPosition);
    this.visual.getWorldPosition(this.#visualWorldPosition);
    return Math.abs(
      this.#visualWorldPosition.y - this.#bodyWorldPosition.y - this.#visualBodyOffsetY,
    );
  }
}

/**
 * The skinned `Mesh` inside a rig, which is the geometry the player actually sees.
 *
 * The rig's root is whatever glTF happened to call its top node, so a rig can arrive as a `Group`
 * with the `Mesh` below it or already be the `Mesh`. The readbacks in `debug()` measure the drawn
 * figure against the body, so they need that `Mesh` and not the wrapper above it.
 */
function skinnedMeshOf(figure: Object3D): Mesh {
  let found: Mesh | undefined;
  figure.traverse((object) => {
    if (found === undefined && (object as Mesh).isMesh === true) found = object as Mesh;
  });
  if (found === undefined) throw new Error("The player rig carried no skinned mesh to animate.");
  return found;
}
