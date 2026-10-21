import { describe, expect, it } from "vitest";
import {
  EMISSIVE_UNITS,
  SKY_TO_SUN,
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  VIEW_DISTANCE_SKY_LIGHT_FIT,
  bakeSkyRadiance,
  distantSkyLight,
  sunTransmittance,
  temperatureColour,
  viewDistanceSkyLight,
} from "../unreal-look/scaffold/render/atmosphere.js";
import { filmicToneMap } from "../unreal-look/scaffold/render/tonemap.js";

describe("the harness lighting model against Unreal 5.8.3 frames (PRD-632, PRD-633)", () => {
  it("the 6500 K tint has unit luminance and Unreal's measured channel ratios", () => {
    const [r, g, b] = temperatureColour(SUN_KELVIN);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 3);
    // Unreal L1 floor, sun60: 0.9112 : 0.8596 : 0.9069 (no atmosphere, so the light's own tint).
    expect(r / g).toBeCloseTo(0.9112 / 0.8596, 1);
    expect(b / g).toBeCloseTo(0.9069 / 0.8596, 1);
  });

  it("the sun is Unreal's 6 lux in three's units, pi times larger", () => {
    expect(SUN_ILLUMINANCE).toBeCloseTo(6 * Math.PI, 10);
  });

  it("emissive 5 outshines a white surface under the sun by Unreal's ratio, 5 / (6 / pi)", () => {
    // Unreal: emissive as it stands, against albedo / pi x lux (Diffuse_Lambert, BRDF.ush:157).
    const unreal = 5 / (6 / Math.PI);
    // Here: three's Lambert divides the sun by pi, so a white surface at normal incidence reads
    // SUN_ILLUMINANCE / pi, and the emissive intensity is scaled by EMISSIVE_UNITS.
    const here = (5 * EMISSIVE_UNITS) / (SUN_ILLUMINANCE / Math.PI);
    expect(here).toBeCloseTo(unreal, 10);
    expect(unreal).toBeCloseTo(2.618, 3);
  });

  it("the sun reddens as it sets, to within a few percent of the Unreal L2 sun-lit boxes", () => {
    const deg = Math.PI / 180;
    const [r60, g60, b60] = sunTransmittance(60 * deg);
    const [r4, g4, b4] = sunTransmittance(4 * deg);
    // Unreal L2 over L1 on the sun-lit white box (sky share included): 0.95/0.88/0.78 at 60 degrees.
    expect(r60).toBeGreaterThan(0.9);
    expect(r60).toBeLessThan(0.97);
    expect(b60).toBeGreaterThan(0.68);
    expect(b60).toBeLessThan(0.8);
    expect(g60).toBeGreaterThan(b60);
    // At 4 degrees blue is almost gone and red survives, as in the Unreal frame (0.52 / 0.16 / 0.02).
    expect(r4).toBeGreaterThan(0.4);
    expect(r4).toBeLessThan(0.6);
    expect(g4).toBeLessThan(0.3);
    expect(b4).toBeLessThan(0.08);
  });

  it("the baked sky is blue overhead, brighter toward the horizon, and the nadir is dark", () => {
    const sun = { x: 0.3, y: 0.866, z: 0.4 } as const;
    const [w, h] = [32, 16];
    const sky = bakeSkyRadiance(sun, w, h);
    const texel = (row: number): number[] => {
      const o = (row * w + 3) * 3;
      return [sky[o] ?? 0, sky[o + 1] ?? 0, sky[o + 2] ?? 0];
    };
    const [zr, , zb] = texel(0);
    const [hr] = texel(h / 2 - 1);
    const [gr] = texel(h - 1);
    expect(zb).toBeGreaterThan((zr ?? 0) * 3);
    expect(hr).toBeGreaterThan((zr ?? 0) * 3);
    expect(gr).toBeLessThan((hr ?? 0) * 0.1);
    expect(sky.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it("the distant sky light, that fog and clouds are lit with, stays near the Unreal-derived colour", () => {
    // Unreal L3 sea at a fixed exposure, divided by the sun's tint and illuminance and SKY_TO_SUN
    // (the colour height fog takes from GetViewDistanceSkyLightColor), per unit sun.
    const unreal = {
      60: [0.00929, 0.01971, 0.03803],
      15: [0.00676, 0.01132, 0.01942],
    } as const;
    for (const deg of [60, 15] as const) {
      const rad = (deg * Math.PI) / 180;
      const [r, g, b] = distantSkyLight({ x: Math.cos(rad), y: Math.sin(rad), z: 0 });
      expect(b).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(r);
      // The gap is the atmosphere's known red excess at high sun (1.36 at 60 degrees), which the
      // tone curve's gamut expansion removes from the picture. A wider gap means the model moved.
      [r, g, b].forEach((v, c) => {
        const expected = unreal[deg][c];
        if (expected === undefined) throw new RangeError(`Invalid colour channel ${c}`);
        const ratio = v / expected;
        expect(ratio, `${deg} deg channel ${c}`).toBeGreaterThan(0.95);
        expect(ratio, `${deg} deg channel ${c}`).toBeLessThan(1.45);
      });
    }
  });

  it("the distant sky light dims and reddens toward sunset and stays positive", () => {
    const at = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return distantSkyLight({ x: Math.cos(rad), y: Math.sin(rad), z: 0 });
    };
    const [r60, , b60] = at(60);
    const [r4, , b4] = at(4);
    expect(b4).toBeLessThan(b60);
    expect(b4 / r4).toBeLessThan(b60 / r60);
    expect(at(4).every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it("the fogged void is Unreal's L3 void within 3 levels of 255 at both suns (fixed exposure)", () => {
    // Unreal L3 sea, cols 64-154 and rows 272-292 of the exterior pose: the fog's own colour.
    const unreal = { 60: [113, 154, 196], 15: [81, 111, 152] } as const;
    const tint = temperatureColour(SUN_KELVIN);
    const encode = (v: number) =>
      255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    for (const deg of [60, 15] as const) {
      const rad = (deg * Math.PI) / 180;
      const light = viewDistanceSkyLight({ x: Math.cos(rad), y: Math.sin(rad), z: 0 });
      const fog = light.map((v, c) => v * (tint[c] ?? 1) * SUN_ILLUMINANCE * SKY_TO_SUN);
      const shown = filmicToneMap(fog as [number, number, number]).map(encode);
      shown.forEach((v, c) => {
        const expected = unreal[deg][c];
        if (expected === undefined) throw new RangeError(`Invalid colour channel ${c}`);
        expect(Math.abs(v - expected), `${deg} deg channel ${c}`).toBeLessThan(3);
      });
    }
    expect(VIEW_DISTANCE_SKY_LIGHT_FIT.every((v) => v > 0 && v <= 1)).toBe(true);
  });
});
