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
    symbol: "ctx.sceneLoad.progress",
    signature: "ctx.sceneLoad.progress: number",
    summary:
      "How far the scene change in flight has loaded, 0 to 1, for a loading bar between levels: 0 when goto() starts, the share of the asset requests that load makes, and 1 once the new scene's enter() has run. During boot it equals ctx.startup.progress.",
    situations: [
      "loading screen between levels",
      "progress bar during a level change",
      "show load progress on restart",
      "loading bar after goto",
    ],
    constraints: [
      "Never decreases within one load; the next goto() resets it to 0.",
      "Counts only the requests that load makes: a request already in flight when goto() started is not in it.",
      "ctx.startup.progress stays at 1 after the first launch, so a bar between levels reads this instead.",
    ],
    example:
      "const width = `${Math.round(ctx.sceneLoad.progress * 100)}%`; // the kits' render/loading.ts reads this",
  }),
  member({
    symbol: "game.pause",
    importPath: "src/game.ts",
    signature: "game.pause(options?: { readonly audio?: boolean }): void; game.resume(): void",
    summary:
      "Pauses the game loop and every playing audio bus with it; resume() lifts exactly that pause. pause({ audio: false }) keeps the sound playing and reports TN_PAUSE_AUDIO_KEPT once.",
    situations: [
      "pause menu",
      "pause the game and mute the sound",
      "stop the music when the game is paused",
      "keep menu music playing while paused",
    ],
    constraints: [
      "A bus the game had already paused itself stays paused after resume().",
      "A bus built after pause() is not paused by it.",
    ],
    example: 'onIntent: (intent) => (intent === "pause" ? game.pause() : game.resume())',
    overrides: ["pause({ audio: false }) keeps audio; TN_PAUSE_AUDIO_KEPT reports it once"],
  }),
  member({
    symbol: "ctx.timeScale",
    signature: "ctx.timeScale: number",
    summary:
      "Simulation speed, after Godot's Engine.time_scale: 0.5 runs half the fixed ticks per wall second with the same step, 0 freezes the simulation while rendering continues. Default 1.",
    situations: [
      "slow motion",
      "bullet time",
      "freeze frame on impact",
      "hitstop",
      "speed up or slow down the game",
      "fast forward the simulation",
    ],
    constraints: [
      "The fixed step and every dt a game receives stay the same; only the tick count changes, so determinism holds.",
      "UI, audio and other wall-clock work keep their own speed.",
      "A value that is not a finite number of at least 0 throws TN_TIME_SCALE_INVALID.",
    ],
    example: "ctx.timeScale = 0.2; // slow motion\nctx.after(0.1, () => (ctx.timeScale = 1));",
  }),
  member({
    symbol: "InputMap.setBinding",
    importPath: "src/input.ts",
    signature:
      "ctx.input.setBinding(action: string, binding: IInputAction): void; ctx.input.bindings(): InputBindings",
    summary:
      "Replaces one declared action's binding at runtime, after Godot's InputMap action_erase_events + action_add_event; bindings() returns a JSON-safe copy a game can save and feed back.",
    situations: [
      "rebind keys",
      "remap controls in an options menu",
      "let the player change key bindings",
      "save and restore custom controls",
    ],
    constraints: [
      "A malformed binding throws TN_BINDING_INVALID, the same check the constructor runs.",
      "An action not declared in defineGame({ input }) throws TN_BINDING_UNKNOWN.",
      "The game owns where bindings are saved, for example localStorage.",
    ],
    example:
      'ctx.input.setBinding("jump", { keys: ["KeyK"] });\nlocalStorage.setItem("keys", JSON.stringify(ctx.input.bindings()));',
  }),
  member({
    symbol: "Scene.applicationPaused",
    signature:
      "applicationPaused(ctx): void; applicationResumed(ctx): void // optional Scene methods",
    summary:
      "Scene hooks for the app leaving and returning to the foreground, after Godot's NOTIFICATION_APPLICATION_PAUSED/RESUMED. Core calls them from `visibilitychange` on the web and on the native host, and forwards them into a worker game.",
    situations: [
      "app goes to background",
      "save the game when the phone sends the app to the background",
      "pause or resume when the user switches apps",
      "detect the app being minimised or brought back",
      "mobile app lifecycle events",
    ],
    constraints: [
      "Fires once per real transition, for the scene active at that moment.",
      "The paused hook gets one JavaScript turn before the host parks the loop; a localStorage write there is flushed to disk before the app is backgrounded.",
      "The web, the legacy host (Android, desktop) and the owned desktop engine player all dispatch it; iOS is not proven yet.",
    ],
    example:
      'override applicationPaused(ctx) { localStorage.setItem("save", JSON.stringify(ctx.state.getState())); }',
  }),
  member({
    symbol: "ctx.quit",
    signature: "ctx.quit(): void",
    summary:
      "Quits the app with status 0, after Godot's get_tree().quit(). A web page cannot end its own process, so there the call prints TN_QUIT_UNSUPPORTED once and does nothing.",
    situations: [
      "quit button in a pause menu",
      "exit the game from its own UI",
      "close the app",
      "end the process from game code",
    ],
    constraints: [
      "Native host only: the web reports TN_QUIT_UNSUPPORTED once and returns.",
      "Hide or disable a Quit button on the web rather than offer one that does nothing.",
    ],
    example: "onQuit = () => ctx.quit();",
    overrides: ["TN_QUIT_UNSUPPORTED reports the web, where quit cannot work"],
  }),
  member({
    symbol: "ctx.input.vibrateHandheld",
    importPath: "src/input.ts",
    signature: "ctx.input.vibrateHandheld(durationMs: number): boolean",
    summary:
      "Vibrates the phone for durationMs through navigator.vibrate, which the native host shims with SDL haptics (the Android system vibrator). Returns whether the platform took the request.",
    situations: [
      "vibrate the phone",
      "haptic feedback on hit",
      "shake the device when the player takes damage",
      "mobile vibration",
    ],
    constraints: [
      "A runtime with no API or no motor prints TN_HAPTICS_UNSUPPORTED once and returns false.",
      "A negative or non-finite duration throws TN_HAPTICS_INVALID.",
      "iOS is not proven yet.",
    ],
    example: "if (ctx.input.vibrateHandheld(80)) hud.flashHit();",
  }),
  member({
    symbol: "ctx.input.startJoyVibration",
    importPath: "src/input.ts",
    signature:
      "ctx.input.startJoyVibration(weak: number, strong: number, durationMs: number, device = 0): boolean",
    summary:
      'Rumbles a gamepad through Gamepad.vibrationActuator.playEffect("dual-rumble"), after Godot\'s Input.start_joy_vibration. The native host shims it with SDL_RumbleGamepad. Magnitudes are 0 to 1.',
    situations: [
      "controller rumble",
      "gamepad vibration when the player crashes or fires",
      "force feedback on a joypad",
      "rumble the pad",
    ],
    constraints: [
      "A pad or host with no actuator prints TN_HAPTICS_UNSUPPORTED once and returns false.",
      "A worker game reads no live gamepads, so it reports unsupported.",
    ],
    example: "ctx.input.startJoyVibration(0.4, 0.8, 250);",
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
