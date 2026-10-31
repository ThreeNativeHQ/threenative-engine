import { type Browser, chromium } from "@playwright/test";
import { WEBGPU_BROWSER_ARGS } from "../../packages/playtest/src/runner/browser.js";
import {
  type IProvideDisplayOptions,
  provideDisplay,
} from "../../packages/playtest/src/runner/captureEnvironment.js";

/**
 * Stops a capture whose page did not read the query it was given. Since the starter runs its game in a
 * web worker, `index.html` hands the scene an empty `location.search`: every cell then drew the default
 * layer, sun and look while the capture filed it under the requested one. The page echoes what it read
 * as `window.__tnRef.config`; each requested parameter must come back unchanged.
 */
export function assertConfigEcho(url: string, echoed: unknown): void {
  const requested = Object.fromEntries(new URL(url).searchParams);
  const read = (echoed ?? {}) as Record<string, unknown>;
  const differ = Object.keys(requested).filter((key) => read[key] !== requested[key]);
  if (differ.length > 0)
    throw new Error(
      `TN_UNREAL_LOOK_CONFIG_MISMATCH: the page read ${JSON.stringify(echoed ?? null)} for ${JSON.stringify(requested)} (${differ.join(", ")})`,
    );
}

/**
 * The headed WebGPU browser every Unreal-look capture opens.
 *
 * A bare `chromium.launch({ headless: false })` paints on whatever `DISPLAY` the shell exports.
 * After a reboot that is `:0`, the owner's screen, and three lanes opened Chrome windows over it.
 * This takes the display decision from the playtest runner (`provideDisplay`): a private Xvfb for
 * every launch, the Wayland variables stripped, and the session's own display only when
 * `TN_PLAYTEST_HOST_DISPLAY=1` asks for it. Set `TN_XVFB_SCREEN` for a viewport above 1600x900.
 *
 * `close()` also stops the display, so a caller keeps its one `finally { await browser.close() }`.
 */
export async function launchWebgpuBrowser(display?: IProvideDisplayOptions): Promise<Browser> {
  const provided = await provideDisplay(display);
  try {
    const browser = await chromium.launch({
      args: [...WEBGPU_BROWSER_ARGS],
      env: provided.env,
      headless: false,
    });
    const close = browser.close.bind(browser);
    browser.close = async (options) => {
      try {
        await close(options);
      } finally {
        await provided.release();
      }
    };
    return browser;
  } catch (error) {
    await provided.release();
    throw error;
  }
}
