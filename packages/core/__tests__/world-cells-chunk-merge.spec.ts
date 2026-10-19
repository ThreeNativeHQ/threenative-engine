import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DirectionalLight,
  FrontSide,
  Frustum,
  Group,
  InstancedMesh,
  InterleavedBufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Scene,
  Vector3,
} from "three";
import { PerspectiveCamera } from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISCRETE_LOD_SCHEMA_VERSION,
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
} from "../src/model-lod.js";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "../src/render/virtual-shadow.js";
import type { IRendererLike } from "../src/renderer.js";
import { isStatic } from "../src/static-transform.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * A hand-placed chunk submits one draw per mesh node, in the main pass and again in every shadow
 * level that redraws it — 42 nodes over 8 materials is 42 calls where 8 would do. The chunk is the
 * one subtree here that never moves, so it is merged by material before it is ever added.
 *
 * Everything the bake cannot flatten keeps its own geometry: a chain-carried mesh has a `ModelLod`
 * that swaps it, a morph-target mesh would lose its targets, and an instanced mesh past the triangle
 * cap is already one cheap draw.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const CELL_SIZE = manifest.cellSize;
const CHUNK_PATH = "chunks/yard_1_1.glb";
/** The centre of the one cell the fixture keeps, so the follow point lands in the chunk's cell. */
const FOLLOW = {
  x: manifest.extent.minX + 1.5 * CELL_SIZE,
  z: manifest.extent.minZ + 1.5 * CELL_SIZE,
};
/** Where the chunk sits in the world, so a baked vertex is at its authored place and not at zero. */
const CHUNK_ORIGIN = new Vector3(10, 0, -5);
/** Box sides cycling per mesh, so a merged vertex proves which piece it came from. */
const SIDES = [1, 2, 3];
const PER_MATERIAL = 4;
const INSTANCES = 5;
const INSTANCE_GAP = 4;

const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };

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

/** The committed package with one cell, one chunk and nothing scattered: only the chunk is tested. */
function oneChunk(): IWorldPackage {
  const cell = manifest.cells.find((candidate) => candidate.x === 1 && candidate.z === 1);
  if (cell === undefined) throw new Error("the committed package has no cell 1:1.");
  return { ...manifest, cells: [{ ...cell, chunks: [CHUNK_PATH], runs: [] }] };
}

function stubManifestFetch(pkg: IWorldPackage): void {
  const body = JSON.stringify(pkg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => pkg,
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

/** The chunk a 2 km package's cook would hand over: 12 boxes over 3 materials, plus 5 repeats. */
function chunkModel(): { readonly group: Group; readonly materials: MeshBasicMaterial[] } {
  const group = new Group();
  group.position.copy(CHUNK_ORIGIN);
  const materials = [0, 1, 2].map(() => new MeshBasicMaterial());
  let placed = 0;
  for (const material of materials)
    for (let part = 0; part < PER_MATERIAL; part += 1) {
      const mesh = new Mesh(new BoxGeometry(SIDES[part % SIDES.length] as number, 2, 3), material);
      mesh.position.set(placed * INSTANCE_GAP, part, 0);
      group.add(mesh);
      placed += 1;
    }
  const repeated = new InstancedMesh(
    new BoxGeometry(2, 2, 2),
    materials[0] as MeshBasicMaterial,
    INSTANCES,
  );
  for (let instance = 0; instance < INSTANCES; instance += 1)
    repeated.setMatrixAt(
      instance,
      new Matrix4().makeTranslation(placed * INSTANCE_GAP + instance * INSTANCE_GAP, 4, 0),
    );
  repeated.instanceMatrix.needsUpdate = true;
  group.add(repeated);
  return { group, materials };
}

/** Where every piece of the chunk is, in world space: the box the merged geometry has to reproduce. */
function sourceBox(group: Object3D): Box3 {
  const box = new Box3().makeEmpty();
  const matrix = new Matrix4();
  const placed = new Matrix4();
  group.updateMatrixWorld(true);
  group.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean };
    if (mesh.isMesh !== true) return;
    mesh.geometry.computeBoundingBox();
    const piece = (mesh.geometry.boundingBox as Box3).clone();
    if (mesh.isInstancedMesh === true) {
      const instanced = mesh as InstancedMesh;
      for (let instance = 0; instance < instanced.count; instance += 1) {
        instanced.getMatrixAt(instance, matrix);
        box.union(piece.clone().applyMatrix4(placed.multiplyMatrices(mesh.matrixWorld, matrix)));
      }
      return;
    }
    box.union(piece.applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

function meshesIn(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh === true) found.push(object as Mesh);
  });
  return found;
}

/** Observe the real level probe's draw inputs at three's shadow-render boundary, without a GPU. */
function shadowDraws(
  world: WorldCells,
  half: "cluster" | "wide",
  observe?: (
    meshes: Mesh[],
    level: number,
    depth: { near: number; far: number },
    camera: Camera,
  ) => void,
): Mesh[][] {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 900);
  camera.position.copy(CHUNK_ORIGIN).add(new Vector3(0, 10, 0));
  const light = new DirectionalLight();
  light.position.copy(CHUNK_ORIGIN).add(new Vector3(60, 200, -40));
  light.target.position.copy(CHUNK_ORIGIN);
  light.castShadow = true;
  scene.add(world, camera, light, light.target);
  for (const layer of [VIRTUAL_SHADOW_CASTER_LAYER, VIRTUAL_SHADOW_WIDE_CASTER_LAYER]) {
    const count = layer === VIRTUAL_SHADOW_WIDE_CASTER_LAYER && half === "cluster" ? 3 : 1;
    for (let index = 0; index < count; index += 1) {
      const batch = new Mesh(new BoxGeometry(8, 8, 8), surface);
      batch.position.copy(CHUNK_ORIGIN);
      batch.castShadow = true;
      batch.layers.set(layer);
      scene.add(batch);
    }
  }
  scene.updateMatrixWorld(true);
  const node = new VirtualShadowNode(light, {
    clipExtents: [24, 96, 320],
    invalidationDelay: 0,
    marker: false,
    mapSize: 1024,
    adaptiveRefresh: false,
    adaptiveCasterGate: false,
  });
  node.setup({
    context: {},
    material: {},
    renderer: { shadowMap: { enabled: true } },
  } as unknown as NodeBuilder);
  const draws: Mesh[][] = [];
  node.levelNodes.forEach((levelNode, index) => {
    (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
      const levelLight = node.levelLights[index] as DirectionalLight;
      levelLight.shadow.updateMatrices(levelLight);
      const shadowCamera = levelLight.shadow.camera;
      expect(shadowCamera.layers.isEnabled(VIRTUAL_SHADOW_CASTER_LAYER)).toBe(half === "cluster");
      expect(shadowCamera.layers.isEnabled(VIRTUAL_SHADOW_WIDE_CASTER_LAYER)).toBe(half === "wide");
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(
          shadowCamera.projectionMatrix,
          shadowCamera.matrixWorldInverse,
        ),
        shadowCamera.coordinateSystem,
        shadowCamera.reversedDepth,
      );
      const visible: Mesh[] = [];
      world.traverseVisible((object) => {
        if (object instanceof Mesh) visible.push(object);
      });
      draws[index] = visible.filter(
        (mesh) =>
          mesh.visible &&
          mesh.castShadow &&
          shadowCamera.layers.test(mesh.layers) &&
          (!mesh.frustumCulled || frustum.intersectsObject(mesh)),
      );
      for (const mesh of draws[index] as Mesh[])
        mesh.onBeforeRender(
          {} as never,
          scene,
          shadowCamera,
          mesh.geometry,
          mesh.material as Material,
          null as never,
        );
      observe?.(
        draws[index] as Mesh[],
        index,
        { near: shadowCamera.near, far: shadowCamera.far },
        shadowCamera,
      );
      for (const mesh of draws[index] as Mesh[])
        mesh.onAfterRender(
          {} as never,
          scene,
          shadowCamera,
          mesh.geometry,
          mesh.material as Material,
          null as never,
        );
    };
  });
  for (const mover of node.moverNodes)
    (mover as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => undefined;
  for (let time = 1; time <= 3; time += 1)
    node.updateBefore({ camera, renderer: {}, time } as unknown as NodeFrame);
  expect(draws).toHaveLength(3);
  node.dispose();
  world.removeFromParent();
  return draws;
}

/** The ordered world-space vertices of every drawn triangle, including its authored side. */
function trianglesOf(meshes: readonly Mesh[]): string[] {
  const triangles: string[] = [];
  const instance = new Matrix4();
  const world = new Matrix4();
  const vertex = new Vector3();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const indices = geometry.getIndex();
    const end = Math.min(
      indices?.count ?? position.count,
      geometry.drawRange.start + geometry.drawRange.count,
    );
    for (let copy = 0; copy < (mesh instanceof InstancedMesh ? mesh.count : 1); copy += 1) {
      if (mesh instanceof InstancedMesh) mesh.getMatrixAt(copy, instance);
      else instance.identity();
      world.multiplyMatrices(mesh.matrixWorld, instance);
      for (let at = geometry.drawRange.start; at + 2 < end; at += 3) {
        const triangle: number[] = [(mesh.material as Material).side];
        for (let corner = 0; corner < 3; corner += 1) {
          vertex
            .fromBufferAttribute(position, indices?.getX(at + corner) ?? at + corner)
            .applyMatrix4(world);
          triangle.push(vertex.x, vertex.y, vertex.z);
        }
        triangles.push(JSON.stringify(triangle));
      }
    }
  }
  return triangles.sort();
}

function preservedChunk(): { group: Group; parts: InstancedMesh[] } {
  const group = new Group();
  group.position.copy(CHUNK_ORIGIN);
  const nested = new Group();
  nested.position.set(2, 4, -2);
  nested.scale.set(2, 1, 2);
  group.add(nested);
  const parts: InstancedMesh[] = [];
  for (let part = 0; part < 5; part += 1) {
    const size = part === 4 ? 1 / 32 : 2;
    const box = new BoxGeometry(size, size, size);
    const geometry = part % 2 === 0 ? box : box.toNonIndexed();
    if (part === 0) {
      const position = geometry.getAttribute("position");
      geometry.setAttribute(
        "position",
        new BufferAttribute(
          Int16Array.from(position.array, (value) => value * 32767),
          3,
          true,
        ),
      );
    }
    if (part === 1) geometry.setDrawRange(3, 15);
    const mesh = new InstancedMesh(
      geometry,
      new MeshBasicMaterial({ side: part % 2 === 0 ? FrontSide : BackSide }),
      part === 4 ? 1 : 3,
    );
    mesh.position.set(part * 2, 0, 0);
    if (part === 3) mesh.position.x = 150;
    for (let copy = 0; copy < mesh.count; copy += 1)
      mesh.setMatrixAt(
        copy,
        copy === 2
          ? new Matrix4().set(0, 0, 1, 0, 0, 1, 0, 4, -1, 0, 0, -4, 0, 0, 0, 1)
          : new Matrix4().makeTranslation(0, copy * 2, copy * -2),
      );
    nested.add(mesh);
    parts.push(mesh);
  }
  return { group, parts };
}

function markers(): string[] {
  return (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("TN_WORLD_CHUNK_MERGE"));
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Step the world until the chunk has attached, or fail rather than assert on nothing. */
async function chunkAttached(world: WorldCells, renderer?: IRendererLike): Promise<Group> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update(renderer, followCamera);
    if (world.stats().loadsInFlight === 0) {
      const chunk = world.getObjectByName("world-chunk");
      if (chunk !== undefined) return chunk as Group;
    }
  }
  throw new Error("the world never attached the chunk.");
}

/** Load the chunk, wait for the world to settle it, and hand back the chunk it attached. */
const followCamera = new PerspectiveCamera(60, 1, 0.1, 1000);
followCamera.position.set(FOLLOW.x, 20, FOLLOW.z);
followCamera.lookAt(FOLLOW.x, 0, FOLLOW.z);
followCamera.updateMatrixWorld();

/**
 * A renderer whose WebGPU backend counts the attributes it is asked to create, which is the whole
 * of what the seam does: the buffers the bake made, before anything can draw them.
 */
function countingRenderer(uploaded: BufferGeometry[]): IRendererLike {
  return {
    compileAsync: () => Promise.resolve(),
    uploadAttributes: (batch: Iterable<BufferGeometry>) => {
      let created = 0;
      for (const geometry of batch) {
        uploaded.push(geometry);
        created += Object.keys(geometry.attributes).length;
        if (geometry.getIndex() !== null) created += 1;
      }
      return created;
    },
  } as unknown as IRendererLike;
}

async function attached(
  model: Object3D,
  options: Partial<Parameters<typeof WorldCells.load>[0]>,
  renderer?: IRendererLike,
): Promise<{ readonly chunk: Group; readonly world: WorldCells }> {
  stubManifestFetch(oneChunk());
  const world = await WorldCells.load({
    ...options,
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    // Off, like the rest of this file's claims: what a merged chunk is asked to do here is keep its
    // own hierarchy, and a cell's BundleGroup re-parents the recorded draws out of it. The record
    // and replay it does with them is `world-bundles.spec.ts`'s subject.
    bundles: false,
    follow: options.follow ?? { position: { ...FOLLOW } },
    loadModel: async () => model,
    prefetchSeconds: 0,
    ring: 0,
    surface,
    url: "/world/world.json",
  });
  return { chunk: await chunkAttached(world, renderer), world };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A grid over its own baked AutoLOD chain, registered by the real plugin — the parser is the only
 * fake part, exactly as `world-cells-chain-lod.spec.ts` builds it.
 */
async function chainedMesh(): Promise<Mesh> {
  const triangles = 16;
  const quads = triangles / 2;
  const positions = new Float32Array((quads + 1) * 2 * 3);
  for (let vertex = 0; vertex <= quads; vertex += 1) {
    const at = (vertex / quads - 0.5) * 2;
    positions.set([at, 0, at, at, 1, at], vertex * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  const indices = (count: number): Uint32Array => {
    const at = new Uint32Array(count * 3);
    for (let quad = 0; quad < count / 2; quad += 1) {
      const offset = quad * 6;
      at[offset] = quad * 2;
      at[offset + 1] = quad * 2 + 1;
      at[offset + 2] = quad * 2 + 2;
      at[offset + 3] = quad * 2 + 1;
      at[offset + 4] = quad * 2 + 3;
      at[offset + 5] = quad * 2 + 2;
    }
    return at;
  };
  geometry.setIndex(new BufferAttribute(indices(triangles), 1));
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  const levels = [indices(8), indices(4)];
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map<object, { meshes: number; primitives: number }>([
      [mesh, { meshes: 0, primitives: 0 }],
    ]),
    getDependency: async (_type: string, index: number) => ({ array: levels[index] }),
    json: {
      meshes: [
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: {
                  absoluteErrors: [0.05, 0.2],
                  counts: [8, 4],
                  errors: [0.05, 0.2],
                  indices: [0, 1],
                  lod0Triangles: triangles,
                  schemaVersion: DISCRETE_LOD_SCHEMA_VERSION,
                },
              },
            },
          ],
        },
      ],
    },
  });
  await plugin.afterRoot({});
  plugin.attach(mesh, { hysteresis: 0.15, maxPixelError: 1 });
  return mesh;
}

/** A mesh with a morph target the bake would drop: the target is the mesh's own business. */
function morphed(): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.geometry.morphAttributes.position = [
    new BufferAttribute(
      Float32Array.from(mesh.geometry.getAttribute("position").array as Float32Array),
      3,
    ),
  ];
  return mesh;
}

/** Three opaque materials and one cutout: the per-material shadow bill, before the proxy. */
function shadowChunkModel(): {
  readonly cutout: MeshBasicMaterial;
  readonly group: Group;
  readonly opaque: MeshBasicMaterial[];
} {
  const group = new Group();
  group.position.copy(CHUNK_ORIGIN);
  const opaque = [0, 1, 2].map(() => new MeshBasicMaterial());
  const cutout = new MeshBasicMaterial({ alphaTest: 0.5 });
  let placed = 0;
  for (const material of [...opaque, cutout])
    for (let part = 0; part < PER_MATERIAL; part += 1) {
      const mesh = new Mesh(new BoxGeometry(2, 2, 2), material);
      mesh.position.set(placed * INSTANCE_GAP, part, 0);
      group.add(mesh);
      placed += 1;
    }
  return { cutout, group, opaque };
}

describe("a hand-placed chunk merged by material", () => {
  it("uploads the merged buffers during admission, not on the first draw", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group } = chunkModel();
    const uploaded: BufferGeometry[] = [];
    const { chunk, world } = await attached(group, {}, countingRenderer(uploaded));

    // Every one of the three merged groups — position, normal, uv and the index, four buffers each —
    // was handed the renderer during admission, which is the frame that used to create them.
    const merged = meshesIn(chunk);
    expect(merged).toHaveLength(3);
    expect(uploaded).toEqual(merged.map((mesh) => mesh.geometry));
    expect(markers()).toEqual([
      "TN_WORLD_CHUNK_MERGE meshes=13 draws=3 bytes=14280 uploaded=12 instancedExpanded=1 keptInstanced=0 shadowDraws=0",
    ]);
    // And the chunk is attached, so the seam is admission and not a replacement for it.
    expect(chunk.parent).not.toBeNull();
    world.dispose();
  });

  it("attaches as one mesh per material, at the vertices the package authored", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group, materials } = chunkModel();
    const authored = sourceBox(group);
    const { chunk, world } = await attached(group, {});

    // Thirteen nodes in, three draws out: the four boxes and the five repeats under `materials[0]`
    // are one buffer now, and the other two materials are one each. `bytes` is what those buffers
    // hold, indices included: 19,584 before the bake kept its index (nine boxes plus four plus four,
    // de-indexed at 36 vertices and 32 bytes each) and 14,280 after, which is what a first draw of a
    // merged chunk uploads.
    const meshes = meshesIn(chunk);
    expect(meshes).toHaveLength(3);
    expect(meshes.map((mesh) => mesh.material).sort()).toEqual([...materials].sort());
    expect(markers()).toEqual([
      "TN_WORLD_CHUNK_MERGE meshes=13 draws=3 bytes=14280 uploaded=0 instancedExpanded=1 keptInstanced=0 shadowDraws=0",
    ]);

    // The whole point of the bake is that the geometry did not move: every vertex is where the
    // export put it, so the chunk's box is the union of the pieces it was made of.
    meshes[0]?.geometry.computeBoundingBox();
    const box = (meshes[0]?.geometry.boundingBox as Box3).clone().applyMatrix4(chunk.matrixWorld);
    for (let component = 0; component < 3; component += 1)
      expect([box.min.getComponent(component), box.max.getComponent(component)]).toEqual([
        expect.closeTo(authored.min.getComponent(component), 5),
        expect.closeTo(authored.max.getComponent(component), 5),
      ]);

    // Behaviour kept: the chunk is still one frozen subtree, still casting and receiving as the
    // world's shadow options say, and the merged groups are the chunk's own children.
    expect(isStatic(chunk)).toBe(true);
    for (const mesh of meshes) {
      expect(mesh.parent).toBe(chunk);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(false);
    }
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("tags every mesh the main pass draws from the chunk as chunks", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group } = chunkModel();
    const { chunk, world } = await attached(group, {});

    // A hand-placed chunk is the buildings and set dressing: one draw per material after the bake,
    // and on the map-walk those draws were the largest part of the `other` bucket — a bridge, a wall
    // and a water surface's cell all reading as one number. The origin is written where the chunk is
    // prepared, so a merge that is refused and a chunk left as authored are named the same way.
    const meshes = meshesIn(chunk);
    expect(meshes).toHaveLength(3);
    for (const mesh of meshes) {
      expect(mesh.layers.isEnabled(0)).toBe(true);
      expect(mesh.userData.tnDrawSource).toBe("chunks");
    }
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("keeps an instanced mesh whose group would cross the triangle cap", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group, materials } = chunkModel();
    // The cap is on the expanded triangles alone: five repeats of a 12-triangle box is 60, and the
    // instanced draw that already exists costs one call to draw them.
    const { chunk, world } = await attached(group, { chunkMergeMaxTriangles: 1 });

    const meshes = meshesIn(chunk);
    expect(meshes).toHaveLength(4);
    expect(meshes.filter((mesh) => mesh instanceof InstancedMesh)).toHaveLength(1);
    expect((meshes.find((mesh) => mesh instanceof InstancedMesh) as InstancedMesh).count).toBe(
      INSTANCES,
    );
    // Still the chunk's own material, and still its own node: an instanced mesh kept in place draws
    // exactly what it drew before the bake.
    const kept = meshes.find((mesh) => mesh instanceof InstancedMesh) as InstancedMesh;
    expect(kept.material).toBe(materials[0]);
    expect(markers()).toEqual([
      "TN_WORLD_CHUNK_MERGE meshes=13 draws=4 bytes=10080 uploaded=0 instancedExpanded=0 keptInstanced=1 shadowDraws=0",
    ]);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("disposes the merged buffers when the chunk's cell is evicted", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group } = chunkModel();
    const follow = { position: { ...FOLLOW } };
    stubManifestFetch(oneChunk());
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      loadModel: async () => group,
      prefetchSeconds: 0,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    const merged = meshesIn(await chunkAttached(world));
    expect(merged).toHaveLength(3);
    const disposed = merged.map((mesh) => vi.spyOn(mesh.geometry, "dispose"));

    // Past the hysteresis ring the cell leaves, and the buffers the bake made go with it — they
    // belong to the chunk, unlike the package's own geometry, which the loader cache still holds.
    follow.position.x += 4 * CELL_SIZE;
    for (let pass = 0; pass < 40 && world.stats().residentKeys.length > 0; pass += 1) {
      world.update();
      await flush();
    }
    expect(world.stats().residentKeys).toEqual([]);
    for (const spy of disposed) expect(spy).toHaveBeenCalled();
    expect(world.getObjectByName("world-chunk")).toBeUndefined();
    world.dispose();
  });

  it("leaves a chained or morphed mesh exactly where the package put it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group, materials } = chunkModel();
    const chained = await chainedMesh();
    const target = morphed();
    group.add(chained, target);
    const { chunk, world } = await attached(group, {});

    // Fifteen nodes in, five draws out: the three material groups, plus the two meshes the bake
    // cannot flatten. A merged buffer would carry a `ModelLod` with no geometry to swap, and would
    // drop the morph target outright — so each keeps its own geometry and its own node.
    const meshes = meshesIn(chunk);
    expect(meshes).toHaveLength(5);
    expect(meshes).toContain(chained);
    expect(meshes).toContain(target);
    expect(
      meshes
        .filter((mesh) => materials.includes(mesh.material as MeshBasicMaterial))
        .map((mesh) => mesh.material)
        .sort(),
    ).toEqual([...materials].sort());
    expect(lodChainOf(chained.geometry)).toBeDefined();
    expect(target.geometry.morphAttributes.position).toHaveLength(1);
    expect(markers()).toEqual([
      "TN_WORLD_CHUNK_MERGE meshes=15 draws=5 bytes=14280 uploaded=0 instancedExpanded=1 keptInstanced=0 shadowDraws=0",
    ]);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  // Covered originals no longer cast: both scatter granularities must retain the proxy.
  it.each([
    ["cluster", true],
    ["wide", true],
  ] as const)(
    "a level selecting %s casters draws the merged chunk proxy: %s",
    async (half, drawn) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const { group } = shadowChunkModel();
      const { chunk, world } = await attached(group, { shadows: { cast: true, receive: true } });
      const proxy = chunk.getObjectByName("world-chunk-shadow") as Mesh;
      expect(proxy).toBeDefined();
      const draws = shadowDraws(world, half);
      for (const level of draws) expect(level.includes(proxy)).toBe(drawn);
      world.dispose();
    },
  );

  it.each(["cluster", "wide"] as const)(
    "consolidates retained opaque parts with exact %s level inputs and unchanged main draws",
    async (half) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const { group, parts } = preservedChunk();
      group.updateMatrixWorld(true);
      const mainBefore = trianglesOf(parts);
      const original = parts.map((mesh) => ({
        geometry: mesh.geometry,
        material: mesh.material,
        parent: mesh.parent,
        matrix: mesh.matrix.clone(),
      }));
      const follow = { position: { ...FOLLOW } };
      const { chunk, world } = await attached(group, {
        follow,
        chunkMergeMaxTriangles: 1,
        shadows: { cast: true, receive: true },
      });
      const proxies = meshesIn(chunk).filter((mesh) => !mesh.layers.isEnabled(0));
      expect(parts.filter((mesh) => mesh.castShadow && mesh.layers.isEnabled(0))).toHaveLength(0);
      expect(proxies).toHaveLength(2);
      expect(meshesIn(chunk).filter((mesh) => mesh.layers.isEnabled(0))).toEqual(parts);
      expect(trianglesOf(parts)).toEqual(mainBefore);
      for (let index = 0; index < parts.length; index += 1) {
        const mesh = parts[index] as InstancedMesh;
        expect(mesh.geometry).toBe(original[index]?.geometry);
        expect(mesh.material).toBe(original[index]?.material);
        expect(mesh.parent).toBe(original[index]?.parent);
        expect(mesh.matrix.equals(original[index]?.matrix as Matrix4)).toBe(true);
      }
      const after: string[][] = [];
      shadowDraws(world, half, (drawn, level) => {
        after[level] = trianglesOf(drawn);
      });
      // Re-enable the exact retained sources and disable only their proxies: the pre-consolidation draw path.
      for (const mesh of parts) mesh.castShadow = true;
      for (const proxy of proxies) proxy.castShadow = false;
      const before: string[][] = [];
      shadowDraws(world, half, (drawn, level) => {
        before[level] = trianglesOf(drawn);
      });
      expect(before[0]?.length).toBeGreaterThan(0);
      expect(before[0]?.length).toBeGreaterThan(before[1]?.length ?? 0);
      expect(after).toEqual(before);
      expect(before[2]?.length).toBeGreaterThan(before[1]?.length ?? 0);
      for (const mesh of parts) mesh.castShadow = false;
      for (const proxy of proxies) proxy.castShadow = true;
      // A hidden source hierarchy must not reappear through a proxy parented outside it.
      const nested = parts[0]?.parent as Group;
      nested.visible = false;
      const hiddenAfter: string[][] = [];
      shadowDraws(world, half, (drawn, level) => {
        hiddenAfter[level] = trianglesOf(drawn);
      });
      for (const mesh of parts) mesh.castShadow = true;
      for (const proxy of proxies) proxy.castShadow = false;
      const hiddenBefore: string[][] = [];
      shadowDraws(world, half, (drawn, level) => {
        hiddenBefore[level] = trianglesOf(drawn);
      });
      expect(hiddenAfter).toEqual(hiddenBefore);
      expect(hiddenAfter).toEqual([[], [], []]);
      nested.visible = true;
      for (const mesh of parts) mesh.castShadow = false;
      for (const proxy of proxies) proxy.castShadow = true;
      expect(trianglesOf(parts)).toEqual(mainBefore);
      const disposed = proxies.map((mesh) => vi.spyOn(mesh.geometry, "dispose"));
      follow.position.x += 4 * CELL_SIZE;
      for (let pass = 0; pass < 40 && world.stats().residentKeys.length > 0; pass += 1) {
        world.update();
        await flush();
      }
      expect(world.stats().residentKeys).toEqual([]);
      expect(world.getObjectByName("world-chunk")).toBeUndefined();
      for (const spy of disposed) expect(spy).toHaveBeenCalled();
      world.dispose();
    },
  );

  it.each(["cluster", "wide"] as const)(
    "does no retained proxy index writes or uploads after warming each %s level",
    async (half) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const { group } = preservedChunk();
      const follow = { position: { ...FOLLOW } };
      const { chunk, world } = await attached(group, {
        follow,
        chunkMergeMaxTriangles: 1,
        shadows: { cast: true, receive: true },
      });
      const proxies = meshesIn(chunk).filter((mesh) => !mesh.layers.isEnabled(0));
      const levels: {
        camera: Camera;
        gates: number[];
        indices: BufferAttribute[];
        triangles: string[];
      }[] = [];
      const positions = proxies.map((proxy) => proxy.geometry.getAttribute("position"));
      shadowDraws(world, half, (drawn, level, _depth, camera) => {
        levels[level] = {
          camera,
          gates: proxies.map((proxy) => Reflect.get(proxy, "casterMinDiameter") as number),
          indices: proxies.map((proxy) => proxy.geometry.getIndex() as BufferAttribute),
          triangles: trianglesOf(drawn),
        };
      });
      expect(new Set(levels.map((level) => JSON.stringify(level.triangles))).size).toBe(3);
      const indices = [...new Set(levels.flatMap((level) => level.indices))];
      const writes = indices.map((index) => vi.spyOn(index.array as Uint32Array, "set"));
      const versions = indices.map((index) => index.version);
      const geometries = new Set(proxies.map((proxy) => proxy.geometry));
      const scene = new Scene();
      const render = (level: (typeof levels)[number]) => {
        proxies.forEach((proxy, part) => {
          Reflect.set(proxy, "casterMinDiameter", level.gates[part]);
          proxy.onBeforeRender(
            {} as never,
            scene,
            level.camera,
            proxy.geometry,
            proxy.material as Material,
            null as never,
          );
          expect(proxy.geometry.getAttribute("position")).toBe(positions[part]);
          geometries.add(proxy.geometry);
        });
      };
      for (let frame = 0; frame < 6; frame += 1)
        for (const level of levels) {
          render(level);
          proxies.forEach((proxy, part) =>
            expect(proxy.geometry.getIndex()).toBe(level.indices[part]),
          );
          expect(trianglesOf(proxies)).toEqual(level.triangles);
        }
      expect(indices.map((index, at) => index.version - (versions[at] as number))).toEqual(
        indices.map(() => 0),
      );
      expect(writes.map((spy) => spy.mock.calls.length)).toEqual(indices.map(() => 0));
      // A changed level must still update immediately, without invalidating either other level.
      const changed = levels[0] as (typeof levels)[number];
      changed.gates = proxies.map(() => Number.POSITIVE_INFINITY);
      render(changed);
      expect(trianglesOf(proxies)).toEqual([]);
      for (const level of levels.slice(1)) {
        const before = level.indices.map((index) => index.version);
        render(level);
        expect(trianglesOf(proxies)).toEqual(level.triangles);
        expect(level.indices.map((index) => index.version)).toEqual(before);
      }
      // More than three cameras reuse the bounded geometry pool, which eviction releases whole.
      const held = levels[1] as (typeof levels)[number];
      for (let extra = 0; extra < 6; extra += 1) render({ ...held, camera: held.camera.clone() });
      expect(geometries.size).toBeLessThanOrEqual(proxies.length * 3);
      const disposed = [...geometries].map((geometry) => vi.spyOn(geometry, "dispose"));
      follow.position.x += 4 * CELL_SIZE;
      for (let pass = 0; pass < 40 && world.stats().residentKeys.length > 0; pass += 1) {
        world.update();
        await flush();
      }
      expect(world.stats().residentKeys).toEqual([]);
      for (const spy of disposed) expect(spy).toHaveBeenCalledOnce();
      world.dispose();
    },
  );

  it("leaves AutoLOD, alpha, morph and deforming retained parts casting their own silhouettes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { group, parts } = preservedChunk();
    const chained = await chainedMesh();
    const lod = new InstancedMesh(chained.geometry, chained.material, 1);
    const morph = new InstancedMesh(morphed().geometry, surface, 1);
    const alpha = new InstancedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ alphaTest: 0.5 }),
      1,
    );
    const transparent = new InstancedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ transparent: true }),
      1,
    );
    const deformingMaterial = new MeshBasicMaterial();
    Reflect.set(deformingMaterial, "positionNode", {});
    const deforming = new InstancedMesh(new BoxGeometry(), deformingMaterial, 1);
    const custom = new InstancedMesh(new BoxGeometry(), surface, 1);
    custom.customDepthMaterial = new MeshBasicMaterial();
    const mirrored = new InstancedMesh(new BoxGeometry(), surface, 1);
    mirrored.scale.x = -1;
    const excluded = [lod, morph, alpha, transparent, deforming, custom, mirrored];
    for (const mesh of excluded) mesh.setMatrixAt(0, new Matrix4());
    group.add(...excluded);
    const { chunk, world } = await attached(group, {
      chunkMergeMaxTriangles: 1,
      shadows: { cast: true, receive: true },
    });
    expect(meshesIn(chunk).filter((mesh) => !mesh.layers.isEnabled(0))).toHaveLength(2);
    for (const mesh of excluded) {
      expect(mesh.parent).toBe(group);
      expect(mesh.castShadow).toBe(true);
    }
    for (const mesh of parts) expect(mesh.castShadow).toBe(false);
    expect(lodChainOf(lod.geometry)).toBeDefined();
    world.dispose();
  });

  it("collapses the chunk's shadow bill into one position-only proxy per side", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { cutout, group, opaque } = shadowChunkModel();
    const follow = { position: { ...FOLLOW } };
    stubManifestFetch(oneChunk());
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      loadModel: async () => group,
      prefetchSeconds: 0,
      ring: 0,
      shadows: { cast: true, receive: true },
      surface,
      url: "/world/world.json",
    });
    const chunk = await chunkAttached(world);
    const proxy = chunk.getObjectByName("world-chunk-shadow") as Mesh | undefined;
    if (proxy === undefined) throw new Error("Expected one shadow-only proxy on the chunk.");

    // One draw per level instead of one per material: the four material groups are still four
    // meshes in the main pass, and the depth pass reads this one.
    expect(markers()).toEqual([
      "TN_WORLD_CHUNK_MERGE meshes=16 draws=5 bytes=13440 uploaded=0 instancedExpanded=0 keptInstanced=0 shadowDraws=1",
    ]);
    expect(meshesIn(chunk)).toHaveLength(5);
    // On both caster halves, and off the main camera's layer.
    expect(proxy.layers.mask).toBe(
      (1 << VIRTUAL_SHADOW_CASTER_LAYER) | (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER),
    );
    expect(proxy.castShadow).toBe(true);
    expect(proxy.receiveShadow).toBe(false);
    // Two origins on one chunk, split by the layer that decides which pass draws them: the proxy is
    // the shadow passes' bill, the groups under it are the main pass's.
    expect(proxy.userData.tnDrawSource).toBe("proxies");
    for (const mesh of meshesIn(chunk).filter((one) => one.layers.isEnabled(0)))
      expect(mesh.userData.tnDrawSource).toBe("chunks");
    // The group's own material, by reference: the side it is grouped by is that material's own
    // `side`, so the depth pass reads exactly what the covered mesh's depth material would have.
    expect(opaque).toContain(proxy.material as MeshBasicMaterial);
    expect((proxy.material as Material).side).toBe(FrontSide);
    // Positions and indices, because a depth pass reads no more than that.
    expect(proxy.geometry.getAttribute("position")).toBeDefined();
    expect(proxy.geometry.getAttribute("normal")).toBeUndefined();
    expect(proxy.geometry.getIndex()).not.toBeNull();

    // The three opaque groups keep drawing the main pass with the game's own materials and keep
    // receiving, and stop casting: the proxy carries the same vertices, so casting from both would
    // pay the bill twice.
    const covered = meshesIn(chunk).filter(
      (mesh) => mesh !== proxy && opaque.includes(mesh.material as MeshBasicMaterial),
    );
    expect(covered).toHaveLength(3);
    for (const mesh of covered) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
    }
    // A cutout's depth is its own alpha test, so it is not covered and keeps casting itself.
    const cut = meshesIn(chunk).filter((mesh) => mesh !== proxy && mesh.material === cutout);
    expect(cut).toHaveLength(1);
    expect(cut[0]?.castShadow).toBe(true);

    // And the proxy's vertices are the covered ones, in the chunk's own space.
    const coveredBox = new Box3().makeEmpty();
    for (const mesh of covered) {
      mesh.geometry.computeBoundingBox();
      coveredBox.union(mesh.geometry.boundingBox as Box3);
    }
    const proxyPosition = proxy.geometry.getAttribute("position");
    if (proxyPosition instanceof InterleavedBufferAttribute)
      throw new Error("Expected a plain position attribute on the proxy.");
    const proxyBox = new Box3().setFromBufferAttribute(proxyPosition);
    expect(proxyBox.equals(coveredBox)).toBe(true);
    expect(trianglesOf([proxy])).toEqual(trianglesOf(covered));

    // The proxy belongs to the chunk: evicting the cell releases it with the rest of the subtree.
    const disposed = vi.spyOn(proxy.geometry, "dispose");
    follow.position.x += 4 * CELL_SIZE;
    for (let pass = 0; pass < 40 && world.stats().residentKeys.length > 0; pass += 1) {
      world.update();
      await flush();
    }
    expect(world.stats().residentKeys).toEqual([]);
    expect(disposed).toHaveBeenCalled();
    world.dispose();
  });

  it("should leave every merged caster that is not an opaque group alpha-cut", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { cutout, group, opaque } = shadowChunkModel();
    const { chunk, world } = await attached(group, { shadows: { cast: true, receive: true } });
    const proxy = chunk.getObjectByName("world-chunk-shadow") as Mesh | undefined;
    if (proxy === undefined) throw new Error("Expected one shadow-only proxy on the chunk.");
    const meshes = meshesIn(chunk);

    // The whole chunk's shadow bill: the proxy is the only opaque caster, and the three opaque
    // groups are the meshes whose shadow it carries. Nothing else casts, so a level render pays
    // one draw per side per chunk and never one per material.
    const stillCasting = meshes.filter((mesh) => mesh.castShadow);
    expect(stillCasting).toHaveLength(2);
    expect(stillCasting).toContain(proxy);
    expect(stillCasting.filter((mesh) => mesh.material === cutout)).toHaveLength(1);
    // What the uncovered casters are, which is the question a wider level window cannot answer by
    // resizing: an alpha-tested group is its own cutout, and the map-walk's 603 unnamed chunk
    // casters are exactly these. A cutout is its texture, and a coarse level either drops it or
    // re-resolves a texture it cannot afford — which is what the engine's `shadowLodBias` answers,
    // by casting them into the finest level only.
    for (const mesh of stillCasting.filter((entry) => entry !== proxy))
      expect({
        alphaTest: (mesh.material as MeshBasicMaterial).alphaTest,
        transparent: (mesh.material as MeshBasicMaterial).transparent,
      }).toEqual({ alphaTest: 0.5, transparent: false });
    // The proxy itself is the world's one opaque caster: it carries the covered vertices' shadows
    // on the group material it borrowed, so it is alpha-free and on every level.
    expect((proxy.material as MeshBasicMaterial).alphaTest).toBe(0);
    expect((proxy.material as MeshBasicMaterial).transparent).toBe(false);
    // And every group the proxy covers has stopped casting, which is the whole of "does the proxy
    // cover all of them": one left casting would pay the bill twice for the same vertices.
    for (const mesh of meshes)
      if (mesh !== proxy && opaque.includes(mesh.material as MeshBasicMaterial))
        expect(mesh.castShadow).toBe(false);
    world.dispose();
  });
});
