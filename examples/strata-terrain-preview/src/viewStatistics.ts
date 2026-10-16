const medians = new WeakMap<readonly number[], { length: number; value: number }>();

/** The upper middle of append-only frame-window samples, without changing their order. */
export function medianOfGrowingSamples(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const cached = medians.get(values);
  if (cached?.length === values.length) return cached.value;
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)] ?? 0;
  medians.set(values, { length: values.length, value });
  return value;
}

export interface IViewVisit {
  windows: number;
  discard: boolean;
  ready: boolean;
}

export function beginViewVisit(): IViewVisit {
  return { windows: 0, discard: true, ready: false };
}

/** Accept one retained window for the current camera visit. */
export function retainViewWindow(
  visit: IViewVisit,
  window: Pick<import("@threenative/core").IFrameBudgetWindow, "gpuMs" | "gpuFrames" | "surface">,
  firstGpuFrame: number,
): boolean {
  if (!visit.ready || window.surface?.compiling === true) {
    visit.discard = true;
    return false;
  }
  if (
    !Number.isFinite(firstGpuFrame) ||
    window.gpuMs === undefined ||
    window.gpuFrames === undefined ||
    window.gpuFrames.first < firstGpuFrame
  )
    return false;
  if (visit.discard) {
    visit.discard = false;
    return false;
  }
  visit.windows++;
  return true;
}
