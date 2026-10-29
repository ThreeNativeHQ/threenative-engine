import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Accessor,
  Document,
  type GLTF,
  type Buffer as GltfBuffer,
  type Mesh as GltfMesh,
  type Material,
  MathUtils,
  NodeIO,
} from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  type InstancedMesh as GltfInstancedMesh,
  KHRMeshQuantization,
  KHRTextureTransform,
  type Transform,
} from "@gltf-transform/extensions";
import {
  copyToDocument,
  createDefaultPropertyResolver,
  transformMesh,
} from "@gltf-transform/functions";
import {
  type ITerrainState,
  Terrain,
  applyPlacementOverrides,
  bakeTerrain,
  bakeWorldPackage,
  decodeRAW16,
  sampleHeight,
} from "@threenative/terrain";
import { PNG } from "pngjs";
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createAssetLoader } from "../../core/src/assets.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "../../core/src/instanced-batch-lod.js";
import {
  DISCRETE_LOD_DEFAULT_HYSTERESIS,
  conservativeViewDepth,
  selectLodLevel,
} from "../../core/src/model-lod.js";
import { type IWorldPackage, validateWorldPackage } from "../../core/src/world-package.js";
import { stackLayers } from "../../core/src/world-terrain-splat.js";
import { createGltfReader, readGltfDocument } from "../src/gltf-io.js";
import { primitiveTriangleCount } from "../src/lod/eligibility.js";
import { type DiscreteLod, TNDiscreteLod, TN_DISCRETE_LOD } from "../src/lod/extension.js";
import { decodeImageBytes } from "../src/passes/decode-image.js";
import { unpackGlb } from "../src/passes/shared-images.js";
import { cookTerrainWorld } from "../src/world/terrain-world.js";

// GLTFLoader reads the global `self` while it parses. Node has none.
Object.assign(globalThis, { self: globalThis });

// A deterministic IO failure injected for one sibling path, so a real stat error can be told
// apart from an absent sibling without touching permissions or the platform.
const fsProbe = vi.hoisted(() => ({
  statFailure: undefined as { path: string; error: Error } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (fsProbe.statFailure && String(args[0]) === fsProbe.statFailure.path) {
        throw fsProbe.statFailure.error;
      }
      return original.stat(...args);
    },
  };
});

/** A real evaluated terrain. The fixed seed fixes every scatter position. */
function evaluatedTerrain(assets: readonly string[] = ["fir"]): ITerrainState {
  let terrain = new Terrain({ resolution: 33, seed: 73, size: 256 });
  for (const asset of assets) {
    terrain = terrain.scatter({ id: `${asset}s`, asset, count: 40, minDistance: 3 });
  }
  const state = terrain.evaluate();
  if (state.instances.length === 0) throw new Error("fixture terrain has no placements");
  return state;
}

function io(): NodeIO {
  return new NodeIO().registerExtensions([...ALL_EXTENSIONS]);
}

/** One triangle with normals and UVs. Its vertices sit in the unit square on the XZ plane. */
function triangle(doc: Document, buffer: GltfBuffer, material: Material) {
  return doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
        .setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]))
        .setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      doc
        .createAccessor()
        .setType("VEC2")
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer),
    )
    .setIndices(
      doc
        .createAccessor()
        .setType("SCALAR")
        .setArray(new Uint16Array([0, 1, 2]))
        .setBuffer(buffer),
    )
    .setMaterial(material);
}

/** Two triangles, an unused vertex, and two primitives that share one derived-level accessor. */
async function smallLodSpecies(
  mode: "shared" | "shared-chain" | "mirror" | "unused" | "bad-index" | "bad-level" = "shared",
): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const extension = doc.createExtension(TNDiscreteLod);
  const positions = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 2, 3, 4]))
    .setBuffer(buffer);
  const level = doc
    .createAccessor()
    .setType("SCALAR")
    .setArray(
      Uint32Array.from(mode === "bad-level" ? [3, 2] : mode === "unused" ? [4, 2, 1] : [3, 2, 1]),
    )
    .setBuffer(buffer);
  const chain = extension
    .createDiscreteLod()
    .setCounts([1])
    .setErrors([0.1])
    .setAbsoluteErrors([0.1])
    .setBaselineTriangles(2)
    .setLod0Triangles(2)
    .setErrorScale(1)
    .addIndices(level);
  const mesh = doc.createMesh("fir");
  for (let part = 0; part < 2; part++) {
    const indices =
      mode === "bad-index"
        ? [99, 2, 1, 1, 2, 0]
        : part === 0
          ? [3, 2, 1, 1, 2, 0]
          : [0, 1, 2, 2, 1, 3];
    const primitive = doc
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setIndices(
        doc
          .createAccessor()
          .setType("SCALAR")
          .setArray(Uint32Array.from(indices))
          .setBuffer(buffer),
      )
      .setMaterial(doc.createMaterial(`part-${part}`));
    primitive.setExtension(
      TN_DISCRETE_LOD,
      part === 0 || mode === "shared-chain" ? chain : chain.clone(),
    );
    mesh.addPrimitive(primitive);
  }
  doc.createScene().addChild(
    doc
      .createNode("fir")
      .setMesh(mesh)
      .setScale(mode === "mirror" ? [-1, 1, 1] : [1, 1, 1]),
  );
  return io().registerExtensions([TNDiscreteLod]).writeBinary(doc);
}

/** A static species with one mesh of one primitive. */
async function simpleSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const mesh = doc
    .createMesh("rock")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("rock")));
  scene.addChild(doc.createNode("rockNode").setMesh(mesh));
  return io().writeBinary(doc);
}

/** One triangle whose normals are KHR_mesh_quantization snorm16, as a quantized cooked model stores them. */
async function quantizedNormalSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const buffer = doc.createBuffer();
  const primitive = triangle(doc, buffer, doc.createMaterial("fir"));
  primitive
    .getAttribute("NORMAL")
    ?.setArray(new Int16Array([0, 32767, 0, 0, 32767, 0, 0, 32767, 0]))
    .setNormalized(true);
  const mesh = doc.createMesh("fir").addPrimitive(primitive);
  doc
    .createScene("Scene")
    .addChild(doc.createNode("firNode").setMesh(mesh).setTranslation([5, 0, 0]));
  return io().writeBinary(doc);
}

/** A static species with two meshes. The trunk is textured and sits 5 m along +X in its node. */
async function twoMeshSpecies(): Promise<{ glb: Uint8Array; png: Uint8Array }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const texture = doc.createTexture("bark").setImage(png).setMimeType("image/png");
  const bark = doc.createMaterial("bark").setBaseColorTexture(texture);
  const trunk = doc.createMesh("trunk").addPrimitive(triangle(doc, buffer, bark));
  const crown = doc
    .createMesh("crown")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("leaf")));
  scene.addChild(doc.createNode("trunkNode").setMesh(trunk).setTranslation([5, 0, 0]));
  scene.addChild(doc.createNode("crownNode").setMesh(crown));
  return { glb: await io().writeBinary(doc), png };
}

/** A static species whose one textured mesh is reused by two nodes, at X=0 and X=5. */
async function sharedMeshSpecies(): Promise<{ glb: Uint8Array; png: Uint8Array }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const texture = doc.createTexture("shared").setImage(png).setMimeType("image/png");
  const material = doc.createMaterial("shared").setBaseColorTexture(texture);
  const mesh = doc.createMesh("shared").addPrimitive(triangle(doc, buffer, material));
  scene.addChild(doc.createNode("node0").setMesh(mesh).setTranslation([0, 0, 0]));
  scene.addChild(doc.createNode("node1").setMesh(mesh).setTranslation([5, 0, 0]));
  return { glb: await io().writeBinary(doc), png };
}

// glTF wrap modes for the samplers that each material keeps.
const REPEAT: GLTF.TextureWrapMode = 10497;
const CLAMP_TO_EDGE: GLTF.TextureWrapMode = 33071;

/** A static species whose one textured mesh samples with its own wrap mode and UV offset. */
async function texturedSpecies(
  wrapS: GLTF.TextureWrapMode,
  offset: [number, number],
): Promise<{ glb: Uint8Array; png: Uint8Array }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const texture = doc.createTexture("bark").setImage(png).setMimeType("image/png");
  const bark = doc.createMaterial("bark").setBaseColorTexture(texture);
  const transform = doc.createExtension(KHRTextureTransform).createTransform().setOffset(offset);
  const info = bark.getBaseColorTextureInfo();
  assert.ok(info);
  info.setWrapS(wrapS).setExtension("KHR_texture_transform", transform);
  const mesh = doc.createMesh("bark").addPrimitive(triangle(doc, buffer, bark));
  scene.addChild(doc.createNode("barkNode").setMesh(mesh));
  return { glb: await io().writeBinary(doc), png };
}

/** A species with a skin. The cook must refuse it by name. */
async function skinnedSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const joint = doc.createNode("root");
  const skin = doc.createSkin("rig").addJoint(joint);
  const mesh = doc
    .createMesh("rigged")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("rigged")));
  scene.addChild(joint);
  scene.addChild(doc.createNode("rigged").setMesh(mesh).setSkin(skin));
  return io().writeBinary(doc);
}

/** A species with a scene but no mesh at all. The cook must refuse it by name. */
async function noMeshSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const scene = doc.createScene("Scene");
  scene.addChild(doc.createNode("prop"));
  return io().writeBinary(doc);
}

/** A species whose one mesh has no primitive, so it draws nothing. The cook must refuse it. */
async function emptyMeshSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const scene = doc.createScene("Scene");
  scene.addChild(doc.createNode("emptyNode").setMesh(doc.createMesh("empty")));
  return io().writeBinary(doc);
}

/** Parses a GLB with the vanilla three loader, the same reader a game uses. */
function loadWorld(glb: Uint8Array): Promise<Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(glb.slice().buffer, "", (gltf) => resolve(gltf.scene), reject);
  });
}

/** Every scene of a cooked GLB, with the default scene and each scene's instancing nodes. */
function loadScenes(glb: Uint8Array): Promise<{ scene: Group; scenes: Group[] }> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      glb.slice().buffer,
      "",
      (gltf) => resolve({ scene: gltf.scene, scenes: gltf.scenes as Group[] }),
      reject,
    );
  });
}

/** The instancing nodes directly in a loaded scene, each with its instance count. */
function instancedNodes(scene: Group): { name: string; instances: number }[] {
  const found: { name: string; instances: number }[] = [];
  scene.traverse((object) => {
    if (object instanceof InstancedMesh) found.push({ name: object.name, instances: object.count });
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

describe("cookTerrainWorld", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("strata-terrain-world-");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves every relative layer texture byte-for-byte and marks terrain nodes", async () => {
    const image = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    await writeFile(path.join(dir, "authored.png"), image);
    const cooked = await cookTerrainWorld({
      state: new Terrain({ resolution: 33, size: 256 }).evaluate(),
      species: {},
      out: path.join(dir, "world"),
      materials: {
        texturesDir: dir,
        layers: [
          {
            id: "base",
            diff: "authored.png",
            nrmBytes: image,
            diffMimeType: "image/png",
            nrmMimeType: "image/png",
            ormBytes: image,
            h: "authored.png",
          },
          { id: "rock", diff: "authored.png", nrm: "authored.png" },
        ],
      },
      extraLayers: { table: "terrain-table.json" },
    });
    for (const id of ["base", "rock"])
      for (const channel of id === "base" ? ["diff", "nrm", "orm", "h"] : ["diff", "nrm"])
        expect(await readFile(path.join(dir, "world", "textures", `${id}_${channel}.jpg`))).toEqual(
          Buffer.from(image),
        );
    const doc = await io().readBinary(cooked.worldGlb);
    for (const node of doc.getRoot().getDefaultScene()?.listChildren() ?? []) {
      expect(node.getExtras()).toEqual({ tnTerrainSurface: "world.json" });
      expect(node.getMesh()?.getExtras()).toEqual({ tnTerrainSurface: "world.json" });
    }
  });

  it("normalizes map dimensions losslessly while preserving already-sized source bytes", async () => {
    const sharp = (await import("sharp")).default;
    const noise = { type: "gaussian", mean: 128, sigma: 40 } as const;
    const jpeg = (size: number) =>
      sharp({ create: { width: size, height: size, channels: 3, background: "#808040", noise } })
        .jpeg()
        .toBuffer();
    // The forest's shape scaled down: rock authored at half the size of grass, dirt and moss.
    const [large, small] = await Promise.all([jpeg(64), jpeg(32)]);
    const largeRgba = (await decodeImageBytes(large, "source.jpg")).data;
    const smallRgba = new Uint8Array(
      await sharp(small).resize(64, 64).ensureAlpha().raw().toBuffer(),
    );
    const ids = ["grass", "dirt", "rock", "moss"];
    const kinds = { diff: "diffBytes", nrm: "nrmBytes", orm: "ormBytes", h: "hBytes" } as const;
    await cookTerrainWorld({
      state: new Terrain({ resolution: 33, size: 256 }).evaluate(),
      species: {},
      out: path.join(dir, "world"),
      materials: {
        layers: ids.map((id) => {
          const bytes = id === "rock" ? small : large;
          return { id, diffBytes: bytes, nrmBytes: bytes, ormBytes: bytes, hBytes: bytes };
        }),
      },
    });
    for (const kind of Object.keys(kinds)) {
      const maps = await Promise.all(
        ids.map(async (id) => {
          const name = `${id}_${kind}.jpg`;
          const bytes = await readFile(path.join(dir, "world", "textures", name));
          const decoded = await decodeImageBytes(bytes, name);
          const texture = new Texture();
          texture.image = { width: decoded.width, height: decoded.height } as never;
          return { id, bytes, decoded, texture };
        }),
      );
      for (const { id, bytes, decoded } of maps) {
        expect([decoded.width, decoded.height, decoded.data.length]).toEqual([64, 64, 64 * 64 * 4]);
        if (id === "rock") {
          expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
          expect(decoded.data).toEqual(smallRgba);
        } else {
          expect(bytes).toEqual(large);
          expect(decoded.data).toEqual(largeRgba);
        }
      }
      const copies: number[] = [];
      const renderer = {
        raw: {
          initTexture: () => undefined,
          copyTextureToTexture: (_s: unknown, _d: unknown, _r: unknown, at: { z: number }) =>
            copies.push(at.z),
        },
      };
      const stacked = stackLayers(
        maps.map((map) => map.texture),
        renderer as never,
      );
      expect((stacked?.image as { depth?: number } | undefined)?.depth).toBe(4);
      expect(copies).toEqual([0, 1, 2, 3]);
    }
  });

  it("names a missing non-base texture before writing a package", async () => {
    await expect(
      cookTerrainWorld({
        state: new Terrain({ resolution: 33, size: 256 }).evaluate(),
        species: {},
        out: path.join(dir, "world"),
        materials: {
          texturesDir: dir,
          layers: [
            { id: "base", diffBytes: PNG.sync.write(new PNG({ width: 2, height: 2 })) },
            { id: "rock", diff: "missing-rock.jpg" },
          ],
        },
      }),
    ).rejects.toThrow(/missing-rock\.jpg/u);
    await expect(stat(path.join(dir, "world"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cooks the real forest with index-only species chains and measures projected-error submission", async () => {
    const kit = path.resolve("packages/terrain/starter/forest");
    const assets = path.resolve("packages/terrain/starter-assets");
    const recipe = JSON.parse(await readFile(path.join(kit, "recipe.json"), "utf8"));
    for (const layer of recipe.recipe.layers) {
      const data = layer.params?.data;
      if (data?.raw16 === undefined) continue;
      data.values = Array.from(
        decodeRAW16(await readFile(path.join(kit, data.raw16)), data).values,
        (value) => Math.round(value * 10) / 10,
      );
    }
    const table = JSON.parse(await readFile(path.join(kit, "assets.json"), "utf8")) as Record<
      string,
      {
        near: string;
        mid: string;
        midDistance: number;
        bounds: { min: [number, number, number]; max: [number, number, number] };
        maxDistance: number;
      }
    >;
    const species = Object.fromEntries(
      Object.entries(table).map(([id, spec]) => [
        id,
        {
          glb: path.join(assets, spec.near),
          bounds: spec.bounds,
          maxDistance: spec.maxDistance,
          lods: [{ glb: path.join(assets, spec.mid), distance: spec.midDistance }],
        },
      ]),
    );
    const state = applyPlacementOverrides(
      Terrain.fromJSON(recipe.recipe).evaluate(),
      recipe.placementOverrides ?? {},
    );
    const surface = JSON.parse(await readFile(path.join(kit, "surface.json"), "utf8"));
    const cooked = await cookTerrainWorld({
      state,
      species,
      out: dir,
      materials: {
        layers: [
          {
            id: surface.base.id,
            diff: path.join(assets, surface.sources[surface.base.id].diff),
            nrm: path.join(assets, surface.sources[surface.base.id].nrm),
            diffMimeType: "image/jpeg",
            nrmMimeType: "image/jpeg",
          },
        ],
      },
      extraLayers: { table: "terrain-table.json" },
    });
    expect(unpackGlb(Buffer.from(cooked.worldGlb)).json.asset.extras).toEqual({
      tnTerrainWorld: 1,
    });
    // The production ctx.assets.model entry must attach chains in a multi-scene cooked world.
    const fetchImage = globalThis.fetch;
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("blob:")) return fetchImage(input, init);
      if (url.endsWith("assets.manifest.json")) return new Response(null, { status: 404 });
      return new Response(await readFile(path.join(dir, "world.glb")));
    });
    const loader = createAssetLoader({ basePath: "" });
    const loaded = await loader.model<{ scene: Group }>("worlds/forest/world.glb");
    const partitions: InstancedMesh[] = [];
    loaded.scene.traverse((object) => {
      if (object instanceof InstancedMesh && object.parent instanceof InstancedMesh)
        partitions.push(object);
    });
    expect(partitions.length).toBeGreaterThan(0);
    loader.clear();
    const document = await new NodeIO()
      .registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod])
      .readBinary(cooked.worldGlb);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    camera.position.set(256, 40, 600);
    camera.lookAt(256, 10, 256);
    camera.updateMatrixWorld(true);
    let base = 0;
    let submitted = 0;
    let terrain = 0;
    const rows: Record<string, unknown> = {};
    for (const node of document.getRoot().getDefaultScene()?.listChildren() ?? []) {
      const mesh = node.getMesh();
      if (mesh === null) continue;
      const id = node.getName().replace(/_instances$/, "");
      const spec = species[id];
      if (spec === undefined) {
        terrain += mesh.listPrimitives().reduce((sum, p) => sum + primitiveTriangleCount(p), 0);
        continue;
      }
      const bytes = Buffer.from(await readFile(spec.glb));
      const source = await readGltfDocument(await createGltfReader(bytes), bytes);
      const expected = new Document();
      const originals: ReturnType<Document["createPrimitive"]>[] = [];
      source
        .getRoot()
        .getDefaultScene()
        ?.traverse((node) => {
          const mesh = node.getMesh();
          if (mesh === null) return;
          const copied = copyToDocument(
            expected,
            source,
            [mesh],
            createDefaultPropertyResolver(expected, source),
          ).get(mesh) as GltfMesh | undefined;
          assert.ok(copied);
          // gltf-transform's transformMesh zeroes snorm normals, so the expectation transforms floats.
          for (const primitive of copied.listPrimitives()) {
            const normal = primitive.getAttribute("NORMAL");
            if (normal?.getNormalized() !== true) continue;
            const type = normal.getComponentType();
            normal
              .setArray(
                Float32Array.from((normal.getArray() ?? []) as ArrayLike<number>, (v) =>
                  MathUtils.decodeNormalizedInt(v, type),
                ),
              )
              .setNormalized(false);
          }
          transformMesh(copied, node.getWorldMatrix());
          originals.push(...copied.listPrimitives());
        });
      const decodedHash = (attribute: Accessor | null): string => {
        assert.ok(attribute);
        const values = new Float32Array(attribute.getCount() * attribute.getElementSize());
        for (let i = 0; i < attribute.getCount(); i++)
          values.set(attribute.getElement(i, []), i * attribute.getElementSize());
        return createHash("sha256").update(new Uint8Array(values.buffer)).digest("hex");
      };
      const placements = state.instances.filter((item) => item.asset === id);
      const batch = node.getExtension<GltfInstancedMesh>("EXT_mesh_gpu_instancing");
      assert.ok(batch);
      const translations = batch.getAttribute("TRANSLATION");
      const rotations = batch.getAttribute("ROTATION");
      const scales = batch.getAttribute("SCALE");
      assert.ok(translations && rotations && scales);
      expect(translations.getCount()).toBe(placements.length);
      const levels: number[][] = [];
      let speciesBase = 0;
      let speciesSubmitted = 0;
      for (const [index, primitive] of mesh.listPrimitives().entries()) {
        const original = originals[index];
        assert.ok(original);
        for (const semantic of original.listSemantics()) {
          expect(decodedHash(primitive.getAttribute(semantic)), `${id} decoded ${semantic}`).toBe(
            decodedHash(original.getAttribute(semantic)),
          );
        }
        expect(primitive.getIndices()?.getArray()).toEqual(original.getIndices()?.getArray());
        expect(primitive.getMaterial()?.getAlphaMode()).toBe(
          original.getMaterial()?.getAlphaMode(),
        );
        expect(primitive.getMaterial()?.getBaseColorFactor()).toEqual(
          original.getMaterial()?.getBaseColorFactor(),
        );
        const chain = primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
        const counts = [primitiveTriangleCount(primitive), ...(chain?.getCounts() ?? [])];
        levels.push(counts);
        const geometry = new BufferGeometry().setAttribute(
          "position",
          new BufferAttribute(primitive.getAttribute("POSITION")?.getArray() as Float32Array, 3),
        );
        geometry.computeBoundingBox();
        assert.ok(geometry.boundingBox);
        const size = geometry.boundingBox.getSize(new Vector3());
        // The simplifier's scale is the largest decoded extent, including the source node scale.
        expect(chain?.getErrorScale(), `${id} transformed error scale`).toBeCloseTo(
          Math.max(size.x, size.y, size.z),
          4,
        );
        expect(chain?.getSharedVertexBuffers()).toBe(true);
        geometry.computeBoundingSphere();
        assert.ok(geometry.boundingSphere);
        for (let i = 0; i < translations.getCount(); i++) {
          const matrix = new Matrix4().compose(
            new Vector3().fromArray(translations.getElement(i, [])),
            new Quaternion().fromArray(rotations.getElement(i, [])),
            new Vector3().fromArray(scales.getElement(i, [])),
          );
          const sphere = new Sphere().copy(geometry.boundingSphere).applyMatrix4(matrix);
          const view = conservativeViewDepth(camera, sphere.center, sphere.radius, camera.near);
          const level = selectLodLevel(
            [0, ...(chain?.getAbsoluteErrors() ?? [])],
            0,
            INSTANCED_LOD_MAX_PIXEL_ERROR / Math.max(matrix.getMaxScaleOnAxis(), Number.EPSILON),
            DISCRETE_LOD_DEFAULT_HYSTERESIS,
            [{ camera, viewportHeight: 1080, ...view }],
          );
          speciesSubmitted += counts[level] ?? counts[0] ?? 0;
          speciesBase += counts[0] ?? 0;
        }
        geometry.dispose();
      }
      rows[id] = {
        instances: placements.length,
        levels,
        base: speciesBase,
        submitted: speciesSubmitted,
      };
      base += speciesBase;
      submitted += speciesSubmitted;
    }
    console.log(
      "FOREST_LOD_CENSUS",
      JSON.stringify({
        pose: [256, 40, 600],
        lookAt: [256, 10, 256],
        viewport: [1920, 1080],
        terrain,
        base: base + terrain,
        submitted: submitted + terrain,
        species: rows,
      }),
    );
    expect(Object.keys(rows).sort()).toEqual(["boulder", "fir", "fir-c"]);
    for (const node of document.getRoot().getDefaultScene()?.listChildren() ?? []) {
      if (!node.getName().endsWith("_instances")) continue;
      expect(
        node
          .getMesh()
          ?.listPrimitives()
          .every((p) => p.getExtension(TN_DISCRETE_LOD) !== null),
      ).toBe(true);
    }
    expect(base + terrain).toBe(505_387_464);
    expect(submitted).toBeLessThan(base);
  }, 120_000);

  it("writes the real terrain chunks and one instancing node for the species", async () => {
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    });

    const lod0 = bakeTerrain(state, { lodSteps: [1] }).lods[0];
    assert.ok(lod0);
    const chunks = lod0.chunks;
    expect(chunks.length).toBeGreaterThan(0);
    const scene = await loadWorld(result.worldGlb);
    const terrainNames: string[] = [];
    const instanceCounts: number[] = [];
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanceCounts.push(object.count);
      else if (object instanceof Mesh && object.name.startsWith("terrain_"))
        terrainNames.push(object.name);
    });
    expect(terrainNames.sort()).toEqual(chunks.map((chunk) => chunk.name).sort());
    expect(instanceCounts).toEqual([state.instances.length]);

    for (const file of [
      "world.glb",
      "world.json",
      "heightmap.u16",
      "placements.bin",
      "placement-ids.json",
      "splat.rgba",
      "models/fir.glb",
    ]) {
      expect((await stat(path.join(dir, file))).size).toBeGreaterThan(0);
    }
  });

  it("writes the splat and placement files exactly as bakeWorldPackage bakes them", async () => {
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    });

    const baked = bakeWorldPackage(state, { assets: result.manifest.assets });
    const splat = new Uint8Array(await readFile(path.join(dir, "splat.rgba")));
    expect(splat.some((byte) => byte !== 0)).toBe(true);
    expect(splat).toEqual(baked.files["splat.rgba"]);
    expect(new Uint8Array(await readFile(path.join(dir, "placements.bin")))).toEqual(
      baked.files["placements.bin"],
    );
    const placementIds = new Uint8Array(await readFile(path.join(dir, "placement-ids.json")));
    expect(placementIds).toEqual(baked.files["placement-ids.json"]);
    console.log(
      `cooker placement sidecar ${String(placementIds.byteLength)} B; placements.bin ${String((baked.files["placements.bin"] as Uint8Array).byteLength)} B`,
    );
  });

  it("keeps one instancing node per species when its source has two meshes", async () => {
    const state = evaluatedTerrain();
    const species = await twoMeshSpecies();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    expect(result.instancedMeshCount).toBe(1);
    expect(result.placementCounts.fir).toBe(state.instances.length);
    const scene = await loadWorld(result.worldGlb);
    const instanceCounts: number[] = [];
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanceCounts.push(object.count);
    });
    // One InstancedMesh per primitive; the two source meshes flatten into one glTF mesh.
    expect(instanceCounts).toEqual([state.instances.length, state.instances.length]);
  });

  it("keeps source translation, texture bytes and vertex attributes when it flattens a species", async () => {
    const species = await twoMeshSpecies();
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    // The trunk's child translation becomes model-space bounds: x runs from 0 to 6.
    const fir = result.manifest.assets.fir;
    assert.ok(fir);
    expect(fir.bounds).toEqual({ min: [0, 0, 0], max: [6, 0, 1] });

    const doc = await io().readBinary(result.worldGlb);
    const textured = doc
      .getRoot()
      .listMaterials()
      .find((m) => m.getBaseColorTexture() !== null);
    assert.ok(textured);
    const baseColorTexture = textured.getBaseColorTexture();
    assert.ok(baseColorTexture);
    const image = baseColorTexture.getImage();
    assert.ok(image);
    expect(new Uint8Array(image)).toEqual(new Uint8Array(species.png));
    const instancedNode = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getExtension("EXT_mesh_gpu_instancing") !== null);
    assert.ok(instancedNode);
    const instancedMesh = instancedNode.getMesh();
    assert.ok(instancedMesh);
    const primitive = instancedMesh.listPrimitives().find((p) => p.getMaterial() === textured);
    assert.ok(primitive);
    const positionAttr = primitive.getAttribute("POSITION");
    assert.ok(positionAttr);
    const positions = positionAttr.getArray() as Float32Array;
    expect(Math.min(...positions.filter((_, i) => i % 3 === 0))).toBe(5);
    expect(primitive.getAttribute("NORMAL")).not.toBeNull();
    expect(primitive.getAttribute("TEXCOORD_0")).not.toBeNull();
    expect(primitive.getMode()).toBe(4); // TRIANGLES
  });

  it("keeps the unit length of quantized species normals through the flatten", async () => {
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb: await quantizedNormalSpecies() } },
      out: dir,
    });
    const doc = await io().readBinary(result.worldGlb);
    const normals = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getExtension("EXT_mesh_gpu_instancing") !== null)
      ?.getMesh()
      ?.listPrimitives()[0]
      ?.getAttribute("NORMAL");
    assert.ok(normals);
    for (let i = 0; i < normals.getCount(); i += 1) {
      const [x = 0, y = 0, z = 0] = normals.getElement(i, [0, 0, 0]);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 2);
    }
  });

  it.each(["shared", "shared-chain", "mirror"] as const)(
    "preserves each shared LOD accessor's triangle through %s compaction",
    async (mode) => {
      const glb = await smallLodSpecies(mode);
      const result = await cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb, lods: [{ distance: 40, glb }] } },
        out: dir,
      });
      const doc = await io().registerExtensions([TNDiscreteLod]).readBinary(result.worldGlb);
      const primitives =
        doc
          .getRoot()
          .getDefaultScene()
          ?.listChildren()
          .find((node) => node.getName() === "fir_instances")
          ?.getMesh()
          ?.listPrimitives() ?? [];
      expect(primitives).toHaveLength(2);
      for (const primitive of primitives) {
        const positions = primitive.getAttribute("POSITION");
        const indices = primitive
          .getExtension<DiscreteLod>(TN_DISCRETE_LOD)
          ?.getIndices()[0]
          ?.getArray();
        assert.ok(positions && indices);
        expect(positions.getCount()).toBe(4);
        const corners = Array.from(indices as ArrayLike<number>, (index) =>
          positions.getElement(index, [0, 0, 0]),
        );
        expect(corners).toEqual(
          mode === "mirror"
            ? [
                [-1, 0, 0],
                [0, 0, 1],
                [-1, 0, 1],
              ]
            : [
                [1, 0, 1],
                [0, 0, 1],
                [1, 0, 0],
              ],
        );
      }
    },
  );

  it.each([
    ["unused", "indexes a vertex that its LOD0 does not draw"],
    ["bad-index", "out of range"],
    ["bad-level", "not a triangle list"],
  ] as const)("rejects %s indices before flattening can conceal them", async (mode, message) => {
    const glb = await smallLodSpecies(mode);
    await expect(
      cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb, lods: [{ distance: 40, glb }] } },
        out: dir,
      }),
    ).rejects.toThrow(message);
  });

  it("stores identical species textures once and keeps each material's sampler and UV offset", async () => {
    const repeat = await texturedSpecies(REPEAT, [0.25, 0]);
    const clamp = await texturedSpecies(CLAMP_TO_EDGE, [0, 0.5]);
    const state = evaluatedTerrain(["fir", "pine"]);
    const result = await cookTerrainWorld({
      state,
      species: {
        fir: { glb: repeat.glb, lods: [{ distance: 45, glb: repeat.glb }] },
        pine: { glb: clamp.glb },
      },
      out: dir,
    });

    const doc = await io().readBinary(result.worldGlb);
    const images = doc.getRoot().listTextures();
    expect(images).toHaveLength(1);
    const textured = doc
      .getRoot()
      .listMaterials()
      .filter((m) => m.getBaseColorTexture() !== null);
    expect(textured).toHaveLength(3);
    for (const material of textured) {
      const texture = material.getBaseColorTexture();
      assert.ok(texture);
      expect(texture).toBe(images[0]);
      expect(texture.getMimeType()).toBe("image/png");
      const image = texture.getImage();
      assert.ok(image);
      expect(new Uint8Array(image)).toEqual(new Uint8Array(repeat.png));
    }

    // The image is shared, but each material keeps its own wrap mode and UV offset.
    const samplers = textured.map((material) => {
      const info = material.getBaseColorTextureInfo();
      assert.ok(info);
      const transform = info.getExtension<Transform>("KHR_texture_transform");
      return JSON.stringify([info.getWrapS(), transform?.getOffset()]);
    });
    expect(samplers.sort()).toEqual(
      [
        JSON.stringify([REPEAT, [0.25, 0]]),
        JSON.stringify([REPEAT, [0.25, 0]]),
        JSON.stringify([CLAMP_TO_EDGE, [0, 0.5]]),
      ].sort(),
    );

    const count = (asset: string) => state.instances.filter((item) => item.asset === asset).length;
    expect(result.placementCounts).toEqual({ fir: count("fir"), pine: count("pine") });
    const scene = await loadWorld(result.worldGlb);
    const instanceCounts: number[] = [];
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanceCounts.push(object.count);
    });
    expect(instanceCounts.sort((a, b) => a - b)).toEqual(
      [count("fir"), count("pine")].sort((a, b) => a - b),
    );
  });

  it("keeps an alpha-cut understory species and an opaque deadwood species through the cook", async () => {
    const image = new PNG({ width: 2, height: 2 });
    image.data.set([0, 160, 40, 255, 80, 100, 20, 0, 40, 120, 10, 255, 0, 80, 30, 255]);
    const imageBytes = PNG.sync.write(image);
    const species = async (cut: boolean) => {
      const doc = new Document();
      const texture = doc.createTexture("map").setImage(imageBytes).setMimeType("image/png");
      const material = doc.createMaterial(cut ? "fern" : "deadwood").setBaseColorTexture(texture);
      if (cut) material.setAlphaMode("MASK").setAlphaCutoff(0.5).setDoubleSided(true);
      const mesh = doc.createMesh("m").addPrimitive(triangle(doc, doc.createBuffer(), material));
      doc.createScene("Scene").addChild(doc.createNode("n").setMesh(mesh));
      return io().writeBinary(doc);
    };
    const state = evaluatedTerrain(["fern", "deadwood"]);
    const result = await cookTerrainWorld({
      state,
      species: {
        fern: { glb: await species(true), maxDistance: 70 },
        deadwood: { glb: await species(false), maxDistance: 90 },
      },
      out: dir,
    });

    const root = (await io().readBinary(result.worldGlb)).getRoot();
    const count = (asset: string) => state.instances.filter((item) => item.asset === asset).length;
    for (const asset of ["fern", "deadwood"]) {
      const nodes = root
        .listScenes()
        .flatMap((scene) => scene.listChildren())
        .filter(
          (node) =>
            node.getName() === `${asset}_instances` || node.getName() === `${asset}_lod1_instances`,
        );
      expect(nodes.map((node) => node.getName()).sort()).toEqual(
        [`${asset}_instances`, `${asset}_lod1_instances`].sort(),
      );
      expect(root.getDefaultScene()?.listChildren()).toContain(
        nodes.find((node) => node.getName() === `${asset}_instances`),
      );
      const assertDrawnSpecies = (node: (typeof nodes)[number]) => {
        const batch = node.getExtension<GltfInstancedMesh>("EXT_mesh_gpu_instancing");
        assert.ok(batch);
        expect(count(asset)).toBeGreaterThan(0);
        expect(batch.getAttribute("TRANSLATION")?.getCount()).toBe(count(asset));
        const primitives = node.getMesh()?.listPrimitives();
        assert.ok(primitives && primitives.length > 0);
        for (const primitive of primitives) {
          const material = primitive.getMaterial();
          assert.ok(material, `${asset} drawn primitive must have a material`);
          expect(material.getName()).toBe(asset);
          expect(material.getAlphaMode()).toBe(asset === "fern" ? "MASK" : "OPAQUE");
          if (asset === "fern") {
            expect(material.getAlphaCutoff()).toBe(0.5);
            expect(material.getDoubleSided()).toBe(true);
          }
          const texture = material.getBaseColorTexture();
          assert.ok(texture, `${asset} drawn primitive must retain its map`);
          expect(texture.getImage()).toEqual(new Uint8Array(imageBytes));
        }
      };
      for (const node of nodes) assertDrawnSpecies(node);
    }
    expect(result.placementCounts).toEqual({ fern: count("fern"), deadwood: count("deadwood") });
  });

  it("flattens one shared mesh at each node's own transform", async () => {
    const species = await sharedMeshSpecies();
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    expect(result.instancedMeshCount).toBe(1);
    expect(result.placementCounts.fir).toBe(state.instances.length);

    const doc = await io().readBinary(result.worldGlb);
    const instancedNode = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getExtension("EXT_mesh_gpu_instancing") !== null);
    assert.ok(instancedNode);
    const instancedMesh = instancedNode.getMesh();
    assert.ok(instancedMesh);
    const primitives = instancedMesh.listPrimitives();
    // Both source nodes survive as their own primitive: one translated to x=0, one to x=5.
    expect(primitives.length).toBe(2);
    const minX = primitives.map((p) => {
      const positionAttr = p.getAttribute("POSITION");
      assert.ok(positionAttr);
      return Math.min(...(positionAttr.getArray() as Float32Array).filter((_, i) => i % 3 === 0));
    });
    expect(minX.sort((a, b) => a - b)).toEqual([0, 5]);

    const textured = doc
      .getRoot()
      .listMaterials()
      .find((m) => m.getBaseColorTexture() !== null);
    assert.ok(textured);
    const baseColorTexture = textured.getBaseColorTexture();
    assert.ok(baseColorTexture);
    const image = baseColorTexture.getImage();
    assert.ok(image);
    expect(new Uint8Array(image)).toEqual(new Uint8Array(species.png));
  });

  it("losslessly optimizes streamed baseline JPEGs while preserving authored content", async () => {
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 37) % 256));
    const jpeg = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 87, optimiseCoding: false })
      .toBuffer();
    const doc = await io().readBinary(await simpleSpecies());
    const texture = doc.createTexture("authored JPEG").setImage(jpeg).setMimeType("image/jpeg");
    const material = doc.getRoot().listMaterials()[0];
    assert.ok(material);
    material.setBaseColorTexture(texture);
    const glb = await io().writeBinary(doc);
    const cooked = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb, lods: [{ distance: 45, glb }] } },
      out: dir,
    });
    for (const name of ["fir.glb", "fir_lod1.glb"]) {
      const bytes = await readFile(path.join(dir, "models", name));
      expect(bytes.length).toBeLessThan(glb.length);
      const output = await io().readBinary(bytes);
      const image = output.getRoot().listTextures()[0]?.getImage();
      assert.ok(image);
      expect(image.length).toBeLessThan(jpeg.length);
      expect(await sharp(image).ensureAlpha().raw().toBuffer()).toEqual(
        await sharp(jpeg).ensureAlpha().raw().toBuffer(),
      );
      const { size: originalSize, ...originalMetadata } = await sharp(jpeg).metadata();
      const { size: optimizedSize, ...optimizedMetadata } = await sharp(image).metadata();
      expect(optimizedSize).toBeLessThan(originalSize ?? jpeg.length);
      expect(optimizedMetadata).toEqual(originalMetadata);
      const before = await io().writeJSON(doc);
      const after = await io().writeJSON(output);
      expect(after.json).toEqual(before.json);
      assert.ok(before.resources["buffer.bin"]);
      expect(after.resources["buffer.bin"]).toEqual(before.resources["buffer.bin"]);
    }
    const combined = await io().readBinary(cooked.worldGlb);
    const combinedJpegs = combined
      .getRoot()
      .listTextures()
      .filter((item) => item.getMimeType() === "image/jpeg");
    expect(combinedJpegs.length).toBeGreaterThan(0);
    for (const item of combinedJpegs) expect(item.getImage()).toEqual(new Uint8Array(jpeg));
  });

  it("preserves unsupported progressive JPEG bytes in streamed GLBs", async () => {
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } })
      .jpeg({ progressive: true })
      .toBuffer();
    const doc = await io().readBinary(await simpleSpecies());
    const texture = doc.createTexture().setImage(jpeg).setMimeType("image/jpeg");
    doc.getRoot().listMaterials()[0]?.setBaseColorTexture(texture);
    const glb = await io().writeBinary(doc);
    await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb, lods: [{ distance: 45, glb }] } },
      out: dir,
    });
    for (const name of ["fir.glb", "fir_lod1.glb"])
      expect(new Uint8Array(await readFile(path.join(dir, "models", name)))).toEqual(glb);
  });

  it("fails with asset context for malformed streamed JPEGs before writing", async () => {
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } })
      .jpeg({ optimiseCoding: false })
      .toBuffer();
    const doc = await io().readBinary(await simpleSpecies());
    const texture = doc
      .createTexture("broken JPEG")
      .setImage(jpeg.subarray(0, jpeg.length - 100))
      .setMimeType("image/jpeg");
    doc.getRoot().listMaterials()[0]?.setBaseColorTexture(texture);
    const glb = await io().writeBinary(doc);
    await expect(
      cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb, lods: [{ distance: 45, glb }] } },
        out: dir,
      }),
    ).rejects.toThrow(/fir\.glb.*broken JPEG/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("writes explicit LOD files and authored bounds without changing them", async () => {
    const near = await simpleSpecies();
    const lod = await simpleSpecies();
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: {
        fir: {
          glb: near,
          bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
          lods: [{ distance: 45, glb: lod }],
        },
      },
      out: dir,
    });

    expect(result.manifest.assets.fir).toMatchObject({
      glb: "models/fir.glb",
      bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
      lods: [{ distance: 45, glb: "models/fir_lod1.glb" }],
    });
    expect(new Uint8Array(await readFile(path.join(dir, "models", "fir.glb")))).toEqual(near);
    expect(new Uint8Array(await readFile(path.join(dir, "models", "fir_lod1.glb")))).toEqual(lod);
  });

  it("fails before writing when a placement names a species that is not in the map", async () => {
    await expect(
      cookTerrainWorld({ state: evaluatedTerrain(), species: {}, out: dir }),
    ).rejects.toThrow(/species 'fir'/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("fails before writing when a placement has a non-finite position", async () => {
    const state = evaluatedTerrain();
    const [first, ...rest] = state.instances;
    assert.ok(first);
    const broken = {
      ...state,
      instances: [
        {
          ...first,
          position: [Number.NaN, first.position[1], first.position[2]] as [number, number, number],
        },
        ...rest,
      ],
    };
    await expect(
      cookTerrainWorld({
        state: broken,
        species: { fir: { glb: await simpleSpecies() } },
        out: dir,
      }),
    ).rejects.toThrow(/non-finite/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("refuses a skinned species by name before writing", async () => {
    await expect(
      cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb: await skinnedSpecies() } },
        out: dir,
      }),
    ).rejects.toThrow(/species 'fir' .*skin/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("refuses a meshless or empty-draw species by name before writing", async () => {
    // Positive placement counts and zero source bounds must not hide a species with nothing to draw.
    for (const glb of [await noMeshSpecies(), await emptyMeshSpecies()]) {
      await expect(
        cookTerrainWorld({ state: evaluatedTerrain(), species: { fir: { glb } }, out: dir }),
      ).rejects.toThrow(/species 'fir' .*empty draw/);
    }
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("refuses an authored LOD that declares a skin, same as the near model", async () => {
    await expect(
      cookTerrainWorld({
        state: evaluatedTerrain(),
        species: {
          fir: {
            glb: await simpleSpecies(),
            lods: [{ distance: 40, glb: await skinnedSpecies() }],
          },
        },
        out: dir,
      }),
    ).rejects.toThrow(/species 'fir' .*skin/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("derives far levels past the kit fir's 55k-triangle mid, each inside maxDistance (PRD-762)", async () => {
    // The forest kit's fir stops at a 55k mid held to 600 m: 62.6M triangles a frame, 122 ms GPU on
    // an Iris Xe. The cook must keep descending past the coarsest authored level.
    const assets = path.resolve("packages/terrain/starter-assets/fir_tree_01");
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: {
        fir: {
          glb: path.join(assets, "fir-b-lod1.glb"),
          lods: [{ distance: 45, glb: path.join(assets, "fir-b-lod2.glb") }],
          maxDistance: 600,
        },
      },
      out: dir,
    });
    const lods = result.manifest.assets.fir?.lods ?? [];
    expect(lods[0]).toEqual({ distance: 45, glb: "models/fir_lod1.glb" });
    expect(lods.length).toBeGreaterThanOrEqual(3);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const triangles = async (glb: string): Promise<number> => {
      let total = 0;
      const doc = await io.read(path.join(dir, glb));
      for (const mesh of doc.getRoot().listMeshes())
        for (const primitive of mesh.listPrimitives())
          total += (primitive.getIndices()?.getCount() ?? 0) / 3;
      return total;
    };
    const counts = await Promise.all(lods.map((level) => triangles(level.glb)));
    for (let level = 1; level < lods.length; level += 1) {
      expect(counts[level]).toBeLessThan(0.8 * (counts[level - 1] as number));
      expect(lods[level]?.distance).toBeGreaterThan(lods[level - 1]?.distance as number);
      expect(lods[level]?.distance).toBeLessThan(600);
    }
    expect(counts.at(-1)).toBeLessThan(12_000);
  });

  it("discovers an authored -mid sibling before falling back to simplification", async () => {
    const nearPath = path.join(dir, "pine.glb");
    const midPath = path.join(dir, "pine-mid.glb");
    const near = await simpleSpecies();
    const mid = await twoMeshSpecies();
    await writeFile(nearPath, near);
    await writeFile(midPath, mid.glb);

    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb: nearPath } },
      out: dir,
    });

    expect(result.manifest.assets.fir?.lods).toHaveLength(1);
    expect(result.manifest.assets.fir?.lods?.[0]?.glb).toBe("models/fir_lod1.glb");
    // The written level is the sibling's bytes, not a simplification of the near model.
    expect(new Uint8Array(await readFile(path.join(dir, "models", "fir_lod1.glb")))).toEqual(
      new Uint8Array(mid.glb),
    );
  });

  it("propagates a real IO error from a sibling probe instead of treating it as absent", async () => {
    const nearPath = path.join(dir, "oak.glb");
    await writeFile(nearPath, await simpleSpecies());
    const sibling = path.join(dir, "oak-mid.glb");
    const ioError = Object.assign(new Error("injected EIO reading sibling"), { code: "EIO" });
    fsProbe.statFailure = { path: sibling, error: ioError };
    try {
      const caught = await cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb: nearPath } },
        out: dir,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      // The exact error reaches the caller; it is not swallowed as a missing sibling.
      expect(caught).toBe(ioError);
      await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
    } finally {
      fsProbe.statFailure = undefined;
    }
  });

  it("names a placement that is mirrored in Z as a contact failure", async () => {
    const state = evaluatedTerrain();
    const spacing = state.size / (state.resolution - 1);
    // A deterministic north-to-south ramp makes mirroring change the ground by half the map size.
    state.height.set(
      Array.from(state.height, (_, i) => Math.floor(i / state.resolution) * spacing),
    );
    const first = state.instances[0];
    assert.ok(first);
    const item = {
      ...first,
      position: [0, state.size / 4, -state.size / 4] as [number, number, number],
    };
    const mirrored = {
      ...item,
      position: [item.position[0], item.position[1], -item.position[2]] as [number, number, number],
    };
    const error = await cookTerrainWorld({
      state: { ...state, instances: [mirrored] },
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    }).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error?.message).toContain(
      `Placement '${item.id}' of species 'fir' contact check failed`,
    );
    expect(error?.message).toContain("mirrored-Z");
  });

  it("checks ground contact against the quantized heightmap, not the horizontal spacing", async () => {
    const state = evaluatedTerrain();
    // A real relief, so one uint16 height step is a meaningful, non-zero tolerance.
    const spacing = state.size / (state.resolution - 1);
    state.height.set(
      Array.from(state.height, (_, i) => Math.floor(i / state.resolution) * spacing),
    );
    const species = { fir: { glb: await simpleSpecies() } };
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const height of state.height) {
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
    // One uint16 step of the heightmap range the bake writes.
    const quantStep = (max - min) / 65_535;
    const first = state.instances[0];
    assert.ok(first);
    const groundY = sampleHeight(state, first.position[0], first.position[2]);
    const at = (delta: number): [number, number, number] => [
      first.position[0],
      groundY + delta,
      first.position[2],
    ];
    const posed = (delta: number, grounding: boolean): ITerrainState => ({
      ...state,
      instances: [
        {
          ...first,
          transform: {
            position: at(delta),
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            grounding,
          },
        },
      ],
    });

    // A sub-texel hop passes: below one uint16 height step.
    await expect(
      cookTerrainWorld({
        state: posed(quantStep * 0.25, true),
        species,
        out: path.join(dir, "sub"),
      }),
    ).resolves.toBeDefined();

    // A real offset above one height step fails by name, with no output written.
    const error = await cookTerrainWorld({
      state: posed(quantStep * 4, true),
      species,
      out: path.join(dir, "lift"),
    }).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error?.message).toContain(
      `Placement '${first.id}' of species 'fir' contact check failed`,
    );
    await expect(stat(path.join(dir, "lift", "world.glb"))).rejects.toThrow();

    // The authored grounding override is honored: the same lifted pose is skipped.
    await expect(
      cookTerrainWorld({
        state: posed(quantStep * 4, false),
        species,
        out: path.join(dir, "override"),
      }),
    ).resolves.toBeDefined();
  });

  it("writes a world package core's validator accepts, with a GLB and a LOD per species", async () => {
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    });

    const manifest = JSON.parse(
      await readFile(path.join(dir, "world.json"), "utf8"),
    ) as IWorldPackage;
    const placements = new Uint8Array(await readFile(path.join(dir, "placements.bin")));
    const placementIds = new Uint8Array(await readFile(path.join(dir, "placement-ids.json")));
    const heightmap = new Uint8Array(await readFile(path.join(dir, "heightmap.u16")));
    const validation = validateWorldPackage(manifest, {
      placementsByteLength: placements.byteLength,
      heightmapByteLength: heightmap.byteLength,
    });
    expect(result.worldPackage?.manifest).toBe(result.manifest);
    expect(result.worldPackage?.files["heightmap.u16"]).toEqual(heightmap);
    expect(result.worldPackage?.files["placements.bin"]).toEqual(placements);
    expect(result.worldPackage?.files["placement-ids.json"]).toEqual(placementIds);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);

    // Every species lists a model, at least one LOD, and the bytes the manifest names exist.
    for (const [id, asset] of Object.entries(manifest.assets)) {
      expect(asset.glb).toBe(`models/${id}.glb`);
      expect(asset.lods?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
    for (const asset of Object.values(result.manifest.assets)) {
      expect((await stat(path.join(dir, asset.glb))).size).toBeGreaterThan(0);
      for (const lod of asset.lods ?? [])
        expect((await stat(path.join(dir, lod.glb))).size).toBeGreaterThan(0);
    }
  });

  it("keeps the node count and all-scene census constant from 1 000 to 10 000 placements", async () => {
    const base = evaluatedTerrain();
    const withPlacements = (count: number): ITerrainState => ({
      ...base,
      instances: Array.from({ length: count }, (_, i) => {
        const placement = base.instances[i % base.instances.length];
        assert.ok(placement);
        return { ...placement, id: `fir_${i}` };
      }),
    });
    const species = { fir: { glb: await simpleSpecies() } };

    const small = await cookTerrainWorld({
      state: withPlacements(1_000),
      species,
      out: path.join(dir, "1k"),
    });
    const large = await cookTerrainWorld({
      state: withPlacements(10_000),
      species,
      out: path.join(dir, "10k"),
    });

    expect(large.nodeCount).toBe(small.nodeCount);
    expect(small.instancedMeshCount).toBe(1);
    expect(large.instancedMeshCount).toBe(1);
    expect(large.placementCounts.fir).toBe(10_000);

    // The authoritative walk: the default scene plus the generated alternate-LOD scene.
    const census = await loadScenes(large.worldGlb);
    expect(census.scenes.map((scene) => scene.name)).toEqual(["TerrainWorld", "fir_lod1"]);
    const allNodes = census.scenes.flatMap((scene) => instancedNodes(scene));
    expect(allNodes).toEqual([
      { name: "fir_instances", instances: 10_000 },
      { name: "fir_lod1_instances", instances: 10_000 },
    ]);
    // The default scene carries the near LOD only.
    expect(instancedNodes(census.scene)).toEqual([{ name: "fir_instances", instances: 10_000 }]);
  });

  it("holds near nodes in the default scene and one node per species-and-LOD pair in named scenes", async () => {
    const state = evaluatedTerrain(["fir", "boulder"]);
    const near = await simpleSpecies();
    const authoredLod = await simpleSpecies();
    const result = await cookTerrainWorld({
      state,
      species: {
        fir: { glb: near }, // generated LOD
        boulder: { glb: near, lods: [{ distance: 45, glb: authoredLod }] }, // authored LOD
      },
      out: dir,
    });

    const counts: Record<string, number> = {
      fir: state.instances.filter((i) => i.asset === "fir").length,
      boulder: state.instances.filter((i) => i.asset === "boulder").length,
    };

    const census = await loadScenes(result.worldGlb);
    // One default scene plus one named scene per alternate LOD.
    expect(census.scenes.map((scene) => scene.name)).toEqual([
      "TerrainWorld",
      "fir_lod1",
      "boulder_lod1",
    ]);
    // Default scene: only the near nodes, each rendering every placement once.
    expect(instancedNodes(census.scene)).toEqual([
      { name: "boulder_instances", instances: counts.boulder },
      { name: "fir_instances", instances: counts.fir },
    ]);
    // Every species-and-LOD pair is exactly one node, with all logical placements.
    expect(instancedNodes(census.scenes[1] as Group)).toEqual([
      { name: "fir_lod1_instances", instances: counts.fir },
    ]);
    expect(instancedNodes(census.scenes[2] as Group)).toEqual([
      { name: "boulder_lod1_instances", instances: counts.boulder },
    ]);
    // The compatibility stat counts the default scene only; the all-scene walk is authoritative.
    expect(result.instancedMeshCount).toBe(2);
  });
});
