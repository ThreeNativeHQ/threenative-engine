import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TEMPLATE_ROOT } from "../../../test-support/templates.js";

/**
 * PRD-747: the starter kits share one meter, `template-assets/kitExposure.ts`, at 0 EV (key 0.18)
 * instead of core's Unreal +1 EV. Kits with their own owner-approved exposure keep it.
 */
const SHARED = [
  "adventure",
  "collectathon",
  "kart",
  "platformer",
  "racing",
  "runner",
  "sailing",
  "starter",
];
const OWN_KEY: Readonly<Record<string, number>> = {
  minimal: 0.36,
  rain: 0.36,
  shooter: 0.14,
  snow: 0.36,
};
const TIERS = ["low", "medium", "high"] as const;
const CANONICAL = path.resolve("packages/create-threenative/template-assets/kitExposure.ts");

async function policy(kit: string, tier: string): Promise<Record<string, unknown>> {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const quality = (await import(
    pathToFileURL(path.join(TEMPLATE_ROOT, kit, "src", "render", "quality.ts")).href
  )) as { qualityPreset: (tier: string) => { exposurePolicy?: Record<string, unknown> } };
  const value = quality.qualityPreset(tier).exposurePolicy;
  if (value === undefined) throw new Error(`${kit}/${tier} has no exposurePolicy`);
  return value;
}

describe("PRD-747 shared kit exposure", () => {
  it.each(SHARED)("%s ships the canonical kitExposure.ts byte for byte", (kit) => {
    const copy = path.join(TEMPLATE_ROOT, kit, "src", "render", "kitExposure.ts");
    expect(existsSync(copy), `${kit} kitExposure.ts`).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(CANONICAL, "utf8"));
  });

  it.each(SHARED)("%s meters at 0 EV on every tier", async (kit) => {
    const core = await import("@threenative/core");
    for (const tier of TIERS)
      expect(await policy(kit, tier), `${kit}/${tier}`).toEqual({
        ...core.exposureSettings,
        key: 0.18,
        minStops: Math.log2(0.18) - 20,
        maxStops: Math.log2(0.18) + 10,
      });
  });

  it.each(Object.entries(OWN_KEY))("%s keeps its own key %s", async (kit, key) => {
    expect(existsSync(path.join(TEMPLATE_ROOT, kit, "src", "render", "kitExposure.ts"))).toBe(
      false,
    );
    for (const tier of TIERS) expect((await policy(kit, tier)).key, `${kit}/${tier}`).toBe(key);
  });
});
