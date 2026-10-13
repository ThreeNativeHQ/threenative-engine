import { type QualityTier, resolveQualityTier } from "./quality.js";

const QUALITY_TIERS: readonly QualityTier[] = ["low", "medium", "high"];

/** Structural subset of the engine's completed frame window; rendering source stays portable. */
export interface IQualityWindow {
  readonly window: number;
  readonly frames: number;
  readonly fps: number;
  readonly presented: { readonly p95: number };
  readonly frame: { readonly p95: number };
  readonly gpuMs?: number;
  readonly gpuAgeFrames?: number;
  readonly surface?: { readonly compiling?: boolean };
}

export interface IQualityDecision {
  readonly tier: QualityTier;
  readonly source: "auto" | "pinned";
  readonly changed: boolean;
  readonly meter: "gpu" | "presented";
  readonly fallback?: "gpu-unavailable" | "gpu-invalid" | "gpu-age-unavailable" | "gpu-stale";
  readonly reason: string;
  readonly budgetMs: number;
  readonly overloadBudgetMs: number;
  readonly gpuMs?: number;
  readonly cpuMs?: number;
  readonly costMs?: number;
}

export interface IAdaptiveQualityOptions {
  readonly targetFps?: number;
  readonly overloadedWindows?: number;
  readonly healthyWindows?: number;
  readonly headroom?: number;
  readonly presentationTolerance?: number;
  readonly cooldownMs?: number;
  readonly startupWindows?: number;
  readonly minFrames?: number;
  readonly maxGpuAgeFrames?: number;
  readonly now?: () => number;
  /** The scene passes its actual loading state; elapsed time cannot establish readiness. */
  readonly ready?: () => boolean;
}

/** The game owns this policy. Platform selects the first look; measured load selects later ones. */
export function createAdaptiveQuality(
  request: {
    readonly gpuClass?: string;
    readonly mobile?: boolean;
    readonly tier?: string;
  } = {},
  options: IAdaptiveQualityOptions = {},
) {
  const policy = {
    targetFps: 60,
    overloadedWindows: 2,
    healthyWindows: 5,
    headroom: 0.2,
    presentationTolerance: 0.05,
    cooldownMs: 5000,
    startupWindows: 1,
    minFrames: 30,
    maxGpuAgeFrames: 4,
    ...options,
  };
  for (const key of ["targetFps", "overloadedWindows", "healthyWindows", "minFrames"] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0)
      throw new Error(`quality ${key} must be positive.`);
  }
  for (const key of ["cooldownMs", "startupWindows", "maxGpuAgeFrames"] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0)
      throw new Error(`quality ${key} must be non-negative.`);
  }
  for (const key of [
    "overloadedWindows",
    "healthyWindows",
    "startupWindows",
    "minFrames",
    "maxGpuAgeFrames",
  ] as const) {
    if (!Number.isInteger(policy[key])) throw new Error(`quality ${key} must be an integer.`);
  }
  if (!Number.isFinite(policy.headroom) || policy.headroom <= 0 || policy.headroom >= 1)
    throw new Error("quality headroom must be between zero and one.");
  if (
    !Number.isFinite(policy.presentationTolerance) ||
    policy.presentationTolerance < 0 ||
    policy.presentationTolerance >= 1
  )
    throw new Error("quality presentationTolerance must be between zero and one.");
  const now = options.now ?? (() => performance.now());
  const ready = options.ready ?? (() => true);
  let tier = resolveQualityTier(request);
  const pinned = request.tier !== undefined;
  const budgetMs = 1000 / policy.targetFps;
  let startup = policy.startupWindows;
  let lastWindow = 0;
  let lastChange = Number.NEGATIVE_INFINITY;
  let overloaded = 0;
  let healthy = 0;
  const finite = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value);
  return {
    get tier() {
      return tier;
    },
    pinned,
    observe(window: IQualityWindow): IQualityDecision {
      const gpu = window.gpuMs;
      const age = window.gpuAgeFrames;
      const fallback: IQualityDecision["fallback"] =
        gpu === undefined
          ? "gpu-unavailable"
          : !Number.isFinite(gpu) || gpu <= 0
            ? "gpu-invalid"
            : age === undefined || !Number.isInteger(age) || age < 0
              ? "gpu-age-unavailable"
              : age > policy.maxGpuAgeFrames
                ? "gpu-stale"
                : undefined;
      const costMs = fallback === undefined ? (gpu as number) : window.presented.p95;
      // Presented intervals include vsync jitter, so fallback overload gets a small tolerance.
      const overloadBudgetMs =
        fallback === undefined ? budgetMs : budgetMs * (1 + policy.presentationTolerance);
      const reportFields: Pick<IQualityDecision, "fallback" | "gpuMs" | "cpuMs" | "costMs"> = {
        ...(fallback === undefined ? {} : { fallback }),
        ...(finite(gpu) ? { gpuMs: gpu } : {}),
        ...(finite(window.frame.p95) ? { cpuMs: window.frame.p95 } : {}),
        ...(finite(costMs) ? { costMs } : {}),
      };
      const report = (reason: string, changed = false): IQualityDecision => ({
        tier,
        source: pinned ? "pinned" : "auto",
        changed,
        reason,
        budgetMs,
        overloadBudgetMs,
        meter: fallback === undefined ? "gpu" : "presented",
        ...reportFields,
      });
      let skip: string | undefined;
      if (
        !Number.isInteger(window.window) ||
        window.window <= lastWindow ||
        !Number.isInteger(window.frames) ||
        window.frames < policy.minFrames ||
        !Number.isFinite(window.fps) ||
        window.fps <= 0 ||
        !Number.isFinite(costMs) ||
        costMs <= 0
      )
        skip = "invalid";
      if (Number.isInteger(window.window) && window.window > lastWindow) lastWindow = window.window;
      if (!ready()) {
        startup = policy.startupWindows;
        skip = "startup";
      } else if (window.surface?.compiling) skip = "compiling";
      else if (skip === undefined && startup > 0) {
        startup -= 1;
        skip = "startup";
      }
      if (skip !== undefined) {
        overloaded = 0;
        healthy = 0;
        return report(skip);
      }
      if (pinned) return report("pinned");
      overloaded = costMs > overloadBudgetMs ? overloaded + 1 : 0;
      healthy = costMs <= budgetMs * (1 - policy.headroom) ? healthy + 1 : 0;
      const direction =
        overloaded >= policy.overloadedWindows ? -1 : healthy >= policy.healthyWindows ? 1 : 0;
      if (direction === 0) return report("steady");
      const next = QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) + direction];
      if (next === undefined) return report(direction < 0 ? "at-floor" : "at-ceiling");
      const time = now();
      if (!Number.isFinite(time)) throw new Error("quality clock must return finite milliseconds.");
      if (time - lastChange < policy.cooldownMs) {
        overloaded = 0;
        healthy = 0;
        return report("cooldown");
      }
      tier = next;
      lastChange = time;
      overloaded = 0;
      healthy = 0;
      return report(direction < 0 ? "overloaded" : "headroom", true);
    },
  };
}

export function formatQualityAdaptation(decision: IQualityDecision): string {
  return (
    `TN_QUALITY_TIER ${decision.tier} source=${decision.source} meter=${decision.meter}` +
    ` reason=${decision.reason} fallback=${decision.fallback ?? "none"}` +
    ` budgetMs=${decision.budgetMs} overloadBudgetMs=${decision.overloadBudgetMs}` +
    ` costMs=${decision.costMs ?? "unavailable"}`
  );
}
