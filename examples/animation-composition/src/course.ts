import {
  AnimationComposer,
  BlendSpace1D,
  BlendSpace2D,
  GroundSnap,
  type ICtx,
  Scene,
} from "@threenative/core";
import {
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import { Group } from "three";
import { CompositionBenchmark, benchmarkMode } from "./benchmark.js";
import { CompositionCharacter } from "./character.js";
import {
  compositionClips,
  compositionLayers,
  compositionSamples,
  sourceClipBytes,
} from "./clips.js";
import { CompositionPose } from "./pose.js";
import { characterSource, cloneCharacter, courseLook } from "./render/character.js";

const originalClips = sourceClipBytes();
const history = {
  walk: 0,
  run: 0,
  strafe: 0,
  reload: 0,
  reloadFinished: 0,
  recoil: 0,
  cancelled: 0,
  pause: 0,
  reset: 0,
  blocked: 0,
  cycles: 0,
  exitActions: -1,
  exitOwnedBytes: -1,
  clipsUnchanged: false,
};

type CourseCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

export class CompositionCourse extends Scene<Record<string, unknown>, IPhysicsContext> {
  #character: CompositionCharacter | undefined;
  #benchmark: CompositionBenchmark | undefined;
  #source: ReturnType<typeof characterSource> | undefined;
  #cleanLook: (() => void) | undefined;
  #rigids: RigidBody3D[] = [];

  override enter(ctx: CourseCtx) {
    this.#cleanLook = courseLook(ctx, benchmarkMode !== "none");
    const source = characterSource();
    this.#source = source;
    if (benchmarkMode !== "none") {
      const benchmark = new CompositionBenchmark(ctx, source, benchmarkMode);
      this.#benchmark = benchmark;
      ctx.beforeRender(() => {
        benchmark.rendered();
        ctx.state.set({ benchmark: benchmark.observation() });
      });
      return (_ctx: CourseCtx, dt: number) => benchmark.update(dt);
    }
    const rig = cloneCharacter(source);
    const object = new Group();
    object.position.set(0, 0.85, 0);
    object.add(rig.root);
    ctx.add(object);
    const body = new CharacterBody3D({
      object,
      physics: ctx.physics,
      gravity: 0,
      shape: CollisionShape3D.capsule(0.55, 0.3),
    });
    for (const [x, y, z, w, h, d] of [
      [0, -0.1, 3, 22, 0.1, 24],
      [0, 1, 6, 12, 2, 0.5],
    ])
      this.#rigids.push(
        new RigidBody3D({
          type: "fixed",
          position: { x: x as number, y: y as number, z: z as number },
          physics: ctx.physics,
          shape: CollisionShape3D.box(w as number, h as number, d as number),
        }),
      );
    const animation = new AnimationComposer({
      root: rig.root,
      clips: compositionClips,
      samples: compositionSamples,
      layers: compositionLayers,
      rootMotion: { bone: "Hips", body: object },
    });
    animation.paused = true;
    const blend1D = new BlendSpace1D([1, 3]);
    const blend2D = new BlendSpace2D(
      [
        [0, 1],
        [0, 3],
        [1, 1],
      ],
      [[0, 1, 2]],
    );
    const weights = new Float64Array(3);
    const ground = new GroundSnap(rig.root);
    const pose = new CompositionPose(rig, animation, ground);
    const character = new CompositionCharacter(
      animation,
      body,
      () => pose.restore(),
      () => pose.apply(),
    );
    animation.mixer.addEventListener("finished", ({ action }) => {
      if (action.getClip().name === "layer:reload") history.reloadFinished += 1;
    });
    let frozen = false;
    this.#character = character;
    ctx.afterPhysics(() => {
      character.afterPhysics();
      history.blocked += animation.blocked ? 1 : 0;
      ctx.state.set({
        history: { ...history },
        phase: animation.phase,
        lowerError: pose.lowerError,
        zeroError: pose.zeroError,
        layersRemoved: pose.layersRemoved,
        poseBeforeIK: pose.poseBeforeIK,
        ikError: pose.ikError,
        bodyZ: object.position.z,
        paused: animation.paused,
        skinRootZ: rig.bones[0]?.position.z,
        feetClearance: ground.clearance,
        actions: animation.resources.actions,
      });
    });
    ctx.entities.add("character", {
      mesh: object,
      debug: () => ({
        state: character.ticks === 0 ? "idle" : "composing",
        phase: animation.phase,
        position: object.position.toArray(),
      }),
      dispose: () => {
        character.dispose();
        rig.skin.skeleton.dispose();
      },
    });
    return (frame: CourseCtx, dt: number) => {
      if (frame.input.justPressed("lifecycle")) {
        void frame.goto("course");
        return;
      }
      if (frame.input.justPressed("reset")) {
        body.teleport({ x: 0, y: 0.85, z: 0 });
        history.reset += 1;
      }
      if (frame.input.justPressed("freeze")) {
        frozen = !frozen;
        history.pause += 1;
      }
      if (frame.input.justPressed("reload")) {
        pose.reloadWeight = 1;
        animation.setLayerWeight("reload", 1);
        animation.restartLayer("reload");
        history.reload += 1;
      }
      if (frame.input.justPressed("fire")) {
        pose.recoilWeight = 0.5;
        animation.setLayerWeight("recoil", 0.5);
        history.recoil += 1;
      }
      if (frame.input.justPressed("cancel")) {
        pose.reloadWeight = 0;
        pose.recoilWeight = 0;
        animation.setLayerWeight("reload", 0);
        animation.setLayerWeight("recoil", 0);
        history.cancelled += 1;
      }
      const forward = frame.input.pressed("forward");
      const strafe = frame.input.pressed("strafe");
      if (forward || strafe) {
        const speed = frame.input.pressed("run") ? 3 : 1;
        if (!strafe) {
          const selected = blend1D.sample(speed);
          weights[0] = selected[0] as number;
          weights[1] = selected[1] as number;
          weights[2] = 0;
          animation.setWeights(weights, 0.1);
        } else animation.setWeights(blend2D.sample(forward ? 0.5 : 1, 1), 0.1);
        if (forward && speed === 3) history.run += 1;
        else if (forward) history.walk += 1;
        if (strafe) history.strafe += 1;
      }
      animation.paused = frozen;
      animation.speed = forward || strafe ? 1 : 0;
      character.update(dt);
    };
  }

  override exit(): void {
    if (this.#character !== undefined) {
      this.#character.dispose();
      const resources = this.#character.animation.resources;
      history.exitActions = resources.actions;
      history.exitOwnedBytes =
        resources.scratchBytes + resources.clipBufferBytes + resources.rootBufferBytes;
      history.clipsUnchanged = sourceClipBytes() === originalClips;
      history.cycles += 1;
      if (history.exitActions !== 0 || history.exitOwnedBytes !== 0 || !history.clipsUnchanged)
        throw new Error(
          "Composition scene exit did not release owned animation resources or changed shared clips.",
        );
    }
    this.#benchmark?.dispose();
    for (const body of this.#rigids) body.dispose();
    this.#rigids = [];
    this.#source?.skin.skeleton.dispose();
    this.#source?.geometry.dispose();
    this.#source?.material.dispose();
    this.#cleanLook?.();
    this.#source = undefined;
    this.#character = undefined;
    this.#benchmark = undefined;
  }
}
