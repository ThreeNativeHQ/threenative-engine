import {
  Bone,
  BoxGeometry,
  DetachedBindMode,
  Float32BufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { computeSkinning, skinning } from "three/tsl";
import { type Node, NodeFrame, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { VelocityTracker, readVelocityPreviousWorldMatrix } from "../src/render/velocity.js";

const previousBind = Symbol.for("threenative.velocity.previousBindMatrixInverse");

interface ISkinBuilder extends WGSLNodeBuilder {
  setShaderStage(stage: string): void;
  flowStagesNode(node: Node, output: string): { code: string };
  buildUpdateNodes(): void;
  nodes: Set<Node>;
  updateNodes: Node[];
  uniforms: { vertex: { name: string; node: { value: unknown } }[] };
}

function fixture(detached = false) {
  const geometry = new BoxGeometry();
  const vertices = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
  const weights = new Float32Array(vertices * 4);
  for (let index = 0; index < vertices; index += 1) weights[index * 4] = 1;
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
  const bone = new Bone();
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.position.set(1.5, 0.3, -2);
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  if (detached) mesh.bindMode = DetachedBindMode;
  const scene = new Scene();
  scene.add(mesh);
  const tracker = new VelocityTracker();
  tracker.update(scene);
  return { bone, mesh, scene, tracker };
}

/**
 * Read the exact inverse uniform and bone buffer used by Three's compiled previous position.
 * `drawn` is the mesh the compiled program draws: meshes sharing a material and geometry share
 * one program, built for whichever of them rendered first.
 */
function shaderPreviousPosition(
  mesh: SkinnedMesh,
  point: Vector3,
  compute = false,
  drawn: SkinnedMesh = mesh,
): Vector3 {
  const builder = new WGSLNodeBuilder(mesh, {
    debug: { diagnostics: { keywords: false } },
    backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
    getMRT: () => new Set(["velocity"]),
  } as never) as ISkinBuilder;
  builder.setShaderStage("vertex");
  const shader = builder.flowStagesNode(
    (compute ? computeSkinning(mesh) : skinning(mesh)) as unknown as Node,
    "void",
  );
  builder.buildUpdateNodes();
  const frame = new NodeFrame();
  frame.object = drawn;
  frame.frameId = 2;
  for (const node of builder.updateNodes) frame.updateNode(node);
  const previousLine = shader.code
    .split("\n")
    .find((line) => line.includes("positionPrevious = ("));
  if (previousLine === undefined) throw new Error("Compiled previous skin position is missing.");
  const inverseName = /positionPrevious = \( object\.(\w+) \*/u.exec(previousLine)?.[1];
  const inverse = builder.uniforms.vertex.find(({ name }) => name === inverseName)?.node.value;
  if (!(inverse instanceof Matrix4)) throw new Error("Compiled previous skin inverse is missing.");
  const boneName = /\.x \* (\w+)\.value/u.exec(previousLine)?.[1];
  const bones = builder.uniforms.vertex.find(({ name }) => name === boneName)?.node.value;
  if (!(bones instanceof Float32Array))
    throw new Error("Compiled previous bone buffer is missing.");
  const world = readVelocityPreviousWorldMatrix(drawn);
  if (world === undefined) throw new Error("Scheduled previous world matrix is missing.");
  return point
    .clone()
    .applyMatrix4(drawn.bindMatrix)
    .applyMatrix4(new Matrix4().fromArray(bones))
    .applyMatrix4(inverse)
    .applyMatrix4(world);
}

describe("scheduled skin bind-inverse history", () => {
  it.each([false, true])(
    "keeps the actual previous skin position under root translation/rotation/scale (detached=%s)",
    (detached) => {
      const { bone, mesh, scene, tracker } = fixture(detached);
      const point = new Vector3(0.3, 0.1, -0.2);
      const previous = mesh.applyBoneTransform(0, point.clone()).applyMatrix4(mesh.matrixWorld);
      tracker.commit(scene);
      mesh.position.x -= 0.25;
      mesh.rotation.z = 0.2;
      mesh.scale.set(1.2, 0.8, 1.1);
      bone.position.y = 0.1;
      tracker.update(scene);
      expect(shaderPreviousPosition(mesh, point).distanceTo(previous)).toBeLessThan(1e-6);
    },
  );

  it("turns the current-world-as-previous mutation into zero root-motion velocity", () => {
    const { mesh, scene, tracker } = fixture();
    tracker.commit(scene);
    mesh.position.x -= 0.25;
    tracker.update(scene);
    const world = readVelocityPreviousWorldMatrix(mesh);
    if (world === undefined) throw new Error("Missing scheduled world history.");
    world.copy(mesh.matrixWorld);
    const point = new Vector3(0.3, 0.1, -0.2);
    const current = mesh.applyBoneTransform(0, point.clone()).applyMatrix4(mesh.matrixWorld);
    expect(shaderPreviousPosition(mesh, point).distanceTo(current)).toBeLessThan(1e-6);
  });

  it.each([false, true])(
    "starts with zero motion and keeps the shader path correct after recompilation (compute=%s)",
    (compute) => {
      const { mesh, scene, tracker } = fixture();
      const point = new Vector3(0.3, 0.1, -0.2);
      const first = mesh.applyBoneTransform(0, point.clone()).applyMatrix4(mesh.matrixWorld);
      expect(shaderPreviousPosition(mesh, point, compute).distanceTo(first)).toBeLessThan(1e-6);
      tracker.commit(scene);
      mesh.position.x -= 0.25;
      tracker.update(scene);
      expect(shaderPreviousPosition(mesh, point, compute).distanceTo(first)).toBeLessThan(1e-6);
      expect(shaderPreviousPosition(mesh, point, compute).distanceTo(first)).toBeLessThan(1e-6);
    },
  );

  it("keeps each shared-skeleton mesh's bind inverse independent", () => {
    const { mesh, scene, tracker } = fixture();
    const other = new SkinnedMesh(mesh.geometry, mesh.material);
    other.position.set(4, -2, 1);
    other.bind(mesh.skeleton, mesh.bindMatrix);
    scene.add(other);
    tracker.update(scene);
    const first = mesh.bindMatrixInverse.clone();
    const second = other.bindMatrixInverse.clone();
    tracker.commit(scene);
    mesh.position.x -= 0.25;
    other.position.y += 0.5;
    tracker.update(scene);
    expect(Reflect.get(mesh, previousBind)).toEqual(first);
    expect(Reflect.get(other, previousBind)).toEqual(second);
    expect(Reflect.get(mesh, previousBind)).not.toEqual(Reflect.get(other, previousBind));
    const point = new Vector3(0.3, 0.1, -0.2);
    const expected = point.clone().applyMatrix4(mesh.bindMatrix);
    expect(shaderPreviousPosition(mesh, point).distanceTo(expected)).toBeLessThan(1e-6);
    expect(shaderPreviousPosition(other, point).distanceTo(expected)).toBeLessThan(1e-6);
  });

  it("keeps bind history through late writes and commits the drawn inverse for the next frame", () => {
    const { mesh, scene, tracker } = fixture();
    const first = mesh.bindMatrixInverse.clone();
    tracker.commit(scene);
    mesh.position.x -= 0.1;
    tracker.update(scene);
    mesh.position.x -= 0.2;
    scene.updateMatrixWorld(true);
    expect(Reflect.get(mesh, previousBind)).toEqual(first);
    const drawn = mesh.bindMatrixInverse.clone();
    tracker.commit(scene);
    expect(Reflect.get(mesh, previousBind)).toEqual(first);
    tracker.update(scene);
    expect(Reflect.get(mesh, previousBind)).toEqual(drawn);
    expect(Reflect.get(mesh, previousBind)).not.toBe(mesh.bindMatrixInverse);
    tracker.clear();
    expect(Reflect.has(mesh, previousBind)).toBe(false);
    tracker.update(scene);
    expect(Reflect.get(mesh, previousBind)).toEqual(mesh.bindMatrixInverse);
    scene.remove(mesh);
    tracker.update(scene);
    expect(Reflect.has(mesh, previousBind)).toBe(false);
  });

  it("reads each skeleton's own bone history when meshes share one material and geometry", () => {
    // A crowd of one rig: SkeletonUtils.clone gives every figure its own skeleton but shares the
    // geometry, and a game that tints the crowd shares one material, so all of them draw through
    // the program built for the first. Its previous bones must still be the drawn figure's own.
    const { mesh, scene, tracker } = fixture();
    const bone = new Bone();
    const other = new SkinnedMesh(mesh.geometry, mesh.material);
    other.position.set(4, 0.3, 1);
    other.add(bone);
    other.bind(new Skeleton([bone]));
    scene.add(other);
    tracker.update(scene);
    const point = new Vector3(0.3, 0.1, -0.2);
    shaderPreviousPosition(mesh, point);
    // The other figure is mid-stride and the first is at rest: only the drawn figure's own bones
    // put its previous position where it was.
    bone.position.set(0.2, 0.4, 0);
    scene.updateMatrixWorld(true);
    tracker.commit(scene);
    const previous = other.applyBoneTransform(0, point.clone()).applyMatrix4(other.matrixWorld);
    other.position.x += 0.25;
    bone.position.set(0.3, 0.5, 0);
    tracker.update(scene);
    expect(shaderPreviousPosition(mesh, point, false, other).distanceTo(previous)).toBeLessThan(
      1e-6,
    );
  });
});
