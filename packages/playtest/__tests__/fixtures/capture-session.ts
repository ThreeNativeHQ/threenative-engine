import type { IStandalonePlaytestConfig } from "../../src/runner/config.js";

interface ICaptureFixtureState {
  events: string[];
  capabilities: string[];
  target: string;
  blank: boolean;
  software: boolean;
  contextHangs: boolean;
  startupConsoleError: boolean;
  consoleListener?: (entry: { type(): string; text(): string }) => void;
  lockError?: Error;
  serverError?: Error;
  startupError?: Error;
  launchOptions?: { headless?: boolean; env?: Record<string, string | undefined>; args?: readonly string[] };
}

export const state: ICaptureFixtureState = {
  target: "web", events: [], capabilities: ["runtime.startup"], blank: false, software: false, contextHangs: false, startupConsoleError: false,
};
export function resetCaptureFixture(): void {
  state.events.length = 0;
  state.target = "web";
  state.capabilities = ["runtime.startup"];
  state.blank = false;
  state.software = false;
  state.contextHangs = false;
  state.startupConsoleError = false;
  delete state.consoleListener;
  delete state.lockError;
  delete state.serverError;
  delete state.startupError;
  delete state.launchOptions;
}
export function captureConfig(directory: string): IStandalonePlaytestConfig {
  return { artifactDirectory: directory, headless: true, port: 0, projectPath: directory,
    scenarioPath: "smoke.playtest.json", server: { command: "test-server", timeoutMs: 100 },
    target: "browser", timeoutMs: 100, trace: false, url: "http://127.0.0.1:5173" };
}
export const chromium = {
  launch: async (options: NonNullable<ICaptureFixtureState["launchOptions"]>) => {
    state.events.push("browser"); state.launchOptions = options;
    return { newContext: async () => {
      if (state.contextHangs) return new Promise<never>(() => undefined);
      return { newPage: async () => ({
        addInitScript: async () => undefined,
        on: (event: string, listener: unknown) => {
          if (event === "console") state.consoleListener = listener as NonNullable<ICaptureFixtureState["consoleListener"]>;
        },
        screenshot: async () => { state.events.push("screenshot"); return Buffer.from("fixture pixels"); },
      }) };
    } };
  },
};
export function assertCaptureNotBlank(): void {
  if (state.blank) throw new Error("TN_CAPTURE_BLANK");
}
export async function loadPlaytestScenario() {
  return { target: state.target, viewport: { width: 640, height: 480 }, warmupFrames: 0, steps: [{ waitTicks: 1 }] };
}
export const PLAYTEST_STARTUP_READY_TIMEOUT_MS = 100;
export const WEBGPU_BROWSER_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];
export function resolveBrowserArguments(args: readonly string[] | undefined): string[] { return [...(args ?? [])]; }
export function softwareAdapterName(adapter: Readonly<Record<string, string>>): string | undefined {
  return Object.values(adapter).find((value) => /swiftshader/i.test(value));
}
export async function openRunnerPage() {
  if (state.startupConsoleError) {
    state.events.push("startup-console-error");
    state.consoleListener?.({ type: () => "error", text: () => "startup compile error, later recovered" });
    state.consoleListener?.({ type: () => "assert", text: () => "startup assertion failed" });
    state.startupConsoleError = false;
  }
  return { description: { capabilities: state.capabilities } };
}
export async function teardownBrowserSession(_page: unknown, _context: unknown, browser: unknown, launch: Promise<unknown> | undefined): Promise<void> {
  if (browser !== undefined || launch !== undefined) state.events.push("close-browser");
}
export function playwrightProfileDirectories(): readonly string[] { return []; }
export function removeStrandedProfiles(): readonly string[] { state.events.push("profiles"); return []; }
export async function acquireRunnerCaptureLock() {
  state.events.push("lock");
  if (state.lockError !== undefined) throw state.lockError;
  return { release: async () => { state.events.push("release-lock"); } };
}
export async function provideRunDisplay() {
  state.events.push("display");
  return { env: { DISPLAY: ":123" }, strategy: { kind: "private-xvfb" },
    release: async () => { state.events.push("release-display"); } };
}
export async function assertManagedUrlAvailable(): Promise<void> { state.events.push("available"); }
export async function findFreePort(): Promise<number> { return 12345; }
export function withPort(url: string, port: number): string { const parsed = new URL(url); parsed.port = String(port); return parsed.toString(); }
export function startManagedServer(): object { state.events.push("server"); return {}; }
export async function stopManagedServer(server: unknown): Promise<void> { if (server !== undefined) state.events.push("stop-server"); }
export async function waitForUrl(): Promise<void> { state.events.push("server-ready"); if (state.serverError !== undefined) throw state.serverError; }
export async function waitForStartupReady() {
  state.events.push("startup");
  if (state.startupError !== undefined) throw state.startupError;
  return { rule: "sustained-frames", startup: { phase: "ready" } };
}
export async function waitFrames(): Promise<void> { state.events.push("warmup"); }
export async function readCaptureProvenance() {
  state.events.push("provenance");
  return { adapter: { description: state.software ? "SwiftShader" : "hardware fixture" },
    rendererKind: "webgpu", browserArgs: WEBGPU_BROWSER_ARGS, captureMethod: "page.screenshot",
    target: "web", viewport: { width: 640, height: 480 } };
}
