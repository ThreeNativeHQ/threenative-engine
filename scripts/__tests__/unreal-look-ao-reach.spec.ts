import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCAFFOLD = join(__dirname, "../unreal-look/scaffold/render");

/** The scaffold copies the starter's `rendererGate.ts` beside `quality.ts`, which re-exports it. */
async function loadQuality(): Promise<{
  qualityPreset(tier: string): {
    gtaoDistanceExponent?: number;
    gtaoDistanceFalloff?: number;
    gtaoRadius?: number;
    gtaoSamples?: number;
  };
}> {
  const dir = mkdtempSync(join(tmpdir(), "tn-ao-quality-"));
  copyFileSync(join(SCAFFOLD, "quality.ts"), join(dir, "quality.ts"));
  copyFileSync(
    join(
      __dirname,
      "../../packages/create-threenative/templates/starter/src/render/rendererGate.ts",
    ),
    join(dir, "rendererGate.ts"),
  );
  return import(/* @vite-ignore */ pathToFileURL(join(dir, "quality.ts")).href);
}

describe("contact occlusion reach (PRD-635)", () => {
  it("takes Unreal's 32 px screen reach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-ao-reach-"));
    copyFileSync(join(SCAFFOLD, "aoReach.ts"), join(dir, "aoReach.ts"));
    const { UNREAL_AO_REACH_PX } = await import(
      /* @vite-ignore */ pathToFileURL(join(dir, "aoReach.ts")).href
    );
    expect(UNREAL_AO_REACH_PX).toBe(32);
  });

  it("leaves the desktop tier on the screen rule, with no world radius", async () => {
    const { qualityPreset } = await loadQuality();
    expect(qualityPreset("high").gtaoRadius).toBeUndefined();
  });

  it("steps at the squared fraction of the reach, 3 steps per direction, on every tier", async () => {
    const { qualityPreset } = await loadQuality();
    for (const tier of ["high", "medium"])
      expect(qualityPreset(tier)).toMatchObject({ gtaoDistanceExponent: 2, gtaoSamples: 7 });
  });

  it("weighs every step alike, as Unreal's horizon search", async () => {
    const { qualityPreset } = await loadQuality();
    for (const tier of ["high", "medium"]) expect(qualityPreset(tier).gtaoDistanceFalloff).toBe(0);
  });
});
