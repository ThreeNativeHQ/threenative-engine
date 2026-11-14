import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { meadowCover } from "../src/render/ground/scatter.js";

/**
 * PRD-806 E30: two TEMP lane A/B knobs were still live at HEAD — `?meadowBase=off` (`scatter.ts`)
 * swapped the meadow carpet for the previous grass-only arm, and `?peaks=before` (`terrain.ts`)
 * turned the backdrop's bedded strata and snow fields off. A query parameter moved a shipped
 * scene's look with no override report, so both are gone: the URL changes nothing.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

it("plants the shipped meadow carpet whatever the URL asks for", () => {
  const eye = { x: 0, z: 0 };
  const look = { x: 0, z: 100 };
  vi.stubGlobal("location", { search: "" });
  // The carpet's band: the old arm reached 100 m, the shipped one reaches `reach`.
  const shipped = meadowCover(eye, look, 20, 200);
  vi.stubGlobal("location", { search: "?meadowBase=off" });
  const ab = meadowCover(eye, look, 20, 200);
  // The shipped carpet measures itself, so a reverted arm cannot pass as "unchanged".
  expect(shipped.length).toBe(22_796);
  expect(shipped[0]?.asset).toBe("meadow");
  expect(ab).toEqual(shipped);
});

it("keeps neither knob's URL read in the render sources", () => {
  for (const name of ["terrain.ts", "scatter.ts"]) {
    const source = readFileSync(new URL(`../src/render/ground/${name}`, import.meta.url), "utf8");
    expect(/get\("(?:peaks|meadowBase)"\)/.test(source), name).toBe(false);
  }
});
