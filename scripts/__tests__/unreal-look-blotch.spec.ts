import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOTCH_FLOOR,
  BLOTCH_LIMIT,
  type IBlotchBands,
  blotchBands,
  blotchVerdict,
  isFlatRegion,
} from "../unreal-look/blotch.js";
import { decode, masks } from "../unreal-look/compare.js";

const W = 220;
const H = 180;
const everything = new Uint8Array(W * H).fill(1);

/** A seeded uniform generator in [-1, 1): the same field on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** White noise of standard deviation `std` on `base`. */
function grainy(base: number, std: number, seed: number): Float32Array {
  const next = random(seed);
  // A uniform on [-1, 1) has a standard deviation of 1 / sqrt(3).
  return Float32Array.from({ length: W * H }, () => base + next() * std * Math.sqrt(3));
}

/**
 * Soft clouds: eight plane waves of 16 to 44 px, in fixed directions, scaled to a standard deviation of
 * `std` on `base`. Nothing finer than 16 px is in the field.
 */
function cloudy(base: number, std: number, w = W, h = H): Float32Array {
  const waves = [16, 20, 24, 28, 32, 36, 40, 44].map((wavelength, k) => ({
    wavelength,
    angle: (k * 2.399963) % Math.PI,
    phase: k * 1.7,
  }));
  const field = Float32Array.from({ length: w * h }, (_, i) => {
    const [x, y] = [i % w, Math.floor(i / w)];
    return waves.reduce(
      (sum, w) =>
        sum +
        Math.sin(
          (2 * Math.PI * (Math.cos(w.angle) * x + Math.sin(w.angle) * y)) / w.wavelength + w.phase,
        ),
      0,
    );
  });
  let [mean, square] = [0, 0];
  for (const v of field) mean += v / field.length;
  for (const v of field) square += (v - mean) ** 2 / field.length;
  return field.map((v) => base + ((v - mean) * std) / Math.sqrt(square));
}

/** The old grain measure: the standard deviation of a pixel against its 9 x 9 box, over the mean. */
function boxGrain(luma: Float32Array): number {
  let [sum, square, n] = [0, 0, 0];
  for (let y = 4; y < H - 4; y++)
    for (let x = 4; x < W - 4; x++) {
      let box = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) box += luma[(y + dy) * W + x + dx] ?? 0;
      const d = (luma[y * W + x] ?? 0) - box / 81;
      sum += luma[y * W + x] ?? 0;
      square += d * d;
      n += 1;
    }
  return Math.sqrt(square / n) / (sum / n);
}

describe("blotch bands (PRD-641)", () => {
  it("reads a flat wall as flat", () => {
    const bands = blotchBands(new Float32Array(W * H).fill(90), W, H, everything);
    expect(bands?.blotch).toBeLessThan(1e-4);
    expect(bands?.grain).toBeLessThan(1e-4);
    expect(bands?.mean).toBeCloseTo(90, 3);
  });

  it("reads a linear ramp as flat, the way a lit wall under a window is", () => {
    const ramp = Float32Array.from(
      { length: W * H },
      (_, i) => 60 + 0.12 * (i % W) + 0.08 * Math.floor(i / W),
    );
    const bands = blotchBands(ramp, W, H, everything);
    expect(bands?.blotch).toBeLessThan(1e-3);
  });

  it("puts white noise in the grain band and leaves the blotch band almost empty", () => {
    const bands = blotchBands(grainy(100, 3, 1), W, H, everything);
    expect(bands?.grain).toBeGreaterThan(0.02);
    expect(bands?.blotch).toBeLessThan(0.004);
  });

  it("sees a soft cloud that the old grain measure cannot see", () => {
    // 16 to 44 px clouds of 2 levels on a 100 level wall: the 9 x 9 box follows them.
    const cloud = cloudy(100, 2);
    const bands = blotchBands(cloud, W, H, everything);
    expect(bands?.blotch).toBeGreaterThan(0.01);
    expect(bands?.grain).toBeLessThan(0.003);
    // The same 2 levels read 0.02 as white noise and under a quarter of that as clouds: the blind spot is the clouds.
    expect(boxGrain(grainy(100, 2, 5))).toBeGreaterThan(0.015);
    expect(boxGrain(cloud)).toBeLessThan(0.006);
    expect(bands?.blotch).toBeGreaterThan(2.5 * boxGrain(cloud));
  });

  it("measures only the pixels of its mask", () => {
    const luma = cloudy(100, 6);
    const half = new Uint8Array(W * H);
    // The right half is flat, the left half is a thick cloud, and only the right half is the region.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (x >= W / 2) luma[y * W + x] = 100;
        half[y * W + x] = x >= W / 2 ? 1 : 0;
      }
    const bands = blotchBands(luma, W, H, half);
    expect(bands?.blotch).toBeLessThan(2e-3);
  });

  it("leaves a region that is too small unmeasured", () => {
    const tiny = new Uint8Array(W * H);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) tiny[y * W + x] = 1;
    expect(blotchBands(grainy(100, 3, 4), W, H, tiny)).toBeUndefined();
    expect(blotchBands(grainy(100, 3, 4), W, H, new Uint8Array(W * H))).toBeUndefined();
  });
});

describe("blotch verdict (PRD-641)", () => {
  const bands = (blotch: number): IBlotchBands => ({
    grain: 0.01,
    blotch,
    mean: 100,
    pixels: 5000,
  });

  it("passes up to the limit and fails past it", () => {
    expect(BLOTCH_LIMIT).toBe(1.2);
    expect(blotchVerdict(bands(0.012), bands(0.01)).pass).toBe(true);
    expect(blotchVerdict(bands(0.0121), bands(0.01)).pass).toBe(false);
    expect(blotchVerdict(bands(0.005), bands(0.01)).ratio).toBeCloseTo(0.5, 6);
  });

  it("keeps the ratio finite where Unreal is flat", () => {
    expect(blotchVerdict(bands(BLOTCH_FLOOR * 1.1), bands(0)).pass).toBe(true);
    const v = blotchVerdict(bands(0.01), bands(0));
    expect(v.ratio).toBeCloseTo(0.01 / BLOTCH_FLOOR, 6);
    expect(v.pass).toBe(false);
  });
});

describe("blotch metric on a real wall shape (PRD-641)", () => {
  // The committed Unreal ID frame gives the wall its real outline: the window and the door cut into it.
  const root = path.resolve(import.meta.dirname, "../../tools/unreal-reference/gi/sunlit-room");
  const regions = JSON.parse(readFileSync(path.join(root, "scene.json"), "utf8")).regions;
  const id = decode(readFileSync(path.join(root, "id/sun60-window.png")), "png");
  const wall = masks(id, regions).regions.Wall_Right as Uint8Array;
  // A lit wall as an 8-bit frame holds it: a smooth ramp rounded to whole display levels, so its only
  // fine structure is the contour of each level. This is how Unreal's own wall reads.
  const smooth = Float32Array.from({ length: id.width * id.height }, (_, i) =>
    Math.round(120 + 0.03 * (i % id.width) + 0.05 * Math.floor(i / id.width)),
  );
  const measure = (plane: Float32Array) => blotchBands(plane, id.width, id.height, wall);
  /** One cloud field of unit standard deviation, made on first use: it takes a second on a loaded host. */
  let unit: Float32Array | undefined;
  /** The wall plus soft clouds of standard deviation `std` display levels, rounded to 8 bits again. */
  const withClouds = (std: number) => {
    unit ??= cloudy(0, 1, id.width, id.height);
    const cloud = unit;
    return smooth.map((v, i) => Math.round(v + std * (cloud[i] ?? 0)));
  };

  it("reads the smooth 8-bit wall as smooth: only its contours are in the band", () => {
    const unreal = measure(smooth);
    expect(unreal?.blotch).toBeLessThan(0.005);
    expect(unreal && blotchVerdict(unreal, unreal).pass).toBe(true);
  }, 60_000);

  it("keeps the wall with 0.2 levels of soft cloud and fails it with 1.5 levels", () => {
    const [unreal, faint, strong] = [
      measure(smooth),
      measure(withClouds(0.2)),
      measure(withClouds(1.5)),
    ];
    expect(unreal && faint && blotchVerdict(faint, unreal).pass).toBe(true);
    expect(unreal && strong && blotchVerdict(strong, unreal).pass).toBe(false);
  }, 60_000);
});

describe("flat regions (PRD-641)", () => {
  it("takes the walls and the ceiling, and leaves floors, trims, brick, strips and the ground", () => {
    const named = [
      "Ceiling",
      "Wall_Left",
      "Wall_Right",
      "Front_Left",
      "Back_Right",
      "Hall_Back",
      "Back",
    ];
    for (const name of named) expect(isFlatRegion(name)).toBe(true);
    const left = [
      "Floor",
      "Front_Sill",
      "Front_Head",
      "Back_Head",
      "Wall_Brick",
      "Strip_Cyan",
      "Emitter",
      "Ground",
      "Sky",
      "Box_Tall",
    ];
    for (const name of left) expect(isFlatRegion(name)).toBe(false);
  });
});
