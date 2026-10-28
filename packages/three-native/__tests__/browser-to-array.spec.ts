/**
 * three's `toArray(array, offset)` writes the lanes into the array it is given and answers that array.
 * The math classes are three's own JS modules (PRD-742), so they keep that behaviour; the Wasm smoke
 * test drives the same classes over the real engine.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages", "three-native", "api", "native-registry.json"), "utf8"),
) as IRegistryDump;

/** A runtime that refuses every call: a JS value crosses nothing to fill a JS array. */
function silentRuntime(): IBrowserRuntime {
  const types = new Map<string, number>();
  const refuse = (): never => {
    throw new Error("engine call");
  };
  return {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: refuse,
    invoke: refuse,
    get: refuse,
    set: refuse,
    release: () => undefined,
    setCallback: refuse,
  };
}

describe("toArray(array, offset)", () => {
  const { classes } = defineBrowserClasses(registry, silentRuntime());
  const vector = new (
    classes.Vector4 as new (
      x?: number,
      y?: number,
      z?: number,
      w?: number,
    ) => { toArray(array?: number[], offset?: number): number[] }
  )(1, 2, 3, 4);

  it("fills the given array from the offset and answers that array", () => {
    const target = [9, 9, 9, 9, 9, 9, 9];
    expect(vector.toArray(target, 2)).toBe(target);
    expect(target).toEqual([9, 9, 1, 2, 3, 4, 9]);
  });

  it("starts at lane 0 when no offset is given", () => {
    const target: number[] = [];
    vector.toArray(target);
    expect(target).toEqual([1, 2, 3, 4]);
  });

  it("answers its lanes when no array is given", () => {
    expect(vector.toArray()).toEqual([1, 2, 3, 4]);
  });
});
