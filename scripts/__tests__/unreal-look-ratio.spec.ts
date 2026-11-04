/**
 * The scene-linear ratio instrument (PRD-646): a display level back to the light a pixel was drawn from, so
 * a calibration round can name the size of a light gap instead of reading the filmic shoulder's few levels.
 *
 * The convention the tool encodes, which is what these tests pin: the capture writes
 * `sRGB(filmicToneMap(sceneLight, exposure))` and Unreal's EXR holds the same curve input, after exposure and
 * before the tone curve. So one inversion covers both framebuffers and no exposure, no exposure factor and no
 * pi stands between an EXR and a PNG. The end-to-end proof of that on Unreal's own frames is
 * `pnpm unreal-look:ratio --selfcheck --unreal <capture>`; these are the rules it rests on.
 */
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { type IImage, decode, displayMedian } from "../unreal-look/compare.js";
import { readScene } from "../unreal-look/gi.js";
import { albedosOf, lambertRadiance, neutral, summarise } from "../unreal-look/ratio.js";
import {
  levelOfLight,
  lightOfLevel,
  linearToSrgb,
  srgbToLinear,
  unrealCurve,
} from "../unreal-look/ratioCurve.js";
import { LUT_CLIP } from "../unreal-look/scaffold/render/tonemap.js";

/** A frame where every pixel holds `level`: a synthetic capture with a known light behind it. */
function frame(level: number, pixels = 4): IImage {
  const image = new PNG({ width: pixels, height: 1 });
  for (let i = 0; i < pixels; i++) image.data.set([level, level, level, 255], i * 4);
  return decode(PNG.sync.write(image));
}

describe("a display level inverts to the light that drew it (PRD-646)", () => {
  it("round-trips a scene light through the harness's own curve", () => {
    for (const light of [0.01, 0.05, 0.18, 0.5, 1, 2, 4]) {
      const level = levelOfLight(light);
      expect(lightOfLevel(level)).toBeCloseTo(light, 4);
    }
  });

  it("reads a synthetic frame back to its light, within one byte of the curve", () => {
    for (const light of [0.05, 0.2, 0.5, 1, 2]) {
      const level = levelOfLight(light);
      const read = lightOfLevel(displayMedian(frame(Math.round(level)), new Uint8Array(4).fill(1)));
      if (read === null) throw new Error("a mid grey never saturates the curve");
      expect(Math.abs(read / light - 1)).toBeLessThan(0.02);
    }
  });

  it("is monotonic: more light is never a darker level", () => {
    let last = -1;
    // Below the curve's clip: above it every light draws the same byte, which is why a clipped row carries none.
    for (let light = 0.01; light < 4; light *= 1.2) {
      const level = levelOfLight(light);
      expect(level).toBeGreaterThan(last);
      last = level;
    }
  });

  it("gives no light for a level at the top of the curve, where a stop changes no byte", () => {
    expect(lightOfLevel(255)).toBeNull();
    expect(lightOfLevel(250)).not.toBeNull();
    // Unreal's colour LUT clips a channel at `LUT_CLIP`, so every light above it draws the same byte.
    const clipped = { ...unrealCurve(), lutClip: LUT_CLIP };
    expect(lightOfLevel(levelOfLight(LUT_CLIP, clipped), clipped)).toBeNull();
    // Mid grey is far below the clip and reads back exactly.
    expect(lightOfLevel(levelOfLight(0.18, clipped), clipped)).toBeCloseTo(0.18, 4);
  });

  it("keeps the sRGB transfer's two branches exact", () => {
    expect(linearToSrgb(0.0031308)).toBeCloseTo(0.04045, 4);
    expect(srgbToLinear(linearToSrgb(0.5))).toBeCloseTo(0.5, 12);
    expect(srgbToLinear(linearToSrgb(0.01))).toBeCloseTo(0.01, 12);
  });

  it("inverts Unreal's PNG with the source's own curve, which never expands a gamut it received expanded", () => {
    expect(unrealCurve().expandGamut).toBe(0);
    // The expansion is a no-op on a neutral grey, so a neutral row reads the same curve either way.
    expect(levelOfLight(0.5, unrealCurve())).toBeCloseTo(levelOfLight(0.5), 6);
  });
});

describe("a light ratio needs a neutral, unsaturating, lit row (PRD-646)", () => {
  it("counts a grey albedo and refuses a coloured one", () => {
    expect(neutral([0.73, 0.73, 0.73])).toBe(true);
    expect(neutral([0.3, 0.3, 0.3])).toBe(true);
    expect(neutral([0.63, 0.065, 0.05])).toBe(false);
    expect(neutral([0.14, 0.45, 0.091])).toBe(false);
    expect(neutral([0, 0, 0])).toBe(false);
  });

  it("reads a scene's neutral regions and whether each one is a horizontal slab", () => {
    const albedos = albedosOf(readScene("cornell").scene);
    expect(Object.keys(albedos).sort()).toEqual([
      "Back",
      "Box_Short",
      "Box_Tall",
      "Ceiling",
      "Floor",
      "Shade",
    ]);
    expect(albedos.Floor?.upFacing).toBe(true);
    expect(albedos.Box_Tall?.upFacing).toBe(false);
  });

  it("keeps the three rows a light scale is read on and counts out the rest", () => {
    const row = (region: string, note: string | null, ratio: number | null) => ({
      scene: "cornell",
      layer: "L1",
      pose: "cornell",
      region,
      unrealLevel: 136,
      threenativeLevel: 132.2,
      unrealLight: 0.2288,
      threenativeLight: 0.218,
      ratio,
      impliedExposure: null,
      note,
    });
    const summary = summarise([
      row("Floor", null, 0.953),
      row("Back", null, 0.959),
      row("Shade", "saturated", null),
      row("Box_Short", "black in both", null),
      row("Wall_Red", "not neutral", 0.749),
    ]);
    expect(summary.neutralRows).toBe(4);
    expect(summary.readRows).toBe(2);
    expect(summary.median).toBeCloseTo(0.956, 3);
    expect(summary.min).toBeCloseTo(0.953, 3);
    expect(summary.max).toBeCloseTo(0.959, 3);
  });

  it("computes the source rule a sunlit horizontal face follows", () => {
    // sunlit-room's exterior ground: albedo 0.3, 6 lux, a 60 degree sun.
    expect(lambertRadiance(0.3, 6, 60)).toBeCloseTo((0.3 / Math.PI) * 6 * Math.sin(Math.PI / 3), 9);
    expect(lambertRadiance(0.3, 6, 60)).toBeCloseTo(0.4962, 4);
    expect(lambertRadiance(0.45, 6, 60)).toBeCloseTo(0.7443, 4);
  });
});
