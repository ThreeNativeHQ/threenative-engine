import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import type { IPlaytestScenario } from "../index.js";
import type { IPlaytestBridgeClient } from "./bridgeClient.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import type { IPlaytestDeviceMetricsObservation } from "./deviceMetrics.js";
import { boundedTeardownStep, openPageAndConnectBridge, settledTeardownValue } from "./server.js";

/** Internal lifecycle contract for a browser the runner attaches to but does not own. */
export interface IRemoteBrowserSession {
  close(): Promise<void>;
  connect(config: IStandalonePlaytestConfig): Promise<Browser>;
  context(browser: Browser): Promise<BrowserContext>;
  finish(): Promise<IPlaytestDeviceMetricsObservation | undefined>;
  navigationUrl(config: IStandalonePlaytestConfig): string;
  prepare(config: IStandalonePlaytestConfig): Promise<void>;
}

const REMOTE_BROWSER_SESSIONS = new WeakMap<IStandalonePlaytestConfig, IRemoteBrowserSession>();

export function remoteBrowserFor(config: IStandalonePlaytestConfig): IRemoteBrowserSession | undefined {
  return REMOTE_BROWSER_SESSIONS.get(config);
}

export async function runWithRemoteBrowser<T>(
  config: IStandalonePlaytestConfig,
  session: IRemoteBrowserSession,
  run: (config: IStandalonePlaytestConfig) => Promise<T>,
): Promise<T> {
  if (REMOTE_BROWSER_SESSIONS.has(config)) {
    throw new Error("TN_PLAYTEST_DEVICE_FAILED: playtest config already has an active remote browser session.");
  }
  REMOTE_BROWSER_SESSIONS.set(config, session);
  try {
    return await run(config);
  } finally {
    REMOTE_BROWSER_SESSIONS.delete(config);
  }
}

export function openRunnerPage(
  page: Page,
  config: IStandalonePlaytestConfig,
  scenario: IPlaytestScenario,
  remoteBrowser: Pick<IRemoteBrowserSession, "navigationUrl"> | undefined,
): Promise<IPlaytestBridgeClient | undefined> {
  const navigationUrl = remoteBrowser?.navigationUrl(config) ?? config.url;
  // This copy is navigation-only. Reports and operator diagnostics retain the URL supplied on
  // the command line, while Android Chrome reaches the same server through its reverse tunnel.
  return installBootFailure(page, scenario)
    .then(() => (scenario.reducedMotion === undefined ? undefined : page.emulateMedia({ reducedMotion: scenario.reducedMotion })))
    .then(() => openPageAndConnectBridge(page, { ...config, url: navigationUrl }, scenario));
}

async function installBootFailure(page: Page, scenario: IPlaytestScenario): Promise<void> {
  if (scenario.bootFailure !== "renderer-no-adapter") return;
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(this: HTMLCanvasElement, contextId: string, options?: unknown) {
        if (contextId === "webgl" || contextId === "webgl2") return null;
        return originalGetContext.call(this, contextId, options);
      },
    });
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: unknown } }).gpu;
    if (gpu !== undefined) {
      Object.defineProperty(gpu, "requestAdapter", {
        configurable: true,
        value: async () => null,
      });
    }
  });
}

export async function teardownBrowserSession(
  page: Pick<Page, "close"> | undefined,
  context: Pick<BrowserContext, "close"> | undefined,
  browser: Pick<Browser, "close"> | undefined,
  browserLaunch: Promise<Browser> | undefined,
  remoteBrowser: { close(): Promise<void> } | undefined,
): Promise<void> {
  if (remoteBrowser !== undefined) {
    // CDP attaches to the user's default Android Chrome context. Closing that context or the
    // connected Browser shuts down pre-existing tabs and the Chrome process; this run owns only
    // the page it created and its adb plumbing.
    await boundedTeardownStep(page?.close(), 5_000);
    await settledTeardownValue(browserLaunch, 10_000);
    await boundedTeardownStep(remoteBrowser.close(), 10_000);
    return;
  }
  await boundedTeardownStep(context?.close(), 5_000);
  const launched = browser ?? (await settledTeardownValue(browserLaunch, 10_000));
  await boundedTeardownStep(launched?.close(), 10_000);
}


/**
 * Temporary directories Playwright creates under the temporary root.
 *
 * It makes two kinds with two different spellings: `playwright_chromiumdev_profile-*` for the
 * browser profile and `playwright-artifacts-*` for traces and videos. Matching only the
 * underscore form reclaimed the profile and left the artifacts directory behind, which the orphan
 * gate then reported on its own. One prefix covers both.
 */
export function playwrightProfileDirectories(root: string = tmpdir()): readonly string[] {
  try {
    return readdirSync(root)
      .filter((entry) => entry.startsWith("playwright"))
      .map((entry) => join(root, entry))
      .sort();
  } catch {
    // No temporary root, or one this process cannot read. Either way there is nothing to reclaim.
    return [];
  }
}

/**
 * Which of the profile directories this run created are safe to remove.
 *
 * Playwright deletes the profile of a browser it closed, but that removal happens in its driver
 * and the runner calls `process.exit` as soon as teardown returns — deliberately, because a
 * Chromium under a virtual display can sit in `close()` forever and the report is already written.
 * The cost showed up in the orphan gate: `playwright_chromiumdev_profile-*` left behind with, in
 * its own words, "no process holds these directories, so this is a real leak".
 *
 * Two conditions, because the temporary root is shared. A directory is only reclaimed if it
 * appeared after this run launched its browser, and if no live process still names it — a sibling
 * runner's profile satisfies neither, and deleting one out from under a running browser would
 * trade this leak for a much worse failure.
 */
export function reclaimableProfileDirectories(
  before: readonly string[],
  after: readonly string[],
  processArguments: string,
): readonly string[] {
  const existing = new Set(before);
  return after.filter((directory) => !existing.has(directory) && !processArguments.includes(directory));
}

/** Remove the profiles this run stranded. Returns what it removed, for the caller to report. */
export function removeStrandedProfiles(
  before: readonly string[],
  root: string = tmpdir(),
): readonly string[] {
  // `ps` is how the orphan gate itself decides whether a directory is still held. Windows has no
  // equivalent here and does not run this lane, so it simply reclaims nothing.
  if (process.platform === "win32") return [];
  const listing = spawnSync("ps", ["-eo", "args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listing.status !== 0) return [];
  const removed: string[] = [];
  for (const directory of reclaimableProfileDirectories(
    before,
    playwrightProfileDirectories(root),
    listing.stdout ?? "",
  )) {
    try {
      rmSync(directory, { force: true, recursive: true });
      removed.push(directory);
    } catch {
      // A profile that cannot be removed is reported by the gate rather than hidden here.
    }
  }
  return removed;
}
