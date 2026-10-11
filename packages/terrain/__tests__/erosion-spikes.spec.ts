import { Terrain } from "@threenative/terrain";
import type { ITerrainState } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

interface IProminence {
  /** Cells over a metre above their 8-neighbour mean, tallest first: the visible spike metric. */
  spikes: number[];
  /** The tallest local prominence anywhere, spike or not. */
  worst: number;
}

const NEIGHBOURS: [number, number][] = [-1, 0, 1]
  .flatMap((dz) => [-1, 0, 1].map((dx): [number, number] => [dx, dz]))
  .filter(([dx, dz]) => dx !== 0 || dz !== 0);

function prominence(state: ITerrainState): IProminence {
  const n = state.resolution;
  const spikes: number[] = [];
  let worst = 0;
  for (let z = 1; z < n - 1; z += 1) {
    for (let x = 1; x < n - 1; x += 1) {
      const h = state.height[z * n + x] as number;
      let max = Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const v = state.height[(z + dz) * n + x + dx] as number;
        max = Math.max(max, v);
        sum += v;
      }
      if (h <= max) continue;
      const p = h - sum / 8;
      if (p > worst) worst = p;
      if (p > 1) spikes.push(p);
    }
  }
  return { spikes: spikes.sort((a, b) => b - a), worst };
}

/** The strata preview's landform: hills, one mountain, then the recipe's hydraulic weathering. */
const weathered = (shape: "mesa" | "mountain", roughness: number): Terrain =>
  new Terrain({ size: 256, resolution: 129, seed: 73 })
    .noise({ id: "hills", base: 18, amplitude: 16, scale: 180, octaves: 5 })
    .stamp({
      id: "eroded-hill",
      at: [-40, -60],
      radius: [130, 105],
      amplitude: 65,
      shape,
      roughness,
    })
    .erode({ id: "weathering", method: "hydraulic", droplets: 2400, maxSteps: 40 });

/** The same landform with and without the erosion pass, from one seeded recipe. */
const withAndWithoutErosion = (recipe: Terrain): { before: IProminence; after: IProminence } => {
  recipe.toggle("weathering", false);
  const before = prominence(recipe.evaluate());
  recipe.toggle("weathering", true);
  return { before, after: prominence(recipe.evaluate()) };
};

describe("hydraulic erosion", () => {
  it("bounds pickup by the downstream bed and settles mesa debris at the talus angle", () => {
    const recipe = new Terrain({ size: 128, resolution: 65, seed: 97 })
      .stamp({ id: "mesa", at: [0, 0], radius: 35, amplitude: 80, shape: "mesa", roughness: 0 })
      .erode({
        id: "rain",
        method: "hydraulic",
        droplets: 20000,
        maxSteps: 40,
        capacity: 7,
        erosion: 0.22,
      });
    const state = recipe.evaluate();
    expect(Math.min(...state.height)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...state.height)).toBeLessThanOrEqual(80);
    const settled = recipe
      .erode({ id: "talus", method: "thermal", talus: 34, iterations: 80 })
      .evaluate();
    expect(prominence(settled).worst).toBeLessThan(3);
  });

  it("leaves no single-cell spike standing on a mountain", () => {
    const after = prominence(weathered("mesa", 0).evaluate());
    expect(after.spikes).toEqual([]);
    expect(after.worst).toBeLessThan(0.8);
  });

  it("adds no spike where the mountain summit is already the tallest cell", () => {
    const { before, after } = withAndWithoutErosion(weathered("mountain", 0.17));
    expect(before.spikes.length).toBeGreaterThan(0);
    expect(after.spikes.length).toBeLessThanOrEqual(before.spikes.length);
    expect(after.worst).toBeLessThanOrEqual(before.worst + 0.1);
  });

  it("still moves material off the landform and evaluates deterministically", () => {
    const recipe = weathered("mesa", 0);
    recipe.toggle("weathering", false);
    const before = recipe.evaluate();
    recipe.toggle("weathering", true);
    const state = recipe.evaluate();
    let moved = 0;
    for (let i = 0; i < state.height.length; i += 1)
      moved += Math.abs((state.height[i] as number) - (before.height[i] as number));
    expect(moved / state.height.length).toBeGreaterThan(0.05);
    expect(state.height).toEqual(Terrain.fromJSON(recipe.toJSON()).evaluate().height);
  });
});
