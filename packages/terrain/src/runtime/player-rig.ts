import { BlendSpace1D, type ICtx, SkeletalMesh3D } from "@threenative/core";
import type { Heightfield } from "@threenative/core/world";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import {
  type AnimationClip,
  CapsuleGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";

/** The humanoid a kit's player rig puts on the capsule. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

/** The clip names a kit's mannequin carries; the package plays them, the kit names them. */
export interface IPlayerRigClips {
  readonly idle: string;
  readonly walk: string;
  readonly run: string;
  readonly fall: string;
  readonly swim: string;
  readonly tread: string;
}

/** Ground speeds in m/s: the walk clip's pace, the jog, and the sprint. */
export interface IPlayerRigGait {
  /** The walk/jog blend's lower speed. */
  readonly stride: number;
  /** The jog the run clip was authored for. */
  readonly run: number;
  /** The Shift sprint. */
  readonly sprint: number;
}

/** Distance along the ray from `from` to `to` to the first wall, or undefined when clear. */
export type PlayerWallProbe = (from: Vector3, to: Vector3) => number | undefined;

/**
 * The game's follow camera. The package drives it (pointer look, the per-step update) but never
 * builds it: framing is the game's, so a kit owns the arm length, the angles and the lens.
 */
export interface IPlayerRigCamera {
  /** The yaw the camera looks along (Three.js convention: forward is -Z at 0). */
  readonly yaw: number;
  /** Puts the camera behind a hero facing `yaw`, with no easing. */
  snap(target: Vector3, yaw: number, probe: PlayerWallProbe): void;
  /** Turns the arm by a pointer delta in pixels: right turns the view right, down raises the arm. */
  look(dx: number, dy: number): void;
  update(target: Vector3, velocity: Vector3, dt: number, probe: PlayerWallProbe): void;
}

/** The eye-line the kit draws from the hero to what it can see (`sightLine`). */
export interface IPlayerRigSight {
  readonly aim: { value: Vector3 };
  readonly radius: { value: number };
  /** The radius a clear line carries, in metres. */
  readonly radiusValue: number;
}

/** Everything the rig reads from the game: its scene, its data and the values that shape it. */
export interface IPlayerRigOptions {
  readonly ctx: ICtx<Record<string, unknown> & { view: string }, IPhysicsContext>;
  /** The player's launch point, in world metres. */
  readonly at: readonly [number, number];
  /** The ground the spawn stands on: the launch pose is measured from it, not guessed. */
  readonly field: Heightfield;
  readonly mannequin: IMannequin;
  readonly clips: IPlayerRigClips;
  /** The rig's two swim clips, which the mannequin's own clips do not carry. */
  readonly swimClips: readonly AnimationClip[];
  /** Where the launch camera stands relative to the player: above the ground under the spawn. */
  readonly cameraOffset: readonly [number, number, number];
  /** The capsule: radius and cylinder height, metres. The figure's feet are derived from them. */
  readonly capsule?: { readonly radius: number; readonly height: number };
  /** The collision mask the ground and the props answer on; absent keeps the physics default. */
  readonly collisionMask?: number;
  readonly gait: IPlayerRigGait;
  /** The game's follow camera, already built. */
  readonly camera: IPlayerRigCamera;
  /** The game's wall probe against its own ground and prop colliders. */
  readonly probe: PlayerWallProbe;
  /** Should the follow camera run this step? False in a fixed view or a vista framing. */
  readonly following: () => boolean;
  /** The aim height above the player the sight line follows, metres. */
  readonly aimHeight: number;
  readonly sight?: IPlayerRigSight;
  /** Centres the sun's shadow pages, or clears them when no player framing draws. */
  readonly focusShadows: (at: Vector3 | undefined) => void;
  /** The horizon seam the scene draws under the player, for the scene picker's report. */
  readonly horizon: () => unknown;
}

/** The player: the capsule the solver moves, the mannequin that rides it and the camera that follows. */
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

/** The capsule's own defaults: 0.35 m radius, 1 m tall; the figure sinks 1 cm into the ground. */
const CAPSULE = { radius: 0.35, height: 1.0 } as const;
const SINK = 0.01;

/**
 * The player: the capsule the solver moves, the mannequin that rides it, and the third-person camera
 * that follows with the terrain as its walls.
 *
 * The stepped world is the authority for both the ground the player stands on and the wall the orbit
 * camera cannot pass, which is why both queries mask to the game's ground layer: what the player can
 * walk on. Every appearance value — the mannequin, its clips, the gait speeds, the capsule and the
 * camera framing — comes from the game.
 *
 * @requires npm i -D @threenative/terrain @threenative/physics
 * @situation give a copied starter kit its player capsule, mannequin and follow camera
 * @constraint the game builds the camera and the wall probe; the package owns only their wiring
 * @example const rig = createPlayerRig(ctx, { at, field, mannequin, clips, gait, camera, probe, ... });
 */
export function createPlayerRig(options: IPlayerRigOptions): IPlayerRig {
  const { at, camera, field, mannequin, probe } = options;
  const capsule = options.capsule ?? CAPSULE;
  const feet = -(capsule.height / 2 + capsule.radius + SINK);
  const [startX, startZ] = at;
  const actor = new Mesh(
    new CapsuleGeometry(capsule.radius, capsule.height, 6, 12),
    new MeshStandardMaterial({ color: 0xffc76d }),
  );
  actor.position.set(startX, field.heightAt(startX, startZ) + 2, startZ);
  actor.name = "player";
  // Freeze the launch region before gameplay or a review view can move its follow camera.
  const spawn = actor.position.clone().add(new Vector3(...options.cameraOffset));
  options.ctx.camera.position.copy(spawn);
  options.ctx.add(actor);
  const body = new CharacterBody3D({
    object: actor,
    physics: options.ctx.physics,
    entity: "player",
    shape: CollisionShape3D.capsule(capsule.height / 2, capsule.radius),
    snapToGround: 0.4,
    ...(options.collisionMask === undefined ? {} : { collisionMask: options.collisionMask }),
  });
  // The humanoid rides the capsule: the capsule is the collider, the mannequin is what the player
  // sees. Its feet sit at the capsule's bottom, sunk 1 cm; the model faces +Z.
  const figure = new SkeletalMesh3D({
    source: mannequin.scene,
    clips: [...mannequin.animations, ...options.swimClips],
    requiredClips: Object.values(options.clips),
    strideRoot: actor,
  });
  figure.root.traverse((object) => {
    object.castShadow = true;
  });
  figure.root.position.y = feet;
  figure.root.rotation.y = Math.PI;
  // engine-override: the capsule is the physics body only; the rigged figure added below is what draws.
  actor.material.visible = false;
  actor.add(figure.root);
  figure.play(options.clips.idle);
  camera.snap(actor.position, 0, probe);
  options.ctx.afterPhysics((dt) => {
    if (!options.following()) {
      options.focusShadows(undefined);
      if (options.sight) options.sight.radius.value = 0;
      return;
    }
    // The mouse turns the camera only while the canvas holds the pointer lock a click took.
    if (options.ctx.input.raw.pointer.captured) {
      const look = options.ctx.input.vector("look");
      camera.look(look.x, look.y);
    }
    camera.update(actor.position, body.velocity, dt, probe);
    if (options.sight) {
      options.sight.aim.value.set(
        actor.position.x,
        actor.position.y + options.aimHeight,
        actor.position.z,
      );
      options.sight.radius.value = options.sight.radiusValue;
    }
    // Shadows centre on the hero, not the orbiting eye: a camera turn re-renders no shadow page.
    options.focusShadows(actor.position);
  });
  options.ctx.entities.add("player", {
    mesh: actor,
    debug: () => ({
      grounded: body.grounded,
      position: actor.position.toArray(),
      visible: actor.visible && figure.root.visible,
      horizon: options.horizon(),
    }),
    dispose: () => {
      body.dispose();
      actor.geometry.dispose();
      actor.material.dispose();
    },
  });
  const gaits = new BlendSpace1D([options.gait.stride, options.gait.run]);
  const heading = new Quaternion();
  let airborne = 0;

  /** Swim, or ease back to land. The swim clips put the root on the waterline; True while swimming. */
  const swim = (dt: number, speed: number): boolean => {
    const surface = body.swimming ? body.waterSurface : undefined;
    const target = surface === undefined ? feet : surface - body.object.position.y;
    figure.root.position.y += (target - figure.root.position.y) * Math.min(1, dt * 8);
    if (surface === undefined) return false;
    figure.play(speed > 0.3 ? options.clips.swim : options.clips.tread, { fade: 0.3 });
    return true;
  };

  /** Face the travel direction, blend walk and jog by ground speed, and play the right clip. */
  const animate = (dt: number): void => {
    const { x, z } = body.velocity;
    const speed = Math.hypot(x, z);
    if (speed > 0.05) {
      heading.setFromAxisAngle(figure.root.up, Math.atan2(x, z));
      figure.root.quaternion.slerp(heading, Math.min(1, dt * 12));
    }
    airborne = body.grounded ? 0 : airborne + dt;
    if (swim(dt, speed)) airborne = 0;
    else if (airborne > 0.2) figure.play(options.clips.fall, { fade: 0.15 });
    else if (speed > 0.05) {
      const weights = gaits.sample(speed);
      figure.playWeighted([
        { clip: options.clips.walk, weight: weights[0] ?? 0 },
        { clip: options.clips.run, weight: weights[1] ?? 0 },
      ]);
    } else figure.play(options.clips.idle, { fade: 0.2 });
    figure.update(dt);
  };

  return {
    actor,
    animate,
    body,
    figure,
    pace: (sprinting: boolean): number => (sprinting ? options.gait.sprint : options.gait.run),
    playsSwimClip: (): boolean => {
      const clip = figure.current;
      return clip === options.clips.swim || clip === options.clips.tread;
    },
    spawn,
    yaw: () => camera.yaw,
  };
}
