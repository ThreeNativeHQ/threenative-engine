import { Terrain, sampleHeight } from "@threenative/terrain";
import type { ITerrainState } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

/** A gentle hillside: gentle enough that a road can follow it inside a 12 % grade. */
const hills = (amplitude: number): Terrain =>
  new Terrain({ size: 256, resolution: 129, seed: 11 }).noise({
    id: "ground",
    base: 12,
    amplitude,
    scale: 140,
    octaves: 4,
  });

/** Steepest rise per metre walked from `from` to `to`, in degrees. */
function steepest(
  state: ITerrainState,
  from: readonly [number, number],
  to: readonly [number, number],
): number {
  const step = 0.5;
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const length = Math.hypot(dx, dz);
  let max = 0;
  let previous = sampleHeight(state, from[0], from[1]);
  for (let d = step; d <= length; d += step) {
    const y = sampleHeight(state, from[0] + (dx * d) / length, from[1] + (dz * d) / length);
    max = Math.max(max, Math.abs(y - previous) / step);
    previous = y;
  }
  return (Math.atan(max) * 180) / Math.PI;
}

describe("spline and pad grading", () => {
  it("grades a following road onto the ground it crosses", () => {
    const recipe = (withRoad: boolean): Terrain => {
      const terrain = hills(24);
      if (withRoad)
        terrain.road({
          id: "road",
          followTerrain: true,
          points: [
            [-110, null, 20],
            [110, null, 20],
          ],
          width: 10,
          shoulder: 8,
        });
      return terrain;
    };
    const ground = recipe(false).evaluate();
    const state = recipe(true).evaluate();
    let step = 0;
    let cross = 0;
    let cut = 0;
    let fill = 0;
    for (let x = -100; x <= 100; x += 5) {
      const top = sampleHeight(state, x, 20);
      const under = sampleHeight(ground, x, 20);
      cut = Math.max(cut, top - under);
      fill = Math.max(fill, under - top);
      for (const offset of [6, -6]) {
        const beside = sampleHeight(ground, x, 20 + offset);
        cross = Math.max(cross, Math.abs(under - beside));
        step = Math.max(step, Math.abs(top - beside));
      }
    }
    // The road never stands above the ground beside it by more than its own cut/fill allowance.
    expect(step).toBeLessThanOrEqual(cross + 2.6);
    expect(cut).toBeLessThanOrEqual(1.6);
    expect(fill).toBeLessThanOrEqual(2.6);
    expect(steepest(state, [-110, 20], [110, 20])).toBeLessThan(13);
  });

  it("leaves the ground no further than the cut and fill limits allow", () => {
    // A 60 m hill at 140 m is far steeper than any road grade: the profile has to follow it.
    const recipe = (withRoad: boolean): Terrain => {
      const terrain = hills(60);
      if (withRoad)
        terrain.road({
          id: "road",
          points: [
            [-110, null, 20],
            [110, null, 20],
          ],
          width: 10,
          shoulder: 8,
        });
      return terrain;
    };
    const ground = recipe(false).evaluate();
    const state = recipe(true).evaluate();
    for (let x = -100; x <= 100; x += 5) {
      // The limits hold on the profile; sampling a 2 m grid adds a few centimetres.
      const delta = sampleHeight(state, x, 20) - sampleHeight(ground, x, 20);
      expect(delta).toBeLessThanOrEqual(1.7);
      expect(delta).toBeGreaterThanOrEqual(-2.7);
    }
  });

  it("holds a following ramp inside its grade limit", () => {
    // A 4 m bump 20 m across: 24 % at its flanks, twice what the ramp is allowed to climb. A
    // taller one cannot be graded at all, because the cut limit pins the profile to the ground.
    const side = 33;
    const values: number[] = [];
    for (let z = 0; z < side; z += 1)
      for (let x = 0; x < side; x += 1)
        values.push(Math.exp(-((((x / (side - 1)) * 256 - 128) / 14) ** 2)) * 4);
    const recipe = (withRamp: boolean): Terrain => {
      const terrain = new Terrain({ size: 256, resolution: 129, seed: 1 }).heightmap({
        id: "bump",
        data: { width: side, height: side, values },
      });
      if (withRamp)
        terrain.ramp({
          id: "ramp",
          from: [-110, null, 0],
          to: [110, null, 0],
          width: 12,
          shoulder: 6,
          maxGrade: 0.12,
        });
      return terrain;
    };
    const ground = recipe(false).evaluate();
    const state = recipe(true).evaluate();
    expect(steepest(state, [-110, 0], [110, 0])).toBeLessThan(13);
    // It rides over the bump on one long grade, at most a cut deep, instead of climbing its flank.
    expect(sampleHeight(state, 0, 0)).toBeGreaterThan(sampleHeight(ground, 0, 0) - 2.6);
  });

  it("keeps absolute control-point elevations", () => {
    const state = new Terrain({ size: 256, resolution: 65, seed: 3 })
      .road({
        id: "road",
        points: [
          [-120, 30, 0],
          [120, 30, 0],
        ],
        width: 8,
        shoulder: 4,
      })
      .evaluate();
    expect(sampleHeight(state, 0, 0)).toBeCloseTo(30, 1);
    // The 30 m fill is a batter, not a wall: it is still near the top 6 m out and back down by 80 m.
    expect(sampleHeight(state, 0, 6)).toBeGreaterThan(25);
    expect(sampleHeight(state, 0, 80)).toBeLessThan(1);
  });

  it("grades the same way every evaluation", () => {
    const recipe = (): Terrain =>
      hills(24).road({
        id: "road",
        points: [
          [-110, null, 20],
          [0, null, -20],
          [110, null, 20],
        ],
        width: 10,
        shoulder: 8,
      });
    expect(Array.from(recipe().evaluate().height)).toEqual(Array.from(recipe().evaluate().height));
  });

  it("accepts an omitted elevation only while the spline follows", () => {
    const terrain = new Terrain({ size: 128, resolution: 33 });
    expect(() =>
      terrain.road({
        id: "floating",
        points: [
          [-20, Number.NaN, 0],
          [20, Number.NaN, 0],
        ],
      }),
    ).not.toThrow();
    expect(() =>
      terrain.road({
        id: "pinned",
        followTerrain: false,
        points: [
          [-20, Number.NaN, 0],
          [20, Number.NaN, 0],
        ],
      }),
    ).toThrow(/finite/);
    expect(() =>
      terrain.road({
        id: "pinned",
        followTerrain: false,
        points: [
          [-20, null, 0],
          [20, 5, 0],
        ],
      }),
    ).toThrow(/3 numbers/);
    expect(() => terrain.evaluate().height.every(Number.isFinite)).not.toThrow();
  });

  it("levels a pad to the ground under it and batters its rim", () => {
    const base = hills(24);
    const ground = base.evaluate();
    const state = base.flatten({ id: "pad", at: [0, 0], radius: 20, falloff: 0.35 }).evaluate();
    const level = sampleHeight(state, 0, 0);
    let sum = 0;
    let count = 0;
    for (let d = -20; d <= 20; d += 2.5)
      for (let e = -20; e <= 20; e += 2.5) {
        if (Math.hypot(d, e) > 8) continue;
        sum += sampleHeight(ground, d, e);
        count += 1;
      }
    // The pad takes the local height instead of an authored one, and its rim reaches past its radius.
    expect(Math.abs(level - sum / count)).toBeLessThan(2);
    for (let d = -8; d <= 8; d += 2)
      expect(Math.abs(sampleHeight(state, d, 0) - level)).toBeLessThan(0.5);
    expect(steepest(state, [8, 0], [34, 0])).toBeLessThan(45);
    expect(steepest(state, [0, 8], [0, 34])).toBeLessThan(45);
  });

  it("carves a river bank as a soft V instead of a wall", () => {
    const base = new Terrain({ size: 256, resolution: 129, seed: 5 }).noise({
      id: "ground",
      base: 30,
      amplitude: 8,
      scale: 140,
    });
    const ground = base.evaluate();
    const state = base
      .river({
        id: "river",
        points: [
          [-120, 10, -20],
          [-40, 10, -20],
          [40, 10, -20],
          [120, 10, -20],
        ],
        width: 12,
        depth: 4,
        shoulder: 8,
      })
      .evaluate();
    // The channel has to climb back the 20 m it was carved below the hillside it crosses, over a
    // 1:1.5 batter rather than the vertical wall it used to leave at the channel edge.
    expect(sampleHeight(state, 0, -20)).toBeLessThan(sampleHeight(ground, 0, -20) - 20);
    expect(steepest(state, [0, -60], [0, -6])).toBeLessThan(50);
    expect(steepest(state, [0, -6], [0, 60])).toBeLessThan(50);
  });
});
