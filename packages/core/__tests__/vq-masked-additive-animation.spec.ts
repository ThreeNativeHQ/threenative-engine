import { createHash } from "node:crypto";
import {
  type AnimationAction,
  AnimationClip,
  AnimationMixer,
  InterpolateDiscrete,
  InterpolateLinear,
  Quaternion,
  QuaternionKeyframeTrack,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationComposer, type IAnimationComposerOptions } from "../src/animation-composition.js";
import { compositionRig } from "./fixtures/composition-rig.js";

function composerWithActions(options: IAnimationComposerOptions) {
  const actions = new Set<AnimationAction>();
  const clipAction = AnimationMixer.prototype.clipAction;
  const capture = vi.spyOn(AnimationMixer.prototype, "clipAction").mockImplementation(function (
    this: AnimationMixer,
    ...args: Parameters<typeof clipAction>
  ) {
    const action = clipAction.call(this, ...args);
    if (action === null) throw new Error("Expected a prepared animation action.");
    actions.add(action);
    return action;
  });
  try {
    return { composer: new AnimationComposer(options), actions };
  } finally {
    capture.mockRestore();
  }
}

describe("single masked/additive animation owner", () => {
  it("retains constant quaternion keys and exact poses without spherical interpolation", () => {
    for (const value of [
      [0, 0, 0, 1],
      [0.5, 0.5, 0.5, 0.5],
    ]) {
      const r = compositionRig();
      const track = new QuaternionKeyframeTrack(
        "Hand.quaternion",
        [0, 0.25, 1],
        [...value, ...value, ...value],
      );
      const clip = new AnimationClip("constant", 1, [track]);
      const before = JSON.stringify(clip.toJSON());
      const { composer, actions } = composerWithActions({
        root: r.root,
        clips: [clip],
        samples: [clip.name],
      });
      const slerp = vi.spyOn(Quaternion, "slerpFlat");
      try {
        const copy = [...actions][0]?.getClip().tracks[0];
        expect(copy?.times).toEqual(track.times);
        expect(copy?.values).toEqual(track.values);
        expect(copy?.values).not.toBe(track.values);
        expect(copy?.getInterpolation()).toBe(InterpolateDiscrete);
        for (const dt of [0, 0.125, 0.125, 0.75, 3.125]) {
          composer.update(dt);
          expect(r.hand.quaternion.toArray()).toEqual(value);
        }
        composer.paused = true;
        composer.update(5);
        expect(r.hand.quaternion.toArray()).toEqual(value);
        expect(slerp).not.toHaveBeenCalled();
        expect(composer.resources.actions).toBe(1);
        expect(composer.resources.bindings).toBe(1);
        expect(JSON.stringify(clip.toJSON())).toBe(before);
        expect(track.getInterpolation()).toBe(InterpolateLinear);
      } finally {
        slerp.mockRestore();
        composer.dispose();
      }
    }
  });

  it("retains linear interpolation for changing quaternions and custom track factories", () => {
    class CustomQuaternionTrack extends QuaternionKeyframeTrack {
      override InterpolantFactoryMethodLinear(
        ...args: Parameters<QuaternionKeyframeTrack["InterpolantFactoryMethodLinear"]>
      ) {
        return super.InterpolantFactoryMethodLinear(...args);
      }
    }
    const r = compositionRig();
    for (const track of [
      new QuaternionKeyframeTrack(
        "Hand.quaternion",
        [0, 0.5, 1],
        [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 1],
      ),
      new QuaternionKeyframeTrack(
        "Hand.quaternion",
        [0, 0.5, 1],
        [0, 0, 0, 1, 0, 0, 1e-7, 1, 0, 0, 0, 1],
      ),
      new QuaternionKeyframeTrack(
        "Hand.quaternion",
        [0, 0.5, 1],
        [0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1],
      ),
      new CustomQuaternionTrack(
        "Hand.quaternion",
        [0, 0.5, 1],
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      ),
    ]) {
      const clip = new AnimationClip("guarded", 1, [track]);
      const { composer, actions } = composerWithActions({
        root: r.root,
        clips: [clip],
        samples: [clip.name],
      });
      try {
        const copy = [...actions][0]?.getClip().tracks[0];
        expect(copy?.getInterpolation()).toBe(InterpolateLinear);
        for (const time of [-0.1, 0, 0.125, 0.5, 0.875, 1, 1.1]) {
          expect(Array.from(copy?.InterpolantFactoryMethodLinear().evaluate(time) ?? [])).toEqual(
            Array.from(track.InterpolantFactoryMethodLinear().evaluate(time)),
          );
        }
      } finally {
        composer.dispose();
      }
    }
  });

  it("resolves different masks on clones of the same source without cross-talk", () => {
    const a = compositionRig();
    const b = compositionRig();
    const make = (root: typeof a.root, name: string) =>
      new AnimationComposer({
        root,
        clips: a.clips,
        samples: ["walk"],
        layers: [
          {
            name: "reload",
            clip: "reload",
            mode: "override",
            mask: { bones: [name], descendants: true },
          },
        ],
      });
    const ca = make(a.root, "Upper");
    const cb = make(b.root, "Leg");
    ca.setLayerWeight("reload", 1);
    cb.setLayerWeight("reload", 1);
    ca.update(0.25);
    cb.update(0.25);
    expect(a.leg.position.x).toBeCloseTo(0.25);
    expect(a.upper.position.x).toBeCloseTo(2.5);
    expect(b.leg.position.x).toBeCloseTo(25);
    expect(b.upper.position.x).toBeCloseTo(0.5);
    ca.dispose();
    cb.dispose();
  });
  it("finishes a one-shot once across pause and repeated weights, with explicit replay and cancellation", () => {
    const r = compositionRig();
    const c = new AnimationComposer({
      root: r.root,
      clips: r.clips,
      samples: ["walk"],
      layers: [
        {
          name: "reload",
          clip: "reload",
          mode: "override",
          mask: { bones: ["Upper"] },
          once: true,
        },
      ],
    });
    let finished = 0;
    c.mixer.addEventListener("finished", () => {
      finished += 1;
    });
    c.setLayerWeight("reload", 1);
    c.update(0.5);
    c.paused = true;
    c.update(10);
    expect(finished).toBe(0);
    expect(r.upper.position.x).toBeCloseTo(5);
    c.paused = false;
    c.update(0.5);
    expect(finished).toBe(1);
    expect(r.upper.position.x).toBeCloseTo(10);
    c.setLayerWeight("reload", 0.5);
    c.update(1);
    expect(finished).toBe(1);
    c.restartLayer("reload");
    c.update(0.5);
    c.setLayerWeight("reload", 0);
    c.update(2);
    expect(finished).toBe(1);
    expect(r.upper.position.x).toBeCloseTo(1);
    c.setLayerWeight("reload", 1);
    c.update(1);
    expect(finished).toBe(2);
    c.dispose();
  });

  it("returns owned actions and clip/scratch buffers to baseline through 50 shared-source lifecycles", () => {
    const original = compositionRig();
    const hash = () =>
      createHash("sha256")
        .update(JSON.stringify(original.clips.map((clip) => clip.toJSON())))
        .digest("hex");
    const before = hash();
    for (let i = 0; i < 50; i += 1) {
      const root = original.root.clone(true);
      const c = new AnimationComposer({
        root,
        clips: original.clips,
        samples: ["walk", "run"],
        layers: [
          {
            name: "reload",
            clip: "reload",
            mode: "override",
            mask: { bones: ["Upper"], descendants: true },
          },
        ],
      });
      expect(c.resources.actions).toBe(5);
      expect(c.resources.clipBufferBytes).toBeGreaterThan(0);
      c.setWeights([0.25, 0.75]);
      c.setLayerWeight("reload", 0.5);
      c.update(0.5);
      c.dispose();
      expect(c.resources).toEqual({
        actions: 0,
        bindings: 0,
        scratchBytes: 0,
        clipBuffers: 0,
        clipBufferBytes: 0,
        rootBuffers: 0,
        rootBufferBytes: 0,
      });
      expect(hash()).toBe(before);
    }
  });
  it("preserves the lower body and applies exact override weights", () => {
    const r = compositionRig();
    const composer = new AnimationComposer({
      root: r.root,
      clips: r.clips,
      samples: ["walk"],
      layers: [{ name: "reload", clip: "reload", mode: "override", mask: { bones: ["Upper"] } }],
    });
    composer.setLayerWeight("reload", 0.25);
    composer.update(0.5);
    expect(r.leg.position.x).toBeCloseTo(0.5, 5);
    expect(r.upper.position.x).toBeCloseTo(2, 5); // .75 * 1 + .25 * 5
    composer.setLayerWeight("reload", 0);
    composer.update(0);
    expect(r.upper.position.x).toBeCloseTo(1, 5);
    composer.dispose();
    expect(composer.mixer.stats.actions.total).toBe(0);
  });

  it("keeps mask ownership when a debugger renames prepared clips", () => {
    const r = compositionRig();
    const source = JSON.stringify(r.clips.map((clip) => clip.toJSON()));
    const { composer, actions } = composerWithActions({
      root: r.root,
      clips: r.clips,
      samples: ["walk"],
      layers: [{ name: "reload", clip: "reload", mode: "override", mask: { bones: ["Upper"] } }],
    });
    try {
      composer.setLayerWeight("reload", 0.25);
      composer.update(0.5);
      expect(actions.size).toBe(3);
      let index = 0;
      for (const action of actions) action.getClip().name = `debug-clip-${index++}`;
      for (const weight of [0.25, 0.4, 1, 0]) {
        composer.setLayerWeight("reload", weight);
        composer.update(0);
        expect(r.leg.position.x).toBeCloseTo(0.5, 5);
        expect(r.upper.position.x).toBeCloseTo((1 - weight) * 1 + weight * 5, 5);
      }
      expect(JSON.stringify(r.clips.map((clip) => clip.toJSON()))).toBe(source);
      expect(composer.resources.actions).toBe(3);
    } finally {
      composer.dispose();
    }
    expect(composer.mixer.stats.actions.total).toBe(0);
  });

  it("uses explicit additive references without changing shared clips or another clone", () => {
    const a = compositionRig();
    const b = compositionRig();
    const before = JSON.stringify(a.clips.map((clip) => clip.toJSON()));
    const ca = new AnimationComposer({
      root: a.root,
      clips: a.clips,
      samples: ["walk"],
      layers: [
        {
          name: "recoil",
          clip: "recoil",
          mode: "additive",
          mask: { bones: ["Hand"] },
          reference: { clip: a.clips[4], time: 0 },
        },
      ],
    });
    const cb = new AnimationComposer({
      root: b.root,
      clips: a.clips,
      samples: ["walk"],
      layers: [
        {
          name: "recoil",
          clip: "recoil",
          mode: "additive",
          mask: { bones: ["Hand"] },
          reference: { clip: a.clips[4], time: 0 },
        },
      ],
    });
    ca.setLayerWeight("recoil", 0.5);
    ca.update(0.5);
    cb.update(0.5);
    expect(a.hand.quaternion.angleTo(new Quaternion())).toBeCloseTo(0.1, 5);
    expect(b.hand.quaternion.angleTo(new Quaternion())).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      ca.setLayerWeight("recoil", 0);
      ca.update(0);
      expect(a.hand.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-5);
      ca.setLayerWeight("recoil", 1);
      ca.update(0);
    }
    expect(JSON.stringify(a.clips.map((clip) => clip.toJSON()))).toBe(before);
    ca.dispose();
    cb.dispose();
  });

  it("refuses missing bones, root masks and missing references before binding actions", () => {
    const r = compositionRig();
    const base = { root: r.root, clips: r.clips, samples: ["walk"] };
    expect(
      () =>
        new AnimationComposer({
          ...base,
          layers: [{ name: "bad", clip: "reload", mode: "override", mask: { bones: ["Missing"] } }],
        }),
    ).toThrow(/Missing/);
    expect(
      () =>
        new AnimationComposer({
          ...base,
          layers: [{ name: "bad", clip: "reload", mode: "override", mask: { bones: ["Hips"] } }],
        }),
    ).toThrow(/root/);
    expect(
      () =>
        new AnimationComposer({
          ...base,
          layers: [{ name: "bad", clip: "recoil", mode: "additive", mask: { bones: ["Hand"] } }],
        }),
    ).toThrow(/reference/);
  });
});
