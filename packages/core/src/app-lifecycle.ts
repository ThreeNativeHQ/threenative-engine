/**
 * App lifecycle: the two transitions a phone sends that a game must hear — Godot's
 * `NOTIFICATION_APPLICATION_PAUSED` / `NOTIFICATION_APPLICATION_RESUMED` — and quit.
 *
 * The web API is the contract. Core listens to `visibilitychange` on the page's `document`, and the
 * owned native host sets `document.visibilityState` and dispatches the same event where it pauses
 * the loop, so one code path serves both runtimes. A worker game has no `document`: the page
 * forwards the transition and the worker host exposes it as `__tnAppVisibility` (`worker.ts`).
 */
import { hostDocument } from "./platform.js";
import { reportMarkerOnce } from "./report-once.js";

/** What core reads to follow app visibility: the page's `document`, or a worker's copy of it. */
export interface IVisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface IApplicationLifecycleHooks {
  /** The app left the foreground: save, release the audio device, stop trusting the clock. */
  paused(): void;
  /** The app came back: the world is live again. */
  resumed(): void;
}

/** `document` on a page, or the worker host's forwarded copy of it. */
function visibilitySource(): IVisibilitySource | undefined {
  // A host document shim without events (an older host, a test stub) has no visibility to report.
  const page = hostDocument();
  const source = page ?? (globalThis as { __tnAppVisibility?: IVisibilitySource }).__tnAppVisibility;
  return typeof source?.addEventListener === "function" ? source : undefined;
}

/**
 * Calls `applicationPaused`/`applicationResumed` once per real transition, and returns the release.
 *
 * The state is read from the source, never accumulated from the events: a browser that fires
 * `visibilitychange` twice for one hide must not save twice.
 *
 * @situation save the game when the app goes to the background
 * @situation release the audio device when the phone pauses the app
 * @example const dispose = installApplicationLifecycle({ paused: () => save(ctx), resumed: () => undefined });
 */
export function installApplicationLifecycle(hooks: IApplicationLifecycleHooks): () => void {
  const source = visibilitySource();
  if (source === undefined) return () => undefined;
  let hidden = source.visibilityState === "hidden";
  const onChange = (): void => {
    const next = source.visibilityState === "hidden";
    if (next === hidden) return;
    hidden = next;
    if (next) hooks.paused();
    else hooks.resumed();
  };
  source.addEventListener("visibilitychange", onChange);
  return () => source.removeEventListener("visibilitychange", onChange);
}

/** The host's ability to end the process: bound before any game module evaluates, on native only. */
function nativeExit(): (() => void) | undefined {
  const host = globalThis as {
    // quality-allow: the marker is the host's own global contract, so it keeps the host's spelling
    // biome-ignore lint/style/useNamingConvention: this is the native host's public global contract.
    __THREENATIVE_NATIVE__?: unknown;
    process?: { exit?: (code: number) => void };
  };
  // Read live rather than through `isNative()`, which caches its first answer, so a test that
  // installs the host's global after core loaded still sees it.
  if (host.__THREENATIVE_NATIVE__ === undefined) return undefined;
  const exit = host.process?.exit;
  return typeof exit === "function" ? () => exit.call(host.process, 0) : undefined;
}

/**
 * Quit the app, as Godot's `get_tree().quit()` does: the native host exits with status 0.
 *
 * A web page cannot end its own process, so the call reports `TN_QUIT_UNSUPPORTED` once and does
 * nothing — named rather than silent, because a Quit button that quietly does nothing reads to the
 * player as a broken menu.
 *
 * @situation offer a Quit button in a pause menu
 * @situation leave the app from the game's own UI
 * @example onQuit = () => ctx.quit();
 */
export function quitGame(): void {
  const exit = nativeExit();
  if (exit === undefined) {
    reportMarkerOnce(
      "TN_QUIT_UNSUPPORTED",
      "a page cannot end its own process, so ctx.quit() does nothing here; the native host exits on it. Close the tab, or read this as the platform's answer.",
    );
    return;
  }
  exit();
}
