import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANDFORMS, type LandformKind, Terrain, landform, terrainStats } from "../src/index.js";

// Calibration targets are measured from the USGS 3DEP 1/3 arc-second crops the strata preview
// carries (5 km, 513 samples, ~9.8 m spacing). The generator is fitted to them at seeds 7 and 11;
// the tolerances below hold for any seed, so they are wide on purpose: slopes ±max(18°, 50%),
// hypsometric integral ±0.25, relief within 30% (the finishing passes shave a few percent).
const DEM_DIR = new URL("../../../examples/strata-terrain-preview/scripts/dem/", import.meta.url);
const DEM: Partial<Record<LandformKind, string>> = {
  alpine: "alpine",
  temperateMountains: "forest",
  desertMesa: "desert",
  coastalCliffs: "coastal",
  tundra: "tundra",
};
const slopeTolerance = (target: number): number => Math.max(18, target * 0.5);

function demStats(name: string) {
  const meta = JSON.parse(readFileSync(new URL(`${name}-horizon.json`, DEM_DIR), "utf8"));
  const raw = readFileSync(new URL(`${name}-horizon.bin`, DEM_DIR));
  const heights = Float32Array.from(
    { length: meta.resolution ** 2 },
    (_, i) => raw.readInt16LE(i * 2) / 10,
  );
  return terrainStats(heights, meta.resolution, meta.size);
}

describe("landform presets", () => {
  it("evaluate to the same heights for the same seed and differ between seeds", () => {
    const a = landform("alpine", { resolution: 129, seed: 3 }).evaluate().height;
    const b = landform("alpine", { resolution: 129, seed: 3 }).evaluate().height;
    const c = landform("alpine", { resolution: 129, seed: 4 }).evaluate().height;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it("rejects an unknown kind", () => {
    expect(() => landform("swamp" as LandformKind)).toThrow(/Unknown landform kind/);
  });

  it("names a reference and a default relief for every kind", () => {
    for (const info of Object.values(LANDFORMS)) {
      expect(info.reference.length).toBeGreaterThan(10);
      expect(info.reliefRatio).toBeGreaterThan(0);
    }
  });

  it("fluvial erosion makes branching, sharp relief that noise alone does not", () => {
    // Red without the fluvial layer: the same recipe with it disabled has a smooth, thick-tailed-free
    // curvature distribution; with it, ridges and gullies give a heavy tail (DEM alpine: 89).
    const doc = landform("alpine", { seed: 7 }).toJSON();
    const off = Terrain.fromJSON({
      ...doc,
      layers: doc.layers.map((l) => (l.id === "valleys" ? { ...l, enabled: false } : l)),
    }).evaluate();
    const on = landform("alpine", { seed: 7 }).evaluate();
    const before = terrainStats(off.height, off.resolution, off.size);
    const after = terrainStats(on.height, on.resolution, on.size);
    expect(before.curvatureKurtosis).toBeLessThan(5);
    expect(after.curvatureKurtosis).toBeGreaterThan(20);
  }, 60_000);

  for (const [kind, name] of Object.entries(DEM) as [LandformKind, string][]) {
    it(`${kind} lands near the ${name} DEM statistics for several seeds`, () => {
      const dem = demStats(name);
      for (const seed of [7, 11, 23]) {
        const state = landform(kind, { seed }).evaluate();
        const s = terrainStats(state.height, state.resolution, state.size);
        expect(
          Math.abs(s.slopeP50 - dem.slopeP50),
          `${kind}/${seed} p50 ${s.slopeP50}`,
        ).toBeLessThanOrEqual(slopeTolerance(dem.slopeP50));
        expect(
          Math.abs(s.slopeP90 - dem.slopeP90),
          `${kind}/${seed} p90 ${s.slopeP90}`,
        ).toBeLessThanOrEqual(slopeTolerance(dem.slopeP90));
        expect(
          Math.abs(s.hypsometricIntegral - dem.hypsometricIntegral),
          `${kind}/${seed} HI`,
        ).toBeLessThanOrEqual(0.25);
        expect(s.relief / dem.relief, `${kind}/${seed} relief ${s.relief}`).toBeGreaterThan(0.7);
        expect(s.relief / dem.relief).toBeLessThan(1.3);
      }
    }, 120_000);
  }

  it("keeps slopes when the world is smaller, with relief scaled to the size", () => {
    const big = landform("alpine", { size: 5000, seed: 7 }).evaluate();
    const small = landform("alpine", { size: 1000, seed: 7 }).evaluate();
    const a = terrainStats(big.height, big.resolution, big.size);
    const b = terrainStats(small.height, small.resolution, small.size);
    expect(b.relief / a.relief).toBeGreaterThan(0.15);
    expect(b.relief / a.relief).toBeLessThan(0.25);
    expect(Math.abs(b.slopeP50 - a.slopeP50)).toBeLessThan(12);
  }, 60_000);

  it("honours a relief override", () => {
    const state = landform("rollingHills", { relief: 60, resolution: 257, seed: 5 }).evaluate();
    const s = terrainStats(state.height, state.resolution, state.size);
    expect(s.relief).toBeGreaterThan(48);
    expect(s.relief).toBeLessThan(66);
  });

  it("evaluates a 513 x 513 world inside the time bound", () => {
    // Measured about 1.5 s unloaded on this machine at load average 11; the bound has 5x margin.
    const start = performance.now();
    const state = landform("alpine", { seed: 7 }).evaluate();
    const ms = performance.now() - start;
    expect(state.height.every(Number.isFinite)).toBe(true);
    expect(ms).toBeLessThan(8000);
  }, 60_000);
});

describe("fluvial erode params", () => {
  it("validate their ranges", () => {
    const terrain = new Terrain({ resolution: 33 });
    expect(() => terrain.erode({ method: "fluvial", uplift: -1 })).toThrow();
    expect(() => terrain.erode({ method: "fluvial", erodibility: 0 })).toThrow();
    expect(() => terrain.erode({ method: "fluvial", timeStep: 0 })).toThrow();
    expect(() => terrain.erode({ method: "fluvial", relief: 0 })).toThrow();
    expect(() => terrain.erode({ method: "fluvial", iterations: 5 })).not.toThrow();
  });

  it("drain every cell: no interior pit survives", () => {
    const state = new Terrain({ size: 1000, resolution: 129, seed: 9 })
      .noise({ amplitude: 80, scale: 200, octaves: 5 })
      .erode({ method: "fluvial", iterations: 20 })
      .evaluate();
    const n = state.resolution;
    let pits = 0;
    for (let z = 2; z < n - 2; z += 1)
      for (let x = 2; x < n - 2; x += 1) {
        const h = state.height[z * n + x] as number;
        let lower = false;
        for (let dz = -1; dz <= 1; dz += 1)
          for (let dx = -1; dx <= 1; dx += 1)
            if ((dx || dz) && (state.height[(z + dz) * n + x + dx] as number) < h) lower = true;
        if (!lower) pits += 1;
      }
    expect(pits).toBe(0);
  });
});
