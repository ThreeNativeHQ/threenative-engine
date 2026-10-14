import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRLightsPunctual } from "@gltf-transform/extensions";
import { read as readKtx2 } from "ktx-parse";
import { TorusKnotGeometry } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  buildFixtureDocument,
  buildFixtureGlb,
} from "../../../test-support/generate-fixture-model.js";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { type IAssetSourceConfig, compileAssets } from "../src/index.js";
import { decodeAstcKtx2 } from "../src/ktx2-encoder.js";
import { modelPass } from "../src/passes/model.js";
import { unpackGlb } from "../src/passes/shared-images.js";
import { sine, wavClip } from "./audio-fixtures.js";

const TRANSCODER = basisTranscoderPaths();
const THREE_INSTALL = path.resolve(import.meta.dirname, "../node_modules/three");

async function installThree(root: string): Promise<void> {
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(THREE_INSTALL, path.join(root, "node_modules/three"));
}

async function lightmapFixtureGlb(): Promise<Buffer> {
  const source = await readFile(
    new URL("../../create-threenative/templates/starter/assets/native-proof.glb", import.meta.url),
  );
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(source);
  const extension = document.createExtension(KHRLightsPunctual);
  const light = extension.createLight("bake-light").setType("point").setIntensity(1);
  document
    .getRoot()
    .listScenes()[0]
    ?.addChild(
      document
        .createNode("bake-light")
        .setTranslation([0, 3, 0])
        .setExtension("KHR_lights_punctual", light),
    );
  return Buffer.from(await io.writeBinary(document));
}

/**
 * A torus knot, the shape `virtual-pass.spec.ts` settled on: closed, indexed, every vertex
 * referenced. A sphere leaves two pole vertices no triangle uses and the pass's self-verify
 * fails on a drift that has nothing to do with the config key under test.
 */
async function torusKnotGlb(tubularSegments: number, radialSegments: number): Promise<Buffer> {
  const geometry = new TorusKnotGeometry(1, 0.4, tubularSegments, radialSegments);
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(Float32Array.from(geometry.attributes.position?.array ?? []))
    .setBuffer(buffer);
  const normal = document
    .createAccessor()
    .setType("VEC3")
    .setArray(Float32Array.from(geometry.attributes.normal?.array ?? []))
    .setBuffer(buffer);
  const indices = document
    .createAccessor()
    .setType("SCALAR")
    .setArray(Uint32Array.from(geometry.index?.array ?? []))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setIndices(indices)
    .setMaterial(document.createMaterial("rock"));
  scene.addChild(
    document.createNode("face").setMesh(document.createMesh("face").addPrimitive(primitive)),
  );
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/** 65,536 triangles: the density the bake turns itself on at. */
async function denseFixtureGlb(): Promise<Buffer> {
  return torusKnotGlb(512, 64);
}

/** 2,048 triangles: far under the default, so a bake here can only come from the config. */
async function sparseFixtureGlb(): Promise<Buffer> {
  return torusKnotGlb(64, 16);
}

async function singleImageFixtureGlb(gridDepth = 3): Promise<Buffer> {
  const document = buildFixtureDocument({ gridDepth });
  const cloth = document
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === "cloth");
  const normalMap = document
    .getRoot()
    .listTextures()
    .find((texture) => texture.getName() === "cloth-normal");
  if (cloth === undefined || normalMap === undefined)
    throw new Error("the fixture model no longer has its expected normal map");
  cloth.setNormalTexture(null);
  normalMap.dispose();
  return Buffer.from(await new NodeIO().writeBinary(document));
}

describe("compileAssets", () => {
  it("lists a cooked terrain GLB byte-identically without invoking model passes", async () => {
    const root = await makeTempDir("threenative-cooked-world-");
    await mkdir(path.join(root, "assets/worlds/forest"), { recursive: true });
    const doc = await buildFixtureDocument();
    doc.getRoot().getAsset().extras = { tnTerrainWorld: 1 };
    const cooked = Buffer.from(await new NodeIO().writeBinary(doc));
    await writeFile(path.join(root, "assets/worlds/forest/world.glb"), cooked);
    await writeFile(path.join(root, "assets/ordinary.glb"), await buildFixtureGlb());
    const apply = vi.fn((input: Buffer) => input);
    await compileAssets({
      cwd: root,
      passes: [{ name: "encode-probe", appliesTo: ["model"], apply }],
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    );
    const entry = manifest.entries["worlds/forest/world.glb"];
    expect(entry).toMatchObject({ kind: "model", bytes: cooked.length, passes: [] });
    expect(await readFile(path.join(root, "public", entry.output))).toEqual(cooked);
    expect(apply.mock.calls).toHaveLength(1);
    expect(manifest.entries["ordinary.glb"].passes).toEqual(["encode-probe"]);
    const malformed = Buffer.from(cooked);
    malformed.writeUInt32LE(cooked.length + 4, 8);
    await writeFile(path.join(root, "assets/worlds/forest/world.glb"), malformed);
    await expect(compileAssets({ cwd: root, passes: [] })).rejects.toThrow(/GLB/);
  });

  it.each([
    { platform: "desktop", models: "none" },
    { platform: "android", models: "none" },
    { platform: "ios", models: "none" },
    { platform: "desktop", models: undefined },
  ] as const)(
    "normalizes cooked terrain layout on $platform (models: $models) without reauthoring or reusing web output",
    async ({ platform, models }) => {
      const root = await makeTempDir("threenative-cooked-world-native-");
      await mkdir(path.join(root, "assets"));
      const doc = buildFixtureDocument();
      const material = doc.getRoot().listMaterials()[0];
      if (!material) throw new Error("fixture must contain a material");
      doc.createMaterial().copy(material);
      doc.getRoot().getAsset().extras = { tnTerrainWorld: 1 };
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      const cooked = Buffer.from(await io.writeBinary(doc));
      await writeFile(path.join(root, "assets/world.glb"), cooked);
      const config = { models, textures: "none", audio: "none", lod: false } as const;
      const readEntry = async () => {
        const manifest = JSON.parse(
          await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
        );
        return manifest.entries["world.glb"];
      };
      await compileAssets({ cwd: root, config, platform: "web" });
      const web = await readEntry();
      expect(await readFile(path.join(root, "public", web.output))).toEqual(cooked);
      const native = await compileAssets({ cwd: root, config, platform });
      const entry = await readEntry();
      expect(native.skipped).toBe(0);
      expect(entry.output).not.toBe(web.output);
      expect(entry.passes).toEqual(["model"]);
      expect(native.passCosts.find((row) => row.pass === "model")).toMatchObject({
        ranInputs: 1,
        cachedInputs: 0,
        status: "ran",
        assets: [{ logicalPath: "world.glb", durationMs: expect.any(Number) }],
      });
      expect(native.receipt?.outputs.find((output) => output.path === entry.output)?.producer).toBe(
        "model",
      );
      const output = await readFile(path.join(root, "public", entry.output));
      const json = (await io.binaryToJSON(output)).json;
      const original = (await io.binaryToJSON(cooked)).json;
      expect(json.materials).toEqual(original.materials);
      expect(json.asset.extras).toEqual(original.asset.extras);
      const accessors = json.accessors ?? [];
      for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
          const attributes = Object.values(primitive.attributes ?? {});
          expect(new Set(attributes.map((index) => accessors[index]?.bufferView)).size).toBe(
            attributes.length,
          );
        }
      }
      const restored = await io.readBinary(output);
      expect(
        restored
          .getRoot()
          .listTextures()
          .map((texture) => Array.from(texture.getImage() ?? [])),
      ).toEqual(
        doc
          .getRoot()
          .listTextures()
          .map((texture) => Array.from(texture.getImage() ?? [])),
      );
      const geometry = (document: typeof doc) =>
        document
          .getRoot()
          .listMeshes()
          .map((mesh) =>
            mesh.listPrimitives().map((primitive) => ({
              attributes: primitive.listAttributes().map((attribute) => attribute.getArray()),
              indices: primitive.getIndices()?.getArray(),
            })),
          );
      expect(geometry(restored)).toEqual(geometry(doc));
      const cached = await compileAssets({ cwd: root, config, platform });
      expect(cached.skipped).toBe(1);
      expect(cached.passCosts.find((row) => row.pass === "model")).toMatchObject({
        ranInputs: 0,
        cachedInputs: 1,
        status: "cached",
        assets: [],
      });
      expect(await readEntry()).toEqual(entry);
    },
  );

  it("should omit an excluded model from the manifest and report saved bytes", async () => {
    const root = await makeTempDir("threenative-exclude-");
    await mkdir(path.join(root, "assets/unused"), { recursive: true });
    const model = await buildFixtureGlb();
    await writeFile(path.join(root, "assets/unused/library.glb"), model);
    await writeFile(path.join(root, "assets/keep.txt"), "keep");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const config = { audio: "none", models: "none", textures: "none" } as const;
    await compileAssets({ cwd: root, config });
    const before = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    );
    expect(before.entries["unused/library.glb"]).toBeDefined();
    await compileAssets({ cwd: root, config: { ...config, exclude: ["unused/**"] } });
    const after = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    );
    expect(after.entries["unused/library.glb"]).toBeUndefined();
    expect(after.entries["keep.txt"]).toBeDefined();
    await expect(
      stat(path.join(root, "public", before.entries["unused/library.glb"].output)),
    ).rejects.toThrow();
    expect(lines).toContain(`TN_ASSETS_EXCLUDED: 1 file(s), ${model.length} bytes`);
    expect(lines).toContain("TN_ASSETS_EXCLUDED: 0 file(s), 0 bytes");
  });

  it.each(["unused/**", [4], [""]])("should reject invalid exclude %j", async (exclude) => {
    await expect(
      compileAssets({ config: { exclude } as unknown as IAssetSourceConfig }),
    ).rejects.toThrow("TN_ASSETS_CONFIG_INVALID");
  });

  it("should write a hashed output and a manifest entry when an input exists", async () => {
    const root = await makeTempDir("threenative-compile-hashed-");
    await mkdir(path.join(root, "assets"));
    // A permissive floor isolates hashed publication from the quality-selection tests.
    const source = rgbaPng({
      blue: (x, y) => (x * 31 + y * 17) % 256,
      green: (x, y) => (x * 7 + y * 29) % 256,
      height: 128,
      red: (x, y) => (x * 13 + y * 11) % 256,
      width: 128,
    });
    await writeFile(path.join(root, "assets", "rock.png"), source);

    const result = await compileAssets({
      cwd: root,
      transcoder: TRANSCODER,
      config: { textures: { floor: { ssim: 0, meanDeltaE00: 100 } } },
    });

    expect(result.written).toBe(1);
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe(1);
    const entry = manifest.entries["rock.png"];
    expect(entry.output).toMatch(/^rock\.[0-9a-f]{8}\.ktx2$/u);
    expect(entry.kind).toBe("texture");
    expect(entry.format).toBe("etc1s");
    expect(entry.transcodeTargets).toEqual(["bc1", "etc2"]);
    expect(entry.passes).toEqual(["audio", "ktx2", "model"]);
    expect(entry.bytesBefore).toBe(source.length);
    expect(entry.bytesAfter).toBeLessThan(source.length);
    expect(entry.bytes).toBe(entry.bytesAfter);
    const compiled = await readFile(path.join(root, "public", entry.output));
    expect([...compiled.subarray(1, 7)].map((byte) => String.fromCharCode(byte)).join("")).toBe(
      "KTX 20",
    );
  });

  it("should report the bytes an assets.textures override ships uncompressed", async () => {
    // `/AGENTS.md`: turning a convention off must not turn its measurement off. One shipped game
    // carried 2,003 MB of manifest output with zero .ktx2 in it because this value was copied out
    // of a template and never revisited, and the build said nothing for weeks.
    const root = await makeTempDir("threenative-compile-skipped-textures-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({
      blue: (x, y) => (x * 31 + y * 17) % 256,
      green: (x, y) => (x * 7 + y * 29) % 256,
      height: 64,
      red: (x, y) => (x * 13 + y * 11) % 256,
      width: 64,
    });
    await writeFile(path.join(root, "assets", "rock.png"), source);
    await writeFile(path.join(root, "assets", "wall.png"), source);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => lines.push(String(line)));

    const result = await compileAssets({
      config: { textures: "none" } satisfies IAssetSourceConfig,
      cwd: root,
      transcoder: TRANSCODER,
    });

    expect(result.skippedCompression).toEqual([
      { bytes: source.length * 2, files: 2, kind: "texture", reason: "config" },
    ]);
    expect(
      lines.some((line) => line.startsWith("TN_ASSETS_COMPRESSION_SKIPPED texture: 2 file(s)")),
    ).toBe(true);
  });

  it("should cook decoder-free ASTC on mobile while web keeps Basis", async () => {
    // ASTC needs no runtime decoder; model Basis/Meshopt remain unavailable.
    const root = await makeTempDir("threenative-compile-platform-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({
      blue: (x, y) => (x * 31 + y * 17) % 256,
      green: (x, y) => (x * 7 + y * 29) % 256,
      height: 64,
      red: (x, y) => (x * 13 + y * 11) % 256,
      width: 64,
    });
    await writeFile(path.join(root, "assets", "rock.png"), source);

    const mobile = await compileAssets({
      cwd: root,
      platform: "android",
      transcoder: TRANSCODER,
      config: { textures: { floor: { ssim: 0, meanDeltaE00: 100 } } },
    });
    const mobileManifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string }> };

    expect(mobileManifest.entries["rock.png"]?.output).toMatch(/\.ktx2$/u);
    expect(mobile.skippedCompression).toEqual([
      {
        bytes: 0,
        decoders: ["meshopt"],
        files: 0,
        kind: "model",
        reason: "platform",
      },
    ]);

    expect(
      mobile.skippedCompression.flatMap((row) => ("decoders" in row ? row.decoders : [])),
    ).not.toContain("KTX2");

    // The same config, the target that can decode it: compression ships.
    await rm(path.join(root, "public"), { force: true, recursive: true });
    await compileAssets({
      cwd: root,
      platform: "web",
      transcoder: TRANSCODER,
      config: { textures: { floor: { ssim: 0, meanDeltaE00: 100 } } },
    });
    const webManifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string }> };

    expect(webManifest.entries["rock.png"]?.output).toMatch(/\.ktx2$/u);
  });

  it.each([
    ["android", false],
    ["android", true],
    ["ios", false],
    ["ios", true],
  ] as const)(
    "cooks embedded ASTC on %s with ktx2=%s while retaining Meshopt",
    async (platform, ktx2) => {
      const root = await makeTempDir("threenative-embedded-astc-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "character.glb"), await singleImageFixtureGlb());
      const result = await compileAssets({
        cwd: root,
        platform,
        runtimeDecoders: { ktx2, meshopt: true },
        config: {
          budget: "none",
          textures: "none",
          lod: "none",
          models: {
            sharedImages: false,
            compact: false,
            virtual: "none",
            textures: { overrides: [{ slot: "baseColorTexture", codec: "etc1s" }] },
          },
        },
      });
      expect(result.skippedCompression.filter((row) => row.kind === "model")).toEqual([]);
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      const bytes = await readFile(
        path.join(root, "public", manifest.entries["character.glb"].output),
      );
      const { json, bin } = unpackGlb(bytes);
      expect(json.extensionsRequired).toContain("EXT_texture_astc");
      expect(json.extensionsUsed).not.toContain("KHR_texture_basisu");
      expect(json.extensionsRequired).toContain("EXT_meshopt_compression");
      const texture = json.textures?.[0];
      const source = (texture?.extensions?.EXT_texture_astc as { source: number }).source;
      expect(texture?.source).toBeUndefined();
      const image = json.images?.[source];
      const view = json.bufferViews?.[image?.bufferView ?? -1];
      if (!view || !bin) throw new Error("embedded ASTC view missing");
      const astc = readKtx2(
        bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
      );
      expect(astc.vkFormat).toBe(158);
      expect(astc.supercompressionScheme).toBe(0);
      expect(astc.levelCount).toBe(
        Math.floor(Math.log2(Math.max(astc.pixelWidth, astc.pixelHeight))) + 1,
      );
      expect(astc.dataFormatDescriptor[0]?.colorPrimaries).toBe(1);
      await compileAssets({
        cwd: root,
        platform,
        runtimeDecoders: { ktx2, meshopt: true },
        config: {
          budget: "none",
          textures: "none",
          lod: "none",
          models: {
            sharedImages: false,
            compact: false,
            virtual: "none",
            textures: "none",
          },
        },
      });
      const disabled = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      const disabledJson = unpackGlb(
        await readFile(path.join(root, "public", disabled.entries["character.glb"].output)),
      ).json;
      expect(disabledJson.extensionsUsed).not.toContain("EXT_texture_astc");
      expect(disabledJson.images?.map((image) => image.mimeType)).toEqual(["image/png"]);
    },
  );

  it.each([
    ["android", true, true],
    ["android", true, false],
    ["android", false, true],
    ["android", false, false],
    ["ios", true, true],
    ["ios", true, false],
    ["ios", false, true],
    ["ios", false, false],
    ["web", true, false],
    ["desktop", true, false],
  ] as const)(
    "honours standalone decoder capabilities on %s with ktx2=%s meshopt=%s",
    async (platform, ktx2, meshopt) => {
      const root = await makeTempDir("threenative-texture-decoder-map-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ width: 16, height: 16 }));
      const result = await compileAssets({
        cwd: root,
        platform,
        runtimeDecoders: { ktx2, meshopt },
        transcoder: TRANSCODER,
        config: {
          models: "none",
          textures: {
            floor: { ssim: 0, meanDeltaE00: 100 },
            overrides: [{ glob: "rock.png", codec: "etc1s" }],
          },
        },
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { output: string; format: string }> };
      const entry = manifest.entries["rock.png"];
      if (entry === undefined) throw new Error("fixture texture is missing from the manifest");
      const mobile = platform === "android" || platform === "ios";
      const bytes = await readFile(path.join(root, "public", entry.output));
      const container = readKtx2(bytes);
      expect(container.vkFormat).toBe(mobile ? 158 : 0);
      expect(entry.format).toBe(mobile ? "astc4x4" : "etc1s");
      expect(container.levelCount).toBeGreaterThan(1);
      if (mobile) {
        expect(container.supercompressionScheme).toBe(0);
        expect(container.levelCount).toBe(
          Math.floor(Math.log2(Math.max(container.pixelWidth, container.pixelHeight))) + 1,
        );
        await expect(
          decodeAstcKtx2(bytes, container.pixelWidth, container.pixelHeight),
        ).resolves.toHaveLength(container.pixelWidth * container.pixelHeight * 4);
      }
      expect(result.skippedCompression.filter((row) => row.kind === "texture")).toEqual([]);
      for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
        const output = path.join(root, "public", "basis", name);
        if (ktx2 && !mobile) expect((await stat(output)).size).toBeGreaterThan(0);
        else await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)(
    "retains the custom decoder contract with ktx2=%s meshopt=%s",
    async (ktx2, meshopt) => {
      const root = await makeTempDir("threenative-custom-decoder-map-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "rock.txt"), "asset");
      const apply = vi.fn((input: Buffer) => input);
      const result = await compileAssets({
        cwd: root,
        platform: "android",
        runtimeDecoders: { ktx2, meshopt },
        passes: [{ name: "decoder-dependent", needsRuntimeDecoder: true, apply }],
      });
      expect(apply).toHaveBeenCalledTimes(ktx2 && meshopt ? 1 : 0);
      expect(result.skippedCompression).toEqual(
        ktx2 && meshopt ? [] : [{ kind: "pass", pass: "decoder-dependent", reason: "platform" }],
      );
    },
  );

  it.each([
    ["android", "codec"],
    ["android", "textures"],
    ["ios", "codec"],
    ["ios", "textures"],
  ] as const)("keeps the mobile %s %s-none kill switch", async (platform, disabled) => {
    const root = await makeTempDir("threenative-mobile-texture-none-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({ width: 16, height: 16 });
    await writeFile(path.join(root, "assets", "rock.png"), source);
    for (const runtimeDecoders of [undefined, { ktx2: true, meshopt: false }]) {
      await compileAssets({
        cwd: root,
        platform,
        runtimeDecoders,
        transcoder: TRANSCODER,
        config: {
          models: "none",
          textures:
            disabled === "textures"
              ? "none"
              : { maxSize: 4, overrides: [{ glob: "rock.png", codec: "none" }] },
        },
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { output: string }> };
      const entry = manifest.entries["rock.png"];
      if (entry === undefined) throw new Error("fixture texture is missing from the manifest");
      expect(entry.output).toMatch(/\.png$/u);
      expect(await readFile(path.join(root, "public", entry.output))).toEqual(source);
    }
  });

  it("should let a caller that probed the runtime drop decoders on desktop too", async () => {
    // A desktop host is V8 except on the Linux arm64 lane, which builds QuickJS over wgpu-native.
    // `platform: "desktop"` alone would keep meshopt/KTX2 and ship an asset the runtime cannot
    // decode; the build reads the engine from the runtime binary and passes the real capability.
    const root = await makeTempDir("threenative-compile-runtime-decoders-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({
      blue: (x, y) => (x * 3 + y * 5) % 256,
      green: (x, y) => (x * 11 + y * 7) % 256,
      height: 32,
      red: (x, y) => (x * 17 + y * 13) % 256,
      width: 32,
    });
    await writeFile(path.join(root, "assets", "rock.png"), source);

    const result = await compileAssets({
      cwd: root,
      platform: "desktop",
      runtimeDecoders: { ktx2: false, meshopt: false },
      transcoder: TRANSCODER,
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string }> };

    expect(manifest.entries["rock.png"]?.output).toMatch(/\.png$/u);
    expect(result.skippedCompression).toContainEqual({
      bytes: source.length,
      files: 1,
      kind: "texture",
      reason: "platform",
    });
  });

  it("should write separate model attribute buffers for desktop native output", async () => {
    const root = await makeTempDir("threenative-compile-desktop-layout-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "character.glb"),
      await buildFixtureGlb({ textured: false }),
    );

    await compileAssets({
      config: {
        models: {
          passes: { dedup: false, meshopt: false, prune: false, quantize: false, reorder: false },
          textures: "none",
          virtual: "none",
        },
        textures: "none",
      },
      cwd: root,
      platform: "desktop",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string }> };
    const entry = manifest.entries["character.glb"];
    if (entry === undefined) throw new Error("compile manifest is missing character.glb");
    const json = (
      await new NodeIO().binaryToJSON(await readFile(path.join(root, "public", entry.output)))
    ).json;
    const accessors = json.accessors ?? [];
    for (const mesh of json.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        const views = new Set(
          Object.values(primitive.attributes ?? {})
            .map((index) => accessors[index]?.bufferView)
            .filter((view): view is number => view !== undefined),
        );
        expect(views.size).toBe(Object.keys(primitive.attributes ?? {}).length);
      }
    }
  });

  it("should share images on an android build while retaining decoder-free model work", async () => {
    const root = await makeTempDir("threenative-compile-android-shared-");
    await mkdir(path.join(root, "assets"));
    // Different geometry, same image: two models that share an image, which is the subject of
    // both native lanes. A byte-identical copy would be one model under two names
    // (TN_ASSET_MODEL_DEDUPE), so there would be nothing to share.
    await writeFile(path.join(root, "assets", "one.glb"), await singleImageFixtureGlb());
    await writeFile(path.join(root, "assets", "two.glb"), await singleImageFixtureGlb(4));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    try {
      const result = await compileAssets({
        config: { budget: "none" },
        concurrency: 2,
        cwd: root,
        platform: "android",
      });
      expect(result.written).toBe(2);

      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as {
        entries: Record<
          string,
          {
            output: string;
            extensions?: string[];
            sharedImages?: { codec: string; output: string }[];
          }
        >;
      };
      for (const logical of ["one.glb", "two.glb"]) {
        const entry = manifest.entries[logical];
        expect(entry?.extensions ?? []).not.toContain("EXT_meshopt_compression");
        expect(entry?.sharedImages).toHaveLength(1);
        expect(entry?.sharedImages?.[0]?.codec).toBe("none");
        expect(entry?.sharedImages?.[0]?.output).toMatch(
          /^shared\/images\/[0-9a-f]{16}\.none\.png$/u,
        );
        const output = await readFile(path.join(root, "public", entry?.output ?? ""));
        const { json } = unpackGlb(output);
        const attributesPerView = new Map<number, Set<number>>();
        for (const mesh of json.meshes ?? []) {
          for (const primitive of mesh.primitives ?? []) {
            for (const accessor of Object.values(primitive.attributes ?? {})) {
              const view = json.accessors?.[accessor]?.bufferView;
              if (view === undefined) continue;
              const seen = attributesPerView.get(view) ?? new Set<number>();
              seen.add(accessor);
              attributesPerView.set(view, seen);
            }
          }
        }
        expect([...attributesPerView.values()].every((seen) => seen.size <= 1)).toBe(true);
      }
      const shared = await readdir(path.join(root, "public", "shared", "images"));
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatch(/\.none\.png$/u);
      expect(lines.join("\n")).toContain("meshopt");
      expect(lines.join("\n")).not.toContain("KTX2");
      expect(result.skippedCompression.find((row) => row.kind === "model")).toMatchObject({
        decoders: ["meshopt"],
      });
      expect(lines.join("\n")).not.toContain("dedupe");
    } finally {
      log.mockRestore();
    }
  });

  it("should not report decoder-backed model work that the config already disabled", async () => {
    const root = await makeTempDir("threenative-compile-mobile-report-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "character.glb"), await buildFixtureGlb());
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    try {
      await compileAssets({
        config: { models: { passes: { meshopt: false }, textures: "none" } },
        cwd: root,
        platform: "android",
      });

      expect(lines.some((line) => line.startsWith("TN_ASSETS_COMPRESSION_SKIPPED model:"))).toBe(
        false,
      );
    } finally {
      log.mockRestore();
    }
  });

  it("should share images on an ios build", async () => {
    const root = await makeTempDir("threenative-compile-ios-shared-");
    await mkdir(path.join(root, "assets"));
    // Different geometry, same image: two models that share an image, which is the subject of
    // both native lanes. A byte-identical copy would be one model under two names
    // (TN_ASSET_MODEL_DEDUPE), so there would be nothing to share.
    await writeFile(path.join(root, "assets", "one.glb"), await singleImageFixtureGlb());
    await writeFile(path.join(root, "assets", "two.glb"), await singleImageFixtureGlb(4));

    await compileAssets({
      config: { budget: "none" },
      concurrency: 2,
      cwd: root,
      platform: "ios",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as {
      entries: Record<string, { extensions?: string[]; sharedImages?: { codec: string }[] }>;
    };
    for (const logical of ["one.glb", "two.glb"]) {
      const entry = manifest.entries[logical];
      expect(entry?.extensions ?? []).not.toContain("EXT_meshopt_compression");
      expect(entry?.sharedImages).toHaveLength(1);
      expect(entry?.sharedImages?.[0]?.codec).toBe("none");
    }
    expect(await readdir(path.join(root, "public", "shared", "images"))).toHaveLength(1);
  });

  it("should keep web output separate from a cached mobile compile", async () => {
    const root = await makeTempDir("threenative-compile-cross-target-cache-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "hero.glb"), await singleImageFixtureGlb());

    await compileAssets({
      config: { budget: "none" },
      cwd: root,
      platform: "android",
    });
    const mobileManifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { extensions?: string[]; output: string }> };
    const mobileEntry = mobileManifest.entries["hero.glb"];
    expect(mobileEntry?.extensions ?? []).not.toContain("EXT_meshopt_compression");

    const web = await compileAssets({
      config: { budget: "none" },
      cwd: root,
      platform: "web",
      transcoder: TRANSCODER,
    });
    const webManifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { extensions?: string[]; output: string }> };
    const webEntry = webManifest.entries["hero.glb"];

    expect(web.written).toBe(1);
    expect(web.skipped).toBe(0);
    expect(webEntry?.output).not.toBe(mobileEntry?.output);
    expect(webEntry?.extensions ?? []).toContain("EXT_meshopt_compression");
  });
  it("should decode compressed source for mobile output", async () => {
    const root = await makeTempDir("threenative-compile-android-source-");
    await mkdir(path.join(root, "assets"));
    const compressed = await modelPass({ textures: "none" }).apply(
      Buffer.from(await buildFixtureGlb({ textured: false })),
      "hero.glb",
    );
    if (Buffer.isBuffer(compressed)) throw new Error("the fixture was not compressed");
    await writeFile(path.join(root, "assets", "hero.glb"), compressed.buffer);

    await compileAssets({ config: { budget: "none" }, cwd: root, platform: "android" });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { extensions?: string[]; output: string }> };
    const entry = manifest.entries["hero.glb"];
    expect(entry?.extensions ?? []).not.toContain("EXT_meshopt_compression");
    const output = await readFile(path.join(root, "public", entry?.output ?? ""));
    expect(unpackGlb(output).json.extensionsUsed ?? []).not.toContain("EXT_meshopt_compression");
  });

  it("should report nothing when the texture pass is running", async () => {
    const root = await makeTempDir("threenative-compile-skipped-none-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({
        blue: (x, y) => (x * 31 + y * 17) % 256,
        green: (x, y) => (x * 7 + y * 29) % 256,
        height: 64,
        red: (x, y) => (x * 13 + y * 11) % 256,
        width: 64,
      }),
    );

    const result = await compileAssets({ cwd: root, transcoder: TRANSCODER });

    expect(result.skippedCompression).toEqual([]);
  });

  it("should throw when a pass throws", async () => {
    const root = await makeTempDir("threenative-compile-pass-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), "png");

    await expect(
      compileAssets({
        cwd: root,
        passes: [
          {
            name: "explode",
            apply: () => {
              throw new Error("boom");
            },
          },
        ],
      }),
    ).rejects.toThrow(/rock\.png/u);
  });

  it.each(["android", "ios", "web", "desktop"] as const)(
    "should filter decoder-dependent custom passes for %s",
    async (platform) => {
      const root = await makeTempDir(`threenative-compile-custom-${platform}-`);
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "rock.txt"), "asset");
      const invoked: string[] = [];
      const decoderDependent = {
        name: "decoder-dependent",
        needsRuntimeDecoder: true,
        apply: (input: Buffer) => {
          invoked.push("decoder-dependent");
          return input;
        },
      };
      const decoderFree = {
        name: "decoder-free",
        needsRuntimeDecoder: false,
        apply: (input: Buffer) => {
          invoked.push("decoder-free");
          return input;
        },
      };
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });

      try {
        const result = await compileAssets({
          cwd: root,
          passes: [decoderDependent, decoderFree],
          platform,
        });
        const manifest = JSON.parse(
          await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
        ) as { entries: Record<string, { passes: string[] }> };
        const expectedPasses =
          platform === "android" || platform === "ios"
            ? ["decoder-free"]
            : ["decoder-dependent", "decoder-free"];

        expect(result.written).toBe(1);
        expect(invoked).toEqual(expectedPasses);
        expect(manifest.entries["rock.txt"]?.passes).toEqual(expectedPasses);
        expect(result.skippedCompression).toEqual(
          platform === "android" || platform === "ios"
            ? [{ kind: "pass", pass: "decoder-dependent", reason: "platform" }]
            : [],
        );
        if (platform === "android" || platform === "ios") {
          expect(lines).toContain(
            "TN_ASSETS_PASS_SKIPPED decoder-dependent: omitted because the pass declares needsRuntimeDecoder=true and this target has no runtime decoder (reason: platform).",
          );
          expect(lines.some((line) => line.startsWith("TN_ASSETS_COMPRESSION_SKIPPED"))).toBe(
            false,
          );
        }
      } finally {
        log.mockRestore();
      }
    },
  );

  it("should content-address an auxiliary output and record its manifest path", async () => {
    const root = await makeTempDir("threenative-compile-auxiliary-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "level.glb"), Buffer.from(await buildFixtureGlb()));

    await compileAssets({
      cwd: root,
      passes: [
        {
          name: "lightmap-fixture",
          apply: (input) => ({
            auxiliaryOutputs: [
              {
                buffer: Buffer.from("ktx2"),
                extension: ".ktx2",
                manifestField: "lightmaps",
                metadata: { texCoord: 1 },
                role: "lightmap",
              },
            ],
            buffer: input,
          }),
        },
      ],
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const lightmap = manifest.entries["level.glb"].lightmaps[0];
    expect(lightmap).toMatchObject({ bytes: 4, texCoord: 1 });
    expect(lightmap.output).toMatch(/^level\.lightmap\.[0-9a-f]{8}\.ktx2$/u);
    expect(await readFile(path.join(root, "public", lightmap.output), "utf8")).toBe("ktx2");
  });

  it("should not rewrite an output whose hash is unchanged", async () => {
    const root = await makeTempDir("threenative-compile-idempotent-");
    await mkdir(path.join(root, "assets"));
    await installThree(root);
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    const first = await compileAssets({ cwd: root });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const output = path.join(root, "public", manifest.entries["rock.png"].output);
    const before = (await stat(output)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await compileAssets({ cwd: root });

    expect(second.written).toBe(0);
    expect(second.skipped).toBe(first.written);
    expect((await stat(output)).mtimeMs).toBe(before);
  });

  it("should throw TN_ASSETS_OVERLAP when the output nests inside the source", async () => {
    const root = await makeTempDir("threenative-compile-overlap-");
    await mkdir(path.join(root, "assets"));

    await expect(compileAssets({ config: { output: "assets/out" }, cwd: root })).rejects.toThrow(
      "TN_ASSETS_OVERLAP",
    );
    await expect(compileAssets({ cwd: root, output: "public", source: "public" })).rejects.toThrow(
      "TN_ASSETS_OVERLAP",
    );
  });

  it("should recompile when the texture quality changes instead of re-serving stale bytes", async () => {
    const root = await makeTempDir("threenative-compile-quality-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({
        blue: (x, y) => (x * 31 + y * 17) % 256,
        green: (x, y) => (x * 7 + y * 29) % 256,
        height: 128,
        red: (x, y) => (x * 13 + y * 11) % 256,
        width: 128,
      }),
    );

    await compileAssets({
      config: { textures: { quality: 255 } },
      cwd: root,
      transcoder: TRANSCODER,
    });
    const manifestPath = path.join(root, "public", "assets.manifest.json");
    const first = JSON.parse(await readFile(manifestPath, "utf8"));

    const second = await compileAssets({
      config: { textures: { quality: 40 } },
      cwd: root,
      transcoder: TRANSCODER,
    });
    const secondManifest = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(second.written).toBe(1);
    expect(secondManifest.entries["rock.png"].output).not.toBe(first.entries["rock.png"].output);
  });

  it("should recompile when standalone texture maxSize changes instead of re-serving stale bytes", async () => {
    const root = await makeTempDir("threenative-compile-texture-max-size-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 16, width: 16 }));

    await compileAssets({
      config: { textures: { maxSize: 12 } },
      cwd: root,
      transcoder: TRANSCODER,
    });
    const manifestPath = path.join(root, "public", "assets.manifest.json");
    const first = JSON.parse(await readFile(manifestPath, "utf8"));

    const second = await compileAssets({
      config: { textures: { maxSize: 8 } },
      cwd: root,
      transcoder: TRANSCODER,
    });
    const secondManifest = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(second.written).toBe(1);
    expect(secondManifest.entries["rock.png"].output).not.toBe(first.entries["rock.png"].output);
  });

  it("should publish an empty manifest when no source directory exists", async () => {
    const root = await makeTempDir("threenative-compile-absent-");

    const result = await compileAssets({ cwd: root });

    expect(result).toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
    expect(
      JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
  });

  it("should publish an empty manifest when the source directory is empty", async () => {
    const root = await makeTempDir("threenative-compile-empty-");
    await mkdir(path.join(root, "assets"));
    await compileAssets({ cwd: root });
    expect(
      JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
  });

  it("should throw when the source path exists but is not a directory", async () => {
    const root = await makeTempDir("threenative-compile-invalid-");
    await writeFile(path.join(root, "assets"), "not a directory");

    await expect(compileAssets({ cwd: root })).rejects.toThrow(/TN_ASSETS_SOURCE_INVALID/u);
  });

  it("should throw naming the asset when an input cannot be read", async () => {
    const root = await makeTempDir("threenative-compile-unreadable-");
    await mkdir(path.join(root, "assets"));
    const secret = path.join(root, "assets", "secret.png");
    await writeFile(secret, "png");
    await chmod(secret, 0o000);

    try {
      await expect(compileAssets({ cwd: root })).rejects.toThrow(
        /TN_ASSETS_INPUT_UNREADABLE.*secret\.png/u,
      );
    } finally {
      await chmod(secret, 0o644);
    }
  });

  it("should regenerate a deleted manifest instead of passing on its absence", async () => {
    const root = await makeTempDir("threenative-compile-regen-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({ height: 32, width: 32 });
    await writeFile(path.join(root, "assets", "rock.png"), source);
    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const firstName = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ).entries["rock.png"].output;
    await rm(path.join(root, "public", "assets.manifest.json"));

    // With no manifest to compare against the run rewrites — but the content-addressed
    // name must land on the exact bytes already on disk.
    const second = await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const output = path.join(root, "public", firstName);

    expect(second.written).toBe(1);
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    expect(manifest.entries["rock.png"].output).toBe(firstName);
    const compiled = await readFile(output);
    expect(compiled).toEqual(source);
  });

  it("should publish an empty manifest when the source holds only dotfiles", async () => {
    const root = await makeTempDir("threenative-compile-empty-source-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", ".gitkeep"), "");

    const result = await compileAssets({ cwd: root });

    expect(result).toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
    expect(
      JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
  });

  it("should empty the stale manifest once the last input is removed", async () => {
    const root = await makeTempDir("threenative-compile-stale-manifest-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));
    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    await rm(path.join(root, "assets", "rock.png"));

    await compileAssets({ cwd: root });

    expect(
      JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
  });

  it("should throw on unknown config keys and duplicate logical paths", async () => {
    const configured = await makeTempDir("threenative-compile-config-");
    await mkdir(path.join(configured, "assets"));
    // The cast is the point: TypeScript rejects this key statically, and the compile step
    // must still reject it at runtime for callers arriving through parsed config.
    const misconfigured = { bogus: "nope" } as IAssetSourceConfig;
    await expect(compileAssets({ config: misconfigured, cwd: configured })).rejects.toThrow(
      /bogus/u,
    );

    const duplicated = await makeTempDir("threenative-compile-duplicate-");
    await mkdir(path.join(duplicated, "assets"));
    await writeFile(
      path.join(duplicated, "assets", "rock.png"),
      rgbaPng({ height: 32, width: 32 }),
    );
    await symlink(".", path.join(duplicated, "assets", "self"), "dir");
    await expect(compileAssets({ cwd: duplicated })).rejects.toThrow(/duplicate/iu);
    await expect(compileAssets({ cwd: duplicated })).rejects.toThrow(/self/u);
  });

  it("should ship textures verbatim when assets.textures is none", async () => {
    const root = await makeTempDir("threenative-compile-none-");
    await mkdir(path.join(root, "assets"));
    const source = rgbaPng({ height: 64, width: 64 });
    await writeFile(path.join(root, "assets", "rock.png"), source);

    await compileAssets({ config: { textures: "none" }, cwd: root });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const entry = manifest.entries["rock.png"];
    expect(entry.output).toMatch(/^rock\.[0-9a-f]{8}\.png$/u);
    expect(entry.format).toBeUndefined();
    expect(entry.bytesBefore).toBeUndefined();
    // Textures: none — the model pass is the only built-in in this configuration.
    expect(entry.passes).toEqual(["audio", "model"]);
    expect((await readFile(path.join(root, "public", entry.output))).equals(source)).toBe(true);
    await expect(stat(path.join(root, "public", "basis"))).rejects.toThrow();
  });

  it("should copy three's Basis transcoder next to the compiled outputs", async () => {
    const root = await makeTempDir("threenative-compile-transcoder-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    await compileAssets({ cwd: root, transcoder: TRANSCODER });

    const basisJs = await readFile(path.join(root, "public", "basis", "basis_transcoder.js"));
    expect(basisJs.length).toBeGreaterThan(0);
    expect((await stat(path.join(root, "public", "basis", "basis_transcoder.wasm"))).isFile()).toBe(
      true,
    );
  });

  it("should reject unknown texture config keys and codec names at the assets layer", async () => {
    const root = await makeTempDir("threenative-compile-textures-config-");
    await mkdir(path.join(root, "assets"));

    const unknownKey = {
      textures: { quality: 150, unknown: true },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: unknownKey, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY.*assets\.textures\.unknown/u,
    );

    const badCodec = {
      textures: { overrides: [{ codec: "supercompressed", glob: "**/*.png" }] },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badCodec, cwd: root })).rejects.toThrow(
      /must be one of etc1s, none, uastc/u,
    );

    const badQuality = { textures: { quality: 900 } } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badQuality, cwd: root })).rejects.toThrow(
      /between 1 and 255/u,
    );

    for (const value of [0, -1, 1.5, "2048"]) {
      const badMaxSize = { textures: { maxSize: value } } as unknown as IAssetSourceConfig;
      await expect(compileAssets({ config: badMaxSize, cwd: root })).rejects.toThrow(
        /assets\.textures\.maxSize must be a positive integer/u,
      );
    }

    for (const maxSize of [
      null,
      [],
      { baseColorTexture: 0 },
      { normalTexture: 3 },
      { baseColorTexture: "2048" },
      { baseColorTexture: Number.POSITIVE_INFINITY },
      { mask: 1024 },
      { unknownTexture: 1024 },
    ]) {
      await expect(
        compileAssets({
          config: { textures: { maxSize } } as unknown as IAssetSourceConfig,
          cwd: root,
        }),
      ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID/u);
    }

    for (const value of [1, 2, 3]) {
      const tooSmallMaxSize = { textures: { maxSize: value } } as unknown as IAssetSourceConfig;
      await expect(compileAssets({ config: tooSmallMaxSize, cwd: root })).rejects.toThrow(
        /assets\.textures\.maxSize must be a positive integer of at least 4/u,
      );
    }
  });

  it("should optimize a model through the built-in registry and record the manifest fields", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await makeTempDir("threenative-compile-model-");
      await mkdir(path.join(root, "assets"));
      await installThree(root);
      const source = Buffer.from(await buildFixtureGlb());
      await writeFile(path.join(root, "assets", "character.glb"), source);

      const result = await compileAssets({ cwd: root });

      expect(result.written).toBe(1);
      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      );
      const entry = manifest.entries["character.glb"];
      expect(entry.output).toMatch(/^character\.[0-9a-f]{8}\.glb$/u);
      expect(entry.kind).toBe("model");
      expect(entry.passes).toEqual(["audio", "ktx2", "model"]);
      expect(entry.extensions).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
      expect(entry.triangles).toBe(20);
      expect(entry.vertices).toBe(18);
      expect(entry.bytesBefore).toBe(source.length);
      expect(entry.bytesAfter).toBeGreaterThan(0);
      expect(entry.bytes).toBe(entry.bytesAfter);
      const compiled = await readFile(path.join(root, "public", entry.output));
      // The compiled output is still a `.glb` — same container, compressed contents.
      expect(compiled.subarray(0, 4).toString("ascii")).toBe("glTF");

      // The size report prints the model rows after the texture rows.
      const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => /^model character\.glb \(/u.test(line))).toBe(true);
      expect(logged.some((line) => line.startsWith("models total:"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should run the configured lightmap UV pass through the built-in registry", async () => {
    const root = await makeTempDir("threenative-compile-lightmap-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "room.glb"), await lightmapFixtureGlb());

    await compileAssets({
      config: { models: { lightmap: { atlasSize: 128, padding: 2 } } },
      cwd: root,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const entry = manifest.entries["room.glb"];
    expect(entry.passes).toEqual(["audio", "ktx2", "lightmap-uv2", "model"]);
    expect(entry.lightmapAtlas).toMatchObject({ padding: 2, skippedMeshes: [] });
    expect(entry.lightmapAtlas.chartCount).toBeGreaterThan(0);
    expect(entry.lightmapAtlas.width).toBeGreaterThan(0);
    expect(entry.lightmapAtlas.height).toBeGreaterThan(0);
    expect(entry.lightmaps).toHaveLength(1);
    expect(entry.lightmaps[0]).toMatchObject({ format: "etc1s", texCoord: 1 });
    const lightmap = await readFile(path.join(root, "public", entry.lightmaps[0].output));
    expect(readKtx2(lightmap).levelCount).toBeGreaterThan(1);
    const compiled = await readFile(path.join(root, "public", entry.output));
    const json = JSON.parse(compiled.subarray(20, 20 + compiled.readUInt32LE(12)).toString("utf8"));
    expect(json.meshes[0].primitives[0].attributes.TEXCOORD_1).toEqual(expect.any(Number));
  });

  it.each([
    ["android", false],
    ["android", true],
    ["ios", false],
    ["ios", true],
  ] as const)(
    "cooks linear lightmaps on %s with decoder capabilities=%s across workers and cache changes",
    async (platform, decoders) => {
      const root = await makeTempDir("threenative-mobile-lightmap-");
      await mkdir(path.join(root, "assets"));
      const input = await lightmapFixtureGlb();
      await writeFile(path.join(root, "assets", "room.glb"), input);
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      const secondRoom = await io.readBinary(input);
      secondRoom.getRoot().listNodes()[0]?.setTranslation([0.25, 0, 0]);
      await writeFile(path.join(root, "assets", "room2.glb"), await io.writeBinary(secondRoom));
      const config: IAssetSourceConfig = {
        audio: "none",
        textures: "none",
        lod: false,
        models: {
          textures: "none",
          passes: { meshopt: false },
          lightmap: { atlasSize: 128, padding: 2 },
        },
      };
      const options = {
        config,
        cwd: root,
        platform,
        runtimeDecoders: { ktx2: decoders, meshopt: decoders },
      };
      const worker = await compileAssets({ ...options, concurrency: 2 });
      expect(worker.concurrencyUsed).toBe(2);
      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      );
      const lightmap = manifest.entries["room.glb"].lightmaps?.[0];
      expect(lightmap).toMatchObject({ format: "astc4x4", texCoord: 1 });
      const bytes = await readFile(path.join(root, "public", lightmap.output));
      const container = readKtx2(bytes);
      expect(container.vkFormat).toBe(157);
      expect(container.supercompressionScheme).toBe(0);
      expect(container.globalData).toBeNull();
      expect(container.levelCount).toBe(
        Math.floor(Math.log2(Math.max(container.pixelWidth, container.pixelHeight))) + 1,
      );
      expect(container.dataFormatDescriptor[0]).toMatchObject({
        colorPrimaries: 0,
        transferFunction: 1,
        texelBlockDimension: [3, 3, 0, 0],
      });
      await expect(
        decodeAstcKtx2(bytes, container.pixelWidth, container.pixelHeight),
      ).resolves.toHaveLength(container.pixelWidth * container.pixelHeight * 4);
      const warm = await compileAssets({ ...options, concurrency: 1 });
      expect(warm.written).toBe(0);
      expect(warm.skipped).toBe(2);
      const serial = await compileAssets({ ...options, concurrency: 1, output: "serial" });
      expect(serial.written).toBe(2);
      const serialManifest = JSON.parse(
        await readFile(path.join(root, "serial", "assets.manifest.json"), "utf8"),
      );
      for (const name of ["room.glb", "room2.glb"]) {
        const parallelEntry = manifest.entries[name];
        const serialEntry = serialManifest.entries[name];
        expect(serialEntry.output).toBe(parallelEntry.output);
        expect(serialEntry.lightmaps[0].output).toBe(parallelEntry.lightmaps[0].output);
        for (const output of [parallelEntry.output, parallelEntry.lightmaps[0].output])
          expect(await readFile(path.join(root, "serial", output))).toEqual(
            await readFile(path.join(root, "public", output)),
          );
      }
      const basis = await compileAssets({
        ...options,
        concurrency: 1,
        platform: "web",
        runtimeDecoders: { ktx2: true, meshopt: true },
      });
      expect(basis.written).toBe(2);
      const basisManifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      );
      const basisLightmap = basisManifest.entries["room.glb"].lightmaps[0];
      expect(basisLightmap.format).toBe("etc1s");
      expect(basisLightmap.output).not.toBe(lightmap.output);
      const basisBytes = await readFile(path.join(root, "public", basisLightmap.output));
      expect(readKtx2(basisBytes).vkFormat).toBe(0);
      const restored = await compileAssets({ ...options, concurrency: 1 });
      expect(restored.written).toBe(2);
      expect(await readFile(path.join(root, "public", lightmap.output))).toEqual(bytes);
    },
  );

  it("should ship a model byte-identical when assets.models is none", async () => {
    const root = await makeTempDir("threenative-compile-model-none-");
    await mkdir(path.join(root, "assets"));
    const source = Buffer.from(await buildFixtureGlb());
    await writeFile(path.join(root, "assets", "character.glb"), source);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    try {
      await compileAssets({ config: { models: "none" }, cwd: root });
      expect(lines.some((line) => line.startsWith("TN_ASSETS_COMPRESSION_SKIPPED model:"))).toBe(
        true,
      );
      expect(lines.some((line) => line.includes('assets.models is "none"'))).toBe(true);
    } finally {
      log.mockRestore();
    }

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const entry = manifest.entries["character.glb"];
    expect(entry.output).toMatch(/^character\.[0-9a-f]{8}\.glb$/u);
    expect(entry.passes).toEqual(["audio", "ktx2"]);
    expect(entry.triangles).toBeUndefined();
    expect(entry.extensions).toBeUndefined();
    expect((await readFile(path.join(root, "public", entry.output))).equals(source)).toBe(true);
  });

  it("should reject unknown model config keys and pass names at the assets layer", async () => {
    const root = await makeTempDir("threenative-compile-model-config-");
    await mkdir(path.join(root, "assets"));

    const unknownKey = { models: { bogus: true } } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: unknownKey, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY.*assets\.models\.bogus/u,
    );

    const unknownPass = {
      models: { passes: { decimate: true } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: unknownPass, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY.*assets\.models\.passes\.decimate/u,
    );

    const shallowPass = { models: { passes: "fast" } } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: shallowPass, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*assets\.models\.passes must be an object/u,
    );

    const badDepth = {
      models: { quantize: { positionBits: 32 } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badDepth, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*between 1 and 16 bits/u,
    );
  });
});

/**
 * The config file's side of PRD-283 AC5. `assets.models.virtual` is documented as the one key a
 * game sets to move or opt out of the cluster bake, `create-threenative`'s config validator
 * accepts and range-checks it — and `compileAssets`, which is what `threenative build` actually
 * calls with that config, listed every model key except this one. A game that wrote the
 * documented override never reached the pipeline: it died at `TN_ASSETS_CONFIG_UNKNOWN_KEY`
 * before a single asset compiled.
 */
describe("compileAssets and assets.models.virtual", () => {
  it("should carry virtual: none through to the pass and leave a dense primitive unclustered", async () => {
    const root = await makeTempDir("threenative-compile-virtual-none-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "face.glb"), await denseFixtureGlb());

    await compileAssets({
      config: { models: { virtual: "none" } } as IAssetSourceConfig,
      cwd: root,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    expect(manifest.entries["face.glb"].extensions ?? []).not.toContain("TN_virtual_geometry");
  });

  it("should carry a virtual threshold through to the pass", async () => {
    const root = await makeTempDir("threenative-compile-virtual-threshold-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "face.glb"), await sparseFixtureGlb());

    // 2,048 triangles is far under the 65,536 default, so a bake here can only mean the
    // threshold this config named reached the pass.
    await compileAssets({
      config: { models: { virtual: { minSourceTriangles: 1024 } } } as IAssetSourceConfig,
      cwd: root,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    expect(manifest.entries["face.glb"].extensions).toContain("TN_virtual_geometry");
  });

  it("should still reject a misspelled key under assets.models.virtual", async () => {
    const root = await makeTempDir("threenative-compile-virtual-bogus-");
    await mkdir(path.join(root, "assets"));

    const bogus = {
      models: { virtual: { minTriangls: 4 } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: bogus, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY.*assets\.models\.virtual\.minTriangls/u,
    );
  });
});

describe("compileAssets and assets.models.compact", () => {
  it("should accept compact: false and an object override, and reject the keys it cannot honour", async () => {
    const root = await makeTempDir("threenative-compile-compact-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "character.glb"), await buildFixtureGlb());

    await compileAssets({
      config: {
        models: { compact: false, textures: "none", virtual: "none" },
      } as IAssetSourceConfig,
      cwd: root,
    });

    const bogus = {
      models: { compact: { flatten: "yes" } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: bogus, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*assets\.models\.compact\.flatten must be a boolean/u,
    );

    const unknown = {
      models: { compact: { joins: true } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: unknown, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY.*assets\.models\.compact\.joins/u,
    );

    const badMin = {
      models: { compact: { instance: { min: 1 } } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badMin, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*assets\.models\.compact\.instance\.min must be an integer of at least 2/u,
    );

    const badNames = {
      models: { compact: { protectedNames: [1] } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badNames, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*protectedNames must be an array of strings/u,
    );

    const badPattern = {
      models: { compact: { protectedPattern: "(" } },
    } as unknown as IAssetSourceConfig;
    await expect(compileAssets({ config: badPattern, cwd: root })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID.*protectedPattern is not a valid regular expression/u,
    );
  });
});

describe("compile cache", () => {
  it("should not run a pass again for an input whose bytes and pass configuration are unchanged", async () => {
    // Every build applied every pass to every input and only then compared the result with the
    // manifest to decide whether to write. For a valley of 58 textured models that is minutes of
    // KTX2 encoding on every `pnpm dev`, all of it producing bytes that already exist.
    const root = await makeTempDir("threenative-compile-skip-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 16, width: 16 }));
    await writeFile(
      path.join(root, "assets", "moss.png"),
      rgbaPng({ green: () => 200, height: 16, width: 16 }),
    );
    let applied = 0;
    const counting = {
      apply: (input: Buffer) => {
        applied += 1;
        return Buffer.concat([input, Buffer.from("!")]);
      },
      configuration: { salt: 1 },
      name: "counting",
    };

    const first = await compileAssets({ cwd: root, passes: [counting] });
    expect(first.written).toBe(2);
    expect(applied).toBe(2);

    const second = await compileAssets({ cwd: root, passes: [counting] });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
    expect(applied).toBe(2);

    // Negative controls: a changed input or a changed configuration runs the pass again.
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({ height: 16, red: () => 9, width: 16 }),
    );
    const third = await compileAssets({ cwd: root, passes: [counting] });
    expect(third.written).toBe(1);
    expect(applied).toBe(3);
    const fourth = await compileAssets({
      cwd: root,
      passes: [{ ...counting, configuration: { salt: 2 } }],
    });
    expect(fourth.written).toBe(2);
    expect(applied).toBe(5);

    // A deleted output is rebuilt even though the manifest still describes it.
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as {
      entries: Record<string, { output: string }>;
    };
    await rm(path.join(root, "public", manifest.entries["moss.png"]?.output ?? ""));
    const fifth = await compileAssets({
      cwd: root,
      passes: [{ ...counting, configuration: { salt: 2 } }],
    });
    expect(fifth.written).toBe(1);
    expect(applied).toBe(6);
  });
});

describe("manifest and per-kind pass isolation", () => {
  it("rejects a corrupt existing manifest instead of rebuilding over it silently", async () => {
    const root = await makeTempDir("threenative-corrupt-manifest-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/keep.txt"), "kept");
    await mkdir(path.join(root, "public"));
    const config = { audio: "none", models: "none", textures: "none" } as const;
    const manifest = path.join(root, "public/assets.manifest.json");

    await writeFile(manifest, "{not json");
    await expect(compileAssets({ cwd: root, config })).rejects.toThrow(
      "TN_ASSETS_MANIFEST_INVALID",
    );
    await writeFile(manifest, JSON.stringify({ version: 2, entries: {} }));
    await expect(compileAssets({ cwd: root, config })).rejects.toThrow(
      "TN_ASSETS_MANIFEST_INVALID",
    );
  });

  it("keeps a non-audio entry unchanged when only the audio options change", async () => {
    const root = await makeTempDir("threenative-pass-isolation-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/notes.txt"), "notes");
    await writeFile(
      path.join(root, "assets/tone.wav"),
      wavClip({ frames: 4_410, sample: sine(440) }),
    );
    const entriesWith = async (audio: Record<string, unknown>) => {
      await compileAssets({
        cwd: root,
        config: { audio, models: "none", textures: "none" } as never,
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      return manifest.entries as Record<string, unknown>;
    };

    const before = await entriesWith({});
    const after = await entriesWith({ seamMaxRatio: 2 });

    expect(after["tone.wav"]).not.toEqual(before["tone.wav"]);
    expect(after["notes.txt"]).toEqual(before["notes.txt"]);
  }, 30_000);
});
