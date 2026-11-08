/**
 * The runner-owned Android lifecycle slice (PRD-366, "Remaining lifecycle producer slice").
 *
 * The steps under test are driven by the runner through the Android driver boundary, and every
 * value in the report is read back out of the device — pid from `pidof`, focus and window rotation
 * from `dumpsys window`, frames from `dumpsys gfxinfo`. Nothing in this file is authored by the
 * game, which is the whole point: a `GameState` resource can restate whatever the scenario wants
 * and prove nothing about whether the app actually went away and came back.
 *
 * The physics column is the runtime-owned simulation-step count, read through the bridge and not
 * off the device: the platform counts frames, and only the physics plugin can say whether the
 * simulation stepped. A build with no physics plugin says so rather than carrying a zero.
 */
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  loadPlaytestScenario,
  type IPlaytestBridgeV1,
  type JsonValue,
} from "../src/index.js";
import {
  AdbAndroidDriver,
  type IAndroidDriver,
  type IAndroidLifecycleOperation,
} from "../src/runner/android.js";
import { runDevicePlaytest } from "../src/runner/deviceRunner.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";
import { androidMailboxPaths, DeviceBridgeTransport } from "../src/runner/deviceTransport.js";
import { connectDevicePlaytestBridge, type IDeviceBridgeInstallation } from "../src/three/device.js";

const PACKAGE = "com.mystral.engine";
const PID = 4242;

/** A device that draws only while it is focused, the way a real app's surface stops. */
class FakeDevice {
  /** Set to model a device with the per-app frame statistics turned off: no counter at all. */
  framesAvailable = true;
  focused = true;
  pid = PID;
  rotation = 0;
  /** Set to model a backgrounded surface that keeps rendering anyway, at 10 Hz. */
  slowBackground = false;
  frames = 500;
  private backgroundSince = Date.now();

  draw(ticks: number): void {
    if (this.focused) this.frames += ticks;
  }

  /**
   * The platform's own frame count as one read sees it.
   *
   * A backgrounded surface that is still rendering at 10 Hz answers two quick reads with the same
   * number, so only a count that holds for a full second separates it from a stopped surface —
   * which is the whole difference the settle makes.
   */
  readFrames(): number | undefined {
    if (!this.framesAvailable) return undefined;
    const now = Date.now();
    if (this.slowBackground && !this.focused) {
      const drawn = Math.floor((now - this.backgroundSince) / 100);
      this.backgroundSince += drawn * 100;
      this.frames += drawn;
    } else {
      this.backgroundSince = now;
    }
    return this.frames;
  }
}

class LifecycleAndroidDriver implements IAndroidDriver {
  installation?: IDeviceBridgeInstallation;
  readonly operations: Array<{ operation: IAndroidLifecycleOperation; rotation?: number }> = [];
  prepared = false;
  /** Set to make a lifecycle operation silently do nothing on the device. */
  refuse = false;
  /** Set to hand the foreground operation a *different* process than the run launched. */
  restartOnForeground = false;
  /** Set for a device whose orientation is pinned, so the rotation never takes. */
  rotationRefused = false;
  /** Set to model a build with no physics plugin, so nothing advertises `runtime.physics`. */
  physicsInstalled = true;
  /** Set to model a bridge that advertises physics and reports a count nobody can read. */
  physicsStepsMalformed = false;
  /** How many samples were attempted while the app was backgrounded, where none can answer. */
  samplesWhileBackgrounded = 0;

  constructor(readonly device = new FakeDevice()) {}

  async background(): Promise<void> {
    this.operations.push({ operation: "background" });
    if (!this.refuse) this.device.focused = false;
  }

  async foreground(): Promise<void> {
    this.operations.push({ operation: "foreground" });
    if (this.restartOnForeground) this.device.pid = 5150;
    if (!this.refuse) this.device.focused = true;
  }

  async rotate(rotation: number): Promise<void> {
    this.operations.push({ operation: "rotate", rotation });
    // `rotationRefused` is a device whose orientation is pinned: `wm user-rotation lock` answers OK
    // and the window never moves.
    if (!this.refuse && !this.rotationRefused) this.device.rotation = rotation;
  }

  async captureConsole() {
    return [];
  }

  async prepare(endpoint: string) {
    this.prepared = true;
    this.installation = connectDevicePlaytestBridge(this.bridge(), endpoint);
  }

  async isAlive() {
    return this.device.pid > 0;
  }

  async lifecycleState() {
    // The real driver parses these out of `pidof`, `dumpsys window` and `dumpsys gfxinfo`; that
    // parsing is covered against real dump shapes at the driver boundary below.
    const frames = this.device.readFrames();
    return {
      focused: this.device.focused,
      ...(frames === undefined ? {} : { frames }),
      pid: this.device.pid,
      windowRotation: this.device.rotation,
    };
  }

  async screenshot() {}

  async stop() {
    this.installation?.close();
  }

  async runAdb(): Promise<string> {
    return "";
  }

  private bridge(): IPlaytestBridgeV1 {
    const device = this.device;
    let tick = 0;
    let physicsSteps = 0;
    return {
      advance: async (ticks) => {
        tick += ticks;
        physicsSteps += ticks;
        device.draw(ticks);
        return { clock: { mode: "fixed-step", tick }, ticks };
      },
      describe: () => ({
        capabilities: [
          "entity.bounds",
          "entity.observe",
          "runtime.fixedStep",
          "runtime.diagnostics",
          ...(this.physicsInstalled ? ["runtime.physics"] : []),
        ],
        limits: PLAYTEST_PROTOCOL_LIMITS,
        name: "lifecycle-test",
        protocolVersion: PLAYTEST_PROTOCOL_VERSION,
      }),
      ready: () => ({ ready: true }),
      sample: () => {
        // A tick observed at a read is not a step: this clock moves on every sample, the way a
        // loop the runner never froze moves between its advances, so an implementation that
        // reports `clock.tick` as the step count reads simulation that never ran.
        tick += 1;
        if (!device.focused) this.samplesWhileBackgrounded += 1;
        return {
          clock: { mode: "fixed-step" as const, tick },
          diagnostics: [] as JsonValue[],
          entities: [{ id: "player", transform: { position: [0, 0, 0] as [number, number, number] }, visible: true }],
          resources: {},
          ...(this.physicsInstalled
            ? {
                // A count as a string is what the wire can carry and the protocol type forbids:
                // exactly the malformed value the runner has to reject rather than read as zero.
                physicsSteps: (this.physicsStepsMalformed
                  ? `${physicsSteps}`
                  : physicsSteps) as number,
              }
            : {}),
        };
      },
    };
  }
}

test("the Android runner drives background, foreground and rotation and reports what the device said", async () => {
  const driver = new LifecycleAndroidDriver();
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "foreground" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "rotate", rotation: 1 }, release: true },
  ]);

  expect(driver.operations).toEqual([
    { operation: "background" },
    { operation: "foreground" },
    { operation: "rotate", rotation: 1 },
  ]);
  const lifecycle = result.observations?.deviceLifecycle;
  expect(lifecycle?.phases.map(({ phase }) => phase)).toEqual(["background", "foreground", "rotate"]);
  // Every value below came out of `pidof`, `dumpsys window` and `dumpsys gfxinfo`.
  expect(lifecycle?.phases[0]).toMatchObject({ focused: false, pid: 4242 });
  expect(lifecycle?.phases[1]).toMatchObject({ focused: true, pid: 4242 });
  expect(lifecycle?.phases[2]).toMatchObject({ focused: true, requestedRotation: 1, windowRotation: 1 });
  expect(lifecycle?.session).toEqual({ pid: 4242 });
  expect(lifecycle?.render).toMatchObject({ framesAdvanced: true, framesPaused: true });
  expect(result.pass).toBe(true);
});

test("the lifecycle phases report the runtime-owned physics-step count read around the away period", async () => {
  const driver = new LifecycleAndroidDriver();
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "foreground" }, release: true },
  ]);

  const physics = result.observations?.deviceLifecycle?.physics;
  expect(physics).toMatchObject({ available: true });
  if (physics?.available !== true) throw new Error(`expected a physics step count, got ${JSON.stringify(physics)}`);
  // Read while the app can still answer: immediately before it went away, the moment it came back
  // and before the runner's own advance, and once after that advance.
  const { afterAdvance, afterForeground, beforeBackground } = physics.steps;
  expect([beforeBackground, afterForeground, afterAdvance]).toEqual([
    expect.any(Number),
    expect.any(Number),
    expect.any(Number),
  ]);
  // The read on return is taken before the runner advances anything, so the simulation cannot
  // have moved while the app was away — which is the pause the report has to be able to claim.
  expect(afterForeground).toBe(beforeBackground);
  expect(afterAdvance).toBe((afterForeground ?? 0) + 1);
  expect(physics.stepsPaused).toBe(true);
  expect(physics.stepsAdvanced).toBe(true);
  // A backgrounded host is asleep, so a sample there reads as a hung bridge rather than a value.
  expect(driver.samplesWhileBackgrounded).toBe(0);
  expect(result.pass).toBe(true);
});

test("a bridge that advertises physics and reports no readable step count fails the lifecycle step", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.physicsStepsMalformed = true;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
  ]);

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_ANDROID_LIFECYCLE_PHYSICS_UNOBSERVED",
  }));
  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("a build with no physics plugin reports the step count as unavailable rather than as zero", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.physicsInstalled = false;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "foreground" }, release: true },
  ]);

  expect(result.observations?.deviceLifecycle?.physics).toEqual({
    available: false,
    reason: expect.stringContaining("runtime.physics"),
  });
  expect(result.pass).toBe(true);
});

test("a device that reports no frame count fails the lifecycle step rather than reporting a zero", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.device.framesAvailable = false;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
  ]);

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_ANDROID_LIFECYCLE_UNOBSERVED",
  }));
  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("a process that is not the one the run launched fails the lifecycle step", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.restartOnForeground = true;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "foreground" }, release: true },
  ]);

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_ANDROID_LIFECYCLE_SESSION_CHANGED",
  }));
  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("an operation the device ignores fails the lifecycle step instead of reporting a phase", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.refuse = true;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
  ]);

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED",
  }));
  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("a device that refuses the rotation fails the step instead of reporting the rotation it was asked for", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.rotationRefused = true;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "rotate", rotation: 1 }, release: true },
  ]);

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED",
    message: expect.stringContaining("asked for rotation 1"),
  }));
  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("a lifecycle step is refused on a target that cannot drive the device", async () => {
  const driver = new LifecycleAndroidDriver();
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
  ], "desktop");

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
    message: expect.stringContaining("lifecycle steps"),
  }));
  expect(driver.operations).toEqual([]);
  expect(driver.prepared).toBe(false);
});

test("a run without lifecycle steps carries no lifecycle observation", async () => {
  const result = await runAndroid(new LifecycleAndroidDriver(), [{ waitTicks: 2, release: true }]);

  expect(result.observations?.deviceLifecycle).toBeUndefined();
});

test("the scenario parser keeps lifecycle steps to one device operation", async () => {
  const parsed = await parse([
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
    { kind: "lifecycle", lifecycle: { operation: "rotate", rotation: 3 }, release: true },
  ]);
  expect(parsed.steps[0]).toMatchObject({ kind: "lifecycle", lifecycle: { operation: "background" } });
  expect(parsed.steps[1]).toMatchObject({ lifecycle: { operation: "rotate", rotation: 3 } });

  for (const steps of [
    [{ kind: "lifecycle", release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "rotate" }, release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "rotate", rotation: 4 }, release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "background", rotation: 1 }, release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "suspend" }, release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "background", nonsense: true }, release: true }],
    [{ kind: "lifecycle", label: "away", lifecycle: { operation: "background" }, release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "background" }, press: "KeyR", release: true }],
    [{ kind: "lifecycle", lifecycle: { operation: "background" }, waitTicks: 2, release: true }],
    [{ lifecycle: { operation: "background" }, release: true, waitTicks: 1 }],
  ]) {
    await expect(parse(steps), JSON.stringify(steps)).rejects.toThrow(/lifecycle/u);
  }
});

test("the device readings behind a phase are parsed off real dumpsys shapes, and a rotation the runner locked is freed on stop", async () => {
  let launcherInFront = false;
  const wmCommands: string[] = [];
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: PACKAGE,
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    if (args[1] === "wm") wmCommands.push(args.join(" "));
    if (args[1] === "pidof") return `${PID}\n`;
    if (args[1] === "dumpsys" && args[2] === "window") {
      return [
        "WINDOW MANAGER POLICY STATE (dumpsys window policy)",
        launcherInFront
          ? "  mCurrentFocus=Window{9c0d33e u0 com.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher}"
          : `  mCurrentFocus=Window{4f2a1b0 u0 ${PACKAGE}/${PACKAGE}.MystralActivity}`,
        "    mRotation=1 mDeferredRotationPauseCount=0",
      ].join("\n");
    }
    if (args[1] === "dumpsys" && args[2] === "gfxinfo") return "Total frames rendered: 941\nJanky frames: 3\n";
    return "";
  };

  // The pid from `pidof`, focus and window rotation from `dumpsys window`, the frames from
  // `dumpsys gfxinfo`. No counter is a missing value, never a zero.
  expect(await driver.lifecycleState()).toEqual({ focused: true, frames: 941, pid: PID, windowRotation: 1 });
  launcherInFront = true;
  expect(await driver.lifecycleState()).toMatchObject({ focused: false });

  await driver.rotate(1);
  wmCommands.length = 0;
  await driver.stop();
  // A lifecycle rotation is its own override: freed on stop, with size and density left alone.
  expect(wmCommands).toContain("shell wm user-rotation free");
  expect(wmCommands).not.toContain("shell wm size reset");
  expect(wmCommands).not.toContain("shell wm density reset");

  const untouched = new AdbAndroidDriver({ activity: ".MystralActivity", adbPath: "/nonexistent/adb", packageName: PACKAGE });
  const untouchedCommands: string[] = [];
  (untouched as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    if (args[1] === "wm") untouchedCommands.push(args.join(" "));
    return "";
  };
  await untouched.stop();
  expect(untouchedCommands).not.toContain("shell wm user-rotation free");
});

test("a backgrounded surface that is still drawing at 10 Hz is not recorded as a paused renderer", async () => {
  const driver = new LifecycleAndroidDriver();
  driver.device.slowBackground = true;
  const result = await runAndroid(driver, [
    { kind: "lifecycle", lifecycle: { operation: "background" }, release: true },
  ]);

  // Two quick reads can land on the same 10 Hz count; only a count held for a second is a stop.
  expect(result.observations?.deviceLifecycle?.phases[0]).toMatchObject({ focused: false, framesPaused: false });
  expect(result.observations?.deviceLifecycle?.render.framesPaused).toBe(false);
  // The run still passes: nothing is claimed that the device did not report.
  expect(result.pass).toBe(true);
});

async function parse(steps: unknown[]) {
  const directory = await makeTempDir("playtest-lifecycle-parse-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "lifecycle-parse",
    schemaVersion: 1,
    steps,
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 0,
  }));
  return loadPlaytestScenario(directory, "scenario.json");
}

async function runAndroid(
  driver: LifecycleAndroidDriver,
  steps: unknown[],
  target: "android" | "desktop" = "android",
) {
  const projectPath = await makeTempDir("playtest-lifecycle-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { diagnostics: { noNetworkErrors: false, networkErrorsOptOutReason: "The Android transport has no network observer in this scenario." } },
    name: "android-lifecycle",
    schemaVersion: 1,
    steps,
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/playtest`;
  const config: IStandalonePlaytestConfig = {
    android: { activity: ".MystralActivity", packageName: PACKAGE },
    artifactDirectory: join(projectPath, "artifacts"),
    endpoint,
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target,
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
  const mailboxPaths = androidMailboxPaths(PACKAGE, `/sdcard/Android/data/${PACKAGE}/files`);
  return runDevicePlaytest(config, {
    driver,
    mailboxPaths,
    name: target,
    processName: PACKAGE,
    transport: new DeviceBridgeTransport(endpoint),
  });
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => (port === undefined ? reject(new Error("no port")) : resolve(port)));
    });
  });
}
