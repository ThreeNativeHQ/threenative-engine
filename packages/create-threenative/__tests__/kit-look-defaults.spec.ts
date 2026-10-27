import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TEMPLATE_ROOT, allTemplates } from "../../../test-support/templates.js";

/**
 * PRD-723 migration phase 1: every shipped kit takes its quality tiers and world environment
 * from `@threenative/core` instead of a vendored copy, and a fresh scene starts on Unreal's
 * filmic curve with metered auto exposure.
 */
const KITS = allTemplates();
const ASSET_ROOT = path.resolve("packages/create-threenative/template-assets");
// Captured from origin/develop 53fbfa18b before replacing the vendored chain.
const LEGACY_PRESETS = JSON.parse(
  readFileSync(new URL("./fixtures/kit-look-legacy.json", import.meta.url), "utf8"),
) as Record<string, Record<string, Record<string, unknown>>>;
const LEGACY_DEFAULTS = {
  autoExposureEnabled: false,
  bloomEnabled: true,
  bloomRadius: 0.5,
  bloomStrength: 0.7,
  bloomThreshold: 0.2,
  exposure: 1,
  gtaoEnabled: false,
  gtaoRadius: 0.25,
  gtaoSamples: 16,
  localExposureEnabled: false,
  motionBlurEnabled: false,
  renderChainTier: "high",
  ssgiEnabled: false,
  ssrEnabled: false,
  temporalAA: false,
  tonemapMode: "aces",
  unrealBloomEnabled: false,
  vignetteAmount: 0,
};
const TIERS = ["low", "medium", "high"] as const;

const VENDORED_RENDER_FILES = [
  "worldEnvironment",
  "autoExposure",
  "exposureGraph",
  "exposureReadback",
  "tonemap",
  "localExposure",
  "motionBlur",
  "unrealBloom",
  "vignette",
] as const;

/**
 * Kits whose look may deviate from the phase-1 defaults. Every key needs a nonempty reason
 * tracking its pending visual migration; remove each entry only after IMPROVEMENT.
 */
const LOOK_OVERRIDES: Readonly<Record<string, string>> = {
  shooter:
    "owner 2026-10-26 prefers the 7b546d6 neutral look (ACES, fixed exposure 0.62, no gather)",
};

/** Runtime names imported from `@threenative/core` in one file. */
function coreImportNames(file: string): ReadonlySet<string> {
  const source = readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']@threenative\/core["']/g,
  )) {
    const block = match[1];
    if (block === undefined) throw new Error("Core import has no binding list");
    for (const part of block.split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (name !== undefined && name !== "") names.add(name);
    }
  }
  return names;
}

function renderFile(kit: string, name: string): string {
  return path.join(TEMPLATE_ROOT, kit, "src", "render", name);
}

describe("PRD-723 phase 1 kit look defaults", () => {
  it("discovers the shipped kits from disk", () => {
    expect(KITS.length).toBeGreaterThan(0);
  });

  it("keeps look overrides pointed at real kits with a reason", () => {
    expect(Object.keys(LOOK_OVERRIDES).filter((kit) => !KITS.includes(kit))).toEqual([]);
    expect(
      Object.entries(LOOK_OVERRIDES)
        .filter(([, reason]) => reason.trim() === "")
        .map(([kit]) => kit),
    ).toEqual([]);
  });

  it.each(KITS)("%s quality.ts imports qualityPreset and qualityTiers from core", (kit) => {
    const imports = coreImportNames(renderFile(kit, "quality.ts"));
    expect(imports.has("qualityPreset")).toBe(true);
    expect(imports.has("qualityTiers")).toBe(true);
  });

  it.each(KITS)("%s postprocessing.ts imports WorldEnvironment from core", (kit) => {
    expect(coreImportNames(renderFile(kit, "postprocessing.ts")).has("WorldEnvironment")).toBe(
      true,
    );
  });

  it.each(VENDORED_RENDER_FILES)("%s.ts is not vendored in template-assets or any kit", (name) => {
    const present = [
      path.join(ASSET_ROOT, `${name}.ts`),
      ...KITS.map((kit) => renderFile(kit, `${name}.ts`)),
    ].filter((file) => existsSync(file));
    expect(present).toEqual([]);
  });

  it.each(KITS)(
    "%s resolves the core look or its documented migration exception on every tier",
    async (kit) => {
      const module = (await import(pathToFileURL(renderFile(kit, "quality.ts")).href)) as Record<
        string,
        unknown
      >;
      const qualityPreset = module.qualityPreset;
      if (typeof qualityPreset !== "function") {
        throw new Error(`${kit}/src/render/quality.ts does not export qualityPreset.`);
      }
      for (const tier of TIERS) {
        const preset = qualityPreset(tier) as {
          readonly autoExposureEnabled?: boolean;
          readonly tonemapMode?: string;
        };
        if (LOOK_OVERRIDES[kit] !== undefined) {
          const previous = LEGACY_PRESETS[kit]?.[tier];
          if (previous === undefined) throw new Error(`Missing legacy preset ${kit}/${tier}`);
          const expected = { ...LEGACY_DEFAULTS, ...previous, samples: previous.samples ?? 4 };
          expect(
            Object.fromEntries(Object.keys(expected).map((key) => [key, Reflect.get(preset, key)])),
            `${kit}/${tier} preserves develop options`,
          ).toEqual(expected);
          continue;
        }
        expect(preset.tonemapMode, `${kit}/${tier} tonemapMode`).toBe("filmic");
        expect(preset.autoExposureEnabled, `${kit}/${tier} autoExposureEnabled`).toBe(true);
      }
      expect(() => qualityPreset("ultra"), `${kit} rejects an unknown tier`).toThrow();
    },
  );

  it("rts explicitly pins full resolution for thin gameplay cues", async () => {
    const { default: config } = await import("../templates/rts/threenative.config.js");
    expect(config.renderer?.resolutionScale).toBe(1);
    expect(config.display?.maxFps).toBe(60);
  });

  it.each(TIERS)("rts/%s retains authored costs with its enabled meter policy", async (tier) => {
    const { qualityPreset } = await import("../templates/rts/src/render/quality.js");
    const { exposureSettings } = await import("../templates/rts/src/render/exposure.js");
    const previous = LEGACY_PRESETS.rts?.[tier];
    if (previous === undefined) throw new Error(`Missing legacy preset rts/${tier}`);
    const expected = { ...LEGACY_DEFAULTS, ...previous, samples: previous.samples ?? 4 };
    const { tonemapMode: _curve, autoExposureEnabled: _meter, ...costs } = expected;
    const preset = qualityPreset(tier);
    expect(
      Object.fromEntries(Object.keys(costs).map((key) => [key, Reflect.get(preset, key)])),
    ).toEqual(costs);
    expect(preset.exposurePolicy).toBe(exposureSettings);
    expect(exposureSettings.enabled).toBe(true);
  });

  it.each(TIERS)(
    "minimal/%s follows the core preset with the authored core exposure policy",
    async (tier) => {
      const quality = (await import(pathToFileURL(renderFile("minimal", "quality.ts")).href)) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(pathToFileURL(renderFile("minimal", "exposure.ts")).href)) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual(core.exposureSettings);
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
      });
      expect(preset.tonemapMode, `minimal/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `minimal/${tier} metered exposure`).toBe(true);
    },
  );

  it.each(TIERS)(
    "shooter/%s is core's preset plus the named neutral-look overrides",
    async (tier) => {
      const quality = (await import(pathToFileURL(renderFile("shooter", "quality.ts")).href)) as {
        neutralLook: Record<string, unknown>;
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(pathToFileURL(renderFile("shooter", "exposure.ts")).href)) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      expect(exposure.exposureSettings).toEqual({ ...core.exposureSettings, key: 0.14 });
      expect(quality.neutralLook).toEqual({
        tonemapMode: "aces",
        autoExposureEnabled: false,
        exposure: 0.62,
        bloomRadius: 0.5,
        bloomStrength: 0.7,
        bloomThreshold: 0.2,
        finalGatherMethod: "none",
        ssgiEnabled: false,
        ssrEnabled: false,
        gtaoDistanceExponent: 1,
        gtaoDistanceFalloff: 1,
        gtaoIndirectOnly: false,
        gtaoRadius: 0.35,
        gtaoSamples: 16,
        samples: 4,
        motionBlurEnabled: false,
      });
      const tiers: Record<string, Record<string, unknown>> = {
        high: {},
        medium: { gtaoSamples: 8 },
        low: { gtaoEnabled: false, gtaoRadius: 0.25, motionBlurEnabled: false, temporalAA: false },
      };
      expect(quality.qualityPreset(tier)).toEqual({
        ...core.qualityPreset(tier),
        ...quality.neutralLook,
        ...tiers[tier],
        exposurePolicy: exposure.exposureSettings,
      });
    },
  );

  it.each(TIERS)(
    "tower-defense/%s follows the core preset with its two named exposure overrides",
    async (tier) => {
      const quality = (await import(
        pathToFileURL(renderFile("tower-defense", "quality.ts")).href
      )) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(
        pathToFileURL(renderFile("tower-defense", "exposure.ts")).href
      )) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual({
        ...core.exposureSettings,
        maxStops: 0.3,
        minStops: -1,
      });
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
      });
      expect(preset.tonemapMode, `tower-defense/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `tower-defense/${tier} metered exposure`).toBe(true);
    },
  );

  it.each(TIERS)(
    "action-rpg/%s follows the core preset with its named exposure and cost overrides",
    async (tier) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const quality = (await import(
        pathToFileURL(renderFile("action-rpg", "quality.ts")).href
      )) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(
        pathToFileURL(renderFile("action-rpg", "exposure.ts")).href
      )) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual({
        ...core.exposureSettings,
        maxStops: 0.3,
        minStops: -2,
      });
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
        finalGatherMethod: "none",
        ssgiEnabled: false,
        ssrEnabled: false,
      });
      expect(preset.tonemapMode, `action-rpg/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `action-rpg/${tier} metered exposure`).toBe(true);
    },
  );

  it.each(TIERS)(
    "puzzle/%s follows the core preset with its named exposure and cost overrides",
    async (tier) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const quality = (await import(pathToFileURL(renderFile("puzzle", "quality.ts")).href)) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(pathToFileURL(renderFile("puzzle", "exposure.ts")).href)) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual({
        ...core.exposureSettings,
        maxStops: 0.5,
        minStops: -2,
      });
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
        finalGatherMethod: "none",
        ssgiEnabled: false,
        ssrEnabled: false,
        motionBlurEnabled: false,
        gtaoResolutionScale: 0.5,
        localExposureEnabled: false,
        unrealBloomEnabled: false,
        bloomRadius: 0.42,
        bloomStrength: 0.5,
        bloomThreshold: 0.85,
      });
      expect(preset.tonemapMode, `puzzle/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `puzzle/${tier} metered exposure`).toBe(true);
    },
  );

  it.each(TIERS)(
    "sailing/%s follows the core preset with its named cost override",
    async (tier) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const quality = (await import(pathToFileURL(renderFile("sailing", "quality.ts")).href)) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(pathToFileURL(renderFile("sailing", "exposure.ts")).href)) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual(core.exposureSettings);
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
        finalGatherMethod: "none",
        ssgiEnabled: false,
        ssrEnabled: false,
        motionBlurEnabled: false,
      });
      expect(preset.tonemapMode, `sailing/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `sailing/${tier} metered exposure`).toBe(true);
    },
  );

  it.each(TIERS)(
    "rain/%s follows the core preset with its own post pass doing bloom and grade",
    async (tier) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const quality = (await import(pathToFileURL(renderFile("rain", "quality.ts")).href)) as {
        qualityPreset: (tier: string) => Record<string, unknown>;
      };
      const exposure = (await import(pathToFileURL(renderFile("rain", "exposure.ts")).href)) as {
        exposureSettings: Record<string, unknown>;
      };
      const core = await import("@threenative/core");
      const preset = quality.qualityPreset(tier);
      expect(exposure.exposureSettings).toEqual({
        ...core.exposureSettings,
        maxStops: 0.8,
        minStops: -2,
      });
      expect(preset).toEqual({
        ...core.qualityPreset(tier),
        exposurePolicy: exposure.exposureSettings,
        bloomEnabled: false,
        denoiseEnabled: false,
        finalGatherMethod: "none",
        gtaoEnabled: false,
        localExposureEnabled: false,
        motionBlurEnabled: false,
        sharpenEnabled: false,
        ssgiEnabled: false,
        ssrEnabled: false,
        temporalAA: false,
        unrealBloomEnabled: false,
        vignetteAmount: 0,
        samples: 4,
      });
      expect(preset.tonemapMode, `rain/${tier} tonemapMode`).toBe("filmic");
      expect(preset.autoExposureEnabled, `rain/${tier} metered exposure`).toBe(true);
    },
  );
  it.each(TIERS)("snow/%s follows the core preset with its named cost override", async (tier) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const quality = (await import(pathToFileURL(renderFile("snow", "quality.ts")).href)) as {
      qualityPreset: (tier: string) => Record<string, unknown>;
    };
    const exposure = (await import(pathToFileURL(renderFile("snow", "exposure.ts")).href)) as {
      exposureSettings: Record<string, unknown>;
      EXPOSURE_BIAS: { clear: number; blizzard: number };
      exposureBias: (storm: number) => number;
    };
    const core = await import("@threenative/core");
    const preset = quality.qualityPreset(tier);
    expect(exposure.exposureSettings).toEqual(core.exposureSettings);
    // Exposure compensation per weather: two stops over the meter in clear weather, less in the
    // blizzard, blended on the eased storm level so the change never pops.
    expect(exposure.exposureBias(0)).toBe(2);
    expect(exposure.exposureBias(1)).toBe(exposure.EXPOSURE_BIAS.blizzard);
    expect(exposure.EXPOSURE_BIAS.blizzard).toBeLessThan(exposure.EXPOSURE_BIAS.clear);
    expect(exposure.exposureBias(0.5)).toBeCloseTo(
      (exposure.EXPOSURE_BIAS.clear + exposure.EXPOSURE_BIAS.blizzard) / 2,
    );
    expect(preset).toEqual({
      ...core.qualityPreset(tier),
      exposurePolicy: exposure.exposureSettings,
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
      temporalAA: false,
      motionBlurEnabled: false,
      bloomEnabled: false,
      localExposureEnabled: false,
    });
    expect(preset.tonemapMode, `snow/${tier} tonemapMode`).toBe("filmic");
    expect(preset.autoExposureEnabled, `snow/${tier} metered exposure`).toBe(true);
  });
});
