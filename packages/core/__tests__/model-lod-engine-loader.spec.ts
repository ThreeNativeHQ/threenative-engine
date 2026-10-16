import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Scene,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// PRD-617: the Wasm engine's glTF loader (three-native/src/addons/gltf-loader-web.ts) used to host
// no plugin, so core skipped `TN_discrete_lod` and every model drew at full detail on that engine
// (action-rpg: 193 406 triangles against a 185 000 budget). This runs the real web loader and the
// real asset loader over an engine-shaped scene: the baked chain must reach the mesh, and a file
// the loader cannot read as a chain must refuse by name instead of dropping its LOD.
const engine = vi.hoisted(() => ({
  load: undefined as undefined | ((bytes: Uint8Array) => { scene: object; animations: object[] }),
}));
vi.mock("three", async (original) => ({
  ...(await original<object>()),
  __tnLoadGltf: (bytes: Uint8Array) => (engine.load as NonNullable<typeof engine.load>)(bytes),
}));
vi.mock(
  "three/addons/loaders/GLTFLoader.js",
  () => import("../../three-native/src/addons/gltf-loader-web.js"),
);

const { createAssetLoader } = await import("../src/assets.js");
const { baseGeometryOf, updateModelLods } = await import("../src/model-lod.js");

const QUADS = 32;
const LOD0_TRIANGLES = QUADS * 2;
const COARSE_TRIANGLES = QUADS / 2;
const VERTICES = (QUADS + 1) * 2;

function gridIndices(triangles: number): Uint32Array {
  const indices: number[] = [];
  for (let quad = 0; quad < triangles / 2; quad += 1) {
    const a = quad * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return new Uint32Array(indices);
}

function gridPositions(): Float32Array {
  const positions = new Float32Array(VERTICES * 3);
  for (let vertex = 0; vertex <= QUADS; vertex += 1) {
    positions.set([(vertex / QUADS) * 2 - 1, -1, 0, (vertex / QUADS) * 2 - 1, 1, 0], vertex * 6);
  }
  return positions;
}

function padTo4(bytes: Uint8Array, fill: number): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
  padded.set(bytes);
  return padded;
}

/** Two primitives on two nodes; only the second carries a chain, so the mapping is exercised. */
function cookedGlb(extension: object = {}): Uint8Array {
  const positions = gridPositions();
  const lod0 = gridIndices(LOD0_TRIANGLES);
  const level = gridIndices(COARSE_TRIANGLES);
  const bin = padTo4(
    new Uint8Array([
      ...new Uint8Array(positions.buffer),
      ...new Uint8Array(lod0.buffer),
      ...new Uint8Array(level.buffer),
    ]),
    0,
  );
  const chain = {
    absoluteErrors: [0.05],
    counts: [COARSE_TRIANGLES],
    errors: [0.05],
    indices: [4],
    lod0Triangles: LOD0_TRIANGLES,
    schemaVersion: 1,
    ...extension,
  };
  const json = {
    accessors: [
      { bufferView: 0, componentType: 5126, count: VERTICES, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: lod0.length, type: "SCALAR" },
      { bufferView: 0, componentType: 5126, count: VERTICES, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: lod0.length, type: "SCALAR" },
      { bufferView: 2, componentType: 5125, count: level.length, type: "SCALAR" },
    ],
    asset: { version: "2.0" },
    bufferViews: [
      { buffer: 0, byteLength: positions.byteLength, byteOffset: 0 },
      { buffer: 0, byteLength: lod0.byteLength, byteOffset: positions.byteLength },
      {
        buffer: 0,
        byteLength: level.byteLength,
        byteOffset: positions.byteLength + lod0.byteLength,
      },
    ],
    buffers: [{ byteLength: bin.length }],
    extensionsUsed: ["TN_discrete_lod"],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] },
      {
        primitives: [
          {
            attributes: { POSITION: 2 },
            extensions: { TN_discrete_lod: chain },
            indices: 3,
            mode: 4,
          },
        ],
      },
    ],
    nodes: [{ children: [1], mesh: 0 }, { mesh: 1 }],
    scene: 0,
    scenes: [{ nodes: [0] }],
  };
  const text = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, bin.length, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}

function engineMesh(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(gridPositions(), 3));
  geometry.setIndex(new BufferAttribute(gridIndices(LOD0_TRIANGLES), 1));
  return new Mesh(geometry);
}

/** The engine glTF loader's shape: a node is its mesh, and a child node hangs under its parent. */
function engineScene(meshes = 2): { scene: Group; meshes: Mesh[] } {
  const made = Array.from({ length: meshes }, engineMesh);
  const scene = new Group();
  const [first, ...rest] = made;
  if (first !== undefined) scene.add(first);
  for (const mesh of rest) first?.add(mesh);
  return { meshes: made, scene };
}

function stubFetch(glb: Uint8Array): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("assets.manifest.json")
      ? { headers: { get: () => null }, ok: false, status: 404 }
      : {
          arrayBuffer: async () =>
            glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
          ok: true,
          status: 200,
        },
  );
}

async function load(
  glb: Uint8Array,
  scene: Group,
): Promise<{ scene: Object3D; animations: object[] }> {
  engine.load = () => ({ animations: [], scene });
  stubFetch(glb);
  return createAssetLoader({ basePath: "" }).model("ship.glb");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a TN_discrete_lod model on the Wasm engine's glTF loader", () => {
  it("gives the mesh its baked chain and the same switch distance as stock three", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { meshes, scene } = engineScene();
    await load(cookedGlb(), scene);
    const [plain, chained] = meshes as [Mesh, Mesh];
    expect(baseGeometryOf(chained).index?.count).toBe(LOD0_TRIANGLES * 3);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    const root = new Scene();
    root.add(scene);
    updateModelLods(root, camera, 1080);
    expect(chained.geometry.index?.count).toBe(COARSE_TRIANGLES * 3);
    expect(plain.geometry.index?.count).toBe(LOD0_TRIANGLES * 3);
    expect(chained.geometry.getAttribute("position")).toBe(
      baseGeometryOf(chained).getAttribute("position"),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("TN_DISCRETE_LOD_UNAVAILABLE"));
  });

  it("refuses a chain it cannot read, by name, instead of dropping the LOD", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(load(cookedGlb({ schemaVersion: 2 }), engineScene().scene)).rejects.toThrow(
      "TN_DISCRETE_LOD_INVALID",
    );
    await expect(load(cookedGlb({ indices: [99] }), engineScene().scene)).rejects.toThrow(
      "TN_DISCRETE_LOD_INVALID",
    );
  });

  it("refuses a scene whose meshes do not match the file's primitives", async () => {
    await expect(load(cookedGlb(), engineScene(1).scene)).rejects.toThrow(
      "TN_WASM_GLTF_LOD_MISMATCH",
    );
  });
});
