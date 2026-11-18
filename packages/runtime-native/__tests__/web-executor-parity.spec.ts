import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRD-898 J6: a `globalThis.__tn*` the web back end installs is a path core takes when it is there and
 * skips when it is not, so a name the native player lacks is a desktop game silently on the slow path.
 * Every web global must have a native installer, or a named reason here.
 */
const read = (file: string): string => readFileSync(path.resolve(file), "utf8");
const web = [
  "packages/three-native/src/browser-backend.ts",
  "packages/three-native/src/browser-entry.ts",
]
  .map(read)
  .join("\n");
const native = [
  "packages/runtime-native/src/adapters/v8/adapter.cpp",
  "packages/runtime-native/src/engine/player/v8_main.cpp",
]
  .map(read)
  .join("\n");

/** Web-only globals: telemetry or a web-host detail core reads only when present, never an executor. */
const WEB_ONLY: Readonly<Record<string, string>> = {
  __tnWasmMemoryBytes: "the Wasm linear memory size, for a bench page's memory report",
  __tnWebThreads: "the browser's thread verdict string; native threads are not a web report",
  __tnCrossingCount: "web crossing meter; the native player meters tn::abi::crossings() in C++",
  __tnEngineTypes: "a type-name map for scripts/profile-wasm-page.ts",
};

const webGlobals = [
  ...new Set(
    [...web.matchAll(/globalThis as \{ (__tn[A-Za-z]+)\?/gu)].map((match) => match[1] as string),
  ),
];

describe("web executor parity", () => {
  it("finds the web back end's globals", () => {
    expect(webGlobals).toContain("__tnAnimationTick");
  });

  it("installs every web executor on the native player", () => {
    const missing = webGlobals.filter(
      (name) => WEB_ONLY[name] === undefined && !native.includes(`"${name}"`),
    );
    expect(missing).toEqual([]);
  });

  it("exempts only names the web still installs", () => {
    for (const name of Object.keys(WEB_ONLY)) expect(webGlobals).toContain(name);
  });
});
