import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SkinnedMesh,
  Sphere,
} from "three";
import { describe, expect, it } from "vitest";
import type { IResolvedAsset } from "../src/assets.js";
import { GEOMETRY_ASSET_KEY, GeometryCapture } from "../src/geometry-capture.js";
import { INSTANCED_MODEL_DEFAULT_CELL_SIZE, InstancedModel } from "../src/instanced-model.js";
import { DiscreteLodPlugin, TN_DISCRETE_LOD, updateModelLods } from "../src/model-lod.js";
import {
  measureStartupOffscreenBytes,
  measureUnusedModels,
} from "../src/startup-offscreen-bytes.js";

function spawnCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 500);
  camera.updateMatrixWorld(true);
  return camera;
}

async function bakedTriangleModel(): Promise<{ source: Group; material: MeshBasicMaterial }> {
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.name = "body";
  const source = new Group();
  source.userData[GEOMETRY_ASSET_KEY] = "props/office.glb";
  geometry.userData[GEOMETRY_ASSET_KEY] = "props/office.glb";
  source.add(mesh);

  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map([[mesh, { meshes: 0, primitives: 0 }]]),
    getDependency: async () => ({ array: new Uint32Array([0, 1, 2, 0, 2, 3]) }),
    json: {
      meshes: [
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: {
                  schemaVersion: 1,
                  lod0Triangles: 12,
                  counts: [2],
                  errors: [0.1],
                  absoluteErrors: [0.1],
                  indices: [0],
                },
              },
            },
          ],
        },
      ],
    },
  });
  await plugin.afterRoot({});
  plugin.attach(source, undefined);
  return { source, material };
}

describe("InstancedModel", () => {
  it("keeps nested child transforms and multi-material sections accurate on every placement", () => {
    const hullMat = new MeshBasicMaterial({ color: 0x334455 });
    hullMat.name = "hull";
    const trimMat = new MeshBasicMaterial({ color: 0xaa8822 });
    trimMat.name = "trim";

    // Multi-material root mesh with 2 geometry groups.
    const baseGeom = new BoxGeometry(2, 1, 2);
    const totalIndices = baseGeom.index?.count ?? 0;
    baseGeom.clearGroups();
    baseGeom.addGroup(0, totalIndices / 2, 0);
    baseGeom.addGroup(totalIndices / 2, totalIndices / 2, 1);

    const source = new Group();
    source.position.set(100, 0, 50); // source's own world offset must cancel out
    const body = new Mesh(baseGeom, [hullMat, trimMat]);
    body.name = "chassis";
    const turret = new Group();
    turret.position.set(0, 2, 0);
    const antenna = new Mesh(new BoxGeometry(0.2, 2, 0.2), trimMat);
    antenna.name = "antenna";
    antenna.position.set(0.5, 1, -0.5);
    turret.add(antenna);
    source.add(body, turret);

    const model = new InstancedModel({ source, cellSize: false });
    model.place({ position: [10, 0, -20] });
    model.place({ position: [-10, 0, -20], rotation: [0, Math.PI / 2, 0] });
    expect(model.count).toBe(2);

    const scene = new Group();
    const built = model.build({ name: "tower", parent: scene, castShadow: true });
    expect(built).toHaveLength(3); // 2 material slices from body + 1 antenna
    expect(scene.children).toHaveLength(3);
    expect(built.every((mesh) => mesh.castShadow && !mesh.receiveShadow)).toBe(true);
    expect(model.meshes).toEqual(built);

    const antennaBatch = built.find((m) => m.name.includes("antenna"));
    if (antennaBatch === undefined) throw new Error("missing antenna batch");
    expect(antennaBatch.count).toBe(2);
    const mat0 = new Matrix4();
    antennaBatch.getMatrixAt(0, mat0);
    // Placement (10, 0, -20) + turret (0, 2, 0) + antenna (0.5, 1, -0.5)
    expect(mat0.elements[12]).toBeCloseTo(10.5, 5);
    expect(mat0.elements[13]).toBeCloseTo(3, 5);
    expect(mat0.elements[14]).toBeCloseTo(-20.5, 5);

    const mat1 = new Matrix4();
    antennaBatch.getMatrixAt(1, mat1);
    // +90 deg around Y rotates local (+0.5, +3, -0.5) -> (-0.5, +3, -0.5)
    expect(mat1.elements[12]).toBeCloseTo(-10.5, 5);
    expect(mat1.elements[13]).toBeCloseTo(3, 5);
    expect(mat1.elements[14]).toBeCloseTo(-20.5, 5);
  });

  it("stamps material-section slices without writing provenance back onto the source geometry", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const half = (geometry.index?.count ?? 0) / 2;
    geometry.clearGroups();
    geometry.addGroup(0, half, 0);
    geometry.addGroup(half, half, 1);
    const source = new Group();
    source.userData[GEOMETRY_ASSET_KEY] = "props/sign.glb";
    source.add(new Mesh(geometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]));

    const model = new InstancedModel({ source, cellSize: false });
    model.place({ position: [0, 0, 0] });
    const built = model.build();

    expect(built.map((mesh) => mesh.geometry.userData[GEOMETRY_ASSET_KEY])).toEqual([
      "props/sign.glb",
      "props/sign.glb",
    ]);
    expect(geometry.userData[GEOMETRY_ASSET_KEY]).toBeUndefined();
  });

  it("buckets spread-out placements into spatial XZ cells for frustum culling", () => {
    expect(INSTANCED_MODEL_DEFAULT_CELL_SIZE).toBe(48);
    const source = new Group();
    source.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));

    const model = new InstancedModel({ source, cellSize: 40 });
    // Two placements inside the front-facing frustum cell, one far behind camera.
    model.place({ position: [10, 0, -20] });
    model.place({ position: [5, 0, -25] });
    model.place({ position: [0, 0, 120] });

    const scene = new Group();
    const built = model.build({ name: "building", parent: scene });
    expect(built).toHaveLength(2);

    const camera = spawnCamera();
    scene.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const visible = built.filter((mesh) => {
      const worldSphere = (mesh.boundingSphere ?? new Sphere())
        .clone()
        .applyMatrix4(mesh.matrixWorld);
      return frustum.intersectsSphere(worldSphere);
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.count).toBe(2);
  });

  it("propagates root and geometry provenance through unused checks, offscreen checks and geometry capture", async () => {
    const source = new Group();
    source.userData[GEOMETRY_ASSET_KEY] = "city/storefront.glb";
    // Child geometries intentionally left unstamped to test root-only provenance survival.
    source.add(new Mesh(new BoxGeometry(2, 4, 2), new MeshBasicMaterial()));
    source.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));

    const model = new InstancedModel({ source });
    model.place({ position: [0, 0, -15] });
    const scene = new Group();
    const built = model.build({ name: "stores", parent: scene });
    expect(built.every((mesh) => mesh.userData[GEOMETRY_ASSET_KEY] === "city/storefront.glb")).toBe(
      true,
    );

    const resolved = new Map<string, IResolvedAsset>([
      [
        "city/storefront.glb",
        { bytes: 42_000, kind: "model", url: "/city/storefront.glb", via: "manifest" },
      ],
    ]);
    scene.updateMatrixWorld(true);
    const camera = spawnCamera();
    expect(measureUnusedModels(resolved, scene, 60_000)).toBeUndefined();
    const offscreen = measureStartupOffscreenBytes(resolved, scene, camera);
    expect(offscreen.visibleBytes).toBe(42_000);
    expect(offscreen.offscreenBytes).toBe(0);

    const collector = new GeometryCapture();
    const pending = collector.request();
    collector.beginFrame({
      camera,
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    for (const mesh of built) {
      mesh.onBeforeRender(
        undefined as never,
        undefined as never,
        undefined as never,
        mesh.geometry as never,
        mesh.material as never,
        undefined as never,
      );
    }
    collector.finishFrame([]);
    const capture = await pending;
    const assets = new Map((capture.assets ?? []).map((row) => [row.asset, row]));
    expect(assets.get("city/storefront.glb")?.objects).toBe(2);
    expect(assets.get("unattributed")).toBeUndefined();
  });

  it("retains baked AutoLOD chains across built cell batches", async () => {
    const { source } = await bakedTriangleModel();
    const model = new InstancedModel({ source, cellSize: 50 });
    model.place({ position: [0, 0, -5] });
    model.place({ position: [0, 0, -120] });
    const scene = new Group();
    const built = model.build({ name: "offices", parent: scene });
    expect(built).toHaveLength(2);
    scene.updateMatrixWorld(true);
    const drawnTriangles = updateModelLods(scene, spawnCamera(), 1080);
    // Near instance selects LOD0 (12 tris), far instance selects LOD1 (2 tris).
    expect(drawnTriangles).toBe(14);
  });

  it("fails closed on invalid sources, invalid options and post-build mutations", () => {
    expect(() => new InstancedModel({ source: null as unknown as Group })).toThrow(/Object3D/u);
    const empty = new Group();
    empty.add(new SkinnedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    expect(() => new InstancedModel({ source: empty })).toThrow(/no static meshes/u);

    const source = new Group().add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    expect(() => new InstancedModel({ source, cellSize: 0 })).toThrow(/cellSize/u);
    expect(() => new InstancedModel({ source, cellSize: Number.NaN })).toThrow(/cellSize/u);
    expect(() => new InstancedModel({ source, autoLod: { maxPixelError: -1 } })).toThrow(
      /autoLod/u,
    );

    const model = new InstancedModel({ source });
    expect(model.build()).toEqual([]);
    expect(() => model.place({ position: [0, 0, 0] })).toThrow(/after build/u);
    expect(() => model.add(new Matrix4())).toThrow(/after build/u);
    expect(() => model.build()).toThrow(/already called/u);

    const open = new InstancedModel({ source });
    expect(() => open.add(null as unknown as Matrix4)).toThrow(/Matrix4/u);
    const bad = new Matrix4();
    bad.elements[12] = Number.NaN;
    expect(() => open.add(bad)).toThrow(/finite/u);
    expect(() => open.place({ position: [0, Number.POSITIVE_INFINITY, 0] })).toThrow(/finite/u);
    expect(new BufferAttribute(new Float32Array(0), 3).count).toBe(0);
    expect(new BufferGeometry().index).toBeNull();
  });
});
