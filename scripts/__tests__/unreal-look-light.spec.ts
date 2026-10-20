import { describe, expect, it } from "vitest";
import {
  EMISSIVE_UNITS,
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  bakeSkyRadiance,
  sunTransmittance,
  temperatureColour,
} from "../unreal-look/scaffold/render/atmosphere.js";

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
});
