import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { TILE_INSIDE_SQUARE } from "../starter/forest/render/ground/horizon.js";

/**
 * PRD-790: the forest kit's streamed tiles keep the skirt each one hangs on the square's edge. A mask
 * cut on the edge itself dropped it, and the square-to-tile cracks showed the sky as a white crest line.
 */
it("keeps the streamed tile skirt that hangs on the forest square's edge", () => {
  const half = 256;
  for (const x of [half - 1e-3, half, half + 1e-3])
    expect(Math.abs(x)).toBeGreaterThan(half - TILE_INSIDE_SQUARE);
  expect(TILE_INSIDE_SQUARE).toBeLessThan(2);
  const terrain = readFileSync(
    new URL("../starter/forest/render/ground/terrain.ts", import.meta.url),
    "utf8",
  );
  expect(terrain).toMatch(/greaterThan\(\s*data\.size \/ 2 - TILE_INSIDE_SQUARE,?\s*\)/);
});
