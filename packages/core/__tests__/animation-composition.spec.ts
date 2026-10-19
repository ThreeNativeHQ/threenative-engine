import { AnimationComposer, AnimationPlayer, BlendSpace1D, BlendSpace2D } from "@threenative/core";
import { AnimationClip, Group, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import { compositionRig } from "./fixtures/composition-rig.js";

describe("one normalized phase owner", () => {
  it("holds all contributing sample phases through speed changes, interruption, loop and pause", () => {
    const r = compositionRig();
    const composer = new AnimationComposer({
      root: r.root,
      clips: r.clips,
      samples: ["walk", "run"],
    });
    composer.setWeights([0.5, 0.5]);
    composer.update(0.4);
    expect(composer.phase).toBeCloseTo(0.3);
    expect(r.leg.position.x).toBeCloseTo(0.75); // .5*.3 + .5*1.2
    composer.speed = 2;
    composer.update(0.2);
    expect(composer.phase).toBeCloseTo(0.6);
    composer.setWeights([0, 1], 0.2);
    composer.update(0.1);
    expect(composer.weights).toEqual([0.25, 0.75]);
    expect(composer.phase).toBeCloseTo(0.725);
    composer.setWeights([1, 0], 0.2);
    composer.update(0.1);
    expect(composer.weights).toEqual([0.625, 0.375]);
    expect(composer.phase).toBeCloseTo(0.8875);
    composer.paused = true;
    composer.update(7);
    expect(composer.phase).toBeCloseTo(0.8875);
    composer.paused = false;
    composer.update(0.1);
    expect(composer.phase).toBeCloseTo(0.0875);
    expect(composer.sampleTimes[0]).toBeCloseTo(0.0875);
    expect(composer.sampleTimes[1]).toBeCloseTo(0.175);
    composer.dispose();
  });

  it("rejects zero, negative/nonfinite weights, invalid speed and action capacity", () => {
    const r = compositionRig();
    const c = new AnimationComposer({ root: r.root, clips: r.clips, samples: ["walk", "run"] });
    expect(() => c.setWeights([0, 0])).toThrow(/positive sum/);
    expect(() => c.setWeights([-1, 1])).toThrow(/nonnegative/);
    expect(() => c.setWeights([Number.NaN, 1])).toThrow(/finite/);
    expect(() => c.setWeights([1])).toThrow(/count/);
    expect(() => {
      c.speed = -1;
    }).toThrow(/nonnegative/);
    c.dispose();
    expect(() => c.update(1)).toThrow(/dispose/);
  });

  it("leaves the incumbent player pose/stride trace and allocation counts unchanged", () => {
    const body = new Group();
    const root = new Group();
    body.add(root);
    const clip = new AnimationClip("walk", 1, [
      new VectorKeyframeTrack(".position", [0, 1], [0, 0, 0, 2, 0, 0]),
    ]);
    const p = new AnimationPlayer({ root, clips: [clip], strideRoot: body });
    p.play("walk");
    const positions: number[] = [];
    const rates: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      body.position.x += 0.5;
      p.update(0.25);
      positions.push(root.position.x);
      rates.push(p.stride.rate);
    }
    for (const [i, expected] of [0.5, 0.575, 1.075, 1.575].entries())
      expect(positions[i]).toBeCloseTo(expected);
    expect(rates).toEqual([0.15, 1, 1, 1]);
    expect(p.mixer.stats.actions.total).toBe(1);
    expect(p.mixer.stats.bindings.total).toBe(1);
    p.dispose();
    expect(p.mixer.stats.actions.total).toBe(0);
  });
});

describe("validated animation blend weights", () => {
  it("sorts once, clamps endpoints and interpolates independent 1D cases", () => {
    const space = new BlendSpace1D([2, 0, 1]);
    expect(Array.from(space.sample(0.25))).toEqual([0, 0.75, 0.25]);
    expect(Array.from(space.sample(1))).toEqual([0, 0, 1]);
    expect(Array.from(space.sample(-4))).toEqual([0, 1, 0]);
    expect(Array.from(space.sample(4))).toEqual([1, 0, 0]);
    expect(space.sample(0)).toBe(space.sample(2));
    expect(() => space.sample(Number.NaN)).toThrow(/finite/);
    expect(() => new BlendSpace1D([])).toThrow(/samples/);
    expect(() => new BlendSpace1D([0, 0])).toThrow(/duplicate/);
  });

  it("uses a fixed triangle and projects queries onto hull edges", () => {
    const space = new BlendSpace2D(
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
      [[0, 1, 2]],
    );
    expect(Array.from(space.sample(0.5, 0.5))).toEqual([0.5, 0.25, 0.25]);
    expect(Array.from(space.sample(2, 2))).toEqual([0, 0.5, 0.5]);
    expect(Array.from(space.sample(-1, 1))).toEqual([0.5, 0, 0.5]);
    expect(Array.from(space.sample(0, 0))).toEqual([1, 0, 0]);
    expect(() => space.sample(Number.POSITIVE_INFINITY, 0)).toThrow(/finite/);
  });

  it("projects onto boundary subedges without dropping a collinear boundary sample", () => {
    const space = new BlendSpace2D(
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
      ],
      [
        [0, 1, 3],
        [1, 2, 3],
      ],
    );
    expect(Array.from(space.sample(1, 0))).toEqual([0, 1, 0, 0]);
    expect(Array.from(space.sample(1, -1e-6))).toEqual([0, 1, 0, 0]);
    expect(Array.from(space.sample(0.5, -1))).toEqual([0.5, 0.5, 0, 0]);
  });

  it("rejects a vector interpolator targeting a quaternion", () => {
    const r = compositionRig();
    const clip = new AnimationClip("bad", 1, [
      new VectorKeyframeTrack(
        "Hand.quaternion",
        [0, 1],
        [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2],
      ),
    ]);
    expect(() => new AnimationComposer({ root: r.root, clips: [clip], samples: ["bad"] })).toThrow(
      /type/,
    );
  });

  it("rejects invalid, duplicate, collinear and incomplete triangulations", () => {
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [0, 0],
            [1, 1],
          ],
          [[0, 1, 2]],
        ),
    ).toThrow(/duplicate/);
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          [[0, 1, 2]],
        ),
    ).toThrow(/collinear/);
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          [[0, 1, 9]],
        ),
    ).toThrow(/index/);
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          [],
        ),
    ).toThrow(/triangulation/);
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ],
          [[0, 1, 2]],
        ),
    ).toThrow(/unused/);
    expect(
      () =>
        new BlendSpace2D(
          [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          [
            [0, 1, 2],
            [0, 2, 1],
          ],
        ),
    ).toThrow(/duplicate/);
  });
});
