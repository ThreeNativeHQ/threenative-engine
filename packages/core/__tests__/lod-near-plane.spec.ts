// One near plane, because two callers used `0.1` and the rest `0`: the same camera with no `near`
// answered two different questions about whether a sphere was degenerate. The change is confined to
// the band a `0.1` fallback used to call degenerate — a surface within ten centimetres of the camera
// — which is what makes it safe to state here rather than infer from a screenshot.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PerspectiveCamera, Sphere, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { LOD_NEAR_PLANE, selectLodFor } from "../src/model-lod.js";

const SOURCES = ["world-cell-chunks.ts", "geometry-capture.ts", "world-tiles.ts"];

describe("the LOD near plane", () => {
  it("should be one value, and zero", () => {
    expect(LOD_NEAR_PLANE).toBe(0);
  });

  it("should leave no caller carrying a near plane of its own", () => {
    const root = path.resolve(import.meta.dirname, "../src");
    const strays = SOURCES.flatMap((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      return /near[^;]*\?\?\s*0\.1/u.test(source) ? [file] : [];
    });
    expect(strays).toEqual([]);
  });

  it("should call degenerate only when the centre is at or behind the camera", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    // A surface ten centimetres ahead: not degenerate at 0, and it used to be at 0.1.
    const near = new Sphere(new Vector3(0, 0, -0.3), 0.2);
    expect(selectLodFor(camera, near, LOD_NEAR_PLANE).degenerate).toBe(false);
    // The camera is inside this one: degenerate either way.
    const inside = new Sphere(new Vector3(0, 0, 0), 1);
    expect(selectLodFor(camera, inside, LOD_NEAR_PLANE).degenerate).toBe(true);
  });
});
