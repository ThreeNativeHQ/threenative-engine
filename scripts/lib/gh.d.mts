// Types for `gh.mjs`, which is plain ESM so the CI scripts CI runs under Node 20 can import it.
// Keep this file and the module in step: it declares exactly what the module exports.
export declare function gh(
  args: readonly string[],
  options?: { readonly retries?: number },
): string;
