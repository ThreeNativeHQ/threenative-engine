/** Release every acquired resource, preserving errors after the remaining releases. */
export function releaseAll(callbacks: Iterable<() => void>): void {
  const errors: unknown[] = [];
  for (const release of callbacks) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "TN_ANIMAL_CLEANUP_FAILED");
}
