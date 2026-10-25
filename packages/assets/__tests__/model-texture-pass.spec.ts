import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP, KHRTextureBasisu } from "@gltf-transform/extensions";
import { listTextureSlots } from "@gltf-transform/functions";
import { read as readKTX2, write as writeKTX2 } from "ktx-parse";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureDocument } from "../../../test-support/generate-fixture-model.js";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { EXTTextureAstc, createGltfReader, readGltfDocument } from "../src/gltf-io.js";
import * as qualityInstrument from "../src/image-quality.js";
import { type IAssetSourceConfig, compileAssets } from "../src/index.js";
import * as encoder from "../src/ktx2-encoder.js";
import { decodeImageBytes } from "../src/passes/decode-image.js";
import {
  BASIS_TRANSCODER_BYTES,
  codecLadder,
  compressEmbeddedTextures,
  encodeTextureLadder,
  resampleRgba,
} from "../src/passes/model-textures.js";
import { modelPass } from "../src/passes/model.js";
import { createSharedImageStore } from "../src/passes/shared-images.js";
import { parsePng } from "../src/png.js";
import { formatTextureRungs } from "../src/report.js";

/**
 * Proof that the textures *inside* a `.glb` go through the pipeline too. A prop carrying
 * three 2048x2048 JPEGs decodes to ~67 MB of VRAM however small the container is, so the
 * geometry-only model pass was shipping the expensive half of every asset untouched.
 */

/** Re-reads pass output the way the runtime does: every extension registered. */
async function readOutput(buffer: Buffer): Promise<Document> {
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readJSON(await io.binaryToJSON(new Uint8Array(buffer)));
}

/** The shared skinned fixture, with its two embedded maps replaced at a chosen size. */
async function fixtureWithTextures(options: {
  readonly height?: number;
  readonly width: number;
}): Promise<Buffer> {
  const { width } = options;
  const height = options.height ?? width;
  const document = buildFixtureDocument();
  const [baseColor, normal] = document.getRoot().listTextures();
  baseColor
    ?.setImage(
      PNG.sync.write(
        PNG.sync.read(
          rgbaPng({
            blue: (x, y) => 100 + ((x * 21 + y * 21) % 8),
            green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
            height,
            red: (x, y) => 100 + ((x * 37 + y * 41) % 8),
            width,
          }),
        ),
      ),
    )
    .setMimeType("image/png");
  normal
    ?.setImage(
      // A perfectly flat normal map is a no-op `prune` deletes outright, which would make
      // every assertion below measure one texture instead of two.
      rgbaPng({
        blue: () => 255,
        green: (x, y) => 96 + ((x * 29 + y * 31) % 64),
        height,
        red: (x, y) => 96 + ((x * 37 + y * 41) % 64),
        width,
      }),
    )
    .setMimeType("image/png");
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/**
 * Most cases below measure the KTX2 ladder itself, not whether the shared transcoder can be
 * repaid by a 32-pixel fixture, so they state that its cost is already paid. The default-cost
 * rule has its own case.
 */
function paidTranscoder(
  options?: Parameters<typeof modelPass>[0],
): Parameters<typeof modelPass>[0] {
  const textures = options?.textures;
  if (textures === "none" || textures?.transcoderBytes !== undefined) return options;
  return { ...options, textures: { ...(textures ?? {}), transcoderBytes: 0 } };
}

function apply(
  input: Buffer,
  options?: Parameters<typeof modelPass>[0],
): Promise<Buffer | { buffer: Buffer; entry?: Readonly<Record<string, unknown>> }> {
  return Promise.resolve(
    modelPass(paidTranscoder(options)).apply(input, "character.glb"),
  ) as Promise<Buffer | { buffer: Buffer; entry?: Readonly<Record<string, unknown>> }>;
}

async function compiled(
  input: Buffer,
  options?: Parameters<typeof modelPass>[0],
): Promise<{ buffer: Buffer; entry: Readonly<Record<string, unknown>> }> {
  const result = await apply(input, options);
  if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
  return { buffer: result.buffer, entry: result.entry ?? {} };
}

/**
 * Two flat halves, never one solid colour: `prune` deletes a single-colour texture and folds it
 * into the material factor, which would leave these cases measuring a material and no image.
 */
const WEBP_HALVES = [
  [200, 130, 40],
  [20, 60, 220],
] as const;

/** A lossless WebP of the requested size, encoded by the decoder the pass uses. */
async function tinyWebp(size = 4): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    pixels.set([...WEBP_HALVES[index % size < size / 2 ? 0 : 1], 255], index * 4);
  }
  return sharp(pixels, { raw: { channels: 4, height: size, width: size } })
    .webp({ lossless: true })
    .toBuffer();
}

/**
 * The shared fixture with its base colour replaced by an `EXT_texture_webp` image, which is what
 * a Fab or McD export ships: the extension declared and required, the payload in a WebP.
 */
async function fixtureWithWebp(size?: number): Promise<Buffer> {
  const document = buildFixtureDocument();
  document.createExtension(EXTTextureWebP).setRequired(true);
  document
    .getRoot()
    .listTextures()[0]
    ?.setImage(await tinyWebp(size))
    .setMimeType("image/webp");
  // The writer only emits the extensions it was told about, and an undeclared `image/webp`
  // would be the invalid document this fixture exists to avoid.
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

interface IBasisModule {
  readonly KTX2File: new (
    bytes: Uint8Array,
  ) => {
    close(): void;
    getHeight(): number;
    getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
    getWidth(): number;
    isValid(): boolean;
    startTranscoding(): boolean;
    transcodeImage(
      dst: Uint8Array,
      mip: number,
      layer: number,
      face: number,
      format: number,
      getAlphaForOpaqueFormats: number,
      channel0: number,
      channel1: number,
    ): boolean;
  };
  readonly initializeBasis: () => void;
  readonly transcoder_texture_format: Readonly<Record<string, { readonly value: number }>>;
}

/**
 * Mip 0 of a KTX2 as RGBA8, decoded by the same `basis_transcoder` the runtime ships. Three
 * publishes it CommonJS inside an ESM package, so it is evaluated here the way its own wrapper
 * does — the alternative is trusting the container header instead of the pixels.
 */
async function transcodeFirstLevel(ktx2: Uint8Array): Promise<Uint8Array> {
  const paths = basisTranscoderPaths();
  const directory = path.dirname(paths.javascriptPath);
  const source = await readFile(paths.javascriptPath, "utf8");
  const shim: { exports: unknown } = { exports: {} };
  new Function("module", "exports", "require", "__filename", "__dirname", source)(
    shim,
    shim.exports,
    createRequire(import.meta.url),
    paths.javascriptPath,
    directory,
  );
  const factory = shim.exports as (options: {
    locateFile: (file: string) => string;
  }) => Promise<IBasisModule>;
  const basis = await factory({ locateFile: (file) => path.join(directory, file) });
  basis.initializeBasis();
  const file = new basis.KTX2File(ktx2);
  // The emscripten bindings report booleans as numbers, so both calls are judged on truth.
  expect(file.isValid()).toBeTruthy();
  expect(file.startTranscoding()).toBeTruthy();
  // The WASM enum's numbering is not three's TranscoderFormat map, so the shipped enum names it.
  const rgba32 = basis.transcoder_texture_format.cTFRGBA32;
  if (rgba32 === undefined) throw new Error("the shipped transcoder exposes no cTFRGBA32 format");
  const format = rgba32.value;
  const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
  expect(file.transcodeImage(pixels, 0, 0, 0, format, 0, -1, -1)).toBeTruthy();
  file.close();
  return pixels;
}

/** Every channel within `tolerance` of the source half the pixel belongs to. */
function expectColours(pixels: Uint8Array, width: number, tolerance: number): void {
  expect(pixels.length).toBe(width * width * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const half = WEBP_HALVES[(offset / 4) % width < width / 2 ? 0 : 1];
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs((pixels[offset + channel] ?? 0) - (half[channel] ?? 0))).toBeLessThanOrEqual(
        tolerance,
      );
    }
  }
}

describe("embedded model textures", () => {
  it("should charge at least the transcoder pair the runtime downloads once", async () => {
    const { javascriptPath, wasmPath } = basisTranscoderPaths();
    const [js, wasm] = await Promise.all([stat(javascriptPath), stat(wasmPath)]);
    expect(BASIS_TRANSCODER_BYTES).toBeGreaterThanOrEqual(js.size + wasm.size);
    // A stale constant must not silently disable KTX2 for every project.
    expect(BASIS_TRANSCODER_BYTES).toBeLessThan((js.size + wasm.size) * 1.2);
  });

  it("should escalate an image that fails the floor", async () => {
    const make = async () => {
      const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 128 }));
      let seed = 123;
      const png = new PNG({ width: 128, height: 128 });
      for (let i = 0; i < png.data.length; i += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        png.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
      }
      document.getRoot().listTextures()[0]?.setImage(PNG.sync.write(png));
      return document;
    };
    const enforced = await compressEmbeddedTextures(await make(), "noise.glb", {
      transcoderBytes: 0,
    });
    expect(enforced?.quality.checker?.rung).not.toBe("etc1s@150");
    expect(enforced?.quality.checker?.rung).toBeDefined();
    expect(enforced?.quality.checker?.status).toBe("pass");
    const disabled = await compressEmbeddedTextures(await make(), "noise.glb", {
      floor: { ssim: 0, meanDeltaE00: 100 },
      transcoderBytes: 0,
    });
    expect(disabled?.quality.checker?.rung).toBe("etc1s@150");
    expect(disabled?.quality.checker?.meanDeltaE00).toBeGreaterThan(3);
  });

  it("should keep a clean image on the cheapest rung", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 128 }));
    // An uncompressed PNG keeps the flat-colour fixture larger than its encoded candidates.
    const flat = rgbaPng({
      width: 128,
      height: 128,
      red: () => 128,
      green: () => 128,
      blue: () => 128,
    });
    document
      .getRoot()
      .listTextures()[0]
      ?.setImage(PNG.sync.write(PNG.sync.read(flat), { deflateLevel: 0 }));
    const summary = await compressEmbeddedTextures(document, "flat.glb", {
      jpeg: false,
      transcoderBytes: 0,
    });
    expect(summary?.quality.checker?.status).toBe("pass");
    const decoded = PNG.sync.read(flat);
    const passing: Uint8Array[] = [];
    for (const candidate of codecLadder(["baseColorTexture"])) {
      if (candidate.codec === "none") continue;
      const encoded = await encoder.encodeToKTX2(flat, {
        imageDecoder: async () => decoded,
        isUASTC: candidate.codec === "uastc",
        isPerceptual: true,
        isSetKTX2SRGBTransferFunc: true,
        qualityLevel: 150,
        needSupercompression: true,
        ...(candidate.rdoLambda === undefined ? {} : { rdoLambda: candidate.rdoLambda }),
      });
      if ((await qualityInstrument.measureKtx2(decoded.data, encoded, 128, 128)).status === "pass")
        passing.push(encoded);
    }
    expect(passing).toHaveLength(4);
    const minimum = Math.min(...passing.map((encoded) => encoded.byteLength));
    const minimumGate = (bytes: number) => expect(bytes).toBe(minimum);
    minimumGate(document.getRoot().listTextures()[0]?.getImage()?.byteLength ?? 0);
    // Force the original first passing candidate instead of the byte minimum.
    document.getRoot().listTextures()[0]?.setImage(flat).setMimeType("image/png");
    await compressEmbeddedTextures(document, "flat.glb", {
      jpeg: false,
      overrides: [{ slot: "baseColorTexture", codec: "etc1s" }],
      transcoderBytes: 0,
    });
    expect(() =>
      minimumGate(document.getRoot().listTextures()[0]?.getImage()?.byteLength ?? 0),
    ).toThrow();
  });

  it("selects a passing RDO rung", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 32 }));
    const source = rgbaPng({
      width: 32,
      height: 32,
      red: (x, y) => 100 + ((x * 37 + y * 41) % 16),
      green: (x, y) => 100 + ((x * 29 + y * 31) % 16),
      blue: (x, y) => 100 + ((x * 21 + y * 21) % 16),
    });
    document
      .getRoot()
      .listTextures()[0]
      ?.setImage(PNG.sync.write(PNG.sync.read(source)));
    const summary = await compressEmbeddedTextures(document, "rdo.glb", { transcoderBytes: 0 });
    expect(summary?.quality.checker).toMatchObject({
      codec: "uastc",
      rung: "uastc+rdo λ3 +zstd",
      status: "pass",
    });
  });

  it("should re-encode an opaque colour map as the smallest passing JPEG", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 256 }));
    const colour = document
      .getRoot()
      .listTextures()
      .find((texture) => listTextureSlots(texture).includes("baseColorTexture"));
    if (colour === undefined) throw new Error("missing colour image");
    // A smooth gradient: large as an unfiltered PNG, tiny as JPEG, and the floor holds.
    colour
      .setImage(
        rgbaPng({
          blue: (x, y) => (x + y) % 256,
          green: (_x, y) => y % 256,
          height: 256,
          red: (x) => x % 256,
          width: 256,
        }),
      )
      .setMimeType("image/png");
    const sourceBytes = colour.getImage()?.byteLength ?? 0;
    const input = Buffer.from(await new NodeIO().writeBinary(document));
    const { buffer, entry } = await compiled(input, {
      textures: { transcoderBytes: BASIS_TRANSCODER_BYTES },
    });
    const output = await readOutput(buffer);
    const cooked = output
      .getRoot()
      .listTextures()
      .find((texture) => listTextureSlots(texture).includes("baseColorTexture"));
    expect(cooked?.getMimeType()).toBe("image/jpeg");
    expect(cooked?.getImage()?.byteLength ?? 0).toBeLessThan(sourceBytes);
    expect(entry.embeddedTextures).toMatchObject({ count: 2 });
    const normal = output
      .getRoot()
      .listTextures()
      .find((texture) => listTextureSlots(texture).includes("normalTexture"));
    expect(normal?.getMimeType()).not.toBe("image/jpeg");
  });

  it("should never try etc1s for a normal map", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 128 }));
    for (const material of document.getRoot().listMaterials()) material.setBaseColorTexture(null);
    document.getRoot().listTextures()[0]?.dispose();
    const encode = vi.spyOn(encoder, "encodeToKTX2");
    try {
      const summary = await compressEmbeddedTextures(document, "normal.glb", {
        transcoderBytes: 0,
      });
      expect(summary?.quality["cloth-normal"]?.rung).toBe("uastc");
      expect(encode.mock.calls.length).toBeGreaterThan(0);
      expect(encode.mock.calls.every(([, settings]) => settings.isUASTC === true)).toBe(true);
    } finally {
      encode.mockRestore();
    }
  });

  it("should report the rung histogram", async () => {
    const root = await makeTempDir("threenative-ladder-report-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      const options = {
        cwd: root,
        concurrency: 1,
        config: { models: { textures: { floor: { ssim: 0.95, meanDeltaE00: 3 } } } },
      };
      await compileAssets(options);
      const histogram = lines.find((line) =>
        /\d+ etc1s · \d+ escalated to uastc · \d+ uncompressed/u.test(line),
      );
      expect(histogram).toBeDefined();
      const histogramGate = (line: string) => {
        const counts = line.match(/^(\d+) etc1s · (\d+) escalated to uastc · (\d+) uncompressed$/u);
        expect(counts).not.toBeNull();
        expect(
          counts
            ?.slice(1)
            .map(Number)
            .reduce((a, b) => a + b, 0),
        ).toBe(2);
      };
      histogramGate(histogram ?? "");
      // Dropping one reported image must fail the same count gate, including all-zero output.
      expect(() => histogramGate(formatTextureRungs(["none"]))).toThrow();
      expect(() => histogramGate(formatTextureRungs([]))).toThrow();
      expect(lines.some((line) => /rung (?:etc1s@150|uastc|none)/u.test(line))).toBe(true);
      lines.length = 0;
      await compileAssets(options);
      expect(lines).toContain(histogram);
    } finally {
      log.mockRestore();
    }
  });

  it("preserves alpha coverage and rejects a forced codec below the configured floor", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 32 }));
    const texture = document.getRoot().listTextures()[0];
    if (texture === undefined) throw new Error("missing colour image");
    const source = PNG.sync.read(Buffer.from(texture.getImage() ?? []));
    for (let i = 3; i < source.data.length; i += 4) source.data[i] = i % 12 === 3 ? 127 : 128;
    texture.setImage(PNG.sync.write(source));
    for (const material of document.getRoot().listMaterials())
      if (material.getBaseColorTexture() === texture)
        material.setAlphaMode("MASK").setAlphaCutoff(0.5);
    const original = Buffer.from(await new NodeIO().writeBinary(document));
    const summary = await compressEmbeddedTextures(document, "cutout.glb");
    expect(summary?.quality.checker?.alpha.coverage[0]?.changedPixels).toBe(0);
    expect(summary?.quality.checker?.status).toBe("pass");
    await expect(
      compressEmbeddedTextures(await new NodeIO().readBinary(original), "cutout.glb", {
        floor: { ssim: 1, meanDeltaE00: 0 },
        overrides: [{ slot: "baseColorTexture", codec: "etc1s" }],
      }),
    ).rejects.toThrow(/TN_ASSETS_TEXTURE_FLOOR/u);
  });

  it("keys floor and caps in the shared decision and recalls uncompressed fallbacks", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const root = await makeTempDir("threenative-ladder-fallback-");
    const strict = { floor: { ssim: 1, meanDeltaE00: 0 }, maxSize: 16 };
    const cold = await compiled(input, {
      sharedImages: createSharedImageStore(root),
      textures: strict,
    });
    await writeFile(path.join(root, "capped.glb"), cold.buffer);
    const capped = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
      .read(path.join(root, "capped.glb"));
    for (const texture of capped.getRoot().listTextures()) {
      const image = texture.getImage();
      if (image === null) throw new Error("capped fixture lost its image");
      const shape =
        texture.getMimeType() === "image/ktx2"
          ? { width: readKTX2(image).pixelWidth, height: readKTX2(image).pixelHeight }
          : parsePng(Buffer.from(image));
      expect(shape).toMatchObject({ width: 16, height: 16 });
    }
    const measure = vi.spyOn(qualityInstrument, "measureKtx2");
    try {
      const warm = await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: strict,
      });
      expect(warm.entry.embeddedTextures).toEqual(cold.entry.embeddedTextures);
      expect(warm.buffer).toEqual(cold.buffer);
      expect(measure).not.toHaveBeenCalled();
      await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: { floor: { ssim: 0, meanDeltaE00: 100 }, maxSize: 16 },
      });
      expect(measure).toHaveBeenCalled();
      expect(() => expect(measure).not.toHaveBeenCalled()).toThrow();
      measure.mockClear();
      await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: { ...strict, maxSize: 32 },
      });
      expect(measure).toHaveBeenCalled();
      expect(() => expect(measure).not.toHaveBeenCalled()).toThrow();
    } finally {
      measure.mockRestore();
    }
  });

  it("charges a below-floor source fallback to the uncooked budget", async () => {
    const root = await makeTempDir("threenative-ladder-budget-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );
    const compile = (uncooked: number | "none") =>
      compileAssets({
        cwd: root,
        concurrency: 1,
        modelTranscoderBytes: 0,
        config: {
          budget: { uncooked },
          models: { textures: { floor: { ssim: 1, meanDeltaE00: 0 } } },
        },
      });
    await compile("none");
    await expect(compile(1)).rejects.toThrow(/TN_ASSETS_BUDGET/u);
  });

  it("round-trips floor through compileAssets and invalidates the build decision", async () => {
    const root = await makeTempDir("threenative-ladder-floor-config-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );
    const read = async () =>
      JSON.parse(await readFile(path.join(root, "public", "assets.manifest.json"), "utf8")) as {
        entries: Record<
          string,
          { embeddedTextures: { quality: Record<string, qualityInstrument.ITextureQuality> } }
        >;
      };
    await compileAssets({
      cwd: root,
      concurrency: 1,
      modelTranscoderBytes: 0,
      config: { models: { textures: { floor: { ssim: 1, meanDeltaE00: 0 } } } },
    });
    expect((await read()).entries["prop.glb"]?.embeddedTextures.quality.checker?.rung).toBe("none");
    await compileAssets({
      cwd: root,
      concurrency: 1,
      modelTranscoderBytes: 0,
      config: { models: { textures: { floor: { ssim: 0, meanDeltaE00: 100 } } } },
    });
    const score = (await read()).entries["prop.glb"]?.embeddedTextures.quality.checker;
    expect(score?.rung).toBe("jpeg@75");
    expect(score?.floor).toEqual({ ssim: 0, meanDeltaE00: 100 });
  });

  it("reports every compressed image without changing output bytes", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const on = await compiled(input);
    const off = await compiled(input, { textures: { measureQuality: false } });
    expect(on.buffer).toEqual(off.buffer);
    const sharedOn = await compiled(input, { sharedImages: createSharedImageStore() });
    const sharedOff = await compiled(input, {
      sharedImages: createSharedImageStore(),
      textures: { measureQuality: false },
    });
    expect(sharedOn.buffer).toEqual(sharedOff.buffer);
    const summary = on.entry.embeddedTextures as {
      formats: Record<string, string>;
      quality: Record<string, { ssim: number; sourceWidth: number; width: number }>;
    };
    const names = Object.keys(summary.formats).filter((name) => summary.formats[name] !== "none");
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(summary.quality).sort()).toEqual(names.sort());
    for (const score of Object.values(summary.quality))
      expect(Number.isFinite(score.ssim)).toBe(true);
    const unmeasured = off.entry.embeddedTextures as typeof summary;
    expect(() =>
      expect(Object.keys(unmeasured.quality ?? {}).sort()).toEqual(names.sort()),
    ).toThrow();
  });

  it("includes all consuming MASK thresholds in quality and shared cache identity", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 32 }));
    const [cloth, skin] = document.getRoot().listMaterials();
    if (cloth === undefined || skin === undefined) throw new Error("fixture lacks materials");
    const colour = cloth.getBaseColorTexture();
    cloth.setAlphaMode("MASK").setAlphaCutoff(0.25);
    skin.setBaseColorTexture(colour).setAlphaMode("MASK").setAlphaCutoff(0.75);
    const store = createSharedImageStore();
    const first = await compiled(Buffer.from(await new NodeIO().writeBinary(document)), {
      sharedImages: store,
    });
    const summary = first.entry.embeddedTextures as {
      quality: Record<string, qualityInstrument.ITextureQuality>;
    };
    expect(summary.quality.checker?.alpha.coverage.map((c) => c.threshold)).toEqual([0.25, 0.75]);
    skin.setAlphaCutoff(0.6);
    const measure = vi.spyOn(qualityInstrument, "measureKtx2");
    const encode = vi.spyOn(encoder, "encodeToKTX2");
    try {
      const second = await compiled(Buffer.from(await new NodeIO().writeBinary(document)), {
        sharedImages: store,
      });
      const scores = second.entry.embeddedTextures as typeof summary;
      expect(scores.quality.checker?.alpha.coverage.map((c) => c.threshold)).toEqual([0.25, 0.6]);
      expect(encode).toHaveBeenCalledTimes(4);
      expect(measure).toHaveBeenCalled();
      for (const call of measure.mock.calls) expect(call[4]?.alphaThresholds).toEqual([0.25, 0.6]);
    } finally {
      measure.mockRestore();
      encode.mockRestore();
    }
  });

  it("stops encoding a large image once ETC1S cannot beat its source bytes", async () => {
    // The starter's 4096x2048 sky.jpg spent 50 s on four encodes and shipped its source: no rung
    // beat the JPEG's bytes. ETC1S is the ladder's lowest bitrate, so on a large image the UASTC
    // rungs are not encoded once it fails; a small image still walks the whole ladder.
    const encode = vi
      .spyOn(encoder, "encodeToKTX2")
      .mockImplementation(async () => new Uint8Array(4096));
    try {
      const ladder = (size: number) =>
        encodeTextureLadder(new Uint8Array(size * size * 4).fill(128), size, size, {
          maxBytes: 100,
          quality: 128,
          srgb: true,
        });
      const large = await ladder(600);
      expect(large.codec).toBe("none");
      expect(large.quality.compressionSkipped).toBe("not-smaller");
      expect(encode).toHaveBeenCalledTimes(1);
      encode.mockClear();
      expect((await ladder(64)).codec).toBe("none");
      expect(encode).toHaveBeenCalledTimes(4);
    } finally {
      encode.mockRestore();
    }
  });

  it("isolates ASTC shared cache and replays its required extension", async () => {
    const root = await makeTempDir("threenative-astc-shared-");
    const input = await fixtureWithTextures({ width: 32 });
    const textures = {
      overrides: [
        { slot: "baseColorTexture", codec: "etc1s" as const },
        { slot: "normalTexture", codec: "none" as const },
      ],
    };
    const basis = await compiled(input, { sharedImages: createSharedImageStore(root), textures });
    const nonAstc = await compiled(input, {
      sharedImages: createSharedImageStore(root),
      textures: { ...textures, astc: false },
    });
    expect(nonAstc.buffer).toEqual(basis.buffer);
    expect(modelPass({ textures }).configuration).toEqual(
      modelPass({ textures: { ...textures, astc: false } }).configuration,
    );
    const cold = await compiled(input, {
      sharedImages: createSharedImageStore(root),
      textures: { ...textures, astc: true },
    });
    expect(cold.buffer).not.toEqual(basis.buffer);
    const encode = vi.spyOn(encoder, "encodeToKTX2");
    try {
      const warm = await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: { ...textures, astc: true },
      });
      expect(warm.buffer).toEqual(cold.buffer);
      expect(warm.entry.embeddedTextures).toEqual(cold.entry.embeddedTextures);
      expect(warm.entry.extensions).toContain("EXT_texture_astc");
      expect(warm.entry.extensions).not.toContain("KHR_texture_basisu");
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it.each([0, 1, "uncompressed-length"] as const)(
    "rejects ASTC mip payload mismatch at %s despite a complete level count",
    async (mip) => {
      const document = buildFixtureDocument();
      await compressEmbeddedTextures(document, "short-mip.glb", {
        astc: true,
        overrides: [
          { slot: "baseColorTexture", codec: "etc1s" },
          { slot: "normalTexture", codec: "none" },
        ],
      });
      const raw = document
        .getRoot()
        .listTextures()
        .find((texture) => texture.getMimeType() === "image/ktx2");
      if (!raw) throw new Error("raw ASTC missing");
      const container = readKTX2(raw.getImage() ?? new Uint8Array());
      const level = container.levels[typeof mip === "number" ? mip : 1];
      if (!level) throw new Error("fixture mip missing");
      if (typeof mip === "number")
        level.levelData = level.levelData.subarray(0, level.levelData.byteLength - 16);
      level.uncompressedByteLength -= 16;
      raw.setImage(writeKTX2(container));
      expect(readKTX2(raw.getImage() ?? new Uint8Array()).levelCount).toBe(container.levelCount);
      await expect(
        new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]).writeBinary(document),
      ).rejects.toThrow("TN_ASSETS_ASTC_METADATA");
    },
  );

  it.each([undefined, false])(
    "preserves optional upstream Basis bytes with astc=%s and no new compression",
    async (astc) => {
      const document = buildFixtureDocument();
      const base = document.getRoot().listTextures()[0];
      if (!base) throw new Error("fixture base missing");
      base
        .setImage(
          await encoder.encodeToKTX2(base.getImage() ?? new Uint8Array(), {
            generateMipmap: true,
            imageDecoder: async (bytes) => PNG.sync.read(Buffer.from(bytes)),
          }),
        )
        .setMimeType("image/ktx2");
      const extension = document.createExtension(KHRTextureBasisu).setRequired(false);
      const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]);
      const before = await io.writeBinary(document);
      await compressEmbeddedTextures(document, "upstream.glb", {
        ...(astc === undefined ? {} : { astc }),
        overrides: [{ slot: "normalTexture", codec: "none" }],
      });
      expect(extension.isRequired()).toBe(false);
      expect(await io.writeBinary(document)).toEqual(before);
    },
  );

  it.each([false, true])(
    "serializes the complete 1x1 authored Basis ASTC pyramid (UASTC=%s)",
    async (isUASTC) => {
      const document = buildFixtureDocument();
      const base = document.getRoot().listTextures()[0];
      if (!base) throw new Error("fixture base missing");
      const data = new Uint8Array([200, 130, 40, 255]);
      const basis = await encoder.encodeToKTX2(data, {
        imageDecoder: async () => ({ data, width: 1, height: 1 }),
        isUASTC,
        generateMipmap: true,
        isSetKTX2SRGBTransferFunc: true,
      });
      expect(readKTX2(basis).levelCount).toBe(1);
      base.setImage(basis).setMimeType("image/ktx2");
      document.createExtension(KHRTextureBasisu).setRequired(true);
      await compressEmbeddedTextures(document, "one-pixel.glb", {
        astc: true,
        overrides: [{ slot: "normalTexture", codec: "none" }],
      });
      const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]);
      const output = await io.writeBinary(document);
      const json = (await io.binaryToJSON(output)).json;
      expect(json.extensionsRequired).toContain("EXT_texture_astc");
      expect(json.extensionsUsed).not.toContain("KHR_texture_basisu");
      const reread = await readOutput(Buffer.from(output));
      const raw = readKTX2(reread.getRoot().listTextures()[0]?.getImage() ?? new Uint8Array());
      expect([raw.pixelWidth, raw.pixelHeight, raw.levelCount, raw.vkFormat]).toEqual([
        1, 1, 1, 158,
      ]);
      expect(raw.levels.map((level) => level.levelData.byteLength)).toEqual([16]);
    },
  );

  it.each([false, true])("converts authored Basis to final ASTC (UASTC=%s)", async (isUASTC) => {
    const document = buildFixtureDocument();
    for (const [index, texture] of document.getRoot().listTextures().entries()) {
      texture
        .setImage(
          await encoder.encodeToKTX2(texture.getImage() ?? new Uint8Array(), {
            generateMipmap: true,
            imageDecoder: async (bytes) => PNG.sync.read(Buffer.from(bytes)),
            isUASTC,
            isPerceptual: index === 0,
            isSetKTX2SRGBTransferFunc: index === 0,
          }),
        )
        .setMimeType("image/ktx2");
    }
    document.createExtension(KHRTextureBasisu).setRequired(true);
    const summary = await compressEmbeddedTextures(document, "authored.glb", { astc: true });
    const containers = document
      .getRoot()
      .listTextures()
      .map((t) => readKTX2(t.getImage() ?? new Uint8Array()));
    expect(containers.map((c) => c.vkFormat)).toEqual([158, 157]);
    expect(containers.map((c) => c.dataFormatDescriptor[0]?.colorPrimaries)).toEqual([1, 0]);
    expect(
      containers.every(
        (c) => c.levelCount === Math.floor(Math.log2(Math.max(c.pixelWidth, c.pixelHeight))) + 1,
      ),
    ).toBe(true);
    expect(Object.values(summary?.formats ?? {})).toEqual(["astc4x4", "astc4x4"]);
    expect(summary?.quality["cloth-normal"]?.status).toBe("unvalidated-slots");
    const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]);
    const json = (await io.binaryToJSON(await io.writeBinary(document))).json;
    expect(json.extensionsRequired).toContain("EXT_texture_astc");
    expect(json.extensionsUsed).not.toContain("KHR_texture_basisu");
  });

  it.each([
    "resize",
    "none",
    "nonASTC",
    "decoderFree",
    "missing-mip",
    "bad-upper",
    "quality-refusal",
    "warm",
  ])("authored Basis conversion preserves policy: %s", async (policy) => {
    const document = await readOutput(await fixtureWithTextures({ width: 32 }));
    const base = document.getRoot().listTextures()[0];
    if (!base) throw new Error("fixture base missing");
    const basis = await encoder.encodeToKTX2(base.getImage() ?? new Uint8Array(), {
      generateMipmap: true,
      imageDecoder: async (bytes) => PNG.sync.read(Buffer.from(bytes)),
      isUASTC: true,
      isSetKTX2SRGBTransferFunc: true,
    });
    base.setImage(basis).setMimeType("image/ktx2");
    document.createExtension(KHRTextureBasisu).setRequired(true);
    const overrides = [
      { slot: "normalTexture", codec: "none" as const },
      ...(policy === "none" ? [{ slot: "baseColorTexture", codec: "none" as const }] : []),
    ];
    const options = {
      astc: policy !== "nonASTC",
      decoderFree: policy === "decoderFree",
      overrides,
      ...(policy === "resize" ? { maxSize: 16 } : {}),
    };
    if (policy === "missing-mip" || policy === "bad-upper") {
      const malformed = basis.slice();
      const header = new DataView(malformed.buffer, malformed.byteOffset);
      if (policy === "missing-mip") header.setUint32(40, 1, true);
      else header.setBigUint64(104, BigInt(malformed.byteLength + 8), true);
      base.setImage(malformed);
      await expect(compressEmbeddedTextures(document, "bad.glb", options)).rejects.toThrow(
        "TN_ASSETS_MODEL_BASIS_ASTC",
      );
      return;
    }
    if (policy === "quality-refusal") {
      const wrong = await encoder.encodeToKTX2(new Uint8Array([0]), {
        generateMipmap: true,
        isUASTC: true,
        isSetKTX2SRGBTransferFunc: true,
        imageDecoder: async () => ({
          data: new Uint8Array(32 * 32 * 4).fill(255),
          width: 32,
          height: 32,
        }),
      });
      const raw = await qualityInstrument.transcodeKtx2ToAstc(wrong, 1);
      const transcode = vi.spyOn(qualityInstrument, "transcodeKtx2ToAstc").mockResolvedValue(raw);
      try {
        await expect(
          compressEmbeddedTextures(document, "bad-quality.glb", options),
        ).rejects.toThrow("TN_ASSETS_TEXTURE_FLOOR");
      } finally {
        transcode.mockRestore();
      }
      expect(base.getImage()).toEqual(basis);
      return;
    }
    if (policy === "warm") {
      const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]);
      const input = Buffer.from(await io.writeBinary(document));
      const root = await makeTempDir("threenative-authored-shared-");
      const priorBasis = await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: { ...options, astc: false },
      });
      const cold = await compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: options,
      });
      expect(cold.buffer).not.toEqual(priorBasis.buffer);
      const decode = vi.spyOn(qualityInstrument, "decodeBasisKtx2");
      try {
        const warm = await compiled(input, {
          sharedImages: createSharedImageStore(root),
          textures: options,
        });
        expect(warm.buffer).toEqual(cold.buffer);
        expect(warm.entry.extensions).toContain("EXT_texture_astc");
        expect(warm.entry.extensions).not.toContain("KHR_texture_basisu");
        expect(decode).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
      return;
    }
    await compressEmbeddedTextures(document, "policy.glb", options);
    if (["none", "nonASTC", "decoderFree"].includes(policy)) expect(base.getImage()).toEqual(basis);
    else {
      const raw = readKTX2(base.getImage() ?? new Uint8Array());
      expect(raw.vkFormat).toBe(158);
      expect(raw.pixelWidth).toBe(16);
      expect(raw.levelCount).toBe(5);
    }
  });

  it("round-trips mixed Basis and ASTC without either writer stealing an image", async () => {
    const document = buildFixtureDocument();
    const normal = document.getRoot().listTextures()[1];
    if (!normal) throw new Error("fixture normal missing");
    const normalBytes = await encoder.encodeToKTX2(normal.getImage() ?? new Uint8Array(), {
      generateMipmap: true,
      imageDecoder: async (bytes) => PNG.sync.read(Buffer.from(bytes)),
      isUASTC: true,
      isPerceptual: false,
      isSetKTX2SRGBTransferFunc: false,
    });
    normal.setImage(normalBytes).setMimeType("image/ktx2");
    document.createExtension(KHRTextureBasisu).setRequired(true);
    await compressEmbeddedTextures(document, "mixed.glb", {
      astc: true,
      overrides: [
        { slot: "baseColorTexture", codec: "etc1s" },
        { slot: "normalTexture", codec: "none" },
      ],
    });
    const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc]);
    const output = Buffer.from(await io.writeBinary(document));
    const json = (await io.binaryToJSON(output)).json;
    expect(json.extensionsRequired).toEqual(
      expect.arrayContaining(["EXT_texture_astc", "KHR_texture_basisu"]),
    );
    expect(json.textures?.filter((t) => t.extensions?.EXT_texture_astc)).toHaveLength(1);
    expect(json.textures?.filter((t) => t.extensions?.KHR_texture_basisu)).toHaveLength(1);
    const reread = await readGltfDocument(await createGltfReader(output), output);
    expect(
      reread
        .getRoot()
        .listTextures()
        .map((t) => readKTX2(t.getImage() ?? new Uint8Array()).vkFormat)
        .sort(),
    ).toEqual([0, 158]);
    expect(
      reread
        .getRoot()
        .listTextures()
        .map((texture) => texture.getImage()),
    ).toEqual(
      document
        .getRoot()
        .listTextures()
        .map((texture) => texture.getImage()),
    );
    const second = (await io.binaryToJSON(await io.writeBinary(reread))).json;
    expect(second.textures).toEqual(json.textures);
    expect(second.extensionsRequired).toEqual(json.extensionsRequired);
    const paired = await io.binaryToJSON(output);
    const astc = paired.json.textures?.find((t) => t.extensions?.EXT_texture_astc);
    if (!astc) throw new Error("ASTC definition missing");
    astc.source = (astc.extensions?.EXT_texture_astc as { source: number }).source;
    await expect(io.readJSON(paired)).rejects.toThrow("TN_ASSETS_ASTC_FALLBACK");
    const raw = document
      .getRoot()
      .listTextures()
      .find((texture) => readKTX2(texture.getImage() ?? new Uint8Array()).vkFormat === 158);
    if (!raw) throw new Error("raw ASTC missing");
    const invalid = readKTX2(raw.getImage() ?? new Uint8Array());
    const descriptor = invalid.dataFormatDescriptor[0];
    if (!descriptor) throw new Error("DFD missing");
    descriptor.colorPrimaries = 0;
    raw.setImage(writeKTX2(invalid));
    await expect(io.writeBinary(document)).rejects.toThrow("TN_ASSETS_ASTC_METADATA");
  });

  it("recalls quality from the shared-image key on a second pass and disk store", async () => {
    const root = await makeTempDir("threenative-quality-cache-");
    const input = await fixtureWithTextures({ width: 32 });
    const store = createSharedImageStore(root);
    const cold = await compiled(input, { sharedImages: store });
    const measure = vi.spyOn(qualityInstrument, "measureKtx2");
    const warm = await compiled(input, { sharedImages: createSharedImageStore(root) });
    expect(warm.entry.embeddedTextures).toEqual(cold.entry.embeddedTextures);
    expect(warm.buffer).toEqual(cold.buffer);
    expect((warm.entry.embeddedTextures as { quality: unknown }).quality).toBeDefined();
    expect(measure).not.toHaveBeenCalled();
    measure.mockRestore();
  });

  it("reports quality through compileAssets and replays the same report on a build cache hit", async () => {
    const root = await makeTempDir("threenative-quality-build-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );
    const lines = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const options = { cwd: root, concurrency: 1, transcoder: basisTranscoderPaths() };
      await compileAssets(options);
      const cold = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as {
        entries: Record<
          string,
          {
            embeddedTextures: { quality: Record<string, unknown> };
            sharedImages: { output: string; quality: { version: string } }[];
          }
        >;
      };
      expect(Object.keys(cold.entries["prop.glb"]?.embeddedTextures.quality ?? {})).toHaveLength(2);
      expect(cold.entries["prop.glb"]?.sharedImages).toHaveLength(2);
      for (const row of cold.entries["prop.glb"]?.sharedImages ?? []) {
        expect(row.quality.version).toBe(qualityInstrument.IMAGE_QUALITY_VERSION);
      }
      const firstReport = lines.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.startsWith("texture quality"));
      expect(firstReport).toHaveLength(3);
      const measure = vi.spyOn(qualityInstrument, "measureKtx2");
      lines.mockClear();
      try {
        await compileAssets(options);
        expect(measure).not.toHaveBeenCalled();
        expect(
          lines.mock.calls
            .map((args) => args.join(" "))
            .filter((line) => line.startsWith("texture quality")),
        ).toEqual(firstReport);
        // Force a model pass on unchanged texture bytes: this must use the per-image cache,
        // not merely the whole-model cache whose report we just checked.
        const changed = await new NodeIO().readBinary(
          await readFile(path.join(root, "assets", "prop.glb")),
        );
        changed.getRoot().listNodes()[0]?.setName("quality-cache-new-model-revision");
        await writeFile(
          path.join(root, "assets", "prop.glb"),
          await new NodeIO().writeBinary(changed),
        );
        await compileAssets(options);
        expect(measure).not.toHaveBeenCalled();
        const revised = JSON.parse(
          await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
        ) as typeof cold;
        expect(revised.entries["prop.glb"]?.embeddedTextures.quality).toEqual(
          cold.entries["prop.glb"]?.embeddedTextures.quality,
        );
      } finally {
        measure.mockRestore();
      }
    } finally {
      lines.mockRestore();
    }
  });

  it("should transcode every embedded image to KTX2 and declare KHR_texture_basisu", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer } = await compiled(input);

    const root = (await readOutput(buffer)).getRoot();
    const extensions = new Set(root.listExtensionsUsed().map((item) => item.extensionName));
    expect(extensions.has("KHR_texture_basisu")).toBe(true);
    const textures = root.listTextures();
    expect(textures.length).toBe(2);
    for (const texture of textures) {
      expect(texture.getMimeType()).toBe("image/ktx2");
      const image = texture.getImage();
      expect(image).not.toBeNull();
      // Mips are generated at encode time: an uncompressed upload without them looks worse
      // than the PNG it replaced.
      expect(readKTX2(image ?? new Uint8Array()).levelCount).toBeGreaterThan(1);
    }
  });

  it("should declare the extension the way a stock GLTFLoader reads it", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer } = await compiled(input);
    // three's GLTFLoader does not consult gltf-transform: it reads this JSON, sees
    // KHR_texture_basisu on the texture, and hands `source` to the KTX2Loader.
    const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8")) as {
      extensionsRequired?: string[];
      extensionsUsed?: string[];
      images: { mimeType?: string }[];
      textures: { extensions?: { KHR_texture_basisu?: { source: number } }; source?: number }[];
    };
    expect(json.extensionsUsed).toContain("KHR_texture_basisu");
    expect(json.extensionsRequired).toContain("KHR_texture_basisu");
    for (const texture of json.textures) {
      const source = texture.extensions?.KHR_texture_basisu?.source;
      expect(source).toEqual(expect.any(Number));
      // The core `source` must stay unset: a fallback there would be an image no decoder
      // in the chain can read.
      expect(texture.source).toBeUndefined();
      expect(json.images[source ?? -1]?.mimeType).toBe("image/ktx2");
    }
  });

  it("should retain normal-map UASTC and permit forced ETC1S for opaque colour", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { entry } = await compiled(input, {
      textures: { overrides: [{ slot: "baseColorTexture", codec: "etc1s" }] },
    });
    const summary = entry.embeddedTextures as
      | { readonly formats: Readonly<Record<string, string>> }
      | undefined;
    expect(summary?.formats["cloth-normal"]).toBe("uastc");
    expect(summary?.formats.checker).toBe("etc1s");
  });

  it("should keep every material slot and UV set bound after compression", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer } = await compiled(input);
    const material = (await readOutput(buffer))
      .getRoot()
      .listMaterials()
      .find((item) => item.getName() === "cloth");
    expect(material?.getBaseColorTexture()).not.toBeNull();
    expect(material?.getNormalTexture()).not.toBeNull();
    expect(material?.getBaseColorTextureInfo()?.getTexCoord()).toBe(0);
    expect(material?.getNormalTextureInfo()?.getTexCoord()).toBe(0);
  });

  it("should cap the resolution of an oversized embedded texture", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer, entry } = await compiled(input, { textures: { maxSize: 16 } });
    const root = (await readOutput(buffer)).getRoot();
    for (const texture of root.listTextures()) {
      const container = readKTX2(texture.getImage() ?? new Uint8Array());
      expect(container.pixelWidth).toBe(16);
      expect(container.pixelHeight).toBe(16);
    }
    const summary = entry.embeddedTextures as { readonly resized: number } | undefined;
    expect(summary?.resized).toBe(2);
  });

  it("should cap baseColor at 2048 and masks at 1024", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 2048 }));
    const [colour, mask] = document.getRoot().listTextures();
    for (const material of document.getRoot().listMaterials()) {
      if (material.getBaseColorTexture() !== colour) continue;
      material.setNormalTexture(null).setOcclusionTexture(mask ?? null);
      material.setMetallicRoughnessTexture(mask ?? null);
    }
    const root = await makeTempDir("threenative-model-slot-caps-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "caps.glb"),
      Buffer.from(await new NodeIO().writeBinary(document)),
    );
    await compileAssets({
      cwd: root,
      platform: "android",
      config: {
        models: {
          sharedImages: false,
          textures: {
            maxSize: {
              baseColorTexture: 2048,
              occlusionTexture: 1024,
              metallicRoughnessTexture: 1024,
            },
          },
        },
      },
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    const output = await readOutput(
      await readFile(path.join(root, "public", manifest.entries["caps.glb"].output)),
    );
    const sizes = output
      .getRoot()
      .listTextures()
      .map((texture) => {
        const image = texture.getImage() ?? new Uint8Array();
        const shape =
          texture.getMimeType() === "image/ktx2"
            ? readKTX2(image)
            : PNG.sync.read(Buffer.from(image));
        return "pixelWidth" in shape
          ? [shape.pixelWidth, shape.pixelHeight]
          : [shape.width, shape.height];
      });
    expect(sizes).toEqual([
      [2048, 2048],
      [1024, 1024],
    ]);
    const scalar = await new NodeIO().readBinary(
      await readFile(path.join(root, "assets", "caps.glb")),
    );
    await compressEmbeddedTextures(scalar, "caps.glb", { decoderFree: true, maxSize: 2048 });
    const scalarSizes = scalar
      .getRoot()
      .listTextures()
      .map((texture) => {
        const png = PNG.sync.read(Buffer.from(texture.getImage() ?? []));
        return [png.width, png.height];
      });
    expect(() => expect(scalarSizes).toEqual(sizes)).toThrow();
  });

  it.each(["web", "android"] as const)(
    "compiles a base-colour and normal pair to their separate caps on %s",
    async (platform) => {
      const root = await makeTempDir("threenative-model-slot-caps-");
      await mkdir(path.join(root, "assets"));
      await writeFile(
        path.join(root, "assets", "caps.glb"),
        await fixtureWithTextures({ width: 512 }),
      );
      await compileAssets({
        cwd: root,
        concurrency: 1,
        platform,
        transcoder: basisTranscoderPaths(),
        config: {
          models: {
            textures: {
              maxSize: { baseColorTexture: 256, normalTexture: 128 },
              overrides: [{ slot: "baseColorTexture", codec: "uastc" }],
            },
          },
        },
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      );
      const output = await new NodeIO()
        .registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc])
        .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
        .read(path.join(root, "public", manifest.entries["caps.glb"].output));
      const material = output.getRoot().listMaterials()[0];
      if (platform === "android") {
        const source = await new NodeIO().readBinary(
          await readFile(path.join(root, "assets", "caps.glb")),
        );
        const pixels = PNG.sync.read(
          Buffer.from(source.getRoot().listTextures()[0]?.getImage() ?? []),
        );
        const final = material?.getBaseColorTexture()?.getImage() ?? new Uint8Array();
        expect(readKTX2(final).vkFormat).toBe(158);
        const score = await qualityInstrument.measureKtx2(
          resampleRgba(pixels.data, pixels.width, pixels.height, 256, 256, true),
          final,
          256,
          256,
          { slots: ["baseColorTexture"] },
        );
        expect(score.status).toBe("pass");
        expect(score.floor).toEqual({ ssim: 0.95, meanDeltaE00: 3 });
        expect(score.ssim).toBeGreaterThanOrEqual(0.95);
        expect(score.meanDeltaE00).toBeLessThanOrEqual(3);
      }
      for (const [texture, expected] of [
        [material?.getBaseColorTexture(), 256],
        [material?.getNormalTexture(), 128],
      ] as const) {
        expect(texture).toBeTruthy();
        const image = texture?.getImage() ?? new Uint8Array();
        const dimensions =
          texture?.getMimeType() === "image/ktx2"
            ? readKTX2(image)
            : PNG.sync.read(Buffer.from(image));
        expect(
          "pixelWidth" in dimensions
            ? [dimensions.pixelWidth, dimensions.pixelHeight]
            : [dimensions.width, dimensions.height],
        ).toEqual([expected, expected]);
      }
    },
  );

  it("should never upscale", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 512 }));
    await compressEmbeddedTextures(document, "small.glb", {
      decoderFree: true,
      maxSize: { baseColorTexture: 2048, normalTexture: 2048 },
    });
    for (const texture of document.getRoot().listTextures()) {
      const png = PNG.sync.read(Buffer.from(texture.getImage() ?? []));
      const noUpscaleGate = (width: number, height: number) =>
        expect([width, height]).toEqual([512, 512]);
      noUpscaleGate(png.width, png.height);
      // Feed an actually upscaled PNG to the dimension gate, rather than just a larger cap.
      const sharp = (await import("sharp")).default;
      const upscaled = PNG.sync.read(
        await sharp(Buffer.from(texture.getImage() ?? []))
          .resize(2048, 2048)
          .png()
          .toBuffer(),
      );
      expect(() => noUpscaleGate(upscaled.width, upscaled.height)).toThrow();
    }
  });

  it("uses the largest consuming slot cap and keys that resolved cap in shared images", async () => {
    const document = await new NodeIO().readBinary(await fixtureWithTextures({ width: 32 }));
    const colour = document.getRoot().listTextures()[0] ?? null;
    for (const material of document.getRoot().listMaterials())
      if (material.getBaseColorTexture() === colour) material.setOcclusionTexture(colour);
    const input = Buffer.from(await new NodeIO().writeBinary(document));
    const root = await makeTempDir("threenative-slot-caps-cache-");
    const run = (maxSize: number | Readonly<Record<string, number>>) =>
      compiled(input, {
        sharedImages: createSharedImageStore(root),
        textures: { decoderFree: true, maxSize },
      });
    const cold = await run({ baseColorTexture: 16, occlusionTexture: 8, normalTexture: 16 });
    const equivalent = await run(16);
    expect(equivalent.buffer).toEqual(cold.buffer);
    const changed = await run({ baseColorTexture: 8, occlusionTexture: 8, normalTexture: 16 });
    expect(changed.buffer).not.toEqual(cold.buffer);
    expect(() => expect(changed.buffer).toEqual(cold.buffer)).toThrow();
  });

  it("should leave a texture under the cap at its authored size", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer, entry } = await compiled(input, { textures: { maxSize: 64 } });
    const root = (await readOutput(buffer)).getRoot();
    for (const texture of root.listTextures()) {
      expect(readKTX2(texture.getImage() ?? new Uint8Array()).pixelWidth).toBe(32);
    }
    expect((entry.embeddedTextures as { readonly resized: number } | undefined)?.resized).toBe(0);
  });

  it("should report bytes and estimated GPU bytes before and after", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { entry } = await compiled(input);
    const summary = entry.embeddedTextures as
      | {
          readonly bytesAfter: number;
          readonly bytesBefore: number;
          readonly count: number;
          readonly gpuBytesAfter: number;
          readonly gpuBytesBefore: number;
        }
      | undefined;
    expect(summary?.count).toBe(2);
    expect(summary?.bytesBefore).toBeGreaterThan(0);
    expect(summary?.bytesAfter).toBeGreaterThan(0);
    // 32x32 RGBA with mips against BC1/BC7 with mips: the GPU cost must fall.
    expect(summary?.gpuBytesBefore).toBe(2 * Math.round(32 * 32 * 4 * (4 / 3)));
    expect(summary?.gpuBytesAfter).toBeLessThan(summary?.gpuBytesBefore ?? 0);
  });

  it('should ship images untouched when textures are "none"', async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer, entry } = await compiled(input, { textures: "none" });
    const root = (await readOutput(buffer)).getRoot();
    for (const texture of root.listTextures()) {
      expect(texture.getMimeType()).toBe("image/png");
    }
    expect(entry.embeddedTextures).toBeUndefined();
  });

  it("should honour a per-slot codec override", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { entry } = await compiled(input, {
      textures: { overrides: [{ codec: "uastc", slot: "baseColorTexture" }] },
    });
    const summary = entry.embeddedTextures as
      | { readonly formats: Readonly<Record<string, string>> }
      | undefined;
    expect(summary?.formats.checker).toBe("uastc");
    await expect(
      compiled(input, { textures: { overrides: [{ codec: "etc1s", slot: "normalTexture" }] } }),
    ).rejects.toThrow(/TN_ASSETS_TEXTURE_SLOT_CODEC/u);
  });

  // Same 4x4 block rule as the standalone pass, same split: an automatic cook retains an image
  // no block codec can take, and only a named per-slot codec fails the build.
  it("should retain an image whose size is not a whole number of blocks", async () => {
    const input = await fixtureWithTextures({ height: 30, width: 30 });
    const before = new Map(
      (await readOutput(input))
        .getRoot()
        .listTextures()
        .map((texture) => [texture.getName(), Buffer.from(texture.getImage() ?? new Uint8Array())]),
    );
    const { buffer, entry } = await compiled(input);
    const summary = entry.embeddedTextures as {
      readonly formats: Readonly<Record<string, string>>;
      readonly gpuBytesAfter: number;
      readonly gpuBytesBefore: number;
      readonly resized: number;
      readonly skippedCompression: Readonly<Record<string, string>>;
    };

    for (const texture of (await readOutput(buffer)).getRoot().listTextures()) {
      const key = texture.getName();
      const image = Buffer.from(texture.getImage() ?? new Uint8Array());
      expect(texture.getMimeType()).toBe("image/png");
      expect(image.equals(before.get(key) ?? Buffer.alloc(0))).toBe(true);
      expect(parsePng(image)).toMatchObject({ height: 30, width: 30 });
      expect(summary.formats[key]).toBe("none");
      expect(summary.skippedCompression[key]).toBe("block-size");
    }
    expect(summary.resized).toBe(0);
    // Nothing was compressed, so the VRAM estimate must still charge 4 bytes per pixel.
    expect(summary.gpuBytesAfter).toBe(2 * Math.round(30 * 30 * 4 * (4 / 3)));
    expect(summary.gpuBytesAfter).toBe(summary.gpuBytesBefore);
  });

  it("should still fail closed on a non-block-aligned image under a named per-slot codec", async () => {
    const input = await fixtureWithTextures({ height: 30, width: 30 });
    await expect(
      apply(input, { textures: { overrides: [{ codec: "uastc", slot: "baseColorTexture" }] } }),
    ).rejects.toThrow(/TN_ASSETS_MODEL_TEXTURE_BLOCK_SIZE.*30x30/su);
  });

  it("should fail closed naming an embedded image it cannot decode", async () => {
    const document = buildFixtureDocument();
    document
      .getRoot()
      .listTextures()[0]
      ?.setImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
      .setMimeType("image/png");
    const input = Buffer.from(await new NodeIO().writeBinary(document));
    // Geometry sub-passes off: `prune` decodes every image itself and would report the
    // truncated source in its own vocabulary before this stage ever sees it.
    await expect(
      apply(input, {
        passes: { dedup: false, meshopt: false, prune: false, quantize: false, reorder: false },
      }),
    ).rejects.toThrow(/TN_ASSETS_MODEL_TEXTURE_UNDECODABLE/u);
  });

  it("should fail closed when compression drops a texture binding", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { buffer } = await compiled(input);
    // Negative control for the self-verify: strip a slot from the compiled output and the
    // same comparison the pass runs must name it.
    const tampered = await readOutput(buffer);
    tampered.getRoot().listMaterials()[0]?.setNormalTexture(null);
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
    const stripped = Buffer.from(await io.writeBinary(tampered));
    const { assertNoTextureDrift, textureBindings } = await import("../src/passes/model.js");
    const intact = textureBindings((await readOutput(buffer)).getRoot());
    const missing = textureBindings((await readOutput(stripped)).getRoot());
    expect(() => assertNoTextureDrift(intact, missing, "character.glb")).toThrow(
      /TN_ASSETS_MODEL_TEXTURE_DRIFT/u,
    );
  });
});

describe("embedded EXT_texture_webp", () => {
  it("should cook a WebP image to KTX2 and drop the extension", async () => {
    // A named per-slot codec also skips the keep-smaller-source guard: a 4x4 WebP is smaller
    // than the KTX2 container around it, and the test needs the cook to have run.
    const { buffer } = await compiled(await fixtureWithWebp(), {
      textures: { overrides: [{ codec: "uastc", slot: "baseColorTexture" }] },
    });
    const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8")) as {
      extensionsRequired?: string[];
      extensionsUsed?: string[];
    };
    expect(json.extensionsUsed ?? []).not.toContain("EXT_texture_webp");
    expect(json.extensionsRequired ?? []).not.toContain("EXT_texture_webp");
    expect(json.extensionsRequired ?? []).toContain("KHR_texture_basisu");

    const cooked = (await readOutput(buffer))
      .getRoot()
      .listTextures()
      .find((texture) => texture.getName() === "checker");
    expect(cooked?.getMimeType()).toBe("image/ktx2");
    const image = cooked?.getImage() ?? new Uint8Array();
    expect(readKTX2(image)).toMatchObject({ pixelHeight: 4, pixelWidth: 4 });
    // UASTC is lossless for 8-bit RGBA, so the transcoded mip is the source colour: proof the
    // WebP payload reached the encoder instead of a container that merely looked like one.
    expectColours(await transcodeFirstLevel(image), 4, 1);
  });

  it("keeps an over-cap WebP lossless in the direct decoder-free pass", async () => {
    const document = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .readBinary(await fixtureWithWebp(8));
    await compressEmbeddedTextures(document, "prop.glb", { decoderFree: true, maxSize: 4 });
    const cooked = document
      .getRoot()
      .listTextures()
      .find((texture) => texture.getName() === "checker");
    expect(cooked?.getMimeType()).toBe("image/png");
    const image = Buffer.from(cooked?.getImage() ?? new Uint8Array());
    expect(parsePng(image)).toMatchObject({ height: 4, width: 4 });
    // A PNG is lossless, so the resampled colour must be the source one.
    expectColours(PNG.sync.read(image).data, 4, 1);
  });

  it("cooks an over-cap WebP to final ASTC on mobile without a runtime decoder", async () => {
    const root = await makeTempDir("threenative-webp-decoder-free-");
    await mkdir(path.join(root, "assets"));
    // 8x8 against a 4-longest-edge cap: `cappedSize` never returns less than one 4x4 block, so
    // this over-cap source must reach the final mobile image at 4x4.
    await writeFile(path.join(root, "assets", "prop.glb"), await fixtureWithWebp(8));

    await compileAssets({
      config: { models: { sharedImages: false, textures: { maxSize: 4 } } },
      cwd: root,
      platform: "android",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    const entry = manifest.entries["prop.glb"];
    if (entry === undefined || typeof entry.output !== "string") {
      throw new Error("no manifest entry for 'prop.glb'");
    }
    expect(entry.extensions ?? []).not.toContain("EXT_texture_webp");
    expect(entry.extensions ?? []).not.toContain("KHR_texture_basisu");
    expect(entry.extensions ?? []).toContain("EXT_texture_astc");

    const cooked = (await readOutput(await readFile(path.join(root, "public", entry.output))))
      .getRoot()
      .listTextures()
      .find((texture) => texture.getName() === "checker");
    expect(cooked?.getMimeType()).toBe("image/ktx2");
    const image = cooked?.getImage() ?? new Uint8Array();
    const container = readKTX2(image);
    expect(container).toMatchObject({
      vkFormat: 158,
      supercompressionScheme: 0,
      pixelWidth: 4,
      pixelHeight: 4,
      pixelDepth: 0,
      layerCount: 0,
      faceCount: 1,
      levelCount: 3,
    });
    expect(
      container.levels.map((level) => [level.levelData.byteLength, level.uncompressedByteLength]),
    ).toEqual([
      [16, 16],
      [16, 16],
      [16, 16],
    ]);
    const authored = await readOutput(await readFile(path.join(root, "assets", "prop.glb")));
    const source = await decodeImageBytes(
      Buffer.from(
        authored
          .getRoot()
          .listTextures()
          .find((texture) => texture.getName() === "checker")
          ?.getImage() ?? [],
      ),
      "prop.glb#checker",
    );
    const score = await qualityInstrument.measureKtx2(
      resampleRgba(source.data, source.width, source.height, 4, 4, true),
      image,
      4,
      4,
      { slots: ["baseColorTexture"] },
    );
    expect(score.status).toBe("pass");
    expect(score.floor).toEqual({ ssim: 0.95, meanDeltaE00: 3 });
    expect(score.ssim).toBeGreaterThanOrEqual(0.95);
    expect(score.meanDeltaE00).toBeLessThanOrEqual(3);
    expectColours(await encoder.decodeAstcKtx2(image, 4, 4), 4, 1);
  });

  it("should convert a WebP even when its KTX2 is larger", async () => {
    // The real-game case: a flat-colour 256x256 WebP costs far fewer bytes than the KTX2
    // container around it, so the keep-smaller-source guard retained the original and the
    // cooked model still required `EXT_texture_webp` — which the decoder-free native targets
    // cannot read. A container only an extension-reading loader understands is never kept.
    const authored = (await readOutput(await fixtureWithWebp(256)))
      .getRoot()
      .listTextures()
      .find((texture) => texture.getName() === "checker")
      ?.getImage()?.byteLength;

    const { buffer, entry } = await compiled(await fixtureWithWebp(256));
    const summary = entry.embeddedTextures as
      | {
          readonly bytesAfter: number;
          readonly bytesBefore: number;
          readonly formats: Readonly<Record<string, string>>;
          readonly skippedCompression: Readonly<Record<string, string>>;
        }
      | undefined;

    // Proof the not-smaller guard really held here: the cook grew the payload, and the row it
    // grew is the one the size report already prints.
    expect(summary?.bytesAfter ?? 0).toBeGreaterThan(summary?.bytesBefore ?? 0);
    expect(summary?.skippedCompression?.checker).toBeUndefined();
    expect(summary?.formats.checker).toBe("etc1s");

    const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8")) as {
      extensionsRequired?: string[];
      extensionsUsed?: string[];
      images: { mimeType?: string }[];
    };
    expect(json.images.some((image) => image.mimeType === "image/webp")).toBe(false);
    expect(json.extensionsUsed ?? []).not.toContain("EXT_texture_webp");
    expect(json.extensionsRequired ?? []).not.toContain("EXT_texture_webp");
    expect(json.extensionsRequired ?? []).toContain("KHR_texture_basisu");
    // The image itself, not just the extension name, got bigger: that is the cost this test
    // buys, and it is the number a reader of the build report sees.
    const cooked = (await readOutput(buffer))
      .getRoot()
      .listTextures()
      .find((texture) => texture.getName() === "checker");
    expect(cooked?.getMimeType()).toBe("image/ktx2");
    expect(cooked?.getImage()?.byteLength ?? 0).toBeGreaterThan(authored ?? 0);
  });

  it("should still keep a PNG whose KTX2 would be larger", async () => {
    // The other half of the same rule, and the reason it is a container test rather than a size
    // test: PNG and JPEG need no extension, so retaining them costs a reader nothing.
    const { buffer, entry } = await compiled(await fixtureWithTextures({ width: 4 }));
    const summary = entry.embeddedTextures as {
      readonly skippedCompression: Readonly<Record<string, string>>;
    };
    expect(summary.skippedCompression.checker).toBe("not-smaller");
    for (const texture of (await readOutput(buffer)).getRoot().listTextures()) {
      expect(texture.getMimeType()).toBe("image/png");
    }
  });

  it("should still fail closed on a container that is not an image", async () => {
    const document = buildFixtureDocument();
    document
      .getRoot()
      .listTextures()[0]
      ?.setImage(Buffer.from("GIF89a not an image at all"))
      .setMimeType("image/png");
    const input = Buffer.from(await new NodeIO().writeBinary(document));
    await expect(
      apply(input, {
        passes: { dedup: false, meshopt: false, prune: false, quantize: false, reorder: false },
      }),
    ).rejects.toThrow(/TN_ASSETS_MODEL_TEXTURE_UNDECODABLE.*TN_ASSETS_TEXTURE_CONTAINER/su);
  });
});

describe("mesh simplification", () => {
  it("should leave triangles untouched unless simplification is declared", async () => {
    const input = await fixtureWithTextures({ width: 32 });
    const { entry } = await compiled(input);
    expect(entry.triangles).toBe(20);
  });

  it("should report the ratio it achieved next to the one that was asked for", async () => {
    // The error tolerance can stop the simplifier well short of the requested ratio — on a
    // real 99k-triangle prop, `ratio: 0.05` with the default error lands at 15.2%. A build
    // that quietly delivers three times the triangles asked for is the kind of silence this
    // pipeline exists to remove, so both numbers are reported.
    const input = Buffer.from(
      await new NodeIO().writeBinary(buildFixtureDocument({ gridDepth: 40, gridWidth: 40 })),
    );
    const { entry } = await compiled(input, {
      simplify: { error: 0.001, ratio: 0.1 },
      textures: "none",
    });
    const summary = entry.simplify as
      | {
          readonly achievedRatio: number;
          readonly error: number;
          readonly requestedRatio: number;
          readonly trianglesAfter: number;
          readonly trianglesBefore: number;
        }
      | undefined;
    expect(summary?.requestedRatio).toBe(0.1);
    expect(summary?.error).toBe(0.001);
    expect(summary?.trianglesBefore).toBe(3208);
    expect(summary?.trianglesAfter).toBe(Number(entry.triangles));
    expect(summary?.achievedRatio).toBeCloseTo(
      (summary?.trianglesAfter ?? 0) / (summary?.trianglesBefore ?? 1),
      5,
    );
  });

  it("should print the achieved ratio in the compile size report", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await makeTempDir("threenative-simplify-report-");
      await mkdir(path.join(root, "assets"));
      await writeFile(
        path.join(root, "assets", "dense.glb"),
        Buffer.from(
          await new NodeIO().writeBinary(buildFixtureDocument({ gridDepth: 40, gridWidth: 40 })),
        ),
      );

      await compileAssets({
        config: { models: { simplify: { ratio: 0.1 }, textures: "none" } },
        cwd: root,
      });

      const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
      expect(
        logged.some((line) =>
          /^simplified dense\.glb: 3208 -> \d+ triangles \(\d+\.\d% kept, requested 10\.0%\)/u.test(
            line,
          ),
        ),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should reduce triangles while preserving joints and clips when declared", async () => {
    const input = Buffer.from(
      await new NodeIO().writeBinary(buildFixtureDocument({ gridDepth: 24, gridWidth: 24 })),
    );
    const before = await compiled(input, { textures: "none" });
    const after = await compiled(input, { simplify: { ratio: 0.5 }, textures: "none" });
    expect(Number(after.entry.triangles)).toBeLessThan(Number(before.entry.triangles));
    const root = (await readOutput(after.buffer)).getRoot();
    expect(root.listSkins()[0]?.listJoints().length).toBe(3);
    expect(root.listAnimations().length).toBe(1);
  });
});

describe("embedded textures through the compile step", () => {
  it("should record the summary and ship the transcoder for a project with models only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await makeTempDir("threenative-model-textures-");
      await mkdir(path.join(root, "assets"));
      const source = await fixtureWithTextures({ width: 32 });
      await writeFile(path.join(root, "assets", "prop.glb"), source);

      await compileAssets({
        cwd: root,
        transcoder: basisTranscoderPaths(),
        modelTranscoderBytes: 0,
      });

      const manifest = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, Record<string, unknown>> };
      const entry = manifest.entries["prop.glb"];
      expect(entry?.extensions).toContain("KHR_texture_basisu");
      expect(entry?.embeddedTextures).toMatchObject({ count: 2, resized: 0 });
      // Not one standalone texture in this project: without the model check the runtime
      // would point its KTX2 loader at a directory that was never written.
      expect(
        (await stat(path.join(root, "public", "basis", "basis_transcoder.wasm"))).isFile(),
      ).toBe(true);
      const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => /^embedded textures prop\.glb: 2 image\(s\)/u.test(line))).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should keep authored images and ship no transcoder when KTX2 cannot repay it", async () => {
    const root = await makeTempDir("threenative-model-textures-cost-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );

    await compileAssets({ cwd: root });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    expect(manifest.entries["prop.glb"]?.extensions).not.toContain("KHR_texture_basisu");
    // The authored containers already decode everywhere; the shared transcoder would cost
    // more than the 32-pixel images it serves.
    await expect(stat(path.join(root, "public", "basis"))).rejects.toThrow();
  });

  it("should give model images KTX2 once a standalone texture already ships the transcoder", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await makeTempDir("threenative-model-textures-paid-");
      await mkdir(path.join(root, "assets"));
      await writeFile(
        path.join(root, "assets", "prop.glb"),
        await fixtureWithTextures({ width: 32 }),
      );
      // An unfiltered flat PNG: ETC1S undercuts it, so the build ships the transcoder anyway.
      const ground = new PNG({ height: 64, width: 64 });
      ground.data.fill(200);
      await writeFile(
        path.join(root, "assets", "ground.png"),
        PNG.sync.write(ground, { deflateLevel: 0 }),
      );
      const manifestPath = path.join(root, "public", "assets.manifest.json");
      const readManifest = async () =>
        JSON.parse(await readFile(manifestPath, "utf8")) as {
          entries: Record<string, Record<string, unknown>>;
        };

      await compileAssets({ cwd: root, transcoder: basisTranscoderPaths() });

      const manifest = await readManifest();
      expect(manifest.entries["ground.png"]?.format).not.toBe("none");
      // The download is paid once per build, so the 32-pixel images no longer have to repay it.
      expect(manifest.entries["prop.glb"]?.extensions).toContain("KHR_texture_basisu");
      // A warm build starts from that decision and cooks nothing again.
      const warm = await compileAssets({ cwd: root, transcoder: basisTranscoderPaths() });
      expect(warm.written).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('should ship images as authored and need no transcoder when models.textures is "none"', async () => {
    const root = await makeTempDir("threenative-model-textures-none-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 32 }),
    );

    await compileAssets({ config: { models: { textures: "none" } }, cwd: root });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    expect(manifest.entries["prop.glb"]?.extensions).not.toContain("KHR_texture_basisu");
    expect(manifest.entries["prop.glb"]?.embeddedTextures).toBeUndefined();
    await expect(stat(path.join(root, "public", "basis"))).rejects.toThrow();
  });

  // The manifest narrows the pass summary field by field rather than casting it, so a reason the
  // narrowing does not recognise is dropped on the way out and the budget never sees it.
  it("should carry the block-size reason into the manifest, fresh and on a cache hit", async () => {
    const root = await makeTempDir("threenative-model-textures-block-size-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ height: 30, width: 30 }),
    );
    const options = { concurrency: 1, cwd: root, transcoder: basisTranscoderPaths() };

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      await compileAssets(options);
      expect(lines).toContain(
        "embedded texture prop.glb#cloth-normal: compression skipped: block-size",
      );
      lines.length = 0;
      const second = await compileAssets(options);
      expect(second.skipped).toBe(1);
      expect(lines).toContain(
        "embedded texture prop.glb#cloth-normal: compression skipped: block-size",
      );
    } finally {
      log.mockRestore();
    }
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    const summary = manifest.entries["prop.glb"]?.embeddedTextures as {
      readonly skippedCompression: Readonly<Record<string, string>>;
    };
    expect(summary.skippedCompression["cloth-normal"]).toBe("block-size");
    expect(manifest.entries["prop.glb"]?.extensions).not.toContain("KHR_texture_basisu");
  });

  it("should cap embedded images on mobile without a runtime Basis decoder", async () => {
    const root = await makeTempDir("threenative-model-textures-decoder-free-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 4096 }),
    );

    await compileAssets({
      config: { models: { sharedImages: false, textures: { maxSize: 1024 } } },
      cwd: root,
      platform: "android",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    const entry = manifest.entries["prop.glb"];
    if (entry === undefined || typeof entry.output !== "string") {
      throw new Error("no manifest entry for 'prop.glb'");
    }
    expect(entry.extensions ?? []).not.toContain("KHR_texture_basisu");
    expect(entry.embeddedTextures).toMatchObject({ resized: 2 });

    const root2 = (
      await readOutput(await readFile(path.join(root, "public", entry.output)))
    ).getRoot();
    for (const texture of root2.listTextures()) {
      const image = Buffer.from(texture.getImage() ?? new Uint8Array());
      const dimensions =
        texture.getMimeType() === "image/ktx2" ? readKTX2(image) : PNG.sync.read(image);
      expect(
        "pixelWidth" in dimensions
          ? [dimensions.pixelWidth, dimensions.pixelHeight]
          : [dimensions.width, dimensions.height],
      ).toEqual([1024, 1024]);
    }
  }, 180_000);

  // The same opt-out the standalone pass honours, on the embedded side: a slot declared
  // `codec: "none"` is the project saying "ship these bytes as authored", and the decoder-free
  // path that replaced the KTX2 encoder on a phone resized the excluded slot anyway.
  it('keeps an embedded image a `codec: "none"` slot excluded at its authored bytes', async () => {
    const root = await makeTempDir("threenative-model-textures-decoder-free-opt-out-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "prop.glb"),
      await fixtureWithTextures({ width: 512 }),
    );

    await compileAssets({
      config: {
        models: {
          sharedImages: false,
          textures: { maxSize: 128, overrides: [{ codec: "none", slot: "baseColorTexture" }] },
        },
      },
      cwd: root,
      platform: "android",
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, Record<string, unknown>> };
    const entry = manifest.entries["prop.glb"];
    if (entry === undefined || typeof entry.output !== "string") {
      throw new Error("no manifest entry for 'prop.glb'");
    }
    // Only the slot the profile did not exclude is resampled.
    expect(entry.embeddedTextures).toMatchObject({ resized: 1 });

    const [excluded, capped] = (
      await readOutput(await readFile(path.join(root, "public", entry.output)))
    )
      .getRoot()
      .listTextures();
    expect(parsePng(Buffer.from(excluded?.getImage() ?? new Uint8Array()))).toMatchObject({
      height: 512,
      width: 512,
    });
    const source = await new NodeIO().readBinary(
      await readFile(path.join(root, "assets", "prop.glb")),
    );
    expect(excluded?.getImage()).toEqual(source.getRoot().listTextures()[0]?.getImage());
    const image = capped?.getImage() ?? new Uint8Array();
    const dimensions =
      capped?.getMimeType() === "image/ktx2" ? readKTX2(image) : PNG.sync.read(Buffer.from(image));
    expect(
      "pixelWidth" in dimensions
        ? [dimensions.pixelWidth, dimensions.pixelHeight]
        : [dimensions.width, dimensions.height],
    ).toEqual([128, 128]);
  });

  it("should reject malformed embedded-texture and simplify config", async () => {
    const root = await makeTempDir("threenative-model-textures-config-");
    await mkdir(path.join(root, "assets"));
    const compile = (models: unknown): Promise<unknown> =>
      compileAssets({ config: { models } as IAssetSourceConfig, cwd: root });

    await expect(compile({ textures: { unknown: true } })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY: assets\.models\.textures\.unknown/u,
    );
    await expect(compile({ textures: "off" })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID: assets\.models\.textures must be "none" or an object/u,
    );
    await expect(compile({ textures: { maxSize: 0 } })).rejects.toThrow(
      /TN_ASSETS_CONFIG_INVALID: assets\.models\.textures\.maxSize must be a positive integer/u,
    );
    for (const maxSize of [
      null,
      [],
      "2048",
      { baseColorTexture: 0 },
      { normalTexture: 1.5 },
      { baseColorTexture: "2048" },
      { mask: 1024 },
      { unknownTexture: 1024 },
    ])
      await expect(compile({ textures: { maxSize } })).rejects.toThrow(
        /TN_ASSETS_CONFIG_(?:INVALID|UNKNOWN_KEY)/u,
      );
    for (const floor of [
      null,
      0,
      { ssim: 2 },
      { ssim: null },
      { meanDeltaE00: -1 },
      { meanDeltaE00: Number.POSITIVE_INFINITY },
      { unknown: true },
    ])
      await expect(compile({ textures: { floor } })).rejects.toThrow(
        /TN_ASSETS_CONFIG_(?:INVALID|UNKNOWN_KEY)/u,
      );
    await expect(
      compile({ textures: { overrides: [{ codec: "bc7", slot: "normalTexture" }] } }),
    ).rejects.toThrow(/codec must be one of etc1s, none, uastc/u);
    await expect(
      compile({ textures: { overrides: [{ codec: "etc1s", slot: "" }] } }),
    ).rejects.toThrow(/slot must be a non-empty string/u);
    await expect(compile({ simplify: { ratio: 0 } })).rejects.toThrow(
      /assets\.models\.simplify\.ratio must be a number greater than 0 and at most 1/u,
    );
    await expect(compile({ simplify: { error: -1, ratio: 0.5 } })).rejects.toThrow(
      /assets\.models\.simplify\.error must be a non-negative number/u,
    );
    await expect(compile({ simplify: { ratio: 0.5, unknown: 1 } })).rejects.toThrow(
      /TN_ASSETS_CONFIG_UNKNOWN_KEY: assets\.models\.simplify\.unknown/u,
    );
  });
});
