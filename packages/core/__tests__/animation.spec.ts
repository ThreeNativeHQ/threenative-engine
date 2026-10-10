import {
  AnimationClip,
  AnimationMixer,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Object3D,
  PropertyBinding,
  Skeleton,
  SkinnedMesh,
  VectorKeyframeTrack,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer } from "../src/animation.js";
import { SkeletalMesh3D } from "../src/skeletal-mesh.js";

describe("AnimationPlayer", () => {
  it("should say how to fix a duplicate clip name rather than only that there is one", () => {
    const root = new Object3D();
    const first = new AnimationClip("A_TPose", 1, []);
    const second = new AnimationClip("A_TPose", 1, []);
    // Two stock animation libraries built on one rig both ship a bind pose under this name, which
    // is what a game hits the moment it loads a second `.glb` of clips.
    expect(() => new AnimationPlayer({ clips: [first, second], root })).toThrow(
      /Duplicate animation clip 'A_TPose'\. Two clip sources define it; keep one per name/,
    );
  });

  it("crossfades named clips while keeping action weights normalized", () => {
    const root = new Object3D();
    const idle = new AnimationClip("idle", 1, []);
    const run = new AnimationClip("run", 1, []);
    const player = new AnimationPlayer({ clips: [idle, run], root });

    player.play("idle");
    player.update(1 / 60);
    player.play("run", { fade: 0.5 });

    const weights = () =>
      player.mixer.clipAction(idle).getEffectiveWeight() +
      player.mixer.clipAction(run).getEffectiveWeight();
    expect(weights()).toBeCloseTo(1);
    player.update(0.25);
    expect(weights()).toBeCloseTo(1);
    expect(player.current).toBe("run");
  });

  it("should not pop the pose when a crossfade is interrupted by another clip", () => {
    const root = new Object3D();
    const idle = new AnimationClip("idle", 1, []);
    const run = new AnimationClip("run", 1, []);
    const hit = new AnimationClip("hit", 1, []);
    const player = new AnimationPlayer({ clips: [idle, run, hit], root });
    const weightOf = (clip: AnimationClip): number =>
      player.mixer.clipAction(clip).getEffectiveWeight();
    const total = (): number => weightOf(idle) + weightOf(run) + weightOf(hit);

    player.play("idle");
    player.update(1 / 60);
    player.play("run", { fade: 0.4 });
    player.update(0.2); // halfway: idle and run both contribute

    const runBefore = weightOf(run);
    const idleBefore = weightOf(idle);
    expect(runBefore).toBeGreaterThan(0.1);
    expect(idleBefore).toBeGreaterThan(0.1);

    // Interrupt mid-blend. Nothing may jump: previously `idle` was hard-stopped to 0 and
    // `run` was snapped to 1 in this single call, which is a visible pop on the character.
    player.play("hit", { fade: 0.4 });

    expect(weightOf(run)).toBeCloseTo(runBefore, 3);
    expect(weightOf(idle)).toBeCloseTo(idleBefore, 3);
    expect(weightOf(hit)).toBeCloseTo(0, 3);
    expect(total()).toBeCloseTo(1, 3);

    // ...and the blend still completes on the new clip.
    player.update(0.4);
    expect(weightOf(hit)).toBeCloseTo(1, 3);
    expect(total()).toBeCloseTo(1, 3);
    expect(player.current).toBe("hit");
  });

  it("preserves weight and phase when returning to a still-contributing loop", () => {
    const root = new Object3D();
    const idle = new AnimationClip("idle", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [1, 2]),
    ]);
    const run = new AnimationClip("run", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [3, 4]),
    ]);
    const player = new AnimationPlayer({ clips: [idle, run], root, strideSync: false });
    const idleAction = player.mixer.clipAction(idle);
    const runAction = player.mixer.clipAction(run);
    player.play("idle");
    player.update(0.1);
    player.play("run", { fade: 0.4 });
    player.update(0.2);
    player.update(0); // sample the current blend without advancing either clip
    const poseBefore = root.position.x;
    const phaseBefore = idleAction.time;

    player.play("idle", { fade: 0.4 });

    expect(idleAction.getEffectiveWeight()).toBeCloseTo(0.5, 6);
    expect(idleAction.time).toBe(phaseBefore);
    player.update(0);
    expect(root.position.x).toBeCloseTo(poseBefore, 6);
    player.update(0.2);
    expect(idleAction.getEffectiveWeight()).toBeCloseTo(0.75, 6);
    expect(runAction.getEffectiveWeight()).toBeCloseTo(0.25, 6);
    player.update(0.2);
    expect(idleAction.getEffectiveWeight()).toBe(1);
    expect(runAction.isScheduled()).toBe(false);
    player.dispose();
  });

  it("keeps rapid idle/walk/run/idle requests normalized before a frame advances", () => {
    const clips = ["idle", "walk", "run"].map((name) => new AnimationClip(name, 1, []));
    const player = new AnimationPlayer({ clips, root: new Object3D() });
    player.play("idle");
    for (const name of ["walk", "run", "idle", "run", "walk", "idle"]) {
      player.play(name, { fade: 0.4 });
      const weights = clips.map((clip) => player.mixer.clipAction(clip).getEffectiveWeight());
      expect(weights.every((weight) => Number.isFinite(weight) && weight >= 0)).toBe(true);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
    }
    player.update(0.4);
    expect(player.mixer.clipAction(player.clip("idle")).getEffectiveWeight()).toBe(1);
    player.dispose();
  });

  it("starts a requested fade at full weight when no actions are scheduled", () => {
    const root = new Object3D();
    const clips = ["idle", "walk", "run"].map(
      (name, index) =>
        new AnimationClip(name, 1, [
          new NumberKeyframeTrack(".position[x]", [0, 1], [index + 1, index + 1]),
        ]),
    );
    const player = new AnimationPlayer({ clips, root, strideSync: false });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      player.play("walk", { fade: 0.4 });
      player.update(0);
      expect(root.position.x).toBe(2);
      expect(player.mixer.stats.actions.inUse).toBe(1);
      player.stop();
      expect(player.mixer.stats.actions.inUse).toBe(0);
    }
    player.dispose();
    expect(player.mixer.stats.actions.total).toBe(0);
  });

  it.each(["once", "loop"] as const)(
    "restarts a still-contributing clip when explicitly changing it to %s",
    (mode) => {
      const root = new Object3D();
      const first = new AnimationClip("first", 1, [
        new NumberKeyframeTrack(".position[x]", [0, 1], [1, 2]),
      ]);
      const other = new AnimationClip("other", 1, []);
      const player = new AnimationPlayer({ clips: [first, other], root, strideSync: false });
      player.play("first", { mode: mode === "loop" ? "once" : "loop" });
      player.update(0.1);
      player.play("other", { fade: 0.4 });
      player.update(0.2);
      player.play("first", { fade: 0.4, mode });
      expect(player.mixer.clipAction(first).time).toBe(0);
      expect(player.mixer.clipAction(first).getEffectiveWeight()).toBeCloseTo(0.5, 6);
      player.update(1.1);
      expect(player.finished).toBe(mode === "once");
      player.dispose();
    },
  );

  it("restarts a loop on an immediate cut and after its previous fade has finished", () => {
    const root = new Object3D();
    const clips = ["idle", "run"].map((name) => new AnimationClip(name, 1, []));
    const player = new AnimationPlayer({ clips, root });
    for (const elapsed of [0.2, 0.4]) {
      player.play("idle");
      player.update(0.1);
      player.play("run", { fade: 0.4 });
      player.update(elapsed);
      player.play("idle", { fade: elapsed === 0.2 ? 0 : 0.4 });
      expect(player.mixer.clipAction(player.clip("idle")).time).toBe(0);
      player.stop();
    }
    player.dispose();
  });

  it("keeps deterministic sampled bone poses through repeated rapid reversals", () => {
    const trace = () => {
      const bone = new Bone();
      bone.name = "Hip";
      const root = new Group();
      root.add(bone);
      const clips = ["idle", "walk", "run"].map(
        (name, index) =>
          new AnimationClip(name, 1, [
            new NumberKeyframeTrack("Hip.position[x]", [0, 0.5, 1], [index, index + 1, index]),
          ]),
      );
      const player = new AnimationPlayer({ clips, root, strideSync: false });
      player.play("idle");
      const poses: number[] = [];
      for (const name of ["walk", "run", "idle", "run", "walk", "idle"]) {
        player.update(0.1);
        player.update(0);
        const before = bone.position.x;
        player.play(name, { fade: 0.4 });
        player.update(0);
        expect(bone.position.x).toBeCloseTo(before, 6);
        poses.push(bone.position.x);
        const weights = clips.map((clip) => player.mixer.clipAction(clip).getEffectiveWeight());
        expect(weights.every((weight) => Number.isFinite(weight) && weight >= 0)).toBe(true);
        expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
      }
      player.update(0.4);
      player.update(0);
      expect(player.mixer.stats.actions.inUse).toBe(1);
      player.dispose();
      expect(player.mixer.stats.actions.total).toBe(0);
      return poses;
    };
    expect(trace()).toEqual(trace());
  });

  it("should ease the blend rather than ramp it linearly", () => {
    const root = new Object3D();
    const idle = new AnimationClip("idle", 1, []);
    const run = new AnimationClip("run", 1, []);
    const player = new AnimationPlayer({ clips: [idle, run], root });

    player.play("idle");
    player.update(1 / 60);
    player.play("run", { fade: 1 });
    player.update(0.25);

    // A linear ramp would sit at 0.25 here; smoothstep(0.25) is ~0.156.
    const weight = player.mixer.clipAction(run).getEffectiveWeight();
    expect(weight).toBeLessThan(0.22);
    expect(weight).toBeGreaterThan(0.1);
  });

  it("throws on an unknown clip and reports mixer advancement", () => {
    const player = new AnimationPlayer({
      clips: [new AnimationClip("idle", 1, [])],
      root: new Object3D(),
    });

    expect(() => player.play("missing")).toThrow("Unknown animation clip 'missing'.");
    player.play("idle");
    player.update(1 / 60);
    expect(player.advancedFrames).toBe(1);
  });

  it("normalizes an interrupted crossfade", () => {
    const root = new Object3D();
    const clips = ["idle", "run", "jump"].map((name) => new AnimationClip(name, 1, []));
    const player = new AnimationPlayer({ clips, root });
    const weights = () =>
      clips.reduce((sum, clip) => sum + player.mixer.clipAction(clip).getEffectiveWeight(), 0);

    player.play("idle");
    player.play("run", { fade: 0.1 });
    player.update(0.01);
    player.play("jump", { fade: 0.1 });
    player.update(0.01);

    expect(weights()).toBeCloseTo(1);
  });

  it("holds the last frame and reports completion for one-shot clips", () => {
    const root = new Object3D();
    const once = new AnimationClip("once", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const player = new AnimationPlayer({ clips: [once], root });

    player.play("once", { mode: "once" });
    player.update(0.9);
    expect(player.finished).toBe(false);
    expect(root.position.x).toBeCloseTo(0.9);

    player.update(0.2);
    expect(player.finished).toBe(true);
    expect(root.position.x).toBeCloseTo(1);

    player.update(1);
    expect(player.finished).toBe(true);
    expect(root.position.x).toBeCloseTo(1);

    // A held last frame is not animation progress: three advances mixer.time every update
    // even when nothing animates, so advancedFrames must stop at the finished clip or
    // playtest evaluators read idle frames as proof the clip animated.
    const frozen = player.advancedFrames;
    player.update(1);
    player.update(1);
    expect(player.advancedFrames).toBe(frozen);
  });

  it("applies a mode change when the requested clip is already current", () => {
    const root = new Object3D();
    const clip = new AnimationClip("clip", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const player = new AnimationPlayer({ clips: [clip], root });

    player.play("clip");
    player.update(0.25);
    player.play("clip", { mode: "once" });
    player.update(1.1);

    expect(player.finished).toBe(true);
    expect(root.position.x).toBeCloseTo(1);
  });

  it("replays a finished one-shot when the requested clip is already current", () => {
    const root = new Object3D();
    const clip = new AnimationClip("clip", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const player = new AnimationPlayer({ clips: [clip], root });

    player.play("clip", { mode: "once" });
    player.update(1.1);
    expect(player.finished).toBe(true);

    player.play("clip", { mode: "once" });
    expect(player.finished).toBe(false);
    expect(player.advancedFrames).toBe(0);
    player.update(0.25);

    expect(root.position.x).toBeCloseTo(0.25);
  });

  it("defaults a finished one-shot replay to looping", () => {
    const root = new Object3D();
    const clip = new AnimationClip("clip", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const player = new AnimationPlayer({ clips: [clip], root });

    player.play("clip", { mode: "once" });
    player.update(1.1);
    expect(player.finished).toBe(true);

    player.play("clip");
    expect(player.finished).toBe(false);
    player.update(1.1);

    expect(player.finished).toBe(false);
    expect(root.position.x).toBeCloseTo(0.1);
  });

  it("keeps the default playback mode looping", () => {
    const root = new Object3D();
    const loop = new AnimationClip("loop", 1, [
      new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const player = new AnimationPlayer({ clips: [loop], root });

    player.play("loop");
    player.update(1.1);

    expect(player.finished).toBe(false);
    expect(root.position.x).toBeCloseTo(0.1);
  });
});

/**
 * Stride sync — the convention that a walking model covers the ground its feet cover.
 *
 * Measured in `sandbox/fps-framework` on 2026-08-25: a soldier patrolling at 2.31 m/s against a
 * walk clip that carries the body 1.31 m/s was played at rate 1.77, and on every patrol pause the
 * clip was switched to idle while the body was still sliding to a stop. Both halves read as wrong
 * to a player — feet spinning faster than the ground, then feet frozen while the body drifts —
 * and both are the same missing mechanism, hand-rolled in that game and in every other one.
 */
describe("AnimationPlayer stride sync", () => {
  const walkClip = () =>
    new AnimationClip("walk", 2, [
      // Two seconds carrying the rig two metres along +z: one metre per clip second.
      new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
    ]);

  /**
   * The shape a real character has: a body the game moves, with the animated rig parented under
   * it. Measuring the rig itself would read the clip's own root track back as if the body had
   * travelled, which is why `strideRoot` exists.
   */
  const character = (options: { strideSync?: boolean; clips: AnimationClip[] }) => {
    const body = new Object3D();
    const rig = new Object3D();
    body.add(rig);
    const player = new AnimationPlayer({
      clips: options.clips,
      root: rig,
      strideRoot: body,
      ...(options.strideSync === undefined ? {} : { strideSync: options.strideSync }),
    });
    return { body, player };
  };

  it("measures a clip's own ground speed from its root track", () => {
    const { player } = character({ clips: [walkClip()] });
    player.play("walk");
    expect(player.stride.clipGroundSpeed).toBeCloseTo(1, 3);
  });

  it("matches playback rate to the ground the body actually covers", () => {
    const { body, player } = character({ clips: [walkClip()] });
    player.play("walk");
    player.update(1 / 60);
    // Two metres per second over a clip that carries one: the feet have to cycle twice as fast.
    body.position.z += 2 * (1 / 60);
    player.update(1 / 60);
    expect(player.stride.groundSpeed).toBeCloseTo(2, 1);
    expect(player.stride.rate).toBeCloseTo(2, 1);
    expect(player.mixer.clipAction(player.clip("walk")).getEffectiveTimeScale()).toBeCloseTo(2, 1);
  });

  it("leaves a clip that carries no ground alone", () => {
    const idle = new AnimationClip("idle", 1, [
      new VectorKeyframeTrack(".position", [0, 1], [0, 0, 0, 0, 0, 0]),
    ]);
    const { body, player } = character({ clips: [idle] });
    player.play("idle");
    player.update(1 / 60);
    body.position.z += 2 * (1 / 60);
    player.update(1 / 60);
    // An idle is not locomotion, so nothing about it is warped by how the body is moving.
    expect(player.stride.synced).toBe(false);
    expect(player.mixer.clipAction(idle).getEffectiveTimeScale()).toBe(1);
  });

  /**
   * "Turning a convention off must not turn its measurement off, and honest reporting when
   * overridden" — the house rule this class has to satisfy to ship the convention on by default.
   */
  it("keeps measuring, and says so, when a game turns it off", () => {
    const { body, player } = character({ clips: [walkClip()], strideSync: false });
    player.play("walk");
    player.update(1 / 60);
    body.position.z += 2 * (1 / 60);
    player.update(1 / 60);
    expect(player.stride.groundSpeed).toBeCloseTo(2, 1);
    expect(player.stride.rate).toBeCloseTo(2, 1);
    expect(player.stride.synced).toBe(false);
    expect(player.stride.overridden).toBe(true);
    // The rate is measured and reported, and deliberately not applied.
    expect(player.mixer.clipAction(player.clip("walk")).getEffectiveTimeScale()).toBe(1);
  });

  it("holds the clip at its slowest honest rate rather than freezing a stopped body", () => {
    const { player } = character({ clips: [walkClip()] });
    player.play("walk");
    player.update(1 / 60);
    player.update(1 / 60); // the body did not move at all
    expect(player.stride.rate).toBeGreaterThan(0);
    expect(player.stride.rate).toBeLessThan(1);
  });

  /**
   * Measured in `sandbox/fps-framework` on 2026-08-27: the enemy death clips carry 0.23–0.36 m/s
   * of hips root motion (the fall itself), and a dying body stands still, so stride sync clamped
   * every death to `STRIDE_RATE_MIN` — a 2.8 s fall spread over 19 s, and the corpse stood
   * upright through its whole respawn window. A `"once"` clip is an event — a death, a flinch, a
   * reload — authored at the rate the event happens at; the convention re-times locomotion, and
   * this is not locomotion.
   */
  it("leaves a one-shot clip at its authored rate even when the clip travels", () => {
    const death = new AnimationClip("death", 2, [
      // Two seconds carrying the rig two metres along +z — root motion, like a fall.
      new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
    ]);
    const { player } = character({ clips: [death] });
    player.play("death", { mode: "once" });
    player.update(1 / 60);
    player.update(1 / 60); // the body did not move at all — a corpse never does
    expect(player.mixer.clipAction(player.clip("death")).getEffectiveTimeScale()).toBe(1);
    // The convention scopes itself out; the game did not override anything.
    expect(player.stride.synced).toBe(false);
    expect(player.stride.overridden).toBe(false);
  });

  /** Backstop for the scoping above: a one-shot must not switch the convention off wholesale. */
  it("still re-times loop clips on the same player after a one-shot", () => {
    const death = new AnimationClip("death", 2, [
      new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
    ]);
    const { body, player } = character({ clips: [death, walkClip()] });
    player.play("death", { mode: "once" });
    player.update(1 / 60);
    player.play("walk");
    player.update(1 / 60);
    body.position.z += 2 * (1 / 60);
    player.update(1 / 60);
    expect(player.stride.rate).toBeCloseTo(2, 1);
    expect(player.stride.synced).toBe(true);
  });

  /**
   * PRD-385 decision B: the update no longer builds a report the reader may not ask for, so a
   * report a caller retained must keep the values it observed rather than being mutated in place.
   */
  it("keeps a retained stride report unchanged after a later update", () => {
    const { body, player } = character({ clips: [walkClip()] });
    player.play("walk");
    player.update(1 / 60);
    const retained = player.stride;
    expect(retained.groundSpeed).toBe(0);

    body.position.z += 2 * (1 / 60);
    player.update(1 / 60);
    const later = player.stride;

    expect(later).not.toBe(retained);
    expect(retained.groundSpeed).toBe(0);
    expect(later.groundSpeed).toBeCloseTo(2, 1);
  });
});

describe("SkeletalMesh3D shared character preparation", () => {
  function createMultiPrimitiveRigFixture() {
    const root = new Group();
    root.name = "source-rig";

    const hips = new Bone();
    hips.name = "Hips";
    const spine = new Bone();
    spine.name = "Spine";
    const head = new Bone();
    head.name = "Head";
    hips.add(spine);
    spine.add(head);
    root.add(hips);

    const bones = [hips, spine, head];
    const skeleton = new Skeleton(bones);

    // Primitive 1: body mesh
    const bodyGeom = new BufferGeometry();
    bodyGeom.setAttribute("position", new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 2, 0], 3));
    bodyGeom.setAttribute(
      "skinIndex",
      new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4),
    );
    bodyGeom.setAttribute(
      "skinWeight",
      new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    const bodyMesh = new SkinnedMesh(bodyGeom, new MeshBasicMaterial());
    bodyMesh.name = "body";
    bodyMesh.bind(skeleton);
    root.add(bodyMesh);

    // Primitive 2: fur/coat mesh (sharing bones)
    const furGeom = new BufferGeometry();
    furGeom.setAttribute("position", new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 2, 0], 3));
    furGeom.setAttribute(
      "skinIndex",
      new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4),
    );
    furGeom.setAttribute(
      "skinWeight",
      new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    const furMesh = new SkinnedMesh(furGeom, new MeshBasicMaterial());
    furMesh.name = "fur";
    furMesh.bind(skeleton);
    root.add(furMesh);

    return { root, bones, skeleton, bodyMesh, furMesh };
  }

  it("ensures clones of a multi-primitive rig animate independently", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const walkClip = new AnimationClip("walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 2]),
    ]);

    const first = new SkeletalMesh3D({
      source: fixture.root,
      clips: [walkClip],
      requiredClips: ["walk"],
    });
    const second = new SkeletalMesh3D({
      source: fixture.root,
      clips: [walkClip],
      requiredClips: ["walk"],
    });

    expect(first).toBeInstanceOf(AnimationPlayer);
    first.play("walk");
    first.update(0.5);

    const firstHips = first.root.getObjectByName("Hips");
    const secondHips = second.root.getObjectByName("Hips");
    expect(firstHips).toBeDefined();
    expect(secondHips).toBeDefined();
    expect(firstHips?.position.z).toBeCloseTo(1, 4);
    expect(secondHips?.position.z).toBe(0);

    const firstBody = first.root.getObjectByName("body") as SkinnedMesh;
    const secondBody = second.root.getObjectByName("body") as SkinnedMesh;
    expect(firstBody.skeleton.bones[0]).not.toBe(secondBody.skeleton.bones[0]);
  });

  it("negative control: plain Object3D.clone(true) fails independent animation by sharing bones", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const firstClone = fixture.root.clone(true);
    const secondClone = fixture.root.clone(true);

    const firstBody = firstClone.getObjectByName("body") as SkinnedMesh;
    const secondBody = secondClone.getObjectByName("body") as SkinnedMesh;
    // With plain clone, both SkinnedMesh instances share the exact same bone instances from the source fixture!
    expect(firstBody.skeleton.bones[0]).toBe(fixture.bones[0]);
    expect(secondBody.skeleton.bones[0]).toBe(fixture.bones[0]);
    expect(firstBody.skeleton.bones[0]).toBe(secondBody.skeleton.bones[0]);
  });

  it("proves two characters play different clips without mutating each other's skeleton", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const clipA = new AnimationClip("clipA", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 5]),
    ]);
    const clipB = new AnimationClip("clipB", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, -5]),
    ]);

    const charA = new SkeletalMesh3D({
      source: fixture.root,
      clips: [clipA, clipB],
      requiredClips: ["clipA", "clipB"],
    });
    const charB = new SkeletalMesh3D({
      source: fixture.root,
      clips: [clipA, clipB],
      requiredClips: ["clipA", "clipB"],
    });

    charA.play("clipA");
    charB.play("clipB");
    charA.update(0.5);
    charB.update(0.5);

    const hipsA = charA.root.getObjectByName("Hips");
    const hipsB = charB.root.getObjectByName("Hips");
    expect(hipsA).toBeDefined();
    expect(hipsB).toBeDefined();
    expect(hipsA?.position.z).toBeCloseTo(2.5, 3);
    expect(hipsB?.position.z).toBeCloseTo(-2.5, 3);
  });

  it("ensures stride measurement reads the motion root rather than the transform the mixer writes", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const travellingClip = new AnimationClip("walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 2]),
    ]);

    const body = new Group();
    const char = new SkeletalMesh3D({
      source: fixture.root,
      clips: [travellingClip],
      requiredClips: ["walk"],
      strideRoot: body,
    });
    body.add(char.root);

    char.play("walk");
    char.update(1 / 60);
    // Mixer moved the rig's internal Hips, but the body has not moved yet:
    expect(body.position.z).toBe(0);

    // Now the game moves the body by 2 metres/second:
    body.position.z += 2 * (1 / 60);
    char.update(1 / 60);

    expect(char.stride.groundSpeed).toBeCloseTo(2, 1);
    expect(char.stride.rate).toBeCloseTo(1, 1);
  });

  it("normalises rendered size with skin-aware measurement", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const instance = new SkeletalMesh3D({
      source: fixture.root,
      size: { axis: "longest", metres: 1 },
    });

    expect(instance.root.scale.x).toBeCloseTo(0.5, 4);
  });

  it("maps an object-valued top option onto the cloned rig", () => {
    const fixture = createMultiPrimitiveRigFixture();
    fixture.bones[1]?.position.set(0, 1, 0);
    fixture.bones[2]?.position.set(0, 2, 0);
    const translatedParent = new Group();
    translatedParent.position.y = 10;
    translatedParent.add(fixture.root);

    const instance = new SkeletalMesh3D({
      source: fixture.root,
      size: { axis: "height", metres: 4, top: fixture.bones[2] },
    });

    expect(instance.root.scale.y).toBeCloseTo(4 / 3, 4);
  });

  it("fails at load time when a requested clip is missing, including the historically bad doe clip map", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const doeIdle = new AnimationClip("ANIM_DeerDoe_IdleBreathe", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 0]),
    ]);
    const doeWalk = new AnimationClip("ANIM_DeerDoe_Walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 1]),
    ]);

    const BAD_DOE_CLIPS = {
      idle: "ANIM_DeerStag_IdleBreathe",
      walk: "ANIM_DeerStag_Walk",
      run: "ANIM_DeerStag_Run",
    };

    expect(() => {
      new SkeletalMesh3D({
        source: fixture.root,
        clips: [doeIdle, doeWalk],
        requiredClips: BAD_DOE_CLIPS,
      });
    }).toThrow(/missing required clip 'ANIM_DeerStag_IdleBreathe'/);
  });

  it("fails at load time when a requested clip binds 0 tracks to the rig", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const alienClip = new AnimationClip("alien_clip", 1, [
      new VectorKeyframeTrack("AlienBone.position", [0, 1], [0, 0, 0, 0, 0, 1]),
    ]);

    expect(() => {
      new SkeletalMesh3D({
        source: fixture.root,
        clips: [alienClip],
        requiredClips: ["alien_clip"],
      });
    }).toThrow(/binds 0 tracks/);
  });

  it("fails at load time when a named required clip has no tracks", () => {
    const fixture = createMultiPrimitiveRigFixture();
    const emptyClip = new AnimationClip("empty_clip", 1, []);

    expect(() => {
      new SkeletalMesh3D({
        source: fixture.root,
        clips: [emptyClip],
        requiredClips: ["empty_clip"],
      });
    }).toThrow(/has no tracks/);
  });

  it("fails closed when required clip map values are malformed", () => {
    const fixture = createMultiPrimitiveRigFixture();

    expect(() => {
      new SkeletalMesh3D({
        source: fixture.root,
        requiredClips: { idle: undefined } as unknown as Readonly<Record<string, string>>,
      });
    }).toThrow(/requiredClips/);
  });
});

/**
 * Stride sync against the clips games actually ship: in-place locomotion.
 *
 * Every clip above carries the rig along a root track, which is the minority authoring
 * convention. The majority — every ActorX/Unreal export, every Mixamo "in place" clip, every
 * stock animal pack — animates the body on the spot and leaves travel entirely to game code.
 *
 * Measured in `sandbox/wildwood` on 2026-09-03 against the PROTOFACTOR animal pack: the true root
 * bone of `ANIM_DeerStag_Walk` carries 0.00000 units of translation, but the clip writes local
 * translation tracks on `STAG_-R-Thigh` and `STAG_-Tail`. `#groundSpeedOf` took the longest
 * horizontal displacement of ANY `.position` track, so a swinging thigh was read as the body's
 * root motion at 0.1287 u/clip-second. Against a 1.3 m/s walk that asks for rate 10.10, clamped
 * to the 3.0 ceiling — so the stag's legs cycled at 3.0x for the whole game while its own stride
 * justifies 1.03x. The owner reported it as "legs ultra fast, but he's moving slowly".
 */
describe("AnimationPlayer stride sync on in-place clips", () => {
  /** A body the game moves, with the animated rig parented under it. */
  const character = (options: { clips: AnimationClip[]; scale?: number }) => {
    const body = new Object3D();
    const rig = new Object3D();
    const foot = new Object3D();
    foot.name = "Foot";
    rig.add(foot);
    body.add(rig);
    if (options.scale !== undefined) body.scale.setScalar(options.scale);
    const player = new AnimationPlayer({ clips: options.clips, root: rig, strideRoot: body });
    return { body, player };
  };

  /**
   * The shape of a real in-place clip: the root never translates, and a limb carries a local
   * translation track that swings back and forth without ever going anywhere.
   */
  const swingingLimb = () =>
    new AnimationClip("walk", 2, [
      new VectorKeyframeTrack("Foot.position", [0, 1, 2], [0, 0, 0.3, 0, 0, -0.3, 0, 0, 0.3]),
    ]);

  it("does not read a swinging limb as the body's root motion", () => {
    const { body, player } = character({ clips: [swingingLimb()] });
    player.play("walk");
    player.update(1 / 60);
    body.position.z += 1 * (1 / 60);
    player.update(1 / 60);
    // The limb goes nowhere: 0.6 units of swing per 2 seconds is not 0.3 m/s of ground.
    expect(player.stride.clipGroundSpeed).toBe(0);
    expect(player.stride.rate).toBe(1);
    expect(player.stride.synced).toBe(false);
  });

  it("says out loud that a clip carries no stride to match, so an override can be seen", () => {
    const { player } = character({ clips: [swingingLimb()] });
    player.play("walk");
    player.update(1 / 60);
    // `synced: false, overridden: false` is what an idle reports too. A game whose walk cycle is
    // not being matched has to be able to tell the two apart.
    expect(player.stride.inPlace).toBe(true);
  });

  /**
   * A clip's translation values are in the rig's own units; the ground the body covers is in
   * world metres. `normaliseToMetres` — the framework's own convention for sizing an import —
   * guarantees the two differ, so the comparison has to cross that scale.
   */
  it("measures a clip's ground speed in the world's metres, not the rig's units", () => {
    const clip = new AnimationClip("walk", 2, [
      new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
    ]);
    const { body, player } = character({ clips: [clip], scale: 0.5 });
    player.play("walk");
    player.update(1 / 60);
    // One unit per clip-second on a rig rendered at half scale is half a metre per clip-second.
    expect(player.stride.clipGroundSpeed).toBeCloseTo(0.5, 3);
    body.position.z += 0.5 * (1 / 60);
    player.update(1 / 60);
    expect(player.stride.rate).toBeCloseTo(1, 1);
  });

  /**
   * The convention doing its job on the clips games ship.
   *
   * A planted foot sweeps backward relative to the body at exactly the body's ground speed, so
   * the stance phase of an in-place cycle states the speed the clip was authored for even though
   * nothing in it translates. Stance is where the contact bone is at the bottom of its own arc.
   */
  const plantedWalk = () =>
    new AnimationClip("walk", 1, [
      new VectorKeyframeTrack(
        "Foot.position",
        [0, 0.6, 0.8, 1],
        [0, 0, 0.25, 0, 0, -0.35, 0, 0.25, 0, 0, 0, 0.25],
      ),
    ]);

  it("reads the sampled rig's world positions without re-walking each bone's ancestors", () => {
    // One world update per sampled frame covers the rig; a per-bone walk costs a native back end
    // one engine call per ancestor per bone per frame.
    const { body, player } = character({ clips: [plantedWalk()] });
    const rig = new Set<Object3D>();
    (body.children[0] as Object3D).traverse((object) => rig.add(object));
    const walked: Object3D[] = [];
    const update = Object3D.prototype.updateWorldMatrix;
    const spy = vi.spyOn(Object3D.prototype, "updateWorldMatrix").mockImplementation(function (
      this: Object3D,
      ...args
    ) {
      if (rig.has(this)) walked.push(this);
      return update.apply(this, args);
    });
    try {
      player.play("walk");
      player.update(1 / 60);
    } finally {
      spy.mockRestore();
    }
    expect(player.stride.clipGroundSpeed).toBeCloseTo(1, 1);
    expect(walked).toEqual([]);
  });

  it("matches an in-place walk cycle from the ground its planted foot sweeps", () => {
    const { body, player } = character({ clips: [plantedWalk()] });
    player.play("walk");
    player.update(1 / 60);
    // 0.6 units of backward sweep over the 0.6 s the foot is down: a 1 m/s walk cycle.
    expect(player.stride.clipGroundSpeed).toBeCloseTo(1, 1);
    expect(player.stride.inPlace).toBe(true);
    // The body is walked at twice that, so the cycle has to run at twice the rate.
    for (let frame = 0; frame < 4; frame += 1) {
      body.position.z += 2 * (1 / 60);
      player.update(1 / 60);
    }
    expect(player.stride.rate).toBeCloseTo(2, 1);
    expect(player.stride.synced).toBe(true);
  });
});

/**
 * Shared preparation across clones of one source.
 *
 * A party of identical characters built from one GLB pays for the binding audit and the
 * foot-plant sample once per member. The reuse is guarded by content signatures, so an edited
 * source, clip or clone falls back to its own measurement — a fast answer is never a stale one.
 */
describe("SkeletalMesh3D shared preparation reuse", () => {
  /** Three bones plus a clip that drives all of them and carries no root motion. */
  const fixture = () => {
    const root = new Group();
    root.name = "source-rig";
    const hips = new Bone();
    hips.name = "Hips";
    const spine = new Bone();
    spine.name = "Spine";
    const foot = new Bone();
    foot.name = "Foot";
    const prop = new Object3D();
    prop.name = "Prop";
    hips.add(spine);
    spine.add(foot);
    hips.add(prop);
    root.add(hips);
    return { root, hips, spine, foot, prop };
  };

  const inPlaceClip = () =>
    new AnimationClip("walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 0.5, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0]),
      new VectorKeyframeTrack("Spine.position", [0, 0.5, 1], [0, 0, 0, 0, 0, 0.2, 0, 0, 0]),
      new VectorKeyframeTrack("Foot.position", [0, 0.5, 1], [0, 0.5, 0.5, 0, 0, 0.25, 0, 0.5, 0.5]),
    ]);

  const strideOf = (player: SkeletalMesh3D): number => {
    player.play("walk");
    return player.stride.clipGroundSpeed;
  };

  it("performs one binding audit for equivalent required-clip clones", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    const bind = vi.spyOn(PropertyBinding.prototype, "bind");
    try {
      new SkeletalMesh3D({ source: root, clips: [clip], requiredClips: ["walk"] });
      const afterFirst = bind.mock.calls.length;
      expect(afterFirst).toBe(3);
      new SkeletalMesh3D({ source: root, clips: [clip], requiredClips: ["walk"] });
      expect(bind.mock.calls.length).toBe(afterFirst);
    } finally {
      bind.mockRestore();
    }
  });

  it("performs one foot-plant sample for equivalent in-place clones", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      const first = new SkeletalMesh3D({ source: root, clips: [clip] });
      strideOf(first);
      const afterFirst = setTime.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      const second = new SkeletalMesh3D({ source: root, clips: [clip] });
      strideOf(second);
      expect(setTime.mock.calls.length).toBe(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("shares the stride across uniformly scaled clones and rescales the reported value", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    const firstBody = new Group();
    const secondBody = new Group();
    secondBody.scale.setScalar(2);
    const first = new SkeletalMesh3D({ source: root, clips: [clip] });
    firstBody.add(first.root);
    const second = new SkeletalMesh3D({ source: root, clips: [clip] });
    secondBody.add(second.root);
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      const firstStride = strideOf(first);
      const afterFirst = setTime.mock.calls.length;
      const secondStride = strideOf(second);
      expect(secondStride).toBeCloseTo(firstStride * 2, 4);
      expect(setTime.mock.calls.length).toBe(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("keeps per-instance measurement under a non-uniform world scale", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    const body = new Group();
    body.scale.set(2, 1, 1);
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
      const afterFirst = setTime.mock.calls.length;
      const scaled = new SkeletalMesh3D({ source: root, clips: [clip] });
      body.add(scaled.root);
      strideOf(scaled);
      // A non-uniform scale cannot be normalized, so this clone measures its own stride.
      expect(setTime.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("misses the audit when the source hierarchy changes between clones", () => {
    const { root, hips } = fixture();
    const clip = inPlaceClip();
    new SkeletalMesh3D({ source: root, clips: [clip], requiredClips: ["walk"] });
    const extra = new Bone();
    extra.name = "Extra";
    hips.add(extra);
    const bind = vi.spyOn(PropertyBinding.prototype, "bind");
    try {
      new SkeletalMesh3D({ source: root, clips: [clip], requiredClips: ["walk"] });
      expect(bind.mock.calls.length).toBeGreaterThan(0);
    } finally {
      bind.mockRestore();
    }
  });

  it("misses the shared stride when a clip's keyframe content changes", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      const track = clip.tracks[2] as VectorKeyframeTrack;
      track.values[1] = 0.9;
      strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
      expect(setTime.mock.calls.length).toBeGreaterThan(0);
    } finally {
      setTime.mockRestore();
    }
  });

  it("does not share when a clip leaves a bone undriven", () => {
    const { root } = fixture();
    const partial = new AnimationClip("walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 0]),
      new VectorKeyframeTrack("Foot.position", [0, 0.5, 1], [0, 0.5, 0.5, 0, 0, 0.25, 0, 0.5, 0.5]),
    ]);
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      strideOf(new SkeletalMesh3D({ source: root, clips: [partial] }));
      const afterFirst = setTime.mock.calls.length;
      strideOf(new SkeletalMesh3D({ source: root, clips: [partial] }));
      expect(setTime.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("does not share a rig with an ambiguous duplicate node name", () => {
    const { root, spine } = fixture();
    const clip = inPlaceClip();
    const duplicate = new Bone();
    duplicate.name = "Spine";
    spine.add(duplicate);
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
      const afterFirst = setTime.mock.calls.length;
      strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
      expect(setTime.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("misses the shared stride when an untracked prop moves on a clone", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      const second = new SkeletalMesh3D({ source: root, clips: [clip] });
      // The prop is not driven by the clip, so its local transform is what the sample starts
      // from; moving it on this clone must not be served another clone's value.
      second.root.getObjectByName("Prop")?.position.setX(1);
      strideOf(second);
      expect(setTime.mock.calls.length).toBeGreaterThan(0);
    } finally {
      setTime.mockRestore();
    }
  });

  it("keeps per-instance measurement under a non-uniform world scale", () => {
    const { root } = fixture();
    const clip = inPlaceClip();
    const setTime = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      strideOf(new SkeletalMesh3D({ source: root, clips: [clip] }));
      const afterFirst = setTime.mock.calls.length;
      const scaled = new SkeletalMesh3D({ source: root, clips: [clip] });
      const body = new Group();
      body.scale.set(2, 1, 1);
      body.add(scaled.root);
      strideOf(scaled);
      // A non-uniform scale cannot be normalized, so this clone measures its own stride.
      expect(setTime.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      setTime.mockRestore();
    }
  });

  it("still fails through the constructor for a missing or zero-bound required clip", () => {
    const { root } = fixture();
    const alien = new AnimationClip("alien", 1, [
      new VectorKeyframeTrack("Alien.position", [0, 1], [0, 0, 0, 0, 0, 1]),
    ]);
    expect(
      () => new SkeletalMesh3D({ source: root, clips: [alien], requiredClips: ["missing"] }),
    ).toThrow(/missing required clip 'missing'/);
    expect(
      () => new SkeletalMesh3D({ source: root, clips: [alien], requiredClips: ["alien"] }),
    ).toThrow(/binds 0 tracks/);
  });
});
