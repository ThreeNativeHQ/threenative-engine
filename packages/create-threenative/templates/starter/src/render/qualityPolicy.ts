/** The adaptive-quality numeric policy: the defaults, the author's overrides, and their limits. */
export interface IQualityPolicy {
  readonly targetFps: number;
  readonly overloadedWindows: number;
  readonly healthyWindows: number;
  readonly headroom: number;
  readonly presentationTolerance: number;
  readonly cooldownMs: number;
  readonly startupWindows: number;
  readonly minFrames: number;
  readonly maxGpuAgeFrames: number;
}

/** Merges the overrides onto the defaults, then rejects any value the policy cannot use. */
export function resolveQualityPolicy(options: Partial<IQualityPolicy>): IQualityPolicy {
  const policy: IQualityPolicy = {
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
  return policy;
}
