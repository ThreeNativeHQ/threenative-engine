import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { speciesFor, standingBase } from "../src/render/props/pack.js";

const STARTER = join(import.meta.dirname, "../../../packages/terrain/starter-assets");

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

describe("a scanned prop stands on its scanned ground", () => {
  it("rests a fallen trunk on y = 0, with the branch that reached under the scan's ground buried", () => {
    // dead_tree_trunk_02 holds a branch 0.33 m below its scan ground: basing on that branch tip
    // lifted the whole trunk off the floor ("FLOATING TRUNKS").
    const lowest = lowestVertex("dead_tree_trunk_02/dead_tree_trunk_02.glb");
    expect(lowest).toBeLessThan(-0.3);
    const box = new Box3(new Vector3(-2, lowest, -0.5), new Vector3(2, 0.73, 0.5));
    expect(standingBase(box, "dead_tree_trunk_02/dead_tree_trunk_02.glb")).toBe(0);
    expect(standingBase(box, "tree_stump_01/tree_stump_01.glb")).toBe(0);
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
});
