/**
 * The mergeGeometries port against three's own, both over the pinned three's classes: equal output
 * for indexed, non-indexed, grouped, morphed and interleaved input, and three's refusals. The engine
 * side is proved by runtime-native's player-imports test.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { defineBufferGeometryUtils } from "../src/addons/merge-geometries.js";

// Upstream three's own classes, untyped here: "three" maps to the engine's declarations.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);
const upstream: Loose = await import(
  pathToFileURL(fromCore.resolve("three/addons/utils/BufferGeometryUtils.js")).href
);
const port = defineBufferGeometryUtils(T);

const dump = (g: Loose) => {
  if (g === null) return null;
  const attribute = (a: Loose) => [
    a.array.constructor.name,
    Array.from(a.array),
    a.itemSize,
    a.normalized,
    a.gpuType,
  ];
  const each = (record: Record<string, Loose>, map: (value: Loose) => unknown) =>
    Object.fromEntries(Object.entries(record).map(([name, value]) => [name, map(value)]));
  return {
    index: g.index && attribute(g.index),
    attributes: each(g.attributes, attribute),
    morph: each(g.morphAttributes, (list: Loose[]) => list.map(attribute)),
    groups: g.groups,
  };
};
const both = (make: () => unknown[], useGroups = false) => [
  dump(upstream.mergeGeometries(make(), useGroups)),
  dump(port.mergeGeometries(make() as never, useGroups)),
];

describe("mergeGeometries", () => {
  it("merges indexed primitives with groups as three does", () => {
    const [three, ported] = both(
      () => [new T.BoxGeometry(1, 2, 3), new T.SphereGeometry(1, 5, 4), new T.PlaneGeometry()],
      true,
    );
    expect(ported).toEqual(three);
  });

  it("merges non-indexed parts, morph targets and an interleaved attribute as three does", () => {
    const make = () => {
      const a = new T.BoxGeometry().toNonIndexed();
      const b = new T.ConeGeometry(1, 2, 6).toNonIndexed();
      for (const g of [a, b]) {
        const position = g.getAttribute("position");
        g.morphAttributes.position = [position.clone()];
        const colors = new T.InterleavedBuffer(
          new Float32Array(position.count * 4).map((_, i) => i / 7),
          4,
        );
        g.setAttribute("color", new T.InterleavedBufferAttribute(colors, 3, 1));
      }
      return [a, b];
    };
    const [three, ported] = both(make);
    expect(ported).toEqual(three);
    expect(Object.keys((ported as { morph: object }).morph)).toEqual(["position"]);
  });

  it("refuses what three refuses, with three's message", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mixed = () => [new T.BoxGeometry(), new T.BoxGeometry().toNonIndexed()];
    expect(both(mixed)).toEqual([null, null]);
    expect(error.mock.calls[1]).toEqual(error.mock.calls[0]);
    const typed = () => {
      const a = new T.PlaneGeometry();
      const b = new T.PlaneGeometry();
      b.setAttribute("uv", new T.BufferAttribute(new Uint16Array(8), 2));
      return [a, b];
    };
    expect(both(typed)).toEqual([null, null]);
    expect(error.mock.calls.slice(2, 4)).toEqual(error.mock.calls.slice(4, 6));
    error.mockRestore();
  });

  // An engine geometry merges the index and attributes in one call (BufferGeometry::mergeFrom, proved
  // by runtime-native's geometry edges test); its refusal is logged with three's messages, and "?"
  // leaves the merge to the port.
  it("hands an engine geometry its parts in one __mergeFrom call and logs its refusal as three does", () => {
    const calls: unknown[][] = [];
    let answer = "";
    let writes = 0;
    class EngineGeometry extends T.BufferGeometry {
      __mergeFrom(...args: unknown[]) {
        calls.push(args);
        return answer;
      }
      setIndex(...args: unknown[]) {
        writes++;
        return super.setIndex(...args);
      }
      setAttribute(...args: unknown[]) {
        writes++;
        return super.setAttribute(...args);
      }
    }
    const engine = defineBufferGeometryUtils({
      BufferGeometry: EngineGeometry,
      BufferAttribute: T.BufferAttribute,
    });
    const parts = [new T.BoxGeometry(), new T.PlaneGeometry()];
    const merged = engine.mergeGeometries(parts as never, true) as Loose;
    expect(calls).toEqual([[parts, true, ["position", "normal", "uv"]]]);
    expect(writes).toBe(0);
    expect(merged.groups.map((g: Loose) => g.materialIndex)).toEqual([0, 1]);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const typed = () => {
      const a = new T.PlaneGeometry();
      a.setAttribute("uv", new T.BufferAttribute(new Uint16Array(8), 2));
      return [new T.PlaneGeometry(), a];
    };
    answer = "array\nuv";
    expect(engine.mergeGeometries(typed() as never)).toBeNull();
    upstream.mergeGeometries(typed());
    expect(error.mock.calls.length).toBe(4);
    expect(error.mock.calls.slice(0, 2)).toEqual(error.mock.calls.slice(2, 4));
    error.mockRestore();

    answer = "?";
    const fallback = () => [new T.BoxGeometry(), new T.SphereGeometry(1, 5, 4)];
    expect(dump(engine.mergeGeometries(fallback() as never))).toEqual(
      dump(upstream.mergeGeometries(fallback())),
    );
    expect(writes).toBe(4);
  });

  // An engine attribute's getX is one crossing per call, so the merged index reads each source
  // index's array once; the index type is still three's choice, Uint32 from 65535 up.
  it("builds a wide or narrow merged index from each index's array, not per element", () => {
    const part = (vertices: number, index: number[]) => {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(vertices * 3), 3));
      g.setIndex(index);
      return g;
    };
    const wide = () => [part(3, [0, 1, 2]), part(70000, [0, 69999, 1]), part(4, [3, 2, 1])];
    const narrow = () => [new T.PlaneGeometry(), new T.BoxGeometry()];
    const three = [wide, narrow].map((make) => dump(upstream.mergeGeometries(make())));
    const inputs = [wide(), narrow()];
    const getX = vi.spyOn(T.BufferAttribute.prototype, "getX");
    const ported = inputs.map((input) => dump(port.mergeGeometries(input as never)));
    const calls = getX.mock.calls.length;
    getX.mockRestore();
    expect(ported).toEqual(three);
    expect(ported.map((merged) => merged?.index?.[0])).toEqual(["Uint32Array", "Uint16Array"]);
    expect(calls).toBe(0);
  });
});
