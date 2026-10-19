import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  type BufferGeometry,
  DirectionalLight,
  Frustum,
  Group,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
} from "three";
// @ts-expect-error Three's private render object has no public declaration.
import RenderObject from "three/src/renderers/common/RenderObject.js";
// @ts-expect-error Three's private render-object manager has no public declaration.
import RenderObjects from "three/src/renderers/common/RenderObjects.js";
// @ts-expect-error Three's private node manager has no public declaration.
import NodeManager from "three/src/renderers/common/nodes/NodeManager.js";
import { getShadowMaterial } from "three/tsl";
import { type NodeBuilder, type NodeFrame, NodeMaterialObserver } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "../src/render/virtual-shadow.js";
import type { IWorldPackage } from "../src/world.js";
import { WorldCells } from "../src/world.js";

/**
 * The shadow half of the prewarm (PRD-458 AC-3).
 *
 * A caster's node is built in the *shadow* context, so a streamed key's first shadow draw is a
 * `NodeBuilder.build` inside a shadow pass — about a third of the shadow lane's CPU on the 2 km walk
 * (~100 ms per 6 s). The main halves of every prewarmed key were already drawn behind the gate; the
 * caster halves were minted and then never drawn until the walk's first window move built all of them
 * in one shadow pass.
 *
 * What three does is the whole of the signal: `getShadowRenderObjectFunction` skips anything without
 * `castShadow` and calls `renderer.renderObject`, which calls `object.onBeforeRender` — so the same
 * counting hook the main half uses fires in a shadow pass. `shadowDraw` below is that call, mirrored
 * with three's own three gates (the level camera's layer mask, the frustum, `visible`/`castShadow`),
 * because the node build itself needs a GPU and the draw that pays for it does not.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;
const CELL_SIZE = manifest.cellSize;
const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
const FOLLOW = {
  x: manifest.extent.minX + 1.5 * CELL_SIZE,
  z: manifest.extent.minZ + 1.5 * CELL_SIZE,
};

/** Two drawable parts per model, so a shared batch key is not one mesh per asset. */
function model(): Object3D {
  const group = new Group();
  for (let part = 0; part < 2; part += 1)
    group.add(new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial()));
  return group;
}

function fileResponse(buffer: Buffer): object {
  return {
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    headers: new Headers(),
    json: async () => JSON.parse(buffer.toString("utf8")),
    ok: true,
    status: 200,
  };
}

function stubFixtureFetch(): void {
  const body = JSON.stringify(manifest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => manifest,
          ok: true,
          status: 200,
        };
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
        ok: false,
        status: 404,
      };
    }),
  );
}

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function cameraAt(x: number, z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1.7, 0.1, 900);
  camera.position.set(x, 12, z);
  camera.lookAt(x + 60, 0, z);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
}

/** What `VirtualShadowNode.setup` needs: a shadow-enabled renderer and a material context. */
const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

interface ILevelShadow {
  readonly camera: PerspectiveCamera;
}

interface ILevelNode {
  readonly light: DirectionalLight;
  readonly shadow: ILevelShadow;
  updateShadow(frame: NodeFrame): void;
}

/** What a shadow render leaves behind: a draw count per key, and the frame each key first drew. */
interface IShadowTally {
  readonly counts: Map<string, number>;
  readonly first: Map<string, number>;
  frame: number;
}

/**
 * One shadow level's render, as three performs it for a caster: the level camera's layers decide
 * which meshes exist for this pass, the frustum drops the ones outside its window, and each survivor
 * is handed to `renderObject`, which is what calls `onBeforeRender`. The node build that follows is
 * a GPU build, so the draw is the part this harness can carry and the part that moves the build.
 */
function shadowDraws(
  node: VirtualShadowNode,
  root: Object3D,
  tally: IShadowTally,
  observe?: (mesh: InstancedMesh, level: number) => void,
): void {
  const renderer = {} as unknown as Parameters<Object3D["onBeforeRender"]>[0];
  for (const [index, levelNode] of [...node.levelNodes, ...node.moverNodes].entries()) {
    const level = levelNode as unknown as ILevelNode;
    level.updateShadow = (): void => {
      level.light.shadow.updateMatrices(level.light);
      const camera = level.shadow.camera;
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      root.traverse((object) => {
        const mesh = object as InstancedMesh;
        if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
        if (mesh.visible !== true || mesh.castShadow !== true) return;
        if ((mesh.layers.mask & camera.layers.mask) === 0) return;
        if (!frustum.intersectsObject(mesh)) return;
        const seen = tally.counts.get(mesh.name) ?? 0;
        tally.counts.set(mesh.name, seen + 1);
        // The first draw of a key is the one that builds its shadow-context node, so the frame it
        // happened on is the whole of the claim: behind the gate, or the walk paid for it.
        if (seen === 0) tally.first.set(mesh.name, tally.frame);
        // The group argument is the multi-material index; one material per batch here, so three
        // passes it as the mesh's own group and never `undefined`.
        mesh.onBeforeRender(
          renderer,
          root as unknown as Scene,
          camera,
          mesh.geometry,
          mesh.material as MeshBasicMaterial,
          mesh as unknown as Group,
        );
        observe?.(mesh, index);
      });
    };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a streamed world's caster prewarm", () => {
  it("draws every prewarmed caster in a shadow render before the gate settles, and never builds one on the walk", async () => {
    const markers: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (String(line).startsWith("TN_WORLD_PREWARM")) markers.push(String(line));
    });
    stubFixtureFetch();

    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(0, 200, 0);
    light.castShadow = true;
    scene.add(light, light.target);
    const node = new VirtualShadowNode(light, {
      clipExtents: [48, 192, 320],
      mapSize: 256,
      marker: false,
      minCasterTexels: 0,
    });
    node.setup(builder);

    const tally: IShadowTally = { counts: new Map(), first: new Map(), frame: 0 };
    const follow = { position: { ...FOLLOW } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      loadModel: async () => model(),
      prefetchSeconds: 0,
      ring: 0,
      // The one hook the gate has to reach the levels with: what a game passes to make them redraw
      // when the world streams records is exactly what makes a caster's prewarm draw happen.
      shadows: { cast: true, castLevels: 2, invalidate: () => node.invalidateAll() },
      surface,
      url: "/world/world.json",
    });
    // In a scene: a world nothing projects is a world nothing draws, and the gate is a promise about
    // draws rather than about mints.
    scene.add(world);
    // Real RenderObjects and NodeManager caches; only shader compilation is replaced by a counter.
    const render = {
      _currentSourceMaterial: null as unknown,
      backend: { isWebGPUBackend: true },
      contextNode: { id: 1, version: 0 },
      currentSamples: 1,
      getMRT: () => null,
      getRenderTarget: () => null,
    };
    const nodes = new NodeManager(render, render.backend);
    const builds: InstancedMesh[] = [];
    nodes._createNodeBuilder = (object: { object: InstancedMesh; material: unknown }) => ({
      build: () => builds.push(object.object),
      getAttributesArray: () => [],
      getBindings: () => [],
      updateNodes: [],
      updateBeforeNodes: [],
      updateAfterNodes: [],
      observer: new NodeMaterialObserver({ ...object, context: {} } as never),
    });
    const objects = new RenderObjects(
      render,
      nodes,
      { getIndex: (object: { geometry: BufferGeometry }) => object.geometry.index },
      { delete: vi.fn() },
      { deleteForRender: vi.fn() },
      {},
    );
    const creations = vi.spyOn(objects, "createRenderObject");
    const geometryChanges = vi.spyOn(RenderObject.prototype, "setGeometry");
    let refreshes = 0;
    let draws = 0;
    const context = { id: 1, sampleCount: 1 };
    const lights = { getLights: () => [] };
    const submitted = new Set<InstancedMesh>();
    const coverage = new Map<InstancedMesh, Set<unknown>>();
    shadowDraws(node, scene, tally, (mesh, index) => {
      const levelLight = (
        [...node.levelNodes, ...node.moverNodes][index] as unknown as { light: DirectionalLight }
      ).light;
      if (levelLight === undefined) throw new Error("missing submitted shadow light");
      const override = getShadowMaterial(levelLight);
      override.side = (mesh.material as MeshBasicMaterial).side === 0 ? 1 : 0;
      render._currentSourceMaterial = mesh.material;
      const object = objects.get(
        mesh,
        override,
        scene,
        levelLight.shadow.camera,
        lights,
        context,
        null,
      );
      // The cache change must leave exactly the source's index range, material and instances.
      object.drawRange = mesh.geometry.drawRange;
      const params = object.getDrawParameters();
      if (mesh.count === 0) expect(params).toBeNull();
      else {
        const indexCount =
          mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count;
        const start = Math.max(0, mesh.geometry.drawRange.start);
        expect(params).toMatchObject({
          firstVertex: start,
          vertexCount: Math.min(indexCount, start + mesh.geometry.drawRange.count) - start,
          instanceCount: mesh.count,
        });
      }
      expect(object.geometry).toBe(mesh.geometry);
      expect(object._sourceMaterial).toBe(mesh.material);
      expect(object.material).toBe(override);
      expect(override.side).toBe((mesh.material as MeshBasicMaterial).side === 0 ? 1 : 0);
      nodes.nodeFrame.renderId = clock * 8 + index;
      draws += 1;
      if (nodes.needsRefresh(object)) refreshes += 1;
      const state = object.getNodeBuilderState();
      submitted.add(mesh);
      const covered = coverage.get(mesh) ?? new Set<unknown>();
      covered.add(state);
      coverage.set(mesh, covered);
    });

    /**
     * The prewarmed *casters*: meshes carrying the owed-a-draw flag that live on one of the two
     * caster layers, which is the prewarm's own bookkeeping on the mesh rather than a guess at which
     * keys were prewarmed rather than streamed. The flag is on a main batch too — the main half is
     * drawn by the main pass and is not what this spec is about.
     */
    const pending = (): string[] => {
      const casters =
        (1 << VIRTUAL_SHADOW_CASTER_LAYER) |
        (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER) |
        (1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER);
      const names: string[] = [];
      const walk = (object: Object3D): void => {
        if (
          (object as { casterPrewarmOwed?: boolean }).casterPrewarmOwed === true &&
          (object.layers.mask & casters) !== 0
        )
          names.push(object.name);
        for (const child of object.children) walk(child);
      };
      for (const child of scene.children) walk(child);
      return names;
    };

    const prewarmed = new Set<string>();
    const camera = cameraAt(follow.position.x, follow.position.z);
    let clock = 0;
    let settled = false;
    for (let frame = 0; frame < 200 && !settled; frame += 1) {
      world.update(undefined, camera);
      // Read between the mint and the level render: this is the prewarm's own list, not a guess at
      // which keys were prewarmed rather than streamed.
      for (const name of pending()) prewarmed.add(name);
      clock += 1;
      tally.frame = clock;
      node.updateBefore({ camera, renderer: {}, time: clock } as unknown as NodeFrame);
      await flush(4);
      settled = markers.length > 0;
    }
    const settledAt = clock;

    // Asserted before awaiting the gate, so a prewarm that never settles is a failed assertion
    // rather than a hanging await. The gate settles, and it says what it paid: every caster it
    // minted drew in a shadow pass.
    expect(settled, "the prewarm gate settled").toBe(true);
    await world.prewarmed;
    expect(prewarmed.size, "the prewarm minted caster halves").toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
    const [marker] = markers;
    expect(marker).toContain(`shadowPrewarmed=${String(prewarmed.size)}`);
    expect(marker).toContain("castersUnbuilt=0");
    for (const name of prewarmed)
      expect(tally.counts.get(name), `${name} drew in a shadow render`).toBeGreaterThan(0);

    // A first submission must warm the actual node-state key used by later level passes.
    // Compilation is counted at NodeManager's build boundary; draw inputs are checked above.
    for (const name of prewarmed)
      expect(tally.first.get(name), `${name} first drew behind the gate`).toBeLessThan(settledAt);
    const firsts = new Map(tally.first);
    const warmed = new Set([...submitted].filter((mesh) => prewarmed.has(mesh.name)));
    const builtAtGate = builds.length;
    const twice = [...warmed].filter((mesh) => (coverage.get(mesh)?.size ?? 0) > 1);
    expect(
      twice.map((mesh) => [mesh.name, coverage.get(mesh)?.size]),
      "identical level shaders reuse one node-builder state per caster",
    ).toEqual([]);

    // Force each level to revisit the same objects after the gate, before streaming can replace them.
    node.invalidateAll();
    for (let frame = 0; frame < 4; frame += 1) {
      clock += 1;
      tally.frame = clock;
      node.updateBefore({ camera, renderer: {}, time: clock } as unknown as NodeFrame);
    }

    // A level's first RenderObject is still necessary; its node state must already be warm.
    const staticStart = {
      creates: creations.mock.calls.length,
      swaps: geometryChanges.mock.calls.length,
      draws,
      refreshes,
    };
    node.invalidateAll();
    for (let frame = 0; frame < 4; frame += 1) {
      clock += 1;
      tally.frame = clock;
      node.updateBefore({ camera, renderer: {}, time: clock } as unknown as NodeFrame);
    }
    expect(creations.mock.calls.length - staticStart.creates).toBe(0);
    expect(geometryChanges.mock.calls.length - staticStart.swaps).toBe(0);
    expect(draws - staticStart.draws).toBeGreaterThan(0);
    expect(refreshes - staticStart.refreshes).toBe(draws - staticStart.draws);
    console.log(
      `TN_RENDERLOOP_SPEC staticDraws=${draws - staticStart.draws} refreshes=${refreshes - staticStart.refreshes} creations=0 swaps=0 states=${builtAtGate}`,
    );
    const late = builds.slice(builtAtGate).filter((mesh) => prewarmed.has(mesh.name));
    expect(
      late.map((mesh) => mesh.name),
      "prewarmed objects have no cold shadow-level node states",
    ).toEqual([]);
    for (let frame = 0; frame < 12; frame += 1) {
      follow.position.x += 0.5 * CELL_SIZE;
      const walk = cameraAt(follow.position.x, follow.position.z);
      world.update(undefined, walk);
      clock += 1;
      tally.frame = clock;
      node.updateBefore({ camera: walk, renderer: {}, time: clock } as unknown as NodeFrame);
      await flush(2);
    }
    for (const [name, frame] of firsts)
      expect(tally.first.get(name), `${name} was not first drawn on the walk`).toBe(frame);
    node.invalidateAll();
    for (let frame = 0; frame < 3; frame += 1) {
      clock += 1;
      node.updateBefore({ camera, renderer: {}, time: clock } as unknown as NodeFrame);
    }
    expect(
      builds
        .slice(builtAtGate)
        .filter((mesh) => prewarmed.has(mesh.name))
        .map((mesh) => mesh.name),
      "no prewarmed key builds during the walk",
    ).toEqual([]);
    world.dispose();
    node.dispose();
  });

  /**
   * PRD-478 phase 2 B: the same gate, with the world's shadow levels drawing its GPU-scene keys.
   *
   * The risk this case exists for is the prewarm's own promise. A caster's shadow-context node is
   * built by a *shadow* render, so a key whose draw no level will ever make leaves
   * `pendingPrewarm` positive forever and the loading gate never settles. With keys on, the caster
   * halves are not minted at all and the shadow key meshes are what a level draws, so the draw the
   * gate waits on is theirs — and it has to be counted by the same `onBeforeRender` a caster's is.
   */
  it("settles the gate on the shadow keys' own draws when a level renders them instead of the caster halves", async () => {
    const markers: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (String(line).startsWith("TN_WORLD_PREWARM")) markers.push(String(line));
    });
    // The flag the world and the scene both read: off by default, so a launch without it registers
    // no provider and mints neither a twin buffer nor a key mesh.
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    stubFixtureFetch();

    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(0, 200, 0);
    light.castShadow = true;
    scene.add(light, light.target);
    const node = new VirtualShadowNode(light, {
      clipExtents: [48, 192, 320],
      mapSize: 256,
      marker: false,
      minCasterTexels: 0,
    });
    node.setup(builder);

    const keyLayer = 1 << VIRTUAL_SHADOW_KEY_LAYER;
    const casterLayers =
      (1 << VIRTUAL_SHADOW_CASTER_LAYER) |
      (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER) |
      (1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER);
    const tally: IShadowTally = { counts: new Map(), first: new Map(), frame: 0 };
    // The level render as three performs it for a shadow caster, with the key layer counted: the
    // camera's mask decides which meshes exist for this pass, `visible` and `castShadow` decide
    // whether they are reached, and `onBeforeRender` is the call the prewarm counts.
    const renderer = {} as unknown as Parameters<Object3D["onBeforeRender"]>[0];
    for (const levelNode of node.levelNodes) {
      const level = levelNode as unknown as ILevelNode;
      level.updateShadow = (): void => {
        level.light.shadow.updateMatrices(level.light);
        const camera = level.shadow.camera;
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const frustum = new Frustum().setFromProjectionMatrix(
          new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        scene.traverse((object: Object3D) => {
          const mesh = object as InstancedMesh;
          if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
          if (mesh.visible !== true || mesh.castShadow !== true) return;
          if ((mesh.layers.mask & camera.layers.mask) === 0) return;
          if ((mesh.layers.mask & keyLayer) === 0) return;
          if (!frustum.intersectsObject(mesh)) return;
          tally.counts.set(mesh.name, (tally.counts.get(mesh.name) ?? 0) + 1);
          if ((tally.counts.get(mesh.name) as number) === 1)
            tally.first.set(mesh.name, tally.frame);
          mesh.onBeforeRender(
            renderer,
            scene as unknown as Scene,
            camera,
            mesh.geometry,
            mesh.material as MeshBasicMaterial,
            mesh as unknown as Group,
          );
        });
      };
    }
    // A renderer the GPU scene accepts, and one the world's dispatch and a level's own dispatch can
    // submit against. The counts below are what is being proved, so nothing here needs a device.
    const gpu = {
      compileAsync: async (): Promise<void> => {},
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
    } as unknown as Parameters<WorldCells["update"]>[0];

    const follow = { position: { ...FOLLOW } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => model(),
      prefetchSeconds: 0,
      ring: 0,
      shadows: { cast: true, castLevels: 2, invalidate: () => node.invalidateAll() },
      surface,
      url: "/world/world.json",
    });
    scene.add(world);

    /** The meshes the gate is waiting on: the prewarm's own flag, on a layer this arm draws. */
    const owed = (layers: number): string[] => {
      const names: string[] = [];
      const walk = (object: Object3D): void => {
        if (
          (object as { casterPrewarmOwed?: boolean }).casterPrewarmOwed === true &&
          (object.layers.mask & layers) !== 0
        )
          names.push(object.name);
        for (const child of object.children) walk(child);
      };
      for (const child of scene.children) walk(child);
      return names;
    };

    const prewarmed = new Set<string>();
    const camera = cameraAt(follow.position.x, follow.position.z);
    let clock = 0;
    let settled = false;
    for (let frame = 0; frame < 200 && !settled; frame += 1) {
      world.update(gpu, camera);
      for (const name of owed(keyLayer)) prewarmed.add(name);
      clock += 1;
      tally.frame = clock;
      node.updateBefore({ camera, renderer: gpu, time: clock } as unknown as NodeFrame);
      await flush(4);
      settled = markers.length > 0;
    }
    const settledAt = clock;

    expect(settled, "the prewarm gate settled on the keys' own draws").toBe(true);
    await world.prewarmed;
    expect(prewarmed.size, "the prewarm minted shadow keys").toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm, "nothing is still owed a draw").toBe(0);
    expect(markers[0]).toContain("castersUnbuilt=0");
    // The world minted no caster half at all while the keys are on: the two are the same placements
    // by two routes and a level's map can only draw one of them, so a caster here would be a mesh
    // no level camera has on.
    expect(owed(casterLayers), "no caster half was minted").toEqual([]);
    // Every owed key drew in a level render, and drew there behind the gate rather than on the walk.
    for (const name of prewarmed) {
      expect(tally.counts.get(name), `${name} drew in a shadow render`).toBeGreaterThan(0);
      expect(tally.first.get(name), `${name} first drew behind the gate`).toBeLessThan(settledAt);
    }
    // And the walk after the gate builds none of them: the point of prewarming them at all.
    node.invalidateAll();
    for (let frame = 0; frame < 4; frame += 1) {
      clock += 1;
      node.updateBefore({ camera, renderer: gpu, time: clock } as unknown as NodeFrame);
    }
    console.info(
      `TN_SHADOW_KEY_PREWARM keys=${String(prewarmed.size)} settledAt=${String(settledAt)}`,
    );
    world.dispose();
    node.dispose();
  });
});
