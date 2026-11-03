// Types for `v8-recipe-hash.mjs`. It is plain JavaScript because the workflow runs it through Node
// directly; only what a caller reads is declared here.

/** Files whose every byte feeds the Android V8 payload build. */
export declare const V8_RECIPE_FILES: readonly string[];

/** The `'v8-android': { … }` member of the dependency provisioner, from its source text. */
export declare function v8AndroidDependencyEntry(source: string): string;

/** Hash that names the Android V8 payload: the release asset and every payload cache key. */
export declare function androidV8RecipeHash(root?: string): string;
