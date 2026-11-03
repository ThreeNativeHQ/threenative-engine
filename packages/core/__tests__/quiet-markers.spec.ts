import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installQuietMarkers, uninstallQuietMarkers } from "../src/quiet-markers.js";

const methods = ["log", "info", "debug", "warn", "error"] as const;
type Method = (typeof methods)[number];

let calls: Array<[Method, unknown[]]>;
let originals: Record<Method, (...args: unknown[]) => void>;

beforeEach(() => {
  calls = [];
  originals = {} as typeof originals;
  for (const method of methods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push([method, args]);
    });
    originals[method] = console[method];
  }
  vi.stubGlobal("location", { protocol: "http:", search: "" });
});

afterEach(() => {
  uninstallQuietMarkers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "__THREENATIVE_LOG__");
});

describe("quiet markers", () => {
  it("routes a TN_ info or log line to debug with the same arguments when no flag is set", () => {
    installQuietMarkers();
    console.info("TN_FRAME_BUDGET:", { a: 1 });
    console.log("TN_AUTO_EXPOSURE");
    expect(calls).toEqual([
      ["debug", ["TN_FRAME_BUDGET:", { a: 1 }]],
      ["debug", ["TN_AUTO_EXPOSURE"]],
    ]);
  });

  it("leaves warn, error and non-TN_ lines alone", () => {
    installQuietMarkers();
    console.warn("TN_SCENE_WARNING");
    console.error("TN_FAILED");
    console.info("hello TN_");
    console.log(42, "TN_X");
    expect(calls.map(([method]) => method)).toEqual(["warn", "error", "info", "log"]);
  });

  it.each([
    [
      "the URL query",
      () => vi.stubGlobal("location", { protocol: "https:", search: "?a=1&tnLog=1" }),
    ],
    ["the page global", () => Object.assign(globalThis, { __THREENATIVE_LOG__: true })],
    ["the env var", () => vi.stubEnv("TN_LOG", "1")],
  ])("prints markers at their own level when %s asks for logs", (_name, setFlag) => {
    setFlag();
    installQuietMarkers();
    console.info("TN_FRAME_BUDGET");
    expect(calls).toEqual([["info", ["TN_FRAME_BUDGET"]]]);
  });

  it.each([["0"], ["false"], [""]])("treats TN_LOG=%j as off", (value) => {
    vi.stubEnv("TN_LOG", value);
    vi.stubGlobal("location", { protocol: "http:", search: "?tnLog=0" });
    installQuietMarkers();
    console.info("TN_FRAME_BUDGET");
    expect(calls).toEqual([["debug", ["TN_FRAME_BUDGET"]]]);
  });

  it("wraps nothing without a browser location, as on the native host", () => {
    vi.stubGlobal("location", undefined);
    installQuietMarkers();
    expect(console.info).toBe(originals.info);
    expect(console.log).toBe(originals.log);
  });

  it("restores the exact original methods and does not double-wrap", () => {
    installQuietMarkers();
    const wrapped = console.info;
    installQuietMarkers();
    expect(console.info).toBe(wrapped);
    console.info("TN_ONCE");
    expect(calls).toEqual([["debug", ["TN_ONCE"]]]);
    uninstallQuietMarkers();
    expect(console.info).toBe(originals.info);
    expect(console.log).toBe(originals.log);
  });
});
