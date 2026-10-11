import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import {
  childEnvForDisplay,
  decideDisplayStrategy,
  provideDisplay,
  runNeedsPixels,
} from "../src/runner/captureEnvironment.js";

const socketPresent = () => true;

const pixelScenario = {
  artifacts: { screenshots: "after" as const },
  steps: [],
};

test("a non-Linux platform always delegates to the host display", () => {
  expect(decideDisplayStrategy({ env: {}, platform: "darwin" })).toEqual({ kind: "host" });
  expect(
    decideDisplayStrategy({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "win32" }),
  ).toEqual({ kind: "host" });
});

test("a live X display is NOT taken by default — a run must not paint on the operator's desktop", () => {
  expect(
    decideDisplayStrategy({ env: { DISPLAY: ":0" }, platform: "linux", displaySocketExists: socketPresent }),
  ).toMatchObject({ kind: "private-xvfb" });
});

test("TN_PLAYTEST_HOST_DISPLAY opts a run back onto the live X display", () => {
  expect(
    decideDisplayStrategy({
      displaySocketExists: socketPresent,
      env: { DISPLAY: ":99", TN_PLAYTEST_HOST_DISPLAY: "1" },
      platform: "linux",
    }),
  ).toEqual({ kind: "existing", display: ":99" });
});

test("an unusable explicitly requested host display fails instead of changing the measured display", () => {
  expect(() =>
    decideDisplayStrategy({
      displaySocketExists: () => false,
      env: { DISPLAY: ":7", TN_PLAYTEST_HOST_DISPLAY: "1" },
      platform: "linux",
    }),
  ).toThrow(/TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE.*:7/);
});

test.each([undefined, ""])("an explicit host request with DISPLAY=%s fails by name", (display) => {
  expect(() => decideDisplayStrategy({
    env: { DISPLAY: display, TN_PLAYTEST_HOST_DISPLAY: "true" },
    platform: "linux",
  })).toThrow(/TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE.*DISPLAY/);
});

test.each([
  { socketPresent: false, connectionStatus: 0, available: true },
  { socketPresent: true, connectionStatus: 1, available: false },
])("host availability follows the X connection, including abstract sockets: %o", (input) => {
  const socket = vi.spyOn(fs, "existsSync").mockReturnValue(input.socketPresent);
  const probe = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
    status: input.connectionStatus,
    signal: null,
    pid: 42,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  const env = { DISPLAY: ":0", TN_PLAYTEST_HOST_DISPLAY: "1", XAUTHORITY: "/session/authority" };
  try {
    const decide = () => decideDisplayStrategy({ env, platform: "linux" });
    if (input.available) expect(decide()).toEqual({ kind: "existing", display: ":0" });
    else expect(decide).toThrow(/TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE.*:0/);
    expect(probe).toHaveBeenCalledWith("xdpyinfo", ["-display", ":0"], expect.objectContaining({
      env,
      stdio: "ignore",
      timeout: expect.any(Number),
    }));
  } finally {
    probe.mockRestore();
    socket.mockRestore();
  }
});

test("a failed explicit host request never launches a substitute Xvfb", async () => {
  const spawnProcess = vi.fn();
  await expect(provideDisplay({
    commandExists: () => false,
    displaySocketExists: () => false,
    env: { DISPLAY: ":7", TN_PLAYTEST_HOST_DISPLAY: "1" },
    platform: "linux",
    spawnProcess: spawnProcess as unknown as typeof childProcess.spawn,
  })).rejects.toThrow(/TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE.*:7/);
  expect(spawnProcess).not.toHaveBeenCalled();
});

test("a DISPLAY whose socket is gone is treated as unusable, not trusted", () => {
  expect(
    decideDisplayStrategy({ env: { DISPLAY: ":7" }, platform: "linux", displaySocketExists: () => false }),
  ).toMatchObject({ kind: "private-xvfb" });
});

test("Wayland alone never satisfies the run — that session hung Chromium at 120s vs 175ms", () => {
  const strategy = decideDisplayStrategy({
    env: { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
    platform: "linux",
    displaySocketExists: () => false,
  });
  expect(strategy).toMatchObject({ kind: "private-xvfb" });
});

test("the screen geometry follows TN_XVFB_SCREEN like the wrapper", () => {
  expect(
    decideDisplayStrategy({
      env: { TN_XVFB_SCREEN: "1280x720x16" },
      platform: "linux",
      displaySocketExists: () => false,
    }),
  ).toEqual({ kind: "private-xvfb", screen: "1280x720x16" });
  expect(decideDisplayStrategy({ env: {}, platform: "linux" })).toEqual({
    kind: "private-xvfb",
    screen: "1600x900x24",
  });
});

test("the browser child environment carries DISPLAY and no Wayland vars", () => {
  const child = childEnvForDisplay(
    { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0", WAYLAND_SOCKET: "wayland-0", XDG_SESSION_TYPE: "wayland" },
    ":42",
  );
  expect(child.DISPLAY).toBe(":42");
  expect(child.WAYLAND_DISPLAY).toBeUndefined();
  expect(child.WAYLAND_SOCKET).toBeUndefined();
  expect(child.XDG_SESSION_TYPE).toBeUndefined();
  expect(child.PATH).toBe("/usr/bin");
});

test("childEnvForDisplay never mutates the parent environment", () => {
  const parent = { DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv;
  childEnvForDisplay(parent, ":5");
  expect(parent).toEqual({ DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" });
});

test("runs that produce pixels need a display; pure assertion runs do not", () => {
  expect(runNeedsPixels({ headless: true }, pixelScenario)).toBe(true);
  expect(runNeedsPixels({ headless: false }, { artifacts: { screenshots: false }, steps: [] })).toBe(true);
  expect(
    runNeedsPixels(
      { headless: true },
      { artifacts: { screenshots: false }, steps: [{ release: true, screenshot: "mid" }] },
    ),
  ).toBe(true);
  // Screenshots are on by default: only an explicit opt-out removes the pixel requirement.
  expect(runNeedsPixels({ headless: true }, { artifacts: undefined, steps: [] })).toBe(true);
  expect(runNeedsPixels({ headless: true }, { artifacts: { screenshots: false }, steps: [] })).toBe(false);
});

test("without Xvfb installed a pixel run fails closed naming the cause", async () => {
  await expect(
    provideDisplay({
      commandExists: () => false,
      displaySocketExists: () => false,
      env: {},
      platform: "linux",
    }),
  ).rejects.toThrow(/Xvfb is not installed/);
});

/**
 * `installed` decides whether this host has a compositing manager. A private Xvfb has none of
 * its own and nothing else blends for it, so the native runtime refuses to attach its UI
 * overlay to a display without one — the display provisions it, and a host that has none still
 * gets its display and keeps the overlay's honest refusal.
 */
for (const installed of [["Xvfb", "xcompmgr"], ["Xvfb"]]) {
  const composited = installed.includes("xcompmgr");
  test(`a private Xvfb is spawned, adopted, and released${composited ? " with a compositor" : " with no compositor installed"}`, async () => {
    const spawnedCommands: string[] = [];
    const killed: string[] = [];
    const { spawn } = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const fd3 = new EventEmitter();
    const originalSpawn = spawn;
    const provided = await provideDisplay({
      commandExists: (command) => installed.includes(command),
      displaySocketExists: () => false,
      env: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      spawnProcess: ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnedCommands.push(command);
        if (command === "Xvfb") queueMicrotask(() => fd3.emit("data", Buffer.from("57\n")));
        // The compositor must be pointed at the display this run just created, never at
        // whatever DISPLAY the operator's own session exported.
        else expect(options.env?.DISPLAY).toBe(":57");
        // A killed child reports its exit, as a real one does: without that the helper waits
        // out its grace period and escalates to SIGKILL, which is a second kill to account for.
        const child = {
          exitCode: null as number | null,
          kill: () => {
            killed.push(command);
            child.exitCode = 0;
            return true;
          },
          on: () => undefined,
          stdio: command === "Xvfb" ? [undefined, undefined, undefined, fd3] : [],
        };
        return child as never;
      }) as unknown as typeof originalSpawn,
    });
    expect(spawnedCommands).toEqual(installed);
    expect(provided.compositor).toBe(composited ? "xcompmgr" : undefined);
    expect(provided.display).toBe(":57");
    expect(provided.strategy).toMatchObject({ kind: "private-xvfb" });
    expect(provided.env.DISPLAY).toBe(":57");
    expect(provided.env.WAYLAND_DISPLAY).toBeUndefined();
    await provided.release();
    // Both children, and the compositor first: it draws the display it is about to lose.
    expect(killed).toEqual(composited ? ["xcompmgr", "Xvfb"] : ["Xvfb"]);
  });
}

/**
 * `commandExists` and the spawn itself are two different moments. A compositor that is gone, or
 * that this host cannot execute, by the time the run reaches it reports neither an exit code nor a
 * signal — the failure arrives as an `error` event — so a run that took the silence for success
 * would report a compositor that never ran and claim a blend nothing performs.
 */
test("a compositor that fails to spawn is not reported as running", async () => {
  const killed: string[] = [];
  const { spawn } = await import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const fd3 = new EventEmitter();
  const originalSpawn = spawn;
  const provided = await provideDisplay({
    commandExists: (command) => ["Xvfb", "xcompmgr"].includes(command),
    displaySocketExists: () => false,
    env: { PATH: "/usr/bin" },
    platform: "linux",
    spawnProcess: ((command: string) => {
      if (command === "Xvfb") queueMicrotask(() => fd3.emit("data", Buffer.from("57\n")));
      const child = {
        exitCode: null as number | null,
        kill: () => {
          killed.push(command);
          child.exitCode = 0;
          return true;
        },
        on: (event: string, listener: () => void) => {
          if (command === "xcompmgr" && event === "error") queueMicrotask(listener);
        },
        stdio: command === "Xvfb" ? [undefined, undefined, undefined, fd3] : [],
      };
      return child as never;
    }) as unknown as typeof originalSpawn,
  });
  expect(provided.compositor).toBeUndefined();
  expect(provided.display).toBe(":57");
  await provided.release();
  expect(killed).toEqual(["Xvfb"]);
});
