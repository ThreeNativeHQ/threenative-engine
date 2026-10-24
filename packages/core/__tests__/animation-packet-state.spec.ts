import { AnimationClip, AnimationMixer, Group, NumberKeyframeTrack } from "three";
import { describe, expect, it, vi } from "vitest";
import { readAnimationPacketState } from "../src/animation-packet-state.js";
import { AnimationPlayer } from "../src/animation.js";

function fixture(root = new Group()) {
  const clip = new AnimationClip("sway", 1, [
    new NumberKeyframeTrack(".rotation[z]", [0, 0.5, 1], [-0.09, 0.09, -0.09]),
  ]);
  const player = new AnimationPlayer({
    root,
    clips: [clip],
    strideSync: false,
    updateRate: 8,
  });
  player.play("sway");
  return { player, root, clip, action: player.mixer.clipAction(clip) };
}

describe("internal animation packet ownership", () => {
  it("reads held pending time and repeating seams without advancing the mixer", () => {
    const f = fixture();
    const mixer = new AnimationMixer(new Group());
    const action = mixer.clipAction(f.clip).play();
    let held = 0;
    for (let frame = 0; frame < 180; frame++) {
      f.player.update(1 / 60);
      mixer.update(1 / 60);
      const before = f.action.time;
      const snapshot = readAnimationPacketState(f.root);
      expect(snapshot?.time).toBeCloseTo(action.time, 12);
      expect(snapshot?.action).toBe(f.action);
      expect(snapshot?.clip).toBe(f.clip);
      expect(snapshot?.mixer).toBe(f.player.mixer);
      expect(snapshot?.evaluated).toBe(f.player.updateRateReport.evaluated);
      expect(f.action.time).toBe(before);
      if (!snapshot?.evaluated) held++;
    }
    expect(held).toBeGreaterThan(100);
    f.player.dispose();
  });

  it("finds the nearest genuine ancestor and removes disposed ownership", () => {
    const outer = fixture();
    const child = new Group();
    outer.root.add(child);
    expect(readAnimationPacketState(child)?.root).toBe(outer.root);
    const inner = fixture(child);
    inner.action.paused = true;
    expect(readAnimationPacketState(child)).toBeUndefined();
    inner.player.dispose();
    expect(readAnimationPacketState(child)?.root).toBe(outer.root);
    outer.player.dispose();
    expect(readAnimationPacketState(child)).toBeUndefined();
  });

  it("does not remove a replacement owner's reader", () => {
    const first = fixture();
    const second = fixture(first.root);
    first.player.dispose();
    expect(readAnimationPacketState(first.root)?.mixer).toBe(second.player.mixer);
    second.player.dispose();
  });

  it("rejects crossfade playback", () => {
    const root = new Group();
    const clips = ["a", "b"].map(
      (name) =>
        new AnimationClip(name, 1, [new NumberKeyframeTrack(".rotation[z]", [0, 1], [0, 0.1])]),
    );
    const player = new AnimationPlayer({ root, clips, strideSync: false, updateRate: 8 });
    player.play("a");
    player.play("b", { fade: 0.5 });
    expect(readAnimationPacketState(root)).toBeUndefined();
    player.dispose();
  });

  it("rejects custom methods and accessors without invoking author code", () => {
    const f = fixture();
    const author = vi.fn(() => {
      throw new Error("author sentinel");
    });
    const original = f.action.getClip;
    f.action.getClip = author;
    expect(readAnimationPacketState(f.root)).toBeUndefined();
    expect(author).not.toHaveBeenCalled();
    f.action.getClip = original;
    Object.defineProperty(f.action, "time", { configurable: true, get: author });
    expect(readAnimationPacketState(f.root)).toBeUndefined();
    expect(author).not.toHaveBeenCalled();
    Object.defineProperty(f.action, "time", { configurable: true, writable: true, value: 0 });
    f.player.dispose();
  });

  it("rejects paused, nonunit and nonfinite playback", () => {
    const f = fixture();
    for (const [key, value] of [
      ["paused", true],
      ["weight", 0.5],
      ["timeScale", 2],
      ["time", Number.NaN],
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(f.action, key);
      if (descriptor === undefined) throw new Error(`missing native action field ${key}`);
      Object.defineProperty(f.action, key, { ...descriptor, value });
      expect(readAnimationPacketState(f.root)).toBeUndefined();
      Object.defineProperty(f.action, key, descriptor);
    }
    f.player.dispose();
  });

  it("rejects reads during evaluation and preserves thrown callback identity", () => {
    const f = fixture();
    const sentinel = new Error("loop author");
    f.player.mixer.addEventListener("loop", () => {
      expect(readAnimationPacketState(f.root)).toBeUndefined();
      throw sentinel;
    });
    let thrown: unknown;
    try {
      f.player.update(1.1, true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    f.player.dispose();
  });
});
