/**
 * The crossings counter sees only what reaches Wasm, and the bridge cache answers most engine-bound
 * property reads before they get there. `TN_FRAME_BUDGET.counters.engine` therefore carries the glue's
 * own entries too (`methodCalls`, `propertyReads`), so a profile's glue time can be sized against a count
 * rather than a guess: a traced wrapper runs once per call, crossed or kept. Both are counted only while
 * a playtest bounds engine counters, so a shipped frame pays a branch and no store.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

const ENGINE_COST_KNOB = "__THREENATIVE_ENGINE_COST__";
const host = globalThis as Record<string, unknown>;

afterEach(() => {
  delete host[ENGINE_COST_KNOB];
});

/** Engine memory is one byte array: `visible` is the first flag at the object's address. */
function countedRuntime() {
  const heap = new Uint8Array(256);
  const crossings: string[] = [];
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId: () => 1,
    construct(name) {
      heap[next * 8] = 1; // visible, as the engine's Object3D starts
      return { key: `${name}:${next++}`, type: 1 };
    },
    invoke(_self, method) {
      crossings.push(`invoke ${method}`);
      return null;
    },
    get(self, property) {
      if (property === "__address") return Number(self.key.split(":")[1]) * 8;
      crossings.push(`get ${property}`);
      return property === "matrixAutoUpdate" ? true : null;
    },
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
    readDoubles: () => 0,
    readByte: (address) => heap[address] as number,
  };
  return { runtime, crossings };
}

interface IGlueNumbers {
  methodCalls?: number;
  propertyReads?: number;
}

describe("bridge glue counters", () => {
  it("counts every wrapper entry, crossed or answered by the back end", () => {
    const { runtime, crossings } = countedRuntime();
    const engine = defineBrowserClasses(registry, runtime);
    const Group = engine.classes.Group as new () => {
      clear(): void;
      matrixAutoUpdate: boolean;
      visible: boolean;
    };
    host[ENGINE_COST_KNOB] = true;
    engine.collect();
    const group = new Group();
    const before = engine.counters() as IGlueNumbers;
    // Two mirrored-and-engine getters, two flag bytes, two method wrappers.
    for (let read = 0; read < 2; read += 1) {
      expect(group.matrixAutoUpdate).toBe(true);
      expect(group.visible).toBe(true);
      group.clear();
    }
    const after = engine.counters() as IGlueNumbers;
    expect((after.propertyReads ?? 0) - (before.propertyReads ?? 0)).toBe(4);
    expect((after.methodCalls ?? 0) - (before.methodCalls ?? 0)).toBe(2);
    // The counter is not the crossing count: the flag reads cross nothing.
    expect(crossings.filter((call) => call === "get visible")).toHaveLength(0);
    expect(crossings.filter((call) => call === "get matrixAutoUpdate")).toHaveLength(2);
  });

  it("counts nothing on a shipped frame, where the knob is unset", () => {
    const { runtime } = countedRuntime();
    const engine = defineBrowserClasses(registry, runtime);
    const Group = engine.classes.Group as new () => {
      clear(): void;
      matrixAutoUpdate: boolean;
    };
    engine.collect();
    const before = engine.counters() as IGlueNumbers;
    const group = new Group();
    for (let read = 0; read < 3; read += 1) {
      void group.matrixAutoUpdate;
      group.clear();
    }
    const after = engine.counters() as IGlueNumbers;
    expect((after.methodCalls ?? 0) - (before.methodCalls ?? 0)).toBe(0);
    expect((after.propertyReads ?? 0) - (before.propertyReads ?? 0)).toBe(0);
  });
});
