import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO, type Primitive, type Scene } from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshGPUInstancing,
  KHRMaterialsTransmission,
  KHRNodeVisibility,
} from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { Matrix3, Matrix4, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { compileAssets } from "../src/index.js";
import {
  applyProxiesToWorld,
  cookWorldProxies,
  formatWorldHlod,
  readWorldPackage,
} from "../src/world/proxy.js";

/**
 * PRD-473 AC-4 (asset-cook half): the cook merges each authored cell's chunks into one proxy GLB
 * with world-space geometry and one draw per material group, writes it beside the world package,
 * and names it on the cell as an optional `proxy` record. No authoring tree is mutated and the
 * authored chunks are retained.
 */

const NONE = { audio: "none", models: "none", textures: "none" } as const;

/** A triangle at the origin, translated by the node, under a named material. */
function part(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  translation: readonly [number, number, number],
  material: ReturnType<Document["createMaterial"]>,
): ReturnType<Document["createNode"]> {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const primitive = document
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      "POSITION",
      document.createAccessor().setArray(positions).setType("VEC3").setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document.createAccessor().setArray(normals).setType("VEC3").setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      document.createAccessor().setArray(uvs).setType("VEC2").setBuffer(buffer),
    )
    .setIndices(document.createAccessor().setArray(indices).setType("SCALAR").setBuffer(buffer));
  const mesh = document.createMesh("part").addPrimitive(primitive);
  return document
    .createNode("part")
    .setMesh(mesh)
    .setTranslation([...translation]);
}

/** An `n`×`n` grid in the XZ plane: enough opaque triangles for the simplifier to reduce. */
function gridPart(
  document: Document,
  scene: ReturnType<Document["createScene"]>,
  buffer: ReturnType<Document["createBuffer"]>,
  translation: readonly [number, number, number],
  material: ReturnType<Document["createMaterial"]>,
  n: number,
): number {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= n; row += 1) {
    for (let column = 0; column <= n; column += 1) {
      // Curved, so a collapse has measurable geometric error rather than a free flat-grid one.
      positions.push(
        column / n,
        0.4 * Math.sin((column / n) * Math.PI) * Math.cos((row / n) * Math.PI),
        row / n,
      );
      normals.push(0, 1, 0);
      uvs.push(column / n, row / n);
    }
  }
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      const a = row * (n + 1) + column;
      indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  const primitive = document
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setArray(new Float32Array(positions))
        .setType("VEC3")
        .setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor()
        .setArray(new Float32Array(normals))
        .setType("VEC3")
        .setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      document.createAccessor().setArray(new Float32Array(uvs)).setType("VEC2").setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setArray(new Uint16Array(indices))
        .setType("SCALAR")
        .setBuffer(buffer),
    );
  const mesh = document.createMesh("grid").addPrimitive(primitive);
  scene.addChild(
    document
      .createNode("grid")
      .setMesh(mesh)
      .setTranslation([...translation]),
  );
  return indices.length / 3;
}

/** A chunk of one dense opaque grid and one dense MASK card, both at the same place. */
async function denseChunk(n: number): Promise<{ buffer: Buffer; opaqueTriangles: number }> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const opaque = gridPart(document, scene, buffer, [0, 0, 0], document.createMaterial("rock"), n);
  gridPart(
    document,
    scene,
    buffer,
    [0, 0, 0],
    document.createMaterial("needles").setAlphaMode("MASK"),
    n,
  );
  return { buffer: Buffer.from(await new NodeIO().writeBinary(document)), opaqueTriangles: opaque };
}

interface IChunkPart {
  readonly alphaMode?: "BLEND" | "MASK" | "OPAQUE";
  readonly material: string;
  readonly translation: readonly [number, number, number];
}

async function chunkGlb(parts: readonly IChunkPart[]): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  for (const entry of parts) {
    const material = document.createMaterial(entry.material);
    if (entry.alphaMode !== undefined) material.setAlphaMode(entry.alphaMode);
    scene.addChild(part(document, buffer, entry.translation, material));
  }
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/**
 * One triangle in the XZ plane with its authored front face toward +Y, referenced by two nodes:
 * the second translated, mirrored in X and nonuniformly scaled in Z.
 */
async function sharedMeshChunk(): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const positions = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const primitive = document
    .createPrimitive()
    .setMaterial(document.createMaterial("rock"))
    .setAttribute(
      "POSITION",
      document.createAccessor().setArray(positions).setType("VEC3").setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document.createAccessor().setArray(normals).setType("VEC3").setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setArray(new Uint16Array([0, 1, 2]))
        .setType("SCALAR")
        .setBuffer(buffer),
    );
  const mesh = document.createMesh("shared").addPrimitive(primitive);
  scene.addChild(document.createNode("a").setMesh(mesh).setTranslation([0, 0, 0]));
  scene.addChild(
    document.createNode("b").setMesh(mesh).setTranslation([10, 0, 0]).setScale([-2, 1, 3]),
  );
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/**
 * Two normally visible triangles sharing one material; the second is named with Godot's collider
 * suffix and carries an authored `collider` extra.
 *
 * The engine has no runtime convention that hides a name-matched collider: `WorldCells` loads a
 * hand-placed chunk GLB through `assets.model` and renders every mesh it contains
 * (`world-cells.ts` `#startChunkLoad` -> `#model` -> `loadModelWith`, then `mergeChunk`, which
 * filters only on lod chains and morph targets), and the only reader of the `-col`/`-convcol`
 * vocabulary is the advisory asset health report (`health.ts` `marksCollider`), which hides
 * nothing. Physics is a game-owned predicate in `buildStaticColliders`, not the name. Both
 * triangles are visible, so both belong in the proxy.
 */
async function colliderChunk(): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const material = document.createMaterial("rock");
  const visible = part(document, buffer, [0, 0, 0], material);
  visible.setExtras({ entity: "rock-1" });
  scene.addChild(visible);
  const collider = part(document, buffer, [5, 0, 0], material);
  collider.setName("arena-convcol").setExtras({ collider: "convexParts" });
  scene.addChild(collider);
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/** One triangle Mesh drawn by `EXT_mesh_gpu_instancing` at two translations. */
async function instancedChunk(): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const mesh = document.createMesh("instanced").addPrimitive(
    document
      .createPrimitive()
      .setMaterial(document.createMaterial("rock"))
      .setAttribute(
        "POSITION",
        document
          .createAccessor()
          .setArray(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]))
          .setType("VEC3")
          .setBuffer(buffer),
      )
      .setAttribute(
        "NORMAL",
        document
          .createAccessor()
          .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]))
          .setType("VEC3")
          .setBuffer(buffer),
      )
      .setIndices(
        document
          .createAccessor()
          .setArray(new Uint16Array([0, 1, 2]))
          .setType("SCALAR")
          .setBuffer(buffer),
      ),
  );
  const batch = document
    .createExtension(EXTMeshGPUInstancing)
    .createInstancedMesh()
    .setAttribute(
      "TRANSLATION",
      document
        .createAccessor()
        .setArray(new Float32Array([0, 0, 0, 4, 0, 0]))
        .setType("VEC3")
        .setBuffer(buffer),
    );
  scene.addChild(
    document.createNode("batch").setMesh(mesh).setExtension("EXT_mesh_gpu_instancing", batch),
  );
  return Buffer.from(
    await new NodeIO().registerExtensions([...ALL_EXTENSIONS]).writeBinary(document),
  );
}

/** A chunk whose one node is explicitly hidden by `KHR_node_visibility`. */
async function invisibleChunk(): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const node = part(document, buffer, [0, 0, 0], document.createMaterial("rock"));
  const visibility = document.createExtension(KHRNodeVisibility).createVisibility();
  visibility.setVisible(false);
  node.setExtension("KHR_node_visibility", visibility);
  scene.addChild(node);
  return Buffer.from(
    await new NodeIO().registerExtensions([...ALL_EXTENSIONS]).writeBinary(document),
  );
}

/** Every vertex normal of a proxy, lifted into world space, as its Y component. */
function worldNormalY(document: Document): number[] {
  const result: number[] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const normalMatrix = new Matrix3().getNormalMatrix(
      new Matrix4().fromArray(node.getWorldMatrix() as number[]),
    );
    for (const primitive of mesh.listPrimitives()) {
      const normal = primitive.getAttribute("NORMAL");
      if (normal === null) continue;
      const element: number[] = [0, 0, 0];
      for (let vertex = 0; vertex < normal.getCount(); vertex += 1) {
        normal.getElement(vertex, element);
        result.push(
          new Vector3(element[0], element[1], element[2]).applyMatrix3(normalMatrix).normalize().y,
        );
      }
    }
  }
  return result;
}

/**
 * Every triangle's winding normal, in the primitive's own vertex space, should agree with its
 * vertex normals. A mirrored transform that baked vertices without reversing the index order
 * flips the winding normal while leaving the stored normals correct, so the two disagree — the
 * regression the shared/mirrored chunk exists to catch.
 */
function windingAgreesWithNormals(document: Document): boolean {
  const element: number[] = [0, 0, 0];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const normal = primitive.getAttribute("NORMAL");
      const indices = primitive.getIndices();
      if (position === null || normal === null || indices === null) continue;
      for (let triangle = 0; triangle + 2 < indices.getCount(); triangle += 3) {
        const corners = [0, 1, 2].map((offset) => {
          position.getElement(indices.getScalar(triangle + offset), element);
          return [element[0], element[1], element[2]] as const;
        });
        const [p0, p1, p2] = corners as [
          readonly [number, number, number],
          readonly [number, number, number],
          readonly [number, number, number],
        ];
        const geometric = new Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).cross(
          new Vector3(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]),
        );
        const vertexNormal = new Vector3();
        for (let offset = 0; offset < 3; offset += 1) {
          normal.getElement(indices.getScalar(triangle + offset), element);
          vertexNormal.add(new Vector3(element[0], element[1], element[2]));
        }
        if (geometric.lengthSq() === 0 || vertexNormal.lengthSq() === 0) continue;
        if (geometric.normalize().dot(vertexNormal.normalize()) < 0.9) return false;
      }
    }
  }
  return true;
}

/** A points-mode chunk: visible geometry this cook refuses to reproduce. */
async function pointsChunk(): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
  const primitive = document
    .createPrimitive()
    .setMode(0)
    .setAttribute(
      "POSITION",
      document.createAccessor().setArray(positions).setType("VEC3").setBuffer(buffer),
    );
  scene.addChild(
    document.createNode("points").setMesh(document.createMesh("points").addPrimitive(primitive)),
  );
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/**
 * A chunk carrying a non-finite vertex or a non-finite node transform. Either would flow through
 * `getBounds` into the published world error, which `JSON.stringify` silently turns into `null`.
 */
async function malformedChunk(kind: "transform" | "vertex"): Promise<Buffer> {
  const document = new Document();
  const scene = document.createScene("Scene");
  const buffer = document.createBuffer();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, kind === "vertex" ? Number.NaN : 0, 0, 1]);
  const primitive = document
    .createPrimitive()
    .setMaterial(document.createMaterial("rock"))
    .setAttribute(
      "POSITION",
      document.createAccessor().setArray(positions).setType("VEC3").setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setArray(new Uint16Array([0, 1, 2]))
        .setType("SCALAR")
        .setBuffer(buffer),
    );
  const node = document
    .createNode("rock")
    .setMesh(document.createMesh("rock").addPrimitive(primitive));
  if (kind === "transform") node.setTranslation([Number.POSITIVE_INFINITY, 0, 0]);
  scene.addChild(node);
  return Buffer.from(await new NodeIO().writeBinary(document));
}

function worldJson(cells: readonly { chunks: readonly string[]; x: number; z: number }[]): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        assets: {},
        cellSize: 64,
        cells: cells.map((cell) => ({ chunks: [...cell.chunks], runs: [], x: cell.x, z: cell.z })),
        extent: { minX: -128, minZ: -128, sizeX: 256, sizeZ: 256 },
        placements: "placements.bin",
        terrain: {
          columns: 129,
          heightMax: 4.86,
          heightMin: -4.86,
          heightmap: "terrain/heightmap.u16",
          rows: 129,
          spacing: 2,
        },
        version: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

interface IManifest {
  entries: Record<string, { output: string }>;
}

async function readManifest(root: string): Promise<IManifest> {
  return JSON.parse(
    await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
  ) as IManifest;
}

async function outputBytes(root: string, manifest: IManifest, logical: string): Promise<Buffer> {
  const entry = manifest.entries[logical];
  if (entry === undefined) throw new Error(`no manifest entry for ${logical}`);
  return readFile(path.join(root, "public", entry.output));
}

function logLines(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.flat().join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("world cell HLOD proxies", () => {
  it("should merge translated chunks into one material-grouped proxy in world space", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    const chunkA = await chunkGlb([{ material: "bark", translation: [100, 0, 0] }]);
    const chunkB = await chunkGlb([
      { material: "rock", translation: [-50, 0, 20] },
      { alphaMode: "MASK", material: "needles", translation: [-50, 0, 20] },
    ]);
    const sourceWorld = worldJson([{ chunks: ["a.glb", "b.glb"], x: 0, z: 0 }]);
    await writeFile(path.join(root, "assets", "world", "a.glb"), chunkA);
    await writeFile(path.join(root, "assets", "world", "b.glb"), chunkB);
    await writeFile(path.join(root, "assets", "world", "world.json"), sourceWorld);

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);

    const shippedWorld = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as {
      cells: {
        proxy?: { glb: string; error: number; materialGroups: number; triangles: number };
      }[];
    };
    const proxy = shippedWorld.cells[0]?.proxy;
    expect(proxy).toBeDefined();
    expect(proxy?.glb).toBe("world.cell_0_0.proxy.glb");
    expect(proxy?.triangles).toBeGreaterThan(0);
    expect(proxy?.materialGroups).toBeGreaterThanOrEqual(2);
    expect(proxy?.error).toBeGreaterThanOrEqual(0);
    // The published world error is a finite bound; `JSON.stringify` would null a NaN.
    expect(Number.isFinite(proxy?.error)).toBe(true);

    const proxyBuffer = await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb");
    const proxyDocument = await new NodeIO().readBinary(new Uint8Array(proxyBuffer));
    const scene = proxyDocument.getRoot().listScenes()[0];
    expect(scene).toBeDefined();
    const bounds = getBounds(scene as NonNullable<typeof scene>);
    // Both authored node translations survive as world-space geometry; the proxy is not
    // double-offset by the cell.
    expect(bounds.min[0]).toBeLessThanOrEqual(-50);
    expect(bounds.max[0]).toBeGreaterThanOrEqual(101);
    // The alpha-cutout card survives as a MASK material rather than being dropped or blended.
    expect(
      proxyDocument
        .getRoot()
        .listMaterials()
        .some((material) => material.getAlphaMode() === "MASK"),
    ).toBe(true);
    expect(
      proxyDocument
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives()),
    ).toHaveLength(proxy?.materialGroups ?? 0);

    expect(logLines(log)).toContain("TN_WORLD_HLOD world=world/world.json");
    // The authored chunks and the authored world JSON are byte-identical after the cook.
    expect(await readFile(path.join(root, "assets", "world", "a.glb"))).toEqual(chunkA);
    expect(await readFile(path.join(root, "assets", "world", "b.glb"))).toEqual(chunkB);
    expect(await readFile(path.join(root, "assets", "world", "world.json"))).toEqual(sourceWorld);
  });

  it("should reduce opaque geometry, keep the cutout card intact and report its error", async () => {
    const root = await makeTempDir("threenative-hlod-simplify-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    const { buffer, opaqueTriangles } = await denseChunk(16);
    await writeFile(path.join(root, "assets", "world", "a.glb"), buffer);
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: { error: number } }[] };
    expect(shipped.cells[0]?.proxy?.error).toBeGreaterThan(0);

    const document = await new NodeIO().readBinary(
      new Uint8Array(await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb")),
    );
    const trianglesOf = (primitive: Primitive): number =>
      Math.floor(
        (primitive.getIndices()?.getCount() ??
          primitive.getAttribute("POSITION")?.getCount() ??
          0) / 3,
      );
    const primitives = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives());
    const opaque = primitives.find((prim) => prim.getMaterial()?.getAlphaMode() !== "MASK");
    const card = primitives.find((prim) => prim.getMaterial()?.getAlphaMode() === "MASK");
    expect(opaque).toBeDefined();
    expect(card).toBeDefined();
    expect(trianglesOf(opaque as NonNullable<typeof opaque>)).toBeLessThan(opaqueTriangles);
    expect(trianglesOf(card as NonNullable<typeof card>)).toBe(opaqueTriangles);
  });

  it("should cook the generated proxy through the default model pass", async () => {
    const root = await makeTempDir("threenative-hlod-modelpass-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(
      path.join(root, "assets", "world", "a.glb"),
      await chunkGlb([{ material: "bark", translation: [10, 0, 0] }]),
    );
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );
    // Models default on: the proxy is an ordinary model input, so the model pass must accept it.
    await compileAssets({ config: { audio: "none", textures: "none" }, cwd: root });
    const manifest = await readManifest(root);
    expect(manifest.entries["world/world.cell_0_0.proxy.glb"]).toBeDefined();
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: { glb: string } }[] };
    expect(shipped.cells[0]?.proxy?.glb).toBe("world.cell_0_0.proxy.glb");
  });

  it("should leave an unrelated JSON source untouched", async () => {
    const root = await makeTempDir("threenative-hlod-json-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    const notes = Buffer.from('{"version":1,"note":"not a world"}\n', "utf8");
    await writeFile(path.join(root, "assets", "notes.json"), notes);
    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    expect(await outputBytes(root, manifest, "notes.json")).toEqual(notes);
  });

  it("should decline a cell whose visible geometry it cannot reproduce, with no partial proxy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-decline-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "points.glb"), await pointsChunk());
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["points.glb"], x: 2, z: 3 }]),
    );
    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: unknown }[] };
    expect(shipped.cells[0]?.proxy).toBeUndefined();
    expect(manifest.entries["world/world.cell_2_3.proxy.glb"]).toBeUndefined();
    expect(logLines(log)).toContain("declined=1:2_3@topology");
  });
});

describe("world HLOD determinism and cache", () => {
  it("should emit the same proxy and world hashes for the same input", async () => {
    const build = async (name: string): Promise<{ proxy: Buffer; world: Buffer }> => {
      const root = await makeTempDir(`threenative-hlod-${name}-`);
      await mkdir(path.join(root, "assets", "world"), { recursive: true });
      await writeFile(
        path.join(root, "assets", "world", "a.glb"),
        await chunkGlb([{ material: "bark", translation: [10, 0, 0] }]),
      );
      await writeFile(
        path.join(root, "assets", "world", "world.json"),
        worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
      );
      await compileAssets({ config: { ...NONE }, cwd: root });
      const manifest = await readManifest(root);
      return {
        proxy: await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb"),
        world: await outputBytes(root, manifest, "world/world.json"),
      };
    };
    const first = await build("a");
    const second = await build("b");
    expect(second.proxy).toEqual(first.proxy);
    expect(second.world).toEqual(first.world);
  });

  it("should reuse the previous cook on a second compile", async () => {
    const root = await makeTempDir("threenative-hlod-cache-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(
      path.join(root, "assets", "world", "a.glb"),
      await chunkGlb([{ material: "bark", translation: [10, 0, 0] }]),
    );
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );
    await compileAssets({ config: { ...NONE }, cwd: root });
    const second = await compileAssets({ config: { ...NONE }, cwd: root });
    expect(second.written).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});

describe("world package detection", () => {
  it("should accept a v1 world and reject unrelated JSON", () => {
    const world = readWorldPackage(worldJson([{ chunks: ["a.glb"], x: 1, z: 2 }]));
    expect(world?.cells[0]).toMatchObject({ chunks: ["a.glb"], x: 1, z: 2 });
    expect(readWorldPackage(Buffer.from('{"version":2,"cellSize":1,"cells":[]}'))).toBeUndefined();
    expect(readWorldPackage(Buffer.from("not json"))).toBeUndefined();
  });

  it("should attach proxies only to matching cells", () => {
    const world = readWorldPackage(
      worldJson([
        { chunks: [], x: 0, z: 0 },
        { chunks: [], x: 1, z: 1 },
      ]),
    );
    const rewritten = JSON.parse(
      applyProxiesToWorld(world as NonNullable<typeof world>, [
        {
          buffer: Buffer.alloc(0),
          error: 0.5,
          logical: "world/world.cell_1_1.proxy.glb",
          materialGroups: 2,
          reference: "world.cell_1_1.proxy.glb",
          triangles: 12,
          x: 1,
          z: 1,
        },
      ]).toString("utf8"),
    ) as { cells: { proxy?: { glb: string } }[] };
    expect(rewritten.cells[0]?.proxy).toBeUndefined();
    expect(rewritten.cells[1]?.proxy?.glb).toBe("world.cell_1_1.proxy.glb");
  });
});

describe("world HLOD transform and exclusion fidelity", () => {
  it("should keep both nodes of one shared mesh and preserve winding through a mirrored transform", async () => {
    const root = await makeTempDir("threenative-hlod-shared-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "a.glb"), await sharedMeshChunk());
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const document = await new NodeIO().readBinary(
      new Uint8Array(await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb")),
    );
    const scene = document.getRoot().listScenes()[0];
    expect(scene).toBeDefined();
    const bounds = getBounds(scene as NonNullable<typeof scene>);
    // Both differently transformed nodes of the one Mesh are present.
    expect(bounds.min[0]).toBeLessThanOrEqual(0);
    expect(bounds.max[0]).toBeGreaterThanOrEqual(10);
    const triangles = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, prim) => sum + Math.floor((prim.getIndices()?.getCount() ?? 0) / 3), 0);
    expect(triangles).toBe(2);
    // Mirrored geometry keeps its authored front face without forcing DoubleSide.
    for (const material of document.getRoot().listMaterials())
      expect(material.getDoubleSided()).toBe(false);
    expect(worldNormalY(document).every((y) => y > 0.99)).toBe(true);
    // The nonuniform + mirrored bake reverses winding, so the triangles' own face normals still
    // agree with the authored vertex normals instead of pointing into the mesh.
    expect(windingAgreesWithNormals(document)).toBe(true);
  });

  it("should expand GPU-instanced nodes into every authored instance", async () => {
    const root = await makeTempDir("threenative-hlod-instanced-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "a.glb"), await instancedChunk());
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const document = await new NodeIO().readBinary(
      new Uint8Array(await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb")),
    );
    const scene = document.getRoot().listScenes()[0];
    const bounds = getBounds(scene as NonNullable<typeof scene>);
    expect(bounds.min[0]).toBeLessThanOrEqual(0);
    expect(bounds.max[0]).toBeGreaterThanOrEqual(4);
    const triangles = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, prim) => sum + Math.floor((prim.getIndices()?.getCount() ?? 0) / 3), 0);
    expect(triangles).toBe(2);
  });

  it("should keep a name-matched collider mesh because the runtime renders it", async () => {
    const root = await makeTempDir("threenative-hlod-collider-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "a.glb"), await colliderChunk());
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const document = await new NodeIO().readBinary(
      new Uint8Array(await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb")),
    );
    const scene = document.getRoot().listScenes()[0];
    const bounds = getBounds(scene as NonNullable<typeof scene>);
    // Both triangles survive: the `-convcol`-named node at x=5 is rendered by the runtime, so
    // dropping it would make the distant proxy differ from the near chunk it replaces.
    expect(bounds.max[0]).toBeGreaterThanOrEqual(6);
    const triangles = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, prim) => sum + Math.floor((prim.getIndices()?.getCount() ?? 0) / 3), 0);
    expect(triangles).toBe(2);
    const proxyRoot = document.getRoot();
    for (const property of [
      ...proxyRoot.listScenes(),
      ...proxyRoot.listNodes(),
      ...proxyRoot.listMeshes(),
      ...proxyRoot.listMeshes().flatMap((mesh) => mesh.listPrimitives()),
    ])
      expect(property.getExtras()).toEqual({});
  });

  it("should decline a cell with a non-finite vertex or transform, publishing no proxy", async () => {
    for (const kind of ["vertex", "transform"] as const) {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const root = await makeTempDir(`threenative-hlod-malformed-${kind}-`);
      await mkdir(path.join(root, "assets", "world"), { recursive: true });
      await writeFile(path.join(root, "assets", "world", "a.glb"), await malformedChunk(kind));
      await writeFile(
        path.join(root, "assets", "world", "world.json"),
        worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
      );

      await compileAssets({ config: { ...NONE }, cwd: root });
      const manifest = await readManifest(root);
      const shipped = JSON.parse(
        (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
      ) as { cells: { proxy?: unknown }[] };
      expect(shipped.cells[0]?.proxy).toBeUndefined();
      expect(manifest.entries["world/world.cell_0_0.proxy.glb"]).toBeUndefined();
      expect(logLines(log)).toContain("declined=1:0_0@malformed-geometry");
      log.mockRestore();
    }
  });

  it("should decline a cell whose chunk is excluded by assets.exclude", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-exclude-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(
      path.join(root, "assets", "world", "a.glb"),
      await chunkGlb([{ material: "bark", translation: [0, 0, 0] }]),
    );
    await writeFile(
      path.join(root, "assets", "world", "secret.glb"),
      await chunkGlb([{ material: "bark", translation: [5, 0, 0] }]),
    );
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb", "secret.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE, exclude: ["world/secret.glb"] }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: unknown }[] };
    expect(shipped.cells[0]?.proxy).toBeUndefined();
    expect(manifest.entries["world/world.cell_0_0.proxy.glb"]).toBeUndefined();
    expect(logLines(log)).toContain("declined=1:0_0@excluded-chunk");
  });

  it("should obey an exclude glob that matches the generated proxy logical", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-proxy-exclude-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(
      path.join(root, "assets", "world", "a.glb"),
      await chunkGlb([{ material: "bark", translation: [0, 0, 0] }]),
    );
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE, exclude: ["world/*.proxy.glb"] }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: unknown }[] };
    expect(shipped.cells[0]?.proxy).toBeUndefined();
    expect(manifest.entries["world/world.cell_0_0.proxy.glb"]).toBeUndefined();
    expect(logLines(log)).toContain("declined=1:0_0@excluded-proxy");
  });

  it("should decline a cell whose chunk escapes the source root", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-traversal-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["../../outside.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: unknown }[] };
    expect(shipped.cells[0]?.proxy).toBeUndefined();
    expect(logLines(log)).toContain("declined=1:0_0@outside-chunk");
  });

  it("should decline a cell whose node has an unknown visibility extension", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await makeTempDir("threenative-hlod-visibility-");
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "a.glb"), await invisibleChunk());
    await writeFile(
      path.join(root, "assets", "world", "world.json"),
      worldJson([{ chunks: ["a.glb"], x: 0, z: 0 }]),
    );

    await compileAssets({ config: { ...NONE }, cwd: root });
    const manifest = await readManifest(root);
    const shipped = JSON.parse(
      (await outputBytes(root, manifest, "world/world.json")).toString("utf8"),
    ) as { cells: { proxy?: unknown }[] };
    expect(shipped.cells[0]?.proxy).toBeUndefined();
    expect(logLines(log)).toContain("declined=1:0_0@extension");
  });
});

describe("cookWorldProxies", () => {
  it("should decline a cell whose chunk cannot be read without throwing", async () => {
    const world = readWorldPackage(worldJson([{ chunks: ["missing.glb"], x: 0, z: 0 }]));
    const result = await cookWorldProxies({
      read: async () => {
        throw new Error("ENOENT");
      },
      world: world as NonNullable<typeof world>,
      worldLogical: "world/world.json",
    });
    expect(result.proxies).toHaveLength(0);
    expect(result.declined).toEqual([{ reason: "missing-chunk", x: 0, z: 0 }]);
    expect(formatWorldHlod("world/world.json", result)).toContain("declined=1:0_0@missing-chunk");
  });
});

describe("scatter cell HLOD", () => {
  function scatterWorld(records = 2, maxDistance?: number) {
    const raw = JSON.parse(worldJson([{ chunks: [], x: 0, z: 0 }]).toString());
    raw.assets = {
      pine: {
        glb: "pine.glb",
        bounds: { min: [0, 0, 0], max: [8, 0, 8] },
        ...(maxDistance === undefined ? {} : { maxDistance }),
      },
    };
    raw.cells[0].runs = [{ asset: "pine", offset: 0, count: records }];
    return readWorldPackage(Buffer.from(JSON.stringify(raw))) as NonNullable<
      ReturnType<typeof readWorldPackage>
    >;
  }

  it("cooks scatter-only cells with placements, authored cutouts and explicit full-cell coverage", async () => {
    const source = await denseChunk(8);
    const records = Buffer.from(
      new Float32Array([10, 0, 0, 0, 0, 0, 1, 1, 30, 0, 0, 0, 0, 0, 1, 2]).buffer,
    );
    const world = scatterWorld();
    const files = new Map([
      ["world/pine.glb", source.buffer],
      ["world/placements.bin", records],
    ]);
    const result = await cookWorldProxies({
      read: async (logical) => files.get(logical) as Buffer,
      world,
      worldLogical: "world/world.json",
    });
    expect(result.declined).toEqual([]);
    expect(result.proxies).toHaveLength(1);
    const proxy = result.proxies[0] as NonNullable<(typeof result.proxies)[0]>;
    const metadata = JSON.parse(applyProxiesToWorld(world, result.proxies).toString()).cells[0]
      .proxy;
    expect(metadata.scope).toBe("cell");
    expect(metadata.sourceTriangles).toBe(source.opaqueTriangles * 4);
    expect(proxy.triangles).toBeLessThan(metadata.sourceTriangles);
    const document = await new NodeIO().readBinary(new Uint8Array(proxy.buffer));
    const bounds = getBounds(document.getRoot().listScenes()[0] as Scene);
    expect(bounds.min[0]).toBe(10);
    expect(bounds.max[0]).toBe(32);
    expect(bounds.min[1]).toBeCloseTo(-0.8);
    expect(bounds.max[1]).toBeCloseTo(0.8);
    expect(bounds.max[2]).toBe(2);
    expect(metadata.bounds).toEqual(bounds);
    const cutoutTriangles = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .filter((primitive) => primitive.getMaterial()?.getAlphaMode() === "MASK")
      .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
    expect(cutoutTriangles).toBe(source.opaqueTriangles * 2);
  });

  it("compiles scatter through the existing overlay and emits deterministic proxy bytes", async () => {
    const root = await makeTempDir("threenative-hlod-scatter-");
    const source = await denseChunk(8);
    const world = scatterWorld(1);
    const records = Buffer.from(new Float32Array([0, 0, 0, 0, 0, 0, 1, 1]).buffer);
    const raw = Buffer.from(JSON.stringify(world.json));
    await mkdir(path.join(root, "assets", "world"), { recursive: true });
    await writeFile(path.join(root, "assets", "world", "pine.glb"), source.buffer);
    await writeFile(path.join(root, "assets", "world", "placements.bin"), records);
    await writeFile(path.join(root, "assets", "world", "world.json"), raw);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await compileAssets({ cwd: root, config: NONE });
    const manifest = await readManifest(root);
    const first = await outputBytes(root, manifest, "world/world.cell_0_0.proxy.glb");
    const emitted = JSON.parse((await outputBytes(root, manifest, "world/world.json")).toString());
    expect(emitted.cells[0].proxy.scope).toBe("cell");
    await compileAssets({ cwd: root, config: NONE });
    expect(
      await outputBytes(root, await readManifest(root), "world/world.cell_0_0.proxy.glb"),
    ).toEqual(first);
    expect(await readFile(path.join(root, "assets", "world", "world.json"))).toEqual(raw);
  });

  it.each([
    "blend",
    "invisible",
    "alternate-scene",
    "orphan",
    "no-reduction",
    "node-budget",
    "nested-instancing",
    "shear",
  ])("declines %s scatter without emitting a partial proxy", async (kind) => {
    let bytes = (await denseChunk(8)).buffer;
    if (kind === "blend")
      bytes = await chunkGlb([{ alphaMode: "BLEND", material: "glass", translation: [0, 0, 0] }]);
    if (kind === "invisible") bytes = await invisibleChunk();
    if (kind === "nested-instancing") bytes = await instancedChunk();
    if (kind === "shear") {
      const doc = await new NodeIO().readBinary(new Uint8Array(bytes));
      const scene = doc.getRoot().listScenes()[0] as Scene;
      const parent = doc.createNode("nonuniform").setScale([2, 1, 1]);
      for (const node of [...scene.listChildren()]) {
        node.setRotation([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
        parent.addChild(node);
      }
      scene.addChild(parent);
      bytes = Buffer.from(await new NodeIO().writeBinary(doc));
    }
    if (kind === "no-reduction")
      bytes = await chunkGlb([{ alphaMode: "MASK", material: "leaves", translation: [0, 0, 0] }]);
    if (kind === "alternate-scene" || kind === "orphan") {
      const doc = await new NodeIO().readBinary(new Uint8Array(bytes));
      if (kind === "alternate-scene") doc.createScene("alternate");
      else doc.createNode("unseen").setMesh(doc.getRoot().listMeshes()[0] ?? null);
      bytes = Buffer.from(await new NodeIO().writeBinary(doc));
    }
    const repetitions = kind === "node-budget" ? 8000 : 1;
    const records = Buffer.alloc(repetitions * 32);
    for (let at = 0; at < records.length; at += 32) {
      records.writeFloatLE(1, at + 24);
      records.writeFloatLE(1, at + 28);
    }
    const result = await cookWorldProxies({
      world: scatterWorld(repetitions),
      worldLogical: "world/world.json",
      read: async (logical) => (logical.endsWith("placements.bin") ? records : bytes),
    });
    expect(result.proxies).toHaveLength(0);
    expect(result.declined).toHaveLength(1);
    const expected = {
      blend: "scatter-material",
      invisible: "extension",
      "alternate-scene": "scatter-scenes",
      orphan: "scatter-orphans",
      "no-reduction": "no-triangle-reduction",
      "node-budget": "node-budget",
      "nested-instancing": "scatter-instancing",
      shear: "scatter-shear",
    };
    expect(result.declined[0]?.reason).toBe(expected[kind as keyof typeof expected]);
  });
  it.each(["alternate-scene", "orphan", "transmission", "tangent", "shear"])(
    "declines %s in chunks when the proxy covers the full scatter cell",
    async (kind) => {
      const source = await denseChunk(8);
      const writer = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      const doc = await writer.readBinary(new Uint8Array(source.buffer));
      if (kind === "alternate-scene") doc.createScene("alternate");
      if (kind === "shear") {
        const scene = doc.getRoot().listScenes()[0] as Scene;
        const parent = doc.createNode("nonuniform").setScale([2, 1, 1]);
        for (const node of [...scene.listChildren()]) {
          node.setRotation([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
          parent.addChild(node);
        }
        scene.addChild(parent);
      }
      if (kind === "orphan")
        doc.createNode("unseen").setMesh(doc.getRoot().listMeshes()[0] ?? null);
      if (kind === "transmission") {
        const extension = doc.createExtension(KHRMaterialsTransmission);
        doc
          .getRoot()
          .listMaterials()[0]
          ?.setExtension(
            "KHR_materials_transmission",
            extension.createTransmission().setTransmissionFactor(1),
          );
      }
      if (kind === "tangent") {
        const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0] as Primitive;
        primitive.setAttribute(
          "TANGENT",
          doc
            .createAccessor()
            .setType("VEC4")
            .setBuffer(doc.getRoot().listBuffers()[0] ?? null)
            .setArray(
              new Float32Array((primitive.getAttribute("POSITION")?.getCount() ?? 0) * 4).fill(0.5),
            ),
        );
      }
      const chunk = Buffer.from(await writer.writeBinary(doc));
      const world = scatterWorld(1);
      const cell = world.cells[0];
      if (cell !== undefined) cell.raw.chunks = ["chunk.glb"];
      const parsed = readWorldPackage(Buffer.from(JSON.stringify(world.json))) as NonNullable<
        ReturnType<typeof readWorldPackage>
      >;
      const records = Buffer.from(new Float32Array([0, 0, 0, 0, 0, 0, 1, 1]).buffer);
      const result = await cookWorldProxies({
        world: parsed,
        worldLogical: "world/world.json",
        read: async (logical) =>
          logical.endsWith("placements.bin")
            ? records
            : logical.endsWith("chunk.glb")
              ? chunk
              : source.buffer,
      });
      expect(result.proxies).toHaveLength(0);
      expect(result.declined[0]?.reason).toBe(
        kind === "transmission"
          ? "scatter-material"
          : kind === "tangent"
            ? "scatter-tangents"
            : kind === "shear"
              ? "scatter-shear"
              : kind === "orphan"
                ? "scatter-orphans"
                : "scatter-scenes",
      );
    },
  );

  it("preserves cancelling rotations through sheared non-mesh chunk ancestors", async () => {
    const source = await denseChunk(8);
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(source.buffer));
    const scene = doc.getRoot().listScenes()[0] as Scene;
    const scale = doc.createNode("scale").setScale([2, 1, 1]);
    const rotate = doc
      .createNode("rotate")
      .setRotation([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
    scale.addChild(rotate);
    for (const node of [...scene.listChildren()]) {
      node.setRotation([0, -Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
      rotate.addChild(node);
    }
    scene.addChild(scale);
    const chunk = Buffer.from(await io.writeBinary(doc));
    const world = scatterWorld(1);
    const cell = world.cells[0];
    if (cell !== undefined) cell.raw.chunks = ["chunk.glb"];
    const parsed = readWorldPackage(Buffer.from(JSON.stringify(world.json))) as NonNullable<
      ReturnType<typeof readWorldPackage>
    >;
    const records = Buffer.from(new Float32Array([10, 0, 0, 0, 0, 0, 1, 1]).buffer);
    const result = await cookWorldProxies({
      world: parsed,
      worldLogical: "world/world.json",
      read: async (logical) =>
        logical.endsWith("placements.bin")
          ? records
          : logical.endsWith("chunk.glb")
            ? chunk
            : source.buffer,
    });
    expect(result.declined).toEqual([]);
    const output = await io.readBinary(new Uint8Array(result.proxies[0]?.buffer as Buffer));
    const bounds = getBounds(output.getRoot().listScenes()[0] as Scene);
    expect(bounds.min[0]).toBeCloseTo(0, 6);
    expect(bounds.min[2]).toBeCloseTo(0, 6);
    expect(bounds.max[0]).toBeCloseTo(11, 6);
    expect(bounds.max[2]).toBeCloseTo(1, 6);
    const card = output
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .find((primitive) => primitive.getMaterial()?.getAlphaMode() === "MASK") as Primitive;
    // Both intact cutout grids retain their source world positions, even at the chunk's +X edge.
    const positions = card.getAttribute("POSITION") as NonNullable<
      ReturnType<Primitive["getAttribute"]>
    >;
    const node = output
      .getRoot()
      .listNodes()
      .find((entry) => entry.getMesh()?.listPrimitives().includes(card));
    const matrix = new Matrix4().fromArray(node?.getWorldMatrix() ?? []);
    const point = new Vector3();
    const xs: number[] = [];
    for (let index = 0; index < positions.getCount(); index += 1)
      xs.push(point.fromArray(positions.getElement(index, [0, 0, 0])).applyMatrix4(matrix).x);
    expect(xs.some((value) => Math.abs(value - 2) < 1e-6)).toBe(true);
  });

  it("keeps the published error conservative for rotated, scaled local geometry", async () => {
    const source = await denseChunk(24);
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(source.buffer));
    for (const node of doc.getRoot().listNodes())
      node.setScale([100, 1, 1]).setRotation([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
    const bytes = Buffer.from(await io.writeBinary(doc));
    const world = readWorldPackage(
      worldJson([{ chunks: ["chunk.glb"], x: 0, z: 0 }]),
    ) as NonNullable<ReturnType<typeof readWorldPackage>>;
    const result = await cookWorldProxies({
      world,
      worldLogical: "world/world.json",
      read: async () => bytes,
    });
    expect(result.declined).toEqual([]);
    expect(result.proxies[0]?.triangles).toBeLessThan(source.opaqueTriangles * 2);
    // Meshopt's local scale is 1m; the retained node stretches it by 100 before rotation.
    expect(result.proxies[0]?.error).toBeGreaterThanOrEqual(1);
  });

  it("accepts ordinary Float32 rotations without silently losing transform error", async () => {
    const source = await denseChunk(8);
    const half = 0.43;
    const sin = Math.sin(half) / Math.sqrt(3);
    const records = Buffer.from(
      new Float32Array([10, 2, -3, sin, sin, sin, Math.cos(half), 2]).buffer,
    );
    const result = await cookWorldProxies({
      world: scatterWorld(1),
      worldLogical: "world/world.json",
      read: async (logical) => (logical.endsWith("placements.bin") ? records : source.buffer),
    });
    expect(result.declined).toEqual([]);
    expect(result.proxies).toHaveLength(1);
    expect(result.proxies[0]?.error).toBeGreaterThan(0);
  });

  it("bounds cumulative staged placements before allocating overlapping runs", async () => {
    const world = scatterWorld(700000);
    (world.cells[0]?.raw.runs as { asset: string; offset: number; count: number }[]).push(
      { asset: "pine", offset: 0, count: 700000 },
      { asset: "pine", offset: 0, count: 700000 },
    );
    const parsed = readWorldPackage(Buffer.from(JSON.stringify(world.json))) as NonNullable<
      ReturnType<typeof readWorldPackage>
    >;
    const read = vi.fn(async () => Buffer.alloc(0));
    const result = await cookWorldProxies({
      world: parsed,
      worldLogical: "world/world.json",
      read,
    });
    expect(result.declined[0]?.reason).toBe("placement-budget");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["non-finite", "short", "distance-filter", "excluded"])(
    "declines an entire scatter cell for %s, retaining its source path",
    async (kind) => {
      const world = scatterWorld(1, kind === "distance-filter" ? 50 : undefined);
      const source = await denseChunk(8);
      const records = Buffer.from(
        new Float32Array([kind === "non-finite" ? Number.NaN : 0, 0, 0, 0, 0, 0, 1, 1]).buffer,
      );
      const result = await cookWorldProxies({
        included: (logical) => kind !== "excluded" || logical !== "world/pine.glb",
        read: async (logical) =>
          logical.endsWith("placements.bin")
            ? kind === "short"
              ? Buffer.alloc(0)
              : records
            : source.buffer,
        world,
        worldLogical: "world/world.json",
      });
      expect(result.proxies).toHaveLength(0);
      expect(result.declined).toHaveLength(1);
      expect(world.cells[0]?.raw.proxy).toBeUndefined();
    },
  );
});
