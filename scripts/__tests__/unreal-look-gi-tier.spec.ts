import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The scaffold copies the starter's `rendererGate.ts` beside `quality.ts`, which re-exports it. The
 * return type names only what this spec reads: a `typeof import()` of `quality.ts` would pull the
 * scaffold's own imports (`./grade.js`, `./rendererGate.js`) into the repository typecheck.
 */
async function loadQuality(): Promise<{
  giPreset(tier: string): object;
  qualityPreset(tier: string): object;
  shadowPreset(tier: string): object;
}> {
  const dir = mkdtempSync(join(tmpdir(), "tn-gi-tier-"));
  copyFileSync(
    join(__dirname, "../unreal-look/scaffold/render/quality.ts"),
    join(dir, "quality.ts"),
  );
  copyFileSync(
    join(
      __dirname,
      "../../packages/create-threenative/templates/starter/src/render/rendererGate.ts",
    ),
    join(dir, "rendererGate.ts"),
  );
  return import(/* @vite-ignore */ pathToFileURL(join(dir, "quality.ts")).href);
}

describe("GI tier table (PRD-644)", () => {
  it("low follows sg.GlobalIlluminationQuality 0: no distance field AO, sky light x 0.8", async () => {
    const { giPreset } = await loadQuality();
    expect(giPreset("low")).toMatchObject({
      distanceFieldAO: false,
      finalGatherMethod: "none",
      globalIlluminationQuality: 0,
      skylightIntensityMultiplier: 0.8,
    });
  });

  it("medium and high keep distance field AO and the full sky light", async () => {
    const { giPreset } = await loadQuality();
    for (const tier of ["medium", "high"]) {
      expect(giPreset(tier)).toMatchObject({
        distanceFieldAO: true,
        skylightIntensityMultiplier: 1,
      });
    }
  });

  it("high gathers with screen probes, 16 x 16 rays, filtered over the neighbouring probes (PRD-640)", async () => {
    const { qualityPreset } = await loadQuality();
    expect(qualityPreset("high")).toMatchObject({
      finalGatherMethod: "screenProbeGather",
      ssgiDenoiseRadius: 16,
      ssgiProbeRays: 16,
      ssgiScreenProbes: true,
    });
    expect(qualityPreset("high")).not.toHaveProperty("ssgiProbeFilterPasses");
  });

  it("medium keeps its world-space probes and low its none", async () => {
    const { qualityPreset } = await loadQuality();
    expect(qualityPreset("medium")).toMatchObject({ finalGatherMethod: "irradianceField" });
    expect(qualityPreset("low")).toMatchObject({ finalGatherMethod: "none" });
  });

  it("throws on a name that is not a tier", async () => {
    const { giPreset } = await loadQuality();
    expect(() => giPreset("ultra")).toThrow();
  });
});

describe("shadow tier table (PRD-652)", () => {
  it("low casts no shadow, as Unreal sg.ShadowQuality 0 draws none", async () => {
    const { shadowPreset } = await loadQuality();
    expect(shadowPreset("low")).toMatchObject({ castShadows: false, shadowQuality: 0 });
  });

  it("budgets each tier's shadow passes at Unreal's measured ShadowDepths time (0 at Low, 0.46 ms at Medium and Epic)", async () => {
    const { shadowPreset } = await loadQuality();
    expect(shadowPreset("low")).toMatchObject({ budgetMs: 0 });
    expect(shadowPreset("medium")).toMatchObject({ budgetMs: 0.46 });
    expect(shadowPreset("high")).toMatchObject({ budgetMs: 0.46 });
  });

  it("medium casts with 4 + 4 taps and keeps the sun clip levels", async () => {
    const { shadowPreset } = await loadQuality();
    expect(shadowPreset("medium")).toMatchObject({
      castShadows: true,
      filter: { blockerSamples: 4, filterSamples: 4 },
      resolutionLodBiasDirectional: 0,
    });
  });

  it("high keeps the pre-change sun look: 16 + 16 taps and no resolution bias", async () => {
    const { shadowPreset } = await loadQuality();
    expect(shadowPreset("high")).toMatchObject({
      castShadows: true,
      filter: { blockerSamples: 16, filterSamples: 16 },
      resolutionLodBiasDirectional: 0,
    });
  });
});
