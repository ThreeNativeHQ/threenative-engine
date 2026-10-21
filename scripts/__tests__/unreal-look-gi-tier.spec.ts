import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** The scaffold copies the starter's `rendererGate.ts` beside `quality.ts`, which re-exports it. */
async function loadQuality(): Promise<typeof import("../unreal-look/scaffold/render/quality.js")> {
  const dir = mkdtempSync(join(tmpdir(), "tn-gi-tier-"));
  copyFileSync(join(__dirname, "../unreal-look/scaffold/render/quality.ts"), join(dir, "quality.ts"));
  copyFileSync(
    join(__dirname, "../../packages/create-threenative/templates/starter/src/render/rendererGate.ts"),
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
      expect(giPreset(tier)).toMatchObject({ distanceFieldAO: true, skylightIntensityMultiplier: 1 });
    }
  });

  it("throws on a name that is not a tier", async () => {
    const { giPreset } = await loadQuality();
    expect(() => giPreset("ultra")).toThrow();
  });
});
