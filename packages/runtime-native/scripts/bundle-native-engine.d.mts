/** Bundles a portable game entry against the native engine's imports (PRD-531). */
export function bundleNativeEngine(options: {
  entry: string;
  outfile: string;
  boot?: boolean;
  /** esbuild `define` substitutions (identifier to JSON text), for a script entry that is configured at build time. */
  define?: Record<string, string>;
  /** Install the player's core host (rAF, timers, `performance`, the canvas global) before a script entry; booted games always get it. */
  host?: boolean;
}): Promise<{ outfile: string; bytes: number; profile: { engine: "native"; gameRuntime: "v8" } }>;

/** Cooks a project's assets decoder-free into `<bundle dir>/native/assets.tnpk`; returns that path. */
export function cookNativeEngineAssets(options: {
  project: string;
  outfile: string;
  /** Asset source dir; defaults to the project's `assets` config `source`. */
  source?: string;
}): Promise<string>;
