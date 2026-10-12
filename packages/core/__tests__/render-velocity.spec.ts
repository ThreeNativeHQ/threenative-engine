import {
  BatchedMesh,
  Bone,
  BoxGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import { instance, pass, skinning } from "three/tsl";
import type { Node } from "three/webgpu";
import { VelocityNode, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

import * as projectionPlan from "../src/projection-plan.js";
import { readBatchedMeshPreviousMatrices } from "../src/render/batched-velocity.js";
import { type IRenderChainRenderer, RenderChain } from "../src/render/chain.js";
import {
  VELOCITY_PREVIOUS_INSTANCE_MATRICES,
  VelocityTracker,
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
} from "../src/render/velocity.js";
import { SceneRenderProjection } from "../src/renderProjection.js";
import {
  SoftwareVelocityRenderer,
  isObjectEvent,
  prepareVelocityShaderState,
  previousBuffer,
} from "./velocity-render-fixture.js";

/**
 * Three's own compile-time gate. `NodeBuilder.needsPreviousData()` decides whether `skinning()`,
 * `instance()` and `batch()` emit a `positionPrevious` assignment at all, so it is the only
 * honest question to ask of a velocity provisioning pass.
 */
function needsPreviousData(object: Object3D, mrt: Set<string> | null = null): boolean {
  // Two casts, both because three's published types are narrower than its runtime: the builder
  // only ever calls `getMRT()` on the renderer it is handed, and `needsPreviousData` is not on
  // the declared `NodeBuilder` surface at all.
  const renderer = { getMRT: () => mrt } as unknown as ConstructorParameters<
    typeof WGSLNodeBuilder
  >[1];
  const builder = new WGSLNodeBuilder(object, renderer) as unknown as {
    needsPreviousData: () => boolean;
  };
  return builder.needsPreviousData();
}

function skinnedCharacter(): SkinnedMesh {
  const geometry = new BoxGeometry(1, 2, 1);
  const vertices = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
  const weights = new Float32Array(vertices * 4);
  for (let index = 0; index < vertices; index += 1) weights[index * 4] = 1;
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
  const root = new Bone();
  const skeleton = new Skeleton([root]);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.add(root);
  mesh.bind(skeleton);
  return mesh;
}

function stubRenderer(): IRenderChainRenderer & { velocityEnabled: boolean } {
  return {
    kind: "webgpu",
    raw: {},
    velocityEnabled: false,
    setOutputNode() {},
    clearOutputNode() {},
    setRenderChainVelocityEnabled(enabled: boolean) {
      this.velocityEnabled = enabled;
    },
  } as IRenderChainRenderer & { velocityEnabled: boolean };
}

function textureNames(scenePass: ReturnType<typeof pass>): string[] {
  const renderTarget = (scenePass as unknown as { renderTarget: { textures: { name: string }[] } })
    .renderTarget;
  return renderTarget.textures.map((texture) => texture.name);
}

function batchMatrixData(
  batch: BatchedMesh,
  property: "_matricesTexture" | "_previousMatricesTexture",
): Float32Array {
  const texture = (
    batch as unknown as {
      _matricesTexture: { image: { data: Float32Array } };
      _previousMatricesTexture: { image: { data: Float32Array } };
    }
  )[property];
  if (texture === undefined) throw new Error(`batch texture '${property}' is missing`);
  return texture.image.data;
}

function previousModelWorldMatrix(node: VelocityNode): Matrix4 {
  return (
    node as unknown as {
      previousModelWorldMatrix: { value: Matrix4 };
    }
  ).previousModelWorldMatrix.value;
}

interface IInspectableVelocityBuilder {
  buildUpdateNodes(): void;
  flowStagesNode(node: Node, output: string): unknown;
  nodes: Set<{
    readonly constructor: { readonly name: string };
    readonly isBufferNode?: boolean;
    readonly value?: unknown;
    update(frame: unknown): unknown;
  }>;
  setShaderStage(stage: "vertex"): void;
}

function buildVelocityUpdateNodes(object: Object3D, node: Node): IInspectableVelocityBuilder {
  const renderer = {
    backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
    getMRT: () => new Set(["velocity"]),
  } as never;
  const builder = new WGSLNodeBuilder(object, renderer) as unknown as IInspectableVelocityBuilder;
  builder.setShaderStage("vertex");
  builder.flowStagesNode(node, "void");
  builder.buildUpdateNodes();
  return builder;
}

function runObjectUpdate(builder: IInspectableVelocityBuilder, object: Object3D): void {
  const event =
    [...builder.nodes].find((node) => Reflect.get(node, "eventType") === "beforeObject") ??
    [...builder.nodes].find(isObjectEvent);
  if (event === undefined) throw new Error("velocity fixture did not build an object update");
  event.update({ frameId: 1, object });
}

function velocitySceneFixture() {
  const camera = new PerspectiveCamera(60, 2, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const scene = new Scene();
  const staticMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  staticMesh.position.set(-5, 0, -8);
  const rigid = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  rigid.position.set(-3.5, 0, -8);
  const character = skinnedCharacter();
  character.position.set(-1.5, 0, -8);
  const crowd = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 2);
  crowd.position.z = -8;
  const movingInstanceId = 1;
  crowd.setMatrixAt(0, new Matrix4().makeTranslation(1.3, 0, 0));
  crowd.setMatrixAt(movingInstanceId, new Matrix4().makeTranslation(2.6, 0, 0));
  const batch = new BatchedMesh(2, 24, 36, new MeshStandardMaterial());
  batch.position.z = -8;
  const geometryId = batch.addGeometry(new BoxGeometry());
  const staticBatchInstanceId = batch.addInstance(geometryId);
  const movingBatchInstanceId = batch.addInstance(geometryId);
  batch.setMatrixAt(staticBatchInstanceId, new Matrix4().makeTranslation(4, 0, 0));
  batch.setMatrixAt(movingBatchInstanceId, new Matrix4().makeTranslation(5.3, 0, 0));
  scene.add(staticMesh, rigid, character, crowd, batch);

  return {
    batch,
    camera,
    character,
    crowd,
    movingBatchInstanceId,
    movingInstanceId,
    rigid,
    scene,
    scenePass: pass(scene, camera),
    staticMesh,
  };
}

describe("velocity provisioning on the shipped path", () => {
  it("gives a skinned character and a moving instance previous-frame data when a temporal stage runs", () => {
    const scene = new Scene();
    const wall = new Mesh(new BoxGeometry(20, 6, 0.5), new MeshStandardMaterial());
    wall.position.set(0, 3, -6);
    const character = skinnedCharacter();
    const crowd = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 4);
    for (let index = 0; index < 4; index += 1) {
      crowd.setMatrixAt(index, new Matrix4().makeTranslation(index * 2, 0, 0));
    }
    scene.add(wall, character, crowd);

    const renderer = stubRenderer();
    const chain = new RenderChain({
      renderer,
      request: { stages: ["traa"], velocity: { perObject: true } },
      stages: [{ build: (input) => input ?? {}, name: "traa" }],
      report: () => undefined,
    });
    expect(chain.applied.stages).toContain("traa");

    const projection = new SceneRenderProjection(scene, {
      velocity: () => renderer.velocityEnabled,
    });
    projection.reconcile();

    expect({
      character: needsPreviousData(character),
      crowd: needsPreviousData(crowd),
    }).toEqual({ character: true, crowd: true });
  });

  it("keeps each instance's previous matrix at the scheduled frame boundary", () => {
    const scene = new Scene();
    const crowd = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 3);
    const first = [
      new Matrix4().makeTranslation(0, 0, -4),
      new Matrix4().makeTranslation(2, 0, -4),
      new Matrix4().makeTranslation(4, 0, -4),
    ];
    first.forEach((matrix, index) => crowd.setMatrixAt(index, matrix));
    scene.add(crowd);

    const tracker = new VelocityTracker();
    tracker.update(scene);
    const previousFrame = readVelocityPreviousMatrices(crowd);
    expect(previousFrame).toBeDefined();
    expect(previousFrame).toEqual(crowd.instanceMatrix.array);
    tracker.commit(scene);

    crowd.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, -4));
    tracker.update(scene);

    const scheduledPrevious = readVelocityPreviousMatrices(crowd);
    expect(scheduledPrevious).toEqual(previousFrame);
    expect(scheduledPrevious).not.toEqual(crowd.instanceMatrix.array);

    tracker.clear();
    expect(readVelocityPreviousMatrices(crowd)).toBeUndefined();
    expect(needsPreviousData(crowd)).toBe(false);
  });

  it("keeps BatchedMesh previous matrices per sub-draw", () => {
    const scene = new Scene();
    const batch = new BatchedMesh(2, 24, 36, new MeshStandardMaterial());
    const geometryId = batch.addGeometry(new BoxGeometry(1, 1, 1));
    const stillId = batch.addInstance(geometryId);
    const movingId = batch.addInstance(geometryId);
    const stillMatrix = new Matrix4().makeTranslation(-1, 0, -4);
    const movingMatrix = new Matrix4().makeTranslation(1, 0, -4);
    batch.setMatrixAt(stillId, stillMatrix);
    batch.setMatrixAt(movingId, movingMatrix);
    scene.add(batch);

    const tracker = new VelocityTracker();
    tracker.update(scene);
    tracker.commit(scene);

    const firstFrame = readVelocityPreviousMatrices(batch);
    expect(firstFrame).toBeDefined();
    expect(
      new Matrix4().fromArray(firstFrame as Float32Array, stillId * 16).equals(stillMatrix),
    ).toBe(true);
    expect(
      new Matrix4().fromArray(firstFrame as Float32Array, movingId * 16).equals(movingMatrix),
    ).toBe(true);
    expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(
      batchMatrixData(batch, "_matricesTexture"),
    );

    const movedMatrix = new Matrix4().makeTranslation(2, 0, -4);
    batch.setMatrixAt(movingId, movedMatrix);
    tracker.update(scene);

    const scheduledPrevious = readVelocityPreviousMatrices(batch);
    expect(scheduledPrevious).toBeDefined();
    expect(
      new Matrix4().fromArray(scheduledPrevious as Float32Array, stillId * 16).equals(stillMatrix),
    ).toBe(true);
    expect(
      new Matrix4()
        .fromArray(scheduledPrevious as Float32Array, movingId * 16)
        .equals(movingMatrix),
    ).toBe(true);
    expect(
      new Matrix4().fromArray(scheduledPrevious as Float32Array, movingId * 16).equals(movedMatrix),
    ).toBe(false);
    expect(
      new Matrix4()
        .fromArray(batchMatrixData(batch, "_previousMatricesTexture"), stillId * 16)
        .equals(stillMatrix),
    ).toBe(true);
    expect(
      new Matrix4()
        .fromArray(batchMatrixData(batch, "_previousMatricesTexture"), movingId * 16)
        .equals(movingMatrix),
    ).toBe(true);
    expect(
      new Matrix4()
        .fromArray(batchMatrixData(batch, "_matricesTexture"), movingId * 16)
        .equals(movedMatrix),
    ).toBe(true);

    tracker.commit(scene);
    const movedAgainMatrix = new Matrix4().makeTranslation(3, 0, -4);
    batch.setMatrixAt(movingId, movedAgainMatrix);
    tracker.update(scene);
    expect(
      new Matrix4()
        .fromArray(batchMatrixData(batch, "_previousMatricesTexture"), movingId * 16)
        .equals(movedMatrix),
    ).toBe(true);
    expect(
      new Matrix4()
        .fromArray(batchMatrixData(batch, "_previousMatricesTexture"), stillId * 16)
        .equals(stillMatrix),
    ).toBe(true);
    tracker.clear();
  });

  it("commits authored sub-draw history when projection is disabled", () => {
    const { batch, movingBatchInstanceId, scene } = velocitySceneFixture();
    const scan = vi.spyOn(projectionPlan, "scanProjection");
    const projection = new SceneRenderProjection(scene, {
      projection: false,
      velocity: true,
      onReport: () => undefined,
    });
    try {
      projection.reconcile();
      expect(projection.root).toBe(scene);
      expect(projection.report).toMatchObject({ reasonCode: "disabled", batches: 0 });
      const first = batchMatrixData(batch, "_matricesTexture").slice();
      expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(first);
      expect(batchMatrixData(batch, "_previousMatricesTexture")).not.toBe(
        batchMatrixData(batch, "_matricesTexture"),
      );
      projection.commit();

      batch.setMatrixAt(movingBatchInstanceId, new Matrix4().makeTranslation(6.05, 0, 0));
      projection.reconcile();
      expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(first);
      expect(batchMatrixData(batch, "_matricesTexture")).not.toEqual(first);
      const moved = batchMatrixData(batch, "_matricesTexture").slice();
      projection.commit();
      // Committing cannot rewrite the history the just-rendered frame consumed.
      expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(first);
      projection.reconcile();
      expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(moved);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
      scan.mockRestore();
    }
  });

  it("resets opted-out history when temporal rendering is toggled and releases owned textures", () => {
    const { batch, movingBatchInstanceId, scene } = velocitySceneFixture();
    batch.userData.useVelocity = false;
    let velocity = false;
    const projection = new SceneRenderProjection(scene, {
      projection: false,
      velocity: () => velocity,
      onReport: () => undefined,
    });
    projection.reconcile();
    projection.commit();
    expect(readBatchedMeshPreviousMatrices(batch)).toBeUndefined();
    velocity = true;
    projection.reconcile();
    projection.commit();
    const firstTexture = readBatchedMeshPreviousMatrices(batch);
    expect(firstTexture).toBeDefined();
    let disposals = 0;
    firstTexture?.addEventListener("dispose", () => {
      disposals += 1;
    });
    expect(batch.userData.useVelocity).toBe(true);

    velocity = false;
    projection.reconcile();
    projection.commit();
    expect(disposals).toBe(1);
    expect(readBatchedMeshPreviousMatrices(batch)).toBeUndefined();
    expect(readVelocityPreviousMatrices(batch)).toBeUndefined();
    expect(readVelocityPreviousWorldMatrix(batch)).toBeUndefined();
    expect(batch.userData.useVelocity).toBe(false);

    batch.setMatrixAt(movingBatchInstanceId, new Matrix4().makeTranslation(8, 0, 0));
    velocity = true;
    projection.reconcile();
    expect(batchMatrixData(batch, "_previousMatricesTexture")).toEqual(
      batchMatrixData(batch, "_matricesTexture"),
    );
    const secondTexture = readBatchedMeshPreviousMatrices(batch);
    expect(secondTexture).not.toBe(firstTexture);
    secondTexture?.addEventListener("dispose", () => {
      disposals += 1;
    });
    projection.dispose();
    projection.dispose();
    expect(disposals).toBe(2);
    expect(readBatchedMeshPreviousMatrices(batch)).toBeUndefined();
    expect(batch.userData.useVelocity).toBe(false);
  });

  it("releases authored batch history when an opted-out scene removes the batch", () => {
    const { batch, scene } = velocitySceneFixture();
    const projection = new SceneRenderProjection(scene, {
      projection: false,
      velocity: true,
      onReport: () => undefined,
    });
    projection.reconcile();
    const texture = readBatchedMeshPreviousMatrices(batch);
    expect(texture).toBeDefined();
    let disposals = 0;
    texture?.addEventListener("dispose", () => {
      disposals += 1;
    });
    scene.remove(batch);
    projection.reconcile();
    projection.commit();
    expect(disposals).toBe(1);
    expect(readBatchedMeshPreviousMatrices(batch)).toBeUndefined();
    expect(readVelocityPreviousMatrices(batch)).toBeUndefined();
    expect(batch.userData).not.toHaveProperty("useVelocity");
    projection.dispose();
    expect(disposals).toBe(1);
  });

  it("does no history traversal with projection and temporal rendering disabled", () => {
    const { batch, scene } = velocitySceneFixture();
    const walk = vi.spyOn(scene, "traverse");
    const matrices = vi.spyOn(scene, "updateMatrixWorld");
    const projection = new SceneRenderProjection(scene, {
      projection: false,
      velocity: false,
      onReport: () => undefined,
    });
    // The one-time disabled report counts renderables; steady frames do no history work.
    projection.reconcile();
    walk.mockClear();
    matrices.mockClear();
    for (let frame = 0; frame < 3; frame += 1) {
      projection.reconcile();
      projection.commit();
    }
    expect(walk).not.toHaveBeenCalled();
    expect(matrices).not.toHaveBeenCalled();
    expect(readBatchedMeshPreviousMatrices(batch)).toBeUndefined();
    expect(readVelocityPreviousMatrices(batch)).toBeUndefined();
    expect(batch.userData).not.toHaveProperty("useVelocity");
    projection.dispose();
    walk.mockRestore();
    matrices.mockRestore();
  });

  it("freezes rigid and bone history at the scheduled frame boundary", () => {
    const scene = new Scene();
    const rigid = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    const character = skinnedCharacter();
    scene.add(rigid, character);

    const tracker = new VelocityTracker();
    tracker.update(scene);

    const firstWorld = readVelocityPreviousWorldMatrix(rigid)?.elements.slice();
    const firstBones = readVelocityPreviousBoneMatrices(character)?.slice();
    if (firstWorld === undefined || firstBones === undefined)
      throw new Error("velocity tracker did not schedule rigid and bone history");
    tracker.commit(scene);

    rigid.position.x = 2;
    const rootBone = character.skeleton.bones[0];
    if (rootBone === undefined) throw new Error("skinned fixture has no root bone");
    rootBone.position.x = 1;
    tracker.update(scene);

    expect(readVelocityPreviousWorldMatrix(rigid)?.elements).toEqual(firstWorld);
    expect(readVelocityPreviousWorldMatrix(rigid)?.elements).not.toEqual(
      rigid.matrixWorld.elements,
    );
    expect(readVelocityPreviousBoneMatrices(character)).toEqual(firstBones);
    expect(readVelocityPreviousBoneMatrices(character)).not.toEqual(
      character.skeleton.boneMatrices,
    );

    tracker.clear();
    expect(readVelocityPreviousWorldMatrix(rigid)).toBeUndefined();
    expect(readVelocityPreviousBoneMatrices(character)).toBeUndefined();
  });

  it("keeps the scheduled snapshot until the post-frame commit", () => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    scene.add(mesh);
    const tracker = new VelocityTracker();

    tracker.update(scene);
    tracker.commit(scene);
    const firstFrame = readVelocityPreviousWorldMatrix(mesh);
    expect(firstFrame).toBeDefined();

    mesh.position.x = 1;
    tracker.update(scene);
    const scheduledPrevious = readVelocityPreviousWorldMatrix(mesh);
    expect(scheduledPrevious?.equals(firstFrame as Matrix4)).toBe(true);

    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateProjectionMatrix();
    const velocityNode = new VelocityNode();
    velocityNode.setProjectionMatrix(camera.projectionMatrix);
    velocityNode.update({ frameId: 2, camera, object: mesh } as never);
    expect(previousModelWorldMatrix(velocityNode).equals(scheduledPrevious as Matrix4)).toBe(true);

    mesh.position.x = 2;
    scene.updateMatrixWorld(true);
    const colourSnapshot = mesh.matrixWorld.clone();
    tracker.commit(scene);

    expect(readVelocityPreviousWorldMatrix(mesh)?.equals(firstFrame as Matrix4)).toBe(true);

    tracker.update(scene);
    expect(readVelocityPreviousWorldMatrix(mesh)?.equals(colourSnapshot)).toBe(true);
  });

  it("does not allocate a velocity target when no temporal stage is requested", () => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    const before = textureNames(scenePass);

    const renderer = stubRenderer();
    new RenderChain({
      renderer,
      input: scenePass.getTextureNode("output"),
      request: { stages: ["bloom"], velocity: { pass: scenePass } },
      stages: [{ build: (input) => input ?? {}, name: "bloom" }],
      report: () => undefined,
    });

    expect(textureNames(scenePass)).toEqual(before);
    expect(scenePass.getMRT()).toBeNull();
  });

  it("adds one velocity target and hands its node to an active temporal stage", () => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    let received: Node | undefined;
    const renderer = stubRenderer();
    const chain = new RenderChain({
      renderer,
      input: scenePass.getTextureNode("output"),
      request: { stages: ["traa"], velocity: { pass: scenePass } },
      stages: [
        {
          build: (input, context) => {
            received = context.velocityNode;
            return input ?? {};
          },
          name: "traa",
        },
      ],
      report: () => undefined,
    });

    expect(chain.applied.stages).toEqual(["traa"]);
    expect(chain.applied.velocity).toMatchObject({ provisioned: true, source: "mrt" });
    expect(scenePass.getMRT()?.has("velocity")).toBe(true);
    expect(textureNames(scenePass)).toContain("velocity");
    expect(received?.isNode).toBe(true);
    expect(renderer.velocityEnabled).toBe(true);
  });

  it("gives temporal nodes the scene-side velocity node, not its texture, through the context", () => {
    // Three's TRAANode reads `builder.context.velocity` and jitters it with setProjectionMatrix;
    // handing it the pass texture threw on every frame of every game that requested `traa`.
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    let output: unknown;
    const renderer = {
      ...stubRenderer(),
      setOutputNode: (node: unknown) => {
        output = node;
      },
    };
    new RenderChain({
      renderer,
      input: scenePass.getTextureNode("output"),
      request: { stages: ["traa"], velocity: { pass: scenePass } },
      stages: [{ build: (input) => input ?? {}, name: "traa" }],
      report: () => undefined,
    });

    const velocity = (output as { value?: { velocity?: unknown } }).value?.velocity;
    expect(velocity).toBeInstanceOf(VelocityNode);
  });

  it("does not allocate velocity for temporal stages dropped by tier or provider checks", () => {
    const tierOffPass = pass(new Scene(), new PerspectiveCamera());
    const tierOffChain = new RenderChain({
      renderer: stubRenderer(),
      input: tierOffPass.getTextureNode("output"),
      request: {
        stages: ["traa"],
        tier: "off",
        velocity: { pass: tierOffPass },
      },
      stages: [{ name: "traa", build: (input) => input ?? {} }],
    });

    expect(tierOffChain.applied.stages).toEqual([]);
    expect(tierOffChain.applied.velocity.provisioned).toBe(false);
    expect(tierOffChain.applied.velocity.source).toBeNull();
    expect(textureNames(tierOffPass)).not.toContain("velocity");

    const missingProviderPass = pass(new Scene(), new PerspectiveCamera());
    const missingProviderChain = new RenderChain({
      renderer: stubRenderer(),
      input: missingProviderPass.getTextureNode("output"),
      request: {
        stages: ["traa"],
        velocity: { pass: missingProviderPass },
      },
      stages: [],
    });

    expect(missingProviderChain.applied.stages).toEqual([]);
    expect(missingProviderChain.applied.velocity.provisioned).toBe(false);
    expect(textureNames(missingProviderPass)).not.toContain("velocity");
  });

  it.each([true, false])("renders non-zero MRT footprints with projection %s", (enabled) => {
    const fixture = velocitySceneFixture();
    const renderer = new SoftwareVelocityRenderer(fixture.scenePass, 200, 100);
    let receivedVelocityNode: Node | undefined;
    const chain = new RenderChain({
      renderer,
      input: fixture.scenePass.getTextureNode("output"),
      request: { stages: ["traa"], velocity: { pass: fixture.scenePass } },
      stages: [
        {
          name: "traa",
          build: (input, context) => {
            receivedVelocityNode = context.velocityNode;
            return input ?? {};
          },
        },
      ],
      report: () => undefined,
    });

    const projection = new SceneRenderProjection(fixture.scene, {
      projection: enabled,
      velocity: true,
      onReport: () => undefined,
    });
    projection.reconcile();
    projection.commit();

    fixture.rigid.position.x += 0.75;
    const rootBone = fixture.character.skeleton.bones[0];
    if (rootBone === undefined) throw new Error("skinned fixture has no root bone");
    rootBone.position.x += 0.75;
    fixture.crowd.setMatrixAt(fixture.movingInstanceId, new Matrix4().makeTranslation(3.35, 0, 0));
    fixture.batch.setMatrixAt(
      fixture.movingBatchInstanceId,
      new Matrix4().makeTranslation(6.05, 0, 0),
    );
    fixture.scene.updateMatrixWorld(true);
    projection.reconcile();

    renderer.setShaderState(
      prepareVelocityShaderState(fixture.camera, {
        ...fixture,
      }),
    );
    const rendered = renderer.render(fixture.camera);
    projection.commit();

    expect(chain.applied.velocity).toMatchObject({ provisioned: true, source: "mrt" });
    expect(fixture.scenePass.getMRT()?.has("velocity")).toBe(true);
    expect(receivedVelocityNode?.isNode).toBe(true);
    expect(renderer.outputNode).toMatchObject({ isNode: true });
    expect(rendered.pixels.some((value) => Math.abs(value) > 1e-6)).toBe(true);
    expect(rendered.footprints.get("static")).toMatchObject({
      coveredPixels: expect.any(Number),
      movingPixels: 0,
    });
    expect(rendered.footprints.get("rigid")?.movingPixels).toBeGreaterThan(0);
    expect(rendered.footprints.get("skinned")?.movingPixels).toBeGreaterThan(0);
    expect(rendered.footprints.get("instanced-moving")?.movingPixels).toBeGreaterThan(0);
    expect(rendered.footprints.get("instanced-static")?.movingPixels).toBe(0);
    expect(rendered.footprints.get("batched-moving")?.movingPixels).toBeGreaterThan(0);
    expect(rendered.footprints.get("batched-static")?.movingPixels).toBe(0);
    projection.dispose();
  });

  it("feeds the scheduled snapshots into Three's instance and skinning update hooks", () => {
    const scene = new Scene();
    const character = skinnedCharacter();
    const crowd = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 2);
    crowd.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -4));
    crowd.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, -4));
    scene.add(character, crowd);

    const tracker = new VelocityTracker();
    tracker.update(scene);
    tracker.commit(scene);
    const rootBone = character.skeleton.bones[0];
    if (rootBone === undefined) throw new Error("skinned fixture has no root bone");
    rootBone.position.x = 1;
    crowd.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, -4));
    scene.updateMatrixWorld(true);
    tracker.update(scene);

    const instanceBuilder = buildVelocityUpdateNodes(
      crowd,
      (instance as unknown as (matrices: typeof crowd.instanceMatrix) => Node)(
        crowd.instanceMatrix,
      ),
    );
    runObjectUpdate(instanceBuilder, crowd);
    expect(previousBuffer(instanceBuilder, crowd.instanceMatrix.array)).toEqual(
      readVelocityPreviousMatrices(crowd),
    );

    const skinBuilder = buildVelocityUpdateNodes(character, skinning(character) as unknown as Node);
    runObjectUpdate(skinBuilder, character);
    expect(previousBuffer(skinBuilder, character.skeleton.boneMatrices as Float32Array)).toEqual(
      readVelocityPreviousBoneMatrices(character),
    );
  });

  it("reads disocclusion rejection from the active temporal result and exposes a failing no-MRT control", () => {
    const pinnedThreshold = 0.25;
    const fixture = velocitySceneFixture();
    const renderer = new SoftwareVelocityRenderer(fixture.scenePass, 200, 100);
    let receivedVelocityNode: Node | undefined;
    const chain = new RenderChain({
      renderer,
      input: fixture.scenePass.getTextureNode("output"),
      request: { stages: ["traa"], velocity: { pass: fixture.scenePass } },
      stages: [
        {
          name: "traa",
          build: (input, context) => {
            receivedVelocityNode = context.velocityNode;
            return input ?? {};
          },
          readVelocityResult: () => renderer.readVelocityResult(),
        },
      ],
      report: () => undefined,
    });
    fixture.staticMesh.position.x = 50;
    fixture.crowd.setMatrixAt(0, new Matrix4().makeTranslation(50, 0, 0));
    fixture.crowd.setMatrixAt(fixture.movingInstanceId, new Matrix4().makeTranslation(52, 0, 0));
    fixture.batch.setMatrixAt(0, new Matrix4().makeTranslation(50, 0, 0));
    fixture.batch.setMatrixAt(
      fixture.movingBatchInstanceId,
      new Matrix4().makeTranslation(52, 0, 0),
    );
    const tracker = new VelocityTracker();
    tracker.update(fixture.scene);
    tracker.commit(fixture.scene);

    fixture.rigid.position.x += 1.25;
    const rootBone = fixture.character.skeleton.bones[0];
    if (rootBone === undefined) throw new Error("skinned fixture has no root bone");
    rootBone.position.x += 1.25;
    fixture.scene.updateMatrixWorld(true);
    tracker.update(fixture.scene);
    renderer.setShaderState(prepareVelocityShaderState(fixture.camera, { ...fixture }));
    const withVelocity = renderer.render(fixture.camera);
    chain.observeFrame();
    const correctRejection = chain.applied.velocity.rejectionFraction;
    if (correctRejection === undefined) throw new Error("temporal stage did not report rejection");
    expect(chain.applied.velocity.measurementFrame).toBe(withVelocity.frame);
    expect(receivedVelocityNode?.isNode).toBe(true);
    expect(withVelocity.footprints.get("skinned")?.coveredPixels).toBeGreaterThan(0);
    expect(withVelocity.footprints.get("skinned")?.movingPixels).toBeGreaterThan(0);
    expect(correctRejection).toBeLessThanOrEqual(pinnedThreshold);
    tracker.commit(fixture.scene);

    fixture.rigid.position.x += 1.25;
    rootBone.position.x += 1.25;
    fixture.scene.updateMatrixWorld(true);
    tracker.update(fixture.scene);
    renderer.setShaderState(prepareVelocityShaderState(fixture.camera, { ...fixture }));
    const mrt = fixture.scenePass.getMRT();
    if (mrt === null) throw new Error("velocity fixture did not provision an MRT");
    fixture.scenePass.setMRT(null);
    const withoutVelocity = renderer.render(fixture.camera);
    chain.observeFrame();
    const missingRejection = chain.applied.velocity.rejectionFraction;
    tracker.commit(fixture.scene);
    fixture.scenePass.setMRT(mrt);

    expect(withoutVelocity.pixels.every((value) => value === 0)).toBe(true);
    expect(missingRejection).toBeDefined();
    expect(missingRejection).toBeGreaterThan(correctRejection);
    expect(missingRejection).toBeGreaterThan(pinnedThreshold);
  });
});

describe("VelocityTracker instance history", () => {
  // The Strata forest tracks 218,809 instances; a fresh Float32Array per instanced mesh per frame
  // was ~14 MB of garbage every frame and produced multi-second collector stalls (PRD-541).
  it("alternates two history buffers per instanced mesh and keeps the committed matrices", () => {
    const scene = new Scene();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 3);
    scene.add(mesh);
    const tracker = new VelocityTracker();
    const previous = () =>
      (mesh as unknown as Record<symbol, Float32Array | undefined>)[
        VELOCITY_PREVIOUS_INSTANCE_MATRICES
      ];
    const move = (x: number) => {
      mesh.setMatrixAt(0, new Matrix4().makeTranslation(x, 0, 0));
      mesh.instanceMatrix.needsUpdate = true;
    };

    tracker.update(scene);
    tracker.commit(scene);
    tracker.update(scene);
    const first = previous();
    if (first === undefined) throw new Error("no instance history was scheduled");

    // Two buffers alternate: the one scheduled for the frame that just rendered is never rewritten
    // by the commit that follows it, and nothing new is allocated after the second frame.
    move(1);
    tracker.commit(scene);
    tracker.update(scene);
    const second = previous();
    expect(second).not.toBe(first);
    expect(second?.[12]).toBe(1);
    expect(first[12]).toBe(0);
    move(2);
    tracker.commit(scene);
    tracker.update(scene);
    expect(previous()).toBe(first);
    expect(first[12]).toBe(2);
    expect(second?.[12]).toBe(1);
    move(3);
    tracker.commit(scene);
    tracker.update(scene);
    expect(previous()).toBe(second);
    tracker.clear();
  });

  it("skips the copy for an instanced mesh whose matrices did not change", () => {
    const scene = new Scene();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 2);
    scene.add(mesh);
    const tracker = new VelocityTracker();
    const previous = () =>
      (mesh as unknown as Record<symbol, Float32Array | undefined>)[
        VELOCITY_PREVIOUS_INSTANCE_MATRICES
      ];
    tracker.update(scene);
    tracker.commit(scene);
    tracker.update(scene);
    const held = previous();
    tracker.commit(scene);
    tracker.update(scene);
    // Unchanged version: no rotation, the same history stays scheduled.
    expect(previous()).toBe(held);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(4, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    tracker.commit(scene);
    tracker.update(scene);
    expect(previous()).not.toBe(held);
    expect(previous()?.[16 + 12]).toBe(4);
    tracker.clear();
  });
});
