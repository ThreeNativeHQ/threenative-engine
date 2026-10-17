/**
 * A game writes `visible` on hundreds of nodes every frame, nearly all to the value they hold. The
 * engine's setter ignores such a write, so crossing the bridge for it costs a call and changes nothing:
 * the back end compares against the flag byte it already reads from engine memory and keeps those home.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

/** Engine memory is one byte array: an object's flags sit at its address, `visible` first. */
function flagRuntime() {
  const heap = new Uint8Array(256);
  const calls: string[] = [];
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId: () => 1,
    construct(name) {
      heap[next * 8] = 1; // visible, as the engine's Object3D starts
      return { key: `${name}:${next++}`, type: 1 };
    },
    invoke: () => null,
    get(self, property) {
      if (property === "__address") return Number(self.key.split(":")[1]) * 8;
      throw new Error(`unexpected get ${property}`);
    },
    set(self: IEngineRef, property, value) {
      calls.push(`set ${property}`);
      if (property === "visible") heap[Number(self.key.split(":")[1]) * 8] = value ? 1 : 0;
    },
    release: () => undefined,
    setCallback: () => undefined,
    readDoubles: () => 0,
    readByte: (address) => heap[address] as number,
  };
  return { runtime, calls };
}

describe("flag writes on the browser back end", () => {
  it("keeps a write of the value a flag already holds out of the engine", () => {
    const { runtime, calls } = flagRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Group = classes.Group as new () => { visible: boolean };
    const group = new Group();
    for (let frame = 0; frame < 100; frame += 1) group.visible = true;
    expect(calls.filter((call) => call === "set visible")).toHaveLength(0);
    group.visible = false;
    group.visible = false;
    expect(group.visible).toBe(false);
    group.visible = true;
    expect(group.visible).toBe(true);
    expect(calls.filter((call) => call === "set visible")).toHaveLength(2);
  });
});
