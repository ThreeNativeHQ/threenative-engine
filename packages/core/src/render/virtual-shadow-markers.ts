import type { IVirtualShadowStats } from "./virtual-shadow-options.js";

/**
 * The `TN_VIRTUAL_SHADOW`, `TN_SHADOW_REFRESH`, `TN_SHADOW_GATE` and `TN_LAMP_SHADOW` lines, how
 * often each prints, and the parsers that read them back.
 *
 * A marker is the only way a browser run can see inside the node: which level is being throttled,
 * which one is shedding its tiniest casters, and what a frame's shadow work cost. The parsers are
 * here so a harness reads exactly the shape the node prints.
 */

export const VIRTUAL_SHADOW_MARKER = "TN_VIRTUAL_SHADOW";
/**
 * One line per level whose refresh trail adaptive refresh widened, at most once a second: the level,
 * the width of the window it re-renders, the smoothed cost of that render in ms, and the trail it
 * bought. A browser run can see which level is being throttled and by how much, which is the only
 * way to tell an expensive level from a slow frame.
 */
export const VIRTUAL_SHADOW_REFRESH_MARKER = "TN_SHADOW_REFRESH";
/** Seconds between two `TN_SHADOW_REFRESH` lines for the same level. */
export const REFRESH_MARKER_SECONDS = 1;
/**
 * One line per level whose adaptive caster gate changed, at most once a second: the level, the width
 * of the window it re-renders, the smoothed cost of that render, the scale its gate bought, and how
 * many casters that gate hid on the render the change was read from. A browser run can see which
 * level is shedding its tiniest props and by how much.
 */
export const VIRTUAL_SHADOW_GATE_MARKER = "TN_SHADOW_GATE";
/** Seconds between two `TN_SHADOW_GATE` lines for the same level. */
export const GATE_MARKER_SECONDS = 1;
/** Frames between markers while `?tnShadowStats=1` is on the URL: about a second a walk is long. */
export const STATS_QUERY_EVERY = 60;

const VIRTUAL_SHADOW_STAT_FIELDS = [
  "autoMovers",
  "autoScanMs",
  "autoTransitions",
  "byAdmission",
  "byEviction",
  "byInvalidation",
  "byMove",
  "cached",
  "coalesced",
  "deferred",
  "frame",
  "held",
  "invalidated",
  "levels",
  "moved",
  "moverRenders",
  "movers",
  "pagesDirty",
  "pagesRedrawn",
  "rendered",
  "rendersTotal",
  "reuseRatio",
] as const;

function isVirtualShadowStats(value: unknown): value is IVirtualShadowStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  if (
    VIRTUAL_SHADOW_STAT_FIELDS.some(
      (field) => typeof stats[field] !== "number" || !Number.isFinite(stats[field]),
    )
  ) {
    return false;
  }
  // Two fields are measurements, not counts: a ratio and a mean in milliseconds.
  const countFields = VIRTUAL_SHADOW_STAT_FIELDS.filter(
    (field) => field !== "reuseRatio" && field !== "autoScanMs",
  );
  if (
    countFields.some((field) => !Number.isInteger(stats[field]) || (stats[field] as number) < 0)
  ) {
    return false;
  }
  const reuseRatio = stats.reuseRatio as number;
  return reuseRatio >= 0 && reuseRatio <= 1 && (stats.autoScanMs as number) >= 0;
}

/**
 * Parse a `TN_VIRTUAL_SHADOW` console line back into its complete stats, or `undefined`.
 *
 * @situation inspect virtual shadow cache and mover counters from a renderer log
 * @constraint non-marker lines and markers with incomplete or non-numeric stats return `undefined`
 * @example
 * const stats = readVirtualShadowMarker(line);
 * if (stats !== undefined) console.log(stats.reuseRatio);
 */
export function readVirtualShadowMarker(line: string): IVirtualShadowStats | undefined {
  if (!line.startsWith(`${VIRTUAL_SHADOW_MARKER}:`)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(VIRTUAL_SHADOW_MARKER.length + 1));
    return isVirtualShadowStats(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One frame's shadow passes on the owned engine with the spot and point light maps apart from the
 * sun's (PRD-650). The sun's draws and the lamps' add up to every shadow draw the renderer submitted.
 */
export interface ILampShadowStats {
  readonly frame: number;
  readonly shadowDraws: number;
  /** The sun's maps: its virtual levels or its plain map. `gpuMs` is -1 until a GPU sample resolves. */
  readonly sun: { readonly draws: number; readonly gpuMs: number };
  /** The lamp maps the frame redrew (a cube's six faces are one), their draws, and their GPU time. */
  readonly lamps: { readonly redraws: number; readonly draws: number; readonly gpuMs: number };
}

export const LAMP_SHADOW_MARKER = "TN_LAMP_SHADOW";

interface ILampShadowCounters {
  readonly lampRedraws: number;
  readonly lampDraws: number;
  readonly shadowDraws: number;
  readonly sunGpuMs: number;
  readonly lampGpuMs: number;
}

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const isGpuMs = (n: unknown): n is number => n === -1 || (Number.isFinite(n) && (n as number) >= 0);

function isLampShadowStats(value: unknown): value is ILampShadowStats {
  const stats = value as Partial<Record<keyof ILampShadowStats, Record<string, unknown>>> | null;
  if (typeof stats !== "object" || stats === null) return false;
  const { frame, shadowDraws } = stats as Record<string, unknown>;
  const sun = stats.sun;
  const lamps = stats.lamps;
  return (
    isCount(frame) &&
    isCount(shadowDraws) &&
    typeof sun === "object" &&
    sun !== null &&
    typeof lamps === "object" &&
    lamps !== null &&
    isCount(sun.draws) &&
    isGpuMs(sun.gpuMs) &&
    isCount(lamps.redraws) &&
    isCount(lamps.draws) &&
    isGpuMs(lamps.gpuMs) &&
    sun.draws + lamps.draws === shadowDraws
  );
}

/**
 * The `TN_LAMP_SHADOW` line for the renderer's last frame, or `undefined` on a renderer that keeps
 * no lamp counters (three's own).
 *
 * @situation log lamp shadow redraws and GPU time apart from the sun's on the owned engine
 * @constraint counters that do not add up to the frame's shadow draws throw TN_LAMP_SHADOW_INVALID
 * @example
 * const line = lampShadowMarker(renderer, frame);
 * if (line !== undefined) console.info(line);
 */
export function lampShadowMarker(
  renderer: { readonly info?: { readonly engine?: { readonly shadows?: ILampShadowCounters } } },
  frame: number,
): string | undefined {
  const counters = renderer.info?.engine?.shadows;
  if (counters === undefined) return undefined;
  const stats: ILampShadowStats = {
    frame,
    shadowDraws: counters.shadowDraws,
    sun: { draws: counters.shadowDraws - counters.lampDraws, gpuMs: counters.sunGpuMs },
    lamps: { redraws: counters.lampRedraws, draws: counters.lampDraws, gpuMs: counters.lampGpuMs },
  };
  if (!isLampShadowStats(stats))
    throw new Error(`TN_LAMP_SHADOW_INVALID: ${JSON.stringify(counters)} at frame ${frame}`);
  return `${LAMP_SHADOW_MARKER}:${JSON.stringify(stats)}`;
}

/**
 * Parse a `TN_LAMP_SHADOW` line back into its stats, or `undefined`.
 *
 * @situation count lamp shadow redraws from a renderer log, for example a moving-caster run
 * @constraint non-marker lines and markers whose sun and lamp draws do not add up return `undefined`
 * @example
 * const stats = readLampShadowMarker(line);
 * if (stats !== undefined) console.log(stats.lamps.redraws);
 */
export function readLampShadowMarker(line: string): ILampShadowStats | undefined {
  if (!line.startsWith(`${LAMP_SHADOW_MARKER}:`)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(LAMP_SHADOW_MARKER.length + 1));
    return isLampShadowStats(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
