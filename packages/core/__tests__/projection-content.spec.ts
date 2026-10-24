import {
  BoxGeometry,
  CylinderGeometry,
  type InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import { contentHash, sameContent } from "../src/projection-content.js";
import { SceneRenderProjection } from "../src/renderProjection.js";

/**
 * Agents write `new Mesh(new CylinderGeometry(...), material)` for every copy, so no two copies share a
 * geometry object. The instanced lanes key on content, not identity: copies whose bytes are equal batch
 * into one draw that references one of their geometries.
 */

function perCopy(scene: Scene, count: number, geometry: (index: number) => BoxGeometry): Mesh[] {
  const material = new MeshStandardMaterial();
  const meshes: Mesh[] = [];
  for (let index = 0; index < count; index += 1) {
    const mesh = new Mesh(geometry(index), material);
    mesh.position.set(index, 0, 0);
    scene.add(mesh);
    meshes.push(mesh);
  }
  scene.updateMatrixWorld(true);
  return meshes;
}

function batchesIn(root: Object3D): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  root.traverse((object) => {
    if ((object as InstancedMesh).isInstancedMesh === true) found.push(object as InstancedMesh);
  });
  return found;
}

describe("render projection content identity", () => {
  it("batches 40 meshes that each built the same geometry into one instanced draw", () => {
    const scene = new Scene();
    const meshes = perCopy(scene, 40, () => new BoxGeometry(1, 1, 1));
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.report.reasonCode).toBe("projected");
    expect(projection.report.instancedBatches).toBe(1);
    expect(projection.report.projectedObjects).toBe(40);
    const batches = batchesIn(projection.root);
    expect(batches).toHaveLength(1);
    // One representative geometry, and it is one of the game's own.
    expect(meshes.map((mesh) => mesh.geometry)).toContain(batches[0]?.geometry);
  });

  it("keeps the same vertex count with different data apart", () => {
    const scene = new Scene();
    perCopy(scene, 40, (index) => new BoxGeometry(1, 1 + index * 0.001, 1));
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.report.reasonCode).toBe("notWorthwhile");
    expect(batchesIn(projection.root)).toHaveLength(0);
  });

  it("lets a member whose geometry changes leave the group, and redraws the rest from a member that did not", () => {
    const scene = new Scene();
    const meshes = perCopy(scene, 40, () => new BoxGeometry(1, 1, 1));
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    const drawn = batchesIn(projection.root)[0]?.geometry;
    const changed = meshes.find((mesh) => mesh.geometry === drawn) as Mesh;
    expect(changed).toBeDefined();

    const position = changed.geometry.getAttribute("position");
    position.setY(0, 5);
    position.needsUpdate = true;
    projection.reconcile();

    expect(projection.report.reasonCode).toBe("projected");
    expect(projection.inspect(changed)?.lane).toBe("exact");
    const batches = batchesIn(projection.root);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.geometry).not.toBe(changed.geometry);
    expect(sameContent(batches[0]?.geometry as BoxGeometry, new BoxGeometry(1, 1, 1))).toBe(true);
    for (const mesh of meshes)
      if (mesh !== changed) expect(projection.inspect(mesh)?.lane).toBe("batched");
  });

  it("compares bytes behind the hash, and hashes equal content equally", () => {
    const a = new CylinderGeometry(0.5, 0.5, 1, 12);
    const b = new CylinderGeometry(0.5, 0.5, 1, 12);
    const c = new CylinderGeometry(0.5, 0.5, 1.01, 12);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(sameContent(a, b)).toBe(true);
    expect(sameContent(a, c)).toBe(false);
  });
});
