import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { read as readKTX2, write as writeKTX2 } from "ktx-parse";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import * as imageQualityModule from "../src/image-quality.js";
import { decodeBasisKtx2, transcodeKtx2ToAstc } from "../src/image-quality.js";
import { type IAssetSourceConfig, compileAssets, texturePass } from "../src/index.js";
import { KTX2_ENCODER_VERSION, decodeAstcKtx2, encodeToKTX2 } from "../src/ktx2-encoder.js";
import { encodeTextureLadder } from "../src/passes/model-textures.js";
import { parsePng } from "../src/png.js";

const TRANSCODER = basisTranscoderPaths();

async function compileOne(
  prefix: string,
  fileName: string,
  bytes: Buffer,
  config?: IAssetSourceConfig,
): Promise<{
  entry: Record<string, unknown>;
  manifest: Record<string, unknown>;
  outputBytes: Buffer;
}> {
  const root = await makeTempDir(prefix);
  await mkdir(path.dirname(path.join(root, "assets", fileName)), { recursive: true });
  await writeFile(path.join(root, "assets", fileName), bytes);
  await compileAssets({ config, cwd: root, transcoder: TRANSCODER });
  const manifest = JSON.parse(
    await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
  ) as { entries: Record<string, Record<string, unknown> | undefined> };
  const entry = manifest.entries[fileName];
  if (entry === undefined) throw new Error(`no manifest entry for '${fileName}'`);
  return {
    entry,
    manifest,
    outputBytes: await readFile(path.join(root, "public", String(entry.output))),
  };
}

/** Flat levels run from 30 at the top-left to 240 at the bottom-right. A flip moves each level to another corner. */
function quadrantLevel(size: number, x: number, y: number): number {
  return 30 + 70 * ((y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1));
}

/** Grey quadrants. Hashed noise from -16 to 15 levels keeps ASTC inexact after a resize. */
function quadrantPng(size: number, noisy = false): Buffer {
  const noise = (x: number, y: number) =>
    (((Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x27d4eb2d)) >>> 16) % 32) - 16;
  const level = (x: number, y: number) => quadrantLevel(size, x, y) + (noisy ? noise(x, y) : 0);
  return rgbaPng({ blue: level, green: level, height: size, red: level, width: size });
}

function ktx2Magic(bytes: Buffer): boolean {
  return [...bytes.subarray(1, 7)].map((byte) => String.fromCharCode(byte)).join("") === "KTX 20";
}

/** Enough distinct pixels for compression to save bytes, so codec assertions reach encoding. */
function compressiblePng(alpha?: (x: number, y: number) => number): Buffer {
  return PNG.sync.write(
    PNG.sync.read(
      rgbaPng({
        alpha,
        width: 64,
        height: 64,
        red: (x, y) => 100 + ((x * 37 + y * 41) % 8),
        green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
        blue: (x, y) => 100 + ((x * 21 + y * 21) % 8),
      }),
    ),
  );
}

describe("the ktx2 texture pass", () => {
  it("rejects final off-colour ASTC despite a passing Basis intermediate", async () => {
    const emit = transcodeKtx2ToAstc;
    const spy = vi
      .spyOn(imageQualityModule, "transcodeKtx2ToAstc")
      .mockImplementation(async (basis) => {
        const astc = readKTX2(await emit(basis));
        for (const level of astc.levels)
          for (let offset = 0; offset < level.levelData.length; offset += 16)
            level.levelData.set(
              [252, 253, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255],
              offset,
            );
        return writeKTX2(astc);
      });
    try {
      const input = rgbaPng({
        width: 8,
        height: 8,
        red: () => 240,
        green: () => 20,
        blue: () => 40,
      });
      await expect(
        texturePass({ astc: true, overrides: [{ glob: "colour.png", codec: "uastc" }] }).apply(
          input,
          "colour.png",
        ),
      ).rejects.toThrow(/TN_ASSETS_TEXTURE_FLOOR/);
    } finally {
      spy.mockRestore();
    }
  });
  it("retains the source when Basis saves bytes but emitted ASTC would grow it", async () => {
    const input = compressiblePng();
    const floor = { ssim: 0, meanDeltaE00: 100 };
    const basis = await texturePass({
      floor,
      overrides: [{ glob: "colour.png", codec: "etc1s" }],
    }).apply(input, "colour.png");
    if (Buffer.isBuffer(basis)) throw new Error("fixture was not encoded");
    const astc = await transcodeKtx2ToAstc(basis.buffer);
    expect(basis.buffer.byteLength).toBeLessThan(input.byteLength);
    expect(astc.byteLength).toBeGreaterThan(input.byteLength);

    const result = await texturePass({ astc: true, floor }).apply(input, "colour.png");
    if (Buffer.isBuffer(result)) throw new Error("fixture has no pass metadata");
    expect(result.buffer).toEqual(input);
    expect(result.entry).toMatchObject({ format: "none", compressionSkipped: "not-smaller" });
  });

  it("rejects ladder candidates whose emitted ASTC exceeds maxBytes", async () => {
    const source = PNG.sync.read(compressiblePng());
    const options = { floor: { ssim: 0, meanDeltaE00: 100 }, srgb: true, quality: 150 };
    const basis = await encodeTextureLadder(source.data, source.width, source.height, options);
    if (basis.encoded === undefined) throw new Error("fixture was not encoded");
    const astc = await transcodeKtx2ToAstc(basis.encoded);
    const maxBytes = Math.floor((basis.encoded.byteLength + astc.byteLength) / 2);
    expect(basis.encoded.byteLength).toBeLessThan(maxBytes);
    expect(astc.byteLength).toBeGreaterThan(maxBytes);

    const admitted = await encodeTextureLadder(source.data, source.width, source.height, {
      ...options,
      astc: true,
      maxBytes: astc.byteLength + 1,
    });
    expect(admitted.encoded?.byteLength).toBe(astc.byteLength);
    expect(admitted.codec).toBe("etc1s");
    expect(readKTX2(admitted.encoded as Uint8Array).vkFormat).toBe(158);

    const result = await encodeTextureLadder(source.data, source.width, source.height, {
      ...options,
      astc: true,
      maxBytes,
    });
    expect(result.encoded).toBeUndefined();
    expect(result.quality.compressionSkipped).toBe("not-smaller");
  });

  it.each(["android", "ios"] as const)(
    "cooks raw ASTC on %s without admitting decoder-backed custom passes",
    async (platform) => {
      const root = await makeTempDir("threenative-mobile-astc-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "colour.png"), compressiblePng());
      await writeFile(path.join(root, "assets", "map_normal.png"), compressiblePng());
      const config = {
        textures: {
          maxSize: 32,
          overrides: [
            { glob: "colour.png", codec: "etc1s" },
            { glob: "map_normal.png", codec: "uastc" },
          ],
          floor: { ssim: 0, meanDeltaE00: 100 },
        },
      } satisfies IAssetSourceConfig;
      const readOutputs = async () => {
        const manifest = JSON.parse(
          await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
        ) as {
          entries: Record<
            string,
            {
              output: string;
              format: string;
              transcodeTargets?: string[];
              quality: { codec: string };
            }
          >;
        };
        return Promise.all(
          Object.values(manifest.entries).map(async (entry) => ({
            entry,
            bytes: await readFile(path.join(root, "public", entry.output)),
          })),
        );
      };
      await compileAssets({
        cwd: root,
        config,
        platform: "web",
        transcoder: TRANSCODER,
        concurrency: 1,
      });
      const web = await readOutputs();
      await compileAssets({
        cwd: root,
        config,
        platform: "desktop",
        transcoder: TRANSCODER,
        concurrency: 1,
      });
      expect(await readOutputs()).toEqual(web);
      const options = {
        cwd: root,
        config,
        platform,
        runtimeDecoders: { ktx2: false, meshopt: false },
        concurrency: 1,
      };
      const mobile = await compileAssets(options);
      expect(mobile.written).toBe(2);
      const outputs = await readOutputs();
      expect(outputs.map(({ entry }) => entry.format)).toEqual(["astc4x4", "astc4x4"]);
      for (const { entry, bytes } of outputs) {
        const raw = readKTX2(bytes);
        expect(raw.vkFormat).toBe(entry.quality.codec === "etc1s" ? 158 : 157);
        expect(raw.supercompressionScheme).toBe(0);
        expect([raw.pixelWidth, raw.pixelHeight, raw.levelCount]).toEqual([32, 32, 6]);
        expect(entry.transcodeTargets).toBeUndefined();
      }
      await expect(
        stat(path.join(root, "public", "basis", "basis_transcoder.wasm")),
      ).rejects.toThrow();
      expect((await compileAssets(options)).written).toBe(0);
      expect(await readOutputs()).toEqual(outputs);
      await compileAssets({
        cwd: root,
        config,
        platform: "web",
        transcoder: TRANSCODER,
        concurrency: 1,
      });
      expect(await readOutputs()).toEqual(web);
      const apply = vi.fn(async (input: Buffer) => input);
      const custom = await compileAssets({
        ...options,
        passes: [{ name: "basis-only", appliesTo: ["texture"], needsRuntimeDecoder: true, apply }],
      });
      expect(apply).not.toHaveBeenCalled();
      expect(custom.skippedCompression).toContainEqual(
        expect.objectContaining({ pass: "basis-only", reason: "platform" }),
      );
    },
  );
  it("preserves pure noise when every compressed rung falls below the quality floor", async () => {
    const channel = (x: number, y: number, shift: number): number => {
      let value = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x27d4eb2d);
      value ^= value >>> 16;
      return value >>> shift;
    };
    const input = rgbaPng({
      blue: (x, y) => channel(x, y, 16),
      green: (x, y) => channel(x, y, 8),
      height: 128,
      red: (x, y) => channel(x, y, 0),
      width: 128,
    });
    const { entry, outputBytes } = await compileOne(
      "threenative-tex-scaffold-codec-",
      "web-codec-proof.png",
      input,
    );
    expect(entry.output).toMatch(/\.png$/u);
    expect(outputBytes).toEqual(input);
    expect(entry).toMatchObject({
      format: "none",
      compressionSkipped: "below-floor",
      quality: { codec: "none", rung: "none", compressionSkipped: "below-floor" },
    });
  });

  it("measures standalone output without changing bytes", async () => {
    const input = compressiblePng();
    const options = { overrides: [{ glob: "flat.png", codec: "etc1s" as const }] };
    const on = await texturePass(options).apply(input, "flat.png");
    const off = await texturePass({ ...options, measureQuality: false }).apply(input, "flat.png");
    if (Buffer.isBuffer(on) || Buffer.isBuffer(off)) throw new Error("fixture was not encoded");
    expect(on.buffer).toEqual(off.buffer);
    expect(on.entry?.quality).toMatchObject({ version: expect.any(String), width: 64, height: 64 });
    expect(off.entry?.quality).toBeUndefined();
  });
  it("should preserve the upstream supercompression default and its explicit false override", async () => {
    const data = new Uint8Array(16 * 16 * 4).fill(128);
    const options = { imageDecoder: async () => ({ data, height: 16, width: 16 }) };
    const implicit = await encodeToKTX2(data, options);
    const explicit = await encodeToKTX2(data, { ...options, needSupercompression: true });
    const disabled = await encodeToKTX2(data, { ...options, needSupercompression: false });
    expect(implicit).toEqual(explicit);
    expect(readKTX2(implicit).supercompressionScheme).toBe(2);
    expect(readKTX2(disabled).supercompressionScheme).toBe(0);
    expect(() => expect(readKTX2(disabled).supercompressionScheme).toBe(2)).toThrow();
    expect(texturePass().configuration?.encoder).toBe(KTX2_ENCODER_VERSION);
  });

  it("rejects a capped image and oversize input at the retained-4K encoder gate", async () => {
    const source = rgbaPng({ height: 4096, width: 4096 });
    const capped = await texturePass({ maxSize: 2048 }).apply(source, "capped_normal.png");
    if (Buffer.isBuffer(capped)) throw new Error("4K control was not capped");
    const dimensions = readKTX2(capped.buffer);
    expect([dimensions.pixelWidth, dimensions.pixelHeight]).toEqual([2048, 2048]);
    expect(() =>
      expect([dimensions.pixelWidth, dimensions.pixelHeight]).toEqual([4096, 4096]),
    ).toThrow();
    await expect(
      encodeToKTX2(source, {
        imageDecoder: async () => ({ data: new Uint8Array(), width: 4096, height: 4100 }),
      }),
    ).rejects.toThrow(/TN_ASSETS_KTX2_SOURCE_SIZE/u);
  });

  it("should not grow the starter's 150-byte source image unless its codec is overridden", async () => {
    const input = await readFile(
      new URL(
        "../../create-threenative/templates/starter/assets/native-proof.png",
        import.meta.url,
      ),
    );
    expect(input.byteLength).toBe(150);
    const { outputBytes } = await compileOne("threenative-tiny-default-", "proof.png", input);
    expect(outputBytes.byteLength).toBeLessThanOrEqual(input.byteLength);
    expect(outputBytes).toEqual(input);
    const forced = await compileOne("threenative-tiny-forced-", "proof.png", input, {
      textures: { overrides: [{ glob: "proof.png", codec: "etc1s" }] },
    });
    expect(ktx2Magic(forced.outputBytes)).toBe(true);
    expect(forced.outputBytes.byteLength).toBeGreaterThan(input.byteLength);
  });

  it("should keep a non-block-aligned maxSize as an actual maximum", async () => {
    // Removing the floor snap makes this 16x8 source encode at 12x8 for maxSize 10, exceeding
    // the game-owned cap. The literal 8x4 result preserves this source's 2:1 aspect ratio.
    const { outputBytes } = await compileOne(
      "threenative-tex-max-size-ten-",
      "cliff.png",
      rgbaPng({ height: 8, width: 16 }),
      { textures: { maxSize: 10 } },
    );

    const ktx2 = readKTX2(outputBytes);
    expect([ktx2.pixelWidth, ktx2.pixelHeight]).toEqual([8, 4]);
    expect(Math.max(ktx2.pixelWidth, ktx2.pixelHeight)).toBeLessThanOrEqual(10);
    expect(ktx2.pixelWidth % 4).toBe(0);
    expect(ktx2.pixelHeight % 4).toBe(0);
  });

  it("stores standalone ASTC rows bottom-up, so an upload without flipY matches the PNG", async () => {
    const size = 64;
    const result = await texturePass({
      astc: true,
      overrides: [{ glob: "colour.png", codec: "uastc" }],
    }).apply(quadrantPng(size), "colour.png");
    if (Buffer.isBuffer(result)) throw new Error("texture was not encoded");
    expect(result.entry?.format).toBe("astc4x4");
    const decoded = await decodeAstcKtx2(result.buffer, size, size);
    const red = (x: number, y: number) => decoded[(y * size + x) * 4] ?? Number.NaN;
    // Decoded row y must hold source row size - 1 - y. A column flip or no flip fails these samples.
    for (const y of [8, 56])
      for (const x of [8, 56])
        expect(Math.abs(red(x, y) - quadrantLevel(size, x, size - 1 - y))).toBeLessThanOrEqual(16);
  });

  it("keeps PNG orientation for codec none, retained PNG and non-ASTC output", async () => {
    const size = 64;
    const input = quadrantPng(size, true);
    const none = await texturePass({
      astc: true,
      overrides: [{ glob: "colour.png", codec: "none" }],
    }).apply(input, "colour.png");
    if (Buffer.isBuffer(none)) throw new Error("codec none did not pass the source through");
    expect(none.buffer).toEqual(input);

    // No lossy encoder meets this floor, so the pass retains the resized PNG.
    const retained = await texturePass({
      astc: true,
      floor: { meanDeltaE00: 0, ssim: 1 },
      maxSize: 32,
    }).apply(input, "colour.png");
    if (Buffer.isBuffer(retained)) throw new Error("texture was not retained");
    expect(retained.entry?.format).toBe("none");
    const png = PNG.sync.read(retained.buffer);
    // An 8x8 window mean cancels the hashed noise. A row flip moves each mean to another quadrant.
    const mean = (cx: number, cy: number) => {
      let sum = 0;
      for (let y = cy - 4; y < cy + 4; y += 1)
        for (let x = cx - 4; x < cx + 4; x += 1) sum += png.data[(y * 32 + x) * 4] ?? Number.NaN;
      return sum / 64;
    };
    for (const y of [8, 24])
      for (const x of [8, 24])
        expect(Math.abs(mean(x, y) - quadrantLevel(size, x * 2, y * 2))).toBeLessThanOrEqual(16);

    // The Basis path keeps source row order. A row flip would move level 30 to level 170 here.
    // The flat source keeps this single-pixel sample free of the hashed noise.
    const basis = await texturePass({
      overrides: [{ glob: "colour.png", codec: "uastc" }],
    }).apply(quadrantPng(size), "colour.png");
    if (Buffer.isBuffer(basis)) throw new Error("texture was not encoded");
    const decodedBasis = await decodeBasisKtx2(basis.buffer, size, size);
    const basisRed = decodedBasis[(8 * size + 8) * 4] ?? Number.NaN;
    expect(Math.abs(basisRed - quadrantLevel(size, 8, 8))).toBeLessThanOrEqual(16);
  });

  it("should cap standalone colour and normal textures through the encoder decoder without upscaling or changing none bytes", async () => {
    // Removing maxSize from the pass configuration makes the first two KTX2 dimensions stay
    // 12x8, so this asserts the encoded artifact rather than a decoder mock.
    const root = await makeTempDir("threenative-tex-max-size-");
    await mkdir(path.join(root, "assets", "ui"), { recursive: true });
    const source = rgbaPng({ height: 8, width: 12 });
    const small = rgbaPng({ height: 4, width: 4 });
    await writeFile(path.join(root, "assets", "cliff.png"), source);
    await writeFile(path.join(root, "assets", "ridge_normal.png"), source);
    await writeFile(path.join(root, "assets", "small.png"), small);
    await writeFile(path.join(root, "assets", "ui", "icon.png"), source);

    await compileAssets({
      config: {
        textures: {
          maxSize: 8,
          overrides: [{ codec: "none", glob: "ui/**" }],
        },
      },
      cwd: root,
      transcoder: TRANSCODER,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    );
    for (const logicalPath of ["cliff.png", "ridge_normal.png"]) {
      const compiled = await readFile(
        path.join(root, "public", manifest.entries[logicalPath].output),
      );
      const ktx2 = readKTX2(compiled);
      expect([ktx2.pixelWidth, ktx2.pixelHeight]).toEqual([8, 4]);
    }
    const smallOutput = await readFile(
      path.join(root, "public", manifest.entries["small.png"].output),
    );
    expect(smallOutput).toEqual(small);
    expect(
      await readFile(path.join(root, "public", manifest.entries["ui/icon.png"].output)),
    ).toEqual(source);
  });

  it("resolves standalone caps from the existing colour and normal semantics", async () => {
    const input = rgbaPng({ height: 16, width: 16 });
    const pass = texturePass({ maxSize: { baseColorTexture: 12, normalTexture: 8 } });
    for (const [name, size] of [
      ["cliff.png", 12],
      ["cliff_normal.png", 8],
    ] as const) {
      const result = await pass.apply(input, name);
      if (Buffer.isBuffer(result)) throw new Error("texture was not capped");
      const ktx2 = readKTX2(result.buffer);
      expect([ktx2.pixelWidth, ktx2.pixelHeight]).toEqual([size, size]);
    }
  });

  it("should preserve cutout alpha on a passing ETC1S candidate", async () => {
    // Alpha is judged independently; binary cutouts can pass on the ETC1S rung.
    const { entry, outputBytes } = await compileOne(
      "threenative-tex-uastc-",
      "decal.png",
      compressiblePng((x) => (x % 2 === 0 ? 255 : 0)),
      { textures: { overrides: [{ glob: "decal.png", codec: "etc1s" }] } },
    );

    expect(entry.format).toBe("etc1s");
    expect(entry.transcodeTargets).toEqual(["bc1", "etc2"]);
    expect(String(entry.output)).toMatch(/^decal\.[0-9a-f]{8}\.ktx2$/u);
    expect(ktx2Magic(outputBytes)).toBe(true);
    // ETC1S uses BasisLZ; UASTC rungs retain the default Zstd compression.
    expect(readKTX2(outputBytes).supercompressionScheme).toBe(1);
    expect(entry.quality).toMatchObject({
      status: "pass",
      alpha: { ssim: 1, meanAbsoluteError: 0 },
    });
  });

  it("should honour a config override over the heuristic", async () => {
    // The source has alpha, so the heuristic alone would pick UASTC; the override must win.
    const overridden = await compileOne(
      "threenative-tex-override-",
      "decal.png",
      rgbaPng({ alpha: () => 128, height: 64, width: 64 }),
      { textures: { overrides: [{ codec: "etc1s", glob: "**/*.png" }] } },
    );
    expect(overridden.entry.format).toBe("etc1s");
    expect(ktx2Magic(overridden.outputBytes)).toBe(true);

    // A narrower override beats a broader one, first match wins.
    const narrowed = await compileOne(
      "threenative-tex-override-narrow-",
      "props/decal.png",
      rgbaPng({ alpha: () => 10, height: 32, width: 32 }),
      {
        textures: {
          overrides: [
            { codec: "uastc", glob: "props/**" },
            { codec: "etc1s", glob: "**/*.png" },
          ],
        },
      },
    );
    expect(narrowed.entry.format).toBe("uastc");
  });

  it("should emit a full mip chain", async () => {
    const root = await makeTempDir("threenative-tex-mips-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "ground.png"), compressiblePng());
    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string } | undefined> };
    const groundEntry = manifest.entries["ground.png"];
    if (groundEntry === undefined) throw new Error("no manifest entry for 'ground.png'");
    const compiled = await readFile(path.join(root, "public", groundEntry.output));

    // 64x64 encodes with every level down to 1x1: log2(64) + 1 = 7.
    expect(readKTX2(compiled).levelCount).toBe(7);
    const input = compressiblePng();
    const decoded = PNG.sync.read(input);
    const noMips = await encodeToKTX2(input, {
      imageDecoder: async () => decoded,
      generateMipmap: false,
    });
    expect(() => expect(readKTX2(noMips).levelCount).toBe(7)).toThrow();
  });

  it("should permit ETC1S for an opaque texture without the normal-map convention", async () => {
    const { entry } = await compileOne("threenative-tex-etc1s-", "wall.jpg", compressiblePng(), {
      textures: { overrides: [{ glob: "wall.jpg", codec: "etc1s" }] },
    });
    expect(entry.format).toBe("etc1s");
  });

  it("should pick UASTC for the normal-map filename convention on an opaque source", async () => {
    for (const name of ["bricks_normal.png", "detail_nrm.png", "surface-Normal.PNG"]) {
      const { entry } = await compileOne(
        "threenative-tex-normal-",
        name.toLowerCase(),
        compressiblePng(),
      );
      expect(entry.format).toBe("uastc");
    }
  });

  it("should leave sources verbatim when an override selects the none codec", async () => {
    const root = await makeTempDir("threenative-tex-none-override-");
    await mkdir(path.join(root, "assets", "ui"), { recursive: true });
    const source = rgbaPng({ height: 32, width: 32 });
    await writeFile(path.join(root, "assets", "ui/icon.png"), source);
    await compileAssets({
      cwd: root,
      transcoder: TRANSCODER,
      config: { textures: { overrides: [{ codec: "none", glob: "ui/**" }] } },
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string; format?: string } | undefined> };
    const entry = manifest.entries["ui/icon.png"];
    if (entry === undefined) throw new Error("no manifest entry for 'ui/icon.png'");
    expect(entry.format).toBeUndefined();
    expect(entry.output).toMatch(/\.png$/u);
    expect((await readFile(path.join(root, "public", entry.output))).equals(source)).toBe(true);
  });

  // Every codec this pass emits transcodes to 4x4 block formats (BC1/ETC2 from ETC1S,
  // ASTC 4x4/BC7 from UASTC), and WebGPU rejects a compressed texture whose base level is
  // not a whole number of blocks: "the size (Extent3D width:1254, height:1254) ... is not a
  // multiple of the block width (4) and height (4)". Basis encodes such a source happily and
  // stamps the odd size into the KTX2 header, so the build went green and the game died at
  // the first draw call. A requested codec therefore fails closed at encode, naming the escape
  // hatch — but only when the project asked for that codec by name.
  it("should refuse a source whose dimensions are not a multiple of the 4x4 block", async () => {
    const root = await makeTempDir("threenative-tex-block-size-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "floor.png"),
      rgbaPng({ blue: (x) => x * 2, height: 66, width: 66 }),
    );

    await expect(
      compileAssets({
        cwd: root,
        transcoder: TRANSCODER,
        config: { textures: { overrides: [{ codec: "uastc", glob: "**/*.png" }] } },
      }),
    ).rejects.toThrow(/TN_ASSETS_TEXTURE_BLOCK_SIZE.*floor\.png.*66x66.*4x4/su);
  });

  // The cook runs on every scaffolded project with no `assets` config at all, so the throw
  // above used to end a whole build over one 11x10 decal, with both escapes on the game's side
  // of the line: resize the art, or hand-write a `codec: "none"` override. Nothing can compress
  // this source, so retain its exact bytes and report why rather than refusing the build.
  it("should retain a non-block-aligned source unchanged when no override names a codec", async () => {
    const source = rgbaPng({ blue: (x) => x * 2, height: 10, width: 11 });
    const { entry, outputBytes } = await compileOne(
      "threenative-tex-block-size-default-",
      "decal.png",
      source,
    );

    expect(entry.compressionSkipped).toBe("block-size");
    expect(entry.format).toBeUndefined();
    expect(entry.output).toMatch(/\.png$/u);
    // Byte-identical, because resampling a texture moves every UV the model was authored
    // against: the dimensions the game shipped are the dimensions it gets back.
    expect(outputBytes.equals(source)).toBe(true);
    expect(parsePng(outputBytes)).toMatchObject({ height: 10, width: 11 });
  });

  it("should print the block-size reason on a fresh compile and again on a cache hit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await makeTempDir("threenative-tex-block-size-report-");
      await mkdir(path.join(root, "assets"));
      await writeFile(
        path.join(root, "assets", "decal.png"),
        rgbaPng({ blue: (x) => x * 2, height: 10, width: 11 }),
      );

      await compileAssets({ cwd: root, transcoder: TRANSCODER });
      const fresh = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
      vi.mocked(console.log).mockClear();
      const second = await compileAssets({ cwd: root, transcoder: TRANSCODER });
      const cached = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));

      // A cache hit reuses the previous manifest entry wholesale, so the reason has to survive
      // on the entry rather than being computed by the pass that no longer runs.
      expect(second.skipped).toBe(1);
      for (const lines of [fresh, cached]) {
        expect(
          lines.filter((line) =>
            /^texture decal\.png: \d+ -> \d+ bytes \([^)]*\); compression skipped: block-size$/u.test(
              line,
            ),
          ),
        ).toHaveLength(1);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should let the none codec carry a source the block formats cannot take", async () => {
    // The named override is the way out: the source ships verbatim rather than silently
    // resampled, because resizing a texture moves every UV the model was authored against.
    const root = await makeTempDir("threenative-tex-block-size-none-");
    await mkdir(path.join(root, "assets", "ui"), { recursive: true });
    const source = rgbaPng({ height: 66, width: 66 });
    await writeFile(path.join(root, "assets", "ui/panel.png"), source);

    await compileAssets({
      cwd: root,
      transcoder: TRANSCODER,
      config: { textures: { overrides: [{ codec: "none", glob: "ui/**" }] } },
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string } | undefined> };
    const entry = manifest.entries["ui/panel.png"];
    if (entry === undefined) throw new Error("no manifest entry for 'ui/panel.png'");
    expect((await readFile(path.join(root, "public", entry.output))).equals(source)).toBe(true);
  });

  it("should reject a source the encoder cannot decode, naming the file", async () => {
    const root = await makeTempDir("threenative-tex-undecodable-");
    await mkdir(path.join(root, "assets"));
    // A .webp source is classified as a texture but has no decoder in this pass yet.
    await writeFile(path.join(root, "assets", "photo.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    await expect(compileAssets({ cwd: root })).rejects.toThrow(/photo\.webp/u);
  });

  it("should not run on non-texture inputs", async () => {
    const root = await makeTempDir("threenative-tex-passthrough-");
    await mkdir(path.join(root, "assets"));
    const audio = Buffer.from("not really an ogg");
    await writeFile(path.join(root, "assets", "blip.ogg"), audio);
    const result = await texturePass().apply(audio, "blip.ogg");
    expect(result).toBe(audio);
  });

  it("should restore the Basis transcoder after public/ is cleaned", async () => {
    const root = await makeTempDir("threenative-tex-transcoder-regen-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), compressiblePng());
    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    await rm(path.join(root, "public", "basis"), { recursive: true });

    // Nothing re-encoded this run (same sources), but a served manifest still needs its
    // transcoder, so the copy step restores it.
    const second = await compileAssets({ cwd: root, transcoder: TRANSCODER });
    expect(second.written).toBe(0);
    expect((await stat(path.join(root, "public", "basis", "basis_transcoder.js"))).isFile()).toBe(
      true,
    );
  });
});

// A target with no Basis transcoder used to ignore `textures.maxSize` outright and ship the
// authored bytes. The cap is a project decision, not a property of the codec, so it has to be
// honoured by resampling to PNG instead of encoding.
describe("the decoder-free size cap", () => {
  const noise = (x: number, y: number, salt: number): number => {
    let value = Math.imul(x + salt, 0x45d9f3b) ^ Math.imul(y + salt, 0x119de1f3);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) & 0xff;
  };

  it("should cap colour, normal and alpha textures to 1024 by resampling, leaving the source and a small texture alone", async () => {
    const root = await makeTempDir("threenative-tex-resize-");
    await mkdir(path.join(root, "assets"));
    const color = rgbaPng({
      blue: (x, y) => noise(x, y, 97),
      green: (x, y) => noise(x, y, 53),
      height: 4096,
      red: (x, y) => noise(x, y, 11),
      width: 4096,
    });
    const normal = rgbaPng({
      blue: () => 255,
      green: (x, y) => noise(x, y, 53),
      height: 4096,
      red: (x, y) => noise(x, y, 11),
      width: 4096,
    });
    const alpha = rgbaPng({
      alpha: (x) => (x < 2048 ? 0 : 255),
      height: 4096,
      width: 4096,
    });
    const small = rgbaPng({ height: 512, width: 512 });
    await writeFile(path.join(root, "assets", "cliff.png"), color);
    await writeFile(path.join(root, "assets", "bricks_normal.png"), normal);
    await writeFile(path.join(root, "assets", "decal.png"), alpha);
    await writeFile(path.join(root, "assets", "small.png"), small);

    // A decoder-free desktop runtime retains the PNG resize path. Mobile cooks raw ASTC.
    // Read back the emitted bytes, not the resolved config.
    await compileAssets({
      config: { textures: { maxSize: 1024 } },
      cwd: root,
      platform: "desktop",
      runtimeDecoders: { ktx2: false, meshopt: false },
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string } | undefined> };
    for (const logical of ["cliff.png", "bricks_normal.png", "decal.png"]) {
      const entry = manifest.entries[logical];
      if (entry === undefined) throw new Error(`no manifest entry for '${logical}'`);
      expect(entry.output).toMatch(/\.png$/u);
      const resized = PNG.sync.read(await readFile(path.join(root, "public", entry.output)));
      expect([resized.width, resized.height]).toEqual([1024, 1024]);
    }

    // The alpha-bearing source survives the resample with real transparency, not an opaque
    // RGBA container that discarded it.
    const decalEntry = manifest.entries["decal.png"];
    const decal = PNG.sync.read(
      await readFile(path.join(root, "public", String(decalEntry?.output))),
    );
    const alphaValues = new Set<number>();
    for (let offset = 3; offset < decal.data.length; offset += 4) {
      alphaValues.add(decal.data[offset] ?? 255);
    }
    expect(alphaValues.has(0)).toBe(true);
    expect(alphaValues.size).toBeGreaterThan(1);

    // Authored sources are never rewritten.
    expect((await readFile(path.join(root, "assets", "cliff.png"))).equals(color)).toBe(true);
    expect((await readFile(path.join(root, "assets", "decal.png"))).equals(alpha)).toBe(true);

    // Under the cap: byte-identical, no re-encode.
    const smallEntry = manifest.entries["small.png"];
    const smallOut = await readFile(path.join(root, "public", String(smallEntry?.output)));
    expect(smallOut.equals(small)).toBe(true);
  }, 180_000);

  // A `codec: "none"` override is a project saying "ship these bytes as authored". The KTX2 pass
  // honoured that; the decoder-free path that replaced it on a phone resized the same files
  // anyway, so the opt-out only worked on the targets that still had a Basis transcoder.
  it('keeps a texture a `codec: "none"` override excluded at its authored bytes', async () => {
    const root = await makeTempDir("threenative-tex-resize-opt-out-");
    await mkdir(path.join(root, "assets", "ui"), { recursive: true });
    const rock = rgbaPng({
      blue: (x, y) => noise(x, y, 97),
      green: (x, y) => noise(x, y, 53),
      height: 128,
      red: (x, y) => noise(x, y, 11),
      width: 128,
    });
    const icon = rgbaPng({
      blue: (x, y) => noise(x, y, 17),
      green: (x, y) => noise(x, y, 71),
      height: 128,
      red: (x, y) => noise(x, y, 23),
      width: 128,
    });
    await writeFile(path.join(root, "assets", "rock.png"), rock);
    await writeFile(path.join(root, "assets", "ui", "x.png"), icon);

    await compileAssets({
      config: { textures: { maxSize: 64, overrides: [{ codec: "none", glob: "ui/**" }] } },
      cwd: root,
      platform: "desktop",
      runtimeDecoders: { ktx2: false, meshopt: false },
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { output: string } | undefined> };
    const excluded = await readFile(
      path.join(root, "public", String(manifest.entries["ui/x.png"]?.output)),
    );
    expect(excluded.equals(icon)).toBe(true);
    const capped = PNG.sync.read(
      await readFile(path.join(root, "public", String(manifest.entries["rock.png"]?.output))),
    );
    expect([capped.width, capped.height]).toEqual([64, 64]);
  });

  it("should reject corrupt image bytes, naming the logical path", async () => {
    const root = await makeTempDir("threenative-tex-resize-corrupt-");
    await mkdir(path.join(root, "assets"));
    const valid = rgbaPng({ height: 4096, width: 4096 });
    // A PNG signature and a truncated body: the header never parses and no decoder can read it.
    await writeFile(path.join(root, "assets", "broken.png"), valid.subarray(0, 64));

    await expect(
      compileAssets({
        config: { textures: { maxSize: 1024 } },
        cwd: root,
        platform: "desktop",
        runtimeDecoders: { ktx2: false, meshopt: false },
      }),
    ).rejects.toThrow(/TN_ASSETS_TEXTURE_UNDECODABLE.*broken\.png/su);
  });
});

it.runIf(process.env.TN_ASSETS_RUN_4K_KTX2 === "1")(
  "should retain an ordinary 4096-square normal map through the default KTX2 pass",
  async () => {
    const noise = (x: number, y: number, salt: number): number => {
      let value = Math.imul(x + salt, 0x45d9f3b) ^ Math.imul(y + salt, 0x119de1f3);
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      return (value ^ (value >>> 16)) & 0xff;
    };
    const { entry, outputBytes } = await compileOne(
      "threenative-tex-4k-",
      "cliff_normal.png",
      rgbaPng({
        blue: (x, y) => noise(x, y, 97),
        green: (x, y) => noise(x, y, 53),
        height: 4096,
        red: (x, y) => noise(x, y, 11),
        width: 4096,
      }),
    );

    const container = readKTX2(outputBytes);
    expect([container.pixelWidth, container.pixelHeight]).toEqual([4096, 4096]);
    expect(container.levelCount).toBe(13);
    expect(container.supercompressionScheme).toBe(2);
    expect(entry.format).toBe("uastc");
    expect(entry.transcodeTargets).toEqual(["astc4x4", "bc7"]);
  },
  180_000,
);
