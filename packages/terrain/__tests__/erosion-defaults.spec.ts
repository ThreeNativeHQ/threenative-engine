import { Terrain } from "@threenative/terrain";
import type { ITerrainState } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

const NEIGHBOURS: readonly [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** A sloped, noisy hill — the landform whose default weathering is under-dosed today. */
const hill = (
  resolution: number,
  erosion?: { droplets: number; maxSteps: number; erosion?: number },
): Terrain => {
  const recipe = new Terrain({ size: 512, resolution, seed: 73 })
    .noise({ id: "hills", base: 30, amplitude: 34, scale: 190, warp: 35, octaves: 5 })
    .stamp({
      id: "eroded-hill",
      at: [-40, -60],
      radius: [130, 105],
      amplitude: 65,
      shape: "mountain",
      roughness: 0.17,
    });
  return erosion
    ? recipe.erode({ id: "weathering", method: "hydraulic", ...erosion })
    : recipe.erode({ id: "weathering", method: "hydraulic" });
};

/**
 * Cells that drain more than an eighth of the grid *and* sit in a hollow: the incised channel
 * network. Raw flow-accumulation count alone is not enough — erosion widens a channel, which can
 * merge neighbouring catchments, so it is the hollow that proves the pass cut downwards.
 */
function channelCells(state: ITerrainState): number {
  const n = state.resolution;
  const h = state.height;
  const area = new Float64Array(h.length).fill(1);
  const order = Array.from({ length: h.length }, (_v, i) => i).sort(
    (a, b) => (h[b] as number) - (h[a] as number),
  );
  for (const i of order) {
    const z = Math.floor(i / n);
    const x = i - z * n;
    if (x === 0 || z === 0 || x === n - 1 || z === n - 1) continue;
    let best = -1;
    let bestH = h[i] as number;
    for (const [dx, dz] of NEIGHBOURS) {
      const j = (z + dz) * n + x + dx;
      if ((h[j] as number) < bestH) {
        bestH = h[j] as number;
        best = j;
      }
    }
    if (best >= 0) area[best] = (area[best] as number) + (area[i] as number);
  }
  let count = 0;
  for (let z = 2; z < n - 2; z += 1)
    for (let x = 2; x < n - 2; x += 1) {
      const i = z * n + x;
      if ((area[i] as number) <= n / 8) continue;
      let sum = 0;
      for (const [dx, dz] of NEIGHBOURS) sum += h[(z + dz) * n + x + dx] as number;
      if ((h[i] as number) < sum / 8 - 0.4) count += 1;
    }
  return count;
}

/** Cells over a metre proud of their 8-neighbour mean: the visible single-cell spike metric. */
function spikeCount(state: ITerrainState): number {
  const n = state.resolution;
  let count = 0;
  for (let z = 1; z < n - 1; z += 1)
    for (let x = 1; x < n - 1; x += 1) {
      const i = z * n + x;
      let max = Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const v = state.height[(z + dz) * n + x + dx] as number;
        if (v > max) max = v;
        sum += v;
      }
      if ((state.height[i] as number) > max && (state.height[i] as number) - sum / 8 > 1)
        count += 1;
    }
  return count;
}

/** Mean absolute height change: how much material a pass actually moved. */
function movedMean(before: Float32Array, after: Float32Array): number {
  let total = 0;
  for (let i = 0; i < before.length; i += 1)
    total += Math.abs((after[i] as number) - (before[i] as number));
  return total / before.length;
}

describe("hydraulic erosion defaults", () => {
  it("moves several times more material on a 257 grid than the old flat 2400", () => {
    const bare = hill(257);
    bare.toggle("weathering", false);
    const base = bare.evaluate();
    const oldDose = hill(257, { droplets: 2400, maxSteps: 40 }).evaluate();
    const defaults = hill(257).evaluate();
    expect(movedMean(defaults.height, base.height)).toBeGreaterThan(
      3 * movedMean(oldDose.height, base.height),
    );
  });

  it("incises a channel network, where the old dose left the hill smooth", () => {
    const bare = hill(257);
    bare.toggle("weathering", false);
    expect(channelCells(hill(257).evaluate())).toBeGreaterThan(
      2 * channelCells(hill(257, { droplets: 2400, maxSteps: 40 }).evaluate()),
    );
    expect(channelCells(bare.evaluate())).toBeLessThan(channelCells(hill(257).evaluate()));
  });

  it("incises without leaving the dimples a deep per-step bite would", () => {
    // The count alone is not the budget: a droplet-per-cell run with the old 0.25 bite carved
    // 746 single-cell dimples standing a metre proud of their neighbours. The shallow bite cuts
    // the same drainage and leaves the surface smooth.
    const deepBite = hill(257, { droplets: 66000, maxSteps: 64, erosion: 0.25 }).evaluate();
    const shallow = hill(257, { droplets: 66000, maxSteps: 64 }).evaluate();
    expect(spikeCount(shallow)).toBeLessThan(spikeCount(deepBite) / 4);
    expect(spikeCount(shallow)).toBeLessThan(60);
  });

  it("keeps a 65 grid's default pass fast enough to bake", () => {
    const started = Date.now();
    hill(65).evaluate();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("is deterministic at grid-scaled defaults", () => {
    const a = hill(129).evaluate();
    const b = hill(129).evaluate();
    expect(a.height).toEqual(b.height);
  });
});
