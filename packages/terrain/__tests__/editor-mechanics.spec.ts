import { BoxGeometry, Mesh, Quaternion, Raycaster, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import type { Layer } from "../src/core/types.js";
import { landformPose, transformedLandform } from "../src/editor/landforms.js";
import { editorSurfaceHeight, pickEditorSurface } from "../src/editor/picking.js";

describe("editor heightfield picking", () => {
  it("subtracts the viewport offset and keeps the caller's target order", () => {
    const raycast = vi.fn<Parameters<typeof editorSurfaceHeight>[0]["raycast"]>();
    const renderer = {
      domElement: { getBoundingClientRect: () => ({ left: 90, top: 40 }) },
    };
    const targets = [new Mesh(), new Mesh()];
    expect(pickEditorSurface({ renderer, raycast }, targets, 120, 60)).toBeUndefined();
    const query = raycast.mock.calls[0]?.[0];
    expect(query?.screen?.toArray()).toEqual([30, 20]);
    expect(query?.targets).toBe(targets);
  });

  it("uses the rendered surface and returns undefined outside it", () => {
    const mesh = new Mesh(new BoxGeometry(10, 4, 10));
    const ray = new Raycaster();
    const raycast: Parameters<typeof editorSurfaceHeight>[0]["raycast"] = (query) => {
      if (!query?.origin || !query.direction) throw new Error("Missing downward ray");
      ray.set(query.origin, query.direction);
      return ray.intersectObject(mesh)[0];
    };
    expect(editorSurfaceHeight({ raycast }, mesh, 0, 0)).toBe(2);
    expect(editorSurfaceHeight({ raycast }, mesh, 20, 0)).toBeUndefined();
    expect(editorSurfaceHeight({ raycast }, mesh, 0, 0, 10000)).toBe(2);
    mesh.geometry.dispose();
  });
});

describe("landform gizmo math", () => {
  const layer: Layer = {
    id: "stamp-1",
    type: "stamp",
    params: { at: [10, 20], radius: [8, 9], offset: 3, scale: 2, rotation: 90 },
  };

  it("round-trips the terrain rotation convention and removes the surface anchor", () => {
    const pose = landformPose(layer, 100, 120);
    expect(pose).toBeDefined();
    if (!pose) throw new Error("Missing landform pose");
    const next = transformedLandform(
      layer,
      new Vector3(...pose.position).add(new Vector3(0, 7, 0)),
      pose.quaternion,
      new Vector3(...pose.scale),
      7,
    );
    expect(next.params).toMatchObject({ at: [10, 20], radius: [8, 9], offset: 3, scale: 2 });
    expect((next.params as typeof layer.params & { rotation: number }).rotation).toBeCloseTo(90);
  });

  it("writes heightmap half extents as full size and keeps unrelated parameters", () => {
    const heightmap: Layer = {
      id: "map",
      type: "heightmap",
      params: { blend: "replace", data: { width: 2, height: 2, values: [0, 0, 0, 0] } },
    };
    expect(landformPose(heightmap, 100, 120)?.scale).toEqual([50, 1, 50]);
    const next = transformedLandform(
      heightmap,
      new Vector3(5, 8, 6),
      new Quaternion(),
      new Vector3(4, 2, 3),
      5,
    );
    expect(next.params).toMatchObject({ size: [8, 6], at: [5, 6], offset: 3, blend: "replace" });
  });

  it("rejects overhangs, nonfinite coordinates and nonpositive scales", () => {
    const transform = (position: Vector3, rotation: Quaternion, scale: Vector3) =>
      transformedLandform(layer, position, rotation, scale, 0);
    expect(() =>
      transform(new Vector3(), new Quaternion(0.1, 0, 0, 1), new Vector3(1, 1, 1)),
    ).toThrow("overhanging");
    expect(() =>
      transform(new Vector3(Number.NaN, 0, 0), new Quaternion(), new Vector3(1, 1, 1)),
    ).toThrow("finite");
    expect(() => transform(new Vector3(), new Quaternion(), new Vector3(1, 0, 1))).toThrow(
      "positive",
    );
  });
});
