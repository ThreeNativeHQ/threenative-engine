import { afterEach, expect, it, vi } from "vitest";
import {
  type HorizonSurroundings,
  horizonSurroundings,
  setHorizonSurroundings,
} from "../src/render/ground/horizon.js";

/**
 * PRD-806 E19: `setHorizonSurroundings` read `?massif=before` off the page URL and installed the
 * bake's `forest-before` survey in place of `forest`, so a query parameter moved a shipped scene's
 * far silhouette with no override report. The baked survey is installed as baked, whatever the URL.
 */
const BAKED: HorizonSurroundings = {
  forest: { resolution: 2, size: 10, heights: [0, 1, 2, 3] },
  "forest-before": { resolution: 2, size: 10, heights: [9, 8, 7, 6] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("installs the baked survey even when the URL asks for the A/B one", () => {
  vi.stubGlobal("location", { search: "?massif=before" });
  setHorizonSurroundings(BAKED);
  expect(horizonSurroundings("forest")).toEqual(BAKED.forest);
});
