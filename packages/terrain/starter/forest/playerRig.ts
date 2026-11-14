import { BlendSpace1D, SkeletalMesh3D } from "@threenative/core";
import type { Heightfield } from "@threenative/core/world";
import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import {
  type AnimationClip,
  CapsuleGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import {
  CAMERA_RIG,
  type IOrbitCamera,
  type WallProbe,
  createOrbitCamera,
} from "./render/orbitCamera.js";
import { SIGHT_RADIUS, sightLine } from "./render/props/pack.js";
import type { TerrainCtx } from "./sceneState.js";

/** The starter kit's mannequin (Quaternius Universal Animation Library, CC0). */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  fall: "Jump_Loop",
  swim: "Swim_Fwd_Loop",
  tread: "Swim_Idle_Loop",
};
/** The mannequin's root sits at the capsule's bottom: 0.5 m half height + 0.35 m radius, sunk 1 cm. */
const FEET = -0.86;
/** Ground speeds in m/s: the jog the clip was authored for, and the Shift sprint. */
const JOG = 6;
const SPRINT = 9;

export interface IPlayerRigOptions {
  readonly world: string;
  /** The player's launch point, in world metres. */
  readonly at: readonly [number, number];
  /** Where the launch camera stands relative to the player: above the ground under the spawn. */
  readonly cameraOffset: readonly [number, number, number];
  /** The ground the spawn stands on: the launch pose is measured from it, not guessed. */
  readonly field: Heightfield;
  readonly mannequin: IMannequin;
  /** The rig's two swim clips, which the cape's own clips do not carry. */
  readonly swimClips: readonly AnimationClip[];
  /** A staged world streams its own ground, so the player walks only while the player view draws. */
  readonly staged: boolean;
  /** A vista look frames the player from a fixed aim instead of the orbit camera. */
  readonly vista: boolean;
  /** Centres the sun's shadow pages, or clears them when no player framing draws. */
  readonly focusShadows: (at: Vector3 | undefined) => void;
  /** The horizon seam the scene draws under the player, for the scene picker's report. */
  readonly horizon: () => unknown;
}

export interface IPlayerRig {
  readonly actor: Mesh;
  readonly body: CharacterBody3D;
  readonly figure: SkeletalMesh3D;
  /** The launch point, frozen at entry: the streamed worlds measure their spawn cells around it. */
  readonly spawn: Vector3;
  /** The camera's yaw, so movement follows the ground the eye looks along. */
  readonly yaw: () => number;
  /** Top ground speed the scene spends on the player's own movement, in m/s. */
  readonly pace: (sprinting: boolean) => number;
  /** Face the travel direction and blend the gait: one call per fixed step. */
  readonly animate: (dt: number) => void;
  /** True while the figure plays a swim clip: the playtest reads swimming that way. */
  readonly playsSwimClip: () => boolean;
}

/**
 * The player: the capsule the solver moves, the mannequin that rides it, and the third-person camera
 * that follows with the terrain as its walls.
 *
 * The stepped world is the authority for both the ground the player stands on and the wall the orbit
 * camera cannot pass, which is why both queries mask to layer 4: what the player can walk on.
 */
export function createPlayerRig(ctx: TerrainCtx, options: IPlayerRigOptions): IPlayerRig {
  const { at, cameraOffset, field, focusShadows, horizon, mannequin, staged, swimClips, vista } =
    options;
  const [startX, startZ] = at;
  const actor = new Mesh(
    new CapsuleGeometry(0.35, 1.0, 6, 12),
    new MeshStandardMaterial({ color: 0xffc76d }),
  );
  actor.position.set(startX, field.heightAt(startX, startZ) + 2, startZ);
  actor.name = "player";
  // Freeze the launch region before gameplay or a review view can move its follow camera.
  const spawn = actor.position.clone().add(new Vector3(...cameraOffset));
  ctx.camera.position.copy(spawn);
  ctx.add(actor);
  const body = new CharacterBody3D({
    object: actor,
    physics: ctx.physics,
    entity: "player",
    shape: CollisionShape3D.capsule(0.5, 0.35),
    snapToGround: 0.4,
    // The kit's ground and prop colliders keep the default layer.
    ...(staged ? {} : { collisionMask: 4 }),
  });
  // The starter kit's humanoid rides the capsule: the capsule is the collider, the mannequin is what
  // the player sees. Its feet sit at the capsule's bottom (0.5 m half-height plus 0.35 m radius),
  // sunk 1 cm like the starter's; the model faces +Z.
  const figure = new SkeletalMesh3D({
    source: mannequin.scene,
    clips: [...mannequin.animations, ...swimClips],
    requiredClips: Object.values(CLIPS),
    strideRoot: actor,
  });
  figure.root.traverse((object) => {
    object.castShadow = true;
  });
  figure.root.position.y = FEET;
  figure.root.rotation.y = Math.PI;
  // engine-override: the capsule is the physics body only; the rigged figure added below is what draws.
  actor.material.visible = false;
  actor.add(figure.root);
  figure.play(CLIPS.idle);
  // Third person: the collectathon kit's orbit camera, with the terrain as its walls. The vista
  // worlds keep their fixed player framing below.
  const along = new Vector3();
  const probe: WallProbe = (from, to) =>
    along.subVectors(to, from).lengthSq() < 1e-8
      ? undefined
      : ctx.physics.directSpaceState.intersectRay({
          ...(staged ? {} : { collisionMask: 4 }),
          from,
          to,
        })?.distance;
  const orbit: IOrbitCamera = createOrbitCamera(ctx.camera);
  orbit.snap(actor.position, 0, probe);
  ctx.afterPhysics((dt) => {
    if (vista || ctx.state.getState().view !== "player") {
      focusShadows(undefined);
      sightLine.radius.value = 0;
      return;
    }
    // The mouse turns the camera only while the canvas holds the pointer lock a click took.
    if (ctx.input.raw.pointer.captured) {
      const look = ctx.input.vector("look");
      orbit.look(look.x, look.y);
    }
    orbit.update(actor.position, body.velocity, dt, probe);
    sightLine.aim.value.set(
      actor.position.x,
      actor.position.y + CAMERA_RIG.aimHeight,
      actor.position.z,
    );
    sightLine.radius.value = SIGHT_RADIUS;
    // Shadows centre on the hero, not the orbiting eye: a camera turn re-renders no shadow page.
    focusShadows(actor.position);
  });
  ctx.entities.add("player", {
    mesh: actor,
    debug: () => ({
      grounded: body.grounded,
      position: actor.position.toArray(),
      visible: actor.visible && figure.root.visible,
      horizon: horizon(),
    }),
    dispose: () => {
      body.dispose();
      actor.geometry.dispose();
      actor.material.dispose();
    },
  });
  const gaits = new BlendSpace1D([1.8, JOG]);
  const heading = new Quaternion();
  let airborne = 0;

  /** Swim, or ease back to land. The swim clips put the root on the waterline; True while swimming. */
  const swim = (dt: number, speed: number): boolean => {
    const surface = body.swimming ? body.waterSurface : undefined;
    const target = surface === undefined ? FEET : surface - body.object.position.y;
    figure.root.position.y += (target - figure.root.position.y) * Math.min(1, dt * 8);
    if (surface === undefined) return false;
    figure.play(speed > 0.3 ? CLIPS.swim : CLIPS.tread, { fade: 0.3 });
    return true;
  };

  /** The starter's gait logic: face the travel direction, blend walk and jog by ground speed. */
  const animate = (dt: number): void => {
    const { x, z } = body.velocity;
    const speed = Math.hypot(x, z);
    if (speed > 0.05) {
      heading.setFromAxisAngle(figure.root.up, Math.atan2(x, z));
      figure.root.quaternion.slerp(heading, Math.min(1, dt * 12));
    }
    airborne = body.grounded ? 0 : airborne + dt;
    if (swim(dt, speed)) airborne = 0;
    else if (airborne > 0.2) figure.play(CLIPS.fall, { fade: 0.15 });
    else if (speed > 0.05) {
      const weights = gaits.sample(speed);
      figure.playWeighted([
        { clip: CLIPS.walk, weight: weights[0] ?? 0 },
        { clip: CLIPS.run, weight: weights[1] ?? 0 },
      ]);
    } else figure.play(CLIPS.idle, { fade: 0.2 });
    figure.update(dt);
  };

  return {
    actor,
    animate,
    body,
    figure,
    pace: (sprinting: boolean): number => (sprinting ? SPRINT : JOG),
    playsSwimClip: (): boolean => {
      const clip = figure.current;
      return clip === CLIPS.swim || clip === CLIPS.tread;
    },
    spawn,
    yaw: () => orbit.yaw,
  };
}
