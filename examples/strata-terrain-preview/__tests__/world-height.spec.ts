import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type HorizonSurroundings,
  createHorizonCollar,
  createWorldHeight,
  setHorizonSurroundings,
} from "../src/render/horizon.js";
import type { IBakedWorld } from "../src/render/terrain.js";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/world/${name}`, import.meta.url), "utf8"));

/**
 * PRD-790 Phase 2: streamed tiles past the playable square sample one height function, so it must
 * join the square to the collar with no step anywhere along the edge, not only at the square's
 * vertices, and it must answer the heights the collar already draws.
 */
it("joins the square to the collar with no step between the edge vertices", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const forest = (read("baked.json") as { forest: IBakedWorld }).forest;
  const height = createWorldHeight(forest, "forest");
  const half = forest.size / 2;
  let gap = 0;
  // 0.37 m never lands on the 2 m vertex lattice, so every sample sits between two edge vertices.
  // Each edge point and the point 0.1 mm outward from it, on all four edges.
  const edges = [
    (a: number) => [a, half, 0, 1e-4],
    (a: number) => [a, -half, 0, -1e-4],
    (a: number) => [half, a, 1e-4, 0],
    (a: number) => [-half, a, -1e-4, 0],
  ];
  // 0.37 m never lands on the 2 m vertex lattice, so every sample sits between two edge vertices.
  for (let along = -half + 0.2; along < half - 0.2; along += 0.37)
    for (const edge of edges) {
      const [x, z, dx, dz] = edge(along) as [number, number, number, number];
      gap = Math.max(gap, Math.abs(height(x, z) - height(x + dx, z + dz)));
    }
  expect(gap).toBeLessThanOrEqual(0.01);
}, 60_000);

it("answers the heights the collar draws", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const forest = (read("baked.json") as { forest: IBakedWorld }).forest;
  const height = createWorldHeight(forest, "forest");
  const positions = createHorizonCollar(forest, "forest").geometry.getAttribute("position").array;
  let worst = 0;
  for (let i = 0; i < positions.length; i += 3 * 1009)
    worst = Math.max(
      worst,
      Math.abs(
        (positions[i + 1] as number) - height(positions[i] as number, positions[i + 2] as number),
      ),
    );
  expect(worst).toBeLessThanOrEqual(0.01);
}, 60_000);
