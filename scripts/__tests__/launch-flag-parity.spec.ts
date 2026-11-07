// The launch-flag rule has two homes because the package graph forces it: core reads a switch for
// its own subsystems, and `@threenative/three-native` is the lower layer that must not import core,
// so it keeps its own three lines for the bridge's telemetry. Two implementations of one rule drift
// — core accepted `?tnDebug=true` and the facade did not — so this holds them to the same answers
// over every seam the rule names. It is the price of the split, paid in one place.
import { afterEach, describe, expect, it } from "vitest";

import { readLaunchFlag, readLaunchValues } from "../../packages/core/src/debug.js";
import { debugRequested } from "../../packages/three-native/src/debug-telemetry.js";

const host = globalThis as Record<string, unknown>;

function seam(search: string | undefined, env: string | undefined, global: unknown): void {
  if (search === undefined) Reflect.deleteProperty(host, "location");
  else host.location = { search };
  if (env === undefined) delete process.env.TN_DEBUG;
  else process.env.TN_DEBUG = env;
  if (global === undefined) Reflect.deleteProperty(host, "__THREENATIVE_DEBUG__");
  else host.__THREENATIVE_DEBUG__ = global;
}

afterEach(() => seam(undefined, undefined, undefined));

/** One case per rule: the two spellings of off, the two of on, a bare query, and the odd values. */
const CASES: readonly (readonly [string | undefined, string | undefined, unknown])[] = [
  [undefined, undefined, undefined],
  [undefined, "1", undefined],
  [undefined, "true", undefined],
  [undefined, "0", undefined],
  [undefined, "false", undefined],
  [undefined, "", undefined],
  [undefined, "yes", undefined],
  ["?tnDebug=1", undefined, undefined],
  ["?tnDebug=true", undefined, undefined],
  ["?tnDebug", undefined, undefined],
  ["?tnDebug=0", undefined, undefined],
  ["?tnDebug=false", undefined, undefined],
  ["?tnDebug=yes", undefined, undefined],
  [undefined, undefined, true],
  [undefined, undefined, false],
  [undefined, undefined, "1"],
  [undefined, undefined, "0"],
  [undefined, undefined, "true"],
  [undefined, undefined, 1],
  [undefined, undefined, 0],
  // Every seam heard: a yes on one beats a no on another, in either direction.
  ["?tnDebug=1", "0", undefined],
  ["?tnDebug=0", "1", undefined],
  ["?tnDebug=0", undefined, true],
  ["", "0", true],
];

describe("the launch-flag rule", () => {
  it("should answer the same as the facade's copy for every seam", () => {
    for (const [search, env, global] of CASES) {
      seam(search, env, global);
      const describeCase = `location=${String(search)} TN_DEBUG=${String(env)} global=${String(global)}`;
      expect(debugRequested(), describeCase).toBe(
        readLaunchFlag({ environment: "TN_DEBUG", global: "__THREENATIVE_DEBUG__", query: "tnDebug" }),
      );
    }
  });

  it("should treat 0 and false as the only spellings of off", () => {
    const spec = { environment: "TN_DEBUG", global: "__THREENATIVE_DEBUG__", query: "tnDebug" };
    for (const value of ["0", "false"]) {
      seam(undefined, value, undefined);
      expect(readLaunchFlag(spec), value).toBe(false);
      expect(readLaunchValues(spec), value).toEqual([value]);
    }
    for (const value of ["", "1", "true", "yes", "off "]) {
      seam(undefined, value, undefined);
      expect(readLaunchFlag(spec), value).toBe(value !== "");
    }
  });

  it("should report every seam that named the flag, in read order", () => {
    seam("?tnDebug=1", "0", true);
    expect(
      readLaunchValues({ environment: "TN_DEBUG", global: "__THREENATIVE_DEBUG__", query: "tnDebug" }),
    ).toEqual(["0", "1", "true"]);
  });
});
