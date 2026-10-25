/** three's NodeLibrary tone functions; the engine compiles the game's curve at its output stage. */
export function defineToneMappingLibrary(
  inputs: () => [unknown, unknown],
  install: (node: unknown) => void,
) {
  const functions = new Map<number, (color: never, exposure: never) => unknown>();
  let installed: unknown;
  return {
    addToneMapping(fn: (color: never, exposure: never) => unknown, mode: number): void {
      if (typeof fn !== "function" || !Number.isInteger(mode))
        throw new TypeError(
          "TN_NATIVE_TONEMAPPING_REGISTRATION: expected a function and integer mode",
        );
      if (!functions.has(mode)) functions.set(mode, fn);
    },
    getToneMappingFunction: (mode: number) => functions.get(mode) ?? null,
    apply(mode: number): unknown {
      if (mode !== 5) return null;
      const fn = functions.get(mode);
      if (!fn)
        throw new Error(
          "TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: register a TSL tone-mapping function before using mode 5",
        );
      if (installed === undefined) {
        const [color, exposure] = inputs();
        const node = fn(color as never, exposure as never);
        install(node);
        installed = node;
      }
      return installed;
    },
  };
}
