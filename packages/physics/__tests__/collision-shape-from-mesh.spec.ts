import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  type Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";

/**
 * One quad strip of two quads, so a trimesh has an internal edge to carry: what a collider built
 * from the drawn triangles of a band looks like, in eight vertices instead of 95 232.
 */
function bandGeometry(): BufferGeometry {
  const positions = new Float32Array([
    0, 0.5, 0, 1, 0.25, 0, 1, 0.25, 1, 0, 0.5, 1, 2, -0.125, 0, 3, -0.75, 0, 3, -0.75, 1, 2, -0.125,
    1,
  ]);
  const indices = new Uint32Array([
    0, 1, 4, 1, 5, 4, 1, 2, 5, 2, 6, 5, 2, 3, 6, 3, 7, 6, 3, 0, 7, 0, 4, 7,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/** The reference: what `fromMesh` read before it had a fast path, spelled out in the test. */
function getterVertices(mesh: Mesh): Float32Array {
  const position = mesh.geometry.getAttribute("position");
  if (position === undefined) throw new Error("the fixture has no positions");
  const vertices = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) {
    vertices[index * 3] = position.getX(index) * mesh.scale.x;
    vertices[index * 3 + 1] = position.getY(index) * mesh.scale.y;
    vertices[index * 3 + 2] = position.getZ(index) * mesh.scale.z;
  }
  return vertices;
}

function getterIndices(mesh: Mesh): Uint32Array {
  const index = mesh.geometry.getIndex();
  if (index === null) throw new Error("the fixture has no index");
  return Uint32Array.from({ length: index.count }, (_, offset) => index.getX(offset));
}

function trimesh(geometry: BufferGeometry, scale?: Vector3): CollisionShape3D {
  const mesh = new Mesh(geometry);
  if (scale !== undefined) mesh.scale.copy(scale);
  return CollisionShape3D.fromMesh(mesh, "trimesh");
}

describe("CollisionShape3D.fromMesh trimesh extraction", () => {
  it("reads a plain attribute's own array, with no per-element getter", () => {
    const geometry = bandGeometry();
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    if (index === null || position === undefined) throw new Error("the fixture is incomplete");
    const positionGetter = vi.spyOn(position, "getX");
    const indexGetter = vi.spyOn(index, "getX");

    const shape = trimesh(geometry);

    expect(positionGetter).not.toHaveBeenCalled();
    expect(indexGetter).not.toHaveBeenCalled();
    expect(shape.descriptor.vertices).toEqual(getterVertices(new Mesh(bandGeometry())));
    expect(shape.descriptor.indices).toEqual(getterIndices(new Mesh(bandGeometry())));
  });

  // A scaled mesh is the arm the plain copy cannot take: the numbers still have to be the getters'.
  it("matches the getters exactly for a plain attribute under a non-unit scale", () => {
    const mesh = new Mesh(bandGeometry());
    mesh.scale.set(1.5, -2, 0.5);

    const shape = CollisionShape3D.fromMesh(mesh, "trimesh");

    expect(shape.descriptor.vertices).toEqual(getterVertices(mesh));
    expect(shape.descriptor.indices).toEqual(getterIndices(mesh));
  });

  // Interleaving and normalisation are what `getX` exists for: the direct read would take the
  // neighbour's lane or the stored integer, so these keep the getter path.
  it("keeps the getter path for an interleaved attribute", () => {
    const geometry = bandGeometry();
    const source = geometry.getAttribute("position");
    if (source === undefined) throw new Error("the fixture has no positions");
    const interleaved = new InterleavedBufferAttribute(
      new InterleavedBuffer(new Float32Array(source.array), 3),
      3,
      0,
    );
    geometry.setAttribute("position", interleaved);
    const getter = vi.spyOn(interleaved, "getX");
    const mesh = new Mesh(geometry);

    const shape = CollisionShape3D.fromMesh(mesh, "trimesh");

    expect(getter).toHaveBeenCalled();
    expect(shape.descriptor.vertices).toEqual(getterVertices(mesh));
  });

  it("keeps the getter path for a normalised attribute", () => {
    const geometry = bandGeometry();
    const source = geometry.getAttribute("position");
    if (source === undefined) throw new Error("the fixture has no positions");
    const scaled = Float32Array.from(source.array, (value) => Math.round((value + 1) * 30000));
    const normalised = new BufferAttribute(Uint16Array.from(scaled), 3, true);
    geometry.setAttribute("position", normalised);
    const getter = vi.spyOn(normalised, "getX");
    const mesh = new Mesh(geometry);

    const shape = CollisionShape3D.fromMesh(mesh, "trimesh");

    expect(getter).toHaveBeenCalled();
    expect(shape.descriptor.vertices).toEqual(getterVertices(mesh));
  });
});
