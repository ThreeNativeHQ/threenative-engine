/**
 * The automation vocabulary, with no browser in it.
 *
 * The source study called its render tiers `low`, `balanced`, `high` and `cinematic`; this
 * framework calls them `performance`, `balanced`, `high` and `ultra`. Both names are accepted —
 * a captured URL or a script written against the source keeps working — and one table is the
 * whole mapping. A name in neither list throws: a typo must not silently pick a tier and report
 * success.
 *
 * Query reading goes through the engine's debug seam when no search string is given, so the same
 * rule reads the URL on the web and `TN_DEBUG_*` on a native launch; a test can still hold one.
 */

import { debugFlag, debugValue } from "@threenative/core";
import type { QualityName } from "../state.js";

/** The four engine tiers, plus the four names the source study published for them. */
export const QUALITY_ALIASES = {
  balanced: "balanced",
  cinematic: "ultra",
  high: "high",
  low: "performance",
  performance: "performance",
  ultra: "ultra",
} as const satisfies Record<string, QualityName>;

export type QualityRequest = keyof typeof QUALITY_ALIASES;

/** The engine tier one requested name means. Throws on a name in neither vocabulary. */
export function qualityTier(name: unknown): QualityName {
  if (typeof name !== "string" || !Object.hasOwn(QUALITY_ALIASES, name)) {
    throw new Error(
      `TN_RAIN_QUALITY_UNKNOWN ${String(name)}: expected low, balanced, high or cinematic`,
    );
  }
  return QUALITY_ALIASES[name as QualityRequest];
}

export interface IAutomationRequest {
  /** `?still` — freeze the simulation instead of running it. Honoured after the first real frame. */
  readonly still: boolean;
  /** The tier `?quality=` asked for, in engine names. */
  readonly quality?: QualityName;
  /** A `?quality=` this build cannot honour, reported rather than quietly defaulted. */
  readonly rejectedQuality?: string;
}

/**
 * What the query asks for. An unreadable tier is named in `rejectedQuality` instead of thrown: a
 * URL is a place somebody typed, and the page still has to open.
 */
export function automationRequest(search?: string): IAutomationRequest {
  const query = search === undefined ? undefined : new URLSearchParams(search);
  const asked = query === undefined ? debugValue("quality") : query.get("quality");
  const still = query === undefined ? debugFlag("still") : query.has("still");
  if (asked === null || asked === undefined) return { still };
  try {
    return { still, quality: qualityTier(asked) };
  } catch {
    return { still, rejectedQuality: asked };
  }
}
