import type { ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { assertCaptureNotBlank } from "../capture.js";
import { loadPlaytestScenario, PLAYTEST_STARTUP_READY_TIMEOUT_MS, type IPlaytestCaptureProvenance } from "../index.js";
import type { IPlaytestBridgeClient } from "./bridgeClient.js";
import { resolveBrowserArguments, softwareAdapterName, WEBGPU_BROWSER_ARGS } from "./browser.js";
import { openRunnerPage, playwrightProfileDirectories, removeStrandedProfiles, teardownBrowserSession } from "./browserSession.js";
import type { IProvidedDisplay } from "./captureEnvironment.js";
import { withPerformanceBudget } from "./buildReport.js";
import type { ICaptureLease } from "./captureLock.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import { UNHANDLED_REJECTION_PREFIX, type IRunnerConsoleEntry } from "./shared.js";
import { readCaptureProvenance } from "./observationSampling.js";
import { acquireRunnerCaptureLock, provideRunDisplay } from "./runner-support.js";
import { assertManagedUrlAvailable, findFreePort, startManagedServer, stopManagedServer, waitForUrl, withPort } from "./server.js";
import { waitForStartupReady } from "./startupReady.js";
import { waitFrames } from "./steps.js";

export interface IBrowserCaptureSession {
  readonly bridge: IPlaytestBridgeClient;
  /** Console errors collected from page creation through the custom capture callback. */
  readonly errors: readonly string[];
  /** Complete console and page-error observations from page creation onward. */
  readonly consoleEntries: readonly IRunnerConsoleEntry[];
  /** Failed network requests from page creation onward. */
  readonly networkEntries: readonly { method: string; url: string }[];
  readonly page: Page;
  readonly provenance: IPlaytestCaptureProvenance;
  readonly signal: AbortSignal;
  /** Writes only nonblank PNGs inside the configured artifact directory. */
  screenshot(label: string): Promise<string>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("TN_CAPTURE_SESSION_ABORTED");
}

/** Bound non-resource operations; acquired resources remain owned by the outer finally. */
async function captureStage<T>(
  stage: string,
  timeoutMs: number,
  controller: AbortController,
  operation: () => Promise<T>,
): Promise<T> {
  if (controller.signal.aborted) throw abortError(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(controller.signal));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error(`TN_CAPTURE_SESSION_TIMEOUT: ${stage} exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      return operation();
    }), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Borrow an owned, ready browser for a custom capture and return every resource afterwards.
 * This is not a scenario verdict: setup and readiness run, but steps/assertions do not.
 */
export async function withBrowserCapture<T>(
  config: IStandalonePlaytestConfig,
  capture: (session: IBrowserCaptureSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if ((config.target ?? "browser") !== "browser") throw new Error("TN_CAPTURE_SESSION_TARGET: only an owned browser is supported");
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647
    || (config.server?.timeoutMs !== undefined && (!Number.isSafeInteger(config.server.timeoutMs) || config.server.timeoutMs <= 0 || config.server.timeoutMs > 2_147_483_647))) {
    throw new Error("TN_CAPTURE_SESSION_TIMEOUT_INVALID: operation and server budgets must be finite positive milliseconds");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let display: IProvidedDisplay | undefined;
  let lease: ICaptureLease | undefined;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let browserLaunch: Promise<Browser> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let profilesBeforeLaunch: readonly string[] | undefined;
  const stage = <R>(name: string, operation: () => Promise<R>, timeoutMs = config.timeoutMs): Promise<R> =>
    captureStage(name, timeoutMs, controller, operation);
  const checkAbort = (): void => {
    if (controller.signal.aborted) throw abortError(controller.signal);
  };
  try {
    checkAbort();
    const scenario = withPerformanceBudget(
      await stage("scenario load", () => loadPlaytestScenario(config.projectPath, config.scenarioPath)),
      config.performanceBudget,
    );
    if (scenario.target !== "web") throw new Error("TN_CAPTURE_SESSION_TARGET: browser captures require a web scenario");
    if (scenario.bootFailure !== undefined || scenario.awaitStartup === false) {
      throw new Error("TN_CAPTURE_SESSION_READINESS_REQUIRED: custom captures cannot bypass startup; use the scenario runner for boot-failure tests");
    }
    // Queue time keeps its existing independent budget and CaptureLockTimeoutError/exit-75 identity.
    // Do not race resource acquisition: even cancellation must retain the handle needed to release it.
    lease = await acquireRunnerCaptureLock();
    checkAbort();
    display = await provideRunDisplay();
    checkAbort();
    const needsFreePort = config.server !== undefined && config.port === 0;
    const port = needsFreePort ? await findFreePort() : config.port;
    const active = {
      ...config,
      browserArgs: resolveBrowserArguments(config.browserArgs ?? WEBGPU_BROWSER_ARGS),
      headless: false,
      ...(port === undefined ? {} : { port }),
      url: needsFreePort && port !== undefined ? withPort(config.url, port) : config.url,
    };
    await mkdir(active.artifactDirectory, { recursive: true });
    if (active.server !== undefined) {
      await stage("server availability", () => assertManagedUrlAvailable(active.url));
      server = startManagedServer(active, port);
      const ownedServer = server;
      await stage("server readiness", () => waitForUrl(active.url, active.server?.timeoutMs ?? active.timeoutMs, ownedServer), active.server.timeoutMs ?? active.timeoutMs);
    }
    checkAbort();
    profilesBeforeLaunch = playwrightProfileDirectories();
    browserLaunch = chromium.launch({ args: active.browserArgs, env: display.env, headless: false, timeout: active.timeoutMs });
    const launchingBrowser = browserLaunch;
    browser = await stage("browser launch", () => launchingBrowser);
    checkAbort();
    // A timed-out child creation still belongs to the browser closed by finally.
    const ownedBrowser = browser;
    context = await stage("context creation", () => ownedBrowser.newContext({ viewport: scenario.viewport }));
    const ownedContext = context;
    page = await stage("page creation", () => ownedContext.newPage());
    const activePage = page;
    const errors: string[] = [];
    const consoleEntries: IRunnerConsoleEntry[] = [];
    const networkEntries: Array<{ method: string; url: string }> = [];
    activePage.on("console", (entry) => {
      const text = entry.text();
      const unhandledRejection = text.startsWith(UNHANDLED_REJECTION_PREFIX);
      const observed: IRunnerConsoleEntry = {
        source: unhandledRejection ? "unhandled-rejection" : "browser-console",
        text: unhandledRejection ? text.slice(UNHANDLED_REJECTION_PREFIX.length) : text,
        type: entry.type(),
      };
      consoleEntries.push(observed);
      if (["assert", "error", "pageerror"].includes(observed.type)) errors.push(observed.text);
    });
    activePage.on("pageerror", (error) => {
      const text = error.stack || error.message;
      errors.push(text);
      consoleEntries.push({ source: "page-error", text, type: "pageerror" });
    });
    activePage.on("requestfailed", (request) => {
      networkEntries.push({ method: request.method(), url: request.url() });
    });
    await stage("runner handshake marker", () => activePage.addInitScript((unhandledPrefix: string) => {
      Object.assign(globalThis, { __THREENATIVE_PLAYTEST_RUNNER_EXPECTED__: true });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason instanceof Error
          ? event.reason.stack || event.reason.message
          : String(event.reason);
        console.error(`${unhandledPrefix}${reason}`);
      });
    }, UNHANDLED_REJECTION_PREFIX));
    // Boot/bridge work gets the existing startup allowance, not a screenshot-sized budget.
    const startupBudget = Math.min(2_147_483_647, PLAYTEST_STARTUP_READY_TIMEOUT_MS + active.timeoutMs);
    const bridge = await stage("navigation and bridge handshake", () => openRunnerPage(activePage, active, scenario, undefined), startupBudget);
    if (bridge === undefined || !bridge.description.capabilities.includes("runtime.startup")) {
      throw new Error("TN_CAPTURE_SESSION_READINESS_REQUIRED: the page must report runtime.startup");
    }
    await stage("warmup", () => waitFrames(activePage, scenario.warmupFrames), startupBudget);
    const startup = await stage("engine startup readiness", () => waitForStartupReady({
      aborted: () => controller.signal.aborted,
      bridge,
      declaredSoftware: active.allowSoftwareAdapter === true,
      pump: () => waitFrames(activePage, 1),
    }), startupBudget);
    if (startup === undefined) throw new Error("TN_CAPTURE_SESSION_READINESS_REQUIRED: no startup observation was returned");
    const provenance = await stage("adapter provenance", () => readCaptureProvenance(activePage, active, scenario));
    const software = softwareAdapterName(provenance.adapter);
    if (provenance.rendererKind !== "webgpu" || (software !== undefined && active.allowSoftwareAdapter !== true)) {
      throw new Error(`TN_CAPTURE_SESSION_ADAPTER_REJECTED: renderer=${provenance.rendererKind}, software=${software ?? "not detected"}`);
    }
    await writeFile(join(active.artifactDirectory, "capture.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    await writeFile(join(active.artifactDirectory, "capture-session.json"), `${JSON.stringify({
      display: display.strategy,
      startup,
      setup: bridge.setupApplication,
      softwareAllowed: active.allowSoftwareAdapter === true,
      timingEvidence: "not-qualified",
    }, null, 2)}\n`);
    const captureSession: IBrowserCaptureSession = {
      bridge,
      get errors() { return Object.freeze([...errors]); },
      get consoleEntries() { return Object.freeze([...consoleEntries]); },
      get networkEntries() { return Object.freeze([...networkEntries]); },
      page: activePage,
      provenance,
      signal: controller.signal,
      screenshot: async (label) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) throw new Error("TN_CAPTURE_SESSION_LABEL_INVALID: use a file-safe label without an extension");
        return stage(`screenshot ${label}`, async () => {
          const destination = join(active.artifactDirectory, `${label}.png`);
          // A failed recapture must not leave a previous run's PNG looking like new evidence.
          await rm(destination, { force: true });
          const bytes = await activePage.screenshot({ timeout: active.timeoutMs });
          assertCaptureNotBlank(bytes, `${label}.png`);
          await writeFile(destination, bytes);
          return destination;
        });
      },
    };
    return await stage("custom capture callback", () => capture(captureSession));
  } finally {
    controller.abort(new Error("TN_CAPTURE_SESSION_CLOSED"));
    signal?.removeEventListener("abort", abort);
    try {
      await teardownBrowserSession(page, context, browser, browserLaunch, undefined);
      if (profilesBeforeLaunch !== undefined) removeStrandedProfiles(profilesBeforeLaunch);
    } finally {
      try {
        await stopManagedServer(server);
      } finally {
        try { await display?.release(); }
        finally { await lease?.release(); }
      }
    }
  }
}
