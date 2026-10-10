import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  type InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import { positionLocal } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { SpanRecorder, setSpanRecorder } from "../src/profiling/Spans.js";
import { SkinnedBatch, isSimilarityTransform } from "../src/projection-skinned.js";
import { SceneRenderProjection } from "../src/renderProjection.js";

/**
 * The skinned lane: rigs that share a geometry and material draw from one palette, the game
 * writes nothing, and every rig the palette cannot draw exactly keeps its own draw with a reason.
 */

const BONES = 3;

function rigGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  // Three vertices, one per bone, each fully weighted to its own bone.
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 2, 0], 3));
  geometry.setAttribute("normal", new Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  geometry.setAttribute(
    "skinIndex",
    new Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  return geometry;
}

function rig(
  geometry: BufferGeometry,
  material: MeshStandardMaterial | MeshStandardNodeMaterial,
): SkinnedMesh {
  const bones: Bone[] = [];
  for (let index = 0; index < BONES; index += 1) {
    const bone = new Bone();
    bone.position.y = index === 0 ? 0 : 1;
    bones[index - 1]?.add(bone);
    bones.push(bone);
  }
  const mesh = new SkinnedMesh(geometry, material);
  mesh.add(bones[0] as Bone);
  mesh.bind(new Skeleton(bones));
  return mesh;
}

function crowd(count: number, material = new MeshStandardMaterial()) {
  const scene = new Scene();
  const geometry = rigGeometry();
  const rigs: SkinnedMesh[] = [];
  for (let index = 0; index < count; index += 1) {
    const mesh = rig(geometry, material);
    mesh.position.set(index * 2, 0, 0);
    scene.add(mesh);
    rigs.push(mesh);
  }
  return { scene, rigs, material };
}

/** Shared-geometry props that fold on the instanced lane, so the frame is projected either way. */
function addProps(scene: Scene, count: number): void {
  const geometry = rigGeometry();
  const material = new MeshStandardMaterial();
  for (let index = 0; index < count; index += 1) scene.add(new Mesh(geometry, material));
}

function drawn(root: Scene): Object3D[] {
  const objects: Object3D[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh === true) objects.push(object);
  });
  return objects;
}

/** What three's own skinning draws for one bone of one rig, in world space. */
function stockBone(mesh: SkinnedMesh, bone: number): Matrix4 {
  mesh.skeleton.update();
  return new Matrix4()
    .copy(mesh.matrixWorld)
    .multiply(mesh.bindMatrixInverse)
    .multiply(new Matrix4().fromArray(mesh.skeleton.boneMatrices as Float32Array, bone * 16))
    .multiply(mesh.bindMatrix);
}

function expectPalette(batch: SkinnedBatch, slot: number, mesh: SkinnedMesh): void {
  for (let bone = 0; bone < BONES; bone += 1) {
    const actual = batch.palette.subarray(
      (slot * BONES + bone) * 16,
      (slot * BONES + bone + 1) * 16,
    );
    const expected = stockBone(mesh, bone).elements;
    for (let index = 0; index < 16; index += 1)
      expect(actual[index]).toBeCloseTo(expected[index] as number, 5);
  }
}

describe("skinned lane of the render projection", () => {
  it("attributes each actual palette write, excluding reconcile overhead", () => {
    const { scene } = crowd(8);
    const projection = new SceneRenderProjection(scene);
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    try {
      projection.reconcile();
      recorder.endFrame(10);
      expect(recorder.window()?.spans.skinnedWrite?.perFrame).toBe(8);
    } finally {
      setSpanRecorder(undefined);
      projection.dispose();
    }
  });

  it("closes the write span if skeleton evaluation throws", () => {
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    const batch = new SkinnedBatch({ first: mesh, capacity: 2, velocity: false });
    const slot = batch.claim(mesh) as number;
    const recorder = new SpanRecorder();
    const update = vi.spyOn(mesh.skeleton, "update").mockImplementation(() => {
      throw new Error("failed skeleton update");
    });
    setSpanRecorder(recorder);
    try {
      expect(() => batch.write(slot, mesh)).toThrow("failed skeleton update");
      recorder.endFrame(10);
      expect(recorder.window()?.spans.skinnedWrite?.perFrame).toBe(1);
    } finally {
      setSpanRecorder(undefined);
      update.mockRestore();
      batch.dispose();
    }
  });

  it("draws a crowd sharing geometry and material as one palette draw, with no game code", () => {
    const { scene, rigs } = crowd(8);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();

    expect(projection.report.projecting).toBe(true);
    expect(projection.report.skinnedBatches).toBe(1);
    expect(projection.report.projectedObjects).toBe(8);
    const objects = drawn(projection.root);
    expect(objects).toHaveLength(1);
    expect((objects[0] as SkinnedMesh).isSkinnedMesh).not.toBe(true);
    expect((objects[0] as Mesh<InstancedBufferGeometry>).geometry.instanceCount).toBe(8);
    // The authored scene is untouched: the game's rigs are still where it put them.
    for (const mesh of rigs) expect(mesh.parent).toBe(scene);
  });

  it("engages on the frame after a level fills an empty scene", () => {
    const scene = new Scene();
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    expect(projection.report.reasonCode).toBe("belowMeshFloor");
    for (const mesh of crowd(8).rigs) scene.add(mesh);
    projection.reconcile();
    expect(projection.report.skinnedBatches).toBe(1);
  });

  it("retires a rig that leaves the scene and recycles its slot", () => {
    // Twelve rigs, so eleven still clear the mesh floor after one leaves.
    const { scene, rigs } = crowd(12);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    scene.remove(rigs[3] as SkinnedMesh);
    projection.reconcile();
    expect(projection.report.projectedObjects).toBe(11);
    scene.add(rigs[3] as SkinnedMesh);
    projection.reconcile();
    expect(projection.report.projectedObjects).toBe(12);
    const draw = drawn(projection.root)[0] as Mesh<InstancedBufferGeometry>;
    // The returning rig reused the freed slot rather than growing the draw.
    expect(draw.geometry.instanceCount).toBe(12);
  });

  it("keeps each rig it cannot draw exactly on its own draw, naming why", () => {
    const { scene, rigs } = crowd(8);
    (rigs[0] as SkinnedMesh).scale.set(1, 2, 1);
    (rigs[1] as SkinnedMesh).scale.set(-1, 1, 1);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    expect(projection.report.exact.nonUniformScale).toBe(1);
    expect(projection.report.exact.negativeScale).toBe(1);
    expect(projection.report.projectedObjects).toBe(6);
    expect(drawn(projection.root).filter((o) => (o as SkinnedMesh).isSkinnedMesh)).toHaveLength(2);
  });

  it("leaves a material that already moves its vertices on three's own skinning", () => {
    const material = new MeshStandardNodeMaterial();
    material.positionNode = positionLocal.mul(2);
    const { scene } = crowd(8, material as unknown as MeshStandardMaterial);
    addProps(scene, 300);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    expect(projection.report.skinnedBatches).toBe(0);
    expect(projection.report.exact.skinned ?? 0).toBe(8);
  });

  it("gives a group below the batching floor its own draws", () => {
    const { scene } = crowd(3);
    addProps(scene, 300);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    expect(projection.report.skinnedBatches).toBe(0);
    expect(projection.report.projecting).toBe(true);
    expect(projection.report.exact.tooFewToBatch).toBe(3);
  });

  it("follows the game's material without being told", () => {
    const { scene, material } = crowd(8);
    const projection = new SceneRenderProjection(scene);
    projection.reconcile();
    const draw = drawn(projection.root)[0] as Mesh<
      InstancedBufferGeometry,
      MeshStandardNodeMaterial
    >;
    material.roughness = 0.123;
    material.color.set(0x336699);
    projection.reconcile();
    expect(draw.material.roughness).toBe(0.123);
    expect(draw.material.color.getHex()).toBe(0x336699);
    const version = draw.material.version;
    material.needsUpdate = true;
    projection.reconcile();
    expect(draw.material.version).toBeGreaterThan(version);
    expect(draw.material).not.toBe(material);
    expect(projection.drawsWith(material)).toBe(true);
  });

  it("drops the whole lane when the game opts out of the projection", () => {
    const { scene } = crowd(8);
    const projection = new SceneRenderProjection(scene, { projection: false });
    projection.reconcile();
    expect(projection.root).toBe(scene);
    expect(projection.report.skinnedBatches).toBe(0);
  });
});

describe("SkinnedBatch palette", () => {
  function posed(mesh: SkinnedMesh, angle: number): void {
    for (const bone of mesh.skeleton.bones) bone.rotation.z = angle;
    mesh.updateMatrixWorld(true);
  }

  it("equals stock skinning for attached, bound-offset and detached rigs", () => {
    const geometry = rigGeometry();
    const material = new MeshStandardMaterial();
    const attached = rig(geometry, material);
    attached.position.set(3, 1, -2);
    attached.rotation.y = 0.7;
    attached.scale.setScalar(1.5);
    const offset = rig(geometry, material);
    offset.bind(offset.skeleton, new Matrix4().makeTranslation(0.5, -1, 0.25));
    const detached = rig(geometry, material);
    detached.bindMode = "detached";
    detached.position.set(-4, 0, 1);
    detached.bind(detached.skeleton, new Matrix4().makeRotationX(0.3));
    const batch = new SkinnedBatch({ first: attached, capacity: 4, velocity: false });
    const rigs = [attached, offset, detached];
    batch.begin();
    rigs.forEach((mesh, index) => {
      posed(mesh, 0.2 * (index + 1));
      batch.write(batch.claim(mesh) as number, mesh);
    });
    batch.end();
    rigs.forEach((mesh, index) => expectPalette(batch, index, mesh));
  });

  it("keeps last frame's pose as history, and a new or returning slot starts from its own pose", () => {
    const geometry = rigGeometry();
    const mesh = rig(geometry, new MeshStandardMaterial());
    const batch = new SkinnedBatch({ first: mesh, capacity: 2, velocity: true });
    const slot = batch.claim(mesh) as number;
    posed(mesh, 0.1);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    // A brand-new slot has no motion to report.
    expect([...(batch.history as Float32Array)]).toEqual([...batch.palette]);
    const first = batch.palette.slice();
    posed(mesh, 0.4);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect([...(batch.history as Float32Array)]).toEqual([...first]);
    expect([...batch.palette]).not.toEqual([...first]);

    batch.begin();
    batch.hide(slot);
    batch.end();
    expect(batch.palette.every((value) => value === 0)).toBe(true);
    batch.begin();
    batch.restart(slot);
    batch.write(slot, mesh);
    batch.end();
    // Back from hidden: history is its own pose, not the collapsed zeros.
    expect([...(batch.history as Float32Array)]).toEqual([...batch.palette]);
  });

  it("collapses a released slot so it draws nothing", () => {
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    const batch = new SkinnedBatch({ first: mesh, capacity: 2, velocity: false });
    batch.begin();
    batch.write(batch.claim(mesh) as number, mesh);
    batch.end();
    batch.release(mesh);
    batch.end();
    expect(batch.palette.every((value) => value === 0)).toBe(true);
    expect(batch.free).toEqual([0]);
  });
});

describe("isSimilarityTransform", () => {
  it("accepts rotation with uniform scale and refuses uneven, sheared or mirrored transforms", () => {
    expect(
      isSimilarityTransform(
        new Matrix4().makeRotationY(1).scale({ x: 2, y: 2, z: 2 } as never).elements,
      ),
    ).toBe(true);
    expect(isSimilarityTransform(new Matrix4().makeScale(1, 2, 1).elements)).toBe(false);
    expect(isSimilarityTransform(new Matrix4().makeScale(-1, 1, 1).elements)).toBe(false);
    expect(isSimilarityTransform(new Matrix4().makeShear(0.3, 0, 0, 0, 0, 0).elements)).toBe(false);
    expect(isSimilarityTransform(new Matrix4().makeScale(0, 0, 0).elements)).toBe(false);
  });
});
