import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTelemetry, uninstallTelemetry } from "../src/telemetry.js";
import { CORE_VERSION } from "../src/version.js";

type Listener = (event: unknown) => void;
type SendBeacon = ReturnType<typeof vi.fn>;

const ENDPOINT = "https://threenative.com/api/telemetry";

let beacon: SendBeacon;
let fetchMock: ReturnType<typeof vi.fn>;
let infos: unknown[][];
let listeners: Map<string, Listener>;
let removeListener: ReturnType<typeof vi.fn>;

/** One browser page: an https location, a beacon, and a global event target. */
function stubPage(search = ""): void {
  vi.stubGlobal("location", { protocol: "https:", search });
  beacon = vi.fn();
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  listeners = new Map<string, Listener>();
  removeListener = vi.fn((type: string) => listeners.delete(type));
  vi.stubGlobal("addEventListener", (type: string, listener: Listener) => {
    listeners.set(type, listener);
  });
  vi.stubGlobal("removeEventListener", removeListener);
}

/** Every event the stub transport was handed, decoded. */
function sent(): Record<string, unknown>[] {
  return beacon.mock.calls.map((call) => JSON.parse(String(call[1])) as Record<string, unknown>);
}

function bootLine(): unknown {
  return infos.at(-1)?.[0];
}

beforeEach(() => {
  infos = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  stubPage();
});

afterEach(() => {
  uninstallTelemetry();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("telemetry", () => {
  it("sends one scrubbed event for a warning that names a TN_ code", () => {
    vi.stubGlobal("__TN_GAME__", "branded-quest");
    const warn = console.warn;
    installTelemetry(undefined);
    console.warn("TN_SOMETHING: x at https://a.b/c and /home/u/file.ts 123456");
    expect(sent()).toEqual([
      {
        backend: "unknown",
        code: "TN_SOMETHING",
        engine: CORE_VERSION,
        game: "branded-quest",
        level: "warn",
        message: "TN_SOMETHING: x at <url> and <path> <n>",
        mode: "dev",
        platform: "web",
        // The site caps every short field at 32 characters (threenative-site worker/telemetry.ts).
        session: expect.stringMatching(/^[0-9a-z]{1,32}$/u),
      },
    ]);
    // The game's own line still reaches the console, unchanged.
    expect(warn).toHaveBeenCalledWith(
      "TN_SOMETHING: x at https://a.b/c and /home/u/file.ts 123456",
    );
  });

  it("reports an uncaught error and an unhandled rejection as error-level events", () => {
    installTelemetry(undefined);
    listeners.get("error")?.({ error: new Error("TN_PHYSICS_FAILED: the body left the world") });
    listeners.get("unhandledrejection")?.({ reason: new Error("TN_SCENE_LOAD_FAILED: no mesh") });
    expect(sent().map((event) => [event.code, event.level])).toEqual([
      ["TN_PHYSICS_FAILED", "error"],
      ["TN_SCENE_LOAD_FAILED", "error"],
    ]);
  });

  it("takes the code from the error event's own message when it carried no error object", () => {
    installTelemetry(undefined);
    listeners.get("error")?.({ message: "TN_ASSET_FAILED: /assets/x.png 404" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.code).toBe("TN_ASSET_FAILED");
  });

  it("sends a code once, and stops at 50 events a session", () => {
    installTelemetry(undefined);
    console.warn("TN_REPEATED: once");
    console.warn("TN_REPEATED: once");
    expect(sent()).toHaveLength(1);
    for (let index = 0; index < 51; index += 1) console.warn(`TN_CODE_${index}: distinct`);
    expect(sent()).toHaveLength(50);
  });

  it("does no work per warning once the session cap is reached, and scans a bounded prefix", () => {
    installTelemetry(undefined);
    for (let index = 0; index < 50; index += 1) console.warn(`TN_CAP_${index}: x`);
    let reads = 0;
    const late = new Error("unused");
    Object.defineProperty(late, "message", {
      get: () => {
        reads += 1;
        return "TN_LATE: after the cap";
      },
    });
    console.warn(late);
    expect(reads).toBe(0);
    uninstallTelemetry();
    beacon.mockClear();
    installTelemetry(undefined);
    console.warn(`TN_HUGE: ${"/very/long/path".repeat(100_000)}`);
    const [event] = sent();
    expect(event?.code).toBe("TN_HUGE");
    expect(String(event?.message).length).toBeLessThanOrEqual(200);
  });

  it("never sends a log or info marker such as TN_FRAME_BUDGET", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    installTelemetry(undefined);
    console.info("TN_FRAME_BUDGET: {}");
    console.log("TN_AUTO_BATCH: {}");
    expect(sent()).toEqual([]);
  });

  it.each<[string, string, () => void]>([
    ["config", "config", () => undefined],
    ["TN_TELEMETRY", "TN_TELEMETRY", () => vi.stubEnv("TN_TELEMETRY", "0")],
    ["the query", "?tnTelemetry=0", () => stubPage("?tnTelemetry=0")],
    [
      "the global",
      "__THREENATIVE_TELEMETRY__",
      () => vi.stubGlobal("__THREENATIVE_TELEMETRY__", false),
    ],
    ["DO_NOT_TRACK", "DO_NOT_TRACK", () => vi.stubEnv("DO_NOT_TRACK", "1")],
  ])("installs nothing and names %s when that opt-out asks for off", (_name, override, setOff) => {
    const warn = console.warn;
    setOff();
    installTelemetry(_name === "config" ? { enabled: false } : undefined);
    expect(bootLine()).toBe(`TN_TELEMETRY off (${override})`);
    expect(console.warn).toBe(warn);
    console.warn("TN_AFTER_OPT_OUT: x");
    expect(beacon).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["a browser runner", () => vi.stubGlobal("__THREENATIVE_PLAYTEST_RUNNER_EXPECTED__", true)],
    ["a device runner", () => vi.stubGlobal("TN_PLAYTEST_ENDPOINT", "mailbox")],
  ])("stays off under %s unless the launch asks for it", (_name, announce) => {
    announce();
    installTelemetry(undefined);
    expect(bootLine()).toBe("TN_TELEMETRY off (playtest)");
    console.warn("TN_IN_A_PLAYTEST: x");
    expect(beacon).not.toHaveBeenCalled();
    uninstallTelemetry();
    stubPage("?tnTelemetry=1");
    announce();
    installTelemetry(undefined);
    expect(bootLine()).toBe("TN_TELEMETRY on");
    console.warn("TN_IN_A_PLAYTEST: x");
    expect(sent()).toHaveLength(1);
  });

  it.each<[string, boolean, string]>([
    ["the engine player, which has no network fetch", false, "TN_TELEMETRY off (no network)"],
    ["the legacy host, whose fetch reaches the network", true, "TN_TELEMETRY on"],
  ])("on %s it reports %#", async (_name, network, line) => {
    vi.resetModules();
    vi.stubGlobal("location", undefined);
    vi.stubGlobal("__THREENATIVE_NATIVE__", {
      platform: { formFactor: "desktop", maxTouchPoints: 0, os: "linux", runtime: "native" },
    });
    if (network) vi.stubGlobal("__httpRequestAsync", () => undefined);
    const fresh = await import("../src/telemetry.js");
    try {
      fresh.installTelemetry(undefined);
      expect(bootLine()).toBe(line);
    } finally {
      fresh.uninstallTelemetry();
    }
  });

  it("installs nothing on a host that is no platform a game runs on", () => {
    vi.stubGlobal("location", undefined);
    const warn = console.warn;
    installTelemetry(undefined);
    expect(bootLine()).toBe("TN_TELEMETRY off (no platform)");
    expect(console.warn).toBe(warn);
    console.warn("TN_NOWHERE: x");
    expect(beacon).not.toHaveBeenCalled();
  });

  it("restores the exact console methods, listeners and no-op second install on uninstall", () => {
    const warn = console.warn;
    const error = console.error;
    installTelemetry(undefined);
    expect(bootLine()).toBe("TN_TELEMETRY on");
    const wrapped = console.warn;
    installTelemetry(undefined);
    expect(console.warn).toBe(wrapped);
    uninstallTelemetry();
    expect(console.warn).toBe(warn);
    expect(console.error).toBe(error);
    expect(removeListener.mock.calls.map((call) => call[0])).toEqual([
      "error",
      "unhandledrejection",
    ]);
    console.warn("TN_AFTER_UNINSTALL: x");
    expect(beacon).not.toHaveBeenCalled();
  });

  it("falls back to keepalive fetch without a beacon, and survives a rejected send", async () => {
    vi.stubGlobal("navigator", undefined);
    fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", fetchMock);
    installTelemetry(undefined);
    console.warn("TN_TRANSPORT: x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; keepalive: boolean; method: string },
    ];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({ keepalive: true, method: "POST" });
    expect(JSON.parse(init.body).code).toBe("TN_TRANSPORT");

    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(() => console.warn("TN_OFFLINE: x")).not.toThrow();
    await Promise.resolve();
  });

  it("installs nothing in production: a page that carries a build id (PRD-918)", () => {
    const warn = console.warn;
    vi.stubGlobal("__TN_BUILD_ID__", "/assets/index-A1.js");
    installTelemetry(undefined);
    expect(bootLine()).toBe("TN_TELEMETRY off (prod)");
    expect(console.warn).toBe(warn);
    console.warn("TN_PROD: x");
    expect(beacon).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
  });

  it("installs nothing in production: a bundle whose launch is not a dev one (PRD-918)", async () => {
    vi.resetModules();
    vi.doMock("../src/game-dev-tools.js", () => ({ isDevLaunch: () => false }));
    try {
      const prod = await import("../src/telemetry.js");
      const warn = console.warn;
      prod.installTelemetry(undefined);
      expect(bootLine()).toBe("TN_TELEMETRY off (prod)");
      expect(console.warn).toBe(warn);
      console.warn("TN_PROD: x");
      expect(beacon).not.toHaveBeenCalled();
      prod.uninstallTelemetry();
    } finally {
      vi.doUnmock("../src/game-dev-tools.js");
      vi.resetModules();
    }
  });

  it("marks a dev-run event dev and names the renderer", () => {
    vi.stubGlobal("__TN_ENGINE__", "threenative");
    installTelemetry(undefined);
    console.warn("TN_DEV: x");
    expect(sent()[0]).toMatchObject({ backend: "threenative", mode: "dev" });
  });
});
