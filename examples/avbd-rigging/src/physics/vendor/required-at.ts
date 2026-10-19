/** Bounded donor port: fail before a missing array observation can become NaN. */
export function requiredAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new Error(`AVBD required index ${index} is missing from ${values.length} entries.`);
  return value;
}
export function requiredValue<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null)
    throw new Error(`AVBD required observation ${name} is missing.`);
  return value;
}
export function incrementAt(
  values: ArrayLike<number> & {
    [index: number]: number;
  },
  index: number,
  delta: number,
  post: boolean,
): number {
  const previous = requiredAt(values, index);
  values[index] = previous + delta;
  return post ? previous : previous + delta;
}
