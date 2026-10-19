import { AnimationClip, Object3D, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "../src/animation.js";

function rig() {
  const clips = [new AnimationClip("idle", 1, []), new AnimationClip("walk", 2, [])] as const;
  const player = new AnimationPlayer({ clips, root: new Object3D(), strideSync: false });
  const actions = [player.mixer.clipAction(clips[0]), player.mixer.clipAction(clips[1])] as const;
  const weights = () => actions.map((action) => action.getEffectiveWeight());
  return { player, actions, weights };
}

describe("weighted action ownership", () => {
  it("retimes a contributing walk even when idle has the dominant weight", () => {
    const body = new Object3D();
    const root = new Object3D();
    body.add(root);
    const idle = new AnimationClip("idle", 2, []);
    const walk = new AnimationClip("walk", 2, [
      new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
    ]);
    const player = new AnimationPlayer({ clips: [idle, walk], root, strideRoot: body });
    player.playWeighted([
      { clip: "idle", weight: 0.6 },
      { clip: "walk", weight: 0.4 },
    ]);
    player.update(0.01);
    body.position.z += 0.02;
    player.update(0.01);
    expect(player.mixer.clipAction(walk).getEffectiveTimeScale()).toBeCloseTo(2);
    expect(player.mixer.clipAction(idle).getEffectiveTimeScale()).toBe(1);
    player.dispose();
  });

  it("joins an entering loop at a finite phase after a static zero-duration clip", () => {
    const clips = [new AnimationClip("static", 0, []), new AnimationClip("walk", 2, [])] as const;
    const player = new AnimationPlayer({ clips, root: new Object3D(), strideSync: false });
    player.play("static");
    player.playWeighted([{ clip: "walk", weight: 1 }]);
    expect(player.mixer.clipAction(clips[1]).time).toBe(0);
    player.update(0.1);
    expect(player.mixer.clipAction(clips[1]).time).toBeCloseTo(0.1);
    player.dispose();
  });

  it("joins an entering loop to the contributing phase and preserves returning phase", () => {
    const { player, actions } = rig();
    player.play("idle");
    player.update(0.35);
    player.playWeighted([
      { clip: "idle", weight: 0.6 },
      { clip: "walk", weight: 0.4 },
    ]);
    expect(actions[1].time / 2).toBeCloseTo(actions[0].time);
    player.update(0.1);
    const before = actions.map((action) => action.time);
    player.playWeighted(
      [
        { clip: "idle", weight: 0.4 },
        { clip: "walk", weight: 0.6 },
      ],
      { transition: 0.5 },
    );
    expect(actions.map((action) => action.time)).toEqual(before);
    player.dispose();
  });

  it.each(
    [
      [],
      [{ clip: "missing", weight: 1 }],
      [{ clip: "idle", weight: -1 }],
      [{ clip: "idle", weight: Number.NaN }],
      [{ clip: "idle", weight: Number.POSITIVE_INFINITY }],
      [{ clip: "idle", weight: 0 }],
      [
        { clip: "idle", weight: 1 },
        { clip: "idle", weight: 2 },
      ],
    ].map((entries) => ({ entries })),
  )("rejects malformed weights before changing existing action ownership: %j", ({ entries }) => {
    const { player, actions, weights } = rig();
    player.play("idle");
    player.update(0.2);
    const before = weights();
    expect(() => player.playWeighted(entries)).toThrow();
    expect(weights()).toEqual(before);
    expect(actions[0].time).toBe(0.2);
    expect(actions[1].isScheduled()).toBe(false);
    player.dispose();
  });
  it("keeps the original deadline when the same targets are requested every frame", () => {
    const { player, actions, weights } = rig();
    player.playWeighted([{ clip: "idle", weight: 1 }]);
    for (let frame = 0; frame < 8; frame++) {
      player.playWeighted([{ clip: "walk", weight: 1 }], { transition: 1 });
      player.update(0.125);
    }
    expect(weights()).toEqual([0, 1]);
    expect(actions[0].isScheduled()).toBe(false);
    player.dispose();
  });

  it("preserves a contributing one-shot weight while converting it into a weighted loop", () => {
    const { player, actions, weights } = rig();
    player.play("idle", { mode: "once" });
    player.update(0.4);
    player.playWeighted(
      [
        { clip: "idle", weight: 0.7 },
        { clip: "walk", weight: 0.3 },
      ],
      { transition: 1 },
    );
    expect(weights()).toEqual([1, 0]);
    expect(actions[0].time).toBeCloseTo(0.4);
    player.update(0.5);
    expect(weights()[0]).toBeCloseTo(0.85);
    expect(weights()[1]).toBeCloseTo(0.15);
    player.update(0.5);
    expect(weights()).toEqual([0.7, 0.3]);
    player.dispose();
  });

  it("retains an outgoing loop until its requested transition reaches zero", () => {
    const { player, actions, weights } = rig();
    player.playWeighted([{ clip: "idle", weight: 1 }]);
    player.update(0.2);
    player.playWeighted([{ clip: "walk", weight: 1 }], { transition: 1 });
    expect(weights()).toEqual([1, 0]);
    expect(actions[0].isScheduled()).toBe(true);
    player.update(0.25);
    expect(weights()[0]).toBeCloseTo(0.75);
    expect(weights()[1]).toBeCloseTo(0.25);
    player.update(0.75);
    expect(weights()).toEqual([0, 1]);
    expect(actions[0].isScheduled()).toBe(false);
    player.dispose();
    expect(player.mixer.stats.actions.total).toBe(0);
  });

  it("interpolates the whole requested delta over the authored duration", () => {
    const { player, weights } = rig();
    player.playWeighted([
      { clip: "idle", weight: 0.8 },
      { clip: "walk", weight: 0.2 },
    ]);
    player.playWeighted(
      [
        { clip: "idle", weight: 0.2 },
        { clip: "walk", weight: 0.8 },
      ],
      { transition: 1 },
    );
    player.update(0.25);
    expect(weights()[0]).toBeCloseTo(0.65);
    expect(weights()[1]).toBeCloseTo(0.35);
    player.update(0.75);
    expect(weights()[0]).toBeCloseTo(0.2);
    expect(weights()[1]).toBeCloseTo(0.8);
    player.dispose();
  });

  it("starts a fresh rig with normalized weights even when a transition is requested", () => {
    const { player, weights } = rig();
    player.playWeighted(
      [
        { clip: "idle", weight: 1 },
        { clip: "walk", weight: 3 },
      ],
      { transition: 1 },
    );
    expect(weights()).toEqual([0.25, 0.75]);
    player.dispose();
  });

  it("normalizes finite large weights without overflow", () => {
    const { player, weights } = rig();
    player.playWeighted([
      { clip: "idle", weight: Number.MAX_VALUE },
      { clip: "walk", weight: Number.MAX_VALUE },
    ]);
    expect(weights()).toEqual([0.5, 0.5]);
    player.dispose();
  });

  it("hands a weighted rig back to the current single loop without resetting its phase", () => {
    const { player, actions, weights } = rig();
    player.playWeighted([
      { clip: "idle", weight: 0.7 },
      { clip: "walk", weight: 0.3 },
    ]);
    player.update(0.2);
    const phase = actions[0].time;
    player.play("idle");
    expect(weights()).toEqual([1, 0]);
    expect(actions[1].isScheduled()).toBe(false);
    expect(actions[0].time).toBe(phase);
    player.dispose();
  });

  it("reactivates a clamped one-shot as a progressing weighted loop", () => {
    const { player, actions } = rig();
    player.play("idle", { mode: "once" });
    player.update(1.1);
    expect(actions[0].paused).toBe(true);
    player.playWeighted([{ clip: "idle", weight: 1 }]);
    expect(actions[0].paused).toBe(false);
    const time = actions[0].time;
    player.update(0.1);
    expect(actions[0].time).not.toBe(time);
    player.dispose();
  });
});
