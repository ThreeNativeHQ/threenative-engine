import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { FRAME_GATE, captureMotionFrames } from "../unreal-look/capture-motion-threenative.js";
import type { IImage } from "../unreal-look/compare.js";
import { type ISceneJson, readScene } from "../unreal-look/gi.js";
import {
  type IMotionReport,
  checkGradual,
  formatReports,
  measureRun,
  savedUnreal,
  switchFrame,
} from "../unreal-look/motion-run.js";
import {
  type IFrameStore,
  type IMotionRun,
  type IRegionSeries,
  boxMean,
  erodeMask,
  flicker,
  frameFile,
  runSeries,
  stillJob,
  swingRedraws,
  switchResponse,
  validateMotion,
} from "../unreal-look/motion.js";

// A 16 x 8 frame. Region A is the left half, region B the right half; region C is in no frame.
const W = 16;
const H = 8;
const COLORS = { A: [255, 0, 0], B: [0, 255, 0], C: [0, 0, 255] } as const;
const REGIONS = { A: COLORS.A, B: COLORS.B, C: COLORS.C };
const FEW = { minPixels: 1, minFrames: 1 };

function idFrame(): IImage {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = i % W < W / 2 ? COLORS.A : COLORS.B;
    data.set([r, g, b, 255], i * 4);
  }
  return { width: W, height: H, data, channels: 4 };
}

/** The ID frame with every pixel that `drop` selects painted black (the sky): the regions lose those pixels. */
function idFrameWithout(drop: (i: number) => boolean): IImage {
  const id = idFrame();
  const data = Uint8Array.from(id.data as Uint8Array);
  for (let i = 0; i < W * H; i++) if (drop(i)) data.set([0, 0, 0, 255], i * 4);
  return { ...id, data };
}

/** A grey frame: a grey pixel of level g has luminance g, whatever the weights. */
function greyFrame(level: (x: number, y: number) => number, width = W, height = H): IImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const g = level(i % width, Math.floor(i / width));
    data.set([g, g, g, 255], i * 4);
  }
  return { width, height, data, channels: 4 };
}

function memoryStore(files: Map<string, IImage>): IFrameStore {
  return {
    list: (dir) =>
      [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
    read: (file) => {
      const image = files.get(file);
      if (image === undefined) throw new Error(`no such file ${file}`);
      return image;
    },
  };
}

/** The frames of one run: `colorOf(t)` is the colour frame of frame t, the ID frame is the same in every frame. */
function runFiles(
  job: string,
  frames: number,
  colorOf: (t: number) => IImage,
  id: () => IImage = idFrame,
): Map<string, IImage> {
  const files = new Map<string, IImage>();
  for (let t = 0; t < frames; t++) {
    files.set(`L7/${frameFile(job, t)}`, colorOf(t));
    files.set(`ID/${frameFile(job, t)}`, id());
  }
  return files;
}

const options = (frames: number, extra = {}) => ({
  job: "pan",
  frames,
  color: "L7",
  id: "ID",
  regions: { A: REGIONS.A, B: REGIONS.B },
  ...FEW,
  ...extra,
});
const flat = (level: number) => () => greyFrame(() => level);

describe("motion frame names", () => {
  it("count from 0000 and name a still by its frame", () => {
    expect(frameFile("pan", 7)).toBe("pan.0007.png");
    expect(frameFile("pan", 179)).toBe("pan.0179.png");
    // Movie Render Queue writes a one-frame job as <job>.0000.png.
    expect(frameFile(stillJob(15), 0)).toBe("still-0015.0000.png");
  });
});

describe("the motion metric fails closed (PRD-638)", () => {
  it("accepts a complete run", () => {
    const files = runFiles("pan", 12, flat(100));
    expect(() => runSeries(memoryStore(files), options(12))).not.toThrow();
  });

  it("fails on a missing frame, naming it", () => {
    const files = runFiles("pan", 12, flat(100));
    files.delete(`L7/${frameFile("pan", 5)}`);
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_MISSING_FRAME.*frame 5/,
    );
  });

  it("fails on a missing ID frame, naming it", () => {
    const files = runFiles("pan", 12, flat(100));
    files.delete(`ID/${frameFile("pan", 9)}`);
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_MISSING_FRAME.*ID.*frame 9/,
    );
  });

  it("fails on a gap that another frame fills in the count", () => {
    // 12 files, but frame 11 is missing and frame 12 is there: the count is right and the run is not.
    const files = runFiles("pan", 12, flat(100));
    files.delete(`L7/${frameFile("pan", 11)}`);
    files.set(
      `L7/${frameFile("pan", 12)}`,
      greyFrame(() => 100),
    );
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_MISSING_FRAME.*frame 11/,
    );
  });

  it("fails on a run that stops short of its declared frame count", () => {
    const files = runFiles("pan", 11, flat(100));
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_FRAME_COUNT.*L7.*11 frames.*12/,
    );
  });

  it("fails on a run that carries more frames than it declares", () => {
    const files = runFiles("pan", 13, flat(100));
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_FRAME_COUNT.*13 frames.*12/,
    );
  });

  it("fails when the ID frames and the colour frames differ in count", () => {
    const files = runFiles("pan", 12, flat(100));
    files.delete(`ID/${frameFile("pan", 11)}`);
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_FRAME_COUNT.*ID.*11 frames/,
    );
  });

  it("fails on a frame whose size differs from its ID frame", () => {
    const files = runFiles("pan", 12, flat(100));
    files.set(
      `L7/${frameFile("pan", 3)}`,
      greyFrame(() => 100, W / 2, H),
    );
    expect(() => runSeries(memoryStore(files), options(12))).toThrow(
      /TN_UNREAL_LOOK_SIZE_MISMATCH/,
    );
  });

  it("fails on a region that no frame shows", () => {
    const files = runFiles("pan", 12, flat(100));
    expect(() =>
      runSeries(memoryStore(files), options(12, { regions: { A: REGIONS.A, C: REGIONS.C } })),
    ).toThrow(/TN_UNREAL_LOOK_EMPTY_MASK.*region C.*0 of 12 frames/);
  });

  it("fails on a region that too few frames show", () => {
    // Region B shows in frames 0 and 1 only; the run needs 3 frames.
    const files = runFiles("pan", 12, flat(100));
    for (let t = 2; t < 12; t++)
      files.set(
        `ID/${frameFile("pan", t)}`,
        idFrameWithout((i) => i % W >= W / 2),
      );
    expect(() => runSeries(memoryStore(files), options(12, { minFrames: 3 }))).toThrow(
      /TN_UNREAL_LOOK_EMPTY_MASK.*region B.*2 of 12 frames.*needs 3/,
    );
  });

  it("fails on a region below the pixel floor in every frame", () => {
    const files = runFiles("pan", 12, flat(100));
    expect(() => runSeries(memoryStore(files), options(12, { minPixels: 100 }))).toThrow(
      /TN_UNREAL_LOOK_EMPTY_MASK/,
    );
  });

  it("fails on a still that is not on disk", () => {
    const files = runFiles("pan", 12, flat(100));
    expect(() => runSeries(memoryStore(files), options(12, { stills: [4] }))).toThrow(
      /TN_UNREAL_LOOK_MISSING_FRAME.*still-0004\.0000\.png/,
    );
  });

  it("rejects a declared frame count that is not a whole number of two or more", () => {
    const files = runFiles("pan", 12, flat(100));
    for (const bad of [0, 1, 11.5, Number.NaN])
      expect(() => runSeries(memoryStore(files), options(bad))).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
  });
});

describe("the per-frame region series", () => {
  it("holds each region's median, pixel count and frame-to-frame change", () => {
    // Region A climbs 10 levels a frame, region B holds 50.
    const files = runFiles("pan", 12, (t) => greyFrame((x) => (x < W / 2 ? 10 * t : 50)));
    const series = runSeries(memoryStore(files), options(12));
    expect(series.frames).toBe(12);
    expect(series.regions.A?.p50).toEqual(Array.from({ length: 12 }, (_, t) => 10 * t));
    expect(series.regions.A?.pixels).toEqual(Array(12).fill((W / 2) * H));
    expect(series.regions.A?.diff).toEqual([null, ...Array(11).fill(10)]);
    expect(series.regions.B?.p50).toEqual(Array(12).fill(50));
    expect(series.regions.B?.diff).toEqual([null, ...Array(11).fill(0)]);
  });

  it("leaves a frame out of a region that shows fewer pixels than the floor", () => {
    const files = runFiles("pan", 12, flat(100));
    // Region B keeps 2 pixels (8 and 9 of the first row) in frame 6.
    files.set(
      `ID/${frameFile("pan", 6)}`,
      idFrameWithout((i) => i % W >= W / 2 && i !== 8 && i !== 9),
    );
    const series = runSeries(memoryStore(files), options(12, { minPixels: 4 }));
    expect(series.regions.B?.p50[6]).toBeNull();
    expect(series.regions.B?.diff[6]).toBeNull();
    // The frame after a gap has nothing to differ from.
    expect(series.regions.B?.diff[7]).toBeNull();
    expect(series.regions.B?.p50[5]).toBe(100);
  });
});

describe("flicker on a still camera", () => {
  const alternating = (d: number) =>
    runSeries(
      memoryStore(runFiles("pan", 12, (t) => greyFrame(() => 100 + (t % 2 === 0 ? d : -d)))),
      options(12),
    );

  it("reads zero when no frame changes", () => {
    const series = runSeries(memoryStore(runFiles("pan", 12, flat(100))), options(12));
    expect(flicker(series.regions.A as IRegionSeries, 2, 11)).toEqual({
      px: 0,
      p50: 0,
      frames: 9,
    });
  });

  it("is the mean pixel change over the level, and the median change over the median", () => {
    const series = alternating(2);
    const result = flicker(series.regions.A as IRegionSeries, 2, 11);
    // Every pixel moves by 4 levels between frames of mean level 100 (+- 2).
    expect(result.px).toBeCloseTo(4 / 100, 2);
    expect(result.p50).toBeCloseTo(4 / 100, 2);
    expect(result.frames).toBe(9);
  });

  it("scales with the swing", () => {
    const small = flicker(alternating(1).regions.A as IRegionSeries, 2, 11);
    const large = flicker(alternating(4).regions.A as IRegionSeries, 2, 11);
    expect(large.px / small.px).toBeCloseTo(4, 0);
  });

  it("fails on a window that holds no measurable pair of frames", () => {
    const series = runSeries(memoryStore(runFiles("pan", 12, flat(100))), options(12));
    expect(() => flicker(series.regions.A as IRegionSeries, 5, 5)).toThrow(
      /TN_UNREAL_LOOK_EMPTY_MASK/,
    );
    expect(() => flicker(series.regions.A as IRegionSeries, 5, 40)).toThrow(
      /TN_UNREAL_LOOK_BAD_INPUT/,
    );
  });
});

describe("ghosting against a converged still", () => {
  const withStill = (moving: number, still: (x: number, y: number) => number, extra = {}) => {
    const files = runFiles("pan", 12, flat(moving));
    files.set(`L7/${frameFile(stillJob(4), 0)}`, greyFrame(still));
    files.set(`ID/${frameFile(stillJob(4), 0)}`, idFrame());
    return runSeries(memoryStore(files), options(12, { stills: [4], erode: 0, ...extra }));
  };

  it("is zero when the moving frame is the still", () => {
    const ghost = withStill(100, () => 100).stills[4]?.A;
    expect(ghost).toEqual({ px: 0, p50: 0, pixels: (W / 2) * H, low: null });
  });

  it("is the mean level gap over the still's level", () => {
    const ghost = withStill(100, () => 110).stills[4]?.A;
    expect(ghost?.px).toBeCloseTo(10 / 110, 6);
    expect(ghost?.p50).toBeCloseTo(10 / 110, 6);
  });

  it("separates a trail that keeps the median from one that moves it", () => {
    // Half of region A is 40 levels dark in the moving frame: the pixels differ, the median barely.
    const files = runFiles("pan", 12, (t) => greyFrame((x, y) => (t === 4 && x < 2 ? 60 : 100)));
    files.set(
      `L7/${frameFile(stillJob(4), 0)}`,
      greyFrame(() => 100),
    );
    files.set(`ID/${frameFile(stillJob(4), 0)}`, idFrame());
    const ghost = runSeries(memoryStore(files), options(12, { stills: [4], erode: 0 })).stills[4]
      ?.A;
    expect(ghost?.px).toBeCloseTo((40 * 2 * H) / ((W / 2) * H) / 100, 6);
    expect(ghost?.p50).toBe(0);
  });

  it("compares the interior of a region only, so an edge ring does not count", () => {
    // Region A is x in [2, 14) and y in [2, 6) of a 16 x 8 frame; the still differs on its outer ring only.
    const id = () => {
      const data = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        const x = i % W;
        const y = Math.floor(i / W);
        data.set(x >= 2 && x < 14 && y >= 2 && y < 6 ? [...COLORS.A, 255] : [0, 0, 0, 255], i * 4);
      }
      return { width: W, height: H, data, channels: 4 } as IImage;
    };
    const ring = (x: number, y: number) => (x === 2 || x === 13 || y === 2 || y === 5 ? 160 : 100);
    const build = (erode: number) => {
      const files = runFiles("pan", 12, flat(100), id);
      files.set(`L7/${frameFile(stillJob(4), 0)}`, greyFrame(ring));
      files.set(`ID/${frameFile(stillJob(4), 0)}`, id());
      return runSeries(
        memoryStore(files),
        options(12, { stills: [4], erode, regions: { A: REGIONS.A } }),
      ).stills[4]?.A;
    };
    expect(build(0)?.px).toBeGreaterThan(0.1);
    expect(build(1)).toEqual({ px: 0, p50: 0, pixels: 10 * 2, low: null });
  });

  it("fails when the region is empty in the still", () => {
    const files = runFiles("pan", 12, flat(100));
    files.set(
      `L7/${frameFile(stillJob(4), 0)}`,
      greyFrame(() => 100),
    );
    files.set(
      `ID/${frameFile(stillJob(4), 0)}`,
      greyFrame(() => 0),
    );
    expect(() => runSeries(memoryStore(files), options(12, { stills: [4], erode: 0 }))).toThrow(
      /TN_UNREAL_LOOK_EMPTY_MASK.*still-0004/,
    );
  });
});

describe("boxMean", () => {
  const frame = (level: (x: number, y: number) => number, width: number, height: number) => {
    const image = greyFrame(level, width, height);
    const luma = new Int16Array(width * height);
    for (let i = 0; i < luma.length; i++) luma[i] = (image.data as Uint8Array)[i * 4] as number;
    return luma;
  };

  it("keeps a flat frame flat, at the border too", () => {
    const mean = boxMean(
      frame(() => 100, 9, 7),
      9,
      7,
      2,
    );
    expect([...mean].every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
  });

  it("spreads one bright pixel over its window and clips the window at the frame edge", () => {
    const mean = boxMean(
      frame((x, y) => (x === 2 && y === 2 ? 90 : 0), 5, 5),
      5,
      5,
      1,
    );
    const at = (x: number, y: number) => mean[y * 5 + x] as number;
    expect(at(2, 2)).toBeCloseTo(10, 9);
    expect(at(1, 1)).toBeCloseTo(10, 9);
    expect(at(3, 3)).toBeCloseTo(10, 9);
    expect(at(0, 0)).toBe(0);
    expect(at(4, 2)).toBe(0);
    // The corner's window holds four pixels: a bright pixel there weighs 1/4, not 1/9.
    const corner = boxMean(
      frame((x, y) => (x === 0 && y === 0 ? 80 : 0), 5, 5),
      5,
      5,
      1,
    );
    expect(corner[0]).toBeCloseTo(20, 9);
  });

  it("refuses a radius that is not a whole number or a luminance of another size", () => {
    expect(() => boxMean(new Int16Array(12), 4, 3, 0)).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => boxMean(new Int16Array(12), 4, 3, 1.5)).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => boxMean(new Int16Array(11), 4, 3, 1)).toThrow(/TN_UNREAL_LOOK_SIZE_MISMATCH/);
  });
});

// The per-pixel ghost counts grain and blur as ghosting. `low` compares the same two frames after a box mean, so
// it reads the smear of old light (a broad patch) and not the noise of one frame (PRD-638 Decisions).
describe("low-frequency ghosting", () => {
  const WW = 48;
  const HH = 24;
  const bigId = (): IImage => {
    const data = new Uint8Array(WW * HH * 4);
    for (let i = 0; i < WW * HH; i++)
      data.set([...(i % WW < WW / 2 ? COLORS.A : COLORS.B), 255], i * 4);
    return { width: WW, height: HH, data, channels: 4 };
  };
  const low = (
    moving: (x: number, y: number) => number,
    still: (x: number, y: number) => number,
    extra = {},
  ) => {
    const files = new Map<string, IImage>();
    for (let t = 0; t < 12; t++) {
      files.set(`L7/${frameFile("pan", t)}`, greyFrame(t === 4 ? moving : () => 100, WW, HH));
      files.set(`ID/${frameFile("pan", t)}`, bigId());
    }
    files.set(`L7/${frameFile(stillJob(4), 0)}`, greyFrame(still, WW, HH));
    files.set(`ID/${frameFile(stillJob(4), 0)}`, bigId());
    return runSeries(
      memoryStore(files),
      options(12, { stills: [4], erode: 0, lowRadius: 2, ...extra }),
    ).stills[4];
  };

  it("is zero when the moving frame is the still", () => {
    expect(
      low(
        () => 100,
        () => 100,
      )?.A?.low,
    ).toBe(0);
  });

  it("does not see grain: a checker of 40 levels moves the pixels, not the light", () => {
    const ghost = low(
      (x, y) => ((x + y) % 2 ? 140 : 60),
      () => 100,
    )?.A;
    expect(ghost?.px).toBeCloseTo(0.4, 6);
    expect(ghost?.low).toBeLessThan(0.02);
  });

  it("sees a broad patch of old light: 10 levels over the whole region", () => {
    expect(
      low(
        () => 110,
        () => 100,
      )?.A?.low,
    ).toBeCloseTo(10 / 100, 9);
  });

  it("keeps the window inside the region: light just outside the region does not count", () => {
    // Region B is x >= 24 and 100 levels brighter in the moving frame. The windows of region A stop at x = 23.
    const found = low(
      (x) => (x >= 24 ? 200 : 100),
      () => 100,
    );
    expect(found?.A?.low).toBe(0);
    expect(found?.B?.low).toBeCloseTo(1, 9);
  });

  it("is null when no pixel keeps its whole window inside the region", () => {
    expect(
      low(
        () => 100,
        () => 100,
        { lowRadius: 12 },
      )?.A?.low,
    ).toBeNull();
  });

  it("refuses a radius that is not a whole number of 1 or more", () => {
    expect(() =>
      low(
        () => 100,
        () => 100,
        { lowRadius: 0 },
      ),
    ).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() =>
      low(
        () => 100,
        () => 100,
        { lowRadius: 2.5 },
      ),
    ).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
  });
});

describe("erodeMask", () => {
  it("keeps the pixels whose whole window lies in the mask", () => {
    const mask = new Uint8Array(5 * 5).fill(1);
    mask[0] = 0; // a hole in the corner
    const out = erodeMask(mask, 5, 5, 1);
    // Interior of the 5 x 5 frame is x, y in [1, 3]; the hole removes only (1, 1).
    const kept = [...out].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(kept).toEqual([7, 8, 11, 12, 13, 16, 17, 18]);
  });

  it("returns the mask unchanged at radius 0", () => {
    const mask = Uint8Array.from([1, 0, 1, 1]);
    expect(erodeMask(mask, 2, 2, 0)).toEqual(mask);
  });
});

describe("response to a switch", () => {
  const series = (values: (number | null)[]): IRegionSeries => ({
    p50: values,
    pixels: values.map((v) => (v === null ? 0 : 100)),
    diff: values.map(() => null),
    mean: values,
  });
  // A light that goes out at frame 20: the region falls 10 levels a frame to zero.
  const falling = Array.from({ length: 60 }, (_, t) =>
    t < 20 ? 100 : Math.max(0, 100 - 10 * (t - 19)),
  );

  it("counts the frames to 90% of the change and to a steady value", () => {
    const result = switchResponse(series(falling), { at: 20 });
    expect(result.before).toBe(100);
    expect(result.after).toBe(0);
    expect(result.target).toBe(0);
    // 90% of the change is reached at frame 28 (value 10), the value holds within 5% from frame 29.
    expect(result.lag90).toBe(8);
    expect(result.settle).toBe(9);
    expect(result.overshoot).toBe(0);
    expect(result.residual).toBe(0);
    expect(result.flat).toBe(false);
  });

  it("answers at once for a region that follows the light in one frame", () => {
    const result = switchResponse(series(falling.map((_, t) => (t < 20 ? 100 : 0))), { at: 20 });
    expect(result.lag90).toBe(0);
    expect(result.settle).toBe(0);
  });

  it("reports a region that never answers, against the target of another run", () => {
    // The light went out; this run kept the old level. Its target is the dark level of the reference.
    const result = switchResponse(series(Array(60).fill(100)), { at: 20, target: 0 });
    expect(result.lag90).toBeNull();
    expect(result.settle).toBeNull();
    expect(result.residual).toBeCloseTo(1, 6);
    expect(result.flat).toBe(false);
  });

  it("measures an undershoot past the target as overshoot", () => {
    const dips = falling.map((v, t) => (t >= 40 ? 5 : Math.max(v, 10)));
    const result = switchResponse(series(dips), { at: 20, target: 10 });
    expect(result.overshoot).toBeCloseTo(5 / 90, 6);
    // The last 30 frames hold 5, which is 5 levels past the target, 5.6% of the change.
    expect(result.settle).toBeNull();
  });

  it("calls a region flat when the switch changes it by less than the floor", () => {
    const result = switchResponse(series(Array(60).fill(100)), { at: 20 });
    expect(result.flat).toBe(true);
    expect(result.lag90).toBeNull();
    expect(result.settle).toBeNull();
  });

  it("fails closed on a switch outside the run or a region the window does not show", () => {
    expect(() => switchResponse(series(falling), { at: 60 })).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => switchResponse(series(falling), { at: 5 })).toThrow(/TN_UNREAL_LOOK_BAD_INPUT/);
    const blind = falling.map((v, t) => (t >= 10 && t < 20 ? null : v));
    expect(() => switchResponse(series(blind), { at: 20 })).toThrow(/TN_UNREAL_LOOK_EMPTY_MASK/);
    const dark = falling.map((v, t) => (t >= 30 ? null : v));
    expect(() => switchResponse(series(dark), { at: 20 })).toThrow(/TN_UNREAL_LOOK_EMPTY_MASK/);
  });
});

describe("validateMotion", () => {
  const scene = {
    lights: [{ name: "Lamp" }],
    poses: [{ name: "cornell" }],
    regions: { Floor: [1, 2, 3], Ceiling: [4, 5, 6] },
  };
  const pan: IMotionRun = {
    frames: 180,
    camera: {
      kind: "pan",
      position: [0, 2.75, 0.5],
      hfovDeg: 90,
      pitchDeg: 0,
      headingDeg: [-45, 45],
      sweepFrames: 60,
    },
    stills: [0, 15, 60],
    regions: ["Floor", "Ceiling"],
  };
  const lamp: IMotionRun = {
    frames: 180,
    camera: { kind: "pose", pose: "cornell" },
    light: {
      name: "Lamp",
      keys: [
        [0, 1],
        [60, 0],
      ],
    },
  };

  it("accepts the motion runs the registered scenes carry, and the neon run switches the lamp off at frame 60", () => {
    for (const name of ["gi:cornell", "gi:neon-corridor"]) {
      const { scene: exported } = readScene(name);
      expect(() => validateMotion(exported.motion ?? {}, exported)).not.toThrow();
    }
    const neon = readScene("gi:neon-corridor").scene.motion?.neon;
    expect(neon?.frames).toBe(180);
    expect(neon?.light?.keys).toEqual([
      [0, 1],
      [60, 0],
    ]);
  });

  it("accepts a pan and a light switch", () => {
    expect(() => validateMotion({ pan, switch: lamp }, scene)).not.toThrow();
  });

  it("fails on a run name that is not a file name", () => {
    expect(() => validateMotion({ "Pan 1": pan }, scene)).toThrow(/run name/);
  });

  it("fails on frames, sweeps and stills outside the run", () => {
    expect(() => validateMotion({ pan: { ...pan, frames: 1 } }, scene)).toThrow(/frames/);
    expect(() =>
      validateMotion(
        { pan: { ...pan, camera: { ...(pan.camera as object), sweepFrames: 181 } as never } },
        scene,
      ),
    ).toThrow(/sweepFrames/);
    expect(() => validateMotion({ pan: { ...pan, stills: [0, 180] } }, scene)).toThrow(/still 180/);
    expect(() => validateMotion({ pan: { ...pan, stills: [15, 15] } }, scene)).toThrow(/still 15/);
  });

  it("fails on a camera pose, a light or a region that the scene does not have", () => {
    expect(() =>
      validateMotion({ switch: { ...lamp, camera: { kind: "pose", pose: "nowhere" } } }, scene),
    ).toThrow(/pose nowhere/);
    expect(() =>
      validateMotion({ switch: { ...lamp, light: { name: "Torch", keys: [[0, 1]] } } }, scene),
    ).toThrow(/light Torch/);
    expect(() => validateMotion({ pan: { ...pan, regions: ["Floor", "Sky2"] } }, scene)).toThrow(
      /region Sky2/,
    );
  });

  it("fails on light keys that are not ordered from frame 0 or carry a bad scale", () => {
    const keys = (k: [number, number][]) => ({
      switch: { ...lamp, light: { name: "Lamp", keys: k } },
    });
    expect(() => validateMotion(keys([[10, 1]]), scene)).toThrow(/first key/);
    expect(() =>
      validateMotion(
        keys([
          [0, 1],
          [60, 0],
          [50, 1],
        ]),
        scene,
      ),
    ).toThrow(/ascending/);
    expect(() => validateMotion(keys([[0, -1]]), scene)).toThrow(/scale/);
    expect(() =>
      validateMotion(
        keys([
          [0, 1],
          [180, 0],
        ]),
        scene,
      ),
    ).toThrow(/key frame 180/);
  });
});

describe("a run report (PRD-638)", () => {
  const mini = {
    scene: "mini",
    regions: { A: [...COLORS.A], B: [...COLORS.B] },
    motion: {
      switch: {
        frames: 40,
        camera: { kind: "pose", pose: "cornell" },
        light: {
          name: "Lamp",
          keys: [
            [0, 1],
            [20, 0],
          ],
        },
      },
      pan: {
        frames: 60,
        camera: {
          kind: "pan",
          position: [0, 0, 0],
          hfovDeg: 90,
          headingDeg: [-45, 45],
          sweepFrames: 10,
        },
        stills: [10, 20],
      },
    },
  } as unknown as ISceneJson;
  const look = (run: string, frames: number, level: (t: number) => number) => {
    const files = new Map<string, IImage>();
    for (let t = 0; t < frames; t++) {
      files.set(`unreal/mini/motion/${run}/ID/${frameFile(run, t)}`, idFrame());
      files.set(
        `unreal/mini/motion/${run}/L7-Epic-motion/${frameFile(run, t)}`,
        greyFrame(() => level(t)),
      );
      files.set(
        `threenative/mini/motion/${run}/L7/${frameFile(run, t)}`,
        greyFrame(() => 100),
      );
    }
    return files;
  };
  const input = (run: string, color: string, extra = {}) => ({
    scene: mini,
    run,
    color: `${color}/mini/motion/${run}/${color === "unreal" ? "L7-Epic-motion" : "L7"}`,
    id: `unreal/mini/motion/${run}/ID`,
    erode: 0,
    minPixels: 1,
    ...extra,
  });

  it("finds the frame of the switch from the light keys", () => {
    expect(switchFrame(mini.motion?.switch as IMotionRun)).toBe(20);
    expect(switchFrame(mini.motion?.pan as IMotionRun)).toBeUndefined();
  });

  it("reads Unreal's answer to a switch and holds ThreeNative to it", () => {
    const files = look("switch", 40, (t) => (t < 20 ? 100 : Math.max(0, 100 - 10 * (t - 19))));
    const store = memoryStore(files);
    const unreal = measureRun(store, input("switch", "unreal"));
    expect(unreal.A?.response).toMatchObject({ before: 100, target: 0, lag90: 8, settle: 9 });
    expect(unreal.A?.flicker).toEqual({ px: 0, p50: 0, frames: 9 });
    const target = Object.fromEntries(
      Object.entries(unreal).map(([name, report]) => [name, report.response?.target ?? Number.NaN]),
    );
    // ThreeNative keeps the old level after the lamp goes out: its light never answers.
    const tn = measureRun(store, input("switch", "threenative", { target }));
    expect(tn.A?.response).toMatchObject({ before: 100, target: 0, lag90: null, settle: null });
    expect(tn.A?.response?.residual).toBeCloseTo(1, 6);
    expect(
      formatReports([
        { scene: "mini", run: "switch", engine: "unreal", folder: "u", regions: unreal },
      ]),
    ).toMatch(/\| A \| unreal \| 100 \| 0.00% \| 0.00% \| 8 \| 9 \| 0.00% \| 0.00% \|/);
  });

  it("keeps the median level of each region in every frame, for a plot of the response", () => {
    const files = look("switch", 40, (t) => (t < 20 ? 100 : 40));
    const unreal = measureRun(memoryStore(files), input("switch", "unreal"));
    const levels = unreal.A?.levels ?? [];
    expect(levels).toHaveLength(40);
    expect([levels[0], levels[19], levels[20], levels[39]]).toEqual([100, 100, 40, 40]);
  });

  it("accepts Unreal's region only when it answers over more than one frame", () => {
    const report = (lag90: number | null): IMotionReport => ({
      scene: "mini",
      run: "switch",
      engine: "unreal",
      folder: "u",
      regions: {
        A: {
          flicker: { px: 0, p50: 0, frames: 10 },
          response: {
            before: 100,
            after: 10,
            target: 10,
            lag90,
            settle: lag90,
            overshoot: 0,
            residual: 0,
            flat: false,
          },
        },
      },
    });
    expect(checkGradual([report(43)], "A")).toBe(0);
    expect(checkGradual([report(1)], "A")).toBe(1);
    expect(checkGradual([report(0)], "A")).toBe(1);
    expect(checkGradual([report(null)], "A")).toBe(1);
  });

  it("fails closed when a run lacks a frame", () => {
    const files = look("switch", 40, () => 100);
    files.delete(`threenative/mini/motion/switch/L7/${frameFile("switch", 39)}`);
    expect(() => measureRun(memoryStore(files), input("switch", "threenative"))).toThrow(
      /TN_UNREAL_LOOK_FRAME_COUNT.*39 frames.*40/,
    );
  });

  it("measures a pan: flicker once the camera holds still, and the ghost at each still", () => {
    const files = look("pan", 60, () => 100);
    for (const s of [10, 20])
      for (const dir of [
        "unreal/mini/motion/pan/L7-Epic-motion",
        "threenative/mini/motion/pan/L7",
      ]) {
        files.set(
          `${dir}/${frameFile(stillJob(s), 0)}`,
          greyFrame(() => 100),
        );
        files.set(`unreal/mini/motion/pan/ID/${frameFile(stillJob(s), 0)}`, idFrame());
      }
    const store = memoryStore(files);
    const unreal = measureRun(store, input("pan", "unreal"));
    expect(unreal.A?.flicker.frames).toBe(19);
    expect(unreal.A?.ghost?.[10]).toEqual({ px: 0, p50: 0, pixels: 64, low: null });
    expect(Object.keys(unreal.B?.ghost ?? {})).toEqual(["10", "20"]);
    const text = formatReports([
      { scene: "mini", run: "pan", engine: "unreal", folder: "u", regions: unreal },
    ]);
    expect(text).toMatch(/ghost@10 \| ghost@20/);
  });
});

// A re-measure of ThreeNative reads Unreal's regions from a saved report instead of decoding Unreal's frames again.
describe("savedUnreal reuses a saved Unreal report (PRD-638)", () => {
  const scene = {
    scene: "mini",
    regions: { A: [1, 2, 3], B: [4, 5, 6] },
    motion: { switch: { frames: 40, regions: ["A"] } },
  } as unknown as ISceneJson;
  const region = { flicker: { px: 0, p50: 0, frames: 10 } };
  const saved = (run: string, engine: string, names: string[]): IMotionReport => ({
    scene: "mini",
    run,
    engine,
    folder: "f",
    regions: Object.fromEntries(names.map((n) => [n, region])),
  });

  it("returns the regions of the saved Unreal run, and nothing without a report", () => {
    expect(savedUnreal(undefined, scene, "switch")).toBeUndefined();
    const found = savedUnreal([saved("switch", "unreal", ["A"])], scene, "switch");
    expect(Object.keys(found ?? {})).toEqual(["A"]);
  });

  it("fails closed on a report without that run, that engine or a region of the run", () => {
    expect(() => savedUnreal([saved("pan", "unreal", ["A"])], scene, "switch")).toThrow(
      /TN_UNREAL_LOOK_BAD_INPUT.*no unreal mini\/switch/,
    );
    expect(() => savedUnreal([saved("switch", "threenative", ["A"])], scene, "switch")).toThrow(
      /no unreal mini\/switch/,
    );
    expect(() => savedUnreal([saved("switch", "unreal", ["B"])], scene, "switch")).toThrow(
      /lacks the regions A/,
    );
  });

  it("fails closed on a pan report that predates the low ghost", () => {
    const pan = {
      ...scene,
      motion: { pan: { frames: 40, regions: ["A"] } },
    } as unknown as ISceneJson;
    const withGhost = (ghost: Record<number, unknown>): IMotionReport => ({
      ...saved("pan", "unreal", []),
      regions: { A: { ...region, ghost } as IMotionReport["regions"][string] },
    });
    const old = withGhost({ 10: { px: 0.1, p50: 0.1, pixels: 5 } });
    expect(() => savedUnreal([old], pan, "pan")).toThrow(/TN_UNREAL_LOOK_BAD_INPUT.*low ghost/);
    const fresh = withGhost({ 10: { px: 0.1, p50: 0.1, pixels: 5, low: 0.02 }, 20: null });
    expect(Object.keys(savedUnreal([fresh], pan, "pan") ?? {})).toEqual(["A"]);
  });
});

// The page-side frame gate, run against a fake browser: a queue of "real" frames, and a loop that draws or is
// declined by the engine's GPU frame gate.
describe("FRAME_GATE steps the page's frame loop one frame at a time", () => {
  interface IStep {
    callbacks: number;
    drawn: number;
    skipped: number;
  }
  function page(declined: (tick: number) => boolean = () => false) {
    const real: Array<(time: number) => void> = [];
    const info = { frame: 0, engine: { frameGateSkips: 0 } };
    const win: Record<string, unknown> = {
      requestAnimationFrame: (callback: (time: number) => void) => real.push(callback),
      cancelAnimationFrame: () => undefined,
      performance: { now: () => 1000 },
      __tnRef: { renderer: { info } },
    };
    win.window = win;
    vm.runInNewContext(FRAME_GATE, win);
    const gate = win.__tnGate as {
      hold(): Promise<number>;
      step(): Promise<IStep>;
      queue: Map<number, unknown>;
    };
    const flush = () => {
      for (const callback of real.splice(0)) callback(0);
    };
    let tick = 0;
    const loop = () => {
      tick += 1;
      if (declined(tick)) info.engine.frameGateSkips += 1;
      else info.frame += 1;
      (win.requestAnimationFrame as (c: () => void) => void)(loop);
    };
    return { win, gate, info, flush, loop, real };
  }

  it("passes frames through until hold(), then runs one queued frame per step", async () => {
    const { win, gate, flush, loop, real, info } = page();
    (win.requestAnimationFrame as (c: () => void) => void)(loop);
    flush();
    expect(info.frame).toBe(1);
    expect(real).toHaveLength(1);
    const held = gate.hold();
    flush();
    await expect(held).resolves.toBe(1);
    const first = gate.step();
    flush();
    await expect(first).resolves.toEqual({ callbacks: 1, drawn: 1, skipped: 0 });
    expect(real).toHaveLength(0);
    expect(gate.queue.size).toBe(1);
    expect(info.frame).toBe(3);
  });

  // The motion blur lasts (1/30 s) over the frame time, and three measures the frame time with performance.now().
  // Unreal's sequences render at 30 frames per second, so a held loop must tick the clock 1/30 s a step.
  it("owns the clock once it holds the loop: performance.now moves 1/30 s a step", async () => {
    const { win, gate, flush, loop } = page();
    const now = () => (win.performance as { now(): number }).now();
    const seen: number[] = [];
    (win.requestAnimationFrame as (c: (time: number) => void) => void)(loop);
    flush();
    expect(now()).toBe(1000);
    const held = gate.hold();
    flush();
    await held;
    expect(now()).toBe(1000);
    for (let i = 1; i <= 3; i++) {
      const step = gate.step();
      flush();
      await step;
      seen.push(now());
    }
    expect(seen[0]).toBeCloseTo(1000 + 1000 / 30, 6);
    expect(seen[1]).toBeCloseTo(1000 + 2000 / 30, 6);
    expect(seen[2]).toBeCloseTo(1000 + 3000 / 30, 6);
    // Between two steps the clock stands still, however long the pace waits.
    expect(now()).toBe(seen[2]);
  });

  it("hands the frame callbacks the time that performance.now reads", async () => {
    const { win, gate, flush } = page();
    const got: number[] = [];
    const ask = () =>
      (win.requestAnimationFrame as (c: (time: number) => void) => void)((time) => {
        got.push(time);
        ask();
      });
    ask();
    flush();
    const held = gate.hold();
    flush();
    await held;
    const step = gate.step();
    flush();
    await step;
    expect(got.at(-1)).toBeCloseTo(1000 + 1000 / 30, 6);
    expect((win.performance as { now(): number }).now()).toBe(got.at(-1));
  });

  it("reports a render the engine declined as skipped, not drawn", async () => {
    // Ticks 1 and 2 run before the first step, so tick 4 is the second step.
    const { win, gate, flush, loop } = page((tick) => tick === 4);
    (win.requestAnimationFrame as (c: () => void) => void)(loop);
    flush();
    const held = gate.hold();
    flush();
    await held;
    const results: IStep[] = [];
    for (let i = 0; i < 3; i++) {
      const step = gate.step();
      flush();
      results.push(await step);
    }
    expect(results).toEqual([
      { callbacks: 1, drawn: 1, skipped: 0 },
      { callbacks: 1, drawn: 0, skipped: 1 },
      { callbacks: 1, drawn: 1, skipped: 0 },
    ]);
  });

  it("rejects a step whose callback throws, so the capture stops", async () => {
    const { win, gate, flush } = page();
    let broken = false;
    const loop = () => {
      if (broken) throw new Error("page broke");
      (win.requestAnimationFrame as (c: () => void) => void)(loop);
    };
    (win.requestAnimationFrame as (c: () => void) => void)(loop);
    const held = gate.hold();
    flush();
    await held;
    broken = true;
    const step = gate.step();
    flush();
    await expect(step).rejects.toThrow("page broke");
  });
});

// The harness half of the ThreeNative capture, against a fake page: the order of the steps, the frames it writes,
// the repeat of a step the engine declined, and the steps that stop the capture.
describe("captureMotionFrames walks a run one rendered frame per step", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  interface IStep {
    callbacks: number;
    drawn: number;
    skipped: number;
  }
  const OK: IStep = { callbacks: 1, drawn: 1, skipped: 0 };
  const scene = {
    motion: {
      switch: {
        frames: 3,
        camera: { kind: "pose", pose: "p" },
        light: { name: "Lamp", keys: [[0, 1]] },
        stills: [1],
      },
    },
  } as unknown as ISceneJson;

  function run(script: IStep[], runName = "switch") {
    const out = mkdtempSync(path.join(os.tmpdir(), "tn-motion-capture-"));
    roots.push(out);
    const calls: string[] = [];
    const page = {
      evaluate: async (code: string) => {
        calls.push(code);
        if (code === "window.__tnGate.hold()") return 1;
        if (code === "window.__tnGate.step()") return script.shift() ?? OK;
        return undefined;
      },
      waitForTimeout: async () => undefined,
      screenshot: async () => Buffer.from("png"),
    } as unknown as Page;
    const done = captureMotionFrames({
      page,
      scene,
      sceneId: "gi:mini",
      layer: "L7",
      run: runName,
      out,
      warmUp: 2,
      paceMs: 0,
    });
    return { out, calls, done, dir: path.join(out, "mini", "motion", "switch", "L7") };
  }

  it("warms up at frame 0, then writes each frame and each still under Unreal's names", async () => {
    const { calls, done, dir } = run([]);
    await expect(done).resolves.toBe(4);
    expect(readdirSync(dir).sort()).toEqual([
      "motion-capture.json",
      "still-0001.0000.png",
      "switch.0000.png",
      "switch.0001.png",
      "switch.0002.png",
    ]);
    const poses = calls.filter((c) => c.startsWith("window.__tnRef.motionFrame"));
    expect(poses).toEqual([0, 0, 1, 2, 1].map((f) => `window.__tnRef.motionFrame("switch", ${f})`));
    // The loop is held before the first pose is set, so no frame of the page's own timing is drawn for it.
    expect(calls[0]).toBe("window.__tnGate.hold()");
    expect(calls[1]).toBe('window.__tnRef.motionFrame("switch", 0)');
    const record = JSON.parse(readFileSync(path.join(dir, "motion-capture.json"), "utf8"));
    // 2 warm-up steps, 3 frames, then 2 warm-up steps and 1 step for the still.
    expect(record).toMatchObject({
      steps: 8,
      frames: 3,
      stills: [1],
      stepsRepeatedForTheFrameGate: 0,
    });
  });

  it("repeats a step the engine's frame gate declined, and still writes every frame", async () => {
    const { done, dir } = run([OK, { callbacks: 1, drawn: 0, skipped: 1 }]);
    await expect(done).resolves.toBe(4);
    const record = JSON.parse(readFileSync(path.join(dir, "motion-capture.json"), "utf8"));
    expect(record.stepsRepeatedForTheFrameGate).toBe(1);
    expect(record.steps).toBe(8);
  });

  it("stops on a step that both drew and skipped, with no callback, or with no draw", async () => {
    await expect(run([{ callbacks: 1, drawn: 1, skipped: 1 }]).done).rejects.toThrow(
      /TN_UNREAL_LOOK_FRAME_STEP: switch warm-up 0: 1 callbacks, 1 frames drawn, 1 skipped/,
    );
    await expect(run([OK, { callbacks: 0, drawn: 1, skipped: 0 }]).done).rejects.toThrow(
      /warm-up 1: 0 callbacks/,
    );
    await expect(run([OK, OK, { callbacks: 1, drawn: 0, skipped: 0 }]).done).rejects.toThrow(
      /switch frame 0: 1 callbacks, 0 frames drawn, 0 skipped/,
    );
  });

  it("names a run the scene does not have", async () => {
    await expect(run([], "orbit").done).rejects.toThrow(/TN_UNREAL_LOOK_BAD_INPUT.*orbit/);
  });
});

describe("swing: lamp shadow redraws over a moving caster (PRD-650 AC-2)", () => {
  const swing = {
    frames: 180,
    camera: { kind: "pose", pose: "spot" },
    actor: {
      name: "Crate",
      keys: [
        [60, 0, 0, 0],
        [120, -1, 0, 0.8],
      ],
    },
  } as unknown as IMotionRun;
  const readings = (redraw: (frame: number) => number) =>
    Array.from({ length: 180 }, (_, frame) => ({ frame, redraws: redraw(frame) }));

  it("counts no redraw while still, and no lag when the map redraws in the frame the caster moved", () => {
    expect(
      swingRedraws(
        swing,
        readings((f) => (f > 60 && f <= 120 ? 3 : 0)),
      ),
    ).toEqual({
      stillBefore: 0,
      stillAfter: 0,
      maxLag: 0,
      moving: 60,
    });
  });

  it("measures a redraw one frame late, redraws while still, and fails on a missing frame", () => {
    expect(
      swingRedraws(
        swing,
        readings((f) => (f > 61 && f <= 121 ? 1 : f === 10 || f === 140 ? 1 : 0)),
      ),
    ).toEqual({
      stillBefore: 1,
      stillAfter: 1,
      maxLag: 1,
      moving: 60,
    });
    expect(() => swingRedraws(swing, readings(() => 0).slice(1))).toThrow(
      /TN_UNREAL_LOOK_MISSING_FRAME/,
    );
  });

  it("refuses an actor that is not a region, or keys out of order", () => {
    const scene = { lights: [], poses: [{ name: "spot" }], regions: { Crate: [1, 2, 3] } };
    expect(() => validateMotion({ swing }, scene)).not.toThrow();
    const ghost = {
      ...swing,
      actor: { name: "Ghost", keys: swing.actor?.keys ?? [] },
    } as IMotionRun;
    expect(() => validateMotion({ swing: ghost }, scene)).toThrow(/actor Ghost is not a region/);
    const backwards = {
      ...swing,
      actor: {
        name: "Crate",
        keys: [
          [120, 0, 0, 0],
          [60, 0, 0, 0],
        ],
      },
    } as IMotionRun;
    expect(() => validateMotion({ swing: backwards }, scene)).toThrow(/ascending/);
  });
});
