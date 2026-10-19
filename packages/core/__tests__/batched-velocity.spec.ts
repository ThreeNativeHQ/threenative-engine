import { BatchedMesh, BoxGeometry, DataTexture, Mesh, MeshStandardMaterial, Scene } from "three";
import { describe, expect, it, vi } from "vitest";

import {
  disposeBatchedMeshVelocity,
  ensureBatchedMeshVelocity,
  isBatchedMeshVelocityPatched,
  readBatchedMeshPreviousMatrices,
  setBatchedMeshPreviousMatrices,
} from "../src/render/batched-velocity.js";
import { SceneRenderProjection } from "../src/renderProjection.js";

function materialBatch(root: Scene): BatchedMesh {
  let result: BatchedMesh | undefined;
  root.traverse((object) => {
    if ((object as BatchedMesh).isBatchedMesh === true) result = object as BatchedMesh;
  });
  if (result === undefined) throw new Error("material batch was not built");
  return result;
}

function matrixData(
  batch: BatchedMesh,
  property: "_matricesTexture" | "_previousMatricesTexture",
): number[] {
  const texture = (batch as BatchedMesh & { [key: string]: { image: { data: Float32Array } } })[
    property
  ];
  if (texture === undefined) throw new Error(`batch texture '${property}' is missing`);
  return [...texture.image.data];
}

describe("BatchedMesh velocity", () => {
  it("detects the patched Three.js BatchedMesh accessor", () => {
    expect(isBatchedMeshVelocityPatched()).toBe(true);
  });

  it("falls back to exact proxies when a consumer has not applied the patch", () => {
    const batchedMeshConstructor = BatchedMesh as unknown as Record<string, unknown>;
    const marker = "threeNativeBatchedVelocityPatch";
    const original = batchedMeshConstructor[marker];
    batchedMeshConstructor[marker] = false;
    try {
      const scene = new Scene();
      const material = new MeshStandardMaterial();
      const sharedGeometry = new BoxGeometry(1, 1, 1);
      for (let index = 0; index < 8; index += 1) scene.add(new Mesh(sharedGeometry, material));
      for (let index = 0; index < 8; index += 1)
        scene.add(new Mesh(new BoxGeometry(1, 1 + index, 1), material));

      const projection = new SceneRenderProjection(scene, { minMeshes: 2, velocity: true });
      projection.reconcile();
      expect(projection.report).toMatchObject({
        exactObjects: 8,
        materialBatches: 0,
        projectedObjects: 8,
      });
      expect(projection.report.exact.batchVelocityPatchMissing).toBe(8);
      projection.dispose();
    } finally {
      if (original === undefined) delete batchedMeshConstructor[marker];
      else batchedMeshConstructor[marker] = original;
    }
  });

  it("keeps static and moving sub-draws in separate current/previous matrix frames", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const sharedGeometry = new BoxGeometry(1, 1, 1);
    for (let index = 0; index < 8; index += 1) {
      scene.add(new Mesh(sharedGeometry, material));
    }
    const meshes = Array.from(
      { length: 8 },
      (_, index) => new Mesh(new BoxGeometry(1, 2 + index, 1), material),
    );
    meshes.forEach((mesh, index) => {
      mesh.position.set(index * 3, 0, -4);
      scene.add(mesh);
    });

    const projection = new SceneRenderProjection(scene, { minMeshes: 2, velocity: true });
    projection.reconcile();
    const batch = materialBatch(projection.root);
    const firstCurrent = matrixData(batch, "_matricesTexture");
    expect(readBatchedMeshPreviousMatrices(batch)).toBeDefined();
    expect(matrixData(batch, "_previousMatricesTexture")).toEqual(firstCurrent);

    projection.reconcile();
    expect(matrixData(batch, "_previousMatricesTexture")).toEqual(firstCurrent);

    const movingMesh = meshes[1];
    if (movingMesh === undefined) throw new Error("moving mesh fixture is missing");
    movingMesh.position.x += 2;
    projection.reconcile();
    const movedCurrent = matrixData(batch, "_matricesTexture");
    expect(matrixData(batch, "_previousMatricesTexture")).toEqual(firstCurrent);
    expect(movedCurrent).not.toEqual(firstCurrent);

    projection.reconcile();
    expect(matrixData(batch, "_previousMatricesTexture")).toEqual(movedCurrent);

    projection.dispose();
  });

  it("initializes a new sub-draw to zero velocity and allocates no storage when disabled", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const sharedGeometry = new BoxGeometry(1, 1, 1);
    for (let index = 0; index < 8; index += 1) {
      scene.add(new Mesh(sharedGeometry, material));
    }
    for (let index = 0; index < 8; index += 1) {
      scene.add(new Mesh(new BoxGeometry(1, 2 + index, 1), material));
    }

    const disabled = new SceneRenderProjection(scene, { minMeshes: 2 });
    disabled.reconcile();
    expect(readBatchedMeshPreviousMatrices(materialBatch(disabled.root))).toBeUndefined();
    disabled.dispose();

    const enabled = new SceneRenderProjection(scene, { minMeshes: 2, velocity: true });
    enabled.reconcile();
    const firstBatch = materialBatch(enabled.root);
    const firstCurrent = matrixData(firstBatch, "_matricesTexture");
    const newMesh = new Mesh(new BoxGeometry(1, 10, 1), material);
    newMesh.position.x = 4;
    scene.add(newMesh);
    enabled.reconcile();
    const secondBatch = materialBatch(enabled.root);
    expect(matrixData(secondBatch, "_previousMatricesTexture")).toEqual(
      matrixData(secondBatch, "_matricesTexture"),
    );
    expect(matrixData(secondBatch, "_matricesTexture")).not.toEqual(firstCurrent);
    enabled.dispose();
  });

  it("can turn previous-matrix storage on and off at the chain seam", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const sharedGeometry = new BoxGeometry(1, 1, 1);
    for (let index = 0; index < 8; index += 1) scene.add(new Mesh(sharedGeometry, material));
    for (let index = 0; index < 8; index += 1)
      scene.add(new Mesh(new BoxGeometry(1, 2 + index, 1), material));

    let velocity = false;
    const projection = new SceneRenderProjection(scene, {
      minMeshes: 2,
      velocity: () => velocity,
    });
    projection.reconcile();
    expect(readBatchedMeshPreviousMatrices(materialBatch(projection.root))).toBeUndefined();

    velocity = true;
    projection.reconcile();
    expect(readBatchedMeshPreviousMatrices(materialBatch(projection.root))).toBeDefined();

    velocity = false;
    projection.reconcile();
    expect(readBatchedMeshPreviousMatrices(materialBatch(projection.root))).toBeUndefined();
    projection.dispose();
  });

  it("throws on a missing current matrix texture and on a malformed matrix image", () => {
    const noCurrent = { _matricesTexture: null } as unknown as BatchedMesh;
    expect(() => ensureBatchedMeshVelocity(noCurrent)).toThrow(
      "BatchedMesh has no current matrix texture.",
    );

    const malformed = {
      _matricesTexture: { image: { data: new Uint8Array(4), height: 1, width: 1 } },
    } as unknown as BatchedMesh;
    expect(() => ensureBatchedMeshVelocity(malformed)).toThrow(
      "BatchedMesh matrix texture must contain a Float32Array image.",
    );
  });

  it("rejects a previous-matrix write that does not match the texture size", () => {
    const current = new DataTexture(new Float32Array(16), 4, 4);
    const mesh = { _matricesTexture: current } as unknown as BatchedMesh;
    expect(() => setBatchedMeshPreviousMatrices(mesh, new Float32Array(15))).toThrow(
      /does not match/,
    );
  });

  it("disposes the previous texture and forgets it", () => {
    const current = new DataTexture(new Float32Array(16), 4, 4);
    const mesh = { _matricesTexture: current } as unknown as BatchedMesh;
    ensureBatchedMeshVelocity(mesh);
    const previous = readBatchedMeshPreviousMatrices(mesh);
    expect(previous).toBeDefined();
    const previousDispose = vi.spyOn(previous as DataTexture, "dispose");
    disposeBatchedMeshVelocity(mesh);
    expect(previousDispose).toHaveBeenCalledOnce();
    expect(readBatchedMeshPreviousMatrices(mesh)).toBeUndefined();
    // Disposing twice must not touch the held texture again.
    disposeBatchedMeshVelocity(mesh);
    expect(previousDispose).toHaveBeenCalledOnce();
  });
});
