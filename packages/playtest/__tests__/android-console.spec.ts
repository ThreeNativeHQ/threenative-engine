import { expect, test, vi } from "vitest";
import { open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../../../test-support/temp-dir.js";

import { AdbAndroidDriver, parseAndroidConsole } from "../src/runner/android.js";
import { runDevicePlaytest } from "../src/runner/androidRunner.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import {
  androidMailboxPaths,
  type IDevicePlaytestTransport,
  type IDeviceResponseObservation,
} from "../src/runner/deviceTransport.js";
import { PLAYTEST_PROTOCOL_LIMITS } from "../src/protocol.js";

test("Android console attributes errors to the launched app rather than another running game", async () => {
  const own = "I/MystralRuntime(15365): TN_NATIVE_SMOKE_FIRST_FRAME";
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.threenative.vq01",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
    args,
  ) => {
    if (args[1] === "pidof") return "15365\n";
    if (args[0] === "logcat" && args[1] === "-d")
      return [
        own,
        "E/BufferQueueProducer(30108): SurfaceView[com.threenative.game/com.threenative.runtime.MystralActivity] BufferQueue has been abandoned",
        'E/MystralRuntime(30108): TN_SURFACE_ACQUIRE_FAILED:{"status":5}',
      ].join("\n");
    return "";
  };
  await driver.prepare("http://127.0.0.1:41777/playtest");
  expect(await driver.captureConsole()).toEqual([{ text: own, type: "log" }]);
});

test("Android console retains its launched pid's errors after that process exits", async () => {
  let alive = true;
  const error = "E/MystralRuntime(15365): TN_NATIVE_START_FAILED: authored startup failed";
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.threenative.vq01",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
    args,
  ) => {
    if (args[1] === "pidof") return alive ? "15365\n" : "";
    if (args[0] === "logcat" && args[1] === "-d") return error;
    return "";
  };
  await driver.prepare("http://127.0.0.1:41777/playtest");
  alive = false;
  expect(await driver.captureConsole()).toEqual([{ text: error, type: "error" }]);
});

test.each([
  "E/platform(15365): driver-specific diagnostic",
  "F/VendorDisplay(15365): vendor-specific diagnostic",
])(
  "Android console preserves runtime tag selection for own-PID vendor records: %s",
  async (vendor) => {
    const own = "E/MystralRuntime(15365): TN_NATIVE_START_FAILED: authored startup failed";
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName: "com.threenative.vq01",
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => {
      if (args[1] === "pidof") return "15365\n";
      if (args[0] === "logcat" && args[1] === "-d") return `${vendor}\n${own}`;
      return "";
    };
    await driver.prepare("http://127.0.0.1:41777/playtest");
    expect(await driver.captureConsole()).toEqual([{ text: own, type: "error" }]);
  },
);

test.each(
  ["AndroidRuntime", "libc", "DEBUG"].flatMap((tag) =>
    ["E", "F"].map((level) => `${level}/${tag.padEnd(8, " ")}(15365): startup crash evidence`),
  ),
)(
  "Android console retains own-PID critical crash records beyond runtime tags: %s",
  async (crash) => {
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName: "com.threenative.vq01",
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => {
      if (args[1] === "pidof") return "15365\n";
      if (args[0] === "logcat" && args[1] === "-d") return crash;
      return "";
    };
    await driver.prepare("http://127.0.0.1:41777/playtest");
    expect(await driver.captureConsole()).toEqual([{ text: crash, type: "error" }]);
  },
);

test.each([
  [
    "activity launch",
    "I/ActivityManager( 575): Start proc 15365:com.threenative.vq01/u0a217 for next-top-activity",
    "E/AndroidRuntime(15365): FATAL EXCEPTION: main",
  ],
  [
    "Java crash identity",
    "E/AndroidRuntime(15365): Process: com.threenative.vq01, PID: 15365",
    "E/AndroidRuntime(15365): java.lang.IllegalStateException: startup failed",
  ],
  [
    "native tombstone",
    "F/DEBUG(16000): pid: 15365, tid: 15365, name: native >>> com.threenative.vq01 <<<",
    "F/libc(15365): Fatal signal 6 (SIGABRT)",
  ],
])(
  "Android console retains a crash before pidof resolves via %s",
  async (_kind, identity, error) => {
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName: "com.threenative.vq01",
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => {
      if (args[0] === "logcat" && args[1] === "-d")
        return `${identity}\n${error}\nE/MystralRuntime(30108): unrelated game failed`;
      return "";
    };
    await driver.prepare("http://127.0.0.1:41777/playtest");
    const entries = await driver.captureConsole();
    expect(entries).toContainEqual({ text: error, type: "error" });
    expect(entries.some(({ text }) => text.includes("30108"))).toBe(false);
    if (identity.startsWith("F/"))
      expect(entries).toContainEqual({ text: identity, type: "error" });
  },
);

test.each(["", "15365invalid", "0"])(
  "Android console fails closed with evidence when pidof returns %j and no launch identity exists",
  async (pidof) => {
    const error = "E/AndroidRuntime(15365): FATAL EXCEPTION before any process identity";
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName: "com.threenative.vq01",
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => {
      if (args[1] === "pidof") return pidof;
      if (args[0] === "logcat" && args[1] === "-d") return error;
      return "";
    };
    await driver.prepare("http://127.0.0.1:41777/playtest");
    await expect(driver.captureConsole()).rejects.toThrow(
      "TN_PLAYTEST_ANDROID_CONSOLE_UNATTRIBUTED",
    );
    await expect(driver.captureConsole()).rejects.toThrow(error);
  },
);

test.each(["0", "15365invalid"])(
  "Android console rejects invalid historical process identity %s",
  async (pid) => {
    const packageName = "com.threenative.vq01";
    const raw = [
      `I/ActivityManager(575): Start proc ${pid}:${packageName}/u0a217`,
      `E/AndroidRuntime(15365): Process: ${packageName}, PID: ${pid}`,
      `F/DEBUG(16000): pid: ${pid}, tid: 15365, name: native >>> ${packageName} <<<`,
    ].join("\n");
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName,
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => (args[0] === "logcat" && args[1] === "-d" ? raw : "");
    await driver.prepare("http://127.0.0.1:41777/playtest");
    await expect(driver.captureConsole()).rejects.toThrow(
      "TN_PLAYTEST_ANDROID_CONSOLE_UNATTRIBUTED",
    );
  },
);

test.each([false, true])(
  "unknown console attribution cannot pass with diagnostics disabled; prior bridge failure %s",
  async (bridgeFailed) => {
    const projectPath = await makeTempDir("playtest-console-attribution-");
    const packageName = "com.threenative.vq01";
    const raw = `${"I/AndroidRuntime(15365): unclassified launch\n".repeat(100)}E/AndroidRuntime(15365): boot crashed`;
    await writeFile(
      join(projectPath, "scenario.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "console-attribution",
        warmupFrames: 0,
        steps: [{ waitFrames: 1 }],
        viewport: { width: 960, height: 640 },
        artifacts: { screenshots: false },
        assert: {
          resources: [{ id: "state", path: "frames", changed: true }],
          diagnostics: {
            noConsoleErrors: false,
            noRuntimeDiagnostics: false,
            noNetworkErrors: false,
            networkErrorsOptOutReason: "No Android network observer.",
            consoleErrorsOptOutReason:
              "This test disables JavaScript console policy to verify mandatory attribution.",
            runtimeDiagnosticsOptOutReason: "This test isolates console attribution.",
          },
        },
      }),
    );
    const driver = new AdbAndroidDriver({
      activity: ".MystralActivity",
      adbPath: "/nonexistent/adb",
      packageName,
      user: "0",
    });
    (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
      args,
    ) => {
      if (args[0] === "logcat" && args[1] === "-d") return raw;
      if (args.join(" ") === "shell wm size") return "Physical size: 960x640";
      return "";
    };
    driver.isAlive = async () => true;
    driver.stop = async () => {};
    let tick = 0;
    const transport: IDevicePlaytestTransport = {
      capabilities: ["browser.console", "browser.screenshot"],
      start: async () => {},
      close: async () => {},
      waitForBridge: async () => true,
      async call<T>(method: string): Promise<T> {
        if (method === "describe")
          return {
            capabilities: ["runtime.resources", "runtime.fixedStep"],
            limits: PLAYTEST_PROTOCOL_LIMITS,
            name: "console-attribution",
            protocolVersion: 1,
          } as T;
        if (method === "ready") {
          if (bridgeFailed)
            throw new PlaytestBridgeError({
              code: "TN_PLAYTEST_STARTUP_HOST_EXITED",
              message: "Startup crashed",
              severity: "error",
              fix: { instruction: "Inspect the startup console." },
            });
          return { ready: true } as T;
        }
        if (method === "sample")
          return {
            clock: { mode: "fixed-step", tick: ++tick },
            resources: { state: { frames: tick } },
            entities: [],
            diagnostics: [],
          } as T;
        return {} as T;
      },
    };
    const artifactDirectory = join(projectPath, "artifacts");
    const run = runDevicePlaytest(
      {
        projectPath,
        scenarioPath: "scenario.json",
        artifactDirectory,
        headless: true,
        timeoutMs: 1000,
        trace: false,
        url: "",
        target: "android",
      },
      {
        driver,
        mailboxPaths: androidMailboxPaths(packageName),
        name: "android",
        processName: packageName,
        transport,
      },
    );
    if (!bridgeFailed) {
      await expect(run).rejects.toThrow("TN_PLAYTEST_ANDROID_CONSOLE_UNATTRIBUTED");
    } else {
      expect((await run).pass).toBe(false);
      const console = JSON.parse(await readFile(join(artifactDirectory, "console.json"), "utf8"));
      expect(console).toContainEqual({
        text: expect.stringContaining("TN_PLAYTEST_ANDROID_CONSOLE_UNATTRIBUTED"),
        type: "error",
      });
      expect(console[0].text).toContain("boot crashed");
      expect(console[0].text.length).toBeLessThan(2300);
    }
  },
);

test("Android console keeps app errors and explicit package crash records from system reporters", async () => {
  const own = "E/AndroidRuntime(15365): FATAL EXCEPTION: main";
  const reported = "E/ActivityManager( 575): Process com.threenative.vq01 (pid 15365) has crashed";
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.threenative.vq01",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
    args,
  ) => {
    if (args[1] === "pidof") return "15365\n";
    if (args[0] === "logcat" && args[1] === "-d")
      return [
        own,
        reported,
        "E/ActivityManager( 575): Process com.threenative.vq01.other (pid 30108) has crashed",
      ].join("\n");
    return "";
  };
  await driver.prepare("http://127.0.0.1:41777/playtest");
  expect(await driver.captureConsole()).toEqual([
    { text: own, type: "error" },
    { text: reported, type: "error" },
  ]);
});

test("Android console starts a new attribution scope on each prepare", async () => {
  let pid = "15365";
  const current = "I/MystralRuntime(16000): current launch";
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.threenative.vq01",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
    args,
  ) => {
    if (args[1] === "pidof") return pid;
    if (args[0] === "logcat" && args[1] === "-d")
      return `E/MystralRuntime(15365): prior launch\n${current}`;
    return "";
  };
  await driver.prepare("http://127.0.0.1:41777/playtest");
  pid = "16000";
  await driver.prepare("http://127.0.0.1:41777/playtest");
  expect(await driver.captureConsole()).toEqual([{ text: current, type: "log" }]);
});

test("Android console starts after stopping the previous process and keeps new launch errors", async () => {
  let log = "";
  const launchError = "E/Mystral ( 8001): Error: current launch failed";
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    if (args[1] === "pidof") return "8001\n";
    if (args.includes("force-stop")) {
      log += "E/InputDispatcher( 658): channel 'com.example.game/MystralActivity' ~ Channel is unrecoverably broken and will be disposed!\n";
    }
    if (args[0] === "logcat" && args[1] === "-c") log = "";
    if (args[0] === "logcat" && args[1] === "-d") return log;
    if (args.includes("start")) log += launchError;
    return "";
  };

  await driver.prepare("http://127.0.0.1:41777/playtest");
  expect(await driver.captureConsole()).toEqual([{ text: launchError, type: "error" }]);
});

/**
 * One dropped adb transport is not a game failure.
 *
 * A hosted SwiftShader emulator drops the adb transport mid-dump: `adb logcat -d` prints part of
 * the buffer, exits non-zero on the truncated line, and the run failed TN_PLAYTEST_RUNNER_FAILED on
 * a game whose assertions had all passed (CI `clean-consumer`, 5th of 6 sequential runs). The same
 * class was already fixed twice on the native side — #310 and b12becde6 — by re-reading after
 * `wait-for-device`; mirroring that shape here keeps the two harnesses answering a dropped transport
 * the same way.
 */
test("Android console capture retries a dropped logcat transport instead of failing the run", async () => {
  const calls: Array<readonly string[]> = [];
  let logcatAttempts = 0;
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    calls.push(args);
    if (args[1] === "pidof") return "8001\n";
    if (args[0] === "logcat" && args[1] === "-d") {
      logcatAttempts += 1;
      if (logcatAttempts === 1) throw new Error("adb logcat -d -v brief failed: I/SDL     ( 8001): [Mystral] Runtime ini");
      return "I/SDL     ( 8001): [Mystral] Runtime initialized\nE/SDL     ( 8001): [Mystral] authored script failed\n";
    }
    return "";
  };

  expect(await driver.captureConsole()).toEqual([
    { text: "I/SDL     ( 8001): [Mystral] Runtime initialized", type: "log" },
    { text: "E/SDL     ( 8001): [Mystral] authored script failed", type: "error" },
  ]);
  expect(logcatAttempts).toBe(2);
  expect(calls.filter((args) => args[0] === "wait-for-device")).toHaveLength(1);
});

test("Android console capture fails with a bounded excerpt once the transport is gone", async () => {
  let logcatAttempts = 0;
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    if (args[0] === "logcat" && args[1] === "-d") {
      logcatAttempts += 1;
      throw new Error(`adb logcat -d -v brief failed: ${"E/SDL     ( 8001): noise\n".repeat(4_000)}`);
    }
    return "";
  };

  // The failing report embedded an 82 KB logcat in the message; the excerpt keeps the complaint
  // (the tail, where the truncation is visible) and drops the rest.
  const failure = await driver.captureConsole().then(() => undefined, (error: Error) => error);
  expect(failure?.message).toMatch(/^adb logcat -d -v brief failed: /u);
  expect(failure?.message.length ?? 0).toBeLessThanOrEqual(2_200);
  expect(failure?.message).toMatch(/noise/u);
  expect(logcatAttempts).toBe(2);
});

test("Android console capture does not retry a device that refuses the command", async () => {
  let logcatAttempts = 0;
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
    user: "0",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    if (args[0] === "logcat" && args[1] === "-d") {
      logcatAttempts += 1;
      throw new Error("adb logcat -d -v brief failed: KO: unknown command");
    }
    return "";
  };

  await expect(driver.captureConsole()).rejects.toThrow(/unknown command/u);
  expect(logcatAttempts).toBe(1);
});

test("Android console ignores SurfaceSyncGroup framework noise that names MystralActivity", () => {
  const entries = parseAndroidConsole([
    "E/SurfaceSyncGroup( 4270): Failed to receive transaction ready for VRI[MystralActivity]",
    "I/SDL     ( 4270): [Mystral] Runtime initialized",
    "E/SDL     ( 4270): [Mystral] Error: authored script failed",
    "E/chromium( 4270): THREENATIVE bridge failed",
  ].join("\n"));

  expect(entries).toEqual([
    { text: "I/SDL     ( 4270): [Mystral] Runtime initialized", type: "log" },
    { text: "E/SDL     ( 4270): [Mystral] Error: authored script failed", type: "error" },
    { text: "E/chromium( 4270): THREENATIVE bridge failed", type: "error" },
  ]);
});

test("Android console ignores system_server TransitionController lines that name MystralActivity", () => {
  const entries = parseAndroidConsole([
    "E/TransitionController(  575): Set visible without transition ActivityRecord{2cc98de u0 com.threenative.nativecsshud/com.threenative.runtime.MystralActivity t405} playing=false",
    "I/SDL     ( 4270): [Mystral] Runtime initialized",
  ].join("\n"));

  expect(entries).toEqual([
    { text: "I/SDL     ( 4270): [Mystral] Runtime initialized", type: "log" },
  ]);
});

/**
 * The WebView's own C++ diagnostics are not the game's console.
 *
 * Measured on emulator-5554, 2026-08-25: a first launch after `adb install -r` writes five
 * `E/chromium` lines — a missing variations-seed signature and an empty HTTP cache directory —
 * and every one of them failed the starter's `noConsoleErrors`. On browser that assertion means
 * the page's console; scraping logcat made it mean "no process on this device logged at error
 * level", which is a different assertion wearing the same name.
 *
 * The lines stay in the observation. Only their severity changes, because an observation that
 * disappears is how a harness learns to lie.
 */
test("Android console classifies WebView internals as log and page console as error", () => {
  const parsed = parseAndroidConsole([
    "E/chromium( 6585): [0825/065120.946206:ERROR:variations_seed_loader.cc(37)] Seed missing signature.",
    "E/chromium( 6585): [ERROR:simple_index_file.cc(614)] Could not reconstruct index from disk",
    'E/chromium( 6585): [ERROR:CONSOLE(12)] "Uncaught TypeError: game.begin is not a function", source: https://appassets.androidplatform.net/ui/main.js (12)',
    "E/Mystral ( 6585): TN_UI_OVERLAY_UNSUPPORTED: this device's WebView has no WEB_MESSAGE_LISTENER",
  ].join("\n"));
  expect(parsed.map(({ type }) => type)).toEqual(["log", "log", "error", "error"]);
  expect(parsed).toHaveLength(4);
});


test.each([0, 3])("device response archive streams %s records without aggregate serialization", async (count) => {
  const records = Array.from({ length: count }, (_, index) => ({
    body: JSON.stringify({ id: String(index), result: `raw\n雪\"${"x".repeat(1024)}` }),
    method: "sample",
    order: index + 1,
    requestId: String(index),
  }));
  const stringify = JSON.stringify;
  const guard = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    if (value?.observations?.length > 1 && typeof value.observations[0]?.body === "string") {
      throw new RangeError("Invalid string length (simulated aggregate limit)");
    }
    return stringify(value, replacer, space);
  });
  try {
    const { artifactPath, responsePath, stopped, closed } = await runResponseArchive(records);
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toEqual({ responsePath, observations: records });
    expect(stopped()).toBe(true);
    expect(closed()).toBe(true);
  } finally {
    guard.mockRestore();
  }
});

test("device response archive writes each record before the producer continues", async () => {
  await runResponseArchive([{ body: "raw response", method: "sample", order: 1, requestId: "1" }], { verifyWrites: true });
});

test.each([false, true])("device response archive write failure closes resources and retains prior error %s", async (priorError) => {
  const scratch = await open(join(await makeTempDir("playtest-archive-handle-"), "scratch"), "w");
  const prototype = Object.getPrototypeOf(scratch) as FileHandle;
  await scratch.close();
  const original = prototype.writeFile;
  let archiveHandle: FileHandle | undefined;
  const write = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: FileHandle, data, options) {
    archiveHandle = this;
    if (typeof data === "string" && (priorError ? data === "]\n}\n" : data.includes('"method":"sample"'))) {
      throw new Error("archive disk full");
    }
    await original.call(this, data, options);
  });
  const stopped = vi.fn();
  const closed = vi.fn();
  try {
    const failure = runResponseArchive(priorError ? [] : [{ body: "raw", method: "sample", order: 1, requestId: "1" }], {
      prepareError: priorError ? new Error("original prepare failure") : undefined,
      onStop: stopped, onClose: closed,
    });
    await expect(failure).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: priorError ? "original prepare failure" : "archive disk full" }),
        expect.objectContaining({ message: "archive disk full" }),
      ],
    });
    expect(stopped).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(archiveHandle?.fd).toBe(-1);
  } finally {
    write.mockRestore();
  }
});

async function runResponseArchive(records: IDeviceResponseObservation[], options: {
  verifyWrites?: boolean;
  prepareError?: Error;
  onStop?: () => void;
  onClose?: () => void;
} = {}) {
  const projectPath = await makeTempDir("playtest-response-archive-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    schemaVersion: 1, name: "archive", warmupFrames: 0,
    steps: [{ waitFrames: 1 }], viewport: { width: 960, height: 640 },
    artifacts: { screenshots: false },
    assert: { resources: [{ id: "state", path: "frames", changed: true }] },
  }));
  const artifactDirectory = join(projectPath, "artifacts");
  const artifactPath = join(artifactDirectory, "device-response-observations.json");
  const paths = androidMailboxPaths("com.example.archive");
  let observer: ((record: IDeviceResponseObservation) => void | Promise<void>) | undefined;
  let stopped = false;
  let closed = false;
  const transport: IDevicePlaytestTransport = {
    capabilities: [],
    setResponseObserver: (callback) => { observer = callback; },
    start: async () => {
      for (const record of records) {
        await observer?.(record);
        if (options.verifyWrites) expect(await readFile(artifactPath, "utf8")).toContain(JSON.stringify(record));
      }
    },
    waitForBridge: async () => false,
    call: async () => { throw new Error("unexpected call"); },
    close: async () => { closed = true; options.onClose?.(); },
  };
  await runDevicePlaytest({
    projectPath, scenarioPath: "scenario.json", artifactDirectory,
    headless: true, timeoutMs: 1000, trace: false, url: "", target: "android",
  }, {
    driver: {
      captureConsole: async () => [], isAlive: async () => true,
      prepare: async () => { if (options.prepareError) throw options.prepareError; }, screenshot: async () => {},
      stop: async () => { stopped = true; options.onStop?.(); },
    },
    mailboxPaths: paths, name: "android", processName: "com.example.archive", transport,
  });
  return { artifactPath, responsePath: paths.response, stopped: () => stopped, closed: () => closed };
}
