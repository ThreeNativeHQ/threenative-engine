import { describe, expect, it } from "vitest";
import {
  WORLD_ENVIRONMENT_STAGES,
  WORLD_ENVIRONMENT_TIERS,
  planWorldEnvironment,
} from "./world-environment.reference.js";

const webgpu = { rendererKind: "webgpu" as const };
const webgl = { rendererKind: "webgl" as const };

describe("planWorldEnvironment", () => {
  it("orders stages canonically regardless of the order they were requested in", () => {
    // Scrambled on purpose. Correct order is not a look decision — ambient occlusion has to
    // reach the GI gather, the gather has to reach the denoiser, and every one of them has
    // to precede tonemapping — so the plan owns it and the caller cannot get it wrong.
    const scrambled = planWorldEnvironment(
      { bloom: {}, ssgi: {}, denoise: {}, godrays: {}, ssr: {} },
      webgpu,
    );
    const canonical = planWorldEnvironment(
      { ssgi: {}, denoise: {}, godrays: {}, ssr: {}, bloom: {} },
      webgpu,
    );
    expect(scrambled.applied.map((entry) => entry.stage)).toEqual(
      canonical.applied.map((entry) => entry.stage),
    );
    expect(scrambled.applied.map((entry) => entry.stage)).toEqual([
      "ssgi",
      "denoise",
      "godrays",
      "ssr",
      "bloom",
    ]);
  });

  it("names every dropped stage and never drops one silently", () => {
    const plan = planWorldEnvironment({ ssgi: {}, ssr: {}, bloom: {} }, webgl);
    expect(plan.applied).toEqual([]);
    expect(plan.dropped.map((entry) => entry.stage).sort()).toEqual(["bloom", "ssgi", "ssr"]);
    for (const entry of plan.dropped) {
      // The charter's rule: turning a convention off must not turn its measurement off. A
      // reason that is absent or blank makes a dropped stage indistinguishable from one the
      // game chose not to request.
      expect(entry.reason).toBeTruthy();
      expect(entry.reason).toContain("webgl");
    }
  });

  it("reports godrays as dropped, by name, when its light cannot cast shadows", () => {
    // Godrays are raymarched against the light's shadow map. A light with castShadow false
    // produces a black pass, which reads as "godrays are on and do nothing".
    const plan = planWorldEnvironment(
      { godrays: { lightCastsShadow: false, lightName: "sun" } },
      webgpu,
    );
    expect(plan.applied).toEqual([]);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]?.stage).toBe("godrays");
    expect(plan.dropped[0]?.reason).toContain("sun");
    expect(plan.dropped[0]?.reason).toMatch(/shadow/i);
  });

  it("drops the denoiser when there is nothing to denoise", () => {
    const plan = planWorldEnvironment({ denoise: {}, bloom: {} }, webgpu);
    expect(plan.applied.map((entry) => entry.stage)).toEqual(["bloom"]);
    expect(plan.dropped[0]?.stage).toBe("denoise");
    expect(plan.dropped[0]?.reason).toMatch(/ssgi/i);
  });

  it("an empty request installs nothing and reports nothing applied", () => {
    const plan = planWorldEnvironment({}, webgpu);
    expect(plan.applied).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.tier).toBe("off");
  });

  it("throws on an unknown stage rather than skipping it", () => {
    expect(() => planWorldEnvironment({ ssgi: {}, sparkle: {} } as never, webgpu)).toThrow(
      /sparkle/,
    );
  });

  it("throws on an unknown quality tier rather than falling back to a default", () => {
    // A typo'd tier that silently became "medium" is a quality setting nobody can trust
    // afterwards, and no gate can catch.
    expect(() => planWorldEnvironment({ ssgi: { quality: "ultra" } } as never, webgpu)).toThrow(
      /ultra/,
    );
  });

  it("every tier names sample counts for every stage that takes them", () => {
    for (const tier of Object.keys(WORLD_ENVIRONMENT_TIERS)) {
      const preset = WORLD_ENVIRONMENT_TIERS[tier as keyof typeof WORLD_ENVIRONMENT_TIERS];
      expect(preset.ssgi.sliceCount).toBeGreaterThan(0);
      expect(preset.ssgi.stepCount).toBeGreaterThan(0);
      expect(preset.godrays.steps).toBeGreaterThan(0);
      expect(preset.ssr.resolutionScale).toBeGreaterThan(0);
      expect(preset.ssr.resolutionScale).toBeLessThanOrEqual(1);
    }
  });

  it("defaults SSR to a scene-scaled ray distance rather than upstream's one world unit", () => {
    // SSRNode.maxDistance defaults to 1. On any scene bigger than a tabletop every ray dies
    // before it reaches the thing that should be standing in the floor, and the stage reads
    // as on-and-doing-nothing.
    const plan = planWorldEnvironment({ ssr: { sceneRadius: 40 } }, webgpu);
    const ssr = plan.applied.find((entry) => entry.stage === "ssr");
    expect(ssr?.settings.maxDistance).toBe(40);
    expect(ssr?.settings.reflectNonMetals).toBe(true);
  });

  it("the canonical stage order is the exported constant, not a literal in the planner", () => {
    expect(WORLD_ENVIRONMENT_STAGES).toEqual([
      "gtao",
      "ssgi",
      "denoise",
      "godrays",
      "ssr",
      "bloom",
    ]);
  });
});
