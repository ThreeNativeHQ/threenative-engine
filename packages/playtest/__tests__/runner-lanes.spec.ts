import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";
import { runAndroidPlaytest } from "../src/runner/androidRunner.js";
import { PLAYTEST_ASSERTION_REGISTRY } from "../src/assertion-schema.js";
import { runDevicePlaytest, unsupportedAssertion, type IDevicePlaytestDriver } from "../src/runner/deviceRunner.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";
import { DeviceBridgeTransport, androidMailboxPaths } from "../src/runner/deviceTransport.js";
import { runIosPlaytest } from "../src/runner/iosRunner.js";
import { handlePlaytestSignal, runStandalonePlaytest } from "../src/runner/runner.js";
import { connectDevicePlaytestBridge, type IDeviceBridgeInstallation } from "../src/three/device.js";
import {
  failureReport,
  throwIfAborted,
} from "../src/runner/shared.js";
import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  type IPlaytestBridgeV1,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestScenario,
} from "../src/index.js";

const runnerDirectory = fileURLToPath(new URL("../src/runner/", import.meta.url));

async function runnerSource(name: string): Promise<string> {
  return readFile(`${runnerDirectory}${name}`, "utf8");
}

test("runner lane helpers have one implementation", async () => {
  const steps = await runnerSource("steps.ts");
  const android = await runnerSource("deviceRunner.ts");
  const cli = await runnerSource("cli.ts");
  const deviceSignal = await runnerSource("deviceSignal.ts");
  const runner = await runnerSource("runner.ts");
  const ios = await runnerSource("iosRunner.ts");
  const shared = await runnerSource("shared.ts");

  expect(steps).toMatch(/from "\.\/shared\.js"/u);
  expect(android).toMatch(/from "\.\/shared\.js"/u);
  expect(runner).toMatch(/accumulatedPathLength/u);
  expect(android).toMatch(/accumulatedPathLength/u);
  expect(steps).not.toMatch(/function setupRequest\(/u);
  expect(android).not.toMatch(/function setupRequest\(/u);
  expect(android).not.toMatch(/function observedEntityIds\(/u);
  expect(android).not.toMatch(/function observedResourceIds\(/u);
  expect(android).not.toMatch(/function appendPosition\(/u);
  expect(android).not.toMatch(/function accumulatedPathLength\(/u);
  expect(android).not.toMatch(/function safePart\(/u);
  expect(android).not.toMatch(/function failureReport\(/u);
  expect(android).not.toMatch(/Math\.hypot/u);
  expect(cli).toMatch(/safePart/u);
  expect(cli).not.toMatch(/function safePart\(/u);
  expect(shared.match(/function safePart\(/gu)).toHaveLength(1);
  expect(runner).toMatch(/activeConfig\.target \?\? "browser"/u);
  expect(deviceSignal).toMatch(/process\.once\("SIGINT", handleSignal\)/u);
  expect(await runnerSource("androidRunner.ts")).toMatch(/abortSignal:/u);
  expect(ios).toMatch(/withTargetAbortSignal/u);
});

test("a device lane refuses an assertion exactly when the registry does not list that lane", () => {
  // The registry said `tone` was unsupported on android while the android runner ran it, because
  // the runner kept its own eleven `if` blocks. The refusal now reads `supportedOn`, so the two
  // cannot disagree: every kind, on every device lane, is refused if and only if it is unlisted.
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    for (const lane of ["android", "desktop", "ios"] as const) {
      // `diagnostics.noNetworkErrors` is the one lane-specific field of a kind that runs everywhere;
      // device-playtest.spec.ts pins its own refusal.
      const assert = entry.kind === "diagnostics" ? { diagnostics: { noConsoleErrors: true } } : entry.example;
      const scenario = { assert, steps: [] } as unknown as IPlaytestScenario;
      const refusal = unsupportedAssertion(scenario, lane, true, true);
      const listed = entry.supportedOn.includes(lane);
      expect(refusal === undefined, `${entry.kind} on ${lane}: listed=${String(listed)}`).toBe(listed);
      if (refusal !== undefined) {
        expect(refusal.code).toBe("TN_PLAYTEST_UNSUPPORTED_ON_TARGET");
        for (const supported of entry.supportedOn) expect(refusal.fix.instruction).toContain(`--target ${supported}`);
      }
    }
  }
});

test("the android runner file holds the android lane only; the shared flow lives in deviceRunner", async () => {
  const android = await runnerSource("androidRunner.ts");
  const device = await runnerSource("deviceRunner.ts");
  expect(android).toMatch(/export async function runAndroidPlaytest/u);
  expect(android).not.toMatch(/function runDevicePlaytest|function unsupportedAssertion/u);
  expect(device).toMatch(/export async function runDevicePlaytest/u);
  // No hand-written per-assertion refusal survives: the registry loop is the only one.
  expect(device).not.toMatch(/scenario\.assert\?\.(deviceMetrics|visual|hud)\b/u);
});

test("both lanes retake a blank capture through captureWithRetry and nothing else", async () => {
  const runner = await runnerSource("runner.ts");
  const device = await runnerSource("deviceRunner.ts");
  for (const [name, source] of [["runner.ts", runner], ["deviceRunner.ts", device]] as const) {
    expect(source, name).toMatch(/captureWithRetry\(/u);
    expect(source, `${name} must not call retakeWhileBlank directly`).not.toMatch(/retakeWhileBlank\(/u);
  }
});

test("sampling.ts contains sampling concerns only", async () => {
  const sampling = await runnerSource("sampling.ts");

  expect(sampling).not.toMatch(/function startManagedServer\(/u);
  expect(sampling).not.toMatch(/function evaluateCamera\(/u);
  expect(sampling).not.toMatch(/function length\(/u);
  expect(sampling).not.toMatch(/PAGE_NAVIGATED_PATTERN/u);
});

test("browser and device lanes report the same shared path length", async () => {
  const fixture = await readFile(fileURLToPath(new URL("./fixtures/app.html", import.meta.url)), "utf8");
  const browserServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await new Promise<void>((resolve, reject) => {
    browserServer.once("error", reject);
    browserServer.listen(0, "127.0.0.1", resolve);
  });
  const browserAddress = browserServer.address();
  if (browserAddress === null || typeof browserAddress === "string") throw new Error("Browser fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-lanes-distance-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { movement: { pathLength: 0.1 } },
    name: "lane-distance",
    schemaVersion: 1,
    steps: [{ holdTicks: 3, press: "KeyW", release: true }],
    subject: "player",
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));

  const browserReport = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "browser-artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: "browser",
    timeoutMs: 15_000,
    trace: false,
    url: `http://127.0.0.1:${browserAddress.port}?mode=physics`,
  });

  const nativePort = await availablePort();
  const nativeBridge = distanceBridge();
  const host = globalThis as typeof globalThis & {
    __THREENATIVE_NATIVE__?: {
      playtestInput: {
        keyboard(type: string, key: string, code: string): void;
        pointer(type: string, x: number, y: number, buttons: number): void;
      };
    };
  };
  const previousHost = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type) => nativeBridge.setHeld(type === "keydown"),
      pointer: () => undefined,
    },
  };
  const nativeDriver = new DistanceDriver(nativeBridge.bridge);
  try {
    const nativeReport = await runDevicePlaytest({
      artifactDirectory: join(projectPath, "native-artifacts"),
      endpoint: `http://127.0.0.1:${nativePort}/playtest`,
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      target: "android",
      timeoutMs: 15_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, {
      driver: nativeDriver,
      mailboxPaths: androidMailboxPaths("com.example.lane-test"),
      name: "android",
      processName: "com.example.lane-test",
      transport: new DeviceBridgeTransport(`http://127.0.0.1:${nativePort}/playtest`),
    });

    expect(browserReport.pathLength).toBeDefined();
    expect(nativeReport.pathLength).toBe(browserReport.pathLength);
    expect(browserReport.pathLength).toBe(0.15000000000000002);
  } finally {
    if (previousHost === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previousHost;
    await closeServer(browserServer);
  }
});

test("browser and native failure reports expose the same field set", () => {
  const scenario = {
    name: "failure-fields",
    schemaVersion: 1,
    steps: [{ release: true, waitTicks: 1 }],
    subject: "player",
    target: "web",
    viewport: { height: 100, width: 100 },
    warmupFrames: 0,
  } as unknown as IPlaytestScenario;
  const diagnostic = {
    code: "TN_PLAYTEST_BRIDGE_MISSING",
    fix: { instruction: "install the bridge" },
    message: "bridge missing",
    severity: "error",
  } as IPlaytestProtocolDiagnostic;
  const web = failureReport({ artifactDirectory: "/tmp/web", headless: true, url: "http://web" } as IStandalonePlaytestConfig, scenario, diagnostic);
  const android = failureReport({ artifactDirectory: "/tmp/android", endpoint: "http://android", headless: true, url: "http://web" } as IStandalonePlaytestConfig, scenario, diagnostic, "android");

  expect(Object.keys(android).sort()).toEqual(Object.keys(web).sort());
  expect(android.runtime).toBe("native");
  expect(android.target).toBe("android");
  expect(web.diagnosticsPolicy?.noNetworkErrors).toBe(true);
  expect(android.diagnosticsPolicy?.noNetworkErrors).toBe(false);
  expect(android.diagnosticsPolicy?.networkErrorsOptOutReason).toMatch(/no network observer/u);
});

test.each([
  ["browser", "Browser"],
  ["android", "Android"],
  ["desktop", "Desktop"],
  ["ios", "iOS"],
] as const)("abort messages name the %s target", async (target, label) => {
  await expect(throwIfAborted({ abortSignal: AbortSignal.abort(), name: target }))
    .rejects.toThrow(`${label} playtest interrupted by signal.`);
});

test("the public browser signal path reports Browser", async () => {
  const messages: string[] = [];
  await handlePlaytestSignal(
    async () => undefined,
    () => undefined,
    () => undefined,
    "browser",
    (message) => messages.push(message),
  );

  expect(messages).toEqual(["Browser playtest interrupted by signal."]);
});

test("the public Android runner passes its abort signal through the target path", async () => {
  const config = await publicAbortConfig("android");

  await expect(runAndroidPlaytest(config, {
    abortSignal: AbortSignal.abort(),
    driver: {
      captureConsole: async () => [],
      isAlive: async () => true,
      prepare: async () => undefined,
      screenshot: async () => undefined,
      stop: async () => undefined,
    },
    transport: {
      capabilities: [],
      call: async () => undefined,
      close: async () => undefined,
      start: async () => undefined,
      waitForBridge: async () => false,
    } as never,
  })).rejects.toThrow("Android playtest interrupted by signal.");
});

test("the public iOS runner passes its abort signal through the target path", async () => {
  const config = await publicAbortConfig("ios");

  await expect(runIosPlaytest(config, {
    abortSignal: AbortSignal.abort(),
    driver: {
      captureConsole: async () => [],
      isAlive: async () => true,
      prepare: async () => undefined,
      screenshot: async () => undefined,
      stop: async () => undefined,
    },
    transport: {
      capabilities: [],
      call: async () => undefined,
      close: async () => undefined,
      start: async () => undefined,
      waitForBridge: async () => false,
    } as never,
  })).rejects.toThrow("iOS playtest interrupted by signal.");
});

test("an interrupted Android run names Android", async () => {
  const projectPath = await makeTempDir("playtest-runner-lanes-");
  const scenarioPath = `${projectPath}/abort.playtest.json`;
  const scenario = {
    name: "abort",
    schemaVersion: 1,
    target: "web",
    steps: [{ release: true, waitTicks: 1 }],
    viewport: { height: 100, width: 100 },
    warmupFrames: 0,
  };
  await writeFile(scenarioPath, JSON.stringify(scenario));

  const config = {
    artifactDirectory: `${projectPath}/artifacts`,
    endpoint: "http://127.0.0.1:41777/playtest",
    headless: true,
    projectPath,
    scenarioPath,
    target: "android",
    timeoutMs: 1000,
    trace: false,
    url: "http://127.0.0.1:5173",
  } as IStandalonePlaytestConfig;
  const target = {
    abortSignal: AbortSignal.abort(),
    driver: {} as never,
    mailboxPaths: {} as never,
    name: "android" as const,
    processName: "com.example.game",
  };

  await expect(runDevicePlaytest(config, target)).rejects.toThrow("Android playtest interrupted by signal.");
});

async function publicAbortConfig(target: "android" | "ios"): Promise<IStandalonePlaytestConfig> {
  const projectPath = await makeTempDir(`playtest-runner-lanes-${target}-abort-`);
  await writeFile(join(projectPath, "abort.playtest.json"), JSON.stringify({
    name: `${target}-abort`,
    schemaVersion: 1,
    steps: [{ release: true, waitTicks: 1 }],
    target: "web",
    viewport: { height: 100, width: 100 },
    warmupFrames: 0,
  }));
  return {
    ...(target === "ios" ? { ios: { appPath: "/fake/ThreeNative.app", bundleId: "dev.threenative.runtime", transport: "simulator" as const } } : {}),
    artifactDirectory: join(projectPath, "artifacts"),
    endpoint: "http://127.0.0.1:41777/playtest",
    headless: true,
    projectPath,
    scenarioPath: "abort.playtest.json",
    target,
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port available.");
  await closeServer(server);
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function distanceBridge(): { bridge: IPlaytestBridgeV1; setHeld(value: boolean): void } {
  let held = false;
  let tick = 0;
  let z = 0;
  return {
    bridge: {
      advance: async (ticks) => {
        tick += ticks;
        if (held) z += ticks * 0.05;
        return { clock: { mode: "fixed-step", tick }, ticks };
      },
      describe: () => ({
        capabilities: ["entity.observe", "runtime.diagnostics", "runtime.fixedStep"],
        limits: PLAYTEST_PROTOCOL_LIMITS,
        name: "runner-lanes-distance",
        protocolVersion: PLAYTEST_PROTOCOL_VERSION,
      }),
      ready: () => ({ ready: true }),
      sample: () => ({
        clock: { mode: "fixed-step", tick },
        diagnostics: [],
        entities: [{ id: "player", transform: { position: [0, 0, z] }, visible: true }],
        resources: {},
      }),
    },
    setHeld: (value) => { held = value; },
  };
}

class DistanceDriver implements IDevicePlaytestDriver {
  private installation?: IDeviceBridgeInstallation;

  constructor(private readonly bridge: IPlaytestBridgeV1) {}

  async captureConsole(): Promise<Array<{ text: string; type: string }>> {
    return [];
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async prepare(endpoint: string): Promise<void> {
    this.installation = connectDevicePlaytestBridge(this.bridge, endpoint);
  }

  async screenshot(): Promise<void> {}

  async stop(): Promise<void> {
    this.installation?.close();
  }
}
