import { readFileSync } from "node:fs";
import { Heightfield, WATER_RIBBON_REACH, riverRibbonGeometry } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import type { IBakedRiver } from "../src/render/river.js";
import { waterSurfaceAt } from "../src/world/water.js";

const forest = JSON.parse(
  readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
).forest;
const field = new Heightfield({
  rows: forest.resolution,
  columns: forest.resolution,
  width: forest.size,
  depth: forest.size,
  origin: { x: 0, z: 0 },
  heights: Float32Array.from(forest.heights),
});

/** Whether (x, z) lies inside one of the drawn triangles, seen from above. */
function drawnAt(positions: number[], indices: number[], x: number, z: number): boolean {
  const at = (i: number) => [positions[3 * i] ?? 0, positions[3 * i + 2] ?? 0] as const;
  const cross = (a: readonly number[], b: readonly number[]) =>
    ((b[0] ?? 0) - (a[0] ?? 0)) * (z - (a[1] ?? 0)) -
    ((b[1] ?? 0) - (a[1] ?? 0)) * (x - (a[0] ?? 0));
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [at(indices[t] ?? 0), at(indices[t + 1] ?? 0), at(indices[t + 2] ?? 0)];
    const s = [cross(a, b), cross(b, c), cross(c, a)];
    if (s.every((v) => v >= 0) || s.every((v) => v <= 0)) return true;
  }
  return false;
}

describe("the forest river's drawn water", () => {
  // The owner saw the river start in a straight edge across the meadow, its carved bowl dry past it
  // (2026-11-10). The swimmer's water reaches a round cap past each end (core clamps each segment),
  // so the drawn ribbon has to reach there too.
  it("covers the water past each end of the river that the swimmer swims in", () => {
    const river = forest.rivers[0] as IBakedRiver;
    const reach = river.width * WATER_RIBBON_REACH;
    const surface = waterSurfaceAt(forest.rivers, forest.lakes, field);
    const geometry = riverRibbonGeometry([river], field, { columns: 25, maxDepth: 1.6 });
    const positions = Array.from(geometry.getAttribute("position").array);
    const indices = Array.from(geometry.getIndex()?.array ?? []);
    const [head, next] = [river.points[0], river.points[1]] as (readonly number[])[];
    const dx = (head?.[0] ?? 0) - (next?.[0] ?? 0);
    const dz = (head?.[2] ?? 0) - (next?.[2] ?? 0);
    const length = Math.hypot(dx, dz);
    const x = (head?.[0] ?? 0) + (dx / length) * reach * 0.5;
    const z = (head?.[2] ?? 0) + (dz / length) * reach * 0.5;
    const level = surface(x, z);
    expect(level).toBeDefined();
    expect(field.heightAt(x, z)).toBeLessThan(level as number);
    expect(drawnAt(positions, indices, x, z)).toBe(true);
  });
});
