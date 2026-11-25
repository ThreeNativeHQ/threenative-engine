import { Box3, BoxGeometry, InstancedBufferAttribute, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { InstancedBatch } from "../src/instanced-batch.js";
import { SharedBatch } from "../src/world-cell-batches.js";

/**
 * On the owned Wasm engine every write to a mesh's `count`, `visible`, `frustumCulled`, `name`,
 * `geometry` or `material` is a JS -> Wasm bridge crossing. `SharedBatch` keeps a JS mirror of each
 * and skips a write that changes nothing, so a settled streamed world stops paying those crossings
 * every frame. These specs fail if the mirror is bypassed or drifts from the mesh.
 */
const WATCHED = ["count", "visible", "frustumCulled", "name", "geometry", "material"] as const;

function batchOf(): SharedBatch {
  const material = new MeshBasicMaterial();
  material.userData.tnPublishedLodRange = true;
  const bounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  return new SharedBatch(
    new BoxGeometry(1, 1, 1),
    material,
    16,
    4,
    "mirror-probe",
    bounds,
    "cluster",
  );
}

function blockOf(count: number): InstancedBatch {
  return { count, writeMatrices: () => count } as unknown as InstancedBatch;
}

/** Count writes per watched property on `mesh`, as a bridge-crossing meter. */
function meterWrites(mesh: object): Record<(typeof WATCHED)[number], number> {
  const writes = Object.fromEntries(WATCHED.map((k) => [k, 0])) as Record<
    (typeof WATCHED)[number],
    number
  >;
  for (const key of WATCHED) {
    let value = Reflect.get(mesh, key);
    Object.defineProperty(mesh, key, {
      configurable: true,
      get: () => value,
      set: (next) => {
        writes[key] += 1;
        value = next;
      },
    });
  }
  return writes;
}

function expectMirrored(batch: SharedBatch): void {
  const mesh = batch.mesh;
  expect(batch.publishedCount).toBe(mesh.count);
  expect(batch.publishedVisible).toBe(mesh.visible);
  expect(batch.publishedFrustumCulled).toBe(mesh.frustumCulled);
  expect(batch.publishedName).toBe(mesh.name);
  expect(batch.currentGeometry).toBe(mesh.geometry);
  expect(batch.currentMaterial).toBe(mesh.material);
  expect(batch.hasRangeAttribute).toBe(
    mesh.geometry.getAttribute("tnPublishedLodRange") instanceof InstancedBufferAttribute,
  );
}

describe("SharedBatch mirrors", () => {
  it("skips mesh writes that change nothing", () => {
    const batch = batchOf();
    const writes = meterWrites(batch.mesh);

    batch.setCount(5);
    batch.setCount(5);
    batch.setVisible(true);
    batch.setVisible(true);
    batch.setFrustumCulled(true);
    batch.setName("mirror-probe");
    batch.setGeometryView(batch.currentGeometry);
    batch.surface(batch.currentMaterial);

    expect(writes).toEqual({
      count: 1,
      visible: 1,
      frustumCulled: 0,
      name: 0,
      geometry: 0,
      material: 0,
    });
    expectMirrored(batch);
  });

  it("matches the mesh after a write, a grow, a rebind and a replace", () => {
    const batch = batchOf();
    expectMirrored(batch);

    batch.write(batch.allocate(40) as number, blockOf(40));
    expectMirrored(batch);

    batch.grow();
    expectMirrored(batch);

    const material = new MeshBasicMaterial();
    batch.rebind(new BoxGeometry(2, 2, 2), material);
    expect(batch.currentMaterial).toBe(material);
    expectMirrored(batch);

    const donor = batchOf();
    donor.mesh.count = 3;
    donor.mesh.visible = true;
    donor.mesh.name = "replaced";
    batch.replaceMesh(donor.mesh);
    expectMirrored(batch);
    // The cached bounds are the mesh's own objects, so a later settle reaches the mesh.
    expect(batch.mesh.boundingBox).toBeInstanceOf(Box3);
  });
});
