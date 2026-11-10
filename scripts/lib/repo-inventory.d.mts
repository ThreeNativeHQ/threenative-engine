// Types for `repo-inventory.mjs`, which is plain ESM so CI's Node 20 can run it. Keep this file
// and the module in step: it declares exactly what the module exports and nothing more.
export declare const REPO_ROOT: string;
export declare function workspacePackageNames(root?: string): readonly string[];
/** The same list from the Git tree: a sparse checkout carries no package manifest. */
export declare function workspacePackageNamesFromTree(root?: string): readonly string[];
export declare function templateNames(root?: string): readonly string[];
export declare function briefGenres(root?: string): readonly string[];
export declare function nodeEngineRange(root?: string): string;
export declare function minimumNodeVersion(root?: string): string;
