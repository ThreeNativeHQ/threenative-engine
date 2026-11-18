/**
 * PRD-573 web: the safe point's cost. Midway holds about 50,000 scene-attached wrappers, and asking an
 * eighth of them every frame cost 2.5 ms of a 21 ms frame. A wrapper the engine keeps referencing
 * settles into a slow lane, so a steady scene costs a sixty-fourth per safe point, while a wrapper
 * just handed out is asked at the very next safe point.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const catalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

type Constructor = new (...args: unknown[]) => object;

/** An engine that references every key in `referenced` and records how many refs each safe point asks. */
function countingRuntime(referenced: Set<string>, asked: number[]): IBrowserRuntime {
  const types = new Map<string, number>();
  let next = 0;
  return {
    typeId(name) {
      if (!types.has(name)) types.set(name, types.size + 1);
      return types.get(name) as number;
    },
    construct(name) {
      return { key: `${name}:0:${++next}:1`, type: types.get(name) ?? 0 };
    },
    invoke: (): EngineValue => null,
    get: (): EngineValue => 0,
    set() {},
    release() {},
    setCallback() {},
    engineReferences(refs: readonly IEngineRef[]) {
      asked.push(refs.length);
      return refs.map((ref) => (referenced.has(ref.key) ? 1 : 0));
    },
  };
}

describe("browser back end safe point cost", () => {
  it("asks a settled scene a sixty-fourth per safe point, not an eighth", () => {
    const referenced = new Set<string>();
    const asked: number[] = [];
    const { classes, collect } = defineBrowserClasses(
      registry,
      countingRuntime(referenced, asked),
      catalog,
    );
    const nodes = attached(classes, 6400);
    for (const node of nodes)
      referenced.add((node as unknown as Record<symbol, IEngineRef>)[refSymbol(node)]?.key ?? "");
    collect(); // the first safe point asks every new wrapper once, and they settle
    asked.length = 0;
    for (let i = 0; i < 50; i++) collect();
    expect(Math.max(...asked)).toBeLessThanOrEqual(Math.ceil(6400 / 64));
    expect(Math.min(...asked)).toBeGreaterThan(0);
  });

  it("asks a wrapper handed out since the last safe point at the next one", () => {
    const referenced = new Set<string>();
    const asked: number[] = [];
    const { classes, collect } = defineBrowserClasses(
      registry,
      countingRuntime(referenced, asked),
      catalog,
    );
    const [fresh] = attached(classes, 1) as [object];
    referenced.add((fresh as unknown as Record<symbol, IEngineRef>)[refSymbol(fresh)]?.key ?? "");
    collect();
    expect(asked).toEqual([1]);
  });

  it("releases a settled wrapper the engine let go within two passes", () => {
    const referenced = new Set<string>();
    const asked: number[] = [];
    const { classes, collect } = defineBrowserClasses(
      registry,
      countingRuntime(referenced, asked),
      catalog,
    );
    const nodes = attached(classes, 640);
    const keys = nodes.map(
      (node) => (node as unknown as Record<symbol, IEngineRef>)[refSymbol(node)]?.key ?? "",
    );
    for (const key of keys) referenced.add(key);
    collect();
    for (const key of keys) referenced.delete(key); // the engine lets every one go
    asked.length = 0;
    for (let i = 0; i < 2 * 64 + 2; i++) collect();
    expect(asked.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(640);
    asked.length = 0;
    collect();
    collect();
    expect(asked.length === 0 || asked.every((n) => n === 0)).toBe(true); // nothing held is left to ask
  });
});

/** Groups handed to the engine (a parent's add), which is what holds a wrapper until a safe point decides. */
function attached(classes: Record<string, Constructor>, count: number): object[] {
  const root = new (classes.Group as Constructor)() as { add(...nodes: object[]): void };
  const nodes = Array.from({ length: count }, () => new (classes.Group as Constructor)());
  for (const node of nodes) root.add(node);
  return nodes;
}

/** The wrapper's engine-ref symbol, found by its description (the symbol itself is private). */
function refSymbol(wrapper: object): symbol {
  const found = Object.getOwnPropertySymbols(wrapper).find((s) => s.description === "tn.engineRef");
  if (found === undefined) throw new Error("wrapper carries no engine ref");
  return found;
}

// PRD-898 J5: the settled set is asked only when the engine ownership epoch moved, as the V8 adapter does.
/** A runtime whose engine references every wrapper, with an ownership epoch the test moves. */
function settledRuntime() {
  const types = new Map<string, number>();
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const asked: number[] = [];
  const state = { epoch: 0 };
  const runtime: IBrowserRuntime = {
    typeId,
    construct: (name) => ({ key: `${name}:${types.size}`, type: typeId(name) }),
    invoke: () => null,
    get: () => null,
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
    engineReferences: (refs) => {
      asked.push(refs.length);
      return refs.map(() => 1);
    },
    ownershipEpoch: () => state.epoch,
  };
  return { runtime, asked, state, typeId };
}

describe("the web safe point (PRD-898 J5)", () => {
  it("asks nothing about settled wrappers while the ownership epoch stands still", () => {
    const { runtime, asked, state, typeId } = settledRuntime();
    const engine = defineBrowserClasses(registry, runtime);
    const kept = Array.from({ length: 200 }, (_, i) =>
      engine.wrap({ key: `Group:${i}`, type: typeId("Group") }),
    );
    engine.collect();
    expect(asked).toEqual([200]); // every new wrapper is asked once, and settles
    // Two whole passes with the epoch unmoved retire the pass that was due at start.
    for (let frame = 0; frame < 2 * 64 + 2; frame += 1) engine.collect();
    asked.length = 0;
    for (let frame = 0; frame < 100; frame += 1) engine.collect();
    expect(asked).toEqual([]);

    // The engine may have let one go: the settled set is asked again, a pass at a time.
    state.epoch += 1;
    engine.collect();
    expect(asked).toEqual([Math.ceil(200 / 64)]);
    expect(kept).toHaveLength(200);
  });

  it("still asks a wrapper handed out since the last safe point, epoch or not", () => {
    const { runtime, asked, typeId } = settledRuntime();
    const engine = defineBrowserClasses(registry, runtime);
    engine.collect();
    for (let frame = 0; frame < 4; frame += 1) engine.collect();
    asked.length = 0;
    const fresh = engine.wrap({ key: "Group:fresh", type: typeId("Group") });
    engine.collect();
    expect(asked).toEqual([1]);
    expect(fresh).toBeDefined();
  });
});
