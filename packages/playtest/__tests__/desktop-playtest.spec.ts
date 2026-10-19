import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  evaluateRichPlaytestAssertions,
  type IPlaytestScenario,
  type IPlaytestBridgeV1,
  type IPlaytestObservationSnapshot,
  type JsonValue,
} from "../src/index.js";
import { assertCaptureNotBlank } from "../src/capture.js";
import { exitCodeForReport, runConfiguredPlaytest } from "../src/runner/cli.js";
import { parseStandalonePlaytestArgs, type IStandalonePlaytestConfig } from "../src/runner/config.js";
import { DesktopPlaytestDriver, LocalDeviceMailbox, desktopConsoleType } from "../src/runner/desktop.js";
import { runDesktopPlaytest } from "../src/runner/desktopRunner.js";
import { DeviceBridgeTransport } from "../src/runner/deviceTransport.js";
import { normalizedRuntimeDiagnostics } from "../src/runner/observationSampling.js";
import type { IDevicePlaytestDriver } from "../src/runner/androidRunner.js";
import type { IPlaytestReport } from "../src/report.js";
import { connectDevicePlaytestBridge, type IDeviceBridgeInstallation } from "../src/three/device.js";

beforeEach(() => {
  vi.stubEnv("TN_PLAYTEST_CLOCK", undefined);
  Reflect.deleteProperty(process.env, "TN_PLAYTEST_CLOCK");
});
afterEach(() => vi.unstubAllEnvs());

test.each([undefined, false])("desktop counted run refuses an inherited clock with liveClock=%s", async (liveClock) => {
  const driverFactory = vi.fn(() => { throw new Error("driver started"); });
  for (const clock of ["wall-clock", "", "unsupported"]) {
    process.env.TN_PLAYTEST_CLOCK = clock;
    await expect(runDesktopPlaytest(
      { ...minimalConfig("desktop"), liveClock },
      { driverFactory },
    )).rejects.toThrow("TN_PLAYTEST_CLOCK: a counted run must not inherit a wall clock; unset TN_PLAYTEST_CLOCK or pass --live-clock.");
    expect(driverFactory).not.toHaveBeenCalled();
  }
});

test("desktop CLI parsing requires and resolves the native executable", () => {
  const config = parseStandalonePlaytestArgs([
    "scenario.json",
    "--project",
    "/project",
    "--target",
    "desktop",
    "--executable",
    ".threenative/build/game",
  ]);

  expect(config.target).toBe("desktop");
  expect(config.desktop).toEqual({ executable: "/project/.threenative/build/game" });
  expect(() => parseStandalonePlaytestArgs(["scenario.json", "--target", "desktop"], "/project"))
    .toThrow("Desktop playtest requires --executable");
});

test("desktop CLI forwards repeated --host-arg to the native host", () => {
  const config = parseStandalonePlaytestArgs([
    "scenario.json",
    "--project",
    "/project",
    "--target",
    "desktop",
    "--executable",
    ".threenative/build/game",
    "--host-arg",
    "run",
    "--host-arg",
    "dist/game.js",
  ]);

  expect(config.desktop).toEqual({
    executable: "/project/.threenative/build/game",
    hostArgs: ["run", "dist/game.js"],
  });
});

test("desktop runner constructs its driver with the configured host arguments", async () => {
  // Watches the construction the runner actually performs. Injecting dependencies.driver
  // would bypass the one line under test, which is why the earlier version of this test
  // could not fail when that line was deleted.
  const constructed: (readonly string[] | undefined)[] = [];
  const driverFactory = (options: { args?: readonly string[] }): IDevicePlaytestDriver => {
    constructed.push(options.args);
    throw new Error("captured");
  };

  await runDesktopPlaytest(
    {
      ...minimalConfig("desktop"),
      desktop: { executable: "/project/game", hostArgs: ["run", "dist/game.js"] },
    },
    { driverFactory },
  ).catch(() => undefined);
  expect(constructed).toEqual([["run", "dist/game.js"]]);

  constructed.length = 0;
  // A host that needs no arguments must still launch, and it must be given an empty list
  // rather than undefined, so the driver spreads nothing instead of skipping the field.
  await runDesktopPlaytest(minimalConfig("desktop"), { driverFactory }).catch(() => undefined);
  expect(constructed).toEqual([[]]);
});

test("desktop runner forwards --cpu-prof to the native host", async () => {
  const constructed: (readonly string[] | undefined)[] = [];
  const driverFactory = (options: { args?: readonly string[] }): IDevicePlaytestDriver => {
    constructed.push(options.args);
    throw new Error("captured");
  };

  await runDesktopPlaytest(
    { ...minimalConfig("desktop"), cpuProfilePath: "/project/out.cpuprofile" },
    { driverFactory },
  ).catch(() => undefined);
  expect(constructed).toEqual([["--cpu-prof=/project/out.cpuprofile"]]);
});

test("desktop runner gives the driver the run's screenshot budget", async () => {
  // A run can pass its 300-frame gate and still need longer than the driver's 5s default to
  // produce one screenshot on a loaded arm64 runner, which then fails
  // TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE. The transport already spends config.timeoutMs.
  const constructed: (number | undefined)[] = [];
  const driverFactory = (options: { screenshotTimeoutMs?: number }): IDevicePlaytestDriver => {
    constructed.push(options.screenshotTimeoutMs);
    throw new Error("captured");
  };

  await runDesktopPlaytest(
    { ...minimalConfig("desktop"), timeoutMs: 30_000 },
    { driverFactory },
  ).catch(() => undefined);

  expect(constructed).toEqual([30_000]);
});

test("desktop CLI routing selects the shared desktop runner", async () => {
  const calls: string[] = [];
  const report = { pass: true } as never;
  const config = minimalConfig("desktop");
  await expect(runConfiguredPlaytest(config, {
    android: async () => { calls.push("android"); return report; },
    browser: async () => { calls.push("browser"); return report; },
    desktop: async (received) => { calls.push(received.desktop?.executable ?? "missing"); return report; },
    ios: async () => { calls.push("ios"); return report; },
  })).resolves.toBe(report);
  expect(calls).toEqual(["/native/game"]);
});

test.each([
  { stream: "stderr", text: 'Gtk-Message: 19:38:01.131: Failed to load module "appmenu-gtk-module"', type: "log" },
  { stream: "stderr", text: "MESA-EGL: warning: DRI3 error: Could not get DRI3 device", type: "warning" },
  // The Mesa EGL loader is a different channel from MESA-EGL; on a DRI3-less headless runner it
  // prints these two lines to stderr, and the CI starter consumer counted them as unclassified
  // errors. The explicit warning prefix keeps them warnings, while a genuine libEGL failure below
  // still has no warning prefix and stays an error.
  { stream: "stderr", text: "libEGL warning: DRI3 error: Could not get DRI3 device", type: "warning" },
  { stream: "stderr", text: "libEGL warning: Ensure your X server supports DRI3 to get accelerated rendering", type: "warning" },
  { stream: "stderr", text: "** (wildwood:4179462): WARNING **: 19:38:01.260: AT-SPI: Could not obtain desktop path or name", type: "warning" },
  // A hosted headless runner has no sound card or accessibility bus. ALSA and AT-SPI name the
  // host, not the game, so they must not be counted as the game's console errors (PRD-366).
  { stream: "stderr", text: "ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default", type: "log" },
  { stream: "stderr", text: "[Audio] Failed to open audio device: ALSA: Couldn't open audio device: No such file or directory", type: "log" },
  { stream: "stderr", text: "(threenative-starter-native:14620): dbind-WARNING **: 22:57:49.500: AT-SPI: Error retrieving accessibility bus address: org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files", type: "warning" },
  { stream: "stderr", text: "Warning: startup gate never opened within 30s; capturing anyway.", type: "warning" },
  { stream: "stderr", text: "MESA-EGL: error: context creation failed", type: "error" },
  { stream: "stderr", text: "libEGL error: eglInitialize failed", type: "error" },
  { stream: "stderr", text: "GPU validation error: warning branch has invalid bindings", type: "error" },
  { stream: "stderr", text: "unclassified native failure", type: "error" },
  { stream: "stdout", text: "[error] Native game startup failed", type: "error" },
  { stream: "stdout", text: "[info] Native game ready", type: "log" },
])("desktop console preserves explicit severity from $stream: $text", async ({ stream, text, type }) => {
  const root = await makeTempDir("playtest-desktop-severity-");
  const driver = new DesktopPlaytestDriver({
    executable: process.execPath,
    mailboxRoot: root,
    args: ["-e", 'process[process.argv[1]].write(process.argv[2] + "\\n" + process.argv[2]);', stream, text],
  });
  try {
    await driver.prepare("unused");
    await expect.poll(() => driver.isAlive()).toBe(false);
    // Both newline-delimited and trailing partial output retain the complete observation.
    expect(await driver.captureConsole()).toEqual([{ text, type }, { text, type }]);
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32").each(["already-exited", "signal-stopped"])("desktop stop drains delayed child stdout after %s", async (mode) => {
  const root = await makeTempDir("playtest-desktop-close-");
  const driver = new DesktopPlaytestDriver({
    executable: process.execPath,
    mailboxRoot: root,
    args: ["-e", `
      const { spawn } = require("node:child_process");
      const finish = () => {
        spawn(process.execPath, ["-e", 'setTimeout(() => process.stdout.write("TN_JS_CPU_PROFILE_TOTAL:10"), 250)'],
          { stdio: ["ignore", 1, 2] }).unref();
        process.exit(0);
      };
      if (${JSON.stringify(mode)} === "already-exited") finish();
      else { process.on("SIGTERM", finish); setInterval(() => {}, 1000); console.log("ready"); }
    `],
  });
  try {
    await driver.prepare("unused");
    if (mode === "already-exited") await expect.poll(() => driver.isAlive()).toBe(false);
    else await expect.poll(async () => (await driver.captureConsole()).some((entry) => entry.text === "ready")).toBe(true);
    await driver.stop();
    expect(await driver.captureConsole()).toContainEqual({ text: "TN_JS_CPU_PROFILE_TOTAL:10", type: "log" });
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test("a classified native warning is recorded but is not a runtime error", async () => {
  const warning = "libEGL warning: DRI3 error: Could not get DRI3 device";
  const fatal = "unclassified native failure";
  const root = await makeTempDir("playtest-desktop-warning-");
  const driver = new DesktopPlaytestDriver({
    executable: process.execPath,
    mailboxRoot: root,
    args: ["-e", `process.stderr.write(${JSON.stringify(warning)} + "\\n" + ${JSON.stringify(fatal)} + "\\n");`],
  });
  try {
    await driver.prepare("unused");
    await expect.poll(() => driver.isAlive()).toBe(false);
    const entries = await driver.captureConsole();
    // The warning is visible in the captured stderr, typed as a warning, and only the genuine
    // unclassified native failure is promoted into the runtime errors.
    expect(entries).toEqual([{ text: warning, type: "warning" }, { text: fatal, type: "error" }]);
    const { recentRuntimeErrors } = normalizedRuntimeDiagnostics(undefined, undefined as never, entries);
    expect(recentRuntimeErrors).toEqual([{ text: fatal, type: "error" }]);
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop process and mailbox lifecycle leaves no child behind", async () => {
  const root = await makeTempDir("playtest-desktop-driver-");
  const executable = join(root, "native-test.mjs");
  const response = join(root, "tn-playtest-response.json");
  await writeFile(executable, `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const responsePath = join(process.env.TN_PLAYTEST_MAILBOX_ROOT, "tn-playtest-response.json");
writeFileSync(responsePath + ".tmp", JSON.stringify({ id: "ready", result: null }));
renameSync(responsePath + ".tmp", responsePath);
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o755);
  const driver = new DesktopPlaytestDriver({ executable, mailboxRoot: root });
  const mailbox = new LocalDeviceMailbox();
  try {
    await mailbox.write(join(root, "probe.txt"), "atomic");
    expect(await mailbox.read(join(root, "probe.txt"))).toBe("atomic");
    await driver.prepare("unused");
    await waitForFile(response);
    expect(JSON.parse(await readFile(response, "utf8"))).toEqual({ id: "ready", result: null });
    expect(await driver.isAlive()).toBe(true);
  } finally {
    await driver.stop();
    expect(await driver.isAlive()).toBe(false);
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop runner drives a real local mailbox process through shared evaluation", async () => {
  const projectPath = await makeTempDir("playtest-desktop-mailbox-");
  const mailboxRoot = join(projectPath, "mailbox");
  const artifactDirectory = join(projectPath, "artifacts");
  const executable = join(projectPath, "native-mailbox.mjs");
  const scenarioPath = join(projectPath, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({
    artifacts: { screenshots: "after" },
    assert: { movement: { entity: "player", minDistance: 2 } },
    name: "desktop-local-mailbox",
    schemaVersion: 1,
    steps: [{ holdFrames: 3, press: "KeyW", release: true }],
    subject: "player",
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  await writeDesktopMailboxExecutable(executable);
  try {
    const report = await runDesktopPlaytest({
      artifactDirectory,
      desktop: { executable },
      endpoint: "http://127.0.0.1:41777/playtest",
      headless: true,
      projectPath,
      scenarioPath,
      target: "desktop",
      timeoutMs: 1_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, { mailboxRoot });

    expect(report.pass).toBe(true);
    expect(report.runtime).toBe("native");
    expect(report.target).toBe("desktop");
    expect(JSON.parse(await readFile(join(mailboxRoot, "desktop-fixture-args.json"), "utf8")))
      .toEqual(["--width", "640", "--height", "360", "--windowed"]);
    expect(report.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: true }));
    if (process.platform === "linux") {
      expect(await readFile(join(mailboxRoot, "desktop-fixture-display.txt"), "utf8")).toMatch(/^:\d+$/u);
    }
    expect(await readFile(join(mailboxRoot, "desktop-fixture-input.txt"), "utf8")).toBe("KeyW");
    const afterPath = join(artifactDirectory, "after.png");
    const after = assertCaptureNotBlank(await readFile(afterPath), afterPath);
    expect(after.distinctColors).toBeGreaterThanOrEqual(8);
    await expect(readFile(join(mailboxRoot, "tn-playtest-screenshot-request.txt"))).rejects.toThrow();
    await expect(readFile(join(mailboxRoot, "tn-playtest-screenshot-request.txt.tmp"))).rejects.toThrow();
    await expect(readFile(join(mailboxRoot, "tn-playtest-request.json"))).rejects.toThrow();
    await expect(readFile(join(mailboxRoot, "tn-playtest-response.json"))).rejects.toThrow();
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop screenshot clears stale and served mailbox requests", async () => {
  const root = await makeTempDir("playtest-desktop-screenshot-");
  const executable = join(root, "native-screenshot.mjs");
  const screenshotPath = join(root, "capture.png");
  const requestPath = join(root, "tn-playtest-screenshot-request.txt");
  await writeFile(requestPath, join(root, "stale-capture.png"));
  await writeFile(`${requestPath}.tmp`, "stale temporary request");
  await writeDesktopMailboxExecutable(executable);
  const driver = new DesktopPlaytestDriver({ executable, mailboxRoot: root });
  try {
    await driver.prepare("unused");
    await waitForFile(join(root, "desktop-fixture-startup.json"));
    const startup = JSON.parse(await readFile(join(root, "desktop-fixture-startup.json"), "utf8"));
    expect(startup).toEqual({ screenshotRequest: false, screenshotRequestTemp: false });

    await driver.screenshot(screenshotPath);
    const stats = assertCaptureNotBlank(await readFile(screenshotPath), screenshotPath);
    expect(stats.distinctColors).toBeGreaterThanOrEqual(8);
    await expect(readFile(requestPath)).rejects.toThrow();
    await expect(readFile(`${requestPath}.tmp`)).rejects.toThrow();
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop prepare surfaces stale screenshot cleanup failures", async () => {
  const root = await makeTempDir("playtest-desktop-cleanup-");
  await mkdir(join(root, "tn-playtest-screenshot-request.txt"));
  const driver = new DesktopPlaytestDriver({ executable: process.execPath, mailboxRoot: root });
  try {
    await expect(driver.prepare("unused")).rejects.toThrow(/EISDIR|is a directory/u);
    expect(await driver.isAlive()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("desktop runner asks for the frame series a performance assertion reads", async () => {
  // The bridge answers only what the request asks for, so a `performance` assertion on a device or
  // desktop target used to evaluate against an empty series and fail as unobserved while the
  // handshake advertised `runtime.performance`. The include list here drifted from the browser
  // runner's; this test fails if it drifts again.
  const projectPath = await makeTempDir("playtest-desktop-performance-");
  const scenarioPath = join(projectPath, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({
    artifacts: { screenshots: false },
    assert: { performance: { minFps: 1 } },
    name: "desktop-performance-scenario",
    schemaVersion: 1,
    steps: [{ waitTicks: 3 }],
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const endpoint = `http://127.0.0.1:${await availablePort()}/playtest`;
  const moving = movingBridge();
  const requests: Array<{ include?: readonly string[] }> = [];
  const describe = moving.bridge.describe;
  const sample = moving.bridge.sample;
  const bridge: IPlaytestBridgeV1 = {
    ...moving.bridge,
    describe: async () => {
      const description = await describe();
      return {
        ...description,
        capabilities: [...description.capabilities, "runtime.performance"],
      };
    },
    sample: async (request) => {
      requests.push(request);
      const snapshot = await sample(request);
      return {
        ...snapshot,
        // Exactly what the native host does: the field is answered only when it was asked for.
        ...(request.include?.includes("runtimeDiagnosticsSeries") === true
          ? {
              runtimeDiagnosticsSeries: [{
                frameMs: 16,
                phases: { hostGap: 1, overlay: 0, render: 10, residual: 4, ui: 0, update: 1 },
              }],
            }
          : {}),
      };
    },
  };
  const driver = new FakeDesktopDriver(bridge);
  const host = globalThis as typeof globalThis & {
    __THREENATIVE_NATIVE__?: { playtestInput: { keyboard(type: string): void; pointer(): void } };
  };
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: { keyboard: (type) => moving.setHeld(type === "keydown"), pointer: () => undefined },
  };
  try {
    const report = await runDesktopPlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      desktop: { executable: "/fake/native-game" },
      endpoint,
      headless: true,
      projectPath,
      scenarioPath,
      target: "desktop",
      timeoutMs: 1_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, { driver, transport: new DeviceBridgeTransport(endpoint) });

    expect(requests.some((request) => request.include?.includes("runtimeDiagnosticsSeries") === true))
      .toBe(true);
    expect(report.observations?.performanceSeries?.length ?? 0).toBeGreaterThan(0);
    const performance = report.assertionResults?.find(({ id }) => id === "performance.minFps");
    expect(performance?.pass).toBe(true);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(host, "__THREENATIVE_NATIVE__");
    else host.__THREENATIVE_NATIVE__ = previous;
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("desktop driver gives the native host the clock the run asked for, and none when it asked for none", async () => {
  // The runner's own `clock` field is a claim about the run. This reads the environment the child
  // process actually receives, which is the only thing the host can read the request from.
  const root = await makeTempDir("playtest-desktop-clock-");
  const observed = async (liveClock: boolean): Promise<string> => {
    const mailbox = join(root, liveClock ? "asked" : "counted");
    const driver = new DesktopPlaytestDriver({
      executable: process.execPath,
      liveClock,
      mailboxRoot: mailbox,
      args: ["-e", `require("node:fs").writeFileSync(process.env.TN_PLAYTEST_MAILBOX_ROOT + "/clock.txt", process.env.TN_PLAYTEST_CLOCK ?? "absent");`],
    });
    try {
      await driver.prepare("unused");
      await expect.poll(() => driver.isAlive()).toBe(false);
      return await readFile(join(mailbox, "clock.txt"), "utf8");
    } finally {
      await driver.stop();
    }
  };
  try {
    expect(await observed(true)).toBe("wall-clock");
    expect(await observed(false)).toBe("absent");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("desktop playtest reuses the device evaluator for positive and negative assertions", async () => {
  const passingRun = await runDesktopScenario(2);
  expect(passingRun.driver.stopped).toBe(true);
  const passing = passingRun.report;
  expect(passing.pass).toBe(true);
  expect(passing.runtime).toBe("native");
  expect(passing.target).toBe("desktop");
  expect(exitCodeForReport(passing)).toBe(0);

  const failingRun = await runDesktopScenario(4);
  expect(failingRun.driver.stopped).toBe(true);
  const failing = failingRun.report;
  expect(failing.pass).toBe(false);
  expect(failing.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: false }));
  expect(exitCodeForReport(failing)).toBe(1);
});

test("desktop runner waits on an asynchronously changing resource", async () => {
  const run = await runDesktopResourceScenario(2, 1_000);

  expect(run.report.pass).toBe(true);
  expect(run.report.assertionResults).toContainEqual(expect.objectContaining({
    id: "resource.state.networkConnected",
    pass: true,
  }));
  expect(run.tick()).toBe(2);
});

test("desktop runner times out a resource wait with the last observation", async () => {
  const run = await runDesktopResourceScenario(Number.POSITIVE_INFINITY, 32);

  expect(run.report.pass).toBe(false);
  expect(run.report.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
    message: expect.stringContaining("last observation false"),
  }));
});

test("desktop playtest surfaces a driver cleanup failure", async () => {
  await expect(runDesktopScenario(2, { stopError: new Error("desktop stop failed") }))
    .rejects.toThrow("desktop stop failed");
});

test("desktop playtest keeps the primary screenshot failure visible when cleanup also fails", async () => {
  // The legacy desktop capture throws before cleanup; the driver's stop then fails too. Both errors
  // must survive, and the primary native-screenshot message must not be hidden by the constant
  // cleanup message (a reader that sees only "cleanup failed" is sent to the wrong layer).
  const screenshotError = new Error(
    "TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE: request timed out; request file consumed",
  );
  const stopError = new Error("desktop stop failed");
  const thrown = await runDesktopScenario(2, { screenshotError, stopError }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as Error).message).toContain(screenshotError.message);
  expect((thrown as AggregateError).errors).toEqual([screenshotError, stopError]);
});

test.skipIf(process.platform === "win32")("desktop runner surfaces mailbox cleanup failures", async () => {
  await expect(runDesktopScenario(2, { mailboxFile: true })).rejects.toThrow(/ENOTDIR|not a directory/u);
});

test("desktop signal before startup prevents driver preparation", async () => {
  let driver: FakeDesktopDriver | undefined;
  const run = runDesktopScenario(2, {
    onDriver: (created) => { driver = created; },
    signalBeforeStart: true,
  });
  await expect(run).rejects.toThrow("Desktop playtest interrupted by signal.");
  expect(driver?.prepareCalls).toBe(0);
  expect(driver?.stopped).toBe(true);
});

test("desktop signal during preparation stops before bridge evaluation continues", async () => {
  let driver: FakeDesktopDriver | undefined;
  const run = runDesktopScenario(2, {
    onDriver: (created) => { driver = created; },
    onPrepare: () => { process.emit("SIGTERM"); },
  });
  await expect(run).rejects.toThrow("Desktop playtest interrupted by signal.");
  expect(driver?.prepareCalls).toBe(1);
  expect(driver?.stopped).toBe(true);
});

test.skipIf(process.platform === "win32")("desktop screenshot timeout fails closed with the host's own words", async () => {
  // A timeout that names only "request timed out" sends the reader to the wrong layer: the host
  // said something, and whether it still sees the request file says which half broke — the file
  // left behind means it never looked, a consumed one means it read the request and the capture
  // never landed. Both readings fail closed under the same prefix.
  const root = await makeTempDir("playtest-desktop-screenshot-");
  const executable = join(root, "native-test.mjs");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    'if (process.argv[2] !== "silent") {',
    '  console.log("[Playtest] mailbox ready");',
    '  console.log("[Screenshot] waiting for request");',
    '  console.log("platform noise the reader does not need");',
    "}",
    'if (process.argv[2] === "error") {',
    '  console.log("[Screenshot] request pending");',
    '  console.log("platform noise the reader does not need");',
    // Untagged, so a tag-only tail drops the one line that says why the frame never came.
    '  console.error("eglInitialize failed: no display");',
    "}",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  await chmod(executable, 0o755);

  const driveTimeout = async (args: string[]): Promise<string> => {
    const driver = new DesktopPlaytestDriver({ executable, args, mailboxRoot: root, screenshotTimeoutMs: 1_000 });
    try {
      await driver.prepare("unused");
      return await driver.screenshot(join(root, "capture.png")).then(
        () => { throw new Error("screenshot unexpectedly resolved"); },
        (error: unknown) => (error as Error).message,
      );
    } finally {
      await driver.stop();
    }
  };

  try {
    const untouched = await driveTimeout([]);
    expect(untouched).toContain("TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE");
    expect(untouched).toContain("request file still present");
    expect(untouched).toContain("[Screenshot] waiting for request");
    expect(untouched).toContain("[Playtest] mailbox ready");
    // The tail is short and tagged: a line the reader cannot act on is not evidence.
    expect(untouched).not.toContain("platform noise the reader does not need");

    // A host that logged nothing still has to name the state it was in, not print an empty tail.
    const mute = await driveTimeout(["silent"]);
    expect(mute).toContain("TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE");
    expect(mute).toContain("request file still present");
    expect(mute).toContain("native host output: none captured");

    // An untagged error is the root cause in most real timeouts (TN_FRAME_NOT_PRESENTED, a lost
    // EGL context), so the tail carries it beside the tagged lines — and still drops the noise.
    const errored = await driveTimeout(["error"]);
    expect(errored).toContain("TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE");
    expect(errored).toContain("[Screenshot] request pending");
    expect(errored).toContain("eglInitialize failed: no display");
    expect(errored).not.toContain("platform noise the reader does not need");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("desktop console artifacts retain profiler output emitted during shutdown", async () => {
  const projectPath = await makeTempDir("playtest-desktop-shutdown-console-");
  const console = [{ text: "game ready", type: "log" }];
  const profile = { text: "TN_JS_CPU_PROFILE_TOTAL:10", type: "log" };
  try {
    await runDesktopScenario(2, {
      projectPath,
      console,
      onDriver(driver) {
        const stop = driver.stop.bind(driver);
        driver.stop = async () => { await stop(); console.push(profile); };
      },
    });
    expect(JSON.parse(await readFile(join(projectPath, "artifacts", "console.json"), "utf8"))).toEqual([...console]);
    expect(console).toContainEqual(profile);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("a failed desktop screenshot still leaves the host console in the artifact directory", async () => {
  // A screenshot that never arrives reports its own tail, but the timing and error lines printed
  // before it were thrown away with the host — TN_FRAME_NOT_PRESENTED with nothing to explain it.
  // The original failure must still be what propagates; the artifact is written beside it.
  const console = [
    { text: "[Playtest] mailbox ready", type: "log" },
    { text: "[Screenshot] request consumed, no png written", type: "log" },
    { text: "TN_FRAME_NOT_PRESENTED (texture=false)", type: "error" },
  ];
  const screenshotError = new Error(
    "TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE: request timed out; request file consumed",
  );
  const projectPath = await makeTempDir("playtest-desktop-console-artifact-");
  try {
    await expect(runDesktopScenario(2, { console, projectPath, screenshotError }))
      .rejects.toThrow(screenshotError.message);
    expect(JSON.parse(await readFile(join(projectPath, "artifacts", "console.json"), "utf8"))).toEqual(console);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

// Arm64 llvmpipe serves endDawnFrame at p50 333ms and max 4.3s, so the host picks the request up
// inside the short wait and then needs far longer than it for the readback and the present. One
// deadline for both phases reported that healthy host as TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE.
test.skipIf(process.platform === "win32")("desktop screenshot outlives the unpicked-request wait", async () => {
  const root = await makeTempDir("playtest-desktop-slow-screenshot-");
  const executable = join(root, "native-test.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { env } from "node:process";
await new Promise(resolve => setTimeout(resolve, 300));
const request = \`\${env.TN_PLAYTEST_MAILBOX_ROOT}/tn-playtest-screenshot-request.txt\`;
setInterval(() => {
  if (!existsSync(request)) return;
  unlinkSync(request);
  setTimeout(() => writeFileSync(env.TN_PLAYTEST_CAPTURE, Buffer.from("${nonBlankPngBase64()}", "base64")), 800);
}, 5);
console.log("fixture ready");
`);
  await chmod(executable, 0o755);
  const driver = new DesktopPlaytestDriver({
    env: { TN_PLAYTEST_CAPTURE: join(root, "capture.png") },
    executable,
    mailboxRoot: root,
    screenshotTimeoutMs: 200,
  });
  try {
    await driver.prepare("unused");
    await expect.poll(async () => (await driver.captureConsole()).some((entry) => entry.text === "fixture ready"))
      .toBe(true);
    await driver.screenshot(join(root, "capture.png"));
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop screenshot timeout can be raised by environment", async () => {
  const previous = process.env.TN_PLAYTEST_NATIVE_SCREENSHOT_TIMEOUT_MS;
  process.env.TN_PLAYTEST_NATIVE_SCREENSHOT_TIMEOUT_MS = "75";
  const root = await makeTempDir("playtest-desktop-screenshot-env-");
  const executable = join(root, "native-test.mjs");
  await writeFile(executable, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  await chmod(executable, 0o755);
  const driver = new DesktopPlaytestDriver({ executable, mailboxRoot: root });
  const started = Date.now();
  try {
    await driver.prepare("unused");
    await expect(driver.screenshot(join(root, "capture.png")))
      .rejects.toThrow("TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    if (previous === undefined) process.env.TN_PLAYTEST_NATIVE_SCREENSHOT_TIMEOUT_MS = undefined;
    else process.env.TN_PLAYTEST_NATIVE_SCREENSHOT_TIMEOUT_MS = previous;
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test("desktop startTick-only alignment follows readiness and warmup, before baseline and input", async () => {
  const events: string[] = [];
  const { report } = await runDesktopScenario(2, { startTick: 10, startupReadyAtTick: 2, events });
  expect(report.pass).toBe(true);
  expect(report.before?.tick).toBe(10);
  expect(report.after?.tick).toBe(13);
  expect(report.frames).toBe(3);
  const ready = events.indexOf("ready:2");
  const aligned = events.indexOf("advance:2:8");
  const baseline = events.indexOf("baseline:10");
  const input = events.indexOf("keydown:10");
  expect(ready).toBeGreaterThan(-1);
  expect(aligned).toBeGreaterThan(ready);
  expect(events.slice(ready + 1, aligned)).toEqual(["sample:2", "sample:2", "sample:2"]);
  expect(baseline).toBeGreaterThan(aligned);
  expect(input).toBeGreaterThan(baseline);
});

interface IDesktopScenarioOptions {
  startTick?: number;
  startupReadyAtTick?: number;
  events?: string[];
  network?: JsonValue;
  assertNetwork?: boolean;
  completion?: { valid: boolean; calls: { method: string; argument: unknown }[] };
  console?: { text: string; type: string }[];
  mailboxFile?: boolean;
  onDriver?: (driver: FakeDesktopDriver) => void;
  onPrepare?: () => void;
  /** A caller-owned root the caller also removes, so its artifacts outlive the run. */
  projectPath?: string;
  screenshots?: "before-after" | "after";
  screenshotError?: Error;
  signalBeforeStart?: boolean;
  stopError?: Error;
}

test("desktop before-after artifacts bracket the measured steps", async () => {
  const { driver, report } = await runDesktopScenario(2, { screenshots: "before-after" });
  expect(report.pass).toBe(true);
  expect(driver.screenshots.map(({ path, tick }) => ({ name: path.split("/").at(-1), tick }))).toEqual([
    { name: "before.png", tick: 0 },
    { name: "after.png", tick: 3 },
  ]);
});

async function runDesktopScenario(minDistance: number, options: IDesktopScenarioOptions = {}) {
  const ownsProjectPath = options.projectPath === undefined;
  const projectPath = options.projectPath ?? await makeTempDir("playtest-desktop-scenario-");
  const scenarioPath = join(projectPath, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({
    artifacts: { screenshots: options.screenshots ?? false },
    assert: { movement: { entity: "player", minDistance }, ...(options.assertNetwork ? { diagnostics: { noNetworkErrors: true } } : {}) },
    ...(options.startTick === undefined ? {} : { startTick: options.startTick }),
    name: "desktop-cross-target-scenario",
    schemaVersion: 1,
    steps: [{
      holdFrames: 3,
      press: "KeyW",
      release: options.completion === undefined,
      ...(options.screenshotError === undefined ? {} : { screenshot: "frame" }),
    }, ...(options.completion === undefined ? [] : [{ kind: "wait", label: "completion-pose", waitTicks: 1000, release: false }])],
    subject: "player",
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: options.startTick === undefined ? 0 : 2,
  }));
  const endpoint = `http://127.0.0.1:${await availablePort()}/playtest`;
  const moving = movingBridge();
  const startupReadyAtTick = options.startupReadyAtTick;
  if (startupReadyAtTick !== undefined) {
    const describeStartup = moving.bridge.describe;
    moving.bridge.describe = async () => ({ ...await describeStartup(), capabilities: [...(await describeStartup()).capabilities, "runtime.startup"] });
    moving.bridge.ready = () => {
      options.events?.push(`ready:${moving.tick()}`);
      return { ready: true, startup: { phase: moving.tick() >= startupReadyAtTick ? "ready" : "collapsing", progress: 1 } };
    };
  }
  const advance = moving.bridge.advance;
  if (advance === undefined) throw new Error("Desktop fixture requires its fixed-step advance provider.");
  moving.bridge.advance = async (ticks) => {
    options.events?.push(`advance:${moving.tick()}:${ticks}`);
    return advance(ticks);
  };
  const sample = moving.bridge.sample;
  moving.bridge.sample = async (request) => {
    options.events?.push(`${request.include?.length === 0 ? "sample" : "baseline"}:${moving.tick()}`);
    return { ...await sample(request), network: (options.network === undefined ? { requests: 0, entries: [] } : options.network) as IPlaytestObservationSnapshot["network"] };
  };
  const describe = moving.bridge.describe;
  moving.bridge.describe = async () => ({ ...await describe(), capabilities: [...(await describe()).capabilities, "runtime.network"] });
  const driver = new FakeDesktopDriver(
    moving.bridge,
    options.stopError,
    options.onPrepare,
    options.screenshotError,
    options.console,
  );
  options.onDriver?.(driver);
  const mailboxRoot = options.mailboxFile ? join(projectPath, "mailbox-root-file") : undefined;
  if (mailboxRoot !== undefined) await writeFile(mailboxRoot, "not a directory");
  const host = globalThis as typeof globalThis & {
    __THREENATIVE_NATIVE__?: { playtestInput: { keyboard(type: string): void; pointer(): void } };
  };
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type) => { options.events?.push(`${type}:${moving.tick()}`); moving.setHeld(type === "keydown"); },
      pointer: () => undefined,
    },
  };
  const transport = new DeviceBridgeTransport(endpoint);
  if (options.completion !== undefined) {
    const original = transport.call.bind(transport);
    transport.call = async <T>(method: string, argument?: unknown): Promise<T> => {
      options.completion!.calls.push({ method, argument });
      if (method === "_setClockMode") return { mode: argument, tick: 3, epoch: 1 } as T;
      if (method === "_presentationCompletions") return { clock: { mode: "wall-clock" }, epoch: 1, valid: options.completion!.valid,
        dropped: 0, source: "present-return", timebase: "steady-clock-ms",
        samples: Array.from({ length: 351 }, (_, i) => ({ sequence: i + 1, completedAtMs: i * 20 })) } as T;
      return original<T>(method, argument);
    };
  }
  try {
    if (options.signalBeforeStart) queueMicrotask(() => process.emit("SIGINT"));
    const report = await runDesktopPlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      desktop: { executable: "/fake/native-game" },
      endpoint,
      headless: true,
      projectPath,
      scenarioPath,
      target: "desktop",
      timeoutMs: 1_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, {
      driver,
      transport,
      ...(mailboxRoot === undefined ? {} : { mailboxRoot }),
    });
    return { driver, report };
  } finally {
    if (previous === undefined) Reflect.deleteProperty(host, "__THREENATIVE_NATIVE__");
    else host.__THREENATIVE_NATIVE__ = previous;
    if (ownsProjectPath) await rm(projectPath, { force: true, recursive: true });
  }
}

async function runDesktopResourceScenario(resourceReadyAtTick: number, timeoutMs: number) {
  const projectPath = await makeTempDir("playtest-desktop-resource-");
  const scenarioPath = join(projectPath, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({
    artifacts: { screenshots: false },
    assert: { resources: [{ changed: true, equals: true, id: "state", path: "networkConnected" }] },
    name: "desktop-resource-wait",
    schemaVersion: 1,
    steps: [{ timeoutMs, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const endpoint = `http://127.0.0.1:${await availablePort()}/playtest`;
  const moving = movingBridge({ resourceReadyAtTick });
  const driver = new FakeDesktopDriver(moving.bridge);
  try {
    const report = await runDesktopPlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      desktop: { executable: "/fake/native-game" },
      endpoint,
      headless: true,
      projectPath,
      scenarioPath,
      target: "desktop",
      timeoutMs: 1_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, {
      driver,
      transport: new DeviceBridgeTransport(endpoint),
    });
    return { report, tick: moving.tick };
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
}

class FakeDesktopDriver implements IDevicePlaytestDriver {
  private installation?: IDeviceBridgeInstallation;
  prepareCalls = 0;
  stopped = false;
  screenshots: Array<{ path: string; tick: number | undefined }> = [];

  constructor(
    private readonly bridge: IPlaytestBridgeV1,
    private readonly stopError?: Error,
    private readonly onPrepare?: () => void,
    private readonly screenshotError?: Error,
    private readonly console: { text: string; type: string }[] = [],
  ) {}

  async captureConsole() { return this.console; }
  async isAlive() { return !this.stopped; }
  async prepare(endpoint: string) {
    this.prepareCalls += 1;
    this.installation = connectDevicePlaytestBridge(this.bridge, endpoint);
    this.onPrepare?.();
  }
  async screenshot(path: string) {
    if (this.screenshotError !== undefined) throw this.screenshotError;
    const snapshot = await this.bridge.sample({});
    this.screenshots.push({ path, tick: snapshot.clock.tick });
    await writeFile(path, Buffer.from(nonBlankPngBase64(), "base64"));
  }
  async stop() {
    this.stopped = true;
    try {
      if (this.stopError !== undefined) throw this.stopError;
    } finally {
      this.installation?.close();
    }
  }
}

function movingBridge(options: { resourceReadyAtTick?: number } = {}): { bridge: IPlaytestBridgeV1; setHeld(value: boolean): void; tick: () => number } {
  const resourceReadyAtTick = options.resourceReadyAtTick;
  let held = false;
  let tick = 0;
  let x = 0;
  const resources = (): Record<string, JsonValue> => resourceReadyAtTick === undefined
    ? {}
    : { state: { networkConnected: tick >= resourceReadyAtTick } };
  return {
    bridge: {
      advance: async (ticks) => {
        tick += ticks;
        if (held) x += ticks;
        return { clock: { mode: "fixed-step", tick }, ticks };
      },
      describe: () => ({
        capabilities: [
          "entity.observe",
          "runtime.diagnostics",
          "runtime.fixedStep",
          "runtime.network",
          ...(resourceReadyAtTick === undefined ? [] : ["runtime.resources"]),
        ],
        limits: PLAYTEST_PROTOCOL_LIMITS,
        name: "desktop-test",
        protocolVersion: PLAYTEST_PROTOCOL_VERSION,
      }),
      ready: () => ({ ready: true }),
      sample: () => ({
        clock: { mode: "fixed-step", tick },
        diagnostics: [],
        network: { requests: 0, entries: [] },
        entities: [{ id: "player", transform: { position: [x, 0, 0] }, visible: true }],
        resources: resources(),
      }),
    },
    setHeld: (value) => { held = value; },
    tick: () => tick,
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port available.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function writeDesktopMailboxExecutable(path: string): Promise<void> {
  const screenshot = nonBlankPngBase64();
  await writeFile(path, `#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.TN_PLAYTEST_MAILBOX_ROOT;
if (typeof root !== "string") process.exit(2);
const requestPath = join(root, "tn-playtest-request.json");
const responsePath = join(root, "tn-playtest-response.json");
const screenshotRequestPath = join(root, "tn-playtest-screenshot-request.txt");
const screenshotBytes = Buffer.from(${JSON.stringify(screenshot)}, "base64");
writeFileSync(join(root, "desktop-fixture-display.txt"), process.env.DISPLAY ?? "");
writeFileSync(join(root, "desktop-fixture-args.json"), JSON.stringify(process.argv.slice(2)));
let held = false;
let x = 0;
let tick = 0;

function writeAtomic(path, contents) {
  const temporary = path + ".tmp";
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function respond(response) {
  writeAtomic(responsePath, JSON.stringify(response));
}

writeFileSync(join(root, "desktop-fixture-startup.json"), JSON.stringify({
  screenshotRequest: existsSync(screenshotRequestPath),
  screenshotRequestTemp: existsSync(screenshotRequestPath + ".tmp"),
}));
respond({ id: "ready", result: null });

function poll() {
  if (existsSync(screenshotRequestPath)) {
    const target = readFileSync(screenshotRequestPath, "utf8");
    unlinkSync(screenshotRequestPath);
    writeFileSync(target, screenshotBytes);
  }
  if (!existsSync(requestPath)) return;
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  unlinkSync(requestPath);
  let result = null;
  if (request.method === "describe") {
    result = {
      capabilities: ["entity.observe", "runtime.diagnostics", "runtime.fixedStep", "runtime.network"],
      limits: { maxEntitiesPerSample: 100, maxEventsPerDrain: 1000, maxPayloadBytes: 1000000, operationTimeoutMs: 5000 },
      name: "desktop-mailbox-fixture",
      protocolVersion: 1,
    };
  } else if (request.method === "ready") {
    result = { ready: true };
  } else if (request.method === "advance") {
    tick += request.argument;
    if (held) x += request.argument;
    result = { clock: { mode: "fixed-step", tick }, ticks: request.argument };
  } else if (request.method === "sample") {
    result = {
      clock: { mode: "fixed-step", tick },
      diagnostics: [],
      network: { requests: 0, entries: [] },
      entities: [{ id: "player", transform: { position: [x, 0, 0] }, visible: true }],
      resources: {},
    };
  } else if (request.method === "input.keyDown") {
    held = true;
    writeFileSync(join(root, "desktop-fixture-input.txt"), request.argument.key);
  } else if (request.method === "input.keyUp") {
    held = false;
  }
  respond({ id: request.id, result });
}

setInterval(poll, 5);
`);
  await chmod(path, 0o755);
}

function nonBlankPngBase64(): string {
  const png = new PNG({ height: 4, width: 4 });
  const colors = [
    [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255],
    [255, 0, 255, 255], [0, 255, 255, 255], [255, 255, 255, 255], [128, 64, 32, 255],
    [32, 64, 128, 255], [64, 128, 32, 255], [192, 32, 64, 255], [32, 192, 64, 255],
    [64, 32, 192, 255], [192, 128, 32, 255], [32, 192, 128, 255], [128, 32, 192, 255],
  ] as const;
  colors.forEach(([red, green, blue, alpha], index) => {
    const offset = index * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = alpha;
  });
  return PNG.sync.write(png).toString("base64");
}

function minimalConfig(target: "android" | "browser" | "desktop" | "ios"): IStandalonePlaytestConfig {
  return {
    artifactDirectory: "/artifacts",
    desktop: target === "desktop" ? { executable: "/native/game" } : undefined,
    headless: true,
    projectPath: "/project",
    scenarioPath: "scenario.json",
    target,
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
}


test("desktop evaluates the host network observation instead of rejecting the assertion", async () => {
  const { report } = await runDesktopScenario(2, { assertNetwork: true, network: {
    requests: 2, entries: [{ method: "GET", url: "https://host/failure" }],
  } });
  expect(report.pass).toBe(false);
  expect(report.diagnostics.some(({ code }) => code === "TN_PLAYTEST_UNSUPPORTED_ON_TARGET")).toBe(false);
  expect(report.observations?.network).toEqual([{ method: "GET", url: "https://host/failure" }]);
  expect(report.diagnostics.some(({ code }) => code === "TN_PLAYTEST_NETWORK_ERROR")).toBe(true);
  const healthy = await runDesktopScenario(2, { assertNetwork: true, network: { requests: 2, entries: [] } });
  expect(healthy.report.pass).toBe(true);
});

test.each([null, { requests: -1, entries: [] }, { requests: 1, entries: [{ url: 123 }] }])(
  "desktop fails closed for a missing or malformed network observation %j", async (network) => {
    await expect(runDesktopScenario(2, { assertNetwork: true, network })).rejects.toThrow(/NETWORK.*UNOBSERVED/u);
  },
);
test("desktop completion opt-in follows deterministic prefix, restores controls and reports separate cadence", async () => {
  const saved = { ...process.env };
  process.env.TN_PLAYTEST_COMPLETION_WINDOW_LABEL = "completion-pose";
  process.env.TN_PLAYER_VSYNC = "0";
  process.env.TN_PLAYTEST_HOST_DISPLAY = "1";
  process.env.DISPLAY = ":synthetic-driver";
  const calls: { method: string; argument: unknown }[] = [];
  try {
    const { report, driver } = await runDesktopScenario(2, { completion: { valid: true, calls } });
    expect(report.pass).toBe(true);
    expect(report.clock).toBe("wall-clock");
    expect(report.acquisition?.cpuWindows).toBeUndefined();
    expect(report.acquisition?.completionWindow).toMatchObject({ intervalCount: 250, durationMs: 5000, completionIntervalP50Ms: 20,
      provenance: { qualified: false, nativeVsync: "0", requestedDisplay: ":synthetic-driver" },
      setupSnapshot: { clock: { mode: "fixed-step", tick: 3 } } });
    expect(calls.filter(call => call.method === "advance").map(call => call.argument)).toEqual([3]);
    expect(calls.filter(call => call.method === "_setClockMode").map(call => call.argument)).toEqual(["wall-clock", "fixed-step"]);
    expect(calls).toContainEqual({ method: "input.keyUp", argument: { key: "KeyW" } });
    expect(await driver.isAlive()).toBe(false);
  } finally {
    for (const key of ["TN_PLAYTEST_COMPLETION_WINDOW_LABEL", "TN_PLAYER_VSYNC", "TN_PLAYTEST_HOST_DISPLAY", "DISPLAY"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});


test.each([
  {},
  { noConsoleErrors: false, noRuntimeDiagnostics: false, consoleErrorsOptOutReason: "Known console noise", runtimeDiagnosticsOptOutReason: "Known runtime noise" },
])("V8 frame failures on stdout fail the verdict despite diagnostic opt-outs %j", (policy) => {
  const failure = "[Playtest] TN_V8_FRAME_FAILED: TypeError: attribute.updateRanges.push is not a function";
  const entries = [{ text: failure, type: desktopConsoleType("stdout", failure) }];
  const diagnostics = normalizedRuntimeDiagnostics(undefined, undefined as never, entries);
  expect(diagnostics.recentRuntimeErrors).toEqual([{ text: failure, type: "error" }]);
  const report: IPlaytestReport = {
    diagnostics: [], distance: 0, entity: "player", expectMoved: false, frames: 1,
    observations: { console: entries, hud: {}, network: [], resources: {}, runtimeDiagnostics: diagnostics },
    target: "desktop", trivialityOptOuts: [],
  };
  const scenario = {
    assert: { diagnostics: policy }, name: "frame-failure", schemaVersion: 1,
    steps: [], subject: "player", target: "desktop",
    viewport: { height: 360, width: 640 }, warmupFrames: 0,
  } as IPlaytestScenario;
  const result = evaluateRichPlaytestAssertions({ report, scenario });
  expect(result.assertions).toContainEqual(expect.objectContaining({ id: "diagnostics", pass: false }));
  expect(exitCodeForReport({
    assertionResults: result.assertions, diagnostics: result.diagnostics,
    pass: result.assertions.every((assertion) => assertion.pass),
  })).toBe(1);
});

test.skipIf(process.platform === "win32")("desktop screenshot services render-only only after the host consumed the request", async () => {
  // A driven native loop presents nothing between ticks, so the host's capture needs the game to
  // draw one render-only frame. The host must have consumed the request first (the copy flag
  // exists only then), so the driver invokes the render-only operation after it sees the request
  // file gone — never before, and never when the bridge offered no operation.
  const root = await makeTempDir("playtest-desktop-render-only-");
  const executable = join(root, "native-render-only.mjs");
  const screenshotPath = join(root, "capture.png");
  const requestPath = join(root, "tn-playtest-screenshot-request.txt");
  const markerPath = join(root, "render-only-requested.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.TN_PLAYTEST_MAILBOX_ROOT;
const request = join(root, "tn-playtest-screenshot-request.txt");
const marker = join(root, "render-only-requested.txt");
const bytes = Buffer.from(${JSON.stringify(nonBlankPngBase64())}, "base64");
let consumed = false;
let target = "";
let deadline = 0;
let wrote = false;
setInterval(() => {
  if (!consumed && existsSync(request)) {
    target = readFileSync(request, "utf8");
    unlinkSync(request);
    consumed = true;
    deadline = Date.now() + 500;
  }
  if (consumed && !wrote && (existsSync(marker) || Date.now() >= deadline)) {
    writeFileSync(join(root, "desktop-fixture-render-order.txt"), existsSync(marker) ? "after-render" : "before-render");
    writeFileSync(target, bytes);
    wrote = true;
  }
}, 5);
`);
  await chmod(executable, 0o755);
  const driver = new DesktopPlaytestDriver({ executable, mailboxRoot: root, screenshotTimeoutMs: 2_000 });
  const calls: string[] = [];
  try {
    await driver.prepare("unused");
    await driver.screenshot(screenshotPath, async () => {
      calls.push(existsSync(requestPath) ? "request-present" : "request-consumed");
      await writeFile(markerPath, "render");
    });
    expect(calls).toEqual(["request-consumed"]);
    expect(await readFile(join(root, "desktop-fixture-render-order.txt"), "utf8")).toBe("after-render");
    assertCaptureNotBlank(await readFile(screenshotPath), screenshotPath);
  } finally {
    await driver.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("desktop counted capture draws a render-only frame through the bridge", async () => {
  // End to end: the runner sees `runtime.renderOnly`, hands it to the driver, and the driver asks
  // the game for one render-only frame only after the host consumed the request. The fake host is
  // a driven native loop — it never presents on its own, so the png exists only when the bridge's
  // render-only operation arrived. A broken chain falls back to a late png and fails the marker.
  const projectPath = await makeTempDir("playtest-desktop-render-only-runner-");
  const mailboxRoot = join(projectPath, "mailbox");
  const artifactDirectory = join(projectPath, "artifacts");
  const executable = join(projectPath, "native-render-only.mjs");
  const scenarioPath = join(projectPath, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({
    artifacts: { screenshots: "after" },
    assert: { movement: { entity: "player", minDistance: 2 } },
    name: "desktop-render-only",
    schemaVersion: 1,
    steps: [{ holdFrames: 3, press: "KeyW", release: true }],
    subject: "player",
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.TN_PLAYTEST_MAILBOX_ROOT;
if (typeof root !== "string") process.exit(2);
const requestPath = join(root, "tn-playtest-request.json");
const responsePath = join(root, "tn-playtest-response.json");
const screenshotRequestPath = join(root, "tn-playtest-screenshot-request.txt");
const bytes = Buffer.from(${JSON.stringify(nonBlankPngBase64())}, "base64");
let held = false;
let x = 0;
let tick = 0;
let shotTarget = null;
let shotConsumedAt = 0;
let shotWrote = false;
function respond(response) {
  const temporary = responsePath + ".tmp";
  writeFileSync(temporary, JSON.stringify(response));
  renameSync(temporary, responsePath);
}
respond({ id: "ready", result: null });
function poll() {
  if (existsSync(screenshotRequestPath)) {
    shotTarget = readFileSync(screenshotRequestPath, "utf8");
    unlinkSync(screenshotRequestPath);
    shotConsumedAt = Date.now();
  }
  if (shotTarget !== null && !shotWrote && Date.now() - shotConsumedAt > 1500) {
    writeFileSync(shotTarget, bytes);
    shotWrote = true;
  }
  if (!existsSync(requestPath)) return;
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  unlinkSync(requestPath);
  let result = null;
  if (request.method === "describe") {
    result = {
      capabilities: ["entity.observe", "runtime.diagnostics", "runtime.fixedStep", "runtime.network", "runtime.renderOnly"],
      limits: { maxEntitiesPerSample: 100, maxEventsPerDrain: 1000, maxPayloadBytes: 1000000, operationTimeoutMs: 5000 },
      name: "desktop-render-only-fixture",
      protocolVersion: 1,
    };
  } else if (request.method === "ready") {
    result = { ready: true };
  } else if (request.method === "advance") {
    tick += request.argument;
    if (held) x += request.argument;
    result = { clock: { mode: "fixed-step", tick }, ticks: request.argument };
  } else if (request.method === "sample") {
    result = {
      clock: { mode: "fixed-step", tick },
      diagnostics: [],
      network: { requests: 0, entries: [] },
      entities: [{ id: "player", transform: { position: [x, 0, 0] }, visible: true }],
      resources: {},
    };
  } else if (request.method === "renderOnly") {
    writeFileSync(join(root, "desktop-fixture-render-only.txt"), "received");
    if (shotTarget !== null && !shotWrote) {
      writeFileSync(shotTarget, bytes);
      shotWrote = true;
    }
  } else if (request.method === "input.keyDown") {
    held = true;
  } else if (request.method === "input.keyUp") {
    held = false;
  }
  respond({ id: request.id, result });
}
setInterval(poll, 5);
`);
  await chmod(executable, 0o755);
  try {
    const report = await runDesktopPlaytest({
      artifactDirectory,
      desktop: { executable },
      endpoint: "http://127.0.0.1:41777/playtest",
      headless: true,
      projectPath,
      scenarioPath,
      target: "desktop",
      timeoutMs: 2_000,
      trace: false,
      url: "http://127.0.0.1:5173",
    }, { mailboxRoot });
    expect(report.pass).toBe(true);
    expect(await readFile(join(mailboxRoot, "desktop-fixture-render-only.txt"), "utf8")).toBe("received");
    const after = join(artifactDirectory, "after.png");
    assertCaptureNotBlank(await readFile(after), after);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});
