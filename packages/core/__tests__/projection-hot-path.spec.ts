import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type IPlaytestScenario, evaluateRichPlaytestAssertions } from "@threenative/playtest";
import {
  type BatchedMesh,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IProjectionExactEntry,
  createProjectionScanWorkspace,
  exactLaneReason,
  scanProjection,
} from "../src/projection-plan.js";
import { SceneRenderProjection } from "../src/renderProjection.js";

/**
 * Steady-state per-frame cost of the render projection and the frame instruments.
 *
 * These are allocation/call-count proofs, not timing benches: a scene that changes nothing
 * between frames must not re-derive work per frame that a single derivation could answer.
 */

function projectedScene(meshCount: number, depth: number): Scene {
  const scene = new Scene();
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial();
  for (let index = 0; index < meshCount; index += 1) {
    let parent: Object3D = scene;
    for (let level = 0; level < depth; level += 1) {
      const group = new Group();
      parent.add(group);
      parent = group;
    }
    parent.add(new Mesh(geometry, material));
  }
  return scene;
}

function projectionOver(scene: Scene): SceneRenderProjection {
  const projection = new SceneRenderProjection(scene, {
    minMeshes: 4,
    onReport: () => undefined,
  });
  projection.reconcile();
  return projection;
}

/**
 * A scene of one shared geometry and material, `half` of it under a hidden-able group, reconciled
 * until the projection has settled on its fast path. The guards below all start here: a skip that
 * is only correct on a frame where nothing at all happened proves nothing.
 */
function settledScene(meshCount: number): {
  projection: SceneRenderProjection;
  scene: Scene;
  meshes: Mesh[];
  group: Group;
} {
  const scene = new Scene();
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial();
  const group = new Group();
  scene.add(group);
  const meshes: Mesh[] = [];
  for (let index = 0; index < meshCount; index += 1) {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(index, index * 0.5, index * 0.25);
    (index % 2 === 0 ? group : scene).add(mesh);
    meshes.push(mesh);
  }
  const projection = new SceneRenderProjection(scene, {
    minMeshes: 4,
    onReport: () => undefined,
  });
  // First reconcile captures the structure; the rest take the path under test.
  for (let frame = 0; frame < 4; frame += 1) projection.reconcile();
  if (projection.deoptimized) throw new Error("the fixture scene did not project");
  return { projection, scene, meshes, group };
}

/**
 * What the renderer was actually handed for one source object.
 *
 * The elements are compared, not the object: a batched slot comes back through a `Float32Array`, so
 * the baked matrix is the authored one to single precision and never bit-identical to it.
 */
function baked(
  projection: SceneRenderProjection,
  mesh: Mesh,
): {
  elements: number[];
  visible: boolean;
  lane: string;
} {
  const found = projection.inspect(mesh);
  if (found === undefined) throw new Error("the mirror holds nothing for this object");
  return {
    elements: [...found.matrixWorld.elements],
    lane: found.lane,
    visible: found.visible,
  };
}

/** The baked transform against the authored one, to the precision the batch actually stores. */
function expectBaked(projection: SceneRenderProjection, mesh: Mesh, visible: boolean): void {
  const found = baked(projection, mesh);
  expect(found.visible).toBe(visible);
  const authored = [...mesh.matrixWorld.elements];
  found.elements.forEach((element, index) => {
    expect(element).toBeCloseTo(authored[index] as number, 5);
  });
}

function materialBatchProbe(): {
  batch: BatchedMesh;
  camera: PerspectiveCamera;
  projection: SceneRenderProjection;
  root: Scene;
} {
  const source = new Scene();
  const material = new MeshBasicMaterial();
  const sharedGeometry = new BoxGeometry(1, 1, 1);
  for (let index = 0; index < 64; index += 1) {
    source.add(new Mesh(sharedGeometry, material));
  }
  for (let index = 0; index < 64; index += 1) {
    const mesh = new Mesh(new BoxGeometry(1, 1 + index * 0.001, 1), material);
    mesh.position.z = index < 16 ? 0 : 1_000;
    source.add(mesh);
  }

  const projection = projectionOver(source);
  let batch: BatchedMesh | undefined;
  projection.root.traverse((object) => {
    if ((object as BatchedMesh).isBatchedMesh === true) batch = object as BatchedMesh;
  });
  if (batch === undefined) throw new Error("Projection mirror did not build a material batch");

  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  projection.root.updateMatrixWorld(true);
  return { batch, camera, projection, root: projection.root };
}

function countCollectionConstructors(
  run: () => void,
  warmup?: () => void,
): {
  maps: number;
  sets: number;
  frustums: number;
} {
  const originalMap = globalThis.Map;
  const originalSet = globalThis.Set;
  const originalFrustumSetFromProjectionMatrix = Frustum.prototype.setFromProjectionMatrix;
  const frustumInstances: Frustum[] = [];
  let maps = 0;
  let sets = 0;
  let knownFrustums: Frustum[] = [];

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
  // BatchedMesh closes over Three's Frustum binding in its ESM module, so replacing
  // globalThis.Frustum cannot see its scratch instance. Census the actual imported class's
  // method receivers instead: the warmup records BatchedMesh's reusable module-private Frustum,
  // and any newly constructed Frustum used by the real culling path is a new receiver.
  const frustumSpy = vi.spyOn(Frustum.prototype, "setFromProjectionMatrix");
  frustumSpy.mockImplementation(function (
    this: Frustum,
    ...args: Parameters<Frustum["setFromProjectionMatrix"]>
  ) {
    if (!frustumInstances.includes(this)) frustumInstances.push(this);
    return originalFrustumSetFromProjectionMatrix.apply(this, args);
  });

  globalThis.Map = CountingMap;
  globalThis.Set = CountingSet;
  try {
    warmup?.();
    knownFrustums = frustumInstances.slice();
    maps = 0;
    sets = 0;
    frustumInstances.length = 0;
    run();
  } finally {
    globalThis.Map = originalMap;
    globalThis.Set = originalSet;
    frustumSpy.mockRestore();
  }
  return {
    maps,
    sets,
    frustums: frustumInstances.filter((instance) => !knownFrustums.includes(instance)).length,
  };
}

function conformanceScenario(): IPlaytestScenario {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../examples/engine-load-test/playtests/projection-conformance.playtest.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as IPlaytestScenario;
}

function conformanceReport(renderSucceeded: boolean) {
  return {
    diagnostics: [],
    distance: 0,
    entity: "projection.proof",
    expectMoved: false,
    frames: 1,
    trivialityOptOuts: [],
    observations: {
      components: {
        "projection.proof": {
          ProjectionConformance: {
            after: {
              projectedRaycastHit: true,
              projectedRaycastDistance: 7.5,
              reconciled: true,
              renderSucceeded,
              sourceRaycastHit: true,
              sourceRaycastDistance: 7.5,
            },
          },
        },
      },
      console: [],
      hud: {},
      network: [],
      resources: {},
      visual: {
        nonblankRegions: [{ height: 720, nonblankPixelRatio: 1, width: 1280, x: 0, y: 0 }],
      },
    },
  } as never;
}

function renderBatch(
  batch: BatchedMesh,
  root: Scene,
  camera: PerspectiveCamera,
  group: Group,
): void {
  batch.onBeforeRender(
    // r187 BatchedMesh.onBeforeRender takes the CPU draw-parameter path only for a non-WebGPU renderer.
    { isWebGPURenderer: false } as never,
    root,
    camera,
    batch.geometry,
    batch.material as MeshBasicMaterial,
    group,
  );
}

function countFrustumMutation(): { maps: number; sets: number; frustums: number } {
  const matrix = new Matrix4();
  return countCollectionConstructors(() => {
    for (let frame = 0; frame < 10; frame += 1) {
      new Frustum().setFromProjectionMatrix(matrix);
    }
  });
}

describe("projection hot path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the culling benchmark on the production projection consumer", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../examples/engine-load-test/src/main.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("SceneRenderProjection");
    expect(source).toContain("projection.reconcile()");
    expect(source).not.toContain("ProjectionMirror");
    expect(source).not.toContain("IProjectionProjectPlan");
    expect(source).not.toMatch(/(?:mirror|projectionMirror)\.apply\(/u);
  });

  it("counts a per-frame Frustum mutation in the allocation probe", () => {
    const allocations = countFrustumMutation();
    expect(allocations).toEqual({ maps: 0, sets: 0, frustums: 10 });
  });

  it("fails projection conformance when the render marker is false despite nonblank pixels", () => {
    const scenario = conformanceScenario();
    scenario.assert = { components: scenario.assert?.components, visual: scenario.assert?.visual };
    const result = evaluateRichPlaytestAssertions({
      report: conformanceReport(false),
      scenario,
    });

    expect(result.assertions).toContainEqual({
      details: expect.any(Object),
      id: "component.projection.proof.ProjectionConformance.renderSucceeded",
      pass: false,
    });
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "visual.0.region", pass: true }),
    );
    expect(result.assertions.every(({ pass }) => pass)).toBe(false);
  });

  it("should still allocate nothing per frame with culling enabled", () => {
    const { batch, camera, projection, root } = materialBatchProbe();
    const group = new Group();
    try {
      expect(batch.perObjectFrustumCulled).toBe(true);
      const allocations = countCollectionConstructors(
        () => {
          for (let frame = 0; frame < 10; frame += 1) {
            renderBatch(batch, root, camera, group);
          }
        },
        () => renderBatch(batch, root, camera, group),
      );
      expect(allocations).toEqual({ maps: 0, sets: 0, frustums: 0 });
    } finally {
      projection.dispose();
    }
  });

  // RED: walkProjection never descends into an LOD (projection-plan.ts skips the subtree), so
  // no object the scan visits can have an LOD ancestor. specializedLaneReason still walks every
  // ancestor of every renderable on every scan checking isLOD — work that can never fire. The
  // legitimate isLOD reads are two per visited group (classify on visit, decide descent), so
  // anything beyond 2 per group is the dead ancestor walk.
  // Mutation: give the walk an internal lane-reason variant without the ancestor loop (the
  // exported exactLaneReason keeps its behaviour for out-of-walk callers).
  it("reads isLOD at most twice per visited group per projected scan", () => {
    const meshCount = 300;
    const depth = 5;
    const scene = projectedScene(meshCount, depth);
    const projection = projectionOver(scene);
    expect(projection.deoptimized).toBe(false);

    const original = Object.getOwnPropertyDescriptor(Object3D.prototype, "isLOD");
    let groupIsLodReads = 0;
    Object.defineProperty(Object3D.prototype, "isLOD", {
      configurable: true,
      get(this: Object3D) {
        if ((this as Mesh).isMesh !== true) groupIsLodReads += 1;
        return false;
      },
    });
    try {
      projection.reconcile();
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(Object3D.prototype as { isLOD?: unknown }, "isLOD");
      else Object.defineProperty(Object3D.prototype, "isLOD", original);
    }
    expect(groupIsLodReads).toBeLessThanOrEqual(2 * meshCount * depth);
  });

  // RED: a projected scene that changed nothing still scans every batch instance twice per
  // frame for retirement — #retireBatches (#retire's seen.has per instance) plus #retireState
  // (seen.has per #state entry). Every #state entry belongs to a live batch instance, whose
  // departure #retireBatches already deleted, so the second whole-population sweep deletes
  // nothing, ever. Mutation: delete the #retireState call (and method) in projection-apply.ts.
  it("spends fewer than 3.5 retirement lookups per instance per steady frame", () => {
    const meshCount = 300;
    const scene = projectedScene(meshCount, 0);
    const projection = projectionOver(scene);
    expect(projection.deoptimized).toBe(false);

    const realGet = WeakMap.prototype.get;
    let lookups = 0;
    const spy = vi.spyOn(WeakMap.prototype, "get");
    spy.mockImplementation(function (this: WeakMap<object, unknown>, value: object) {
      lookups += 1;
      return realGet.call(this, value);
    });
    try {
      projection.reconcile();
    } finally {
      spy.mockRestore();
    }
    expect(lookups).toBeLessThan(meshCount * 3.5);
  });

  // The scan classifies through an internal variant that skips the LOD ancestor walk (the walk
  // never descends into an LOD, so no scanned object can have one). This pins the two
  // classifications together across every lane-reason branch: if the internal variant ever
  // drops or narrows a branch the exported reason carries, a projected frame batches or
  // draws the wrong objects, and this fails.
  it("classifies every scanned object exactly as the exported exactLaneReason would", () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial();
    for (let index = 0; index < 8; index += 1) scene.add(new Mesh(geometry, material));

    const transparent = new Mesh(geometry, new MeshBasicMaterial());
    transparent.material.transparent = true;
    scene.add(transparent);
    const ordered = new Mesh(geometry, material);
    ordered.renderOrder = 3;
    scene.add(ordered);
    const morphed = new Mesh(geometry, material);
    morphed.geometry = geometry.clone();
    morphed.geometry.morphAttributes.position = [new BufferAttribute(new Float32Array(24), 3)];
    scene.add(morphed);
    const ranged = new Mesh(geometry.clone(), material);
    ranged.geometry.setDrawRange(0, 6);
    scene.add(ranged);
    scene.add(new InstancedMesh(geometry, material, 4));
    scene.add(new SkinnedMesh(geometry, material));
    scene.add(new Sprite(new SpriteMaterial()));
    const lod = new LOD();
    lod.addLevel(new Mesh(geometry, material), 0);
    scene.add(lod);
    scene.add(new Mesh(geometry, [material, material]));

    const workspace = createProjectionScanWorkspace();
    const result = scanProjection(scene, 4, workspace);
    for (let index = 0; index < result.exactLaneCount; index += 1) {
      const entry = result.exactLane[index] as IProjectionExactEntry;
      expect(entry.object).toBeDefined();
      expect(entry.reason).toBe(exactLaneReason(entry.object as Object3D));
    }
    expect(result.plan.action).toBe("project");
    if (result.plan.action !== "project") return;
    for (const group of result.plan.batchGroups) {
      if (group === undefined) continue;
      for (let index = 0; index < group.memberCount; index += 1)
        expect(exactLaneReason(group.members[index] as Mesh)).toBeUndefined();
    }
    for (let index = 0; index < result.plan.belowFloorCount; index += 1)
      expect(exactLaneReason(result.plan.belowFloor[index] as Mesh)).toBeUndefined();
  });
});

/**
 * The guards for a projection that skips work it can prove is redundant.
 *
 * A settled scene re-derives its classification every frame today, and a scene whose transforms
 * all move pays for a scan whose inputs — membership, geometry, material, flags, visibility — did
 * not change at all. Skipping it is only correct if the skip *proves* the inputs are the same, so
 * every mutation a game can make at runtime is asserted here against the fast path: a moved object,
 * an added and a removed one, a hidden ancestor, a reparent, a swapped material and a swapped
 * geometry. Each would be silently stale on one frame if the proof were wrong, and a wrong frame
 * is the one defect this whole class is built to not have.
 */
describe("projection fast-path guards", () => {
  it("bakes a moved object's new matrix after settled frames", () => {
    const { projection, meshes } = settledScene(12);
    try {
      const moved = meshes[3] as Mesh;
      expectBaked(projection, moved, true);
      moved.position.set(-4, 7, 2.5);
      moved.rotation.y = 0.75;
      projection.reconcile();
      expectBaked(projection, moved, true);
    } finally {
      projection.dispose();
    }
  });

  it("reflects an added and a removed object after settled frames", () => {
    const { projection, scene, meshes } = settledScene(12);
    try {
      const removed = meshes[0] as Mesh;
      const arrived = new Mesh((meshes[1] as Mesh).geometry, (meshes[1] as Mesh).material);
      arrived.position.set(3, 3, 3);
      scene.add(arrived);
      (removed.parent as Group).remove(removed);
      projection.reconcile();

      expect(projection.report.sourceRenderables).toBe(12);
      expect(projection.report.projectedObjects).toBe(12);
      expect(projection.inspect(removed)).toBeUndefined();
      expectBaked(projection, arrived, true);
      // The freed slot must not leave a copy of the object it used to be drawing.
      expect(projection.report.resultDrawCandidates).toBe(projection.report.batches);
    } finally {
      projection.dispose();
    }
  });

  it("reflects a hidden ancestor and a reparent after settled frames", () => {
    const { projection, scene, meshes, group } = settledScene(12);
    try {
      const hidden = meshes[2] as Mesh;
      group.visible = false;
      projection.reconcile();
      // A batch has no hierarchy to inherit visibility from, so a hidden ancestor collapses the
      // slot rather than leaving it drawing.
      expect(baked(projection, hidden).elements).toEqual([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(baked(projection, hidden).visible).toBe(false);

      const reparented = meshes[4] as Mesh;
      group.visible = true;
      scene.add(reparented);
      projection.reconcile();
      expectBaked(projection, reparented, true);
    } finally {
      projection.dispose();
    }
  });

  it("asks a host that can answer for ancestor visibility, and bakes what it says", () => {
    const { projection, meshes, group } = settledScene(12);
    try {
      // The native engine walks the parents in one call; three has no such method. The answer
      // must be the one the walk gives, and the walk must not run when the host answers.
      let asked = 0;
      for (const mesh of meshes) {
        (mesh as unknown as { __tnVisibleInWorld: () => boolean }).__tnVisibleInWorld = () => {
          asked += 1;
          for (let node: Object3D | null = mesh; node !== null; node = node.parent)
            if (!node.visible) return false;
          return true;
        };
      }
      group.visible = false;
      projection.reconcile();
      expect(asked).toBeGreaterThanOrEqual(meshes.length);
      expect(baked(projection, meshes[2] as Mesh).visible).toBe(false);
      group.visible = true;
      projection.reconcile();
      expectBaked(projection, meshes[2] as Mesh, true);
    } finally {
      projection.dispose();
    }
  });

  it("re-classifies a swapped material and a swapped geometry", () => {
    const { projection, meshes } = settledScene(12);
    try {
      const transparent = meshes[1] as Mesh;
      const glass = new MeshBasicMaterial();
      glass.transparent = true;
      transparent.material = glass;
      const regeomed = meshes[5] as Mesh;
      regeomed.geometry = new BoxGeometry(2, 2, 2);
      projection.reconcile();

      expect(baked(projection, transparent).lane).toBe("exact");
      expect(projection.report.exact.transparent).toBe(1);
      // A geometry nothing else shares cannot join the group, so it keeps a draw of its own.
      expect(baked(projection, regeomed).lane).toBe("exact");
      expect(projection.report.exact.tooFewToBatch).toBe(1);
      // The one surviving group still draws, minus the two objects that left it.
      expect(projection.report.instancedBatches).toBe(1);
      expect(projection.report.projectedObjects).toBe(10);
    } finally {
      projection.dispose();
    }
  });

  it("stops re-classifying a structure that has not changed", () => {
    const { projection, meshes } = settledScene(64);
    try {
      const realGetAttribute = BufferGeometry.prototype.getAttribute;
      let reads = 0;
      const spy = vi.spyOn(BufferGeometry.prototype, "getAttribute").mockImplementation(function (
        this: BufferGeometry,
        name: string | number | symbol,
      ) {
        reads += 1;
        return realGetAttribute.call(this, name);
      });
      try {
        for (let frame = 0; frame < 5; frame += 1) {
          // Every transform moves, which is the workload the skip has to survive: the scan reads no
          // world matrices, so a moving object is not a reason to classify it again.
          for (const [index, mesh] of meshes.entries()) {
            mesh.position.y = index + frame;
            mesh.rotation.x = frame * 0.1;
          }
          projection.reconcile();
        }
      } finally {
        spy.mockRestore();
      }
      // One classification for the whole run, not one per frame: the scan asks every renderable for
      // its position attribute, and a frame that re-derived the plan would ask 64 more times.
      expect(reads).toBeLessThan(meshes.length);
    } finally {
      projection.dispose();
    }
  });

  it("re-examines a geometry whose vertex data moved", () => {
    const { projection, meshes } = settledScene(64);
    try {
      const geometry = (meshes[0] as Mesh).geometry;
      const realGetAttribute = BufferGeometry.prototype.getAttribute;
      let reads = 0;
      const spy = vi.spyOn(BufferGeometry.prototype, "getAttribute").mockImplementation(function (
        this: BufferGeometry,
        name: string | number | symbol,
      ) {
        reads += 1;
        return realGetAttribute.call(this, name);
      });
      try {
        projection.reconcile();
        const settledReads = reads;
        // A packed copy of this geometry is the one thing the instanced lane follows by reference
        // and a material lane cannot, so a version move has to bring the classification back.
        (geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
        projection.reconcile();
        expect(reads).toBeGreaterThan(settledReads);
      } finally {
        spy.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });
});
