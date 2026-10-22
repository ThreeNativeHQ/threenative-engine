/**
 * three's `toArray(array, offset)` writes the lanes into the array it is given and answers that array. The engine answers
 * a new array (a plain array crosses by value), so the back end's wrapper does the write. The math classes the engine
 * owns (everything but the JS Vector3) share it, and `native_engine_wasm_browser_backend` checks it over the real Wasm ABI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages", "three-native", "api", "native-registry.json"), "utf8"),
) as IRegistryDump;

/** A runtime that answers every `toArray()` with four lanes and records the arguments it crossed with. */
function fourLanes(crossed: (readonly EngineValue[])[]): IBrowserRuntime {
  const types = new Map<string, number>();
  return {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: (className) => ({ key: `${className}:1`, type: 1 }),
    invoke: (_self, _method, args) => {
      crossed.push(args);
      return [1, 2, 3, 4];
    },
    get: () => undefined,
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
  };
}

describe("toArray(array, offset)", () => {
  const crossed: (readonly EngineValue[])[] = [];
  const { classes } = defineBrowserClasses(registry, fourLanes(crossed));
  const vector = new (
    classes.Vector4 as new () => {
      toArray(array?: number[], offset?: number): number[];
    }
  )();

  it("fills the given array from the offset and answers that array", () => {
    crossed.length = 0;
    const target = [9, 9, 9, 9, 9, 9, 9];
    expect(vector.toArray(target, 2)).toBe(target);
    expect(target).toEqual([9, 9, 1, 2, 3, 4, 9]);
    // Only the engine's own lanes were asked for: the target never crossed.
    expect(crossed).toEqual([[]]);
  });

  it("starts at lane 0 when no offset is given", () => {
    const target: number[] = [];
    vector.toArray(target);
    expect(target).toEqual([1, 2, 3, 4]);
  });

  it("answers the engine's own array when no array is given", () => {
    expect(vector.toArray()).toEqual([1, 2, 3, 4]);
  });
});
