import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@playwright/test", () => ({ chromium: { launch } }));

import { launchWebgpuBrowser } from "../unreal-look/browser.js";

/**
 * A capture opens a headed Chromium, and a headed Chromium paints on the `DISPLAY` it inherits.
 * After a reboot that is `:0`, the owner's screen, and three lanes opened windows over it. The
 * launcher must hand Chromium a private display instead and ask for the session's own only when
 * `TN_PLAYTEST_HOST_DISPLAY` says so.
 */

const SESSION = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" };

/** A fake Xvfb that reports display `:57`, and the order in which the fake processes were stopped. */
function fakeHost(env: NodeJS.ProcessEnv, sessionUsable = true) {
  const events: string[] = [];
  const report = new EventEmitter();
  return {
    events,
    options: {
      commandExists: (command: string) => command === "Xvfb",
      displaySocketExists: () => sessionUsable,
      env,
      platform: "linux",
      spawnProcess: ((command: string) => {
        events.push(`spawn ${command}`);
        queueMicrotask(() => report.emit("data", Buffer.from("57\n")));
        const child = {
          exitCode: null as number | null,
          kill: () => {
            events.push(`stop ${command}`);
            child.exitCode = 0;
            return true;
          },
          on: () => undefined,
          stdio: [undefined, undefined, undefined, report],
        };
        return child as never;
      }) as never,
    },
  };
}

function fakeBrowser(events: string[]) {
  return {
    close: vi.fn(async () => {
      events.push("close browser");
    }),
  };
}

beforeEach(() => {
  launch.mockReset();
});

describe("launchWebgpuBrowser", () => {
  it("starts Chromium on a private display, whatever DISPLAY the shell exports", async () => {
    const host = fakeHost({ ...SESSION, PATH: "/usr/bin" });
    launch.mockResolvedValue(fakeBrowser(host.events));
    await launchWebgpuBrowser(host.options);
    expect(host.events).toEqual(["spawn Xvfb"]);
    const options = launch.mock.calls[0]?.[0];
    expect(options.headless).toBe(false);
    expect(options.args).toContain("--enable-unsafe-webgpu");
    expect(options.env.DISPLAY).toBe(":57");
    expect(options.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(options.env.XDG_SESSION_TYPE).toBeUndefined();
    expect(options.env.PATH).toBe("/usr/bin");
  });

  it("takes the session display only when TN_PLAYTEST_HOST_DISPLAY asks, and then starts no Xvfb", async () => {
    const host = fakeHost({ ...SESSION, TN_PLAYTEST_HOST_DISPLAY: "1" });
    launch.mockResolvedValue(fakeBrowser(host.events));
    await launchWebgpuBrowser(host.options);
    expect(host.events).toEqual([]);
    expect(launch.mock.calls[0]?.[0].env.DISPLAY).toBe(":0");
  });

  it("fails by name when the requested session display cannot be used, and launches nothing", async () => {
    const host = fakeHost({ ...SESSION, TN_PLAYTEST_HOST_DISPLAY: "1" }, false);
    await expect(launchWebgpuBrowser(host.options)).rejects.toThrow(
      /TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE/,
    );
    expect(host.events).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("stops the display after the browser closes, so a caller needs no other cleanup", async () => {
    const host = fakeHost(SESSION);
    launch.mockResolvedValue(fakeBrowser(host.events));
    const browser = await launchWebgpuBrowser(host.options);
    await browser.close();
    expect(host.events).toEqual(["spawn Xvfb", "close browser", "stop Xvfb"]);
  });

  it("stops the display when the browser fails to close", async () => {
    const host = fakeHost(SESSION);
    launch.mockResolvedValue({
      close: async () => {
        throw new Error("close failed");
      },
    });
    const browser = await launchWebgpuBrowser(host.options);
    await expect(browser.close()).rejects.toThrow("close failed");
    expect(host.events).toEqual(["spawn Xvfb", "stop Xvfb"]);
  });

  it("stops the display when the launch fails", async () => {
    const host = fakeHost(SESSION);
    launch.mockRejectedValue(new Error("no chromium"));
    await expect(launchWebgpuBrowser(host.options)).rejects.toThrow("no chromium");
    expect(host.events).toEqual(["spawn Xvfb", "stop Xvfb"]);
  });
});

describe("the capture scripts", () => {
  const HARNESS = path.resolve(import.meta.dirname, "../unreal-look");
  const sources = readdirSync(HARNESS)
    .filter((name) => name.endsWith(".ts") && name !== "browser.ts")
    .map((name) => ({ name, source: readFileSync(path.join(HARNESS, name), "utf8") }));

  it("open a browser only through launchWebgpuBrowser", () => {
    expect(sources.filter(({ source }) => /chromium\s*\.\s*launch\s*\(/.test(source))).toEqual([]);
  });

  it.each(["capture-threenative.ts", "capture-gi-threenative.ts"])(
    "%s launches through it",
    (name) => {
      expect(sources.find((entry) => entry.name === name)?.source).toMatch(
        /await launchWebgpuBrowser\(\)/,
      );
    },
  );
});

describe("assertConfigEcho", () => {
  const url = "http://127.0.0.1:5173/main.html?tnRef=L9&sun=15,25&baseline=1";

  it("stops a capture whose page read no query (the starter's worker page)", async () => {
    const { assertConfigEcho } = await import("../unreal-look/browser.js");
    expect(() => assertConfigEcho(url, {})).toThrow(
      /TN_UNREAL_LOOK_CONFIG_MISMATCH.*tnRef, sun, baseline/u,
    );
    expect(() => assertConfigEcho(url, undefined)).toThrow(/TN_UNREAL_LOOK_CONFIG_MISMATCH/u);
  });

  it("passes a page that read every requested parameter", async () => {
    const { assertConfigEcho } = await import("../unreal-look/browser.js");
    expect(() =>
      assertConfigEcho(url, { tnRef: "L9", sun: "15,25", baseline: "1", extra: "x" }),
    ).not.toThrow();
  });
});
