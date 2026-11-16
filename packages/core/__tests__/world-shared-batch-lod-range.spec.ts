import { Box3, BoxGeometry, InstancedBufferAttribute, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { GEOMETRY_ASSET_KEY } from "../src/geometry-capture.js";
import type { InstancedBatch } from "../src/instanced-batch.js";
import { LOD_RANGE_STRIDE, SharedBatch } from "../src/world-cell-batches.js";
import { batchRecords } from "../src/world-cell-records.js";

/**
 * The two buffers one shared batch writes must hold the same number of records.
 *
 * `instanceMatrix` comes from the mesh pool, which rounds a requested capacity up to a power of two,
 * and the batch's ceiling is that rounded count. The `tnPublishedLodRange` column is kept beside it
 * and `#touched` writes a range over the records the batch drew. When the column is sized from the
 * unrounded request it is shorter than the instance buffer, so a batch that fills past the request
 * records a range past the end of the column's array. Three's WebGPU backend turns that range into
 * one `GPUQueue.writeBuffer` against a buffer it created for the shorter array, and the queue throws
 * `Number of bytes to write is too large` — the renderer then draws nothing for the rest of the run.
 * Measured on `strata-terrain-preview`'s swim scenario: a 208-record request, 213 records drawn, an
 * 852-element range into an 832-element column.
 */
function batchOf(segmentSize: number, segments: number): SharedBatch {
  const material = new MeshBasicMaterial();
  material.userData.tnPublishedLodRange = true;
  const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  return new SharedBatch(
    new BoxGeometry(1, 1, 1),
    material,
    segmentSize,
    segments,
    "lod-range-probe",
    bounds,
    "cluster",
  );
}

/** A block of `count` records; the matrices stay zero, which is also a readable box. */
function blockOf(count: number): InstancedBatch {
  return { count, writeMatrices: () => count } as unknown as InstancedBatch;
}

function lodRangeOf(batch: SharedBatch): InstancedBufferAttribute {
  const attribute = batch.mesh.geometry.getAttribute("tnPublishedLodRange");
  if (!(attribute instanceof InstancedBufferAttribute)) throw new TypeError("no range column");
  return attribute;
}

/** Every pending upload of both buffers has to land inside the array the GPU buffer was made from. */
function expectAligned(batch: SharedBatch): void {
  batchRecords.flush();
  const lod = lodRangeOf(batch);
  expect(lod.array.length).toBe(batch.mesh.instanceMatrix.count * LOD_RANGE_STRIDE);
  for (const range of lod.updateRanges)
    expect(range.start + range.count).toBeLessThanOrEqual(lod.array.length);
  for (const range of batch.mesh.instanceMatrix.updateRanges)
    expect(range.start + range.count).toBeLessThanOrEqual(batch.mesh.instanceMatrix.array.length);
}

describe("SharedBatch's range column", () => {
  it("is as long as the pooled instance buffer, not the requested capacity", () => {
    // 13 × 16 = 208 records requested, pooled to 256, so the two never agree on the request alone.
    const batch = batchOf(13, 16);
    expect(batch.mesh.instanceMatrix.count).toBe(256);
    expectAligned(batch);

    const written = batch.allocate(213);
    expect(written).toBeDefined();
    batch.write(written as number, blockOf(213));
    expectAligned(batch);
  });

  it("stays aligned when the buffer doubles", () => {
    const batch = batchOf(13, 16);
    batch.write(batch.allocate(200) as number, blockOf(200));
    batch.grow();
    expectAligned(batch);
    batch.write(batch.allocate(500) as number, blockOf(500));
    expectAligned(batch);
  });

  it("stays aligned when the surface turns range-aware", () => {
    const material = new MeshBasicMaterial();
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const batch = new SharedBatch(
      new BoxGeometry(1, 1, 1),
      material,
      13,
      16,
      "lod-range-probe",
      bounds,
      "cluster",
    );
    batch.write(batch.allocate(213) as number, blockOf(213));
    material.userData.tnPublishedLodRange = true;
    batch.surface(material);
    expectAligned(batch);
  });
});

describe("SharedBatch's range-aware view", () => {
  it("keeps the source geometry's asset stamp, so TN_ASSET_UNUSED sees the model drawn", () => {
    const material = new MeshBasicMaterial();
    material.userData.tnPublishedLodRange = true;
    const source = new BoxGeometry(1, 1, 1);
    source.userData[GEOMETRY_ASSET_KEY] = "trees/oak-near.glb";
    const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const batch = new SharedBatch(source, material, 4, 4, "stamp-probe", bounds, "cluster");
    expect(batch.mesh.geometry).not.toBe(source);
    expect(batch.mesh.geometry.userData[GEOMETRY_ASSET_KEY]).toBe("trees/oak-near.glb");
  });
});
