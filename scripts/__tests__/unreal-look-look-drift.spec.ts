import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { qualityPreset as coreQuality } from "@threenative/core";
import { describe, expect, it, vi } from "vitest";
import { TEMPLATE_ROOT } from "../../test-support/templates.js";
import { exposureSettings as HARNESS_EXPOSURE } from "../unreal-look/scaffold/render/exposure.js";

/**
 * Every template ships the stock Unreal 5.8.3 look the harness is calibrated to, or names why not.
 * PRD-747 moved eight kits to a 0 EV meter and the starter, the Unreal calibration template, went
 * with them: its frames read 1 EV under Unreal and nothing reported it. A look constant that differs
 * from the harness now fails here unless `OVERRIDES` lists it with its reason, so the drift is a
 * visible, reviewed line instead of a silent one.
 */
type LookKey = "key" | "tonemapMode" | "autoExposureEnabled";
const PRD_747 =
  "PRD-747: bright stylised kits read pastel at +1 EV; a judge read 0 EV better on 9 of 9";
const OVERRIDES: Readonly<Record<string, Partial<Record<LookKey, string>>>> = {
  "action-rpg": {
    tonemapMode: "ACES at a fixed exposure: the filmic curve and the meter read yellowish here",
    autoExposureEnabled: "ACES at a fixed exposure (quality.ts neutralLook)",
  },
  adventure: { key: PRD_747 },
  collectathon: { key: PRD_747 },
  kart: { key: PRD_747 },
  platformer: { key: PRD_747 },
  racing: { key: PRD_747 },
  runner: { key: PRD_747 },
  rts: {
    key: "PRD-765: the AstraCraft reference look (owner, 2026-10-28)",
    tonemapMode: "PRD-765: ACES at a fixed 1.02 exposure; metering brightened the aprons to white",
    autoExposureEnabled: "PRD-765: fixed exposure",
  },
  sailing: { key: PRD_747 },
  shooter: {
    key: "PRD-746: core's 0.36 drains the pale town's reds and blues (judge, 2026-10-26)",
    tonemapMode: "ACES at a fixed exposure: the filmic curve read yellowish on this town",
    autoExposureEnabled: "ACES at a fixed exposure (quality.ts neutralLook)",
  },
};

/** A tier's look with WorldEnvironment's defaults filled in: the filmic curve and metered exposure. */
function normalise(high: Record<string, unknown> & { exposurePolicy?: { key?: number } }) {
  return {
    key: high.exposurePolicy?.key,
    tonemapMode: high.tonemapMode ?? "filmic",
    autoExposureEnabled: high.autoExposureEnabled ?? true,
  } as Record<LookKey, unknown>;
}

async function look(kit: string): Promise<Record<LookKey, unknown>> {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const quality = (await import(
    pathToFileURL(path.join(TEMPLATE_ROOT, kit, "src/render/quality.ts")).href
  )) as { qualityPreset: (tier: string) => Record<string, unknown> };
  return normalise(quality.qualityPreset("high"));
}

/** The harness's look: its own Unreal meter over core's high tier (harness quality.ts leaves both curve and metering to core). */
const HARNESS = normalise({
  ...(coreQuality("high") as unknown as Record<string, unknown>),
  exposurePolicy: HARNESS_EXPOSURE,
});

const TEMPLATES = readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();

describe("template look against the Unreal harness", () => {
  it("reads stock Unreal in the harness: key 0.36, the filmic curve, metered exposure", () => {
    expect(HARNESS).toEqual({ key: 0.36, tonemapMode: "filmic", autoExposureEnabled: true });
  });

  it.each(TEMPLATES)("%s matches the harness look or names its override", async (kit) => {
    const kitLook = await look(kit);
    const named = OVERRIDES[kit] ?? {};
    const drift = (Object.keys(HARNESS) as LookKey[]).filter(
      (key) => kitLook[key] !== HARNESS[key] && named[key] === undefined,
    );
    const stale = (Object.keys(named) as LookKey[]).filter((key) => kitLook[key] === HARNESS[key]);
    expect(drift, `${kit} drifts from the harness look without a named override`).toEqual([]);
    expect(stale, `${kit} lists an override it no longer has`).toEqual([]);
  });
});
