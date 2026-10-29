import type { IPlaytestPointer } from "../scenario.js";

export const WEBGPU_BROWSER_ARGS = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  // Keep Vulkan available on both hardware and software adapters.
  "--enable-features=Vulkan",
  // No forced ANGLE/Vulkan (--use-angle=vulkan --use-vulkan --disable-vulkan-surface): on a KDE
  // Xwayland host display it blacked out the sky while the same NVIDIA adapter drew it without them.
] as const;

/** Allow performance probes to sample render work instead of Xvfb's compositor cadence. */
export const PERFORMANCE_BROWSER_ARGS = [
  "--disable-frame-rate-limit",
  "--disable-gpu-vsync",
] as const;

/**
 * What a run adds for its measurements. A frame-time assertion unthrottles only the private Xvfb,
 * whose compositor timer would pace the frames. On a real display the gated rAF interval must stay
 * the display's cadence: unthrottled, a game faster than 60 fps read the swapchain's back-pressure
 * (one ~17 ms wait every few callbacks) as a 17.5 ms interval p95. The completion window measures
 * unthrottled completion on the session display by design.
 *
 * A game drawing from a worker (PRD-752) keeps the frame-rate limit: Xvfb's compositor does not
 * pace a worker's OffscreenCanvas frames, and `--disable-frame-rate-limit` throttled them (the
 * shooter presented 36 ms frames with it, 16.7 ms without), the opposite of its effect on a page.
 */
export function measurementBrowserArgs(
  performance: boolean,
  completion: boolean,
  display: "real" | "virtual",
  gameThread: "page" | "worker" = "page",
): readonly string[] {
  const args = completion || (performance && display === "virtual") ? PERFORMANCE_BROWSER_ARGS : [];
  return gameThread === "worker" ? args.filter((argument) => argument !== "--disable-frame-rate-limit") : args;
}

export function resolveBrowserArguments(browserArgs: readonly string[] | undefined): string[] {
  return [...(browserArgs ?? [])];
}

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/i;

/**
 * Name a software adapter from what `adapter.info` reported. Every field is searched because
 * which one carries the giveaway depends on the platform: Linux Dawn puts `swiftshader` in
 * `architecture`, Mesa reports `llvmpipe` in `description`, and a headless Windows run says
 * `Microsoft Basic Render Driver` in `device`.
 */
export function softwareAdapterName(adapter: Readonly<Record<string, string>> | undefined): string | undefined {
  if (adapter === undefined) return undefined;
  for (const value of Object.values(adapter)) {
    if (typeof value === "string" && SOFTWARE_ADAPTER.test(value)) return value;
  }
  return undefined;
}

export interface IBrowserPointerChange {
  isPrimary: boolean;
  pointer: Required<IPlaytestPointer>;
  type: "pointerdown" | "pointermove" | "pointerup";
}

export function reconcileBrowserPointers(
  previous: ReadonlyMap<number, Required<IPlaytestPointer>>,
  next: readonly IPlaytestPointer[],
): IBrowserPointerChange[] {
  const normalized = new Map(next.map((pointer) => [pointer.id, {
    buttons: pointer.buttons ?? 1,
    id: pointer.id,
    x: pointer.x,
    y: pointer.y,
  }]));
  const previousPrimary = previous.keys().next().value;
  const nextPrimary = normalized.keys().next().value;
  const changes: IBrowserPointerChange[] = [];
  for (const pointer of previous.values()) {
    if (!normalized.has(pointer.id)) {
      changes.push({ isPrimary: pointer.id === previousPrimary, pointer: { ...pointer, buttons: 0 }, type: "pointerup" });
    }
  }
  for (const pointer of normalized.values()) {
    const old = previous.get(pointer.id);
    if (old === undefined) {
      changes.push({ isPrimary: pointer.id === nextPrimary, pointer, type: "pointerdown" });
    } else if (old.x !== pointer.x || old.y !== pointer.y || old.buttons !== pointer.buttons) {
      changes.push({ isPrimary: pointer.id === nextPrimary, pointer, type: "pointermove" });
    }
  }
  return changes;
}
