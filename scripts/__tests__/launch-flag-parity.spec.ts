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
  if (env === undefined) Reflect.deleteProperty(process.env, "TN_DEBUG");
  else process.env.TN_DEBUG = env;
  if (global === undefined) Reflect.deleteProperty(host, "__THREENATIVE_DEBUG__");
  else host.__THREENATIVE_DEBUG__ = global;
}

afterEach(() => seam(undefined, undefined, undefined));

/**
 * One case per rule, with the answer the rule gives: the two spellings of off, the spellings of on,
 * a bare query, an empty variable, and every seam heard over every other. The expected column is the
 * point — a parity check without one only proves the two copies agree, which they can do and be wrong.
 */
const CASES: readonly (readonly [string | undefined, string | undefined, unknown, boolean])[] = [
  [undefined, undefined, undefined, false],
  [undefined, "1", undefined, true],
  [undefined, "true", undefined, true],
  [undefined, "0", undefined, false],
  [undefined, "false", undefined, false],
  // An exported-but-empty variable is unset, not off and not on.
  [undefined, "", undefined, false],
  [undefined, "yes", undefined, true],
  ["?tnDebug=1", undefined, undefined, true],
  ["?tnDebug=true", undefined, undefined, true],
  // A URL that names the switch and gives it no value has no other way to say yes.
  ["?tnDebug", undefined, undefined, true],
  ["?tnDebug=", undefined, undefined, true],
  ["?tnDebug=0", undefined, undefined, false],
  ["?tnDebug=false", undefined, undefined, false],
  ["?tnDebug=yes", undefined, undefined, true],
  [undefined, undefined, true, true],
  [undefined, undefined, false, false],
  [undefined, undefined, "1", true],
  [undefined, undefined, "0", false],
  [undefined, undefined, "true", true],
  [undefined, undefined, 1, true],
  [undefined, undefined, 0, false],
  // Every seam heard: a yes on one beats a no on another, in either direction.
  ["?tnDebug=1", "0", undefined, true],
  ["?tnDebug=0", "1", undefined, true],
  ["?tnDebug=0", undefined, true, true],
  ["", "0", true, true],
];

describe("the launch-flag rule", () => {
  it("should answer the same as the facade's copy for every seam", () => {
    for (const [search, env, global, expected] of CASES) {
      seam(search, env, global);
      const label = `location=${String(search)} TN_DEBUG=${String(env)} global=${String(global)}`;
      expect(
        readLaunchFlag({
          environment: "TN_DEBUG",
          global: "__THREENATIVE_DEBUG__",
          query: "tnDebug",
        }),
        `core: ${label}`,
      ).toBe(expected);
      expect(debugRequested(), `facade: ${label}`).toBe(expected);
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
      readLaunchValues({
        environment: "TN_DEBUG",
        global: "__THREENATIVE_DEBUG__",
        query: "tnDebug",
      }),
    ).toEqual(["0", "1", "true"]);
  });
});
