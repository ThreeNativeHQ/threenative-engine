import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
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

  it("takes the contact occlusion URL knobs on a calibration scene", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-ao-knobs-"));
    copyFileSync(join(SCAFFOLD, "aoReach.ts"), join(dir, "aoReach.ts"));
    const { gtaoUrlKnobs } = (await import(
      /* @vite-ignore */ pathToFileURL(join(dir, "aoReach.ts")).href
    )) as typeof import("../unreal-look/scaffold/render/aoReach.js");
    // The arm that turns every 340abbffd part off, as the mirror-room Wall_Green paired runs used it.
    expect(
      gtaoUrlKnobs(
        new URLSearchParams(
          "gtaoR=0.12&gtaoSamples=16&gtaoMultiBounceAlbedo=0&gtaoIndirectOnly=0&tnGi=x",
        ),
      ),
    ).toEqual({
      gtaoRadius: 0.12,
      gtaoSamples: 16,
      gtaoMultiBounceAlbedo: 0,
      gtaoIndirectOnly: false,
    });
    expect(gtaoUrlKnobs(new URLSearchParams("gtaoIndirectOnly=1"))).toEqual({
      gtaoIndirectOnly: true,
    });
    expect(gtaoUrlKnobs(new URLSearchParams(""))).toEqual({});
    expect(readFileSync(join(SCAFFOLD, "../CalibrationScene.ts.in"), "utf8")).toContain(
      "gtaoUrlKnobs(params)",
    );
  });
});
