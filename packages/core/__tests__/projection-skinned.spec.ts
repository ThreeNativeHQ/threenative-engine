import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  type InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { positionLocal } from "three/tsl";
import { MeshStandardNodeMaterial, type Node, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer } from "../src/animation.js";
import { SpanRecorder, setSpanRecorder } from "../src/profiling/Spans.js";
import { SkinnedBatch, isSimilarityTransform } from "../src/projection-skinned.js";
import { RenderCameraCull } from "../src/render-camera-cull.js";
import { SceneRenderProjection } from "../src/renderProjection.js";

/**
 * The skinned lane: rigs that share a geometry and material draw from one palette, the game
 * writes nothing, and every rig the palette cannot draw exactly keeps its own draw with a reason.
 */

const BONES = 3;

/** Reads bone0's fully weighted vertex from the buffers and blend compiled into the draw. */
function compiledPose(batch: SkinnedBatch, previous = false): () => Vector3 {
  const builder = new WGSLNodeBuilder(batch.mesh, {
    backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
    getDrawIndex: () => null,
    getMRT: () => null,
    hasFeature: () => false,
  } as never) as unknown as {
    setShaderStage(stage: string): void;
    flowStagesNode(node: Node, output: string): { code: string; result: string };
    uniforms: { vertex: { name: string; node: { value: { array?: Float32Array } } }[] };
  };
  builder.setShaderStage("vertex");
  const shader = builder.flowStagesNode(batch.mesh.material.positionNode as Node, "vec3");
  const matrix = (
    previous
      ? /positionPrevious = \( (\w+) \*/u.exec(shader.code)
      : /^\( (\w+) \*/u.exec(shader.result)
  )?.[1];
  if (matrix === undefined) throw new Error("Compiled pose result missing");
  const lines = shader.code
    .split("\n")
    .filter((line) => line.trimStart().startsWith(`${matrix} =`));
  const target = /skinWeight.x \* (\w+)\.value/u.exec(lines[0] ?? "")?.[1];
  if (target === undefined) throw new Error("Compiled target palette missing");
  const equation = lines.find((line) => line.includes("1.0 -"));
  const uniform = (name: string) => {
    const input = builder.uniforms.vertex.find((u) => u.name === name)?.node.value.array;
    if (input === undefined) throw new Error(`Compiled buffer ${name} missing`);
    return input;
  };
  return () => shaderPose(uniform, target, matrix, equation);
}

function shaderPose(
  uniform: (name: string) => Float32Array,
  target: string,
  matrix: string,
  equation?: string,
): Vector3 {
  const point = new Vector3().applyMatrix4(new Matrix4().fromArray(uniform(target)));
  if (equation === undefined) return point;
  const alpha = /1.0 - (\w+)\.value/u.exec(equation)?.[1];
  const root = /\* \( (\w+)\.value\[ instanceIndex \] \*/u.exec(equation)?.[1];
  const from = /skinWeight.x \* (\w+)\.value/u.exec(equation)?.[1];
  if (alpha === undefined || root === undefined || from === undefined)
    throw new Error("Compiled blend inputs missing");
  expect(equation).toMatch(new RegExp(`${alpha}\\.value\\[ instanceIndex \\]\\.x \\* ${matrix}`));
  const amount = uniform(alpha)[0] as number;
  if (amount >= 1) return point;
  return new Vector3()
    .applyMatrix4(new Matrix4().fromArray(uniform(from)))
    .applyMatrix4(new Matrix4().fromArray(uniform(root)))
    .lerp(point, amount);
}

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

  it.each([4, 8])("rewrites a hidden slot after a skipped update at rate %i", (updateRate) => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    root.add(mesh);
    const player = new AnimationPlayer({ root, clips: [], strideSync: false, updateRate });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;

    player.update(0, true);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect(batch.palette.some((value) => value !== 0)).toBe(true);

    batch.begin();
    batch.hide(slot);
    batch.end();
    do player.update(1 / 60);
    while (player.updateRateReport.evaluated);

    root.updateMatrixWorld(true);
    batch.begin();
    batch.restart(slot);
    batch.write(slot, mesh);
    batch.end();
    expect(batch.palette.some((value) => value !== 0)).toBe(true);
    expect([...(batch.history as Float32Array)]).toEqual([...batch.palette]);

    player.dispose();
    batch.dispose();
  });

  it("writes the restored pose and velocity history when stopped after a skipped tick", () => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    (mesh.skeleton.bones[0] as Bone).name = "joint";
    root.add(mesh);
    const player = new AnimationPlayer({
      root,
      clips: [
        new AnimationClip("move", 1, [
          new NumberKeyframeTrack("joint.position[x]", [0, 1], [0, 1]),
        ]),
      ],
      strideSync: false,
      updateRate: 8,
    });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;
    player.play("move");
    player.update(0, true);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    const initial = batch.palette.slice();
    player.update(0.5, true);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    const animated = batch.palette.slice();
    do player.update(1 / 60);
    while (player.updateRateReport.evaluated);
    player.stop();
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect([...batch.palette]).toEqual([...initial]);
    expect([...(batch.history as Float32Array)]).toEqual([...animated]);
    player.dispose();
    batch.dispose();
  });

  it("draws equal steps through a rate-four linear pose instead of holds and catch-up", () => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    (mesh.skeleton.bones[0] as Bone).name = "joint";
    root.add(mesh);
    const player = new AnimationPlayer({
      root,
      clips: [
        new AnimationClip("move", 10, [
          new NumberKeyframeTrack("joint.position[x]", [0, 10], [0, 10]),
        ]),
      ],
      strideSync: false,
      updateRate: 4,
    });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: false });
    const slot = batch.claim(mesh) as number;
    const drawnPosition = compiledPose(batch);
    const positions: number[] = [];
    try {
      player.play("move");
      for (let tick = 0; tick < 36; tick += 1) {
        player.update(1 / 60, tick === 0);
        root.updateMatrixWorld(true);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        positions.push(drawnPosition().x);
      }
      const steps = positions.slice(17).map((x, i) => x - (positions[i + 16] as number));
      expect(Math.min(...steps)).toBeGreaterThan(0);
      expect(Math.max(...steps) / Math.min(...steps)).toBeLessThanOrEqual(1.05);
    } finally {
      player.dispose();
      batch.dispose();
    }
  });

  it.each([false, true, "partial"] as const)(
    "keeps moving roots current and velocity equal to the previously displayed pose (external armature=%s)",
    (external) => {
      const root = new Group();
      const mesh = rig(rigGeometry(), new MeshStandardMaterial());
      (mesh.skeleton.bones[0] as Bone).name = "joint";
      root.add(mesh);
      const player = new AnimationPlayer({
        root,
        clips: [
          new AnimationClip("move", 10, [
            new NumberKeyframeTrack("joint.position[x]", [0, 10], [0, 10]),
          ]),
        ],
        strideSync: false,
        updateRate: 4,
      });
      const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
      const slot = batch.claim(mesh) as number;
      const current = compiledPose(batch);
      const previous = compiledPose(batch, true);
      const armature = new Group();
      if (external) {
        root.add(armature);
        if (external === "partial") {
          const omittedAncestor = new Bone();
          armature.add(omittedAncestor);
          omittedAncestor.add(mesh.skeleton.bones[0] as Bone);
        } else armature.add(mesh.skeleton.bones[0] as Bone);
      }
      const movingRoot = external ? armature : root;
      let last: Vector3 | undefined;
      try {
        player.play("move");
        for (let tick = 0; tick < 36; tick += 1) {
          movingRoot.position.y += 0.1;
          player.update(1 / 60, tick === 0);
          root.updateMatrixWorld(true);
          batch.begin();
          batch.write(slot, mesh);
          batch.end();
          const point = current();
          expect(point.y).toBeCloseTo(movingRoot.position.y, 5);
          expect(previous().distanceTo(last ?? point)).toBeLessThan(1e-5);
          last = point;
        }
        player.update(1 / 60, true);
        root.updateMatrixWorld(true);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        const exact = current();
        expect(exact.x).toBeCloseTo(mesh.skeleton.bones[0]?.position.x as number, 5);
        do player.update(0);
        while (player.updateRateReport.evaluated);
        root.updateMatrixWorld(true);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        expect(current().distanceTo(exact)).toBeLessThan(1e-5);
        batch.hide(slot);
        batch.restart(slot);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        expect(current().distanceTo(exact)).toBeLessThan(1e-5);
        expect(previous().distanceTo(exact)).toBeLessThan(1e-5);
      } finally {
        player.dispose();
        batch.dispose();
      }
    },
  );

  it("ignores incomplete internal rate metadata instead of corrupting the drawn pose", () => {
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    mesh.userData["threenative.animationRateState"] = { evaluated: false, evaluation: 1 };
    (mesh.skeleton.bones[0] as Bone).position.x = 0.25;
    mesh.updateMatrixWorld(true);
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: false });
    const slot = batch.claim(mesh) as number;
    try {
      batch.begin();
      expect(() => batch.write(slot, mesh)).not.toThrow();
      batch.end();
      expect(compiledPose(batch)().x).toBeCloseTo(0.25);
    } finally {
      batch.dispose();
    }
  });

  it("does not revive a stale blend when an attachment leaves during a held tick", () => {
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    const bone = mesh.skeleton.bones[0] as Bone;
    bone.name = "joint";
    const player = new AnimationPlayer({
      root: mesh,
      strideSync: false,
      updateRate: 4,
      clips: [
        new AnimationClip("move", 10, [
          new NumberKeyframeTrack("joint.position[x]", [0, 10], [0, 10]),
        ]),
      ],
    });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;
    const current = compiledPose(batch);
    const draw = () => {
      mesh.updateMatrixWorld(true);
      batch.begin();
      batch.write(slot, mesh);
      batch.end();
    };
    try {
      player.play("move");
      for (let tick = 0; tick < 36; tick += 1) {
        player.update(1 / 60, tick === 0);
        draw();
      }
      let interpolating = false;
      for (let tick = 0; tick < 8; tick += 1) {
        player.update(1 / 60);
        draw();
        if (
          !player.updateRateReport.evaluated &&
          Math.abs(current().x - bone.position.x) >= 0.001
        ) {
          interpolating = true;
          break;
        }
      }
      expect(interpolating).toBe(true);
      const weapon = new Mesh(rigGeometry(), new MeshStandardMaterial());
      bone.add(weapon);
      draw();
      const exact = current();
      expect(exact.x).toBeCloseTo(bone.position.x, 5);
      bone.remove(weapon);
      draw();
      expect(current().distanceTo(exact)).toBeLessThan(1e-5);
    } finally {
      player.dispose();
      batch.dispose();
    }
  });

  it("keeps rate-one shader poses exact and recycled slots free of the previous owner", () => {
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    (mesh.skeleton.bones[0] as Bone).name = "joint";
    const player = new AnimationPlayer({
      root: mesh,
      clips: [
        new AnimationClip("move", 10, [
          new NumberKeyframeTrack("joint.position[x]", [0, 10], [0, 10]),
        ]),
      ],
      strideSync: false,
      updateRate: 1,
    });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;
    const current = compiledPose(batch);
    const previous = compiledPose(batch, true);
    try {
      player.play("move");
      for (let tick = 0; tick < 12; tick += 1) {
        player.update(1 / 60);
        mesh.position.y += 0.1;
        mesh.updateMatrixWorld(true);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        const exact = mesh.applyBoneTransform(0, new Vector3()).applyMatrix4(mesh.matrixWorld);
        expect(current().distanceTo(exact)).toBeLessThan(1e-6);
      }
      batch.release(mesh);
      const replacement = rig(mesh.geometry, mesh.material as MeshStandardMaterial);
      replacement.position.set(9, 8, 7);
      replacement.updateMatrixWorld(true);
      expect(batch.claim(replacement)).toBe(slot);
      batch.begin();
      batch.write(slot, replacement);
      batch.end();
      const exact = replacement
        .applyBoneTransform(0, new Vector3())
        .applyMatrix4(replacement.matrixWorld);
      expect(current().distanceTo(exact)).toBeLessThan(1e-6);
      expect(previous().distanceTo(exact)).toBeLessThan(1e-6);
    } finally {
      player.dispose();
      batch.dispose();
    }
  });

  it("keeps the target palette unwritten until evaluation while the shader interpolates its display", () => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    root.add(mesh);
    const player = new AnimationPlayer({
      root,
      clips: [
        new AnimationClip("turn", 1, [
          new NumberKeyframeTrack(".rotation[x]", [0, 1], [0, Math.PI]),
        ]),
      ],
      strideSync: false,
      updateRate: 4,
    });
    player.play("turn");
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;
    player.update(0, true);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    const first = batch.palette.slice();

    let skipped = false;
    while (!skipped) {
      player.update(1 / 60);
      if (player.updateRateReport.evaluated) {
        root.updateMatrixWorld(true);
        batch.begin();
        batch.write(slot, mesh);
        batch.end();
        first.set(batch.palette);
      }
      skipped = !player.updateRateReport.evaluated;
    }
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect([...(batch.history as Float32Array)]).toEqual([...batch.palette]);

    while (!player.updateRateReport.evaluated) player.update(1 / 60);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect([...(batch.history as Float32Array)]).toEqual([...first]);
    expect([...batch.palette]).not.toEqual([...first]);

    player.updateRate = 1;
    player.update(1 / 60);
    root.updateMatrixWorld(true);
    batch.begin();
    batch.write(slot, mesh);
    batch.end();
    expect([...(batch.history as Float32Array)]).not.toEqual([...batch.palette]);
    player.dispose();
    batch.dispose();
  });

  it("keeps an unparented camera target at full rate behind a projected skinned batch", () => {
    const scene = new Scene();
    const geometry = rigGeometry();
    const material = new MeshStandardMaterial();
    const entries = Array.from({ length: 8 }, (_, index) => {
      const root = new Group();
      root.position.set(index * 5, 0, -120);
      const mesh = rig(geometry, material);
      root.add(mesh);
      (mesh.skeleton.bones[0] as Bone).name = "joint";
      scene.add(root);
      const player = new AnimationPlayer({
        root,
        clips: [
          new AnimationClip("turn", 1, [
            new NumberKeyframeTrack("joint.rotation[z]", [0, 1], [0, Math.PI]),
          ]),
        ],
        strideSync: false,
      });
      player.play("turn");
      return { player, root };
    });
    const projection = new SceneRenderProjection(scene);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1_000);
    camera.lookAt(0, 0, -120);
    scene.updateMatrixWorld(true);
    projection.reconcile();
    expect(projection.report.skinnedBatches).toBe(1);

    const cull = new RenderCameraCull();
    cull.apply(projection.root, camera, 720);
    cull.restore();
    for (const entry of entries) entry.player.update(1 / 60);

    expect(entries[0]?.player.updateRateReport).toMatchObject({ rate: 1, overridden: false });
    expect(entries[1]?.player.updateRateReport.rate).toBe(4);

    cull.dispose();
    projection.dispose();
    for (const entry of entries) entry.player.dispose();
  });

  it("protects an animated ancestor owned by a different player", () => {
    const { scene, rigs } = crowd(8);
    const outer = new Group();
    scene.add(outer);
    const players = rigs.map((mesh) => {
      mesh.position.set(20, 0, -120);
      outer.add(mesh);
      (mesh.skeleton.bones[0] as Bone).name = "joint";
      return new AnimationPlayer({
        root: mesh,
        strideSync: false,
        clips: [
          new AnimationClip("bend", 10, [
            new NumberKeyframeTrack("joint.rotation[x]", [0, 10], [0, 1]),
          ]),
        ],
      });
    });
    const parent = new AnimationPlayer({
      root: outer,
      strideSync: false,
      clips: [
        new AnimationClip("turn", 10, [new NumberKeyframeTrack(".rotation[y]", [0, 10], [0, 1])]),
      ],
    });
    const projection = new SceneRenderProjection(scene);
    const cull = new RenderCameraCull();
    try {
      scene.updateMatrixWorld(true);
      projection.reconcile();
      cull.apply(projection.root, new PerspectiveCamera(60, 1, 0.1, 1_000), 720);
      cull.restore();
      expect(parent.updateRateReport).toMatchObject({ rate: 1, overridden: false });
    } finally {
      projection.dispose();
      cull.dispose();
      parent.dispose();
      for (const player of players) player.dispose();
    }
  });

  it.each([".rotation[x]", "joint.rotation[x]"])(
    "protects animated non-bone root compensation at %s",
    (track) => {
      const { scene, rigs } = crowd(8);
      const players = rigs.map((mesh) => {
        mesh.position.set(20, 0, -120);
        (mesh.skeleton.bones[0] as Bone).name = "joint";
        const player = new AnimationPlayer({
          root: mesh,
          strideSync: false,
          clips: [new AnimationClip("turn", 10, [new NumberKeyframeTrack(track, [0, 10], [0, 1])])],
        });
        player.play("turn");
        return player;
      });
      const projection = new SceneRenderProjection(scene);
      const cull = new RenderCameraCull();
      try {
        scene.updateMatrixWorld(true);
        projection.reconcile();
        cull.apply(projection.root, new PerspectiveCamera(60, 1, 0.1, 1_000), 720);
        cull.restore();
        if (track.startsWith("."))
          expect(players[0]?.updateRateReport).toMatchObject({ rate: 1, overridden: false });
        else expect(players[0]?.updateRateReport.rate).toBeGreaterThan(1);
      } finally {
        projection.dispose();
        cull.dispose();
        for (const player of players) player.dispose();
      }
    },
  );

  it("keeps dynamically bone-attached props coherent by reporting a full-rate auto pose", () => {
    const { scene, rigs } = crowd(8);
    const players = rigs.map((mesh) => {
      mesh.position.set(20, 0, -120);
      return new AnimationPlayer({ root: mesh, clips: [], strideSync: false });
    });
    const projection = new SceneRenderProjection(scene);
    const cull = new RenderCameraCull();
    const camera = new PerspectiveCamera(60, 1, 0.1, 1_000);
    const render = () => {
      scene.updateMatrixWorld(true);
      projection.reconcile();
      cull.apply(projection.root, camera, 720);
      cull.restore();
    };
    try {
      render();
      expect(players[0]?.updateRateReport.rate).toBeGreaterThan(1);
      const weapon = new Mesh(rigGeometry(), new MeshStandardMaterial());
      const bone = rigs[0]?.skeleton.bones[0] as Bone;
      bone.add(weapon);
      render();
      expect(players[0]?.updateRateReport).toMatchObject({ rate: 1, overridden: false });
      expect(players[1]?.updateRateReport.rate).toBeGreaterThan(1);
      bone.remove(weapon);
      render();
      expect(players[0]?.updateRateReport.rate).toBeGreaterThan(1);
    } finally {
      projection.dispose();
      cull.dispose();
      for (const player of players) player.dispose();
    }
  });

  it("observes animation roots behind exact projection proxies", () => {
    const scene = new Scene();
    const geometry = rigGeometry();
    const material = new MeshStandardMaterial();
    const camera = new PerspectiveCamera(60, 1, 0.1, 1_000);
    scene.add(camera);
    const entries: { player: AnimationPlayer; root: Group }[] = [];
    for (let index = 0; index < 9; index += 1) {
      const root = new Group();
      root.position.set(index === 0 ? 60 : 0, 0, -120);
      const mesh = rig(geometry, material);
      if (index === 0) mesh.scale.set(1, 2, 1);
      else if (index === 1 || index === 2) mesh.scale.set(-1, 1, 1);
      root.add(mesh);
      (mesh.skeleton.bones[0] as Bone).name = "joint";
      (index === 2 ? camera : scene).add(root);
      const player = new AnimationPlayer({
        root,
        clips: [
          new AnimationClip("turn", 1, [
            new NumberKeyframeTrack("joint.rotation[z]", [0, 1], [0, Math.PI]),
          ]),
        ],
        strideSync: false,
      });
      player.play("turn");
      entries.push({ player, root });
    }
    camera.lookAt(0, 0, -120);
    scene.updateMatrixWorld(true);
    const projection = new SceneRenderProjection(scene, { minMeshes: 1 });
    const cull = new RenderCameraCull({ minimumPixels: 2 });
    try {
      projection.reconcile();
      expect(projection.report.exact.nonUniformScale).toBe(1);
      expect(projection.report.exact.negativeScale).toBe(2);
      cull.apply(projection.root, camera, 720);
      cull.restore();
      for (const entry of entries) entry.player.update(1 / 60);
      expect(entries[0]?.player.updateRateReport).toMatchObject({ rate: 1, overridden: false });
      expect(entries[1]?.player.updateRateReport).toMatchObject({ rate: 1, overridden: false });
      expect(entries[2]?.player.updateRateReport).toMatchObject({ rate: 1, overridden: false });
    } finally {
      cull.dispose();
      projection.dispose();
      for (const entry of entries) entry.player.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("writes gameplay root movement on a skipped animation frame", () => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    root.add(mesh);
    const player = new AnimationPlayer({ root, clips: [], strideSync: false, updateRate: 4 });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: true });
    const slot = batch.claim(mesh) as number;
    const skeletonUpdate = vi.spyOn(mesh.skeleton, "update");
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    try {
      player.update(0, true);
      root.updateMatrixWorld(true);
      batch.begin();
      batch.write(slot, mesh);
      batch.end();
      recorder.endFrame(1);
      recorder.window();

      while (player.updateRateReport.evaluated) player.update(1 / 60);
      root.position.x = 10;
      root.updateMatrixWorld(true);
      batch.begin();
      batch.write(slot, mesh);
      batch.end();
      recorder.endFrame(1);
      expect(batch.palette[12]).toBeCloseTo(10);
      expect(batch.history?.[12]).toBeCloseTo(0);
      expect(recorder.window()?.spans.skinnedWrite?.perFrame).toBe(1);

      skeletonUpdate.mockClear();
      batch.begin();
      batch.write(slot, mesh);
      batch.end();
      recorder.endFrame(1);
      expect(skeletonUpdate).not.toHaveBeenCalled();
      expect(batch.history?.[12]).toBeCloseTo(batch.palette[12] as number);
      expect(recorder.window()?.spans.skinnedWrite?.perFrame).toBe(1);
    } finally {
      setSpanRecorder(undefined);
      skeletonUpdate.mockRestore();
      player.dispose();
      batch.dispose();
    }
  });

  it("updates auto-rate state for source rigs behind the projected skinned batch", () => {
    const root = new Group();
    const mesh = rig(rigGeometry(), new MeshStandardMaterial());
    root.add(mesh);
    // Keep this policy subject off the centre ray: this test measures projected size behind the
    // batch, not camera target recognition.
    root.position.set(10, 0, -100);
    root.updateMatrixWorld(true);
    const player = new AnimationPlayer({
      root,
      clips: [],
      strideSync: false,
    });
    const batch = new SkinnedBatch({ first: mesh, capacity: 1, velocity: false });
    batch.claim(mesh);
    batch.begin();
    batch.write(0, mesh);
    batch.end();
    const scene = new Scene();
    scene.add(batch.mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    scene.updateMatrixWorld(true);
    const cull = new RenderCameraCull();
    cull.apply(scene, camera, 720);
    cull.restore();
    expect(player.updateRateReport.rate).toBeGreaterThan(1);
    cull.dispose();
    player.dispose();
    batch.dispose();
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
