import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { expect, test } from "vitest";

import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  type IPlaytestBridgeV1,
  type IPlaytestSampleRequest,
  type IPlaytestSetupRequest,
  type JsonValue,
} from "../src/index.js";
import type { IAndroidDriver } from "../src/runner/android.js";
import { AdbAndroidDriver, androidTouchBatches } from "../src/runner/android.js";
import { runAndroidPlaytest, runDevicePlaytest } from "../src/runner/androidRunner.js";
import { exitCodeForReport } from "../src/runner/cli.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";
import { androidMailboxPaths, DeviceBridgeTransport } from "../src/runner/deviceTransport.js";
import {
  connectDevicePlaytestBridge,
  type IDeviceBridgeInstallation,
} from "../src/three/device.js";

interface INativeHost {
  __THREENATIVE_NATIVE__?: {
    playtestInput: {
      keyboard(type: string, key: string, code: string): void;
      pointer(type: string, x: number, y: number, buttons: number): void;
    };
  };
}

class FakeAndroidDriver implements IAndroidDriver {
  installation?: IDeviceBridgeInstallation;
  pointerSets: number[][] = [];
  prepared = false;
  preparedMailboxRoot?: string;

  constructor(
    private readonly bridge?: IPlaytestBridgeV1,
    private readonly consoleEntries: Array<{ text: string; type: string }> = [],
    private readonly onPointers: (ids: readonly number[]) => void = () => undefined,
  ) {}

  async captureConsole() {
    return this.consoleEntries;
  }

  async prepare(endpoint: string, mailboxRoot?: string) {
    this.prepared = true;
    this.preparedMailboxRoot = mailboxRoot;
    if (this.bridge !== undefined) this.installation = connectDevicePlaytestBridge(this.bridge, endpoint);
  }

  async isAlive() {
    return true;
  }

  async screenshot() {}

  async setPointers(pointers: readonly { id: number }[]) {
    const ids = pointers.map(({ id }) => id);
    this.pointerSets.push(ids);
    this.onPointers(ids);
    return { activeIds: ids, injection: "adb-emu-event-protocol-b" as const, rotation: 0, trackingIds: ids };
  }

  async stop() {
    this.installation?.close();
  }
}

class FakeRecordingAndroidDriver extends FakeAndroidDriver {
  recordingStarted = false;
  recordingStopped = false;

  async startScreenRecording() {
    this.recordingStarted = true;
  }

  async stopScreenRecording(path: string) {
    this.recordingStopped = true;
    await writeFile(path, "not an mp4");
  }
}

test("the Android runner samples only after the advertised startup phase is ready", async () => {
  const moving = movingBridge({ startupPolls: 3 });
  const result = await runDevice(
    { diagnostics: deviceDiagnosticsOptOut },
    new FakeAndroidDriver(moving.bridge),
    1_000,
    [{ waitTicks: 10, release: true }],
  );

  expect(result.pass).toBe(true);
  expect(moving.readinessPhases).toEqual(["collapsing", "collapsing", "collapsing", "ready"]);
  expect(moving.sampledBeforeStartup).toBe(0);
  expect(result.observations?.startup).toMatchObject({
    phase: "ready", rule: "sustained-frames", timeline: { readyMs: 1_200 },
  });
});

test("native startup assertions use the observed timeline for passing and slow launches", async () => {
  for (const maxReadyMs of [1_500, 1_000]) {
    const moving = movingBridge({ startupPolls: 1 });
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut, startup: { maxReadyMs } },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [{ waitTicks: 1, release: true }],
    );

    expect(result.pass).toBe(maxReadyMs >= 1_200);
    expect(result.assertionResults).toContainEqual(
      expect.objectContaining({ id: "startup.readyMs", pass: maxReadyMs >= 1_200 }),
    );
    expect(result.diagnostics?.some(({ code }) => code === "TN_PLAYTEST_STARTUP_UNOBSERVABLE")).toBe(false);
  }
});

test("native runner waits on an asynchronously changing resource", async () => {
  const moving = movingBridge({ resourceReadyAtTick: 2 });
  const result = await runDevice(
    {
      diagnostics: deviceDiagnosticsOptOut,
      resources: [{ changed: true, equals: true, id: "state", path: "networkConnected" }],
    },
    new FakeAndroidDriver(moving.bridge),
    1_000,
    [{ timeoutMs: 1_000, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
    null,
  );

  expect(result.pass).toBe(true);
  expect(moving.tick()).toBe(2);
  expect(moving.sampleRequests.some(({ resources }) => resources?.includes("state"))).toBe(true);
});

test("native runner times out a resource wait with the last observation", async () => {
  const moving = movingBridge({ resourceReadyAtTick: Number.POSITIVE_INFINITY });
  const result = await runDevice(
    {
      diagnostics: deviceDiagnosticsOptOut,
      resources: [{ equals: true, id: "state", path: "networkConnected" }],
    },
    new FakeAndroidDriver(moving.bridge),
    1_000,
    [{ timeoutMs: 32, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
    null,
  );

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
    message: expect.stringContaining("last observation false"),
  }));
});

test("the existing device-smoke scenario reaches its visibility assertion on Android", async () => {
  const driver = new FakeAndroidDriver(movingBridge({ entity: "multitouch-player" }).bridge);
  const result = await runDeviceScenario("device-smoke.playtest.json", driver);

  expect(driver.prepared).toBe(true);
  expect(result.pass).toBe(true);
  expect(result.runtime).toBe("native");
  expect(result.target).toBe("android");
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "visibility.cube", pass: true }));
  expect(exitCodeForReport(result)).toBe(0);
});

test("the Android runner resolves an omitted network policy before bridge capability validation", async () => {
  const result = await runDevice(
    {
      diagnostics: {
        noRuntimeDiagnostics: false,
        runtimeDiagnosticsOptOutReason: "This input proof judges its semantic assertions while retaining console diagnostics.",
      },
    },
    new FakeAndroidDriver(movingBridge().bridge),
    1_000,
    [{ waitTicks: 1 }],
  );

  expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
    capability: "browser.network",
    code: "TN_PLAYTEST_CAPABILITY_MISSING",
  }));
  expect(result.pass).toBe(true);
  expect(result.diagnosticsPolicy).toMatchObject({
    noConsoleErrors: true,
    noNetworkErrors: false,
    noRuntimeDiagnostics: false,
  });
  expect(result.diagnosticsPolicy?.networkErrorsOptOutReason).toMatch(/no network observer/u);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "diagnostics", pass: true }));
});

test("the native runner forwards scene-node selectors to bridge samples", async () => {
  const moving = movingBridge();
  const result = await runDevice(
    {
      diagnostics: deviceDiagnosticsOptOut,
      sceneNodes: [{ minCount: 1, select: { name: "cube" }, visible: true }],
    },
    new FakeAndroidDriver(moving.bridge),
    1_000,
    [{ waitTicks: 1, release: true }],
  );

  expect(result.pass).toBe(true);
  expect(moving.sampleRequests).toContainEqual(expect.objectContaining({
    sceneNodes: [{ name: "cube" }],
  }));
});

test("the native lane composes setup overrides and reports the applied receipt", async () => {
  const moving = movingBridge({ height: 1.6, setup: true });
  const setup = {
    aim: { pitch: -Math.PI / 6, yaw: Math.PI / 2 },
    place: [
      { at: { x: 1, y: 2, z: 3 }, entity: "sentry", frozen: true, lookAt: { x: 1, y: 2, z: 0 } },
      { at: { x: -2, y: 4, z: 1 }, entity: "beacon", facing: { yaw: Math.PI / 2 } },
    ],
    spawn: { x: 3, z: -4 },
  };

  const result = await runDevice(
    { diagnostics: deviceDiagnosticsOptOut },
    new FakeAndroidDriver(moving.bridge),
    1_000,
    [{ waitTicks: 1 }],
    "player",
    false,
    setup,
  );

  expect(moving.setupRequests).toEqual([{
    entities: [
      { entity: "player", transform: { position: [3, 1.6, -4] } },
      { entity: "player", transform: { rotation: [-0.18301270189221933, 0.6830127018922193, 0.1830127018922193, 0.6830127018922194] } },
      { entity: "sentry", frozen: true, transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1] } },
      { entity: "beacon", transform: { position: [-2, 4, 1], rotation: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] } },
    ],
  }]);
  const expectedSetupRecords = [
    { entity: "player", kind: "spawn" as const, value: { x: 3, z: -4 } },
    { entity: "player", kind: "aim" as const, value: { pitch: -Math.PI / 6, yaw: Math.PI / 2 } },
    { entity: "sentry", kind: "place" as const, value: { at: { x: 1, y: 2, z: 3 }, frozen: true, lookAt: { x: 1, y: 2, z: 0 } } },
    { entity: "beacon", kind: "place" as const, value: { at: { x: -2, y: 4, z: 1 }, facing: { yaw: Math.PI / 2 } } },
  ];
  expect(result.setup).toEqual({
    applied: expectedSetupRecords,
    // This fake bridge resolves without naming what it applied, so the only evidence is that it
    // did not throw. The report says which — it does not call an echo of the request a read-back.
    confirmedBy: "throw-contract",
    requested: expectedSetupRecords,
  });
});

test("native screenshot evidence fails closed when the driver does not produce a frame", async () => {
  const driver = new FakeAndroidDriver(movingBridge().bridge);
  await expect(runDevice(
    { diagnostics: deviceDiagnosticsOptOut, movement: { entity: "player", maxDistance: 10 } },
    driver,
    1_000,
    [{ waitTicks: 1 }],
    "player",
    "after",
  )).rejects.toThrow(/ENOENT|no such file/u);
});

test("desktop wheel, media and the fixed UI clock reach the native host", async () => {
  const moving = movingBridge();
  const wheels: number[][] = [];
  const media: number[][] = [];
  const clock: number[] = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      advanceClock: (ticks: number) => { clock.push(ticks); return true; },
      keyboard: () => undefined,
      media: (dark: number, reducedMotion: number) => { media.push([dark, reducedMotion]); return true; },
      pointer: () => undefined,
      wheel: (x: number, y: number, deltaX: number, deltaY: number) => { wheels.push([x, y, deltaX, deltaY]); return true; },
    },
  } as never;
  try {
    const result = await runDesktopDevice(new FakeAndroidDriver(moving.bridge), [
      { media: { colorScheme: "dark" }, waitTicks: 1 },
      { wheel: { deltaY: 50, x: 0.25, y: 0.5 }, waitTicks: 7 },
      { media: { reducedMotion: "reduce" }, wheel: { deltaX: 3, deltaY: -20 }, waitTicks: 1 },
    ]);
    expect(result.pass).toBe(true);
    expect(wheels).toEqual([[160, 180, 0, 50], [320, 180, 3, -20]]);
    expect(media).toEqual([[1, -1], [-1, 1]]);
    // Every advance the run made is handed to the host clock, tick for tick.
    expect(clock).toContain(7);
    expect(clock.reduce((sum, ticks) => sum + ticks, 0)).toBe(moving.tick());
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("a desktop media step fails closed when the host has no CSS UI to take it", async () => {
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: { keyboard: () => undefined, media: () => false, pointer: () => undefined },
  } as never;
  try {
    const outcome = await runDesktopDevice(new FakeAndroidDriver(movingBridge().bridge), [
      { media: { colorScheme: "dark" }, waitTicks: 1 },
    ]).then((report) => JSON.stringify(report), (error: unknown) => String(error));
    expect(outcome).toMatch(/media emulation is unavailable/u);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("buttonless native pointer movement drives anonymous evidence", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const pointerEvents: string[] = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type) => {
        pointerEvents.push(type);
        moving.setHeld(type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut, movement: { minDistance: 2 } },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { waitFrames: 1, release: true },
        { holdFrames: 3, pointerPosition: { x: 0.5, y: 0.5 }, release: true },
        { waitFrames: 1, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(result.entity).toBe("player");
    expect(pointerEvents).toEqual(["pointermove"]);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("buttoned native pointer movement presses before moving and releases", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const pointerEvents: string[] = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type) => {
        pointerEvents.push(type);
        moving.setHeld(type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { holdFrames: 1, pointerPosition: { buttons: 1, x: 0.25, y: 0.5 }, release: false },
        { holdFrames: 3, pointerPosition: { buttons: 1, x: 0.75, y: 0.5 }, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(pointerEvents).toEqual(["pointerdown", "pointermove", "pointerup"]);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("native pointer release lands on the pressed point in the same step", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const events: Array<{ buttons: number; type: string; x: number; y: number }> = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type, x, y, buttons) => {
        events.push({ buttons, type, x, y });
        moving.setHeld(type === "pointerdown" || type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [{ holdFrames: 1, pointerPosition: { buttons: 1, x: 0.338, y: 0.538 }, release: true }],
      null,
    );

    expect(result.pass).toBe(true);
    expect(events.map(({ type }) => type)).toEqual(["pointerdown", "pointerup"]);
    expect(events[1]).toEqual({ buttons: 0, type: "pointerup", x: 0.338 * 640, y: 0.538 * 360 });
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("native pointer held across steps releases on the last moved point", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const events: Array<{ buttons: number; type: string; x: number; y: number }> = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type, x, y, buttons) => {
        events.push({ buttons, type, x, y });
        moving.setHeld(type === "pointerdown" || type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { holdFrames: 1, pointerPosition: { buttons: 1, x: 0.25, y: 0.5 }, release: false },
        { holdFrames: 1, pointerPosition: { buttons: 1, x: 0.75, y: 0.5 }, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(events.map(({ type }) => type)).toEqual(["pointerdown", "pointermove", "pointerup"]);
    expect(events[2]).toEqual({ buttons: 0, type: "pointerup", x: 0.75 * 640, y: 0.5 * 360 });
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("native pointer held without a repeated position releases at the saved point", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const events: Array<{ buttons: number; type: string; x: number; y: number }> = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type, x, y, buttons) => {
        events.push({ buttons, type, x, y });
        moving.setHeld(type === "pointerdown" || type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { holdFrames: 1, pointerPosition: { buttons: 1, x: 0.25, y: 0.5 }, release: false },
        { waitFrames: 1, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(events.map(({ type }) => type)).toEqual(["pointerdown", "pointerup"]);
    expect(events[1]).toEqual({ buttons: 0, type: "pointerup", x: 0.25 * 640, y: 0.5 * 360 });
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("a release step with no pointer sends no pointer event", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const events: Array<{ buttons: number; type: string; x: number; y: number }> = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type, x, y, buttons) => {
        events.push({ buttons, type, x, y });
        moving.setHeld(type === "pointerdown" || type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [{ waitFrames: 1, release: true }],
      null,
    );

    expect(result.pass).toBe(true);
    expect(events).toEqual([]);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("an explicit buttons-0 release after a held pointer closes the gesture at its last point", async () => {
  const moving = movingBridge({ clearHeldAfterAdvance: true });
  const events: Array<{ buttons: number; type: string; x: number; y: number }> = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: () => undefined,
      pointer: (type, x, y, buttons) => {
        events.push({ buttons, type, x, y });
        moving.setHeld(type === "pointerdown" || type === "pointermove");
      },
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { holdFrames: 1, pointerPosition: { buttons: 1, x: 0.25, y: 0.5 }, release: false },
        { holdFrames: 1, pointerPosition: { buttons: 0, x: 0.75, y: 0.5 }, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    // A buttons-0 move clears the mask but does not itself close the native gesture; the
    // explicit release on that step still has to emit the pointerup, at the last moved point.
    expect(events.map(({ type }) => type)).toEqual(["pointerdown", "pointermove", "pointerup"]);
    expect(events[1]).toEqual({ buttons: 0, type: "pointermove", x: 0.75 * 640, y: 0.5 * 360 });
    expect(events[2]).toEqual({ buttons: 0, type: "pointerup", x: 0.75 * 640, y: 0.5 * 360 });
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("one device scenario reaches the same semantic evaluator and passes", async () => {
  const { bridge, setHeld } = movingBridge();
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type) => setHeld(type === "keydown"),
      pointer: () => undefined,
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut, movement: { entity: "player", minDistance: 2 } },
      new FakeAndroidDriver(bridge),
    );
    expect(result.pass).toBe(true);
    expect(result.runtime).toBe("native");
    expect(result.target).toBe("android");
    expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: true }));
    expect(exitCodeForReport(result)).toBe(0);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("anonymous device movement omits the entity selector from bridge samples", async () => {
  const moving = movingBridge();
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type) => moving.setHeld(type === "keydown"),
      pointer: () => undefined,
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut, movement: { minDistance: 2 } },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { waitFrames: 1, release: true },
        { holdFrames: 3, press: "KeyW", release: true },
        { waitFrames: 1, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(moving.sampleRequests.length).toBeGreaterThan(0);
    expect(moving.sampleRequests.every(({ entities }) => entities === undefined)).toBe(true);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("device wait preserves held input classification", async () => {
  const moving = movingBridge();
  const keyEvents: string[] = [];
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type, _key, code) => {
        keyEvents.push(`${type}:${code}`);
        moving.setHeld(type === "keydown");
      },
      pointer: () => undefined,
    },
  };
  try {
    const result = await runDevice(
      { diagnostics: deviceDiagnosticsOptOut, movement: { minDistance: 2 } },
      new FakeAndroidDriver(moving.bridge),
      1_000,
      [
        { holdFrames: 1, press: "KeyW", release: false },
        { waitFrames: 2, release: true },
        { holdFrames: 1, press: "KeyW", release: true },
        { waitFrames: 1, release: true },
      ],
      null,
    );

    expect(result.pass).toBe(true);
    expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: true }));
    expect(keyEvents).toEqual(["keydown:KeyW", "keyup:KeyW"]);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("a deliberately wrong value fails on the device path with exit code 1", async () => {
  const { bridge, setHeld } = movingBridge();
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: {
      keyboard: (type) => setHeld(type === "keydown"),
      pointer: () => undefined,
    },
  };
  try {
    const result = await runDevice({
      diagnostics: deviceDiagnosticsOptOut,
      movement: { entity: "player", minDistance: 4 },
    }, new FakeAndroidDriver(bridge));

    expect(result.pass).toBe(false);
    expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: false }));
    expect(exitCodeForReport(result)).toBe(1);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("an Android runtime error reaches the diagnostics assertion with exit code 1", async () => {
  const host = globalThis as typeof globalThis & INativeHost;
  const previous = host.__THREENATIVE_NATIVE__;
  host.__THREENATIVE_NATIVE__ = {
    playtestInput: { keyboard: () => undefined, pointer: () => undefined },
  };
  try {
    const result = await runDevice(
      {
        diagnostics: {
          noConsoleErrors: false,
          consoleErrorsOptOutReason: "This device test isolates runtime diagnostics from the console policy.",
          noNetworkErrors: false,
          networkErrorsOptOutReason: "The Android transport has no network observer in this runtime test.",
          noRuntimeDiagnostics: true,
        },
      },
      new FakeAndroidDriver(movingBridge().bridge, [{ text: "android boom", type: "error" }]),
    );

    expect(result.assertionResults).toContainEqual({
      details: {
        consoleErrors: 1,
        networkErrors: 0,
        policy: {
          consoleErrorsOptOutReason: "This device test isolates runtime diagnostics from the console policy.",
          networkErrorsOptOutReason: "The Android transport has no network observer in this runtime test.",
          noConsoleErrors: false,
          noNetworkErrors: false,
          noRuntimeDiagnostics: true,
        },
        runtimeDiagnostics: 1,
      },
      id: "diagnostics",
      pass: false,
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RUNTIME_DIAGNOSTIC");
    expect(exitCodeForReport(result)).toBe(1);
  } finally {
    if (previous === undefined) delete host.__THREENATIVE_NATIVE__;
    else host.__THREENATIVE_NATIVE__ = previous;
  }
});

test("a missing device bridge fails closed with exit code 2", async () => {
  const driver = new FakeAndroidDriver();
  const result = await runDevice(
    { diagnostics: deviceDiagnosticsOptOut, movement: { entity: "player", minDistance: 1 } },
    driver,
    30,
  );

  expect(driver.preparedMailboxRoot).toBe("/sdcard/Android/data/com.mystral.engine/files");
  expect(result.pass).toBe(false);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "diagnostics", pass: false }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_BRIDGE_MISSING");
  expect(exitCodeForReport(result)).toBe(2);
});

test("a misspelled assertion is rejected before the Android app launches", async () => {
  const driver = new FakeAndroidDriver();

  await expect(runDevice({ movment: { entity: "player", minDistance: 1 } }, driver))
    .rejects.toMatchObject({
      diagnostic: expect.objectContaining({ code: "TN_PLAYTEST_SCENARIO_INVALID" }),
    });
  expect(driver.prepared).toBe(false);
});

test("network assertions fail explicitly unsupported instead of being skipped", async () => {
  const driver = new FakeAndroidDriver();
  const result = await runDeviceScenario("device-smoke-network.playtest.json", driver);

  expect(result.pass).toBe(false);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "diagnostics", pass: false }));
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
    message: expect.stringContaining("network assertions"),
  }));
  expect(exitCodeForReport(result)).toBe(2);
  expect(driver.prepared).toBe(false);
});

test("Android framebuffer coverage requires the recorder observer before launching", async () => {
  const driver = new FakeAndroidDriver(movingBridge().bridge);
  const result = await runDevice(
    framebufferCoverageAssertion(),
    driver,
    1_000,
    [{ label: "loading", waitFrames: 1 }],
  );

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
    message: expect.stringContaining("framebuffer coverage recording"),
  }));
  expect(exitCodeForReport(result)).toBe(2);
  expect(driver.prepared).toBe(false);
});

test("Android framebuffer coverage brackets its declared steps and fails closed on unreadable video", async () => {
  const moving = movingBridge();
  const driver = new FakeRecordingAndroidDriver(moving.bridge);
  const result = await runDevice(
    framebufferCoverageAssertion(),
    driver,
    1_000,
    [{ label: "loading", waitFrames: 1 }],
  );

  expect(driver.recordingStarted).toBe(true);
  expect(driver.recordingStopped).toBe(true);
  expect(moving.tick()).toBe(1);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "framebufferCoverage",
    pass: false,
  }));
  expect(result.observations?.framebufferCoverage).toMatchObject({
    boundarySource: "scenario-steps",
    frameCount: 0,
    unreadableReason: expect.stringContaining("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_VIDEO_UNREADABLE"),
    windowCompleted: false,
    windowStarted: false,
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_FRAMEBUFFER_PIXELS_UNREADABLE",
  }));
  expect(exitCodeForReport(result)).toBe(1);
});

test("Android multi-pointer steps deliver complete held sets and release in finally", async () => {
  const moving = movingBridge();
  const driver = new FakeAndroidDriver(moving.bridge, [], (ids) => moving.setHeld(ids.length === 2));
  const result = await runDevice(
    { diagnostics: deviceDiagnosticsOptOut, movement: { entity: "player", minDistance: 2 } },
    driver,
    1_000,
    [
      { holdFrames: 2, pointers: [{ id: 7, x: 0.2, y: 0.8 }], release: false },
      {
        holdFrames: 3,
        pointers: [{ id: 7, x: 0.25, y: 0.8 }, { id: 3, x: 0.8, y: 0.8 }],
        release: true,
      },
    ],
  );

  expect(result.pass).toBe(true);
  expect(driver.pointerSets.slice(0, 3)).toEqual([[7], [7, 3], []]);
  expect(driver.pointerSets.at(-1)).toEqual([]);
});

test("an Android run records device thermal, power and battery state as an observation", async () => {
  const driver = new MeteredAndroidDriver(movingBridge().bridge);
  const result = await runDevice(
    { diagnostics: deviceDiagnosticsOptOut },
    driver,
    1_000,
    [{ waitFrames: 1 }],
    null,
  );

  const metrics = result.observations?.deviceMetrics;
  expect(metrics?.available).toBe(true);
  expect(metrics?.errors).toEqual([]);
  expect(metrics?.serial).toBe("192.168.1.192:5555");
  // Sampled before prepare() and after the last bridge sample, so the run is bracketed.
  expect(metrics?.samples.map(({ phase }) => phase)).toEqual(["before", "after"]);
  expect(metrics?.samples[0]?.batteryTemperatureC).toBe(34.7);
  expect(metrics?.samples[0]?.powerRails.available).toBe(true);
  expect(metrics?.verdict.thermallyConfounded).toBe(false);
  expect(driver.adbCalls.some((call) => call.includes("dumpsys thermalservice"))).toBe(true);
});

test("a deviceMetrics assertion on a device run judges the thermal verdict", async () => {
  const driver = new MeteredAndroidDriver(movingBridge().bridge, "hot");
  const result = await runDevice(
    {
      deviceMetrics: { notThermallyConfounded: true },
      diagnostics: deviceDiagnosticsOptOut,
    },
    driver,
    1_000,
    [{ waitFrames: 1 }],
    null,
  );

  expect(result.pass).toBe(false);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "deviceMetrics.notThermallyConfounded",
    pass: false,
  }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_DEVICE_THERMALLY_CONFOUNDED");
  // The numbers survive the failing verdict: a confounded run is reported, never discarded.
  expect(result.observations?.deviceMetrics?.samples[0]?.batteryTemperatureC).toBe(43.2);
});

test("a deviceMetrics assertion on desktop fails unsupported and names the Android lane", async () => {
  const projectPath = await makeTempDir("playtest-device-metrics-desktop-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { deviceMetrics: { notThermallyConfounded: true } },
    name: "thermal-cross-target",
    schemaVersion: 1,
    steps: [{ waitFrames: 1 }],
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const driver = new FakeAndroidDriver();
  const result = await runDevicePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: "desktop",
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  }, {
    driver,
    mailboxPaths: androidMailboxPaths("com.mystral.engine", projectPath),
    name: "desktop",
    processName: "native-game",
  });

  expect(result.pass).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
    message: expect.stringContaining("device thermal and power assertions"),
  }));
  expect(result.diagnostics[0]?.suggestion).toContain("--target android");
  expect(driver.prepared).toBe(false);
});

/**
 * Answers the four read-only device probes from the captured Pixel 8 fixtures in
 * `fixtures/device-metrics/`, so the wiring is proven without a phone attached.
 */
class MeteredAndroidDriver extends FakeAndroidDriver {
  readonly adbCalls: string[] = [];

  constructor(bridge?: IPlaytestBridgeV1, private readonly heat: "cool" | "hot" = "cool") {
    super(bridge);
  }

  deviceSerial() {
    return "192.168.1.192:5555";
  }

  async runAdb(args: readonly string[]) {
    const call = args.join(" ");
    this.adbCalls.push(call);
    const suffix = this.heat === "hot" ? "-hot" : "";
    if (call.includes("dumpsys battery")) return deviceMetricsFixture(`pixel8-battery${suffix}.txt`);
    if (call.includes("dumpsys thermalservice")) return deviceMetricsFixture(`pixel8-thermalservice${suffix}.txt`);
    if (call.includes("current_now")) return deviceMetricsFixture("pixel8-current-now.txt");
    if (call.includes("logcat")) return deviceMetricsFixture("pixel8-power-rails.logcat.txt");
    throw new Error(`unexpected adb call: ${call}`);
  }
}

async function deviceMetricsFixture(name: string): Promise<string> {
  return readFile(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/device-metrics", name),
    "utf8",
  );
}

async function runDevice(
  assert: unknown,
  driver: FakeAndroidDriver,
  timeoutMs = 1_000,
  steps: unknown[] = [{ holdFrames: 3, press: "KeyW", release: true }],
  subject: string | null = "player",
  screenshots: "after" | false = false,
  setup?: unknown,
) {
  const projectPath = await makeTempDir("playtest-device-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots },
    assert,
    name: "same-cross-target-scenario",
    schemaVersion: 1,
    steps,
    ...(subject === null ? {} : { subject }),
    ...(setup === undefined ? {} : { setup }),
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/playtest`;
  const config: IStandalonePlaytestConfig = {
    android: { activity: ".MystralActivity", packageName: "com.mystral.engine" },
    artifactDirectory: join(projectPath, "artifacts"),
    endpoint,
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: "android",
    timeoutMs,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
  return runAndroidPlaytest(config, { driver, transport: new DeviceBridgeTransport(endpoint) });
}

async function runDesktopDevice(driver: FakeAndroidDriver, steps: unknown[]) {
  const projectPath = await makeTempDir("playtest-desktop-device-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { movement: { entity: "player", maxDistance: 10 } },
    name: "desktop-device-input",
    schemaVersion: 1,
    steps,
    subject: "player",
    target: "desktop",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/playtest`;
  return runDevicePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    endpoint,
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: "desktop",
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  }, {
    driver,
    mailboxPaths: { request: "request", response: "response" },
    name: "desktop",
    processName: "desktop-input-test",
    transport: new DeviceBridgeTransport(endpoint),
  });
}

/**
 * A 128 by 128 frame with eight shades of dark background and one 16 by 16 bright cloud. The
 * cloud is 256 of 16384 pixels: below the browser bright-pixel floor (0.05), above the desktop
 * content floor (0.001). Background luminance stays under 0.05, so it is not bright either.
 */
function cloudPng(): Buffer {
  const png = new PNG({ width: 128, height: 128 });
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const cloud = x >= 56 && x < 72 && y >= 56 && y < 72;
      const shade = cloud ? 255 : 4 + ((x + y) % 8);
      png.data.set([shade, shade, shade, 255], (y * 128 + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

class PngDriver extends FakeAndroidDriver {
  readonly written: string[] = [];

  constructor(bridge: IPlaytestBridgeV1, private readonly png: Buffer) {
    super(bridge);
  }

  override async screenshot(path?: string) {
    if (path === undefined) return;
    this.written.push(path);
    await writeFile(path, this.png);
  }
}

test("a device screenshot on desktop passes the content floor, and android still fails the bright-pixel floor", async () => {
  const cloud = cloudPng();
  const steps = [{ waitTicks: 1 }];
  const desktop = new PngDriver(movingBridge().bridge, cloud);
  const desktopOutcome = await runScreenshotDevice("desktop", desktop, steps).then(
    (result) => JSON.stringify(result),
    (error: unknown) => String(error),
  );
  expect(desktopOutcome).not.toContain("TN_CAPTURE_BLANK");
  expect(desktop.written).toHaveLength(2);

  const android = new PngDriver(movingBridge().bridge, cloud);
  const androidOutcome = await runScreenshotDevice("android", android, steps).then(
    (result) => JSON.stringify(result),
    (error: unknown) => String(error),
  );
  expect(androidOutcome).toContain("bright pixel ratio");
  expect(android.written.length).toBeGreaterThanOrEqual(1);
});

async function runScreenshotDevice(name: "android" | "desktop", driver: PngDriver, steps: unknown[]) {
  const projectPath = await makeTempDir("playtest-device-capture-");
  const artifactDirectory = join(projectPath, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: "before-after" },
    assert: { movement: { entity: "player", maxDistance: 10 } },
    name: `${name}-device-capture`,
    schemaVersion: 1,
    steps,
    subject: "player",
    target: name === "desktop" ? "desktop" : "web",
    viewport: { height: 128, width: 128 },
    warmupFrames: 0,
  }));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/playtest`;
  const config: IStandalonePlaytestConfig = {
    android: { activity: ".MystralActivity", packageName: "com.mystral.engine" },
    artifactDirectory,
    endpoint,
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: name,
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
  const transport = new DeviceBridgeTransport(endpoint);
  if (name === "android") return runAndroidPlaytest(config, { driver, transport });
  return runDevicePlaytest(config, {
    driver,
    mailboxPaths: { request: "request", response: "response" },
    name,
    processName: "desktop-capture-test",
    transport,
  });
}

async function runDeviceScenario(
  scenarioFile: string,
  driver: FakeAndroidDriver,
  timeoutMs = 1_000,
) {
  const projectPath = await makeTempDir("playtest-device-fixture-");
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/native-smoke/playtests", scenarioFile);
  await writeFile(join(projectPath, "scenario.json"), await readFile(fixturePath));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/playtest`;
  const config: IStandalonePlaytestConfig = {
    android: { activity: ".MystralActivity", packageName: "com.mystral.engine" },
    artifactDirectory: join(projectPath, "artifacts"),
    endpoint,
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    target: "android",
    timeoutMs,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
  return runAndroidPlaytest(config, { driver, transport: new DeviceBridgeTransport(endpoint) });
}

function framebufferCoverageAssertion() {
  return {
    diagnostics: {
      noNetworkErrors: false,
      networkErrorsOptOutReason: "The Android transport has no network observer in this scenario.",
    },
    framebufferCoverage: {
      backdrop: [13, 27, 42],
      tolerance: 0,
      window: { endStep: "loading", startStep: "loading" },
    },
  };
}

const deviceDiagnosticsOptOut = {
  noNetworkErrors: false,
  networkErrorsOptOutReason: "The Android transport has no network observer in this scenario.",
};

function movingBridge(options: { clearHeldAfterAdvance?: boolean; entity?: string; height?: number; resourceReadyAtTick?: number; setup?: boolean; startupPolls?: number } = {}): {
  bridge: IPlaytestBridgeV1;
  sampleRequests: IPlaytestSampleRequest[];
  sampledBeforeStartup: number;
  readinessPhases: string[];
  setupRequests: IPlaytestSetupRequest[];
  setHeld(value: boolean): void;
  tick(): number;
} {
  const resourceReadyAtTick = options.resourceReadyAtTick;
  let held = false;
  let tick = 0;
  let x = 0;
  let startupPollsRemaining = options.startupPolls ?? 0;
  let startupReady = options.startupPolls === undefined;
  let sampledBeforeStartup = 0;
  const readinessPhases: string[] = [];
  const sampleRequests: IPlaytestSampleRequest[] = [];
  const setupRequests: IPlaytestSetupRequest[] = [];
  return {
    bridge: {
      advance: async (ticks) => {
        tick += ticks;
        if (held) x += ticks;
        if (options.clearHeldAfterAdvance === true) held = false;
        return { clock: { mode: "fixed-step", tick }, ticks };
      },
      describe: () => ({
        capabilities: [
          "entity.bounds",
          "entity.observe",
          ...(options.setup === true ? ["entity.setup"] : []),
          "runtime.fixedStep",
          "runtime.diagnostics",
          "runtime.network",
          ...(resourceReadyAtTick === undefined ? [] : ["runtime.resources"]),
          ...(options.startupPolls === undefined ? [] : ["runtime.startup"]),
          "scene.nodes",
        ],
        limits: PLAYTEST_PROTOCOL_LIMITS,
        name: "device-test",
        protocolVersion: PLAYTEST_PROTOCOL_VERSION,
      }),
      ...(options.setup === true
        ? { applySetup: async (request: IPlaytestSetupRequest) => { setupRequests.push(request); } }
        : {}),
      ready: () => {
        const ready = startupPollsRemaining <= 0;
        if (!ready) startupPollsRemaining -= 1;
        if (ready) startupReady = true;
        return {
          ready: true,
          ...(options.startupPolls === undefined
            ? {}
            : (() => {
                const phase = ready ? "ready" : "collapsing";
                readinessPhases.push(phase);
                return { startup: { phase, progress: ready ? 1 : 0.5, timeline: { readyMs: 1_200 } } };
              })()),
        };
      },
      sample: (request) => {
        if (!startupReady) sampledBeforeStartup += 1;
        sampleRequests.push(request);
        const resources: Record<string, JsonValue> = resourceReadyAtTick === undefined
          ? {}
          : { state: { networkConnected: tick >= resourceReadyAtTick } };
        return {
          clock: { mode: "fixed-step", tick },
          diagnostics: [],
          network: { requests: 0, entries: [] },
          entities: [
            { id: options.entity ?? "player", transform: { position: [x, options.height ?? 0, 0] }, visible: true },
            { bounds: { height: 40, width: 40, x: 300, y: 160 }, id: "cube", visible: true },
          ],
          resources,
          ...(request.sceneNodes === undefined ? {} : {
            sceneNodes: request.sceneNodes.map((selector) => ({
              matched: selector.name === "cube" ? 1 : 0,
              nodes: selector.name === "cube" ? [{
                name: "cube",
                path: "Scene/cube",
                position: [0, 0, 0],
                scale: [1, 1, 1],
                type: "Mesh",
                visible: true,
                visibleInTree: true,
              }] : [],
              selector,
              truncated: false,
            })),
          }),
        };
      },
    },
    sampleRequests,
    get sampledBeforeStartup() { return sampledBeforeStartup; },
    readinessPhases,
    setupRequests,
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("emulator touch batches never mix a tracking id with a coordinate", () => {
  const identity = ["EV_ABS:ABS_MT_SLOT:0", "EV_ABS:ABS_MT_TRACKING_ID:100"];
  const positions = [
    "EV_ABS:ABS_MT_SLOT:0",
    "EV_ABS:ABS_MT_POSITION_X:6553",
    "EV_ABS:ABS_MT_POSITION_Y:26214",
  ];

  expect(androidTouchBatches(identity, positions)).toEqual([
    [...identity, "EV_SYN:0:0"],
    [...positions, "EV_SYN:0:0"],
  ]);
  expect(androidTouchBatches([], [])).toEqual([]);
  expect(androidTouchBatches(identity, [])).toEqual([[...identity, "EV_SYN:0:0"]]);

  // The emulator answers OK and silently discards the coordinate, so this has to throw rather
  // than inject a contact that lands at (0, 0).
  expect(() => androidTouchBatches([...identity, ...positions], [])).toThrow(
    /TN_PLAYTEST_ANDROID_TOUCH_BATCH_MIXED/u,
  );
});

// The batches are emitted in argument order, and setPointers passes coordinates first on
// purpose: a slot activated before it is positioned presses at wherever the previous gesture
// left it. Observed on an emulator as every tap landing at the previous step's coordinates and
// then dragging to the requested ones.
test("emulator touch batches position a slot before activating it", async () => {
  const sent: string[][] = [];
  const driver = new AdbAndroidDriver({
    activity: ".MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
    touchRotation: 0,
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (
    args,
  ) => {
    if (args[0] === "get-serialno") return "emulator-5554\n";
    if (args[0] === "emu") sent.push([...args.slice(3)]);
    return "";
  };
  await driver.setPointers([{ id: 1, x: 0.25, y: 0.75 }]);
  expect(sent).toHaveLength(2);
  expect(sent[0]?.some((event) => event.includes("ABS_MT_POSITION_X"))).toBe(true);
  expect(sent[1]?.some((event) => event.includes("ABS_MT_TRACKING_ID"))).toBe(true);
});

test("Android launches the playtest activity in the current foreground user", async () => {
  const calls: string[][] = [];
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "shell am get-current-user") return "10\n";
    return "";
  };

  await driver.prepare("http://127.0.0.1:41777/playtest", "/sdcard/Android/data/com.example.game/files");

  expect(calls).toContainEqual([
    "shell",
    "am",
    "force-stop",
    "--user",
    "10",
    "com.example.game",
  ]);
  expect(calls).toContainEqual([
    "shell",
    "am",
    "start",
    "--user",
    "10",
    "-W",
    "-n",
    "com.example.game/com.threenative.runtime.MystralActivity",
    "--es",
    "TN_PLAYTEST_ENDPOINT",
    "http://127.0.0.1:41777/playtest",
    "--es",
    "TN_PLAYTEST_MAILBOX_ROOT",
    "/sdcard/Android/data/com.example.game/files",
  ]);
  await driver.stop();
  expect(calls).toContainEqual([
    "shell",
    "am",
    "force-stop",
    "--user",
    "10",
    "com.example.game",
  ]);
});

/**
 * The native-css UI's own test knobs cross the launch as intent extras, because `am start` passes an
 * app no environment and the host reads both with `getenv`. Absent by default, so a run that asked
 * for neither launches exactly as it did before.
 */
test("Android launch carries the native-css UI's clock and state trace when the environment sets them", async () => {
  const calls: string[][] = [];
  const driver = new AdbAndroidDriver({
    activity: "com.threenative.runtime.MystralActivity",
    adbPath: "/nonexistent/adb",
    packageName: "com.example.game",
  });
  (driver as unknown as { adb: (args: readonly string[]) => Promise<string> }).adb = async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "shell am get-current-user") return "0\n";
    return "";
  };

  process.env.TN_CSS_UI_FIXED_STEP_MS = "0.1";
  process.env.TN_CSS_UI_STATE_TRACE = "1";
  try {
    await driver.prepare("http://127.0.0.1:41777/playtest", "/sdcard/Android/data/com.example.game/files");
  } finally {
    delete process.env.TN_CSS_UI_FIXED_STEP_MS;
    delete process.env.TN_CSS_UI_STATE_TRACE;
  }
  const launch = calls.find((args) => args[0] === "shell" && args[1] === "am" && args[2] === "start");
  expect(launch?.join(" ")).toContain("--es TN_CSS_UI_FIXED_STEP_MS 0.1 --es TN_CSS_UI_STATE_TRACE 1");
  await driver.stop();
});
