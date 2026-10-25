import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import {
  playtestDiagnostic,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestScenario,
} from "../index.js";
import { connectPlaytestBridge, PlaytestBridgeError, type IPlaytestBridgeClient } from "./bridgeClient.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import { networkEmulation } from "./network.js";
import { managedServerError } from "./shared.js";
import type { Page } from "playwright";

export function startManagedServer(config: IStandalonePlaytestConfig, dynamicPort?: number): ChildProcess {
  const port = dynamicPort ?? managedPort(config);
  return spawn(resolveManagedServerCommand(config, dynamicPort), {
    cwd: resolve(config.server!.cwd ?? config.projectPath),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...(port === undefined ? {} : { PORT: String(port) }),
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function resolveManagedServerCommand(
  config: IStandalonePlaytestConfig,
  dynamicPort?: number,
): string {
  const port = dynamicPort ?? managedPort(config);
  return port === undefined ? config.server!.command : substituteManagedPort(config.server!.command, port);
}

export function substituteManagedPort(command: string, port: number): string {
  return command
    .replace(/(?:\$\{PORT\}|\$PORT\b)/gu, String(port))
    .replace(/(--port(?:=|\s+))(?=--|$)/u, `$1${port} `);
}

export async function findFreePort(): Promise<number> {
  const probe = createServer();
  return new Promise<number>((resolvePort, reject) => {
    const rejectProbe = (error: Error): void => {
      probe.close();
      reject(error);
    };
    probe.once("error", rejectProbe);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        rejectProbe(new Error("Could not determine the free managed server port."));
        return;
      }
      probe.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

export function managedPort(config: IStandalonePlaytestConfig): number | undefined {
  if (config.port !== undefined && config.port > 0) return config.port;
  try {
    const parsed = new URL(config.url);
    return parsed.port === "" ? undefined : Number(parsed.port);
  } catch {
    return undefined;
  }
}

export function withPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  const result = parsed.toString();
  return url.endsWith("/") ? result : result.replace(/\/$/u, "");
}

/**
 * A dev server can reload the page out from under the handshake — Vite issues a full reload
 * when it discovers a dependency it has not pre-bundled, which is common on the first load
 * after a server was killed mid-write. Playwright reports that as "Execution context was
 * destroyed", and it used to escape as the runner's unexplained-error catch-all.
 */
export const PAGE_NAVIGATED_PATTERN =
  /Execution context was destroyed|frame (?:was )?detached|Target (?:page|closed)/iu;

export const TEARDOWN_TIMED_OUT = Symbol("teardown-timed-out");

/**
 * Await one teardown step, but never longer than `timeoutMs`. Returns true when the step
 * finished (or there was nothing to do) and false when it ran out of time, so the caller can
 * escalate. Teardown runs after the report is written, so a step that hangs costs the process
 * its exit rather than costing the run its result.
 */
export async function boundedTeardownStep(
  step: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (step === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TEARDOWN_TIMED_OUT>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(TEARDOWN_TIMED_OUT), timeoutMs);
  });
  try {
    return (await Promise.race([step.catch(() => undefined), timeout])) !== TEARDOWN_TIMED_OUT;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Await a resource that is still being created, but never longer than `timeoutMs`. Returns the
 * value when it arrives and `undefined` when it fails or runs out of time.
 *
 * Teardown needs this because a signal can land while the resource is mid-construction: the
 * variable holding it is still unassigned, so closing "whatever we have" closes nothing and the
 * process exits over the top of a live child. Waiting for the in-flight value first is what makes
 * the close reach it.
 */
export async function settledTeardownValue<T>(
  pending: Promise<T> | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  if (pending === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TEARDOWN_TIMED_OUT>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(TEARDOWN_TIMED_OUT), timeoutMs);
  });
  try {
    const settled = await Promise.race([pending.catch(() => undefined), timeout]);
    return settled === TEARDOWN_TIMED_OUT ? undefined : settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function isPageNavigatedRace(error: unknown): boolean {
  return error instanceof Error && PAGE_NAVIGATED_PATTERN.test(error.message);
}

export interface IPageLifecycle {
  closed: boolean;
  crashed: boolean;
  /** Every main-frame navigation, including the run's own initial one. */
  frameNavigations: string[];
  /** Main-frame navigations after the handshake settled — the ones that break a run. */
  navigations: string[];
  settled: boolean;
  /** The last console lines before the failure, which is where a device loss announces itself. */
  tail: string[];
}

/**
 * Playwright reports a crashed renderer and a navigated document with the same
 * "Execution context was destroyed" message, and the two have opposite fixes: a crash is an
 * environment or content problem, a navigation is the page moving under the run. The listeners
 * on the page record which one happened, so the report names it rather than falling through to
 * the unexplained-error catch-all. Returns undefined when the error is neither, leaving it to
 * propagate untouched.
 */
export function pageLifecycleDiagnostic(
  error: unknown,
  lifecycle: IPageLifecycle,
  url: string,
): IPlaytestProtocolDiagnostic | undefined {
  if (!lifecycle.crashed && !isPageNavigatedRace(error)) return undefined;
  const detail = error instanceof Error ? error.message : String(error);
  if (lifecycle.crashed) {
    return playtestDiagnostic(
      "TN_PLAYTEST_PAGE_CRASHED",
      `The browser page crashed while the scenario was running at '${url}'; runner error: ${detail}.`,
      "The renderer process died mid-run, so no assertion after that point was observed. Re-run with a smaller scene or a hardware GPU; under a virtual display the software WebGPU path is the usual cause.",
    );
  }
  const observed = [
    `page closed: ${lifecycle.closed}`,
    `main-frame navigations: ${lifecycle.frameNavigations.length}`,
    ...(lifecycle.tail.length === 0 ? [] : [`last console: ${lifecycle.tail.join(" | ")}`]),
  ].join("; ");
  // A closed page is not a navigated one. Playwright reports a browser or renderer that went away
  // with the same "Target page, context or browser has been closed" wording, and a renderer killed
  // by a GPU stall or an out-of-memory kill never navigates anything — so this used to report a
  // navigation the lifecycle listeners had already proven did not happen, with a fix aimed at the
  // game ("remove the navigation from the game") for a machine failure. One production profile hit
  // it at 18.8 s of a 60 s window: `page closed: true; main-frame navigations: 1`, the one being the
  // run's own. The same false reading cost the suite its expected transport diagnostics once
  // (`docs/verification/runtime-perf-state.md`, e2e-runner.spec.ts).
  if (lifecycle.closed && lifecycle.navigations.length === 0) {
    return playtestDiagnostic(
      "TN_PLAYTEST_PAGE_CLOSED",
      `The page went away without navigating while the scenario was running at '${url}'; runner error: ${detail}. Observed: ${observed}.`,
      "Nothing moved the document: the page closed mid-run, so every observation after that point is missing. This is the machine rather than the game — check for a GPU stall, an out-of-memory kill, or another browser benchmark competing for the display, then re-run. Nothing in the scenario can fix it.",
    );
  }
  // A renderer that goes away raises neither event. Playwright destroys the execution context the
  // same way for a dead renderer and a moved document, and a software rasteriser losing its device
  // mid-frame (run 36821800527, `template-nonvisual (starter, 2/3)`: one 2649.9 ms frame at 4.6 s
  // uptime, then `page closed: false` and one main-frame navigation — the run's own) produced the
  // navigation reading, whose fix is aimed at the game. Nothing moved the document and nothing
  // closed the page, so the report says what was observed.
  //
  // It then stops there, deliberately. The absence of both events says how the page died, not why:
  // a software adapter running a hardware-tier look is the same observation as an out-of-memory
  // kill, and the last line of the console tail usually separates them. Blaming the machine alone
  // sent this exact reading back for a re-run that the look would have fixed.
  if (!lifecycle.closed && lifecycle.navigations.length === 0) {
    return playtestDiagnostic(
      "TN_PLAYTEST_PAGE_CRASHED",
      `The renderer went away without navigating or closing while the scenario was running at '${url}'; runner error: ${detail}. Observed: ${observed}.`,
      "Nothing moved the document and nothing closed the page, so Playwright destroyed the execution context because the renderer itself is gone, and every observation after that point is missing. The events say how the page died, not why: read the console tail above for the last frame cost or device-loss line. A frame that cost seconds on a software adapter is what a hardware look costs there — check the adapter and the tier the run reported before re-running, and check for a GPU stall, a lost or out-of-memory device, or another browser benchmark competing for the display. No scenario step can fix this.",
    );
  }
  const where = lifecycle.navigations.length === 0
    ? "an unrecorded location"
    : `'${lifecycle.navigations.join("', '")}'`;
  return playtestDiagnostic(
    "TN_PLAYTEST_PAGE_NAVIGATED",
    `The page navigated to ${where} while the scenario was running at '${url}'; runner error: ${detail}. Observed: ${observed}.`,
    "Something moved the document after the run started, so the observations after that point are from a different page. Remove the navigation from the game, or point --url at a server that does not reload itself mid-run.",
  );
}

/**
 * Navigate and complete the bridge handshake, re-navigating when the page reloads itself
 * before the handshake finishes. This never retries past the handshake: no observation has
 * been taken and no assertion has been evaluated yet, so a reattempt cannot hide a failure.
 * A bridge that is genuinely missing or incompatible still fails on its own diagnostic, and
 * an exhausted retry budget fails closed on TN_PLAYTEST_PAGE_NAVIGATED rather than passing.
 */
/** Live CDP sessions by page: the throttle belongs to a session, so something must hold it. */
const throttledPages = new WeakMap<Page, unknown>();

/**
 * Apply the scenario's browser-only network profile before navigation.
 *
 * CDP takes bytes per second; a plan is read in kilobits, so one conversion happens here. A
 * session that cannot be created fails the run: a scenario that asked to be throttled must never
 * report numbers from an unthrottled page.
 */
async function applyNetworkProfile(page: Page, scenario: IPlaytestScenario): Promise<void> {
  const profile = scenario.network;
  if (profile === undefined) return;
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", networkEmulation(profile));
  throttledPages.set(page, session);
}

export async function openPageAndConnectBridge(
  page: Page,
  config: IStandalonePlaytestConfig,
  scenario: IPlaytestScenario,
): Promise<IPlaytestBridgeClient | undefined> {
  await applyNetworkProfile(page, scenario);
  const attempts = 3;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(config.url, { timeout: config.timeoutMs, waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: config.timeoutMs }).catch(() => undefined);
      // A forced boot-failure scenario deliberately stops before the runtime bridge can install;
      // the browser DOM and screenshot assertions still run against the rendered failure surface.
      if (scenario.bootFailure !== undefined) return undefined;
      return await connectPlaytestBridge(page, scenario, config.timeoutMs);
    } catch (error) {
      if (error instanceof PlaytestBridgeError || !isPageNavigatedRace(error)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new PlaytestBridgeError(playtestDiagnostic(
    "TN_PLAYTEST_PAGE_NAVIGATED",
    `The page navigated during the bridge handshake on all ${attempts} attempts at '${config.url}'; last runner error: ${lastError?.message ?? "unknown"}.`,
    "The served page is reloading itself while the run starts. With a Vite dev server this is usually dependency pre-bundling: run the project's build or dev command once before the scenario so the dependency cache is warm, or point --url at a preview server instead.",
    { nextCommand: config.server?.command },
  ));
}

export async function assertManagedUrlAvailable(url: string): Promise<void> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(500) });
    await response.body?.cancel();
  } catch {
    return;
  }
  throw managedServerError("Managed server URL is already in use before startup.", url, 0, []);
}

export async function waitForUrl(url: string, timeoutMs: number, server: ChildProcess): Promise<void> {
  const started = Date.now();
  const output: string[] = [];
  server.stdout?.on("data", (chunk) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk) => output.push(String(chunk)));
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      throw managedServerError(
        `Managed server exited with code ${server.exitCode}.`,
        url,
        timeoutMs,
        output,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server has not started listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw managedServerError(`Managed server did not become ready within ${timeoutMs}ms.`, url, timeoutMs, output);
}

export async function stopManagedServer(server: ChildProcess | undefined): Promise<void> {
  if (server?.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = waitForProcessExit(server, 2_000);
  if (process.platform === "win32") server.kill();
  else {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // The process group may have exited between the status check and teardown.
    }
  }
  if (await stopped) return;
  if (process.platform === "win32") server.kill("SIGKILL");
  else {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // The process group may have exited between the timeout and forced teardown.
    }
  }
  await waitForProcessExit(server, 1_000);
}

export function waitForProcessExit(server: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      server.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    server.once("exit", onExit);
  });
}
