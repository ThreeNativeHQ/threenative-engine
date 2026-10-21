import { createOwnedRunResourceRelease } from "./ownedRunResources.js";
import type { IPlaytestToneCaptureObservation } from "../tone.js";
import { completionWindowEnvironment, completionWindowLabel, measureCompletionWindow, setPointerButtons, setBrowserPointers, type ICompletionWindow, waitFrames, captureVisualSurface, runStep, sampleVisualElementBounds, screenshotObservations, sampleAfterTransition } from "./steps.js";
import type { StepInputState } from "./steps.js";
import { withPerformanceBudget } from "./buildReport.js";
import { alignScenarioStartTick, preflightDisplay, acquireRunnerCaptureLock, provideRunDisplay, buildReport, addPreflightDiagnostic, isJudgeMarkerRequestFailure } from "./runner-support.js";
import type { IPageLifecycle } from "./server.js";
import { stopManagedServer, boundedTeardownStep, settledTeardownValue, assertManagedUrlAvailable, startManagedServer, waitForUrl, openPageAndConnectBridge, pageLifecycleDiagnostic, findFreePort, withPort } from "./server.js";
import { sampleHud } from "./sampling.js";
import {
  normalizedRuntimeDiagnostics,
  pairObservations,
  readCaptureProvenance,
} from "./observationSampling.js";
import { accumulatedPathLength, entityPosition, failureReport, interruptedPlaytestError, isAnonymousMovementScenario, observedEntityIds, observedResourceIds, PRESENTATION_BOUND_MS, safePart, SCREENSHOT_TIMEOUT_MS, withPageCause } from "./shared.js";
import {
  failedDiagnosticsAssertion,
  ManagedServerError,
  MAX_FIXED_STEP_STARTUP_RETRIES,
  STOPPED_LOOP_ERROR,
  UNHANDLED_REJECTION_PREFIX,
} from "./shared.js";
import type {
  IRunStepSamples,
  IStandalonePlaytestReport,
  ILabeledPlaytestSample,
  IMovementSampleInterval,
  IRunnerConsoleEntry,
} from "./shared.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  evaluateRichPlaytestAssertions,
  loadPlaytestScenario,
  playtestDiagnostic,
  playtestStepHoldTicks,
  playtestStepWaitTicks,
  resolveDiagnosticsPolicy,
  type IPlaytestArtifactRequest,
  type IPlaytestCaptureProvenance,
  type IPlaytestFramebufferCoverageObservation,
  type IPlaytestScenario,
  type IPlaytestSetupApplication,
  type IPlaytestVisualElementRegionObservation,
  type PlaytestVec3,
} from "../index.js";
import type { IPlaytestObservationSnapshot } from "../protocol.js";
import { assertCaptureNotBlank, CaptureGuardError, collectRegionalTone } from "../capture.js";
import { retakeWhileBlank } from "./capture-retry.js";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";

import { connectPlaytestBridge, PlaytestBridgeError, type IPlaytestBridgeClient } from "./bridgeClient.js";
import { waitForStartupReady } from "./startupReady.js";
import {
  PERFORMANCE_BROWSER_ARGS,
  reconcileBrowserPointers,
  resolveBrowserArguments,
  softwareAdapterName,
} from "./browser.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import {
  provideDisplay,
  runNeedsPixels,
  type IProvidedDisplay,
} from "./captureEnvironment.js";
import {
  acquireCaptureLock,
  decideLockPolicy,
  defaultCaptureLockRoot,
  detectCaptureConcurrency,
  isProcessAlive,
  type ICaptureLease,
} from "./captureLock.js";
import {
  finishFramebufferCoverageProbe,
  startFramebufferCoverageProbe,
} from "./framebufferCoverage.js";
import { STANDALONE_PLAYTEST_OBSERVATION_FIELDS } from "./observationFields.js";
import {
  openRunnerPage,
  remoteBrowserFor,
  playwrightProfileDirectories,
  removeStrandedProfiles,
  teardownBrowserSession,
  type IRemoteBrowserSession,
} from "./browserSession.js";
import { startBrowserCpuProfile, type IBrowserCpuProfile } from "./cpuProfile.js";
import { browserCpuProcess, cpuWindowLabels, measureCpuWindow, type ICpuWindow } from "./linuxCpuWindow.js";
import { formatScenarioSummary } from "./scenario-summary.js";

const TOUCH_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36 Chrome/151.0 Mobile Safari/537.36";

function isTouchPrimaryBrowserScenario(scenario: IPlaytestScenario): boolean {
  if (!scenario.steps.some(({ pointers }) => pointers !== undefined)) return false;
  // Pointer steps also drive mouse placement and pinch assertions. The authored touch-control
  // visibility assertion is the scenario's explicit declaration that this is the touch-primary
  // browser lane, so those existing pointer scenarios keep their desktop platform signal.
  return (
    scenario.assert?.visibility?.some(
      ({ entity, present }) => entity === "touch-controls" && present === true,
    ) ?? false
  );
}

interface IVisualPageCapture {
  elementRegions?: IPlaytestVisualElementRegionObservation[];
  image: Buffer;
}

interface IVisualPageCapture {
  elementRegions?: IPlaytestVisualElementRegionObservation[];
  image: Buffer;
}

export { preflightDisplay, buildReport } from './runner-support.js';
export { captureVisualSurface } from './steps.js';
export { advanceFixedStep, playtestStepDrivesMovement } from './steps.js';
export { isRuntimeReadout } from './observationSampling.js';
export { ManagedServerError, failedDiagnosticsAssertion } from './shared.js';
export { resolveManagedServerCommand, substituteManagedPort, boundedTeardownStep, pageLifecycleDiagnostic } from './server.js';
export type { IStandalonePlaytestReport, ILabeledPlaytestSample, IMovementSampleInterval, IRunStepSamples, IRunnerConsoleEntry } from './shared.js';
export { STANDALONE_PLAYTEST_OBSERVATION_FIELDS } from "./observationFields.js";

export async function handlePlaytestSignal(
  teardown: (stopManagedServer: boolean) => Promise<void>,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
  target = "browser",
  writeMessage: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`);
  },
): Promise<void> {
  await teardown(true).catch(() => undefined);
  writeMessage(interruptedPlaytestError(target).message);
  setExitCode(2);
  exit(2);
}


export async function writeCaptureProvenance(
  artifactDirectory: string,
  provenance: IPlaytestCaptureProvenance,
): Promise<void> {
  await writeFile(join(artifactDirectory, "capture.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}

/**
 * Diagnostics name `console.json` and `runtime-trace.json`, and `artifacts.console`,
 * `artifacts.network` and `artifacts.runtimeTrace` accept a request for them. Neither was
 * written: a build hitting TN_PLAYTEST_CONSOLE_ERROR found the artifact directory holding
 * only `after.png` and `capture.json`, and had to reconstruct the errors from provenance.
 * A message that names a file the runner never writes sends the reader somewhere empty, so
 * write each one whenever it has content or was asked for.
 */
export async function writeObservationArtifacts(
  artifactDirectory: string,
  requested: IPlaytestArtifactRequest | undefined,
  observations: {
    console: readonly unknown[];
    network: readonly unknown[];
    runtimeTrace: { readonly recentRuntimeErrors?: readonly unknown[]; readonly [key: string]: unknown } | undefined;
  },
): Promise<readonly string[]> {
  const runtimeErrors = observations.runtimeTrace?.recentRuntimeErrors ?? [];
  const files: Array<[string, unknown, boolean]> = [
    ["console.json", observations.console, observations.console.length > 0 || requested?.console === true],
    ["network.json", observations.network, observations.network.length > 0 || requested?.network === true],
    ["runtime-trace.json", observations.runtimeTrace, runtimeErrors.length > 0 || requested?.runtimeTrace === true],
  ];
  const written: string[] = [];
  for (const [name, content, wanted] of files) {
    if (!wanted || content === undefined) continue;
    await writeFile(join(artifactDirectory, name), `${JSON.stringify(content, null, 2)}\n`);
    written.push(name);
  }
  return written;
}

export interface IStandalonePlaytestRunOptions {
  managedServer?: ChildProcess;
}

interface IStandalonePlaytestInternalOptions extends IStandalonePlaytestRunOptions {
  remoteBrowser?: IRemoteBrowserSession;
}

export async function runStandalonePlaytest(
  config: IStandalonePlaytestConfig,
  options: IStandalonePlaytestRunOptions = {},
): Promise<IStandalonePlaytestReport> {
  return runStandalonePlaytestInternal(config, {
    ...options,
    remoteBrowser: remoteBrowserFor(config),
  });
}

async function runStandalonePlaytestInternal(
  config: IStandalonePlaytestConfig,
  options: IStandalonePlaytestInternalOptions = {},
): Promise<IStandalonePlaytestReport> {
  const usesFreePort = config.server !== undefined && config.port === 0;
  const activeConfig = usesFreePort ? await resolveManagedServerConfig(config) : config;
  const scenario = withPerformanceBudget(
    await loadPlaytestScenario(activeConfig.projectPath, activeConfig.scenarioPath),
    activeConfig.performanceBudget,
  );
  const cpuLabels = cpuWindowLabels(scenario, "browser", activeConfig.liveClock === true);
  if (cpuLabels.length > 0 && options.remoteBrowser !== undefined) {
    throw new Error("TN_PLAYTEST_CPU_WINDOW_FAILED: remote browser has no local owned process tree");
  }
  const cpuWindows: ICpuWindow[] = [];
  const completionLabel = completionWindowLabel(scenario, "browser", activeConfig.liveClock === true);
  let completionWindow: ICompletionWindow | undefined;
  const completionDisplay = completionLabel === undefined ? undefined : completionWindowEnvironment("browser", activeConfig.headless);
  if (completionLabel !== undefined && options.remoteBrowser !== undefined) throw new Error("TN_PLAYTEST_COMPLETION_WINDOW_FAILED: requires a fresh local browser process");
  const browserConfig = scenario.assert?.performance === undefined && completionLabel === undefined
    ? activeConfig
    : {
        ...activeConfig,
        browserArgs: [
          ...(activeConfig.browserArgs ?? []),
          ...PERFORMANCE_BROWSER_ARGS.filter((argument) => !activeConfig.browserArgs?.includes(argument)),
        ],
      };
  await mkdir(activeConfig.artifactDirectory, { recursive: true });
  let server: ChildProcess | undefined;
  const ownsServer = options.managedServer === undefined && activeConfig.server !== undefined;
  server = options.managedServer;
  let browser: Browser | undefined;
  let browserLaunch: Promise<Browser> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let displayAcquisition: Promise<IProvidedDisplay> | undefined;
  let leaseAcquisition: Promise<ICaptureLease> | undefined;
  const releaseOwnedResources = createOwnedRunResourceRelease(
    () => displayAcquisition,
    () => leaseAcquisition,
  );
  let teardownPromise: Promise<void> | undefined;
  let serverTeardownPromise: Promise<void> | undefined;
  const pageLifecycle: IPageLifecycle = {
    closed: false,
    crashed: false,
    frameNavigations: [],
    navigations: [],
    settled: false,
    tail: [],
  };
  const stopServer = async (): Promise<void> => {
    serverTeardownPromise ??= stopManagedServer(server);
    await serverTeardownPromise;
  };
  let profilesBeforeLaunch: readonly string[] | undefined;
  // `--cpu-prof` writes the loadable DevTools artifact for this run. Stopping is idempotent so the
  // success path (before the page closes) and the failure path (in `finally`) share one call. On
  // the success path a missing profile fails the run: a green run without its artifact is a lie.
  let cpuProfile: IBrowserCpuProfile | undefined;
  let cpuProfileStopped = false;
  const stopCpuProfile = async (failClosed: boolean): Promise<void> => {
    if (cpuProfile === undefined || cpuProfileStopped) return;
    cpuProfileStopped = true;
    try {
      const written = await cpuProfile.stop();
      process.stderr.write(`${JSON.stringify({ cpuProfile: written })}\n`);
    } catch (error) {
      if (failClosed) {
        throw new Error(`TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.stderr.write(
        `${JSON.stringify({ diagnostics: [{ code: "TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED", message: error instanceof Error ? error.message : String(error), severity: "error" }] })}\n`,
      );
    }
  };
  const teardown = async (stopManagedServerOnTeardown = ownsServer): Promise<void> => {
    teardownPromise ??= (async () => {
      // Chromium does not always exit when asked — under a virtual display with a live GPU
      // process it can sit in close() forever. The report is already written by this point, so
      // teardown gives up rather than holding the run open; the CLI then exits explicitly.
      // A signal can arrive while chromium.launch() is still in flight, when `browser` is not
      // yet assigned. Closing only the assigned handle would close nothing and exit the process
      // over a live Chromium, stranding it and its profile directory — which is the orphan the
      // suite gate catches. Wait for the launch to settle, then close whatever it produced.
      await teardownBrowserSession(page, context, browser, browserLaunch, options.remoteBrowser);
      // Teardown above is deliberately bounded, and the CLI exits as soon as it returns — so
      // Playwright's own removal of the profile directory may never run. Reclaim what this run
      // launched and nothing else; the orphan gate reports whatever is left.
      if (profilesBeforeLaunch !== undefined) {
        const removed = removeStrandedProfiles(profilesBeforeLaunch);
        if (removed.length > 0) {
          process.stderr.write(
            `${JSON.stringify({ reclaimedBrowserProfiles: removed.length })}\n`,
          );
        }
      }
    })();
    await teardownPromise.catch(() => undefined);
    if (stopManagedServerOnTeardown) await stopServer();
    // Signal exits do not reach finally. Await this run's pending handles before exiting too.
    await releaseOwnedResources();
  };
  let tearingDown = false;
  const ensureRunning = (): void => {
    if (tearingDown) throw interruptedPlaytestError(activeConfig.target ?? "browser");
  };
  const handleSignal = (): void => {
    // Read by the startup wait so it yields to teardown instead of polling to its own deadline.
    tearingDown = true;
    void handlePlaytestSignal(
      (stopManagedServerOnSignal) => teardown(stopManagedServerOnSignal),
      undefined,
      undefined,
      activeConfig.target ?? "browser",
    );
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  // Pixel-producing runs have their display handled by the runner itself now (a private Xvfb
  // whenever Linux offers no usable X display), so the wrapper-only preflight advice is
  // muted exactly where provisioning answers it; every other run keeps it.
  const needsPixels = options.remoteBrowser === undefined && (completionLabel !== undefined || runNeedsPixels(activeConfig, scenario));
  const preflight = needsPixels ? undefined : preflightDisplay(activeConfig, scenario);
  if (preflight !== undefined) {
    process.stderr.write(`${JSON.stringify({ diagnostics: [preflight] })}\n`);
  }
  let providedDisplay: IProvidedDisplay | undefined;
  let observationArtifactsWritten = false;
  const consoleEntries: IRunnerConsoleEntry[] = [];
  const networkEntries: Array<{ method: string; url: string }> = [];
  try {
    if (needsPixels) {
      leaseAcquisition = acquireRunnerCaptureLock();
      await leaseAcquisition;
      ensureRunning();
      displayAcquisition = provideRunDisplay();
      providedDisplay = await displayAcquisition;
      ensureRunning();
    }
    if (activeConfig.server !== undefined && server === undefined) {
      if (!usesFreePort) await assertManagedUrlAvailable(activeConfig.url);
      ensureRunning();
      server = startManagedServer(activeConfig, usesFreePort ? activeConfig.port : undefined);
    }
    if (options.remoteBrowser !== undefined && server !== undefined && options.managedServer === undefined) {
      await waitForUrl(activeConfig.url, activeConfig.server?.timeoutMs ?? activeConfig.timeoutMs, server);
    }
    await options.remoteBrowser?.prepare(activeConfig);
    ensureRunning();
    // Snapshot the profiles that already exist, so teardown can tell this run's from a sibling's.
    profilesBeforeLaunch = playwrightProfileDirectories();
    browserLaunch = options.remoteBrowser === undefined
      ? chromium.launch({
          ...(browserConfig.browserArgs === undefined ? {} : { args: resolveBrowserArguments(browserConfig.browserArgs) }),
          ...(providedDisplay === undefined ? {} : { env: providedDisplay.env }),
          headless: activeConfig.headless,
        })
      : options.remoteBrowser.connect(activeConfig);
    browser = await browserLaunch;
    ensureRunning();
    if (options.remoteBrowser === undefined && server !== undefined && options.managedServer === undefined) {
      await waitForUrl(activeConfig.url, activeConfig.server?.timeoutMs ?? activeConfig.timeoutMs, server);
    }
    ensureRunning();
    const touchBrowser = isTouchPrimaryBrowserScenario(scenario);
    // Explicit touch-control scenarios expose the same mobile signal that core's portable
    // predicate reads; keyboard and other pointer-only scenarios stay desktop.
    context = options.remoteBrowser === undefined
      ? await browser.newContext({
          viewport: scenario.viewport,
          ...(touchBrowser
            ? { hasTouch: true, userAgent: TOUCH_BROWSER_USER_AGENT }
            : {}),
        })
      : await options.remoteBrowser.context(browser);
    ensureRunning();
    if (touchBrowser && options.remoteBrowser === undefined) {
      // Chromium keeps desktop `userAgentData.mobile` unless full mobile emulation is enabled.
      // That emulation breaks the minimal template's WebGPU atmosphere path, so expose the one
      // platform fact the touch lane is declaring without changing its viewport/render surface.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "userAgentData", {
          configurable: true,
          value: { mobile: true, platform: "Android" },
        });
      });
    }
    ensureRunning();
    if (activeConfig.trace) {
      await context.tracing.start({ screenshots: true, snapshots: true });
    }
    ensureRunning();
    page = await context.newPage();
    const requestUrls = new Set<string>();
    page.on("request", (request) => requestUrls.add(request.url()));
    ensureRunning();
    await page.addInitScript((liveClock) => {
      // Announce the runner before any game code evaluates, so an adapter can hold its loop
      // instead of racing this run's first observation.
      (globalThis as Record<string, unknown>).__THREENATIVE_PLAYTEST_RUNNER_EXPECTED__ = true;
      // The clock request rides with it, ahead of every page script, for the same reason: read
      // once when the producer installs, a request that arrived after the game's own bundle
      // evaluated is one the engine never saw. The wire name is literal because the other end of
      // it is the page's engine, not this package.
      if (liveClock) (globalThis as Record<string, unknown>).__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason instanceof Error
          ? event.reason.stack || event.reason.message
          : String(event.reason);
        console.error(`__THREENATIVE_PLAYTEST_UNHANDLED_REJECTION__:${reason}`);
      });
    }, activeConfig.liveClock === true);
    page.on("console", (entry) => {
      const text = entry.text();
      const unhandledRejection = text.startsWith(UNHANDLED_REJECTION_PREFIX);
      consoleEntries.push({
        source: unhandledRejection ? "unhandled-rejection" : "browser-console",
        text: unhandledRejection ? text.slice(UNHANDLED_REJECTION_PREFIX.length) : text,
        type: entry.type(),
      });
      pageLifecycle.tail.push(`${entry.type()}: ${text}`);
      if (pageLifecycle.tail.length > 8) pageLifecycle.tail.shift();
    });
    page.on("pageerror", (error) => consoleEntries.push({ source: "page-error", text: error.stack || error.message, type: "pageerror" }));
    page.on("requestfailed", (request) => {
      const method = request.method();
      const url = request.url();
      if (isJudgeMarkerRequestFailure(method, url, activeConfig.judgeMarkerUrl)) return;
      networkEntries.push({ method, url });
    });
    // A renderer crash and a page navigation both surface as "Execution context was destroyed"
    // on the next evaluate, and the two need opposite fixes. Record which actually happened so
    // the report names it instead of emitting the unexplained-error catch-all.
    const observedPage = page;
    page.on("crash", () => {
      pageLifecycle.crashed = true;
    });
    page.on("framenavigated", (frame) => {
      if (frame !== observedPage.mainFrame()) return;
      pageLifecycle.frameNavigations.push(frame.url());
      if (pageLifecycle.settled) pageLifecycle.navigations.push(frame.url());
    });
    page.on("close", () => {
      pageLifecycle.closed = true;
    });
    const activePage = page;
    if (activeConfig.cpuProfilePath !== undefined) {
      cpuProfile = await startBrowserCpuProfile(activePage, activeConfig.cpuProfilePath);
    }
    const bridge = await openRunnerPage(page, browserConfig, scenario, options.remoteBrowser);
    // From here on the page is expected to stay put; anything that moves it is evidence.
    pageLifecycle.settled = true;
    const setupApplication = bridge?.setupApplication;
    if (scenario.setup !== undefined) {
      // The capability handshake already failed the run when the page has no bridge but
      // setup requires one; this guard keeps that promise explicit instead of relying on
      // registry drift never happening.
      if (bridge === undefined) {
        throw new PlaytestBridgeError(playtestDiagnostic(
          "TN_PLAYTEST_BRIDGE_MISSING",
          "Scenario declares setup overrides but no playtest bridge is installed to receive them.",
          "Install the playtest bridge before application startup.",
        ));
      }
    }
    await waitFrames(page, scenario.warmupFrames);
    // `warmupFrames` is a fixed count, so whether it covers the application's launch depends on
    // the machine. Where the application reports its own startup, wait for that instead: the
    // baseline below must be read from a game that is running, not from one still loading.
    // `allowSoftwareAdapter` is the operator saying out loud that this machine has no GPU. The
    // wait still runs to full readiness; the declaration is the only thing that labels the result
    // as the non-smoothness measurement it is. Nothing infers it from a slow run.
    const startupOutcome = bridge === undefined || scenario.awaitStartup === false
      ? undefined
      : await waitForStartupReady({
          aborted: () => tearingDown,
          bridge,
          declaredSoftware: activeConfig.allowSoftwareAdapter === true,
          pump: () => waitFrames(activePage, 1),
        });
    await alignScenarioStartTick(bridge, scenario.startTick, activeConfig.liveClock === true);
    const runtimeReady = await page.evaluate(() =>
      document.readyState !== "loading" && document.querySelector("canvas") !== null,
    ).catch(() => false);
    // Vite can abort dependency-prefetch requests while the first document is settling. Those
    // cold-start failures are not gameplay evidence; diagnostics begin at the readiness boundary.
    if (runtimeReady) networkEntries.length = 0;
    const entityIds = observedEntityIds(scenario);
    const resourceIds = observedResourceIds(scenario);
    const sampleRequest = {
      ...(entityIds === undefined ? {} : { entities: entityIds }),
      include: [
        "components",
        "diagnostics",
        "entities",
        "resources",
        ...(scenario.assert?.aerodynamics === undefined &&
        scenario.assert?.contacts === undefined &&
        scenario.assert?.settled === undefined
          ? []
          : ["physicsDebugSeries"]),
        ...(scenario.assert?.performance === undefined && scenario.assert?.parity === undefined
          ? []
          : ["runtimeDiagnosticsSeries"]),
        ...(scenario.assert?.renderChain === undefined ? [] : ["renderChain"]),
      ],
      resources: resourceIds,
      // One selector per assertion, in scenario order: the evaluator reads observation `i` for
      // assertion `i`, so the mapping has to be positional and never deduplicated.
      ...(scenario.assert?.sceneNodes === undefined
        ? {}
        : { sceneNodes: scenario.assert.sceneNodes.map(({ select }) => select) }),
      // One armed capture per sample; absent means the bridge does no geometry work at all.
      ...(scenario.assert?.geometry === undefined ? {} : { geometry: scenario.assert.geometry }),
    } as const;
    const labeledSamples: ILabeledPlaytestSample[] = [];
    const capturesAnonymousMovement = isAnonymousMovementScenario(scenario);
    // Per-step samples used to be collected only for anonymous movement scenarios. A named entity
    // needs them too, but only as a fallback: when the whole-run window cannot see it — a scenario
    // that opens on a menu has no player at its first snapshot — the report measures the entity
    // between its first and last observation instead of reporting a distance of zero it never
    // measured. Collected whenever a movement assertion exists, which is what pays for them.
    const capturesMovementSamples = capturesAnonymousMovement || scenario.assert?.movement !== undefined;
    const movementSamples: IMovementSampleInterval[] = [];
    const tone: IPlaytestToneCaptureObservation[] = [];
    const wantsFinalTone = scenario.assert?.tone?.some(({ atStep }) => atStep === undefined) === true;
    const wantsVisual = (scenario.assert?.visual?.length ?? 0) > 0;
    const visualAssertions = scenario.assert?.visual ?? [];
    const hasElementBoundVisualRegion = visualAssertions.some(({ region }) => region !== undefined && "element" in region);
    const needsCapture = scenario.artifacts?.screenshots !== false
      || scenario.steps.some((step) => step.screenshot !== undefined)
      || wantsVisual || (scenario.assert?.tone?.length ?? 0) > 0;
    const requiresWebGpuProvenance = browserConfig.browserArgs?.includes("--enable-unsafe-webgpu") === true;
    const captureProvenance = scenario.bootFailure === undefined && (needsCapture || requiresWebGpuProvenance)
      ? await readCaptureProvenance(page, browserConfig, scenario)
      : undefined;
    if (captureProvenance !== undefined) {
      await writeCaptureProvenance(activeConfig.artifactDirectory, captureProvenance);
    }
    let captureFailure: { code: "TN_CAPTURE_BLANK"; label: string; reason: string } | undefined;
    /**
     * One blank-capture grace window. An accelerated canvas can legitimately present nothing at
     * the sampled instant — shader prewarm still settling, HMR re-present, a busy GPU, a restart's
     * new render chain still compiling — while the world is some presents away from its first
     * visible frame. Wait for two more animation frames (bounded by 500 ms) before the caller
     * shoots again, and keep shooting until the surface shows something or
     * `PRESENTATION_BOUND_MS` passes. Not a skip: a surface still blank at the bound is final,
     * so a genuinely blank surface still fails closed.
     */
    const presentationGrace = async (): Promise<void> => {
      if (page === undefined || page.isClosed?.()) return;
      await Promise.race([
        page.evaluate(() => new Promise<void>((resolveFrames) => {
          let remaining = 2;
          const tick = (): void => {
            remaining -= 1;
            if (remaining <= 0) resolveFrames();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 500)),
      ]);
    };
    const capturePage = async (
      label: string,
      requested: Parameters<Page["screenshot"]>[0],
      captureElementBounds = false,
      atStep?: string,
    ): Promise<IVisualPageCapture | undefined> => {
      // Playwright's 30s default is sized for a machine with a GPU. A CPU rasteriser — SwiftShader
      // on a CI runner, llvmpipe on a headless box — composites the same frame one to two orders
      // of magnitude slower, and the shot times out with `page.screenshot: Timeout 30000ms
      // exceeded` after reporting `fonts loaded`, which reads as a broken game rather than a slow
      // one. The scenario's own timeout still bounds the run; this only stops a slow machine from
      // being reported as a failed capture.
      const options = { timeout: SCREENSHOT_TIMEOUT_MS, ...requested };
      let elementRegions = captureElementBounds
        ? await sampleVisualElementBounds(activePage, visualAssertions)
        : undefined;
      let png: Buffer;
      try {
        png = await activePage.screenshot(options);
      } catch (error) {
        try {
          const fallback = await captureVisualSurface(
            activePage,
            typeof options?.path === "string" ? options.path : undefined,
          );
          if (fallback === undefined) throw error;
          png = fallback;
        } catch {
          throw error;
        }
      }
      try {
        const stats = assertCaptureNotBlank(png, label);
        if (stats.tone !== undefined) tone.push({ code: "TN_TONE", label, ...(atStep === undefined ? {} : { atStep }), ...stats.tone });
        tone.push(...collectRegionalTone(png, scenario.assert?.tone ?? [], label, atStep));
        return { ...(elementRegions === undefined ? {} : { elementRegions }), image: png };
      } catch (error) {
        if (!(error instanceof CaptureGuardError)) throw error;
        try {
          return await retakeWhileBlank(
            async () => {
              if (captureElementBounds) elementRegions = await sampleVisualElementBounds(activePage, visualAssertions);
              try {
                png = await activePage.screenshot(options);
              } catch {
                // The first shot stands; its blank verdict is what gets reported below.
              }
              const stats = assertCaptureNotBlank(png, label);
              if (stats.tone !== undefined) tone.push({ code: "TN_TONE", label, ...(atStep === undefined ? {} : { atStep }), ...stats.tone });
              tone.push(...collectRegionalTone(png, scenario.assert?.tone ?? [], label, atStep));
              return { ...(elementRegions === undefined ? {} : { elementRegions }), image: png };
            },
            presentationGrace,
            PRESENTATION_BOUND_MS,
          );
        } catch (error2) {
          if (!(error2 instanceof CaptureGuardError)) throw error2;
          captureFailure ??= { code: error2.code, label: error2.label, reason: error2.reason };
          return undefined;
        }
      }
    };
    const captureVisualPage = async (
      label: string,
      artifactPath: string | undefined,
      atStep?: string,
    ): Promise<IVisualPageCapture | undefined> => {
      if (scenario.bootFailure !== undefined || hasElementBoundVisualRegion) {
        return capturePage(
          label,
          artifactPath === undefined ? {} : { path: artifactPath },
          hasElementBoundVisualRegion,
          atStep,
        );
      }
      try {
        const png = await captureVisualSurface(activePage, artifactPath);
        if (png === undefined) {
          captureFailure ??= {
            code: "TN_CAPTURE_BLANK",
            label,
            reason: "no canvas was available for the visual capture",
          };
          return undefined;
        }
        const stats = assertCaptureNotBlank(png, label);
        if (stats.tone !== undefined) tone.push({ code: "TN_TONE", label, ...(atStep === undefined ? {} : { atStep }), ...stats.tone });
        tone.push(...collectRegionalTone(png, scenario.assert?.tone ?? [], label, atStep));
        return { image: png };
      } catch (error) {
        if (!(error instanceof CaptureGuardError)) throw error;
        try {
          const retry = await retakeWhileBlank(
            async () => {
              const shot = await captureVisualSurface(activePage, artifactPath);
              if (shot === undefined) return undefined;
              const stats = assertCaptureNotBlank(shot, label);
              if (stats.tone !== undefined) tone.push({ code: "TN_TONE", label, ...(atStep === undefined ? {} : { atStep }), ...stats.tone });
              tone.push(...collectRegionalTone(shot, scenario.assert?.tone ?? [], label, atStep));
              return shot;
            },
            presentationGrace,
            PRESENTATION_BOUND_MS,
          );
          if (retry !== undefined) return { image: retry };
        } catch (error2) {
          if (!(error2 instanceof CaptureGuardError)) throw error2;
          captureFailure ??= { code: error2.code, label: error2.label, reason: error2.reason };
          return undefined;
        }
        captureFailure ??= { code: error.code, label: error.label, reason: error.reason };
        return undefined;
      }
    };
    const beforeSnapshot = await bridge?.sample(sampleRequest);
    if (completionLabel !== undefined && beforeSnapshot?.clock.mode !== "fixed-step") throw new Error("TN_PLAYTEST_COMPLETION_WINDOW_FAILED: prefix requires fixed-step clock");
    let movementCursor = beforeSnapshot;
    const movementEntity = scenario.assert?.movement?.entity ?? scenario.subject;
    const movementNeedsBaseline = scenario.assert?.movement !== undefined
      && movementEntity !== undefined
      && entityPosition(beforeSnapshot, movementEntity) === undefined;
    let movementBaselineSnapshot: IPlaytestObservationSnapshot | undefined;
    const transitionEntity = scenario.subject ?? movementEntity;
    let transitionSubjectNeedsSettle = transitionEntity !== undefined
      && entityPosition(beforeSnapshot, transitionEntity) === undefined;
    const establishSceneSubject = async (): Promise<void> => {
      if (!transitionSubjectNeedsSettle || bridge === undefined || transitionEntity === undefined || page === undefined) return;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const snapshot = await bridge.sample(sampleRequest);
        if (entityPosition(snapshot, transitionEntity) !== undefined) {
          transitionSubjectNeedsSettle = false;
          if (movementNeedsBaseline && movementBaselineSnapshot === undefined) {
            movementBaselineSnapshot = snapshot;
          }
          return;
        }
        await waitFrames(page, 1);
      }
    };
    const pathEntity = scenario.assert?.movement?.pathLength === undefined
      ? undefined
      : scenario.assert.movement.entity ?? scenario.subject;
    const pathPositions = beforeSnapshot === undefined || pathEntity === undefined
      ? []
      : [entityPosition(beforeSnapshot, pathEntity)].filter((position): position is PlaytestVec3 => position !== undefined);
    const inputState: StepInputState = { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() };
    const hudAssertions = scenario.assert?.hud ?? [];
    const beforeHud = await sampleHud(page, hudAssertions);
    // `--no-screenshots` drops the convenience frames a run takes whether or not anything reads
    // them. A scenario that asserts on a frame keeps `wantsVisual` true and still captures one, so
    // this can never turn a visual assertion into a silent pass.
    const artifactFrames = activeConfig.captureArtifactScreenshots !== false;
    const beforeScreenshot = (scenario.artifacts?.screenshots === "before-after" && artifactFrames) || wantsVisual
      ? wantsVisual
        ? await captureVisualPage(
            "before.png",
            scenario.artifacts?.screenshots === "before-after"
              ? join(activeConfig.artifactDirectory, "before.png")
              : undefined,
          )
        : await capturePage("before.png", scenario.artifacts?.screenshots === "before-after"
          ? { path: join(activeConfig.artifactDirectory, "before.png") }
          : {})
      : undefined;
    let framebufferCoverage: IPlaytestFramebufferCoverageObservation | undefined;
    for (const [index, step] of scenario.steps.entries()) {
      const framebufferAssertion = scenario.assert?.framebufferCoverage;
      if (framebufferAssertion !== undefined
        && step.label === framebufferAssertion.window.startStep) {
        await startFramebufferCoverageProbe(page, framebufferAssertion);
      }
      const stepSamples = await runStep(
        page,
        bridge,
        step,
        scenario.viewport,
        pathEntity,
        pathPositions,
        inputState,
        step.waitForResource !== undefined || capturesMovementSamples || movementNeedsBaseline
          ? sampleRequest
          : undefined,
        index === scenario.steps.length - 1,
        scenario.subject,
        activeConfig.liveClock === true,
        step.label !== undefined && cpuLabels.includes(step.label)
          ? async (advance) => {
              if (browser === undefined || bridge === undefined) throw new Error("TN_PLAYTEST_CPU_WINDOW_FAILED: missing browser/bridge");
              cpuWindows.push(await measureCpuWindow(step.label!, () => browserCpuProcess(browser!), bridge, advance));
            }
          : undefined,
        step.label === completionLabel && completionLabel !== undefined ? async () => {
          const setupSnapshot = await bridge!.sample({ ...sampleRequest, include: [...new Set([...(sampleRequest.include ?? []), "scene", "resources"])], resources: [...new Set([...(sampleRequest.resources ?? []), "state", "hud"])] });
          if (setupSnapshot.clock.mode !== "fixed-step") throw new Error("TN_PLAYTEST_COMPLETION_WINDOW_FAILED: pose setup requires fixed-step clock");
          completionWindow = await measureCompletionWindow(completionLabel,
            (mode) => activePage.evaluate((value) => {
              // quality-allow: the page-side bridge is read through a structural type, as the bridge client does in the page.
              const bridge = (globalThis as unknown as { __THREENATIVE_PLAYTEST_BRIDGE__: { _setClockMode(mode: string): unknown } }).__THREENATIVE_PLAYTEST_BRIDGE__;
              return bridge._setClockMode(value);
            }, mode),
            () => activePage.evaluate(async () => {
              // quality-allow: the page-side bridge is read through a structural type, as the bridge client does in the page.
              const bridge = (globalThis as unknown as { __THREENATIVE_PLAYTEST_BRIDGE__: {
                _clockEpoch: number; sample(request: unknown): Promise<{ clock: unknown; runtimeDiagnosticsSeries: unknown }>;
              } }).__THREENATIVE_PLAYTEST_BRIDGE__;
              const epoch = bridge._clockEpoch;
              const snapshot = await bridge.sample({ entities: [], include: ["runtimeDiagnosticsSeries"] });
              return { clock: snapshot.clock, epoch, valid: epoch === bridge._clockEpoch, dropped: 0,
                source: "render-callback-return", timebase: "performance-now-ms", samples: snapshot.runtimeDiagnosticsSeries };
            }), async () => {
              for (const key of inputState.heldKeys) await activePage.keyboard.up(key);
              inputState.heldKeys.clear();
              await setPointerButtons(activePage, inputState, 0);
              await setBrowserPointers(activePage, inputState, [], scenario.viewport);
            });
          completionWindow.setupSnapshot = setupSnapshot;
        } : undefined,
      );
      if (movementBaselineSnapshot === undefined && movementNeedsBaseline && movementEntity !== undefined) {
        const candidate = stepSamples.afterStep ?? stepSamples.afterInput;
        if (entityPosition(candidate, movementEntity) !== undefined) movementBaselineSnapshot = candidate;
      }
      if (capturesMovementSamples && movementCursor !== undefined && stepSamples.afterInput !== undefined) {
        movementSamples.push({
          after: stepSamples.afterInput,
          before: movementCursor,
          inputDriven: stepSamples.inputDriven,
        });
      }
      if (
        capturesMovementSamples
        && stepSamples.afterInput !== undefined
        && stepSamples.afterStep !== undefined
        && stepSamples.afterStep !== stepSamples.afterInput
      ) {
        movementSamples.push({ after: stepSamples.afterStep, before: stepSamples.afterInput, inputDriven: false });
      }
      if (capturesMovementSamples && stepSamples.afterStep !== undefined) {
        movementCursor = stepSamples.afterStep;
      }
      if (step.label === scenario.assert?.framebufferCoverage?.window.endStep) {
        framebufferCoverage = await finishFramebufferCoverageProbe(page, activeConfig.artifactDirectory);
      }
      await establishSceneSubject();
      if (step.label !== undefined && bridge !== undefined) {
        const snapshot = await bridge.sample({ ...sampleRequest, label: step.label });
        if (movementBaselineSnapshot === undefined && movementNeedsBaseline && movementEntity !== undefined
          && entityPosition(snapshot, movementEntity) !== undefined) {
          movementBaselineSnapshot = snapshot;
        }
        const signals = bridge.description.capabilities.includes("runtime.events")
          ? await bridge.drainEvents()
          : [];
        labeledSamples.push({ label: step.label, signals, snapshot });
      }
      const wantsStepTone = step.label !== undefined && scenario.assert?.tone?.some(({ atStep }) => atStep === step.label) === true;
      if (step.screenshot !== undefined) {
        await capturePage(`${safePart(step.screenshot)}.png`, { path: join(activeConfig.artifactDirectory, `${safePart(step.screenshot)}.png`) }, false, step.label);
      } else if (wantsStepTone) {
        await captureVisualPage(`tone-${index}.png`, join(activeConfig.artifactDirectory, `tone-${index}.png`), step.label);
      }
    }
    const afterSnapshot = await sampleAfterTransition(page, bridge, sampleRequest);
    if (afterSnapshot !== undefined && pathEntity !== undefined) {
      const position = entityPosition(afterSnapshot, pathEntity);
      if (position !== undefined) pathPositions.push(position);
    }
    const afterHud = await sampleHud(page, hudAssertions);
    const afterScreenshot = (scenario.artifacts?.screenshots !== false && artifactFrames) || wantsVisual || wantsFinalTone
      ? wantsVisual || wantsFinalTone
        ? await captureVisualPage(
            "after.png",
            scenario.artifacts?.screenshots === false
              ? undefined
              : join(activeConfig.artifactDirectory, "after.png"),
          )
        : await capturePage("after.png", scenario.artifacts?.screenshots === false
          ? {}
          : { path: join(activeConfig.artifactDirectory, "after.png") })
      : undefined;
    const visual = screenshotObservations(
      beforeScreenshot?.image,
      afterScreenshot?.image,
      scenario,
      captureFailure,
      afterScreenshot?.elementRegions,
    );
    if (activeConfig.trace) {
      await context.tracing.stop({ path: join(activeConfig.artifactDirectory, "trace.zip") });
    }
    const deviceMetrics = await options.remoteBrowser?.finish();
    const report = buildReport(
      browserConfig,
      scenario,
      beforeSnapshot,
      afterSnapshot,
      consoleEntries,
      networkEntries,
      accumulatedPathLength(pathPositions),
      pairObservations(beforeHud, afterHud),
      runtimeReady,
      visual,
      labeledSamples,
      framebufferCoverage,
      captureProvenance,
      captureFailure,
      movementSamples,
      setupApplication,
      deviceMetrics,
      movementBaselineSnapshot,
      startupOutcome === undefined
        ? undefined
        : { ...startupOutcome.startup, rule: startupOutcome.rule },
      undefined,
      tone,
    );
    if (cpuWindows.length !== cpuLabels.length) throw new Error("TN_PLAYTEST_CPU_WINDOW_FAILED: missing requested CPU window");
    if (completionWindow !== undefined) {
      report.clock = "wall-clock";
      completionWindow.provenance = { requestedDisplay: completionDisplay!, qualified: false,
        browserArgs: resolveBrowserArguments(browserConfig.browserArgs) };
    }
    report.acquisition = { requestUrls: [...requestUrls], ...(cpuLabels.length === 0 ? {} : { cpuWindows }), ...(completionWindow === undefined ? {} : { completionWindow }) };
    await writeObservationArtifacts(activeConfig.artifactDirectory, scenario.artifacts, {
      console: consoleEntries,
      network: networkEntries,
      runtimeTrace: normalizedRuntimeDiagnostics(afterSnapshot, scenario, consoleEntries),
    });
    observationArtifactsWritten = true;
    await stopCpuProfile(true);
    if (options.remoteBrowser === undefined) await context.close();
    else await page.close();
    return addPreflightDiagnostic(report, preflight);
  } catch (error) {
    // Retain already-collected observations under the existing artifact policy.
    // A failed bridge is never queried here; artifact I/O cannot replace the primary error.
    try {
      if (!observationArtifactsWritten) await writeObservationArtifacts(activeConfig.artifactDirectory, scenario.artifacts, {
        console: consoleEntries,
        network: networkEntries,
        runtimeTrace: normalizedRuntimeDiagnostics(undefined, scenario, consoleEntries),
      });
    } catch (artifactError) {
      try {
        process.stderr.write(`${JSON.stringify({ failureArtifactError: String(artifactError) })}\n`);
      } catch { /* Preserve the primary failure if diagnostic logging also fails. */ }
    }
    if (error instanceof PlaytestBridgeError || error instanceof ManagedServerError) {
      return addPreflightDiagnostic(failureReport(activeConfig, scenario, withPageCause(error.diagnostic, consoleEntries)), preflight);
    }
    const lifecycleDiagnostic = pageLifecycleDiagnostic(error, pageLifecycle, activeConfig.url);
    if (lifecycleDiagnostic !== undefined) {
      return addPreflightDiagnostic(failureReport(activeConfig, scenario, lifecycleDiagnostic), preflight);
    }
    throw error;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await stopCpuProfile(false);
    await teardown();
    // Signal and normal/error teardown share the same idempotent owner-handle release.
    await releaseOwnedResources();
  }
}

export async function runStandalonePlaytests(
  config: IStandalonePlaytestConfig,
): Promise<readonly IStandalonePlaytestReport[]> {
  const scenarioPaths = config.scenarioPaths ?? [config.scenarioPath];
  if (scenarioPaths.length <= 1) {
    return [await runStandalonePlaytestInternal({ ...config, scenarioPath: scenarioPaths[0]! })];
  }
  if (config.server === undefined) {
    const reports: IStandalonePlaytestReport[] = [];
    for (const [index, scenarioPath] of scenarioPaths.entries()) {
      reports.push(await runStandalonePlaytestInternal({
        ...config,
        artifactDirectory: batchArtifactDirectory(config.artifactDirectory, scenarioPath, index),
        scenarioPath,
        scenarioPaths: undefined,
      }));
    }
    return reports;
  }

  const usesFreePort = config.port === 0;
  const activeConfig = usesFreePort ? await resolveManagedServerConfig(config) : config;
  const scenarios = [] as IPlaytestScenario[];
  for (const scenarioPath of scenarioPaths) {
    scenarios.push(withPerformanceBudget(
      await loadPlaytestScenario(activeConfig.projectPath, scenarioPath),
      activeConfig.performanceBudget,
    ));
  }
  let server: ChildProcess | undefined;
  try {
    if (!usesFreePort) await assertManagedUrlAvailable(activeConfig.url);
    server = startManagedServer(activeConfig, usesFreePort ? activeConfig.port : undefined);
    await waitForUrl(activeConfig.url, activeConfig.server?.timeoutMs ?? activeConfig.timeoutMs, server);
    const reports: IStandalonePlaytestReport[] = [];
    for (const [index, scenarioPath] of scenarioPaths.entries()) {
      const report = await runStandalonePlaytestInternal({
        ...activeConfig,
        artifactDirectory: batchArtifactDirectory(activeConfig.artifactDirectory, scenarioPath, index),
        scenarioPath,
        scenarioPaths: undefined,
      }, { managedServer: server });
      reports.push(report);
      // A batch prints one JSON document at the end, and a CI log viewer truncates it — a run of
      // sixteen scenarios reported `"pass": false` with only the first scenario's report readable,
      // so the failing one could not be named at all. One line per scenario, to stderr, as each
      // finishes: the verdict survives truncation and arrives while the run is still going.
      process.stderr.write(`${JSON.stringify(formatScenarioSummary(report))}\n`);
    }
    return reports;
  } catch (error) {
    if (!(error instanceof ManagedServerError)) throw error;
    return scenarios.map((scenario, index) => failureReport({
      ...activeConfig,
      artifactDirectory: batchArtifactDirectory(activeConfig.artifactDirectory, scenarioPaths[index]!, index),
      scenarioPath: scenarioPaths[index]!,
      scenarioPaths: undefined,
    }, scenario, error.diagnostic));
  } finally {
    await stopManagedServer(server);
  }
}

export function batchArtifactDirectory(base: string, scenarioPath: string, index: number): string {
  return join(base, `${String(index + 1).padStart(2, "0")}-${safePart(scenarioPath)}`);
}

export async function resolveManagedServerConfig(
  config: IStandalonePlaytestConfig,
): Promise<IStandalonePlaytestConfig> {
  if (config.server === undefined || config.port !== 0) return config;
  const port = await findFreePort();
  return { ...config, port, url: withPort(config.url, port) };
}

export { openPageAndConnectBridge } from './server.js';
