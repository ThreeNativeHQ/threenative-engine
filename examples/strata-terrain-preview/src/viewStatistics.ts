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
