import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCAFFOLD = join(__dirname, "../unreal-look/scaffold/render");

async function loadFit(): Promise<
  typeof import("../unreal-look/scaffold/render/aoMultiBounce.js")
> {
  const dir = mkdtempSync(join(tmpdir(), "tn-ao-multibounce-"));
  copyFileSync(join(SCAFFOLD, "aoMultiBounce.ts"), join(dir, "aoMultiBounce.ts"));
  return import(/* @vite-ignore */ pathToFileURL(join(dir, "aoMultiBounce.ts")).href);
}

describe("contact occlusion multi-bounce (PRD-635)", () => {
  it("caps the albedo at 0.5, as Unreal's short-range AO", async () => {
    const { UNREAL_AO_MULTIBOUNCE_ALBEDO } = await loadFit();
    expect(UNREAL_AO_MULTIBOUNCE_ALBEDO).toBe(0.5);
  });

  it("keeps full light and full shadow where nothing bounces", async () => {
    const { aoMultiBounce } = await loadFit();
    expect(aoMultiBounce(0.5, 1)).toBeCloseTo(1, 3);
    expect(aoMultiBounce(0.5, 0)).toBe(0);
  });

  it("gives back light in a crease, more for a paler surface and none past the cap", async () => {
    const { aoMultiBounce } = await loadFit();
    // Jimenez fit at occlusion 0.5: ((0.5a + b) 0.5 + c) 0.5 with a, b, c from the albedo.
    expect(aoMultiBounce(0.5, 0.5)).toBeCloseTo(0.6812, 3);
    expect(aoMultiBounce(0.2, 0.5)).toBeLessThan(aoMultiBounce(0.5, 0.5));
    expect(aoMultiBounce(0.9, 0.5)).toBe(aoMultiBounce(0.5, 0.5));
  });

  it("never darkens past the occlusion it was given, and a cap of 0 leaves it alone", async () => {
    const { aoMultiBounce } = await loadFit();
    for (const albedo of [0, 0.1, 0.5, 1])
      for (const ao of [0.1, 0.4, 0.8])
        expect(aoMultiBounce(albedo, ao)).toBeGreaterThanOrEqual(ao);
    expect(aoMultiBounce(0.8, 0.5, 0)).toBeCloseTo(0.5, 3);
  });

  it("is on the indirect path of the harness, with a named override", () => {
    const source = readFileSync(join(SCAFFOLD, "worldEnvironment.ts"), "utf8");
    expect(source).toContain("gtaoMultiBounceAlbedo");
    expect(source).toContain("aoMultiBounce");
  });
});
