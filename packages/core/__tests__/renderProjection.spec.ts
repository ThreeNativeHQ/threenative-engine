import {
  BatchedMesh,
  Bone,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LOD,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Uint32BufferAttribute,
} from "three";
import { positionLocal, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { markEngineRenderHook } from "../src/engine-render-hook.js";
import { ProjectionMirror } from "../src/projection-apply.js";
import { formatProjectionWindow } from "../src/projection-marker.js";
import { hasMorphAttributes } from "../src/projection-plan.js";
import {
  createProjectionScanWorkspace,
  releaseProjectionScanWorkspace,
  scanProjection,
} from "../src/projection-plan.js";
import * as projectionPlan from "../src/projection-plan.js";
import { readVelocityPreviousMatrices } from "../src/render/velocity.js";
import { type IRenderProjectionReport, SceneRenderProjection } from "../src/renderProjection.js";

/**
 * PRD-152 Phase 2. The projection's whole claim is that a game cannot tell it is there. These
 * assertions are about the authored scene staying exactly as authored while the renderer's input
 * collapses — a draw-count win with a rewritten graph underneath it is the defect, not the goal.
 */

const GEOMETRY = new BoxGeometry(1, 1, 1);

function fill(parent: Object3D, material: MeshStandardMaterial, count: number): Mesh[] {
  const meshes: Mesh[] = [];
  for (let index = 0; index < count; index += 1) {
    const mesh = new Mesh(GEOMETRY, material);
    mesh.position.set(index % 40, Math.floor(index / 40), 0);
    parent.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

/** Everything the renderer would walk and draw in the scene it was handed. */
function drawCandidates(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((object) => {
    const candidate = object as Mesh & { isSprite?: boolean; isPoints?: boolean; isLine?: boolean };
    if (
      candidate.isMesh === true ||
      candidate.isSprite === true ||
      candidate.isPoints === true ||
      candidate.isLine === true
    ) {
      found.push(object);
    }
  });
  return found;
}

function countInstanceMatrices(root: Object3D, expected: Matrix4): number {
  const actual = new Matrix4();
  let matches = 0;
  root.traverse((object) => {
    const mesh = object as InstancedMesh;
    if (mesh.isInstancedMesh !== true) return;
    for (let slot = 0; slot < mesh.count; slot += 1) {
      mesh.getMatrixAt(slot, actual);
      if (actual.equals(expected)) matches += 1;
    }
  });
  return matches;
}

function findMaterialBatch(root: Object3D): BatchedMesh {
  let found: BatchedMesh | undefined;
  root.traverse((object) => {
    if ((object as BatchedMesh).isBatchedMesh === true) found = object as BatchedMesh;
  });
  if (found === undefined) throw new Error("Projection mirror did not build a material batch");
  return found;
}

function findMaterialBatches(root: Object3D): BatchedMesh[] {
  const found: BatchedMesh[] = [];
  root.traverse((object) => {
    if ((object as BatchedMesh).isBatchedMesh === true) found.push(object as BatchedMesh);
  });
  return found;
}

function findInstancedBatch(root: Object3D): InstancedMesh {
  let found: InstancedMesh | undefined;
  root.traverse((object) => {
    if ((object as InstancedMesh).isInstancedMesh === true) found = object as InstancedMesh;
  });
  if (found === undefined) throw new Error("Projection mirror did not build an instanced batch");
  return found;
}

function preparedSubDraws(batch: BatchedMesh, root: Scene, camera: PerspectiveCamera): number {
  root.updateMatrixWorld(true);
  batch.onBeforeRender(
    // r187 BatchedMesh.onBeforeRender takes the CPU draw-parameter path only for a non-WebGPU renderer.
    { isWebGPURenderer: false } as never,
    root,
    camera,
    batch.geometry,
    batch.material as MeshStandardMaterial,
    new Group(),
  );
  return (batch as BatchedMesh & { _multiDrawCount: number })._multiDrawCount;
}

function isLightObject(object: Object3D): boolean {
  return (object as { isLight?: boolean }).isLight === true;
}

/** A structural fingerprint of the authored graph: identity, parentage, naming and order. */
function graphSnapshot(scene: Scene): string {
  const rows: string[] = [];
  scene.traverse((object) => {
    rows.push(
      [
        object.uuid,
        object.name,
        object.type,
        object.parent?.uuid ?? "root",
        object.parent?.children.indexOf(object) ?? -1,
      ].join("|"),
    );
  });
  return rows.join("\n");
}

function projected(scene: Scene, frames = 1, minMeshes = 8) {
  const projection = new SceneRenderProjection(scene, { minMeshes });
  for (let frame = 0; frame < frames; frame += 1) projection.reconcile();
  return projection;
}

function countCollectionConstructors(run: () => void): { maps: number; sets: number } {
  const originalMap = globalThis.Map;
  const originalSet = globalThis.Set;
  let maps = 0;
  let sets = 0;

  class CountingMap<K, V> extends originalMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      maps += 1;
    }
  }
  class CountingSet<T> extends originalSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      sets += 1;
    }
  }

  globalThis.Map = CountingMap;
  globalThis.Set = CountingSet;
  try {
    run();
  } finally {
    globalThis.Map = originalMap;
    globalThis.Set = originalSet;
  }
  return { maps, sets };
}

function trackArrayLengthWrites(array: unknown[]): { proxy: unknown[]; writes: () => number } {
  let writes = 0;
  const proxy = new Proxy(array, {
    set(target, property, value, receiver) {
      if (property === "length") writes += 1;
      return Reflect.set(target, property, value, receiver);
    },
  });
  return { proxy, writes: () => writes };
}

describe("SceneRenderProjection", () => {
  it("rejects a mesh floor that cannot be reached", () => {
    expect(() => new SceneRenderProjection(new Scene(), { minMeshes: 0 })).toThrow(
      /minMeshes must be a positive integer/,
    );
  });

  it("collapses draw candidates without touching the authored graph", () => {
    const scene = new Scene();
    scene.add(new DirectionalLight(0xffffff, 1));
    const level = new Group();
    level.name = "level";
    scene.add(level);
    const meshes = fill(level, new MeshStandardMaterial({ color: 0x88aa44 }), 400);
    const before = graphSnapshot(scene);

    const projection = projected(scene, 300);

    expect(projection.deoptimized).toBe(false);
    // The renderer's input, counted from what it is actually handed.
    const candidates = drawCandidates(projection.root);
    expect(candidates.length).toBe(1);
    expect(projection.report.resultDrawCandidates).toBe(1);
    expect(projection.report.sourceRenderables).toBe(400);
    expect(projection.report.projectedObjects).toBe(400);

    // And the game's own scene is bit-for-bit the graph it authored, 300 frames later.
    expect(graphSnapshot(scene)).toBe(before);
    for (const mesh of meshes) expect(mesh.parent).toBe(level);
    expect(level.children.length).toBe(400);
    // Nothing of the projection's leaked into the scene the game can see.
    expect(drawCandidates(scene).length).toBe(400);
  });

  it("renders the authored scene directly when there is too little to batch", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 4);
    const projection = projected(scene, 2, 200);

    expect(projection.deoptimized).toBe(true);
    // Not merely reported as declined: the renderer is handed the game's own scene.
    expect(projection.root).toBe(scene);
    expect(projection.report.reasonCode).toBe("belowMeshFloor");
  });

  it("gives the frame back to the authored scene when an object hooks its own draw", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    // A game that hooks a draw is handed its own object by three.js. Neither a batch nor a proxy
    // can do that, so the frame stops being projected rather than lying about which object it is.
    (meshes[10] as Mesh).onBeforeRender = () => undefined;
    projection.reconcile();

    expect(projection.deoptimized).toBe(true);
    expect(projection.root).toBe(scene);
    expect(projection.report.reasonCode).toBe("renderHook");
  });

  it("still projects when the only hook is the engine's own prewarm bookkeeping (PRD-458)", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);

    // What `WorldCells#awaitDraw` installs: a self-clearing borrow that counts one submitted draw.
    // It is engine bookkeeping with no game-visible object behind it, so the mirror's own draw
    // cannot be mistaken for the game's draw and the frame stays projectable. A real game hook on
    // the same mesh still declines the frame — see the case above.
    const borrow = (): void => undefined;
    markEngineRenderHook(borrow);
    (meshes[7] as Mesh).onBeforeRender = borrow;

    projection.reconcile();

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.reasonCode).toBe("projected");
  });

  it("keeps one draw per material and never merges two materials into one", () => {
    const scene = new Scene();
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const grass = new MeshStandardMaterial({ color: 0x33aa33 });
    fill(scene, stone, 200);
    fill(scene, grass, 200);

    const projection = projected(scene, 2);
    const candidates = drawCandidates(projection.root);
    expect(candidates.length).toBe(2);
    expect(projection.report.batches).toBe(2);
    // The game's own material instances, so recolouring one still recolours what draws.
    const materials = candidates.map((mesh) => (mesh as Mesh).material);
    expect(materials).toContain(stone);
    expect(materials).toContain(grass);
  });

  it("keeps an object three.js semantics cannot batch on a draw of its own", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    scene.add(instanced);

    const projection = projected(scene, 2);

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.exact.instanced).toBe(1);
    expect(projection.report.exactObjects).toBe(1);
    // The stand-in is a real InstancedMesh drawing the source's own geometry and material, with
    // every instance intact — and the source itself is still in the game's scene.
    // Batches are `InstancedMesh` too, so the stand-in is identified by the source geometry it
    // draws rather than by its class.
    expect(projection.inspect(instanced)?.lane).toBe("exact");
    const proxy = drawCandidates(projection.root).find(
      (object) => (object as Mesh).geometry === instanced.geometry,
    ) as InstancedMesh | undefined;
    expect(proxy).toBeDefined();
    expect(proxy?.material).toBe(instanced.material);
    expect(instanced.parent).toBe(scene);
  });

  it("renders an authored BatchedMesh directly so every sub-draw stays live", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const material = new MeshBasicMaterial();
    const batch = new BatchedMesh(4, 64, 96, material);
    const geometryId = batch.addGeometry(new BoxGeometry(1, 1, 1));
    const instanceId = batch.addInstance(geometryId);
    batch.setMatrixAt(instanceId, new Matrix4().makeTranslation(0, 0, -4));
    scene.add(batch);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8, velocity: true });
    projection.reconcile();

    // A BatchedMesh owns per-sub-draw geometry ids, visibility and matrix textures. The mirror
    // cannot reproduce those private tables from a shallow proxy, so the source remains the
    // renderer input and ThreeNative's velocity patch observes the authored sub-draws directly.
    expect(projection.deoptimized).toBe(true);
    expect(projection.root).toBe(scene);
    expect(projection.report.reasonCode).toBe("unsupportedObject");
    expect(projection.report.sourceRenderables).toBe(301);

    const firstPrevious = readVelocityPreviousMatrices(batch);
    expect(firstPrevious).toBeDefined();
    expect(
      new Matrix4()
        .fromArray(firstPrevious as Float32Array, instanceId * 16)
        .equals(new Matrix4().makeTranslation(0, 0, -4)),
    ).toBe(true);
    projection.commit();

    const moved = new Matrix4().makeTranslation(3, 0, -4);
    batch.setMatrixAt(instanceId, moved);
    projection.reconcile();
    const scheduledPrevious = readVelocityPreviousMatrices(batch);
    expect(scheduledPrevious).toBeDefined();
    expect(
      new Matrix4().fromArray(scheduledPrevious as Float32Array, instanceId * 16).equals(moved),
    ).toBe(false);
    expect(
      new Matrix4()
        .fromArray(scheduledPrevious as Float32Array, instanceId * 16)
        .equals(new Matrix4().makeTranslation(0, 0, -4)),
    ).toBe(true);
    const actual = new Matrix4();
    batch.getMatrixAt(instanceId, actual);
    expect(actual.equals(moved)).toBe(true);
    projection.dispose();
  });

  it("mirrors the scene's lights instead of moving them out of the game's scene", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0x8899ff, 2.5);
    light.position.set(3, 9, 4);
    scene.add(light);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);

    // The game's light never left the game's scene.
    expect(light.parent).toBe(scene);
    const mirrored: DirectionalLight[] = [];
    projection.root.traverse((object) => {
      if ((object as DirectionalLight).isDirectionalLight === true) {
        mirrored.push(object as DirectionalLight);
      }
    });
    expect(mirrored.length).toBe(1);
    expect(mirrored[0]?.intensity).toBe(2.5);
    expect(mirrored[0]?.color.getHex()).toBe(0x8899ff);
    expect(mirrored[0]?.matrixWorld.elements).toEqual(light.matrixWorld.elements);

    // A light the game turns down is turned down in the mirror on the next frame.
    light.intensity = 0.25;
    projection.reconcile();
    expect(mirrored[0]?.intensity).toBe(0.25);
  });

  it("keeps a spotlight's runtime cone and falloff parameters in step", () => {
    const scene = new Scene();
    const light = new SpotLight(0xffffff, 3, 12, 0.4, 0.2, 1.5);
    light.position.set(0, 6, 0);
    scene.add(light);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    let mirrored: SpotLight | undefined;
    projection.root.traverse((object) => {
      if ((object as SpotLight).isSpotLight === true) mirrored = object as SpotLight;
    });
    expect(mirrored).toBeDefined();

    // A flashlight zoom or a fading muzzle-flash light changes cone and falloff at runtime;
    // frozen first-frame values would render the scene lit differently than authored.
    light.angle = 0.9;
    light.penumbra = 0.7;
    light.distance = 30;
    light.decay = 1.1;
    light.intensity = 5;
    projection.reconcile();

    expect(mirrored?.angle).toBeCloseTo(0.9);
    expect(mirrored?.penumbra).toBeCloseTo(0.7);
    expect(mirrored?.distance).toBeCloseTo(30);
    expect(mirrored?.decay).toBeCloseTo(1.1);
    expect(mirrored?.intensity).toBeCloseTo(5);
  });

  it("carries the scene's own look rather than choosing one", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 1);
    const sky = new Color(0x102030);
    scene.background = sky;
    projection.reconcile();
    expect((projection.root as Scene).background).toBe(sky);
  });

  it("releases what it owns on dispose and leaves the game's scene whole", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const before = graphSnapshot(scene);
    const projection = projected(scene, 5);
    expect(projection.deoptimized).toBe(false);

    projection.dispose();

    expect(projection.deoptimized).toBe(true);
    expect(projection.root).toBe(scene);
    expect(graphSnapshot(scene)).toBe(before);
    // The geometries and materials are the game's, and disposing the projection must not take
    // them with it: a scene change would take the next scene down too.
    for (const mesh of meshes) {
      expect(mesh.geometry.getAttribute("position")).toBeDefined();
      expect((mesh.material as MeshStandardMaterial).type).toBe("MeshStandardMaterial");
    }
  });

  it("draws every object sharing one geometry and material as a single instanced draw", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    // Four hundred references to one geometry is the ordinary case — a level of identical crates.
    fill(scene, material, 400);
    const projection = projected(scene, 2);
    expect(projection.report.projectedObjects).toBe(400);
    expect(projection.report.batches).toBe(1);
    expect(drawCandidates(projection.root).length).toBe(1);

    // A lone object of a different shape is *not* batched. An instanced draw of one is one draw,
    // exactly as the object already was, plus a buffer and a slot table — so it keeps its own draw
    // and lands on the exact lane instead.
    const sphere = new Mesh(new SphereGeometry(1, 8, 6), material);
    scene.add(sphere);
    projection.reconcile();
    expect(projection.report.projectedObjects).toBe(400);
    expect(projection.report.batches).toBe(1);
    expect(projection.report.exact.tooFewToBatch).toBe(1);
  });

  it("should submit fewer batched sub-draws when most objects are behind the camera", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    fill(scene, material, 32);
    for (let index = 0; index < 32; index += 1) {
      // Never 1: a copy of the filler's box would batch with it by content.
      const mesh = new Mesh(new BoxGeometry(1, 1 + (index + 1) * 0.001, 1), material);
      mesh.position.z = index < 8 ? 0 : 1_000;
      scene.add(mesh);
    }

    const projection = projected(scene);
    try {
      const batch = findMaterialBatch(projection.root);
      const camera = new PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);

      expect(batch.perObjectFrustumCulled).toBe(true);
      batch.perObjectFrustumCulled = false;
      expect(preparedSubDraws(batch, projection.root, camera)).toBe(32);
      batch.perObjectFrustumCulled = true;
      expect(preparedSubDraws(batch, projection.root, camera)).toBe(8);

      const awayCamera = new PerspectiveCamera(60, 1, 0.1, 100);
      awayCamera.position.set(0, 0, -10);
      awayCamera.lookAt(0, 0, -100);
      awayCamera.updateMatrixWorld(true);
      expect(preparedSubDraws(batch, projection.root, awayCamera)).toBe(0);
    } finally {
      projection.dispose();
    }
  });

  it("keeps forced-visible members in a material batch of their own", () => {
    const scene = new Scene();
    const material = new MeshBasicMaterial();
    // The forced-visible members sit behind the camera, so a batch that culled per object from
    // their authored bounds would drop them. (A shader that moved them into view used to stand
    // in for this; a material that displaces vertices now keeps its own draw instead — see
    // "keeps a static mesh whose material moves its own vertices".)
    const geometries: BoxGeometry[] = [];
    const anchorGeometry = new BoxGeometry(1, 1, 1);

    for (let index = 0; index < 8; index += 1) {
      // Never 1: a copy of the anchor's box would batch with it by content.
      const mesh = new Mesh(new BoxGeometry(1, 1 + (index + 1) * 0.01, 1), material);
      mesh.position.z = index < 4 ? -1_000 : 1_000;
      mesh.frustumCulled = index < 4;
      scene.add(mesh);
      geometries.push(mesh.geometry);
    }
    for (let index = 0; index < 8; index += 1) {
      scene.add(new Mesh(anchorGeometry, material));
    }

    const projection = projected(scene);
    try {
      const batches = findMaterialBatches(projection.root);
      expect(batches).toHaveLength(2);

      const forcedVisibleBatch = batches.find((batch) => !batch.perObjectFrustumCulled);
      const culledBatch = batches.find((batch) => batch.perObjectFrustumCulled);
      expect(forcedVisibleBatch).toBeDefined();
      expect(culledBatch).toBeDefined();

      const camera = new PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      expect(preparedSubDraws(forcedVisibleBatch as BatchedMesh, projection.root, camera)).toBe(4);
      expect(preparedSubDraws(culledBatch as BatchedMesh, projection.root, camera)).toBe(0);
    } finally {
      projection.dispose();
      material.dispose();
      anchorGeometry.dispose();
      for (const geometry of geometries) geometry.dispose();
    }
  });

  it("keeps large instanced batches on the full buffer after compaction was rejected by measurement", () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial();
    const meshes: Mesh[] = [];
    for (let index = 0; index < 1_024; index += 1) {
      const mesh = new Mesh(geometry, material);
      mesh.position.z = index < 256 ? 0 : 1_000;
      scene.add(mesh);
      meshes.push(mesh);
    }
    const before = graphSnapshot(scene);
    const first = meshes[0] as Mesh;
    const projection = projected(scene);
    try {
      const batch = findInstancedBatch(projection.root);
      const uncompactedCount = batch.count;
      const camera = new PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      projection.root.updateMatrixWorld(true);
      batch.onBeforeRender(
        // r187 BatchedMesh.onBeforeRender takes the CPU draw-parameter path only for a non-WebGPU renderer.
        { isWebGPURenderer: false } as never,
        projection.root,
        camera,
        batch.geometry,
        batch.material as MeshStandardMaterial,
        new Group(),
      );

      expect(batch.count).toBe(uncompactedCount);
      expect(projection.inspect(first)?.matrixWorld.elements).toEqual(first.matrixWorld.elements);
      expect(graphSnapshot(scene)).toBe(before);

      first.position.x = 1;
      scene.updateMatrixWorld(true);
      projection.reconcile();
      expect(projection.inspect(first)?.matrixWorld.elements).toEqual(first.matrixWorld.elements);
      expect(batch.count).toBe(uncompactedCount);
    } finally {
      projection.dispose();
    }
  });

  /**
   * P2-3 Phase 1 characterization. A scene transition swaps the level's population underneath a
   * live projection; after the next reconcile the mirror must agree with the authored scene
   * exactly, and nothing the game removed may still be held or drawn.
   */
  it("should restore authored objects after projection changes", () => {
    const scene = new Scene();
    const level = new Group();
    scene.add(level);
    const material = new MeshStandardMaterial({ color: 0x4488cc });
    const first = fill(level, material, 300);
    const projection = projected(scene, 2, 8);
    expect(projection.deoptimized).toBe(false);

    // The game swaps the level's contents in one frame, as a scene transition does.
    for (const mesh of first) level.remove(mesh);
    const second = fill(level, material, 120);
    projection.reconcile();

    // The authored scene holds exactly what the game put in it.
    expect(level.children.length).toBe(120);
    for (const mesh of second) expect(mesh.parent).toBe(level);
    // Nothing the game removed is still held by the mirror.
    const stale = first.filter((mesh) => projection.inspect(mesh) !== undefined);
    expect(stale, "RED observed: authored object state leaked").toEqual([]);
    expect(projection.report.sourceRenderables).toBe(120);
    expect(projection.report.projectedObjects).toBe(120);
    expect(projection.report.resultDrawCandidates).toBe(1);
    expect(projection.deoptimized).toBe(false);
  });

  it("should reuse projected-plan storage across settled frames", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 250);
    const projection = projected(scene, 2);
    const originalJoin = Array.prototype.join;
    let batchKeyJoins = 0;
    const joins = vi.spyOn(Array.prototype, "join").mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      if (separator === "|" && this.length === 5) batchKeyJoins += 1;
      return originalJoin.call(this, separator);
    });

    try {
      const allocations = countCollectionConstructors(() => {
        for (let frame = 0; frame < 10; frame += 1) projection.reconcile();
      });

      expect(batchKeyJoins).toBe(0);
      expect(allocations).toEqual({ maps: 0, sets: 0 });
      expect(projection.report.projectedObjects).toBe(250);
      expect(projection.report.resultDrawCandidates).toBe(1);
    } finally {
      joins.mockRestore();
    }
  });

  it("should not churn settled scan storage at the 2,000-mesh workload", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 2000);
    const workspace = createProjectionScanWorkspace();
    const warmup = scanProjection(scene, 8, workspace);
    expect(warmup.plan.action).toBe("project");
    const group = warmup.plan.action === "project" ? warmup.plan.batchGroups[0] : undefined;
    expect(group).toBeDefined();
    releaseProjectionScanWorkspace(workspace);

    const arrayNames = [
      "eligible",
      "exactLane",
      "lights",
      "batchGroups",
      "materialGroups",
      "activeMaterialGroups",
      "belowFloor",
      "activeGroups",
      "walkStack",
    ] as const;
    const workspaceRecord = workspace as unknown as Record<string, unknown>;
    const tracked = arrayNames.map((name) => {
      const tracking = trackArrayLengthWrites(workspaceRecord[name] as unknown[]);
      workspaceRecord[name] = tracking.proxy;
      return tracking;
    });
    const memberTracking = trackArrayLengthWrites((group as { members: unknown[] }).members);
    (group as { members: unknown[] }).members = memberTracking.proxy;
    const originalSetClear = Set.prototype.clear;
    const originalSetAdd = Set.prototype.add;
    let setClears = 0;
    let setAdds = 0;
    Set.prototype.clear = function (): void {
      setClears += 1;
      originalSetClear.call(this);
    };
    Set.prototype.add = function <T>(this: Set<T>, value: T): Set<T> {
      setAdds += 1;
      return originalSetAdd.call(this, value);
    };

    try {
      for (let frame = 0; frame < 5; frame += 1) {
        const scan = scanProjection(scene, 8, workspace);
        expect(scan.plan.action).toBe("project");
        releaseProjectionScanWorkspace(workspace);
      }
    } finally {
      Set.prototype.clear = originalSetClear;
      Set.prototype.add = originalSetAdd;
    }

    const lengthWrites = tracked.reduce((total, tracking) => total + tracking.writes(), 0);
    expect(lengthWrites + memberTracking.writes()).toBe(0);
    expect(setClears).toBe(0);
    expect(setAdds).toBe(0);
  });

  it("should reclassify a material swap in the same frame", () => {
    const scene = new Scene();
    const first = new MeshStandardMaterial({ color: 0x446688 });
    const second = new MeshStandardMaterial({ color: 0x886644 });
    const firstMeshes = fill(scene, first, 200);
    const secondMeshes = fill(scene, second, 100);
    for (const mesh of secondMeshes) mesh.position.x += 1000;
    const projection = projected(scene, 2);
    const changed = firstMeshes[0] as Mesh;

    changed.material = second;
    projection.reconcile();

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.batches).toBe(2);
    expect(projection.report.projectedObjects).toBe(300);
    expect(projection.inspect(changed)?.lane).toBe("batched");
    expect(projection.drawsWith(second)).toBe(true);
    expect(countInstanceMatrices(projection.root, changed.matrixWorld)).toBe(1);
  });

  it("should dispose a batch after every member changes its group", () => {
    const scene = new Scene();
    const first = new MeshStandardMaterial({ color: 0x446688 });
    const second = new MeshStandardMaterial({ color: 0x886644 });
    const firstMeshes = fill(scene, first, 200);
    const secondMeshes = fill(scene, second, 100);
    for (const mesh of secondMeshes) mesh.position.x += 1000;
    const projection = projected(scene, 2);

    for (const mesh of firstMeshes) mesh.material = second;
    projection.reconcile();

    expect(projection.report.batches).toBe(1);
    expect(projection.report.resultDrawCandidates).toBe(1);
    expect(drawCandidates(projection.root)).toHaveLength(1);
  });

  it("should clear pooled source references after a scan", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 8);
    const sprite = new Sprite(new SpriteMaterial());
    scene.add(sprite);
    const workspace = createProjectionScanWorkspace();
    const scan = scanProjection(scene, 8, workspace);
    const group = scan.plan.action === "project" ? scan.plan.batchGroups[0] : undefined;
    const exactEntry = workspace.exactEntryPool[0];

    expect(exactEntry?.object).toBe(sprite);
    expect(group?.memberCount).toBe(8);
    releaseProjectionScanWorkspace(workspace);

    expect(exactEntry?.object).toBeUndefined();
    expect(group?.memberCount).toBe(0);
    expect(group?.members).toHaveLength(8);
    expect(group?.members.every((member) => member === undefined)).toBe(true);
  });

  it("should retire removed lights with reused membership storage", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    scene.add(light);
    fill(scene, new MeshStandardMaterial(), 250);
    const projection = projected(scene, 2);

    scene.remove(light);
    const allocations = countCollectionConstructors(() => projection.reconcile());

    let mirroredLights = 0;
    projection.root.traverse((object) => {
      if (isLightObject(object)) mirroredLights += 1;
    });
    expect(allocations.sets).toBe(0);
    expect(mirroredLights).toBe(0);

    scene.add(light);
    projection.reconcile();
    scene.remove(light);
    projection.reconcile();
    mirroredLights = 0;
    projection.root.traverse((object) => {
      if (isLightObject(object)) mirroredLights += 1;
    });
    expect(mirroredLights).toBe(0);
  });
});

/**
 * PRD-152 Phase 3. Every row here mutates a settled scene *after* it has been stable for 600
 * frames, which is the case the pass this replaces got wrong: it decided what could change from
 * eight startup frames and then drew that decision forever.
 *
 * The rows are deliberately one property each. A single "something changed" test passes as soon as
 * any one field is reconciled and would hide the other nine.
 */
describe("SceneRenderProjection reconciliation after settling", () => {
  const SETTLED = 600;

  /** A scene of ordinary props, projected and left alone long past any observation window. */
  function settled(count = 300) {
    const scene = new Scene();
    const material = new MeshStandardMaterial({ color: 0x557799 });
    const level = new Group();
    scene.add(level);
    const meshes = fill(level, material, count);
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    for (let frame = 0; frame < SETTLED; frame += 1) projection.reconcile();
    expect(projection.deoptimized).toBe(false);
    return { scene, level, meshes, material, projection };
  }

  /**
   * The world matrix the mirror is currently drawing this source with.
   *
   * Read through `inspect` rather than off the batch, so these rows assert what the renderer was
   * given without depending on which three.js primitive the batch happens to be built from.
   */
  function drawnMatrix(projection: SceneRenderProjection, object: Mesh): Matrix4 {
    const found = projection.inspect(object);
    expect(found).toBeDefined();
    return (found as { matrixWorld: Matrix4 }).matrixWorld;
  }

  it("shows a transform changed on frame 600 on frame 601", () => {
    const { meshes, projection } = settled();
    const mover = meshes[7] as Mesh;
    mover.position.set(123, 45, 6);

    projection.reconcile();

    const drawn = drawnMatrix(projection, mover);
    expect([drawn.elements[12], drawn.elements[13], drawn.elements[14]]).toEqual([123, 45, 6]);
  });

  it("shows a transform inherited from an ancestor that only starts moving now", () => {
    const { level, meshes, projection } = settled();
    // Nothing about the meshes themselves changed. A pass that watched only the leaves sees
    // nothing here and draws the whole level where it used to be.
    level.position.set(0, 0, -50);

    projection.reconcile();

    expect(drawnMatrix(projection, meshes[3] as Mesh).elements[14]).toBe(-50);
  });

  it("hides an object the game hides after settling", () => {
    const { meshes, projection } = settled();
    const hidden = meshes[2] as Mesh;
    expect(projection.inspect(hidden)?.visible).toBe(true);

    hidden.visible = false;
    projection.reconcile();

    expect(projection.inspect(hidden)?.visible).toBe(false);
    // Not merely flagged: the transform it draws through has no volume, so nothing is rasterised.
    expect(drawnMatrix(projection, hidden).elements).toEqual(
      new Matrix4().multiplyScalar(0).elements,
    );
  });

  it("hides an object whose ancestor the game hides after settling", () => {
    const { level, meshes, projection } = settled();

    level.visible = false;
    projection.reconcile();

    // Visibility is inherited in a scene graph and is not in a batch, so it has to be resolved
    // per object rather than read off the flag.
    expect(projection.inspect(meshes[0] as Mesh)?.visible).toBe(false);
    expect(projection.inspect(meshes[9] as Mesh)?.visible).toBe(false);
  });

  it("draws an object added long after the projection settled", () => {
    const { scene, material, projection } = settled();
    const before = projection.report.projectedObjects;

    const late = new Mesh(GEOMETRY, material);
    late.position.set(9, 9, 9);
    scene.add(late);
    projection.reconcile();

    expect(projection.report.projectedObjects).toBe(before + 1);
  });

  it("stops drawing an object the game removes, without disturbing the rest", () => {
    const { level, meshes, projection } = settled();
    const before = projection.report.projectedObjects;

    level.remove(meshes[5] as Mesh);
    projection.reconcile();

    expect(projection.report.projectedObjects).toBe(before - 1);
    expect(projection.deoptimized).toBe(false);
  });

  it("follows an object the game reparents under a moved group", () => {
    const { scene, meshes, projection } = settled();
    const elsewhere = new Group();
    elsewhere.position.set(0, 200, 0);
    scene.add(elsewhere);

    const traveller = meshes[11] as Mesh;
    traveller.position.set(0, 0, 0);
    elsewhere.add(traveller);
    projection.reconcile();

    expect(drawnMatrix(projection, traveller).elements[13]).toBe(200);
    // Reparented in the game's graph, exactly as the game asked, and nowhere else.
    expect(traveller.parent).toBe(elsewhere);
  });

  it("draws a geometry the game streams into without needing to be told", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const streamed = new BufferGeometry();
    streamed.setAttribute("position", new Float32BufferAttribute(new Float32Array(9), 3));
    for (let index = 0; index < 300; index += 1) {
      scene.add(new Mesh(index === 0 ? streamed : GEOMETRY, material));
    }
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    for (let frame = 0; frame < SETTLED; frame += 1) projection.reconcile();

    // The batch references the game's own geometry rather than copying it into a private buffer,
    // so the array three.js uploads is the array the game just wrote to. That identity is what
    // makes a streamed update correct here with no re-upload bookkeeping at all.
    const drawn = drawCandidates(projection.root)
      .map((object) => (object as Mesh).geometry)
      .filter((geometry) => geometry === streamed);
    expect(drawn.length).toBe(1);

    const position = streamed.getAttribute("position");
    position.setXYZ(0, 5, 5, 5);
    position.needsUpdate = true;
    projection.reconcile();

    expect((drawn[0] as BufferGeometry).getAttribute("position").getX(0)).toBe(5);
    expect(projection.deoptimized).toBe(false);
  });

  it("never merges a shadow caster with a non-caster that shares its material", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const meshes = fill(scene, material, 300);
    for (const [index, mesh] of meshes.entries()) mesh.castShadow = index % 2 === 0;

    const projection = projected(scene, 2);

    // One draw for the casters and one for the rest. A single draw would have to pick one
    // behaviour and overrule the other half of the level.
    expect(projection.report.batches).toBe(2);
    const batches = drawCandidates(projection.root);
    expect(batches.length).toBe(2);
    expect(batches.filter((mesh) => mesh.castShadow).length).toBe(1);
    expect(batches.filter((mesh) => !mesh.castShadow).length).toBe(1);
  });

  it("moves an object to its own draw when the game turns its shadow on after settling", () => {
    const { meshes, projection } = settled();
    expect(projection.report.batches).toBe(1);

    const caster = meshes[4] as Mesh;
    caster.castShadow = true;
    projection.reconcile();

    // One caster cannot share the non-casting batch, and one object is not worth a batch of its
    // own, so it moves to the exact lane — still drawn once, still casting.
    expect(projection.report.batches).toBe(1);
    expect(projection.inspect(caster)?.lane).toBe("exact");
    expect(projection.report.exact.tooFewToBatch).toBe(1);
    expect(projection.report.projectedObjects).toBe(299);
  });

  it("moves an object to the exact lane when its material turns transparent, and draws it once", () => {
    const scene = new Scene();
    const opaque = new MeshStandardMaterial();
    const glass = new MeshStandardMaterial();
    fill(scene, opaque, 300);
    const window_ = new Mesh(GEOMETRY, glass);
    scene.add(window_);
    const projection = projected(scene, 2);
    // The lone glass pane is already on the exact lane: one object is below the batching floor.
    expect(projection.report.exact.tooFewToBatch).toBe(1);
    expect(projection.report.exact.transparent).toBeUndefined();

    glass.transparent = true;
    projection.reconcile();

    expect(projection.report.exact.transparent).toBe(1);
    expect(projection.report.exactObjects).toBe(1);
    // Once as a stand-in, and no longer also inside a batch.
    expect(projection.inspect(window_)?.lane).toBe("exact");
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("releases what it remembered about an object that leaves the scene", () => {
    const { scene, level, meshes, projection } = settled();
    // A level that streams in and out must not grow the projection's memory of it without bound.
    for (const mesh of meshes) level.remove(mesh);
    scene.remove(level);
    projection.reconcile();

    expect(projection.report.projectedObjects).toBe(0);
    expect(projection.report.sourceRenderables).toBe(0);
  });
});

/**
 * PRD-152. These assert against the mirror *after* `updateMatrixWorld()`, which is the first thing
 * a renderer does to the scene it is handed.
 *
 * Asserting before that call is how a whole class of bug hides: a `Scene` recomposes its own matrix
 * every frame, which forces every child to recompute `matrixWorld` from its local matrix. A mirror
 * that writes world matrices directly looks correct to any test that reads them back, and renders
 * every proxy and every light at the world origin.
 */
describe("SceneRenderProjection under the renderer's own matrix pass", () => {
  function rendered(projection: SceneRenderProjection): Scene {
    const root = projection.root;
    // Exactly what WebGLRenderer and WebGPURenderer do at the top of render().
    root.updateMatrixWorld();
    return root;
  }

  it("keeps an exact-lane object where the game put it", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    instanced.position.set(11, 22, 33);
    scene.add(instanced);

    const projection = projected(scene, 2);
    const root = rendered(projection);

    const proxy = drawCandidates(root).find(
      (object) => (object as Mesh).geometry === instanced.geometry,
    ) as InstancedMesh;
    expect([
      proxy.matrixWorld.elements[12],
      proxy.matrixWorld.elements[13],
      proxy.matrixWorld.elements[14],
    ]).toEqual([11, 22, 33]);
  });

  it("keeps a mirrored light where the game put it", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(4, 8, 15);
    scene.add(light);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    const root = rendered(projection);

    let found: DirectionalLight | undefined;
    root.traverse((object) => {
      if ((object as DirectionalLight).isDirectionalLight === true) {
        found = object as DirectionalLight;
      }
    });
    expect([
      found?.matrixWorld.elements[12],
      found?.matrixWorld.elements[13],
      found?.matrixWorld.elements[14],
    ]).toEqual([4, 8, 15]);
  });

  it("follows a light the game moves after settling", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(1, 2, 3);
    scene.add(light);
    fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 600);

    // Cloning the light copies where it was standing at the time, so a mirror that never updates
    // it still looks right until the game moves it. A day/night cycle moves it every frame.
    light.position.set(0, 90, 0);
    scene.updateMatrixWorld(true);
    projection.reconcile();
    const root = rendered(projection);

    let found: DirectionalLight | undefined;
    root.traverse((object) => {
      if ((object as DirectionalLight).isDirectionalLight === true) {
        found = object as DirectionalLight;
      }
    });
    expect([
      found?.matrixWorld.elements[12],
      found?.matrixWorld.elements[13],
      found?.matrixWorld.elements[14],
    ]).toEqual([0, 90, 0]);
  });

  it("follows an exact-lane object that moves after settling", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    scene.add(instanced);
    const projection = projected(scene, 600);

    instanced.position.set(0, 0, -70);
    scene.updateMatrixWorld(true);
    projection.reconcile();
    const root = rendered(projection);

    const proxy = drawCandidates(root).find(
      (object) => (object as Mesh).geometry === instanced.geometry,
    ) as InstancedMesh;
    expect(proxy.matrixWorld.elements[14]).toBe(-70);
  });
});

/**
 * PRD-152 Phase 4. A feature-rich scene stays correct while the ordinary props around it still
 * batch. Each subject here is an advanced Three.js semantic the batch cannot carry; the assertion
 * is that it survives *and* that its neighbours are still optimized — falling the whole scene back
 * whenever a game contains one skinned character would make the optimizer useless on real games.
 */
describe("SceneRenderProjection exact lane corpus", () => {
  /** The scene, its projection, and the mirror after the renderer's matrix pass. */
  function withSubject(subject: Object3D, props = 300) {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), props);
    scene.add(subject);
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    projection.root.updateMatrixWorld();
    return { scene, projection };
  }

  function proxyOf(projection: SceneRenderProjection, predicate: (o: Object3D) => boolean) {
    return drawCandidates(projection.root).find(predicate);
  }

  it("keeps a two-material mesh whole, with both materials and both groups", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const front = new MeshBasicMaterial();
    const back = new MeshBasicMaterial();
    const subject = new Mesh(geometry, [front, back]);
    subject.position.set(0, 0, 12);

    const { projection } = withSubject(subject);

    expect(projection.report.exact.multiMaterial).toBe(1);
    const proxy = proxyOf(projection, (o) => Array.isArray((o as Mesh).material));
    expect(proxy).toBeDefined();
    expect((proxy as Mesh).material).toBe(subject.material);
    expect((proxy as Mesh).geometry.groups.length).toBe(geometry.groups.length);
    expect((proxy as Mesh).matrixWorld.elements[14]).toBe(12);
    // And the ordinary props beside it are still one draw, not three hundred.
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps every instance of an InstancedMesh", () => {
    const subject = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    for (let index = 0; index < 3; index += 1) {
      subject.setMatrixAt(index, new Matrix4().makeTranslation(index * 4, 0, 0));
    }
    subject.instanceMatrix.needsUpdate = true;

    const { projection } = withSubject(subject);

    expect(projection.report.exact.instanced).toBe(1);
    const proxy = proxyOf(projection, (o) => (o as Mesh).geometry === subject.geometry);
    expect((proxy as InstancedMesh).count).toBe(3);
    // The same instance buffer, so the game moving an instance moves what draws.
    expect((proxy as InstancedMesh).instanceMatrix).toBe(subject.instanceMatrix);
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps a mesh whose draw count the GPU writes, indirect attribute and all", () => {
    // PRD-255. A GPU-driven candidate field is one ordinary `Mesh` whose geometry carries an
    // indirect draw buffer a compute pass writes the survivor count into. Nothing about the mesh
    // says "instanced", so without a guard it looks like an ordinary prop and gets folded into a
    // material batch — which draws the geometry once, with the count the CPU last believed, and
    // silently discards the number the GPU computed. The field vanishes or draws wrong, and the
    // projection report says it projected 301 objects successfully.
    const geometry = new BoxGeometry(1, 1, 1);
    const indirect = new Uint32BufferAttribute(new Uint32Array([36, 1024, 0, 0]), 1);
    geometry.setIndirect(indirect as unknown as Parameters<typeof geometry.setIndirect>[0]);
    const subject = new Mesh(geometry, new MeshBasicMaterial());
    subject.position.set(0, 0, 7);

    const { projection } = withSubject(subject);

    expect(projection.report.exact.indirect).toBe(1);
    const proxy = proxyOf(projection, (o) => (o as Mesh).geometry === geometry);
    expect(proxy).toBeDefined();
    // The same indirect attribute, so the count the compute pass writes is the count that draws.
    expect((proxy as Mesh).geometry.indirect).toBe(indirect);
    // The ordinary props beside it still fold; declining one object is not declining the frame.
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps a skinned mesh bound to the game's own skeleton", () => {
    const bone = new Bone();
    const skeleton = new Skeleton([bone]);
    const geometry = new BoxGeometry(1, 1, 1);
    const subject = new SkinnedMesh(geometry, new MeshStandardMaterial());
    subject.add(bone);
    subject.bind(skeleton);

    const { projection } = withSubject(subject);

    expect(projection.report.exact.skinned).toBe(1);
    const proxy = proxyOf(projection, (o) => (o as SkinnedMesh).isSkinnedMesh === true);
    expect(proxy).toBeDefined();
    // The game's skeleton, so the bones the game animates are the bones that deform the draw.
    expect((proxy as SkinnedMesh).skeleton).toBe(skeleton);
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps a morph-target mesh with its influences live", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const base = geometry.getAttribute("position");
    geometry.morphAttributes.position = [
      new Float32BufferAttribute(new Float32Array(base.count * 3), 3),
    ];
    const subject = new Mesh(geometry, new MeshStandardMaterial());
    subject.morphTargetInfluences = [0.5];

    const { projection } = withSubject(subject);

    expect(projection.report.exact.morph).toBe(1);
    const proxy = proxyOf(
      projection,
      (o) => (o as Mesh).geometry?.morphAttributes?.position !== undefined,
    );
    expect(proxy).toBeDefined();
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("does not read a holder that names position and normal with no targets as morphed", () => {
    // The native engine's morphAttributes always carries both keys, as empty arrays.
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.morphAttributes.position = [];
    geometry.morphAttributes.normal = [];
    expect(hasMorphAttributes(geometry)).toBe(false);
    geometry.morphAttributes.position = [
      new Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 3), 3),
    ];
    expect(hasMorphAttributes(geometry)).toBe(true);
  });

  it("keeps a geometry that draws only part of its index buffer", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.setDrawRange(0, 6);
    const subject = new Mesh(geometry, new MeshStandardMaterial());

    const { projection } = withSubject(subject);

    expect(projection.report.exact.drawRange).toBe(1);
    // Batching concatenates whole attribute arrays, so the window the game asked for would be lost.
    const proxy = proxyOf(projection, (o) => (o as Mesh).geometry === geometry);
    expect((proxy as Mesh).geometry.drawRange.count).toBe(6);
  });

  it("keeps a sprite and a point cloud as themselves", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const sprite = new Sprite(new SpriteMaterial());
    const points = new Points(new BoxGeometry(1, 1, 1), new PointsMaterial());
    scene.add(sprite);
    scene.add(points);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.report.exact.sprite).toBe(1);
    expect(projection.report.exact.points).toBe(1);
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps Line, LineSegments and LineLoop as their own primitive on the game's geometry", () => {
    // `LineSegments` and `LineLoop` both set `isLine`, so a stand-in chosen by that flag alone is
    // a plain `Line` and draws every segment joined into one connected zigzag — the wrong shape,
    // in the mirror the renderer is handed. The primitive class is part of what makes the exact
    // draw the game authored, exactly as the skeleton is for a `SkinnedMesh`.
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const material = new LineBasicMaterial();
    const makeGeometry = (drawCount: number) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(12), 3));
      geometry.setDrawRange(0, drawCount);
      return geometry;
    };
    const lineGeometry = makeGeometry(2);
    const segmentsGeometry = makeGeometry(4);
    const loopGeometry = makeGeometry(8);
    scene.add(new Line(lineGeometry, material));
    scene.add(new LineSegments(segmentsGeometry, material));
    scene.add(new LineLoop(loopGeometry, material));

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    projection.root.updateMatrixWorld();

    // The projection is actually engaged, and every line kept a draw of its own.
    expect(projection.report.exact.points).toBe(3);
    expect(projection.report.projectedObjects).toBe(300);

    const proxyFor = (geometry: BufferGeometry) =>
      drawCandidates(projection.root).find((o) => (o as Mesh).geometry === geometry) as unknown as {
        geometry: BufferGeometry;
        isLine?: boolean;
        isLineSegments?: boolean;
        isLineLoop?: boolean;
      };

    const lineProxy = proxyFor(lineGeometry);
    expect(lineProxy.isLine).toBe(true);
    expect(lineProxy.isLineSegments).toBeUndefined();
    expect(lineProxy.isLineLoop).toBeUndefined();
    expect(lineProxy.geometry).toBe(lineGeometry);
    expect(lineProxy.geometry.drawRange.count).toBe(2);

    const segmentsProxy = proxyFor(segmentsGeometry);
    expect(segmentsProxy.isLineSegments).toBe(true);
    expect(segmentsProxy.geometry).toBe(segmentsGeometry);
    expect(segmentsProxy.geometry.drawRange.count).toBe(4);

    const loopProxy = proxyFor(loopGeometry);
    expect(loopProxy.isLineLoop).toBe(true);
    expect(loopProxy.geometry).toBe(loopGeometry);
    expect(loopProxy.geometry.drawRange.count).toBe(8);
  });

  it("keeps an LOD's levels out of one another", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const lod = new LOD();
    const near = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
    const far = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    lod.addLevel(near, 0);
    lod.addLevel(far, 50);
    lod.position.set(0, 0, -8);
    scene.add(lod);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    projection.root.updateMatrixWorld();

    // The container is the exact-lane object, not its rungs. An LOD shows exactly one rung by
    // camera distance and decides that on itself every frame, so the mirror needs the container —
    // mirroring the rungs as siblings would draw every level at once, which is the whole thing an
    // LOD exists to avoid.
    expect(projection.report.exact.lod).toBe(1);
    let mirrored: LOD | undefined;
    projection.root.traverse((object) => {
      if ((object as LOD).isLOD === true) mirrored = object as LOD;
    });
    expect(mirrored).toBeDefined();
    expect(mirrored?.levels.length).toBe(2);
    expect(mirrored?.levels[0]?.distance).toBe(0);
    expect(mirrored?.levels[1]?.distance).toBe(50);
    // Each rung draws the game's own geometry and material; only the container is new.
    expect((mirrored?.levels[0]?.object as Mesh).geometry).toBe(near.geometry);
    expect((mirrored?.levels[1]?.object as Mesh).geometry).toBe(far.geometry);
    expect(mirrored?.matrixWorld.elements[14]).toBe(-8);

    // Level selection runs on the stand-in, exactly as it would have on the source.
    const camera = new PerspectiveCamera();
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld();
    mirrored?.update(camera);
    expect(mirrored?.levels[0]?.object.visible).toBe(true);
    expect(mirrored?.levels[1]?.object.visible).toBe(false);

    expect(projection.report.projectedObjects).toBe(300);
    // And the game's LOD keeps its own levels, in its own scene.
    expect(lod.levels.length).toBe(2);
    expect(lod.parent).toBe(scene);
  });

  it("keeps a mesh with a custom depth material off the shared draw", () => {
    const subject = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    subject.customDepthMaterial = new MeshStandardMaterial();

    const { projection } = withSubject(subject);

    // The shadow pass swaps this in per object; a batch is one object and would apply whichever
    // override it inherited to everything folded into it.
    expect(projection.report.exact.customDepthMaterial).toBe(1);
    expect(projection.report.projectedObjects).toBe(300);
  });

  it("keeps a static mesh whose material moves its own vertices on a draw of its own", () => {
    // A batch is one object: it draws with its own model matrix, so a displacement written in
    // object space — TSL wind reading `modelWorldMatrixInverse`, a `displacementMap` — is wrong
    // there, or silently lost. Nothing about such a mesh looks batchable, so the mesh keeps its
    // own draw and the report names the reason instead of counting it as folded.
    const displacements: Array<(material: MeshStandardNodeMaterial) => void> = [
      (material) => {
        material.positionNode = positionLocal.add(vec3(0, 0, 0.25));
      },
      (material) => {
        material.castShadowPositionNode = positionLocal.add(vec3(0, 0, 0.25));
      },
      (material) => {
        material.displacementMap = new DataTexture(new Uint8Array(4), 1, 1);
      },
    ];
    for (const displace of displacements) {
      const material = new MeshStandardNodeMaterial();
      displace(material);
      const subject = new Mesh(new BoxGeometry(1, 1, 1), material);

      const { projection } = withSubject(subject);

      expect(projection.report.exact.vertexDisplaced).toBe(1);
      const proxy = proxyOf(projection, (o) => (o as Mesh).material === material);
      expect(proxy).toBeDefined();
      // The 300 props beside it are the same shape without the displacement, and still one draw.
      expect(projection.report.projectedObjects).toBe(300);
    }
  });

  it("keeps a mesh that asked for its own place in the draw order", () => {
    const subject = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    subject.renderOrder = 5;

    const { projection } = withSubject(subject);

    expect(projection.report.exact.renderOrder).toBe(1);
    const proxy = proxyOf(projection, (o) => o.renderOrder === 5);
    expect(proxy).toBeDefined();
  });

  it("mirrors a camera-parented overlay where the camera actually is", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const camera = new PerspectiveCamera();
    camera.position.set(0, 0, 100);
    scene.add(camera);
    // A HUD element hangs off the camera and rides along with it.
    const reticle = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    reticle.position.set(0, 0, -2);
    camera.add(reticle);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    projection.root.updateMatrixWorld();

    // A camera-parented overlay needs no special case: its world matrix already carries the
    // camera's transform, so mirroring it in world space rides the camera exactly as it did. The
    // pass this replaces needed a whole second camera-space merge to achieve the same thing.
    expect(projection.inspect(reticle)?.matrixWorld.elements[14]).toBe(98);

    // And it follows the camera on the next frame.
    camera.position.set(0, 0, 40);
    scene.updateMatrixWorld(true);
    projection.reconcile();
    expect(projection.inspect(reticle)?.matrixWorld.elements[14]).toBe(38);

    // The camera itself is still the game's, parented where the game put it.
    expect(camera.parent).toBe(scene);
    expect(reticle.parent).toBe(camera);
  });

  it("isolates one unsafe object without giving up on its neighbours", () => {
    const scene = new Scene();
    const shared = new MeshStandardMaterial();
    const meshes = fill(scene, shared, 300);
    // Every kind of awkward object at once, beside three hundred ordinary props.
    scene.add(new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2));
    scene.add(new Sprite(new SpriteMaterial()));
    scene.add(
      new Mesh(new BoxGeometry(1, 1, 1), [new MeshBasicMaterial(), new MeshBasicMaterial()]),
    );

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.projectedObjects).toBe(300);
    expect(projection.report.exactObjects).toBe(3);
    // Three hundred and three source renderables became four draws.
    expect(projection.report.sourceRenderables).toBe(303);
    expect(projection.report.resultDrawCandidates).toBe(4);
    for (const mesh of meshes) expect(mesh.parent).toBe(scene);
  });
});

/**
 * The rule a real game had to teach this class: never make a scene worse.
 *
 * A shipped platformer that had already merged itself from 1,698 meshes to 254 was handed to an
 * earlier version of this projection, which re-expanded it into 1,251 single-member instanced
 * draws — the same draw count as the authored scene, plus a batch rebuild on the frame that found
 * them. The loading screen never finished and the phone showed black. Every unit test here passed
 * at the time, because none of them compared the result against the input.
 */
describe("SceneRenderProjection refuses to make a scene worse", () => {
  it("declines an every-geometry-unique scene by material until packed copies are proven", () => {
    // This row has changed sides twice, and both times a real game forced it. It first asserted
    // a decline: with only the instanced lane, unique geometry per mesh meant nothing could
    // batch, and refusing was arithmetically right (see
    // docs/bugs/render-projection-cannot-batch-differing-geometries-2026-08-25.md). The material
    // lane then opened the fold — and drew a real town with displaced geometry and textureless
    // walls while every scene-graph invariant held pristine (mirrored slots, packed ranges, and
    // multi-draw arrays all verified live). On the WebGPU backend the fold never saved a draw
    // command anyway: a BatchedMesh still executes one sub-draw per visible member. So the
    // prediction counts members honestly, the worthwhile ratio refuses the fold, and what must
    // still hold is the rule this describe exists for: never make the scene worse than the game
    // authored it. Re-admitting the fold is a backend-aware-prediction question and needs a
    // visual conformance proof first; the stream watch and the packed-copy machinery in
    // projection-apply stay for that day.
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    for (let index = 0; index < 300; index += 1) {
      scene.add(new Mesh(new BoxGeometry(1, 1 + index * 0.001, 1), material));
    }
    const before = graphSnapshot(scene);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.deoptimized).toBe(true);
    expect(projection.report.reasonCode).toBe("notWorthwhile");
    expect(projection.root).toBe(scene);
    // And the authored graph is still bit-for-bit the graph the game authored.
    expect(graphSnapshot(scene)).toBe(before);
  });

  it("still projects a scene where batching genuinely wins", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    fill(scene, material, 300);

    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.resultDrawCandidates).toBe(1);
  });

  it("names slot exhaustion as slot exhaustion rather than as an unsupported geometry", () => {
    // A batch keeps its slots until the retirement sweep at the end of the frame, so a level that
    // swaps a whole set of props in one frame asks for slots the outgoing set still holds. The
    // meshes that miss out keep their own draw, which is correct. What was wrong is what the
    // report said about them: `unsupportedGeometry` sends a reader to inspect an asset that is
    // fine, when the cause is a batch that was full.
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const first = fill(scene, material, 60);
    const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
    projection.reconcile();
    expect(projection.report.exact.batchOverflow).toBeUndefined();

    for (const mesh of first) scene.remove(mesh);
    fill(scene, material, 60);
    projection.reconcile();

    const report = projection.report;
    expect(report.exact.batchOverflow).toBeGreaterThan(0);
    expect(report.exact.unsupportedGeometry).toBeUndefined();
    // Still drawn, just not batched. Naming the reason must not cost the object its frame.
    expect(report.resultDrawCandidates).toBeGreaterThan(0);
    expect(report.projectedObjects + (report.exact.batchOverflow ?? 0)).toBe(60);
  });

  it("never returns more draw candidates than the scene it was given", () => {
    // The invariant behind both cases above, asserted directly across a spread of scene shapes.
    for (const distinctGeometries of [1, 2, 8, 60, 300]) {
      const scene = new Scene();
      const material = new MeshStandardMaterial();
      const shapes = Array.from(
        { length: distinctGeometries },
        (_, index) => new BoxGeometry(1, 1 + index * 0.01, 1),
      );
      for (let index = 0; index < 300; index += 1) {
        scene.add(new Mesh(shapes[index % distinctGeometries] as BufferGeometry, material));
      }

      const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
      projection.reconcile();

      const report = projection.report;
      expect(report.resultDrawCandidates).toBeLessThanOrEqual(report.sourceRenderables);
    }
  });

  /**
   * P2-3 Phase 3. Apply and restore must be reversible: a lane change that reverts lands back on
   * exactly the same draw counts, a decline followed by recovery reconverges without residue,
   * disposing one projection and building another over the same scene reproduces the same mirror,
   * and a mid-flight population swap leaves nothing of the outgoing set behind.
   */
  it("should keep projection and authored scene reversible", () => {
    const scene = new Scene();
    const level = new Group();
    scene.add(level);
    const material = new MeshStandardMaterial();
    const meshes = fill(level, material, 300);
    const beforeGraph = graphSnapshot(scene);
    const projection = projected(scene, 2, 8);
    expect(projection.deoptimized).toBe(false);
    const settled = projection.report;

    // Lane-change round trip: an object that leaves its batch and comes back costs nothing.
    const traveller = meshes[4] as Mesh;
    traveller.castShadow = true;
    projection.reconcile();
    expect(projection.report.batches).toBe(settled.batches);
    expect(projection.inspect(traveller)?.lane).toBe("exact");
    traveller.castShadow = false;
    projection.reconcile();
    expect(projection.report.projectedObjects).toBe(settled.projectedObjects);
    expect(projection.report.resultDrawCandidates).toBe(settled.resultDrawCandidates);
    expect(projection.inspect(traveller)?.lane).toBe("batched");

    // Decline and recover: the hook sends the frame to the authored scene, removing it returns
    // the mirror, and both directions are counted from the scene actually handed over.
    traveller.onBeforeRender = () => undefined;
    projection.reconcile();
    expect(projection.deoptimized).toBe(true);
    expect(projection.root).toBe(scene);
    // Removed, not nulled: the scan tests Object.hasOwn, so an own undefined property would
    // still count as a hook. Recovery from a settled decline is bounded by the rescan cadence
    // (PRD-169), not immediate — the delayed state is "not yet optimized", never a wrong frame.
    Reflect.deleteProperty(traveller, "onBeforeRender");
    for (let frame = 0; frame < 61 && projection.deoptimized; frame += 1) projection.reconcile();
    expect(projection.deoptimized).toBe(false);
    expect(projection.report.projectedObjects).toBe(settled.projectedObjects);
    expect(projection.report.resultDrawCandidates).toBe(settled.resultDrawCandidates);

    // Dispose and rebuild across a scene transition: restoration has one owner, so a fresh
    // projection over the same scene reproduces the same numbers exactly.
    projection.dispose();
    expect(projection.root).toBe(scene);
    const rebuilt = new SceneRenderProjection(scene, { minMeshes: 8 });
    rebuilt.reconcile();
    expect(rebuilt.report.projectedObjects).toBe(settled.projectedObjects);
    expect(rebuilt.report.resultDrawCandidates).toBe(settled.resultDrawCandidates);

    // A population swap under the rebuilt projection leaves none of the outgoing set behind.
    const outgoing = meshes.slice(0, 150);
    for (const mesh of outgoing) level.remove(mesh);
    fill(level, material, 150);
    rebuilt.reconcile();
    expect(rebuilt.report.sourceRenderables).toBe(300);
    expect(rebuilt.report.projectedObjects).toBe(300);
    const stale = outgoing.filter((mesh) => rebuilt.inspect(mesh) !== undefined);
    expect(stale, "RED observed: projection mutation leaked across transition").toEqual([]);
    expect(drawCandidates(rebuilt.root).length).toBe(1);
    // And the authored scene never changed shape of its own accord.
    expect(graphSnapshot(scene)).not.toBe(beforeGraph);
    for (const mesh of meshes) expect(mesh.geometry.getAttribute("position")).toBeDefined();
  });
});

/**
 * docs/bugs/render-projection-cannot-batch-differing-geometries-2026-08-25.md. The instanced lane
 * only folds meshes sharing one geometry instance, and a town of distinct buildings shares
 * materials instead — 835 candidates went out as 835 draws because every group held one member.
 * The material lane is the missing grouping: meshes whose geometry keeps them out of an instanced
 * group fold into one `BatchedMesh` draw per material.
 */
describe("SceneRenderProjection batches across differing geometries", () => {
  /** N meshes, each with its own geometry, all sharing one material — the bayview shape. */
  function town(scene: Scene, material: MeshStandardMaterial, count: number): Mesh[] {
    const meshes: Mesh[] = [];
    for (let index = 0; index < count; index += 1) {
      const mesh = new Mesh(new BoxGeometry(1, 1 + index * 0.001, 1), material);
      mesh.position.set(index % 20, Math.floor(index / 20) * 3, 0);
      scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  it("declines a town of unique geometries instead of drawing it through packed copies", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    town(scene, material, 300);

    const projection = projected(scene, 2);

    // One BatchedMesh per material still executes one multidraw sub-draw per member on the WebGPU
    // backend — the fold saves render objects, not draw commands — and the packed-copy path drew
    // a real town with displaced geometry and textureless walls while every scene-graph invariant
    // held pristine. Until packed copies carry a visual conformance proof, unique-geometry scenes
    // stay on the exact lane, which renders them correctly.
    expect(projection.deoptimized).toBe(true);
    expect(projection.report.reasonCode).toBe("notWorthwhile");
    expect(projection.root).toBe(scene);
  });

  it("still declines when nothing is shared, not even the material", () => {
    const scene = new Scene();
    for (let index = 0; index < 300; index += 1) {
      scene.add(
        new Mesh(
          new BoxGeometry(1, 1 + index * 0.001, 1),
          new MeshStandardMaterial({ color: index }),
        ),
      );
    }

    const projection = projected(scene, 2);

    // Nothing collapses when neither a geometry nor a material repeats: batching would draw the
    // same count plus its own overhead. This is the worthwhile ratio still doing its job.
    expect(projection.deoptimized).toBe(true);
    expect(projection.report.reasonCode).toBe("notWorthwhile");
    expect(projection.root).toBe(scene);
  });
});

describe("SceneRenderProjection declined-frame cost", () => {
  it("forces no whole-scene matrix pass while settled below the floor", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 4);
    const projection = projected(scene, 2, 200);
    expect(projection.deoptimized).toBe(true);

    // The renderer refreshes the authored scene itself on the frames it draws it, so the
    // reconciler forcing one too is duplicate whole-scene work on every declined frame.
    const updateSpy = vi.spyOn(scene, "updateMatrixWorld");
    try {
      projection.reconcile();
      projection.reconcile();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("refreshes the matrix pass on frames it projects without forcing", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    const updateSpy = vi.spyOn(scene, "updateMatrixWorld");
    try {
      projection.reconcile();
      // Three's own renderer contract: one pass, no force, so a game's static marking survives.
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("re-judges a scene that grew past the floor within the bounded cadence", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    fill(scene, material, 4);
    const projection = projected(scene, 2, 200);
    expect(projection.deoptimized).toBe(true);

    fill(scene, material, 200);
    // Settled declines rescan on a cadence; growth must be noticed within one window.
    for (let frame = 0; frame < 61 && projection.deoptimized; frame += 1) projection.reconcile();
    expect(projection.deoptimized).toBe(false);
    expect(projection.report.reasonCode).toBe("projected");
  });

  it("keeps re-scanning every frame while projecting", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    (meshes[10] as Mesh).onBeforeRender = () => undefined;
    projection.reconcile();
    expect(projection.deoptimized).toBe(true);
    expect(projection.report.reasonCode).toBe("renderHook");
  });
});

/**
 * A game that has promised to keep its own scene matrices current — by marking the scene or a
 * subtree `matrixWorldAutoUpdate = false` — must keep that promise. The reconciler used to run a
 * forced whole-scene matrix pass (`updateMatrixWorld(true)`) on every projected frame, defeating
 * both the authored flag and Three's own `matrixWorldNeedsUpdate` propagation. Three's renderers
 * call `updateMatrixWorld()` (no force) and only when the scene still auto-updates its world, which
 * is the contract honoured here.
 *
 * A note on where a sentinel has to sit to prove a subtree was left alone: in Three 0.185 a node
 * marked `matrixWorldAutoUpdate = false` already skips recomposing *its own* `matrixWorld` even
 * under a forced pass — the flag guards that one node. What a forced pass still does is overwrite
 * that node's descendants, which inherit `force = true` while a node still auto-updating skips
 * them. So the sentinel goes one level inside the frozen subtree root, which is the behaviour the
 * forced pass destroyed and the unflagged pass preserves.
 */
describe("SceneRenderProjection respects an authored static marking", () => {
  // (a) The ordinary case: nothing is marked, an object moves, the mirror still sees it.
  it("reflects a moving projected object on the next reconcile", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    const mover = meshes[7] as Mesh;
    mover.position.set(123, 45, 6);
    projection.reconcile();
    expect(projection.inspect(mover)?.matrixWorld.elements.slice(12, 15)).toEqual([123, 45, 6]);

    mover.position.set(-7, 8, 9);
    projection.reconcile();
    expect(projection.inspect(mover)?.matrixWorld.elements.slice(12, 15)).toEqual([-7, 8, 9]);
  });

  // (b) A frozen subtree under a still parent. Its world matrices carry a sentinel; a forced pass
  // recomposes the descendants and destroys it, the unflagged pass leaves the whole subtree alone.
  it("leaves a static subtree's world matrices untouched", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    fill(scene, material, 300);
    // The scene root is static too, so it does not re-dirty itself and hand the subtree `force`.
    scene.matrixAutoUpdate = false;

    const frozen = new Group();
    frozen.matrixAutoUpdate = false;
    frozen.matrixWorldAutoUpdate = false;
    const held: Mesh[] = [];
    for (let index = 0; index < 8; index += 1) {
      const mesh = new Mesh(GEOMETRY, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldNeedsUpdate = false;
      frozen.add(mesh);
      held.push(mesh);
    }
    scene.add(frozen);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    const sentinel = held[0] as Mesh;
    sentinel.matrixWorld.copy(new Matrix4().makeTranslation(999, 0, 0));
    sentinel.matrixWorldNeedsUpdate = false;

    projection.reconcile();
    expect(projection.inspect(sentinel)?.matrixWorld.elements.slice(12, 15)).toEqual([999, 0, 0]);
  });

  // (c) The scene itself marks its world static: the reconciler must not walk it at all, yet the
  // mirror keeps drawing from the matrices that are already present.
  it("does not walk a source scene that marks its world static", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    scene.matrixWorldAutoUpdate = false;
    const walk = vi.spyOn(scene, "updateMatrixWorld");
    try {
      projection.reconcile();
      expect(walk).not.toHaveBeenCalled();
    } finally {
      walk.mockRestore();
    }
    expect(projection.inspect(meshes[3] as Mesh)?.matrixWorld.elements.slice(12, 15)).toEqual([
      3, 0, 0,
    ]);
  });

  // (d) Safety: a static-marked object whose parent moved this frame is still refreshed, because
  // the moving parent's update propagates the world change down to it.
  it("refreshes a static-marked subtree whose parent moved", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    fill(scene, material, 300);

    const mover = new Group();
    const held: Mesh[] = [];
    for (let index = 0; index < 8; index += 1) {
      const mesh = new Mesh(GEOMETRY, material);
      mesh.matrixAutoUpdate = false;
      mover.add(mesh);
      held.push(mesh);
    }
    scene.add(mover);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    mover.position.set(50, 0, 0);
    projection.reconcile();
    expect(projection.inspect(held[0] as Mesh)?.matrixWorld.elements.slice(12, 15)).toEqual([
      50, 0, 0,
    ]);
  });
});

/**
 * While the projection holds, the renderer is handed the mirror, and three builds a frame's
 * lighting from the lights of the scene it is handed (the mirror), not from the authored scene
 * the shared materials came from. The mirror holds a clone of each game light, and `light.clone()`
 * gives that clone its own `LightShadow` and shadow camera. So the game's own light renders a
 * shadow map nothing samples while the mirror draws — the dead map measured in report F.
 *
 * Three's WebGPU `ShadowNode.updateBefore` reads each light's own `shadow.autoUpdate`, so the
 * dead map is dropped by taking the authored light offline and restoring it exactly when the
 * projection releases. These assertions pin which light is switched off, that the clone's own map
 * stays live, and the restoration on every release path.
 */
describe("SceneRenderProjection takes the unsampled authored light's shadow offline", () => {
  function mirroredLight(root: Scene, source: DirectionalLight): DirectionalLight {
    let found: DirectionalLight | undefined;
    root.traverse((object) => {
      const light = object as DirectionalLight;
      if (light.isDirectionalLight === true) found = light;
    });
    if (found === undefined) throw new Error("mirror did not clone the directional light");
    expect(found).not.toBe(source);
    return found;
  }

  // (a) The measured case: the authored sun's map is the one no drawn pixel reads, so its update
  // stops; the clone the mirror draws with keeps updating its own separate map.
  it("stops the source light's shadow update while the cloned light's keeps updating", () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.castShadow = true;
    scene.add(sun);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);

    expect(sun.shadow.autoUpdate).toBe(false);
    const clone = mirroredLight(projection.root as Scene, sun);
    expect(clone.shadow).not.toBe(sun.shadow);
    expect(clone.shadow.autoUpdate).toBe(true);
  });

  // (b) Reversibility is the contract: a scene that stops projecting gets its authored shadows
  // back on the very next frame, so the release path restores the exact captured value.
  it("restores the authored light's shadow update on dispose", () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1);
    scene.add(sun);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);
    expect(sun.shadow.autoUpdate).toBe(false);

    projection.dispose();
    expect(projection.root).toBe(scene);
    expect(sun.shadow.autoUpdate).toBe(true);
  });

  it("restores the authored light's shadow update on a decline", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const sun = new DirectionalLight(0xffffff, 1);
    scene.add(sun);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);
    expect(sun.shadow.autoUpdate).toBe(false);

    // A render hook is a decline; the mirror is released and the authored scene draws again.
    (meshes[10] as Mesh).onBeforeRender = () => undefined;
    projection.reconcile();
    expect(projection.deoptimized).toBe(true);
    expect(projection.report.reasonCode).toBe("renderHook");
    expect(sun.shadow.autoUpdate).toBe(true);
  });

  // A light the game had already told three not to auto-update must come back off, never forced
  // on by the restore. This case passes on the unpatched code too — it is the guard that the fix
  // does not invent an update the game had deliberately switched off.
  it("leaves a light that had autoUpdate off to off across projection and release", () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.shadow.autoUpdate = false;
    scene.add(sun);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);
    expect(sun.shadow.autoUpdate).toBe(false);

    projection.dispose();
    expect(sun.shadow.autoUpdate).toBe(false);
  });

  // (c) A scene that never projects keeps its authored shadow state: the mirror never takes the
  // light, so nothing is captured and nothing is restored.
  it("leaves a scene that never projects untouched", () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1);
    scene.add(sun);
    fill(scene, new MeshStandardMaterial(), 4);

    const projection = projected(scene, 2, 200);
    expect(projection.deoptimized).toBe(true);
    expect(projection.root).toBe(scene);
    expect(sun.shadow.autoUpdate).toBe(true);
  });
});

/**
 * The reported bug: ~22 s in, the image darkens once and stays dark on the frame the projection
 * takes over. The mirror is a fresh `Scene`, so `backgroundRotation` and `environmentRotation`
 * defaulted to zero while the game had authored `SKY_ROTATION = Euler(0, 2.76, 0)`. When the
 * mirror becomes the rendered scene the sky and the environment lighting snap back to yaw 0 —
 * the room turns and the lit top of everything drops with it. The fix copies both rotations, value
 * and order, onto the mirror alongside the rest of the scene look.
 */
describe("SceneRenderProjection copies the authored background and environment rotations", () => {
  function projecting(source: Scene): Scene {
    const projection = projected(source, 2);
    expect(projection.deoptimized).toBe(false);
    const mirror = projection.root as Scene;
    expect(mirror).not.toBe(source);
    return mirror;
  }

  // (a) The authored yaw must survive the handover; it fails on the unpatched mirror (0,0,0).
  it("carries the authored background rotation and its order onto the mirror", () => {
    const scene = new Scene();
    scene.backgroundRotation.set(0, 2.76, 0, "YXZ");
    fill(scene, new MeshStandardMaterial(), 300);

    const mirror = projecting(scene);
    expect(mirror.backgroundRotation.x).toBe(0);
    expect(mirror.backgroundRotation.y).toBe(2.76);
    expect(mirror.backgroundRotation.z).toBe(0);
    expect(mirror.backgroundRotation.order).toBe("YXZ");
  });

  // (b) Same for the environment rotation, which is what lights the aircraft's top.
  it("carries the authored environment rotation and its order onto the mirror", () => {
    const scene = new Scene();
    scene.environmentRotation.set(0.1, 2.76, -0.2, "ZXY");
    fill(scene, new MeshStandardMaterial(), 300);

    const mirror = projecting(scene);
    expect(mirror.environmentRotation.x).toBe(0.1);
    expect(mirror.environmentRotation.y).toBe(2.76);
    expect(mirror.environmentRotation.z).toBe(-0.2);
    expect(mirror.environmentRotation.order).toBe("ZXY");
  });

  // (c) No aliasing: the mirror owns its own Euler, and each reconcile re-reads the source.
  it("does not alias the source rotations, and re-reads changed ones", () => {
    const scene = new Scene();
    scene.backgroundRotation.set(0, 1, 0);
    scene.environmentRotation.set(0, 1, 0);
    fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);
    const mirror = projection.root as Scene;
    expect(mirror.backgroundRotation).not.toBe(scene.backgroundRotation);
    expect(mirror.environmentRotation).not.toBe(scene.environmentRotation);

    scene.backgroundRotation.set(0, 2, 0);
    mirror.environmentRotation.set(0, 3, 0);
    projection.reconcile();
    expect(mirror.backgroundRotation.y).toBe(2);
    expect(scene.environmentRotation.y).toBe(1);
  });

  // (d) The default case is untouched: a source that never set a rotation reconciles to zero.
  it("reconciles a scene that never set a rotation to zero", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);

    const mirror = projecting(scene);
    expect([
      mirror.backgroundRotation.x,
      mirror.backgroundRotation.y,
      mirror.backgroundRotation.z,
    ]).toEqual([0, 0, 0]);
    expect([
      mirror.environmentRotation.x,
      mirror.environmentRotation.y,
      mirror.environmentRotation.z,
    ]).toEqual([0, 0, 0]);
  });
});

/**
 * The named opt-out. Projection is an optimizer, and an optimizer a game cannot decline is a tax:
 * a scene whose draw count falls without its frame time following should be able to say so. The
 * option is `projection: false` on the constructor — `renderer.projection: false` in config — and the
 * contract is that it costs nothing: no mirror, no scan, the authored scene every frame, and a
 * verdict that names the opt-out rather than impersonating one of the measured declines.
 */
describe("SceneRenderProjection honors a game's opt-out", () => {
  // (a) Unset is the shipping behaviour: the option's absence changes nothing and a qualifying
  // scene still projects. This passes on both sides of the change, which is the point.
  it("still projects a qualifying scene when the option is unset", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);

    const projection = projected(scene, 2);
    expect(projection.deoptimized).toBe(false);
    expect(projection.root).not.toBe(scene);
    expect(projection.inspect(meshes[0] as Mesh)?.lane).toBeDefined();
  });

  // (b) An opted-out scene that WOULD qualify never projects: no mirror is built, no scan runs, and
  // the renderer is handed the authored scene. Must fail before the opt-out exists.
  it("never projects a qualifying scene when the game opts out", () => {
    const scene = new Scene();
    const meshes = fill(scene, new MeshStandardMaterial(), 300);
    const scanSpy = vi.spyOn(projectionPlan, "scanProjection");

    const projection = new SceneRenderProjection(scene, { minMeshes: 8, projection: false });
    projection.reconcile();

    expect(scanSpy).not.toHaveBeenCalled();
    expect(projection.root).toBe(scene);
    expect(projection.inspect(meshes[0] as Mesh)).toBeUndefined();
    expect(projection.report.batches).toBe(0);
    expect(projection.report.projecting).toBe(false);
    // `sourceRenderables` is written by the scan and by nothing else, so it staying at zero is the
    // same fact the spy asserts, counted from the report the boundary actually publishes.
    expect(projection.report.sourceRenderables).toBe(0);
    scanSpy.mockRestore();
  });

  // The window line every five seconds reads the report but not its scene count: on the native
  // engine a whole-scene walk crosses the bridge per node, and the shooter town's 8,900 nodes made
  // that window's frame miss its vsync. The full report still counts it.
  it("walks the scene for its draw-candidate count only when the count is read", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const projection = new SceneRenderProjection(scene, { minMeshes: 8, projection: false });
    projection.reconcile();
    const walk = vi.spyOn(projection.root, "traverse");

    formatProjectionWindow(projection.windowReport, 1, 300);
    expect(walk).not.toHaveBeenCalled();
    expect(projection.report.resultDrawCandidates).toBe(300);
    walk.mockRestore();
  });

  // (c) The verdict names the opt-out: `disabled`, its own reason code, not `belowMeshFloor` or
  // `notWorthwhile` and not silence. Must fail before the opt-out exists.
  it("reports the opt-out with its own reason code", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);
    const reports: IRenderProjectionReport[] = [];

    const projection = new SceneRenderProjection(scene, {
      minMeshes: 8,
      projection: false,
      onReport: (report) => reports.push(report),
    });
    projection.reconcile();

    expect(projection.report.reasonCode).toBe("disabled");
    expect(projection.report.reason).toMatch(/projection/);
    expect(reports.at(-1)?.reasonCode).toBe("disabled");
  });

  // (d) Off and on across scene changes leaves no leaked mirror state: a disabled projection builds
  // nothing an enabled one inherits, and an enabled projection's batches do not survive a later
  // disabled one.
  it("toggles off and on across scene changes with no leaked mirror state", () => {
    const scene = new Scene();
    fill(scene, new MeshStandardMaterial(), 300);

    const off = new SceneRenderProjection(scene, { minMeshes: 8, projection: false });
    off.reconcile();
    expect(off.root).toBe(scene);
    expect(off.report.batches).toBe(0);

    const on = new SceneRenderProjection(scene, { minMeshes: 8, projection: true });
    on.reconcile();
    expect(on.root).not.toBe(scene);
    expect(on.report.batches).toBeGreaterThan(0);
    on.dispose();

    const offAgain = new SceneRenderProjection(scene, { minMeshes: 8, projection: false });
    offAgain.reconcile();
    expect(offAgain.root).toBe(scene);
    expect(offAgain.report.batches).toBe(0);
    expect(offAgain.report.projecting).toBe(false);
  });
});

describe("ProjectionMirror CPU guards", () => {
  function makePlan(
    batchGroups: unknown[] = [],
    materialGroups: unknown[] = [],
    lights: unknown[] = [],
    seen: Set<Object3D> = new Set(),
  ): Parameters<ProjectionMirror["apply"]>[0] {
    return {
      lights,
      lightCount: lights.length,
      belowFloor: [],
      belowFloorCount: 0,
      batchGroups,
      batchGroupCount: batchGroups.length,
      materialGroups,
      materialGroupCount: materialGroups.length,
      seen: { has: (object: Object3D) => seen.has(object) },
    } as unknown as Parameters<ProjectionMirror["apply"]>[0];
  }

  function instancedGroup(
    members: Mesh[],
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
  ) {
    return { members, memberCount: members.length, geometry, material };
  }

  function materialGroup(members: Mesh[], material: MeshStandardMaterial, revision = 1) {
    return {
      members,
      memberCount: members.length,
      geometries: new Map(members.map((mesh) => [mesh.geometry, 0])),
      material,
      revision,
      frustumCulled: true,
    };
  }

  function uniqueMeshes(count: number, material: MeshStandardMaterial): Mesh[] {
    return Array.from(
      { length: count },
      (_, index) => new Mesh(new BoxGeometry(1, 1 + index * 0.01, 1), material),
    );
  }

  it("describes exact, instanced, and material ownership", () => {
    const sharedGeometry = new BoxGeometry();
    const instancedMaterial = new MeshStandardMaterial();
    const material = new MeshStandardMaterial();
    const exact = new Sprite(new SpriteMaterial());
    const instanced = Array.from({ length: 8 }, () => new Mesh(sharedGeometry, instancedMaterial));
    const materialMembers = uniqueMeshes(8, material);
    const mirror = new ProjectionMirror();
    mirror.prepare([{ object: exact, reason: "tooFewToBatch" }] as never, 1);
    mirror.apply(
      makePlan(
        [instancedGroup(instanced, sharedGeometry, instancedMaterial)],
        [materialGroup(materialMembers, material)],
        [],
        new Set([exact, ...instanced, ...materialMembers]),
      ),
    );

    const ownership = mirror.describeOwnership();
    const ownershipEntries = [...ownership.values()];
    const exactOwnership = ownershipEntries.find((entry) => entry.kind === "exact");
    const instancedOwnership = ownershipEntries.find((entry) => entry.kind === "instancedBatch");
    const materialOwnership = ownershipEntries.find((entry) => entry.kind === "materialBatch");
    expect(ownership.size).toBe(3);
    expect(exactOwnership?.sources).toStrictEqual([exact]);
    expect(instancedOwnership?.sources).toHaveLength(instanced.length);
    expect(materialOwnership?.sources).toHaveLength(materialMembers.length);
    expect(mirror.drawsWith(instancedMaterial)).toBe(true);
    expect(mirror.drawsWith(material)).toBe(true);
    expect(mirror.drawsWith(exact.material as SpriteMaterial)).toBe(true);
    expect(mirror.drawsWith(new MeshStandardMaterial())).toBe(false);
  });

  it("fails closed when an exact entry was cleared", () => {
    const mirror = new ProjectionMirror();
    mirror.prepare([{ object: undefined, reason: "tooFewToBatch" }] as never, 1);
    expect(() => mirror.apply(makePlan())).toThrow("cleared before apply");
  });

  it("releases a mirror when a light cannot be mirrored", () => {
    const material = new MeshStandardMaterial();
    const geometry = new BoxGeometry();
    const members = Array.from({ length: 8 }, () => new Mesh(geometry, material));
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([instancedGroup(members, geometry, material)], [], [], new Set(members)));
    const light = new DirectionalLight(0xffffff, 1);
    vi.spyOn(light, "clone").mockReturnValue(new Group() as never);

    expect(mirror.apply(makePlan([], [], [light]))).toMatch(/could not be mirrored/u);
    expect(mirror.batchCount).toBe(0);
    expect(mirror.proxyCount).toBe(0);
    expect(mirror.describeOwnership()).toEqual(new Map());
  });

  it("mirrors point-light runtime settings and retires a no-shadow-change light", () => {
    const light = new DirectionalLight(0xffffff, 1);
    light.shadow.autoUpdate = false;
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [], [light]));
    mirror.apply(makePlan());
    expect(light.shadow.autoUpdate).toBe(false);
    expect(mirror.scene.children).toHaveLength(0);

    const point = new PointLight(0xffffff, 2, 30, 1.5);
    point.power = 17;
    const pointMirror = new ProjectionMirror();
    pointMirror.apply(makePlan([], [], [point]));
    const mirrored = pointMirror.scene.children.find(
      (object) => (object as PointLight).isPointLight === true,
    ) as PointLight | undefined;
    expect(mirrored?.distance).toBe(30);
    expect(mirrored?.decay).toBe(1.5);
    expect(mirrored?.power).toBe(17);
  });

  it("labels material members that cannot use a batch", () => {
    const material = new MeshStandardMaterial();
    const mirrored = uniqueMeshes(8, material);
    mirrored[0]?.scale.set(-1, 1, 1);
    mirrored[0]?.updateMatrixWorld(true);
    const small = new Mesh(new BoxGeometry(), material);
    const mirror = new ProjectionMirror();
    mirror.apply(
      makePlan(
        [],
        [materialGroup(mirrored, material), materialGroup([small], material)],
        [],
        new Set([...mirrored, small]),
      ),
    );
    expect(mirror.exactCounts.get("negativeScale")).toBe(1);
    expect(mirror.exactCounts.get("tooFewToBatch")).toBe(1);
  });

  it("refuses a material group whose packed batch cannot be constructed", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(8, material);
    const invalidGeometry = new BufferGeometry();
    const group = {
      ...materialGroup(members, material),
      geometries: new Map([[invalidGeometry, 0]]),
    };
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [group], [], new Set(members)));
    expect(mirror.exactCounts.get("unsupportedGeometry")).toBe(8);
  });

  it("disposes a batch when a later geometry cannot be added", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(8, material);
    const invalidGeometry = new BufferGeometry();
    const group = {
      ...materialGroup(members, material),
      geometries: new Map([
        [members[0]?.geometry as BufferGeometry, 0],
        [invalidGeometry, 0],
      ]),
    };
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [group], [], new Set(members)));
    expect(mirror.exactCounts.get("unsupportedGeometry")).toBe(8);
  });

  it("falls back when an instanced batch cannot be constructed", () => {
    const material = new MeshStandardMaterial();
    const geometry = new BoxGeometry();
    const members = Array.from({ length: 8 }, () => new Mesh(geometry, material));
    const group = { ...instancedGroup(members, geometry, material), memberCount: Number.NaN };
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([group], [], [], new Set(members)));
    expect(mirror.instancedBatchCount).toBe(0);
  });

  it("retires material batches and exact proxies when sources disappear", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(8, material);
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [materialGroup(members, material)], [], new Set(members)));
    expect(mirror.materialBatchCount).toBe(1);
    mirror.apply(makePlan());
    expect(mirror.materialBatchCount).toBe(0);
    expect(
      mirror.scene.children.some((object) => (object as BatchedMesh).isBatchedMesh === true),
    ).toBe(false);

    const exact = new Sprite(new SpriteMaterial());
    mirror.prepare([{ object: exact, reason: "tooFewToBatch" }] as never, 1);
    mirror.apply(makePlan([], [], [], new Set([exact])));
    expect(mirror.proxyCount).toBe(1);
    mirror.apply(makePlan());
    expect(mirror.proxyCount).toBe(0);
    expect(mirror.scene.children.some((object) => (object as Sprite).isSprite === true)).toBe(
      false,
    );
  });

  it("releases a material slot before moving its source to the exact lane", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(8, material);
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [materialGroup(members, material)], [], new Set(members)));
    const exact = members[0] as Mesh;
    mirror.prepare([{ object: exact, reason: "tooFewToBatch" }] as never, 1);
    mirror.apply(makePlan([], [], [], new Set([exact])));

    expect(mirror.inspect(exact)?.lane).toBe("exact");
    const materialOwnership = [...mirror.describeOwnership().values()].find(
      (entry) => entry.kind === "materialBatch",
    );
    expect(materialOwnership).toBeUndefined();
    expect(mirror.materialBatchCount).toBe(0);
  });

  it("keeps a material member exact when its geometry or instance cannot be packed", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(8, material);
    const group = materialGroup(members, material);
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [group], [], new Set(members)));

    const replacement = new Mesh(new BoxGeometry(), material);
    group.members = [members[0] as Mesh, replacement, ...members.slice(2)];
    group.memberCount = 8;
    mirror.apply(makePlan([], [group], [], new Set([members[0] as Mesh, replacement])));
    expect(mirror.exactCounts.get("batchOverflow")).toBe(1);

    const second = new Mesh(members[0]?.geometry as BufferGeometry, material);
    const batch = mirror.scene.children.find(
      (object) => (object as BatchedMesh).isBatchedMesh === true,
    ) as BatchedMesh;
    const addInstance = vi.spyOn(batch, "addInstance").mockImplementation(() => {
      throw new Error("instance packing failed");
    });
    group.members = [members[0] as Mesh, ...members.slice(1, 7), second];
    group.memberCount = 8;
    mirror.apply(makePlan([], [group], [], new Set([members[0] as Mesh, second])));
    addInstance.mockRestore();
    expect(mirror.exactCounts.get("batchOverflow")).toBe(8);
  });

  it("keeps a material group exact when its packed capacity is exhausted", () => {
    const material = new MeshStandardMaterial();
    const members = uniqueMeshes(10, material);
    const geometry = members[0]?.geometry as BufferGeometry;
    const group = materialGroup(members, material);
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [group], [], new Set(members)));

    const additions = Array.from({ length: 6 }, () => new Mesh(geometry, material));
    group.members = [...members, ...additions];
    group.memberCount = 16;
    mirror.apply(makePlan([], [group], [], new Set(group.members)));

    const overflow = new Mesh(geometry, material);
    group.members = [...group.members.slice(0, 15), overflow];
    mirror.apply(makePlan([], [group], [], new Set(group.members)));
    expect(mirror.exactCounts.get("batchOverflow")).toBe(1);
  });

  it("releases the old material batch when a source changes groups", () => {
    const firstMaterial = new MeshStandardMaterial();
    const secondMaterial = new MeshStandardMaterial();
    const members = uniqueMeshes(8, firstMaterial);
    const first = materialGroup(members, firstMaterial);
    const second = {
      ...materialGroup(members, secondMaterial),
      geometries: new Map(members.map((mesh) => [mesh.geometry, 0])),
    };
    const mirror = new ProjectionMirror();
    mirror.apply(makePlan([], [first, second], [], new Set(members)));
    expect(mirror.materialBatchCount).toBe(1);
    expect(mirror.projectedObjects).toBe(16);
  });
});
