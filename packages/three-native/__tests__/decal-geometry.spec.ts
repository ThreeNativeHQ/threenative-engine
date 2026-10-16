/**
 * The DecalGeometry port against three's own, both over the pinned three's classes: equal positions,
 * normals and uvs for indexed and non-indexed meshes, with and without normals. The engine side is
 * proved by runtime-native's player-imports test.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { defineDecalGeometry } from "../src/addons/decal.js";

// Upstream three's own classes, untyped here: "three" maps to the engine's declarations.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);
const upstream: Loose = await import(
  pathToFileURL(fromCore.resolve("three/addons/geometries/DecalGeometry.js")).href
);
const { DecalGeometry: Port } = defineDecalGeometry(T);

const arrays = (geometry: Loose) =>
  Object.fromEntries(
    ["position", "normal", "uv"].map((name) => [
      name,
      geometry.getAttribute(name) ? Array.from(geometry.getAttribute(name).array) : null,
    ]),
  );

const wall = (geometry: Loose) => {
  const mesh = new T.Mesh(geometry, new T.MeshBasicMaterial());
  mesh.position.set(0.3, -0.2, 0);
  mesh.rotation.set(0.1, 0.4, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
};

describe("DecalGeometry port", () => {
  const projector = [
    new T.Vector3(0.2, 0, 0.9),
    new T.Euler(0.2, -0.3, 0.1),
    new T.Vector3(1, 0.8, 1),
  ];

  it("matches three on an indexed mesh with normals", () => {
    const mesh = wall(new T.BoxGeometry(2, 2, 2, 3, 3, 3));
    const expected = arrays(new upstream.DecalGeometry(mesh, ...projector));
    expect(expected.position?.length).toBeGreaterThan(0);
    expect(arrays(new Port(mesh, ...projector))).toEqual(expected);
  });

  it("matches three on a non-indexed mesh and on one without normals", () => {
    const onPlane = [new T.Vector3(0.2, 0, 0.1), projector[1], projector[2]];
    const flat = wall(new T.PlaneGeometry(3, 3, 4, 4).toNonIndexed());
    const expected = arrays(new upstream.DecalGeometry(flat, ...onPlane));
    expect(expected.position?.length).toBeGreaterThan(0);
    expect(arrays(new Port(flat, ...onPlane))).toEqual(expected);
    const bare = wall(new T.PlaneGeometry(3, 3, 4, 4));
    bare.geometry.deleteAttribute("normal");
    const out = arrays(new Port(bare, ...onPlane));
    expect(out.normal).toBeNull();
    expect(out.position?.length).toBeGreaterThan(0);
    expect(out).toEqual(arrays(new upstream.DecalGeometry(bare, ...onPlane)));
  });

  it("is empty when the projector misses the mesh", () => {
    const mesh = wall(new T.PlaneGeometry(1, 1));
    const miss = new Port(mesh, new T.Vector3(0, 0, 9), new T.Euler(), new T.Vector3(1, 1, 1));
    expect(arrays(miss).position).toEqual([]);
  });
});
