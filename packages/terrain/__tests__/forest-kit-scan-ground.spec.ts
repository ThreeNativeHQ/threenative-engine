import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { speciesFor, standingBase } from "../starter/forest/render/props/pack.js";

const STARTER = join(import.meta.dirname, "../starter-assets");

/** Every vertex of a starter GLB, read from its float POSITION accessors. */
function vertices(path: string): [number, number, number][] {
  const bytes = readFileSync(join(STARTER, path));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const bin = bytes.subarray(20 + jsonLength + 8);
  const out: [number, number, number][] = [];
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) {
      const accessor = json.accessors[primitive.attributes.POSITION];
      const view = json.bufferViews[accessor.bufferView];
      const stride = view.byteStride ?? 12;
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let i = 0; i < accessor.count; i++) {
        const at = start + i * stride;
        out.push([bin.readFloatLE(at), bin.readFloatLE(at + 4), bin.readFloatLE(at + 8)]);
      }
    }
  return out;
}

const lowestVertex = (path: string) => Math.min(...vertices(path).map((v) => v[1]));

/** The underside of a model in eight slices along its longest horizontal side. */
function undersides(path: string): number[] {
  const points = vertices(path);
  const span = (k: 0 | 2) =>
    Math.max(...points.map((v) => v[k])) - Math.min(...points.map((v) => v[k]));
  const axis = span(0) >= span(2) ? 0 : 2;
  const lo = Math.min(...points.map((v) => v[axis]));
  const step = span(axis) / 8;
  return Array.from({ length: 8 }, (_, i) =>
    Math.min(
      ...points
        .filter((v) => v[axis] >= lo + i * step && v[axis] <= lo + (i + 1) * step)
        .map((v) => v[1]),
    ),
  );
}

describe("the forest kit: a scanned prop stands on its scanned ground", () => {
  it("rests a stump on y = 0, with the roots that reach under the scan's ground buried", () => {
    // tree_stump_01 holds roots 0.19 m below its scan ground: basing on a root tip lifted the
    // whole stump off the floor ("FLOATING TRUNKS").
    const lowest = lowestVertex("tree_stump_01/tree_stump_01.glb");
    expect(lowest).toBeLessThan(-0.15);
    const box = new Box3(new Vector3(-1, lowest, -1), new Vector3(1, 1.2, 1));
    expect(standingBase(box, "tree_stump_01/tree_stump_01.glb")).toBe(0);
    expect(standingBase(box, "dead_tree_trunk/dead_tree_trunk.glb")).toBe(0);
  });
  it("keeps the lowest vertex as the base for licensed art, whose origin is not its ground", () => {
    const box = new Box3(new Vector3(-1, 0.4, -1), new Vector3(1, 3, 1));
    expect(standingBase(box, "fern/0")).toBe(0.4);
    const below = new Box3(new Vector3(-1, -0.2, -1), new Vector3(1, 3, 1));
    expect(standingBase(below, "landscape-pro/deadfall_a")).toBe(-0.2);
  });
  it("never lifts a scan whose lowest vertex is above its origin", () => {
    const box = new Box3(new Vector3(-1, 0.05, -1), new Vector3(1, 1, 1));
    expect(standingBase(box, "boulder_01/boulder-near.glb")).toBe(0.05);
  });
  it("draws only fallen wood that lies along its scan ground, so no log props itself up in the air", () => {
    // dead_tree_trunk_02 was scanned propped on a branch: its far half rides 0.23 m over its ground.
    const wood = speciesFor("forest").filter((one) => one.asset === "deadfall");
    expect(wood.length).toBe(4);
    for (const one of wood) {
      const lifted = Math.max(
        ...undersides(one.path).map((y) => y - Math.max(0, lowestVertex(one.path))),
      );
      expect(lifted, one.path).toBeLessThan(0.1);
    }
  });
  it("draws no fallen wood wider than 1.7 m across, so none spans between trunks or lies on a slope as a slab", () => {
    // root_cluster_01 is a 4.1 x 2.7 m root plate: it cut through standing trunks and lay on shore
    // slopes as one flat brown slab.
    for (const one of speciesFor("forest").filter((row) => row.asset === "deadfall")) {
      const points = vertices(one.path);
      const span = (k: 0 | 2) =>
        Math.max(...points.map((v) => v[k])) - Math.min(...points.map((v) => v[k]));
      const across = (Math.min(span(0), span(2)) * one.metres) / Math.max(span(0), span(2));
      expect(across, one.path).toBeLessThan(1.7);
    }
  });
});
