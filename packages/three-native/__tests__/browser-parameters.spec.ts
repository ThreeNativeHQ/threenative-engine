/**
 * PRD-540: three's parameters object (`new MeshStandardMaterial({ color, roughness })`) on the
 * browser back end. The engine ABI takes no records, so the wrapper constructs bare and applies
 * each key the way three's `setValues` does: a colour member is set, everything else assigned.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { Color as ThreeColor } from "three";
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

/** Records every call; a material's `color` is a Color object of its own, with stored lanes. */
function recordingRuntime(calls: string[]): {
  runtime: IBrowserRuntime;
  lanes: Map<string, { r: number; g: number; b: number }>;
} {
  const types = new Map<string, number>();
  const lanes = new Map<string, { r: number; g: number; b: number }>();
  const colors = new Map<string, IEngineRef>();
  let next = 0;
  const ref = (type: string): IEngineRef => {
    const color: IEngineRef = {
      key: `${type}:0:${++next}:1`,
      type: type === "Color" ? (types.get(type) ?? 0) : 0,
    };
    if (type === "Color") lanes.set(color.key, { r: 1, g: 1, b: 1 });
    return color;
  };
  const runtime: IBrowserRuntime = {
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
      if (property === "color" || property === "emissive") {
        const key = `${self.key}.${property}`;
        if (!colors.has(key)) {
          colors.set(key, ref("Color"));
        }
        return colors.get(key) as IEngineRef;
      }
      if (property === "r" || property === "g" || property === "b") {
        return (lanes.get(self.key) ?? { r: 1, g: 1, b: 1 })[property];
      }
      return 0;
    },
    set(self, property, value) {
      if (property === "r" || property === "g" || property === "b") {
        const store = lanes.get(self.key) ?? { r: 1, g: 1, b: 1 };
        store[property] = Number(value);
        lanes.set(self.key, store);
        return;
      }
      calls.push(`set ${self.key.split(":")[0]}.${property} ${JSON.stringify(value)}`);
    },
    release() {},
    setCallback() {},
  };
  return { runtime, lanes };
}

describe("browser back end parameters objects", () => {
  it("constructs bare, sets colour members and assigns the other keys", () => {
    const calls: string[] = [];
    const { runtime, lanes } = recordingRuntime(calls);
    const { classes } = defineBrowserClasses(registry, runtime);
    const Material = classes.MeshStandardMaterial as new (...args: unknown[]) => object;
    new Material({ color: 0xff8030, emissive: "#102030", roughness: 0.5, map: undefined });
    // PRD-742: a colour's lanes are JS and reach the engine as writes, not one method crossing each.
    const [color, emissive] = [...lanes.values()] as { r: number; g: number; b: number }[];
    const rgb = (value: ThreeColor) => ({ r: value.r, g: value.g, b: value.b });
    expect(color).toEqual(rgb(new ThreeColor().setHex(0xff8030)));
    expect(emissive).toEqual(rgb(new ThreeColor().setStyle("#102030")));
    expect(calls).toEqual([
      "construct MeshStandardMaterial []",
      "set MeshStandardMaterial.roughness 0.5",
    ]);
  });

  it("refuses a key the class does not have instead of dropping it", () => {
    const { classes } = defineBrowserClasses(registry, recordingRuntime([]).runtime);
    const Material = classes.MeshStandardMaterial as new (...args: unknown[]) => object;
    expect(() => new Material({ clearcoat: 1 })).toThrow(
      "TN_BROWSER_PARAMETER_UNSUPPORTED: MeshStandardMaterial has no 'clearcoat'",
    );
  });
});
