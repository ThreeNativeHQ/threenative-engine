/**
 * PRD-803 phase 1 pin: the file a bridge counter attributes to a call.
 *
 * A census frame names the frame *above* the back end (`bridge-meter.ts`'s frame filter), and a
 * counter's source record is registered with the same attribution (`debug-telemetry.ts`). Both must
 * name the game's frame, never a file of the back end: a crossing the back end makes on a game's
 * behalf is not the game's own read, and a report that names the back end sends its reader to the
 * wrong file. The counter records added with no caller name the source file that adds them.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const REPO = process.cwd();
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;
const backEndFiles = new Set(readdirSync(path.join(REPO, "packages/three-native/src")));

interface ISources {
  __tnDebugSources?: Record<string, { caller?: string }>;
}
const sources = (): Record<string, { caller?: string }> => {
  const host = globalThis as ISources;
  host.__tnDebugSources ??= {};
  return host.__tnDebugSources;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** An engine over plain maps: every get, set and call is logged, and a member ref is made on demand. */
function fakeRuntime() {
  const types = new Map<string, number>();
  const values = new Map<string, Map<string, EngineValue>>();
  const calls: string[] = [];
  let next = 0;
  const typeId = (name: string): number => {
    let id = types.get(name);
    if (id === undefined) {
      id = types.size + 1;
      types.set(name, id);
    }
    return id;
  };
  const make = (name: string): IEngineRef => {
    next += 1;
    const ref = { key: `${name}:${next}`, type: typeId(name) };
    values.set(ref.key, new Map());
    return ref;
  };
  const runtime: IBrowserRuntime = {
    typeId,
    construct(name, args) {
      const ref = make(name);
      if (typeof args[1] === "number") values.get(ref.key)?.set("intensity", args[1]);
      return ref;
    },
    invoke(_self, method) {
      calls.push(`call ${method}`);
      return null;
    },
    get(self, property) {
      if (property === "__address") return Number(self.key.split(":")[1]) * 32;
      // A fixed member the engine hands over as its own object.
      if (property === "rotation" || property === "quaternion")
        return make(property === "quaternion" ? "Quaternion" : "Euler");
      calls.push(`get ${property}`);
      return values.get(self.key)?.get(property) ?? (property === "name" ? "" : 1);
    },
    set(self, property, value) {
      calls.push(`set ${property}`);
      values.get(self.key)?.set(property, value);
    },
    release() {},
    setCallback() {},
    readDoubles: (_address, count) => (count === 1 ? 0 : [0]),
    readByte: () => 0,
    writeDouble() {},
  };
  return { runtime, calls };
}

describe("the frame a bridge counter attributes a fixed call to", () => {
  it("names the caller of a method call and the value class's view write, not the back end", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {});
    const { runtime, calls } = fakeRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Mesh = classes.Mesh as new () => {
      rotation: { _order: string };
      applyMatrix4(matrix: object): void;
    };
    const Matrix4 = classes.Matrix4 as new () => object;
    const mesh = new Mesh();
    // Named, so the attribution can be read back: every frame between these calls and the counter
    // is the back end's own (the method wrapper, the argument's marshalling, the engine view).
    function promoteMatrix(): void {
      mesh.applyMatrix4(new Matrix4());
      mesh.rotation._order = "YXZ";
    }
    promoteMatrix();
    expect(calls).toContain("set order");
    for (const label of ["bridge:call Mesh.applyMatrix4", "bridge:set Euler.order"]) {
      const caller = sources()[label]?.caller;
      expect(caller, label).toContain("promoteMatrix");
      expect(caller, label).not.toMatch(/browser-[a-z-]*\.ts/u);
    }
  });

  it("names the source file that adds a counter which gives no caller", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {});
    const { runtime } = fakeRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Group = classes.Group as new () => object;
    new Group();
    const caller = sources().bridgeWrappersCreated?.caller;
    expect(caller).toMatch(/^browser(?:-[a-z-]+)?\.ts$/u);
    expect(backEndFiles.has(caller as string)).toBe(true);
  });
});
