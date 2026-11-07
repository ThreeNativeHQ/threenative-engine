import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { LEVEL_EXPOSURE } from "../unreal-look/scaffold/render/atmosphere.js";

/**
 * The scaffold's own `rendererGate.ts` is copied beside `quality.ts`, which re-exports it; the
 * framework's copy moved to `@threenative/core/render/environment` (PRD-833) and this capture harness
 * stays independent of the engine. The return type names only what this spec reads: a
 * `typeof import()` of `quality.ts` would pull the scaffold's own imports into the typecheck.
 */
async function loadQuality(): Promise<{
  giPreset(tier: string): object;
  qualityPreset(tier: string): { exposure?: number };
  shadowPreset(tier: string): object;
}> {
  const dir = makeTempDirSync("tn-gi-tier-");
  copyFileSync(
    join(__dirname, "../unreal-look/scaffold/render/quality.ts"),
    join(dir, "quality.ts"),
  );
  // `quality.ts` reads the level's fixed exposure from `atmosphere.ts` (PRD-646 round 6).
  copyFileSync(
    join(__dirname, "../unreal-look/scaffold/render/atmosphere.ts"),
    join(dir, "atmosphere.ts"),
  );
  // The scaffold's own gate, not a borrowed one: the starter's copy is the engine's now
  // (`@threenative/core/render/environment`), and this capture harness stays independent of it.
  copyFileSync(
    join(__dirname, "../unreal-look/scaffold/render/rendererGate.ts"),
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

  it("throws on a name that is not a tier", async () => {
    const { giPreset } = await loadQuality();
    expect(() => giPreset("ultra")).toThrow();
  });
});

describe("the level's fixed exposure (PRD-646)", () => {
  // A tier that states the exposure itself shadows the ported value and draws the wrong frame in silence: the
  // first round-6 arm read 0.399 of Unreal because the preset's own `exposure: 1` won over the fallback.
  it("draws every tier with LEVEL_EXPOSURE, so no preset can shadow the ported 2.4", async () => {
    const { qualityPreset } = await loadQuality();
    expect(LEVEL_EXPOSURE).toBeCloseTo(2.4, 9);
    for (const tier of ["low", "medium", "high"])
      expect(qualityPreset(tier).exposure).toBe(LEVEL_EXPOSURE);
  });
});

describe("shadow tier table (PRD-652)", () => {
  it("low casts no shadow, as Unreal sg.ShadowQuality 0 draws none", async () => {
    const { shadowPreset } = await loadQuality();
    expect(shadowPreset("low")).toMatchObject({ castShadows: false, shadowQuality: 0 });
  });

  it("carries no fixed-millisecond budget: the frame period decides, not a stage time that moves with the GPU clock", async () => {
    const { shadowPreset } = await loadQuality();
    for (const tier of ["low", "medium", "high"])
      expect(shadowPreset(tier)).not.toHaveProperty("budgetMs");
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
