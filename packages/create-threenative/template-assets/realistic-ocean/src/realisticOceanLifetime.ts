/** Small scene-owned disposal stack. It owns no renderer, scene, or appearance. */
export class DisposalScope {
  #disposed = false;
  #cleanups: (() => void)[] = [];

  get disposed(): boolean {
    return this.#disposed;
  }

  defer(cleanup: () => void): void {
    if (this.#disposed) cleanup();
    else this.#cleanups.push(cleanup);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const cleanup of this.#cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Realistic ocean resource cleanup failed.");
  }
}
