import type { ICapabilityManifestEntry } from "./build-capability-manifest.js";

/**
 * The `ctx` members that exist only as interface properties, so nothing exports them and the
 * manifest cannot find them by walking exports.
 *
 * This is the same gap the render-chain stages had: `ctx.assets.memo` shipped and worked, and
 * `engine_search_capabilities("cache generated geometry between page loads")` returned nothing,
 * so a game rebuilt a nine-second stage on every load. The manifest is the thing an agent searches
 * first; a member absent from it does not exist. Each row therefore carries the words an author
 * types before they know the name, plus the constraint that actually bites.
 *
 * The JSDoc on the interface member stays the source of the behaviour; this file is the index.
 */
function member(entry: {
  readonly symbol: string;
  readonly signature: string;
  readonly summary: string;
  readonly situations: readonly string[];
  readonly constraints: readonly string[];
  readonly example: string;
  readonly overrides?: readonly string[];
  readonly importPath?: string;
}): ICapabilityManifestEntry {
  return {
    symbol: entry.symbol,
    package: "@threenative/core",
    importPath: entry.importPath ?? "src/scene.ts",
    kind: "function",
    signature: entry.signature,
    summary: entry.summary,
    situations: entry.situations,
    aliases: [],
    example: entry.example,
    constraints: entry.constraints,
    overrides: entry.overrides ?? [],
    supersedes: [],
  };
}

export const CTX_MANIFEST_ENTRIES: readonly ICapabilityManifestEntry[] = [
  member({
    symbol: "ctx.assets.memo",
    importPath: "src/assets.ts",
    signature: "ctx.assets.memo<T>(key: string, build: () => T | Promise<T>): Promise<T>",
    summary:
      "Returns what `build` returned the last time this build of the game ran, read back from disk, and calls `build` only when nothing is stored. Use it for seeded work that is the same every run: placement lists, painted sky pixels, terrain heights, a generated stage.",
    situations: [
      "cache generated geometry between page loads",
      "stop rebuilding the same generated stage on every page load",
      "cache painted sky pixels or baked terrain heights between runs",
      "keep seeded placement work the same every run without recomputing it",
      "make a slow boot fast without shipping a baked asset",
    ],
    constraints: [
      "The value is named typed arrays; a map of names to typed arrays is what is stored.",
      "On the dev server and on a native host `build` runs every time, and `TN_ASSET_MEMO` reports why: the cache is a build artifact, not a substitute for authoring.",
      "A new build of the game regenerates: the key alone does not pin a value across a rebuild.",
      "A game that drives a loader outside `defineGame` may call it whenever it likes; the reveal is not waited on.",
    ],
    example: 'const { pixels } = await ctx.assets.memo("sky", () => ({ pixels: paintSky() }));',
    overrides: ["TN_ASSET_MEMO reports why a run rebuilt instead of reading the store"],
  }),
  member({
    symbol: "ctx.startup.progress",
    signature: "ctx.startup.progress: number",
    summary:
      "How much of the start scene has loaded and presented, 0 to 1, for a loading cover's bar. It never falls: a loader whose pending work grows keeps the number it reached rather than jumping backwards.",
    situations: [
      "boot progress bar",
      "show how much of the start scene has loaded",
      "loading screen percentage",
      "a progress bar that never goes backwards",
      "report startup progress while assets stream in",
    ],
    constraints: [
      "Never decreases, even when the loader is asked for more work mid-boot.",
      "Reaches 1 only after the first world render has been presented, not when the last byte arrived.",
      "A loading view the engine drew for you already reads it; this is for a cover the game draws itself.",
    ],
    example:
      "const width = `${Math.round(ctx.startup.progress * 100)}%`; // a cover the game draws on ctx.canvasLayer",
  }),
  member({
    symbol: "ctx.after",
    signature: "ctx.after(delay: number, callback: () => void): ScheduleHandle",
    summary:
      "Runs `callback` once, `delay` seconds of game time later, and returns a handle that cancels it. Game time stops while the game is paused, so a delayed beat does not fire behind a paused frame.",
    situations: [
      "run a callback after a delay",
      "schedule a one-shot timer that pauses with the game",
      "do something a moment later without setTimeout",
      "cancel a pending delayed action when a scene exits",
    ],
    constraints: [
      "The delay is game seconds: a paused game does not age it, and a slow frame does not skip it.",
      "`setTimeout` keeps running while the game is paused and after the scene is gone; this does not.",
      "Call the returned handle to cancel: a pending callback holds its scene's closure alive.",
    ],
    example: "const spawn = ctx.after(0.4, () => ctx.add(makeWave()));\nspawn(); // cancels",
  }),
  member({
    symbol: "ctx.beforeRender",
    signature: "ctx.beforeRender(callback: () => void): () => void",
    summary:
      "Registers work that runs once per actual world render, after the frame's last fixed update and before the projection reconciles and the renderer draws. The last place to change a transform, a uniform or a camera before the frame is presented.",
    situations: [
      "run a callback just before the frame renders",
      "update a camera or a uniform after physics and before the draw",
      "change a transform in the same frame it is seen",
      "run per-render work that must not run on a loader-only frame",
    ],
    constraints: [
      "A held, loader-only frame has no world draw and dispatches nothing.",
      "Runs after every fixed update in the frame, so a value it writes is the one drawn.",
      "Returns an unregister function; call it when the object that needed it is gone.",
    ],
    example:
      "const stop = ctx.beforeRender(() => (material.uniforms.time.value = clock.elapsed));\n// later: stop();",
  }),
];
