import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { InstancedBatch } from "../src/instanced-batch.js";
import {
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
  updateModelLods,
} from "../src/model-lod.js";

function batch(): InstancedBatch {
  return new InstancedBatch({
    geometry: new BoxGeometry(1, 1, 1),
    material: new MeshBasicMaterial(),
  });
}

/** Position, scale and the axis a unit +Y shape ends up pointing along, read back off an instance. */
function readInstance(matrix: Matrix4) {
  const position = new Vector3();
  const scale = new Vector3();
  const axis = new Vector3();
  position.setFromMatrixPosition(matrix);
  scale.setFromMatrixScale(matrix);
  axis.set(0, 1, 0).transformDirection(matrix);
  return { axis, position, scale };
}

describe("InstancedBatch", () => {
  it("collapses every placement into one mesh with the transforms it was given", () => {
    const props = batch();
    props.place({ position: [1, 2, 3] });
    props.place({ position: [-4, 0, 5], scale: [2, 3, 4], rotation: [0, Math.PI / 2, 0] });
    expect(props.count).toBe(2);

    const mesh = props.build();
    expect(mesh).toBeDefined();
    expect(mesh?.count).toBe(2);

    const read = new Matrix4();
    mesh?.getMatrixAt(0, read);
    expect(readInstance(read).position.toArray()).toEqual([1, 2, 3]);
    mesh?.getMatrixAt(1, read);
    const second = readInstance(read);
    expect(second.position.toArray()).toEqual([-4, 0, 5]);
    expect(second.scale.x).toBeCloseTo(2, 6);
    expect(second.scale.y).toBeCloseTo(3, 6);
    expect(second.scale.z).toBeCloseTo(4, 6);
  });

  it("hands back the instance index so a game can keep animating one prop by name", () => {
    const props = batch();
    expect(props.place({ position: [0, 0, 0] })).toBe(0);
    const flame = props.place({ position: [0, 5, 0] });
    expect(flame).toBe(1);
    expect(props.place({ position: [0, 9, 0] })).toBe(2);

    const mesh = props.build();
    if (mesh === undefined) throw new Error("the batch had three placements");
    mesh.setMatrixAt(flame, new Matrix4().makeTranslation(7, 7, 7));
    const read = new Matrix4();
    mesh.getMatrixAt(flame, read);
    expect(readInstance(read).position.toArray()).toEqual([7, 7, 7]);
    // The neighbours are untouched: the index addresses one instance, not the whole batch.
    mesh.getMatrixAt(2, read);
    expect(readInstance(read).position.toArray()).toEqual([0, 9, 0]);
  });

  it("copies the matrix it is handed so one scratch Matrix4 can drive every call", () => {
    const props = batch();
    const scratch = new Matrix4();
    props.add(scratch.makeTranslation(1, 0, 0));
    props.add(scratch.makeTranslation(2, 0, 0));

    const mesh = props.build();
    const read = new Matrix4();
    mesh?.getMatrixAt(0, read);
    expect(readInstance(read).position.x).toBe(1);
    mesh?.getMatrixAt(1, read);
    expect(readInstance(read).position.x).toBe(2);
  });

  it("spans two points as a stretched unit-height shape", () => {
    const rods = new InstancedBatch({
      geometry: new CylinderGeometry(1, 1, 1, 6),
      material: new MeshBasicMaterial(),
    });
    rods.span([0, 0, 0], [0, 0, 10], 0.25);

    const mesh = rods.build();
    const read = new Matrix4();
    mesh?.getMatrixAt(0, read);
    const rod = readInstance(read);
    expect(rod.position.toArray()).toEqual([0, 0, 5]);
    expect(rod.scale.x).toBeCloseTo(0.25, 6);
    expect(rod.scale.y).toBeCloseTo(10, 6);
    expect(rod.scale.z).toBeCloseTo(0.25, 6);
    // The shape's +Y now points from `from` toward `to`.
    expect(rod.axis.x).toBeCloseTo(0, 6);
    expect(rod.axis.y).toBeCloseTo(0, 6);
    expect(rod.axis.z).toBeCloseTo(1, 6);
  });

  it("bounds the batch around every instance so the culler does not drop a spread-out one", () => {
    const props = batch();
    props.place({ position: [0, 0, 0] });
    props.place({ position: [100, 0, 0] });

    const mesh = props.build();
    // Without the explicit compute this is the bounds of one un-transformed copy, and the batch
    // pops out of view while half of it is still on screen.
    expect(mesh?.boundingSphere?.radius ?? 0).toBeGreaterThan(50);
  });

  it("passes the built mesh straight through to the parent, name and shadow flags", () => {
    const parent = new Group();
    const props = batch();
    props.place({ position: [0, 0, 0] });
    const mesh = props.build({ castShadow: true, name: "curbs", parent, receiveShadow: true });

    expect(parent.children).toEqual([mesh]);
    expect(mesh?.name).toBe("curbs");
    expect(mesh?.castShadow).toBe(true);
    expect(mesh?.receiveShadow).toBe(true);
    expect(props.mesh).toBe(mesh);
  });

  it("defaults the shadow flags to Three.js's own, so the batch decides nothing", () => {
    const props = batch();
    props.place({ position: [0, 0, 0] });
    const mesh = props.build();
    expect(mesh?.castShadow).toBe(false);
    expect(mesh?.receiveShadow).toBe(false);
  });

  it("returns undefined rather than a mesh that draws nothing", () => {
    const props = batch();
    // `new InstancedMesh(geometry, material, 0)` satisfies every type check and draws nothing, so
    // an empty batch would be indistinguishable from a working one.
    expect(props.build()).toBeUndefined();
    expect(props.mesh).toBeUndefined();
    expect(() => props.place({ position: [1, 0, 0] })).toThrow(/after build/u);
    expect(() => props.span([0, 0, 0], [0, 1, 0], 0.1)).toThrow(/after build/u);
    expect(() => props.add(new Matrix4())).toThrow(/after build/u);
  });

  it("refuses to place after build, because an InstancedMesh count is fixed", () => {
    const props = batch();
    props.place({ position: [0, 0, 0] });
    props.build();
    expect(() => props.place({ position: [1, 0, 0] })).toThrow(/after build/u);
    expect(() => props.span([0, 0, 0], [0, 1, 0], 0.1)).toThrow(/after build/u);
    expect(() => props.add(new Matrix4())).toThrow(/after build/u);
    expect(() => props.build()).toThrow(/already called/u);
  });

  it("fails closed on input that would silently shift every later index", () => {
    const props = batch();
    expect(() => props.span([1, 2, 3], [1, 2, 3], 0.2)).toThrow(/same point/u);
    expect(() => props.span([0, 0, 0], [0, 1, 0], 0)).toThrow(/positive finite/u);
    expect(() => props.place({ position: [0, Number.NaN, 0] })).toThrow(/finite/u);
    expect(() =>
      props.place({ position: [0, 0, 0], scale: [1, 2] as unknown as [number, number, number] }),
    ).toThrow(/triple/u);
    expect(props.count).toBe(0);
  });

  it("requires the game to supply both the shape and the surface", () => {
    expect(
      () =>
        new InstancedBatch({
          geometry: undefined as unknown as BoxGeometry,
          material: new MeshBasicMaterial(),
        }),
    ).toThrow(/geometry is required/u);
    expect(
      () =>
        new InstancedBatch({
          geometry: new BoxGeometry(1, 1, 1),
          material: undefined as unknown as MeshBasicMaterial,
        }),
    ).toThrow(/never chooses one/u);
  });
});

async function bakedGeometry() {
  const geometry = new BoxGeometry();
  const source = new Mesh(geometry, new MeshBasicMaterial());
  const root = new Group().add(source);
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map([[source, { meshes: 0, primitives: 0 }]]),
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
  plugin.attach(root, undefined);
  return geometry;
}

function draws(root: Group | InstancedMesh) {
  const found: InstancedMesh[] = [];
  root.traverse((object) => {
    if (
      object instanceof InstancedMesh &&
      object.visible &&
      object.count > 0 &&
      object.geometry.drawRange.count > 0
    )
      found.push(object);
  });
  return found;
}

function lodCamera() {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  return camera;
}

describe("InstancedBatch automatic LOD", () => {
  it("rejects invalid automatic selection options even on geometry without a chain", () => {
    const props = new InstancedBatch({
      geometry: new BoxGeometry(),
      material: new MeshBasicMaterial(),
      autoLod: { maxPixelError: Number.NaN },
    });
    props.place({ position: [0, 0, 0] });
    expect(() => props.build()).toThrow(/autoLod/);
  });

  it("partitions near and far instances through the engine frame tracker without game LOD code", async () => {
    const geometry = await bakedGeometry();
    const props = new InstancedBatch({ geometry, material: new MeshBasicMaterial() });
    props.place({ position: [0, 0, -5] });
    props.place({ position: [0, 0, -100] });
    const root = new Group();
    const mesh = props.build({ name: "pines", parent: root, castShadow: true });
    if (mesh === undefined) throw new Error("missing batch");
    mesh.setColorAt(0, new Color(1, 0, 0));
    mesh.setColorAt(1, new Color(0, 0, 1));
    root.updateMatrixWorld(true);
    expect(updateModelLods(root, lodCamera(), 1080)).toBe(14);
    expect(
      draws(root).map((draw) => Array.from(draw.instanceColor?.array.slice(0, 3) ?? [])),
    ).toEqual([
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(draws(root).map((draw) => [draw.geometry.index?.count, draw.count])).toEqual([
      [36, 1],
      [6, 1],
    ]);
    // Public matrices retain placement order; far slots never replace the near slot.
    const moved = new Matrix4().makeTranslation(0, 0, -5);
    mesh.setMatrixAt(1, moved);
    updateModelLods(root, lodCamera(), 1080);
    expect(draws(root).map((draw) => draw.count)).toEqual([2]);
    const hits = new Raycaster(new Vector3(0, 0, 0), new Vector3(0, 0, -1)).intersectObject(
      mesh,
      true,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.object === mesh)).toBe(true);
    expect(new Set(hits.map((hit) => hit.instanceId))).toEqual(new Set([0, 1]));
    root.remove(mesh);
    expect(mesh.children).toHaveLength(0);
    root.add(mesh);
    expect(updateModelLods(root, lodCamera(), 1080)).toBe(24);
    expect(draws(root).map((draw) => draw.count)).toEqual([2]);
  });

  it("keeps empty render partitions visible across LOD changes so projection lights remain stable", async () => {
    const props = new InstancedBatch({
      geometry: await bakedGeometry(),
      material: new MeshBasicMaterial(),
    });
    props.place({ position: [0, 0, -100] });
    const root = new Group();
    const mesh = props.build({ parent: root, castShadow: true, receiveShadow: true });
    if (mesh === undefined) throw new Error("missing batch");
    expect(mesh.children.every((child) => child.castShadow && child.receiveShadow)).toBe(true);
    expect(mesh.children.every((child) => child.visible)).toBe(true);
    updateModelLods(root, lodCamera(), 1080);
    expect(mesh.children.every((child) => child.visible)).toBe(true);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -5));
    updateModelLods(root, lodCamera(), 1080);
    expect(mesh.children.every((child) => child.visible)).toBe(true);
  });

  it("spatially bounds broad LOD batches while retaining offscreen shadow casters", async () => {
    const props = new InstancedBatch({
      geometry: await bakedGeometry(),
      material: new MeshBasicMaterial(),
    });
    for (const x of [100, 0, -100, 80, -1, -80, 60, 1, -60]) props.place({ position: [x, 0, -10] });
    const root = new Group();
    const mesh = props.build({ parent: root, castShadow: true });
    if (mesh === undefined) throw new Error("missing batch");
    const camera = lodCamera();
    updateModelLods(root, camera, 1080);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const partitions = draws(root);
    const visible = partitions.filter(
      (child) =>
        child.boundingSphere !== null &&
        frustum.intersectsSphere(child.boundingSphere.clone().applyMatrix4(child.matrixWorld)),
    );
    expect(visible.reduce((sum, child) => sum + child.count * 12, 0)).toBeLessThanOrEqual(60);
    expect(partitions.reduce((sum, child) => sum + child.count, 0)).toBe(9);
    expect(partitions.every((child) => child.castShadow && child.visible)).toBe(true);
    const read = new Matrix4();
    mesh.getMatrixAt(0, read);
    expect(read.elements[12]).toBe(100);
  });

  it("projects scaled parents and camera movement, and retains a cloned transformed chain", async () => {
    const geometry = (await bakedGeometry()).clone().applyMatrix4(new Matrix4().makeScale(2, 3, 4));
    expect(lodChainOf(geometry)?.errors[1]).toBeCloseTo(0.4);
    const props = new InstancedBatch({ geometry, material: new MeshBasicMaterial() });
    props.place({ position: [0, 0, -150] });
    const root = new Group();
    root.scale.setScalar(2);
    props.build({ parent: root });
    root.updateMatrixWorld(true);
    const camera = lodCamera();
    expect(updateModelLods(root, camera, 1080)).toBe(2);
    camera.position.z = -290;
    expect(updateModelLods(root, camera, 1080)).toBe(12);
  });

  it("authored levels win, failed rungs warn once with the batch name, and opt-out keeps LOD0", async () => {
    const geometry = await bakedGeometry();
    const authored = new BoxGeometry(2, 2, 2);
    authored.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = new InstancedBatch({
      geometry,
      material: new MeshBasicMaterial(),
      lods: [
        { distance: 10, geometry: authored },
        { distance: 20, geometry: undefined },
      ],
    });
    props.place({ position: [0, 0, -100] });
    const root = new Group();
    props.build({ parent: root, name: "authored-pines" });
    root.updateMatrixWorld(true);
    updateModelLods(root, lodCamera(), 1080);
    updateModelLods(root, lodCamera(), 1080);
    expect(draws(root).map((draw) => draw.geometry)).toEqual([authored]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toMatch(/TN_INSTANCED_LOD_FAILED.*authored-pines/);
    warning.mockRestore();
    const fixed = new InstancedBatch({
      geometry,
      material: new MeshBasicMaterial(),
      autoLod: false,
    });
    fixed.place({ position: [0, 0, -100] });
    const mesh = fixed.build();
    if (mesh === undefined) throw new Error("missing batch");
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.children).toHaveLength(0);
  });
});
