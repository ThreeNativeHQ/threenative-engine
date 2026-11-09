/**
 * PRD-784 P5-9: AnimationComposer (animation-composition) calls three's AnimationUtils.makeClipAdditive,
 * which the native profile did not bind. The port against three's own, on the same clips. The engine's
 * tracks answer copies and bind no createInterpolant, getInterpolation or getValueSize. So each case
 * also runs on tracks that hide all three: the port's own interpolation must give three's values.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { AnimationUtils } from "../src/animation-utils.js";

// biome-ignore lint/suspicious/noExplicitAny: upstream three's own classes, untyped here.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);

// three's own AnimationUtils, on the same input.
const upstream: Loose = T.AnimationUtils;

const clip = () => {
  const q = (x: number, y: number) =>
    new T.Quaternion().setFromEuler(new T.Euler(x, y, 0)).toArray();
  return new T.AnimationClip("walk", 1, [
    new T.QuaternionKeyframeTrack(
      "hip.quaternion",
      [0, 0.5, 1],
      [...q(0, 0), ...q(0.4, 0.2), ...q(0.9, -0.3)],
    ),
    new T.VectorKeyframeTrack("hip.position", [0, 0.5, 1], [0, 1, 0, 0.5, 1.2, 0.1, 1, 0.9, 0.3]),
    new T.NumberKeyframeTrack("face.morphTargetInfluences[0]", [0, 1], [0.2, 0.8]),
  ]);
};

// The V8 engine's constructors refuse an explicit undefined argument (found on the player).
const strict = (Base: Loose) =>
  class extends Base {
    constructor(...args: Loose[]) {
      if (args.includes(undefined)) throw new TypeError("TN_NATIVE_UNSUPPORTED expected a number");
      super(...args);
    }
  };

// What the engine's tracks and clip expose: name, ValueTypeName, times, values, duration and a strict
// constructor; no blendMode getter.
const engineLike = (source: Loose) =>
  Object.create(
    new T.AnimationClip(
      source.name,
      source.duration,
      source.tracks.map((track: Loose) =>
        Object.create(track, {
          createInterpolant: { value: undefined },
          getValueSize: { value: undefined },
          getInterpolation: { value: undefined },
          constructor: { value: strict(track.constructor) },
        }),
      ),
    ),
    { blendMode: { value: undefined }, constructor: { value: strict(T.AnimationClip) } },
  );

const tracks = (result: Loose) =>
  result.tracks.map((track: Loose) => [track.name, Array.from(track.values)]);

const close = (actual: Loose, expected: Loose) => {
  expect(actual.map(([name]: Loose) => name)).toEqual(expected.map(([name]: Loose) => name));
  for (const [i, [, values]] of expected.entries())
    for (const [k, value] of values.entries()) expect(actual[i][1][k]).toBeCloseTo(value, 6);
};

describe("AnimationUtils port", () => {
  for (const frame of [0, 9, 15, 40]) {
    it(`makeClipAdditive subtracts the reference frame ${frame} as three does, into a new clip`, () => {
      const expected = upstream.makeClipAdditive(clip(), frame, clip(), 30);
      for (const input of [clip(), engineLike(clip())]) {
        const before = tracks(input);
        const result = AnimationUtils.makeClipAdditive(input, frame, input, 30) as Loose;
        close(tracks(result), tracks(expected));
        expect(result.blendMode).toBe(T.AdditiveAnimationBlendMode);
        expect(result).not.toBe(input);
        expect(tracks(input)).toEqual(before);
      }
    });
  }

  it("subclip keeps the frames in range and starts them at 0, as three does", () => {
    const expected = upstream.subclip(clip(), "mid", 10, 31, 30);
    for (const input of [clip(), engineLike(clip())]) {
      const result = AnimationUtils.subclip(input, "mid", 10, 31, 30) as Loose;
      expect(result.name).toBe("mid");
      expect(result.duration).toBeCloseTo(expected.duration, 6);
      expect(result.tracks.map((t: Loose) => Array.from(t.times))).toEqual(
        expected.tracks.map((t: Loose) => Array.from(t.times)),
      );
      close(tracks(result), tracks(expected));
    }
  });

  it("the array helpers match three", () => {
    const three = upstream;
    const times = [0.5, 0, 1];
    const order = AnimationUtils.getKeyframeOrder(times);
    expect(order).toEqual(three.getKeyframeOrder(times));
    const values = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(AnimationUtils.sortedArray(values, 2, order)).toEqual(
      three.sortedArray(values, 2, order),
    );
    expect(AnimationUtils.convertArray([1, 2], Float32Array)).toEqual(
      three.convertArray([1, 2], Float32Array),
    );
    expect(AnimationUtils.convertArray(values, Array)).toEqual(three.convertArray(values, Array));
    expect([
      AnimationUtils.isTypedArray(values),
      AnimationUtils.isTypedArray(new DataView(values.buffer)),
    ]).toEqual([true, false]);
    expect(AnimationUtils.hasTangents({ inTangents: [], outTangents: [] })).toBe(true);
    const keys = [{ time: 0 }, { time: 1, v: [1, 2] }, { time: 2, v: [3, 4] }];
    const flat = [[] as number[], [] as unknown[]] as const;
    const theirs = [[] as number[], [] as unknown[]] as const;
    AnimationUtils.flattenJSON(keys, flat[0], flat[1], "v");
    three.flattenJSON(keys, theirs[0], theirs[1], "v");
    expect(flat).toEqual(theirs);
  });
});
