import {
  type Box3,
  type BufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  type Sphere,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";
import { TN_DISCRETE_LOD, baseGeometryOf, lodChainOf, updateModelLods } from "../src/model-lod.js";

// PRD-377 §5/§6 — the real front door. A GLB carrying `TN_discrete_lod` is loaded through
// `createAssetLoader` (which fetches the bytes, decides the decoder set from `extensionsUsed`,
// registers the reader, widens quantized positions and attaches the chain all by itself), and the
// engine's per-frame selection then swaps the mesh to the cheapest level the camera allows.

function padTo4(buffer: Buffer, fill: number): Buffer {
  const remainder = buffer.length % 4;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

const QUADS = 32;
const LOD0_TRIANGLES = QUADS * 2;
const COARSE_TRIANGLES = QUADS / 2;
// The two instanced placements: index 0 sits near the camera, index 1 far from it.
const NEAR_Z = 95;
const FAR_Z = 0;

/** A grid strip of `QUADS` quads: `2 * QUADS` LOD0 triangles, half of them in the derived level. */
function gridIndices(triangles: number): number[] {
  const indices: number[] = [];
  for (let quad = 0; quad < triangles / 2; quad += 1) {
    const a = quad * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return indices;
}

/**
 * A minimal valid GLB: a dense grid with LOD0 indices, a coarser index-only level, and the
 * `TN_discrete_lod` extension on the primitive. Written by hand so the loader — not the asset
 * package the pipeline owns — is what this test exercises.
 */
function cookedGlb(
  options: {
    copies?: boolean;
    instances?: boolean;
    mixedParts?: boolean;
    alternateScene?: boolean;
  } = {},
): Buffer {
  const lod0Vertices = (QUADS + 1) * 2;
  let positions = new Float32Array(lod0Vertices * 3);
  for (let vertex = 0; vertex <= QUADS; vertex += 1) {
    positions[vertex * 6] = (vertex / QUADS) * 2 - 1;
    positions[vertex * 6 + 1] = -1;
    positions[vertex * 6 + 2] = 0;
    positions[vertex * 6 + 3] = (vertex / QUADS) * 2 - 1;
    positions[vertex * 6 + 4] = 1;
    positions[vertex * 6 + 5] = 0;
  }
  const baseIndices = new Uint32Array(gridIndices(LOD0_TRIANGLES));
  let levelIndices = new Uint32Array(gridIndices(COARSE_TRIANGLES));
  if (options.copies === true) {
    // The card cook's shape (PRD-541): the level draws copies of its vertices, scaled and appended
    // after LOD0's, which LOD0's own indices never reach.
    const source = [...new Set(levelIndices)];
    const grown = new Float32Array((lod0Vertices + source.length) * 3);
    grown.set(positions);
    for (const [copy, vertex] of source.entries())
      for (let axis = 0; axis < 3; axis += 1)
        grown[(lod0Vertices + copy) * 3 + axis] = (positions[vertex * 3 + axis] as number) * 2;
    positions = grown;
    levelIndices = levelIndices.map((vertex) => lod0Vertices + source.indexOf(vertex));
  }
  // Two placements: index 0 near the camera, index 1 far from it. Their z is the fixture's identity.
  const instanced = options.instances === true;
  const translations = new Float32Array([0, 0, NEAR_Z, 0, 0, FAR_Z]);
  const binPadded = padTo4(
    Buffer.concat([
      Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
      Buffer.from(baseIndices.buffer, baseIndices.byteOffset, baseIndices.byteLength),
      Buffer.from(levelIndices.buffer, levelIndices.byteOffset, levelIndices.byteLength),
      ...(instanced
        ? [Buffer.from(translations.buffer, translations.byteOffset, translations.byteLength)]
        : []),
    ]),
    0,
  );
  const positionBytes = positions.byteLength;
  const baseBytes = baseIndices.byteLength;
  const json = {
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        max: options.copies === true ? [2, 2, 0] : [1, 1, 0],
        min: options.copies === true ? [-2, -2, 0] : [-1, -1, 0],
        type: "VEC3",
      },
      { bufferView: 1, componentType: 5125, count: baseIndices.length, type: "SCALAR" },
      { bufferView: 2, componentType: 5125, count: levelIndices.length, type: "SCALAR" },
      ...(instanced ? [{ bufferView: 3, componentType: 5126, count: 2, type: "VEC3" }] : []),
    ],
    asset: { version: "2.0" },
    bufferViews: [
      { buffer: 0, byteLength: positionBytes, byteOffset: 0, target: 34962 },
      { buffer: 0, byteLength: baseBytes, byteOffset: positionBytes, target: 34963 },
      {
        buffer: 0,
        byteLength: levelIndices.byteLength,
        byteOffset: positionBytes + baseBytes,
        target: 34963,
      },
      ...(instanced
        ? [
            {
              buffer: 0,
              byteLength: translations.byteLength,
              byteOffset: positionBytes + baseBytes + levelIndices.byteLength,
            },
          ]
        : []),
    ],
    buffers: [{ byteLength: binPadded.length }],
    extensionsUsed: instanced ? [TN_DISCRETE_LOD, "EXT_mesh_gpu_instancing"] : [TN_DISCRETE_LOD],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            extensions: {
              [TN_DISCRETE_LOD]: {
                absoluteErrors: [0.05],
                counts: [COARSE_TRIANGLES],
                errors: [0.05],
                indices: [2],
                lod0Triangles: LOD0_TRIANGLES,
                schemaVersion: 1,
                sharedVertexBuffers: true,
                strategy: "discrete",
              },
            } as Record<string, unknown>,
            indices: 1,
            mode: 4,
          },
        ],
      },
    ],
    nodes: (instanced
      ? [{ extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 3 } } }, mesh: 0 }]
      : [{ mesh: 0 }]) as Array<{ mesh: number; extensions?: Record<string, unknown> }>,
    scene: 0,
    scenes: [{ nodes: [0] }],
  };
  const primitives = json.meshes[0]?.primitives;
  if (options.alternateScene === true) {
    json.nodes.push({ mesh: 0 });
    json.scenes.push({ nodes: [1] });
  }
  if (options.mixedParts === true && primitives?.[0] !== undefined)
    primitives.push({ ...primitives[0], extensions: {} });
  const jsonPadded = padTo4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  const binHeader = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  binPadded.copy(out, binHeader + 8);
  return out;
}

function stubFetch(glb: Buffer, manifest?: unknown): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("assets.manifest.json")) {
      if (manifest === undefined) {
        return { headers: { get: () => null }, ok: false, status: 404 };
      }
      return {
        headers: { get: () => "application/json" },
        json: async () => manifest,
        ok: true,
        status: 200,
      };
    }
    return {
      arrayBuffer: async () => glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
      ok: true,
      status: 200,
    };
  });
}

function firstMesh(root: Object3D): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (found === undefined && object instanceof Mesh) found = object;
  });
  if (found === undefined) throw new Error("the loaded scene holds no mesh");
  return found;
}

function firstInstancedMesh(root: Object3D): InstancedMesh {
  let found: InstancedMesh | undefined;
  root.traverse((object) => {
    if (found === undefined && object instanceof InstancedMesh) found = object;
  });
  if (found === undefined) throw new Error("the loaded scene holds no instanced mesh");
  return found;
}

/** The geometry each placement draws this frame, keyed by its z translation (the fixture's identity). */
function rungsByZ(mesh: InstancedMesh): Map<number, BufferGeometry> {
  const rungs = new Map<number, BufferGeometry>();
  const matrix = new Matrix4();
  const partitions = mesh.children.filter(
    (child): child is InstancedMesh => child instanceof InstancedMesh,
  );
  if (partitions.length === 0) {
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix);
      rungs.set(matrix.elements[14] as number, mesh.geometry);
    }
    return rungs;
  }
  for (const partition of partitions) {
    for (let index = 0; index < partition.count; index += 1) {
      partition.getMatrixAt(index, matrix);
      rungs.set(matrix.elements[14] as number, partition.geometry);
    }
  }
  return rungs;
}

/** A manifest entry carrying the runtime budget a cook resolves, as `assets.manifest.json` holds it. */
function manifestFor(runtime: { hysteresis: number; maxPixelError: number }): unknown {
  return {
    entries: {
      "forest.glb": {
        kind: "model",
        lod: { generated: 1, preset: "quality", runtime },
        output: "forest.abc123.glb",
      },
    },
    version: 1,
  };
}

/** Loads the instanced fixture through the real loader and runs one selection from a far camera. */
async function selectInstanced(manifest?: unknown): Promise<{
  base: BufferGeometry;
  drawn: Map<number, BufferGeometry>;
  instanced: InstancedMesh;
  scene: Scene;
}> {
  stubFetch(cookedGlb({ instances: true }), manifest);
  const loader = createAssetLoader({ basePath: "" });
  const value = await loader.model<{ scene: Object3D }>("forest.glb");
  const instanced = firstInstancedMesh(value.scene);
  const base = baseGeometryOf(instanced);
  const scene = new Scene();
  scene.add(value.scene);
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld(true);
  updateModelLods(scene, camera, 1080);
  return { base, drawn: rungsByZ(instanced), instanced, scene };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAssetLoader with a cooked TN_discrete_lod model", () => {
  it("attaches instanced partitions when the cooked model has alternate LOD scenes", async () => {
    stubFetch(cookedGlb({ instances: true, alternateScene: true }));
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("forest.glb");
    const mesh = firstInstancedMesh(value.scene);
    expect(mesh.children.filter((child) => child instanceof InstancedMesh)).toHaveLength(2);
    loader.clear();
  });
  it("attaches the chain and selects by camera through the normal load path", async () => {
    stubFetch(cookedGlb());
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("hull.glb");
    const mesh = firstMesh(value.scene);
    const base = baseGeometryOf(mesh);
    expect(base.index?.count).toBe(LOD0_TRIANGLES * 3);
    // LOD0 is what the mesh draws before any selection.
    expect(mesh.geometry.index?.count).toBe(LOD0_TRIANGLES * 3);

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    const triangles = updateModelLods(scene, camera, 1080);
    expect(triangles).toBe(COARSE_TRIANGLES);
    expect(mesh.geometry.index?.count).toBe(COARSE_TRIANGLES * 3);
    // The far route submits at least half the triangles fewer than LOD0 (PRD-377 §8).
    expect(triangles).toBeLessThanOrEqual(LOD0_TRIANGLES / 2);
    // The derived level shares the authored vertices, so no buffer was duplicated.
    expect(mesh.geometry.getAttribute("position")).toBe(base.getAttribute("position"));
    // LOD0 is still recoverable for picking.
    expect(baseGeometryOf(mesh)).toBe(base);
  }, 120_000);

  it("draws a level whose indices reach vertex copies appended after LOD0's", async () => {
    stubFetch(cookedGlb({ copies: true }));
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("cards.glb");
    const mesh = firstMesh(value.scene);
    const lod0Vertices = (QUADS + 1) * 2;
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    expect(updateModelLods(scene, camera, 1080)).toBe(COARSE_TRIANGLES);
    const level = Array.from(mesh.geometry.index?.array ?? []);
    expect(level.length).toBe(COARSE_TRIANGLES * 3);
    // Every corner the level draws is a copy, and the copy is in the shared position buffer.
    for (const vertex of level) expect(vertex).toBeGreaterThanOrEqual(lod0Vertices);
    const position = mesh.geometry.getAttribute("position");
    expect(position).toBe(baseGeometryOf(mesh).getAttribute("position"));
    expect(Math.max(...level)).toBeLessThan(position.count);
    // LOD0 never reaches a copy.
    const lod0 = Array.from(baseGeometryOf(mesh).index?.array ?? []);
    expect(Math.max(...lod0)).toBeLessThan(lod0Vertices);
  }, 120_000);

  it("shares the base's bounds with every level, so bounds padded after load reach them", async () => {
    // A vertex-displacement material makes a game pad the base's bounds after the model loads, so
    // the renderer does not cull the object the shader pushed out of shape. Every level shares the
    // base's vertex attributes, so its bounds are the base's bounds: a level that kept a copy is
    // culled early against bounds frozen at bake time, and the mesh vanishes at distance.
    stubFetch(cookedGlb());
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("hull.glb");
    const mesh = firstMesh(value.scene);
    const base = baseGeometryOf(mesh);
    base.computeBoundingSphere();
    base.computeBoundingBox();
    const sphere = base.boundingSphere as Sphere;
    const box = base.boundingBox as Box3;
    sphere.radius *= 4;
    box.expandByScalar(5);

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    expect(updateModelLods(scene, camera, 1080)).toBe(COARSE_TRIANGLES);

    // The level that just went onto the mesh reports the padded bounds, by identity: the base's own
    // objects, so a later pad reaches this level and every sibling level with it.
    const level = mesh.geometry;
    expect(level).not.toBe(base);
    expect(level.boundingSphere).toBe(sphere);
    expect(level.boundingBox).toBe(box);
    // And the padding was a real one, so the assertions above are not comparing two empty values.
    expect(sphere.radius).toBeGreaterThan(1);
    expect(box.max.y).toBeGreaterThan(1);
  }, 120_000);

  it("refines to full detail when the camera is close", async () => {
    stubFetch(cookedGlb());
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("hull.glb");
    const mesh = firstMesh(value.scene);
    // A camera against the object returns the base geometry and nothing a selection could coarsen.
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 3);
    camera.updateMatrixWorld(true);
    updateModelLods(scene, camera, 1080);
    expect(mesh.geometry.index?.count).toBe(LOD0_TRIANGLES * 3);
  }, 120_000);

  it("honours the runtime budget the manifest resolved", async () => {
    stubFetch(cookedGlb(), {
      entries: {
        "hull.glb": {
          kind: "model",
          lod: {
            generated: 1,
            preset: "quality",
            runtime: { hysteresis: 0.15, maxPixelError: 0.1 },
          },
          output: "hull.abc123.glb",
        },
      },
      version: 1,
    });
    const loader = createAssetLoader({ basePath: "" });
    const value = await loader.model<{ scene: Object3D }>("hull.glb");
    const mesh = firstMesh(value.scene);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    // 0.05 * ~9.5 = ~0.47 px: inside the default 1-pixel budget, outside the manifest's 0.1.
    expect(updateModelLods(scene, camera, 1080)).toBe(LOD0_TRIANGLES);
    expect(mesh.geometry.index?.count).toBe(LOD0_TRIANGLES * 3);
  }, 120_000);

  it("gives each imported instance the rung its own distance selects", async () => {
    const { base, drawn } = await selectInstanced();
    // The near placement keeps LOD0 while the far one takes the coarse level: two placements, two rungs.
    expect(drawn.size).toBe(2);
    expect(drawn.get(NEAR_Z)).toBe(base);
    expect(drawn.get(FAR_Z)).not.toBe(base);
    expect(drawn.get(FAR_Z)?.index?.count).toBe(COARSE_TRIANGLES * 3);
  }, 120_000);

  it("keeps the authored instance slots, count, ray hits and geometry ownership", async () => {
    const { base, instanced, scene } = await selectInstanced();
    const levels = lodChainOf(base)?.levels ?? [];
    expect(levels.length).toBe(2);
    expect(instanced.count).toBe(2);
    const matrix = new Matrix4();
    instanced.getMatrixAt(0, matrix);
    expect(matrix.elements[14]).toBe(NEAR_Z);
    instanced.getMatrixAt(1, matrix);
    expect(matrix.elements[14]).toBe(FAR_Z);
    // A ray down the z axis crosses both placements; the hits report their public ids, nearest first.
    scene.updateMatrixWorld(true);
    const raycaster = new Raycaster(new Vector3(0.23, 0, 200), new Vector3(0, 0, -1));
    expect(raycaster.intersectObject(instanced).map((hit) => hit.instanceId)).toEqual([0, 1]);
    // Disposal releases the partitions; the chain's geometries stay owned by the loader.
    const disposals = levels.map((geometry) => vi.spyOn(geometry, "dispose"));
    instanced.dispatchEvent({ type: "dispose" });
    for (const spy of disposals) expect(spy).not.toHaveBeenCalled();
    expect(instanced.geometry).toBe(base);
    expect(instanced.children.some((child) => child instanceof InstancedMesh)).toBe(false);
  }, 120_000);

  it("honours the manifest's pixel budget for each imported instance", async () => {
    // A 0.1 px budget refines the far placement, which the default 4 px budget coarsens.
    const { base, drawn } = await selectInstanced(
      manifestFor({ hysteresis: 0.15, maxPixelError: 0.1 }),
    );
    expect(drawn.get(NEAR_Z)).toBe(base);
    expect(drawn.get(FAR_Z)).toBe(base);
  }, 120_000);

  it("honours the manifest's hysteresis for each imported instance", async () => {
    // Coarsening needs the error under (1 - hysteresis) * budget: 10% of 1 px keeps the far placement at LOD0.
    const { base, drawn } = await selectInstanced(
      manifestFor({ hysteresis: 0.9, maxPixelError: 1 }),
    );
    expect(drawn.get(FAR_Z)).toBe(base);
  }, 120_000);

  it("recovers each imported primitive's own extension in a multi-part instanced node", async () => {
    stubFetch(cookedGlb({ instances: true, mixedParts: true }));
    const value = await createAssetLoader({ basePath: "" }).model<{ scene: Object3D }>(
      "forest.glb",
    );
    const parts: InstancedMesh[] = [];
    value.scene.traverse((object) => {
      if (object instanceof InstancedMesh && !(object.parent instanceof InstancedMesh))
        parts.push(object);
    });
    expect(parts).toHaveLength(2);
    const scene = new Scene();
    scene.add(value.scene);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.z = 100;
    camera.updateMatrixWorld(true);
    updateModelLods(scene, camera, 1080);
    const chained = parts[0] as InstancedMesh;
    const unchained = parts[1] as InstancedMesh;
    expect(rungsByZ(chained).get(FAR_Z)?.index?.count).toBe(COARSE_TRIANGLES * 3);
    expect(unchained.children).toHaveLength(0);
    expect(rungsByZ(unchained).get(FAR_Z)?.index?.count).toBe(LOD0_TRIANGLES * 3);
  }, 120_000);
});
