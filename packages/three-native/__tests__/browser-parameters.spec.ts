/**
 * PRD-540: three's parameters object (`new MeshStandardMaterial({ color, roughness })`) on the
 * browser back end. The engine ABI takes no records, so the wrapper constructs bare and applies
 * each key the way three's `setValues` does: a colour member is set, everything else assigned.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { Color } from "three";
import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(path.join(process.cwd(), "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

/** Records every call; a material's `color` is a Color object of its own. */
function recordingRuntime(calls: string[]): IBrowserRuntime {
  const types = new Map<string, number>();
  let next = 0;
  const ref = (type: string): IEngineRef => ({
    key: `${type}:0:${++next}:1`,
    type: types.get(type) ?? 0,
  });
  const colors = new Map<string, IEngineRef>();
  const values = new Map<string, EngineValue>();
  return {
    typeId(name) {
      if (!types.has(name)) types.set(name, types.size + 1);
      return types.get(name) as number;
    },
    construct(name, args) {
      calls.push(`construct ${name} ${JSON.stringify(args)}`);
      return ref(name);
    },
    invoke(self, method, args) {
      calls.push(`invoke ${self.key.split(":")[0]}.${method} ${JSON.stringify(args)}`);
      return null;
    },
    get(self, property): EngineValue {
      if (property !== "color" && property !== "emissive")
        return values.get(`${self.key}.${property}`) ?? 0;
      const key = `${self.key}.${property}`;
      if (!colors.has(key)) colors.set(key, ref("Color"));
      return colors.get(key) as IEngineRef;
    },
    set(self, property, value) {
      calls.push(`set ${self.key.split(":")[0]}.${property} ${JSON.stringify(value)}`);
      values.set(`${self.key}.${property}`, value);
    },
    release() {},
    setCallback() {},
  };
}

describe("browser back end parameters objects", () => {
  it("constructs bare, sets colour members and assigns the other keys", () => {
    const calls: string[] = [];
    const { classes } = defineBrowserClasses(registry, recordingRuntime(calls));
    const Material = classes.MeshStandardMaterial as new (...args: unknown[]) => object;
    new Material({ color: 0xff8030, emissive: "#102030", roughness: 0.5, map: undefined });
    // A hex runs three's setHex in JS: its sRGB lanes, then the working (linear) ones.
    const { r, g, b } = new Color(0xff8030);
    expect(calls).toEqual([
      "construct MeshStandardMaterial []",
      "set Color.r 1",
      `set Color.g ${128 / 255}`,
      `set Color.b ${48 / 255}`,
      `set Color.r ${r}`,
      `set Color.g ${g}`,
      `set Color.b ${b}`,
      'invoke Color.setStyle ["#102030"]',
      "set MeshStandardMaterial.roughness 0.5",
    ]);
  });

  it("refuses a key the class does not have instead of dropping it", () => {
    const { classes } = defineBrowserClasses(registry, recordingRuntime([]));
    const Material = classes.MeshStandardMaterial as new (...args: unknown[]) => object;
    expect(() => new Material({ clearcoat: 1 })).toThrow(
      "TN_BROWSER_PARAMETER_UNSUPPORTED: MeshStandardMaterial has no 'clearcoat'",
    );
  });

  it("names a refused value's class and keys", () => {
    const { classes } = defineBrowserClasses(registry, recordingRuntime([]));
    const Material = classes.MeshStandardMaterial as new (...args: unknown[]) => object;
    class Odd {
      depth = 1;
    }
    expect(() => {
      (new Material() as { roughness: unknown }).roughness = new Odd();
    }).toThrow("TN_BROWSER_ARGUMENT_UNSUPPORTED: Odd {depth} cannot cross to the engine");
  });
});
