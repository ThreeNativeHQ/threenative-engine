import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  COLLAR_UNDER_TILE,
  type HorizonSurroundings,
  collarArithmeticHeight,
  collarDrawnHeight,
  collarSeamGap,
  createHorizonCollar,
  createMorphedHeight,
  createWorldHeight,
  setHorizonSurroundings,
} from "../src/render/ground/horizon.js";
import type { IBakedWorld } from "../src/render/ground/terrain.js";

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

it("finds the collar's drawn triangle by arithmetic, as the tile shader does", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const forest = (read("baked.json") as { forest: IBakedWorld }).forest;
  const collar = createHorizonCollar(forest, "forest");
  let worst = 0;
  // A spiral of points from the square's edge out to 2 km, every heading.
  for (let i = 0; i < 20000; i += 1) {
    const angle = i * 2.399963;
    const reach = 257 + (i / 20000) * 2050;
    const x = Math.cos(angle) * reach;
    const z = Math.sin(angle) * reach;
    const drawn = collarDrawnHeight(collar, x, z);
    if (drawn === null) continue;
    worst = Math.max(worst, Math.abs(collarArithmeticHeight(collar, x, z) - drawn));
  }
  expect(worst).toBeLessThanOrEqual(0.001);
}, 60_000);

/**
 * PRD-790 Phase 2 box 2. Before the band the tiles' edge stood 1.21 m off the collar at their own
 * vertices on this route; the outermost tile now slides onto the collar, so every edge vertex stands
 * on it. Between two vertices a fold of the collar's coarser triangles can still cross the 2 m edge:
 * that step is reported, not hidden.
 */
it("meets the streamed tiles with no step where the collar takes over", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const forest = (read("baked.json") as { forest: IBakedWorld }).forest;
  const collar = createHorizonCollar(forest, "forest");
  const height = createWorldHeight(forest, "forest");
  let gap = 0;
  let fold = 0;
  let before = 0;
  // The tiles' square around a player at the spawn, then along the 2 km route north-north-west.
  for (const along of [0, 300, 700, 1100, 1500, 1900]) {
    const centreX = Math.floor((-0.41 * along + 32) / 64) * 64;
    const centreZ = Math.floor((0.91 * along + 32) / 64) * 64;
    const morphed = createMorphedHeight(collar, height, centreX, centreZ, 288, 64);
    const seam = collarSeamGap(collar, morphed, centreX, centreZ, 288, 2);
    gap = Math.max(gap, seam.gap);
    fold = Math.max(fold, seam.fold);
    before = Math.max(before, collarSeamGap(collar, height, centreX, centreZ, 288, 2).gap);
  }
  expect(before).toBeGreaterThan(1);
  expect(gap).toBeLessThanOrEqual(0.01);
  expect(fold).toBeLessThanOrEqual(0.5);
  // The collar draws under the tiles' edge far enough that a view 2 degrees above the ground,
  // across the largest fold, meets a surface, not the sky: the dotted white seam from high views.
  expect(COLLAR_UNDER_TILE).toBeGreaterThanOrEqual(fold / Math.tan((2 * Math.PI) / 180));
}, 60_000);
