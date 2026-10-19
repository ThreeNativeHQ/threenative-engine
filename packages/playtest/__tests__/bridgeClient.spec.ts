import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "vitest";

import { parseStandalonePlaytestArgs } from "../src/runner/config.js";
import { initStandalonePlaytest } from "../src/runner/init.js";
import {
  connectPlaytestBridgeTransport,
  advanceTimeoutMs,
  bridgeWaitTimeoutMs,
  type IBridgeTransport,
} from "../src/runner/bridgeClient.js";
import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  type IPlaytestBridgeDescription,
} from "../src/protocol.js";
import type { IPlaytestScenario } from "../src/scenario.js";

test("standalone args support existing-server and managed-server flows", () => {
  const existing = parseStandalonePlaytestArgs(["playtests/move.json", "--url", "http://localhost:4173"], "/project");
  expect(existing.scenarioPath).toBe("playtests/move.json");
  expect(existing.url).toBe("http://localhost:4173");
  expect(existing.server).toBe(undefined);

  const managed = parseStandalonePlaytestArgs([
    "--scenario", "playtests/move.json",
    "--server-command", "pnpm dev",
    "--server-timeout", "20000",
  ], "/project");
  expect(managed.server?.command).toBe("pnpm dev");
  expect(managed.server?.timeoutMs).toBe(20_000);
});

test("scenario flags accumulate and expand a project glob in sorted order", async () => {
  const projectPath = await makeTempDir("playtest-scenarios-");
  await mkdir(join(projectPath, "playtests"));
  await writeFile(join(projectPath, "playtests/b.playtest.json"), "{}");
  await writeFile(join(projectPath, "playtests/a.playtest.json"), "{}");
  await writeFile(join(projectPath, "playtests/terminal-menu.playtest.json"), "{}");

  const repeated = parseStandalonePlaytestArgs([
    "--scenario", "first.playtest.json",
    "--scenario", "second.playtest.json",
  ], projectPath);
  expect(repeated.scenarioPaths).toEqual(["first.playtest.json", "second.playtest.json"]);

  const glob = parseStandalonePlaytestArgs(["--scenario", "playtests/*.playtest.json"], projectPath);
  expect(glob.scenarioPaths).toEqual([
    "playtests/a.playtest.json",
    "playtests/b.playtest.json",
    "playtests/terminal-menu.playtest.json",
  ]);

  const hyphenatedGlob = parseStandalonePlaytestArgs(
    ["--scenario", "playtests/terminal-*.playtest.json"],
    projectPath,
  );
  expect(hyphenatedGlob.scenarioPaths).toEqual(["playtests/terminal-menu.playtest.json"]);
});

test("a scenario glob that matches nothing fails closed", async () => {
  const projectPath = await makeTempDir("playtest-empty-glob-");
  expect(() => parseStandalonePlaytestArgs(["--scenario", "playtests/*.playtest.json"], projectPath))
    .toThrow(/matched no files/u);
});

test("a managed server without an explicit URL or port requests a free port", () => {
  const config = parseStandalonePlaytestArgs([
    "--scenario", "playtests/move.playtest.json",
    "--server-command", "pnpm dev --port $PORT",
  ], "/project");

  expect(config.port).toBe(0);
});

test("an explicit port is applied when the URL omits its port", () => {
  const config = parseStandalonePlaytestArgs([
    "--scenario", "playtests/move.playtest.json",
    "--port", "4321",
    "--url", "http://127.0.0.1",
    "--server-command", "pnpm dev --port $PORT",
  ], "/project");

  expect(config.port).toBe(4_321);
  expect(config.url).toBe("http://127.0.0.1:4321");
});

test("device args select Android and preserve an explicit endpoint", () => {
  const config = parseStandalonePlaytestArgs([
    "playtests/move.json",
    "--target", "android",
    "--endpoint", "http://127.0.0.1:43123/playtest",
    "--device", "emulator-5554",
  ], "/project");

  expect(config.target).toBe("android");
  expect(config.endpoint).toBe("http://127.0.0.1:43123/playtest");
  expect(config.device).toBe("emulator-5554");
});

test("device args preserve an explicit Android user", () => {
  const config = parseStandalonePlaytestArgs([
    "playtests/move.json",
    "--target", "android",
    "--user", "10",
  ], "/project");

  expect(config.android?.user).toBe("10");
  expect(() => parseStandalonePlaytestArgs([
    "playtests/move.json",
    "--target", "android",
    "--user", "current",
  ], "/project")).toThrow(/Android --user must be numeric/u);
});

test("device args select iOS simulator or physical devicectl transport", () => {
  const simulator = parseStandalonePlaytestArgs([
    "scenario.json", "--target", "ios", "--app", "build/ThreeNative.app",
    "--bundle-id", "dev.example.game", "--device", "SIM-123",
  ], "/project");
  expect(simulator.target).toBe("ios");
  expect(simulator.ios).toEqual({
    appPath: "/project/build/ThreeNative.app",
    bundleId: "dev.example.game",
    transport: "simulator",
  });
  expect(simulator.device).toBe("SIM-123");

  const physical = parseStandalonePlaytestArgs([
    "scenario.json", "--target", "ios", "--app", "game.app", "--ios-transport", "device",
  ], "/project");
  expect(physical.ios?.transport).toBe("device");
});

test("browser args are repeatable and absent when unused", () => {
  // A WebGPU target needs several chromium flags at once, so one flag per
  // occurrence rather than a delimited string.
  const withArgs = parseStandalonePlaytestArgs([
    "--scenario", "playtests/move.json",
    "--browser-arg", "--enable-unsafe-webgpu",
    "--browser-arg", "--enable-features=Vulkan",
  ], "/project");
  expect(withArgs.browserArgs).toEqual(["--enable-unsafe-webgpu", "--enable-features=Vulkan"]);

  expect(parseStandalonePlaytestArgs(["playtests/move.json"], "/project").browserArgs).toBe(undefined);
});

test("the WebGPU browser recipe expands to the sealed Chromium flags", () => {
  expect(
    parseStandalonePlaytestArgs(["playtests/move.json", "--browser-recipe", "webgpu"], "/project")
      .browserArgs,
  ).toEqual([
    "--ozone-platform=x11",
    "--enable-unsafe-webgpu",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    ...(process.env.TN_PLAYTEST_HOST_DISPLAY === "1"
      ? ["--use-angle=vulkan", "--use-vulkan", "--disable-vulkan-surface"]
      : []),
  ]);
  expect(() =>
    parseStandalonePlaytestArgs(["playtests/move.json", "--browser-recipe", "unknown"], "/project"),
  ).toThrow(/Unknown browser recipe/);
});

test("a browser arg with no value fails instead of swallowing the next flag", () => {
  // `--browser-arg --headed` would otherwise consume `--headed` as the value and
  // silently drop the mode the author asked for.
  expect(
    () => parseStandalonePlaytestArgs(["playtests/move.json", "--browser-arg", "--headed"], "/project"),
  ).toThrow(/requires a value/u);
});

test("a value-taking flag cannot swallow the next playtest flag", () => {
  expect(() => parseStandalonePlaytestArgs(["--scenario", "--url", "http://127.0.0.1:5173"], "/project"))
    .toThrow(/Flag '--scenario' requires a value/u);
});

test("unknown flags fail as CLI usage instead of being ignored", () => {
  expect(() => parseStandalonePlaytestArgs(["playtests/move.json", "--future-flag"], "/project"))
    .toThrow(/Unknown flag '--future-flag'/u);
});

test("standalone args fail with a concrete first command", () => {
  expect(
    () => parseStandalonePlaytestArgs([], "/project"),
  ).toThrow(/threenative-playtest --scenario/);
});

test.each([
  ["an unknown target", ["playtests/move.json", "--target", "tvos"], /Unknown target 'tvos'/u],
  ["a port that conflicts with the URL port", ["playtests/move.json", "--url", "http://127.0.0.1:5173", "--port", "4000"], /conflicts with the port in --url \(5173\)/u],
  ["an unknown iOS transport", ["playtests/move.json", "--ios-transport", "usb"], /Unknown iOS transport 'usb'/u],
  ["a browser recipe with a browser arg", ["playtests/move.json", "--browser-recipe", "webgpu", "--browser-arg", "--enable-unsafe-webgpu"], /Choose --browser-recipe or --browser-arg, not both/u],
  ["a judge marker URL that does not parse", ["playtests/move.json", "--judge-marker-url", "not a url"], /--judge-marker-url must be a canonical/u],
  ["a judge marker URL with a query", ["playtests/move.json", "--judge-marker-url", "http://127.0.0.1:4000/first-frame?run=1"], /--judge-marker-url must be a canonical/u],
  ["a browser recipe on a device run", ["playtests/move.json", "--device", "emulator-5554", "--browser-recipe", "webgpu"], /cannot honor --browser-recipe/u],
  ["a browser arg on a device run", ["playtests/move.json", "--device", "emulator-5554", "--browser-arg", "--enable-unsafe-webgpu"], /cannot honor --browser-arg/u],
  ["--headed on a device run", ["playtests/move.json", "--device", "emulator-5554", "--headed"], /cannot honor --headed/u],
  ["a touch rotation outside 0 to 3", ["playtests/move.json", "--touch-rotation", "4"], /TN_PLAYTEST_ANDROID_ROTATION_INVALID/u],
  ["a build report without an artifact", ["playtests/move.json", "--build-report", "build.json"], /--build-report on the browser target also needs --artifact/u],
  ["a port outside the TCP range", ["playtests/move.json", "--port", "70000"], /Expected a TCP port from 0 to 65535/u],
  ["a zero timeout", ["playtests/move.json", "--timeout", "0"], /Expected a positive integer, received '0'/u],
])("standalone args refuse %s", (_case, argv, message) => {
  expect(() => parseStandalonePlaytestArgs(argv, "/project")).toThrow(message);
});

test("init creates only config scenario and adapter examples", async () => {
  const projectPath = await makeTempDir("playtest-init-");

  const result = await initStandalonePlaytest(projectPath);

  expect(result.created.sort()).toEqual([
    "playtest.adapter.example.ts",
    "playtest.config.json",
    "playtests/smoke.playtest.json",
  ]);
  const scenario = JSON.parse(await readFile(join(projectPath, "playtests/smoke.playtest.json"), "utf8"));
  expect(scenario.schemaVersion).toBe(1);
  await expect(initStandalonePlaytest(projectPath)).rejects.toThrow(/Refusing to overwrite/);
});

test("routes bulk advance and ordinary bridge calls through their intended timeouts", async () => {
  const calls: Array<{ argument?: unknown; method: string; timeoutMs: number }> = [];
  const description: IPlaytestBridgeDescription = {
    capabilities: [],
    limits: PLAYTEST_PROTOCOL_LIMITS,
    name: "timeout-fixture",
    protocolVersion: PLAYTEST_PROTOCOL_VERSION,
  };
  const transport: IBridgeTransport = {
    capabilities: [],
    async call<T>(method: string, argument?: unknown, timeoutMs?: number): Promise<T> {
      calls.push({
        ...(argument === undefined ? {} : { argument }),
        method,
        timeoutMs: timeoutMs ?? PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs,
      });
      if (method === "describe") return description as T;
      if (method === "ready") return { ready: true } as T;
      if (method === "sample") {
        return { clock: { mode: "fixed-step", tick: 0 } } as T;
      }
      return undefined as T;
    },
    async close(): Promise<void> {},
    async waitForBridge(): Promise<boolean> {
      return true;
    },
  };
  const scenario: IPlaytestScenario = {
    artifacts: { screenshots: false },
    name: "timeout wiring",
    schemaVersion: 1,
    steps: [{ release: true, waitTicks: 1 }],
    target: "web",
    viewport: { height: 180, width: 320 },
    warmupFrames: 0,
  };

  const client = await connectPlaytestBridgeTransport(transport, scenario);
  if (client === undefined) throw new Error("Expected a connected transport.");
  await client.advance(600);
  await client.sample({});
  await client.readiness();

  // The handshake is answered while the page is still booting, so it carries the startup budget;
  // a later readiness poll, a sample and any other round trip stay on the operation budget.
  expect(calls).toEqual([
    { method: "describe", timeoutMs: bridgeWaitTimeoutMs() },
    { method: "ready", timeoutMs: bridgeWaitTimeoutMs() },
    { argument: 600, method: "advance", timeoutMs: advanceTimeoutMs(600) },
    { argument: {}, method: "sample", timeoutMs: PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs },
    { method: "ready", timeoutMs: PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs },
  ]);
});


test("startTick alone requires the fixed-step provider during the handshake", async () => {
  const description: IPlaytestBridgeDescription = {
    capabilities: [], limits: PLAYTEST_PROTOCOL_LIMITS, name: "anchor", protocolVersion: PLAYTEST_PROTOCOL_VERSION,
  };
  const transport: IBridgeTransport = {
    capabilities: [],
    call: async <T>(method: string) => (method === "describe" ? description : { ready: true }) as T,
    close: async () => undefined,
    waitForBridge: async () => true,
  };
  const scenario: IPlaytestScenario = {
    artifacts: { screenshots: false }, name: "anchor", schemaVersion: 1, startTick: 0,
    steps: [{ release: true, waitFrames: 1 }], target: "web", viewport: { height: 180, width: 320 }, warmupFrames: 0,
  };
  await expect(connectPlaytestBridgeTransport(transport, scenario)).rejects.toThrow("runtime.fixedStep");
  description.capabilities = ["runtime.fixedStep"];
  await expect(connectPlaytestBridgeTransport(transport, scenario)).resolves.toBeDefined();
});
