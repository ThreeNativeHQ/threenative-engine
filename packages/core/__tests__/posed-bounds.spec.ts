import {
  Bone,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { measureThreePose, posedBounds } from "../src/pose-measure.js";

const vector3Allocations = vi.hoisted(() => ({ count: 0 }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    Vector3: class CountingVector3 extends actual.Vector3 {
      constructor(...args: ConstructorParameters<typeof actual.Vector3>) {
        super(...args);
        vector3Allocations.count += 1;
      }
    },
  };
});

/** A two-bone rig; `copies` repeats its four vertices to scale the vertex count. */
function rig(copies = 1): { root: Group; mesh: SkinnedMesh; hip: Bone } {
  const repeat = (values: number[]) => Array.from({ length: copies }, () => values).flat();
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(repeat([-0.1, 0, 0, 0.1, 0, 0, -0.1, 2, 0, 0.1, 2, 0]), 3),
  );
  geometry.setAttribute(
    "skinIndex",
    new Float32BufferAttribute(repeat([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new Float32BufferAttribute(repeat([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4),
  );

  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  const hip = new Bone();
  hip.name = "Hips";
  const crown = new Bone();
  crown.name = "HeadTop";
  crown.position.y = 1;
  hip.add(crown);
  mesh.add(hip);
  mesh.bind(new Skeleton([hip, crown]));

  const root = new Group();
  root.add(mesh);
  root.updateWorldMatrix(true, true);
  return { root, mesh, hip };
}

/** Counts reads of `key` made by pose-measure itself; three's own skinning reads it per vertex. */
function countMeasureReads(target: object, key: string): { reads: number } {
  // On the native host every property read crosses to the engine; `bones` wraps each bone.
  const value = (target as Record<string, unknown>)[key];
  const counter = { reads: 0 };
  Object.defineProperty(target, key, {
    get: () => {
      if (new Error().stack?.split("\n")[2]?.includes("pose-measure")) counter.reads += 1;
      return value;
    },
  });
  return counter;
}

describe("posedBounds", () => {
  it("calibrates upright static copies from shared geometry bounds without walking every vertex", () => {
    const geometry = new BoxGeometry(2, 4, 3);
    geometry.translate(0, 3, 0);
    const material = new MeshBasicMaterial();
    for (const scale of [0.5, 2, -1]) {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(4, 7, -3);
      mesh.rotation.y = 0.7;
      mesh.scale.setScalar(scale);
      const vertices = vi.spyOn(mesh, "getVertexPosition");
      const bounds = posedBounds(mesh);
      expect(bounds.min[1]).toBeCloseTo(7 + (scale < 0 ? 5 : 1) * scale, 6);
      expect(vertices).not.toHaveBeenCalled();
    }
  });

  it("still measures the exact lowest vertex on a tilted static copy", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 3, 0], 3));
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.rotation.z = -Math.PI / 4;
    const vertices = vi.spyOn(mesh, "getVertexPosition");
    expect(posedBounds(mesh).min[1]).toBeCloseTo(-Math.SQRT2, 6);
    expect(vertices).not.toHaveBeenCalled();
  });

  it("tracks the posed skeleton instead of returning the bind-pose box", () => {
    const { root, mesh, hip } = rig();
    const bindCheapMin = posedBounds(root, [mesh]).min[1];
    const bindPreciseMin = measureThreePose(root, { bounds: [mesh] }).bounds?.min[1] ?? 0;

    hip.position.y = 0.5;
    root.updateWorldMatrix(true, true);
    const posed = posedBounds(root, [mesh]);
    const precise = measureThreePose(root, { bounds: [mesh] }).bounds;

    expect(precise).not.toBeNull();
    expect(Math.abs(posed.min[1] - bindCheapMin)).toBeGreaterThan(0.05);
    expect(Math.abs((precise?.min[1] ?? 0) - bindPreciseMin)).toBeGreaterThan(0.05);
    expect(Math.abs(posed.min[1] - (precise?.min[1] ?? 0))).toBeLessThanOrEqual(0.02);
  });

  it("stays within two centimetres of precise bounds across a posed animation", () => {
    const { root, mesh, hip } = rig();
    posedBounds(root, [mesh]);

    for (let frame = 0; frame < 30; frame += 1) {
      hip.position.y = Math.sin(frame / 5) * 0.5;
      root.updateWorldMatrix(true, true);
      const cheap = posedBounds(root, [mesh]);
      const precise = measureThreePose(root, { bounds: [mesh] }).bounds;
      expect(precise).not.toBeNull();
      expect(Math.abs(cheap.min[1] - (precise?.min[1] ?? 0))).toBeLessThanOrEqual(0.02);
    }
  });

  it("reads the skeleton's bones once per mesh, not once per vertex", () => {
    const { root, mesh } = rig();
    const bones = countMeasureReads(mesh.skeleton, "bones");

    posedBounds(root, [mesh]);

    expect(bones.reads).toBe(1);
  });

  it("reads world matrices a fixed number of times, whatever the vertex count", () => {
    const worldReads = (copies: number) => {
      const { root, mesh, hip } = rig(copies);
      const counters = [mesh, hip, hip.children[0] as Bone].map((object) =>
        countMeasureReads(object, "matrixWorld"),
      );
      posedBounds(root, [mesh]);
      return counters.map((counter) => counter.reads);
    };

    expect(worldReads(25)).toEqual(worldReads(1));
  });

  it("skips a vertex whose dominant bone the skeleton lacks", () => {
    const { root, mesh } = rig();
    // With every weight zero, skinning ignores the index and the dominant one names no bone.
    mesh.geometry.getAttribute("skinIndex").setX(3, 7);
    mesh.geometry.getAttribute("skinWeight").setX(3, 0);

    const bounds = posedBounds(root, [mesh]);

    expect([...bounds.min, ...bounds.max].every(Number.isFinite)).toBe(true);
  });

  it("does not reuse an explicit subset for an unscoped measurement", () => {
    const { root, mesh } = rig();
    const other = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    other.position.x = 10;
    root.add(other);

    const subset = posedBounds(root, [mesh]);
    const all = posedBounds(root);

    expect(all).not.toBe(subset);
    expect(all.max[0]).toBeGreaterThan(9);
  });

  it("reuses its result and does not allocate a bounds object per call", () => {
    const { root, mesh } = rig();
    const first = posedBounds(root, [mesh]);
    const constructionAllocations = vector3Allocations.count;
    expect(constructionAllocations).toBeGreaterThan(0);
    let observedY = first.min[1];

    for (let index = 0; index < 1_000; index += 1) {
      const result = posedBounds(root, [mesh]);
      expect(result).toBe(first);
      observedY = result.min[1];
    }

    expect(observedY).toBe(first.min[1]);
    expect(vector3Allocations.count).toBe(constructionAllocations);
  });
});
