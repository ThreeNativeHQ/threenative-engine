import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { read as readKTX2, write as writeKTX2 } from "ktx-parse";
import { describe, expect, it } from "vitest";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { deltaE00, imageQuality, ssim } from "../src/image-quality.js";
import { measureKtx2, transcodeKtx2ToAstc } from "../src/image-quality.js";
import { decodeAstcKtx2, encodeToKTX2 } from "../src/ktx2-encoder.js";
import { decodeImageBytes } from "../src/passes/decode-image.js";

function pixels(noise = false): Uint8Array {
  const data = new Uint8Array(32 * 32 * 4);
  let seed = 123;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i + c] = noise ? seed >>> 24 : 128;
    }
    data[i + 3] = 255;
  }
  return data;
}

describe("image quality instrument", () => {
  it.each([
    { slot: "normalTexture", rgba: [128, 128, 255, 255], srgb: false, primaries: 0 as const },
    {
      slot: "metallicRoughnessTexture",
      rgba: [10, 128, 255, 255],
      srgb: false,
      primaries: 0 as const,
    },
    { slot: "baseColorTexture", rgba: [240, 20, 40, 128], srgb: true, primaries: 1 as const },
  ])(
    "glTF ASTC metadata matches $slot before final-buffer scoring",
    async ({ slot, rgba, srgb, primaries }) => {
      const data = new Uint8Array(8 * 8 * 4);
      for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
      const basis = await encodeToKTX2(data, {
        imageDecoder: async () => ({ data, width: 8, height: 8 }),
        isUASTC: true,
        isNormalMap: slot === "normalTexture",
        isSetKTX2SRGBTransferFunc: srgb,
      });
      const original = await transcodeKtx2ToAstc(basis);
      // Exact default bytes captured before this change at e49bb087f (8x8 RGBA fixture).
      if (srgb)
        expect(createHash("sha256").update(original).digest("hex")).toBe(
          "2e75ef39257d356a9c433626b70fbe7fa25528734c7342fc6deccfa83aedbaf4",
        );
      const final = await transcodeKtx2ToAstc(basis, primaries);
      const before = readKTX2(original);
      const after = readKTX2(final);
      const beforeDescriptor = before.dataFormatDescriptor[0];
      const afterDescriptor = after.dataFormatDescriptor[0];
      if (beforeDescriptor === undefined || afterDescriptor === undefined)
        throw new Error("fixture descriptor missing");
      expect(afterDescriptor.colorPrimaries).toBe(primaries);
      expect(after.vkFormat).toBe(srgb ? 158 : 157);
      expect(afterDescriptor.transferFunction).toBe(srgb ? 2 : 1);
      expect(afterDescriptor.flags).toBe(0);
      expect(after.keyValue.KTXorientation).toBeUndefined();
      expect(after.levels.map((level) => level.levelData.byteLength)).toEqual([64, 16, 16, 16]);
      expect(after.levels.map((level) => level.levelData)).toEqual(
        before.levels.map((level) => level.levelData),
      );
      const score = await measureKtx2(data, final, 8, 8, { slots: [slot] });
      expect(score.status).toBe(srgb ? "pass" : "unvalidated-slots");
      afterDescriptor.colorPrimaries = beforeDescriptor.colorPrimaries;
      expect(writeKTX2(after)).toEqual(original);
      expect(await transcodeKtx2ToAstc(basis)).toEqual(original);
      await expect(transcodeKtx2ToAstc(basis, 2 as 0)).rejects.toThrow(/TN_ASSETS_ASTC_METADATA/u);
      await expect(transcodeKtx2ToAstc(basis, srgb ? 0 : 1)).rejects.toThrow(
        /TN_ASSETS_ASTC_METADATA/u,
      );
    },
  );

  it.each([false, true])(
    "transcodes every ETC1S/UASTC mip directly to raw ASTC (UASTC=%s)",
    async (isUASTC) => {
      const data = new Uint8Array(8 * 8 * 4);
      for (let i = 0; i < 64; i += 1)
        data.set(i % 8 < 4 ? [200, 130, 40, 255] : [20, 60, 220, 255], i * 4);
      const encoded = await encodeToKTX2(data, {
        imageDecoder: async () => ({ data, height: 8, width: 8 }),
        isUASTC,
        isSetKTX2SRGBTransferFunc: !isUASTC,
      });
      const paths = basisTranscoderPaths();
      const shim = { exports: {} as unknown };
      new Function(
        "module",
        "exports",
        "require",
        "__filename",
        "__dirname",
        await readFile(paths.javascriptPath, "utf8"),
      )(
        shim,
        shim.exports,
        createRequire(import.meta.url),
        paths.javascriptPath,
        path.dirname(paths.javascriptPath),
      );
      const basis = await (
        shim.exports as (options: { wasmBinary: Uint8Array }) => Promise<{
          initializeBasis(): void;
          transcoder_texture_format: { cTFASTC_4x4_RGBA: { value: number } };
          KTX2File: new (
            bytes: Uint8Array,
          ) => {
            isETC1S(): boolean;
            startTranscoding(): boolean;
            getLevels(): number;
            getImageTranscodedSizeInBytes(...args: number[]): number;
            transcodeImage(dst: Uint8Array, ...args: number[]): boolean;
            close(): void;
            delete(): void;
          };
        }>
      )({ wasmBinary: await readFile(paths.wasmPath) });
      basis.initializeBasis();
      const file = new basis.KTX2File(encoded);
      try {
        expect(Boolean(file.isETC1S())).toBe(!isUASTC);
        expect(Boolean(file.startTranscoding())).toBe(true);
        const format = basis.transcoder_texture_format.cTFASTC_4x4_RGBA.value;
        expect(format).toBe(10);
        const raw = readKTX2(await transcodeKtx2ToAstc(encoded));
        expect(raw.vkFormat).toBe(isUASTC ? 157 : 158);
        expect(raw.supercompressionScheme).toBe(0);
        expect(raw.globalData).toBeNull();
        expect(raw.levelCount).toBe(4);
        expect(raw.levels.map((level) => level.levelData.byteLength)).toEqual([64, 16, 16, 16]);
        for (let mip = 0; mip < file.getLevels(); mip += 1) {
          const expected = new Uint8Array(file.getImageTranscodedSizeInBytes(mip, 0, 0, format));
          expect(Boolean(file.transcodeImage(expected, mip, 0, 0, format, 0, -1, -1))).toBe(true);
          expect(expected.some((byte) => byte !== 0)).toBe(true);
          expect(raw.levels[mip]?.levelData).toEqual(expected);
          expect(raw.levels[mip]?.uncompressedByteLength).toBe(expected.byteLength);
        }
        expect(raw.dataFormatDescriptor[0]).toMatchObject({
          colorModel: 162,
          texelBlockDimension: [3, 3, 0, 0],
          bytesPlane: [16, 0, 0, 0, 0, 0, 0, 0],
        });
      } finally {
        file.close();
        file.delete();
      }
    },
  );
  it.each([false, true])(
    "scores final ASTC bytes, profiles and edge mips (UASTC=%s)",
    async (isUASTC) => {
      const data = new Uint8Array(5 * 3 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([240, 20, 40, 128], i);
      for (const srgb of [false, true]) {
        const basis = await encodeToKTX2(data, {
          imageDecoder: async () => ({ data, width: 5, height: 3 }),
          isUASTC,
          isSetKTX2SRGBTransferFunc: srgb,
        });
        expect((await measureKtx2(data, basis, 5, 3)).status).toBe("pass");
        const astc = await transcodeKtx2ToAstc(basis);
        const good = await measureKtx2(data, astc, 5, 3);
        expect(good.status).toBe("pass");
        expect(good.alpha.meanAbsoluteError).toBe(0);
        expect(readKTX2(astc).levels.map((level) => level.levelData.length)).toEqual([32, 16, 16]);
        const offColour = readKTX2(astc.slice());
        for (const level of offColour.levels) {
          for (let block = 0; block < level.levelData.length; block += 16)
            level.levelData.set(
              [252, 253, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 128, 128],
              block,
            );
        }
        expect((await measureKtx2(data, writeKTX2(offColour), 5, 3)).status).toBe("below-floor");
        for (const mip of [0, 1]) {
          const corrupt = readKTX2(astc.slice());
          const level = corrupt.levels[mip];
          if (level === undefined) throw new Error("fixture mip missing");
          level.levelData.fill(0, 0, 16);
          await expect(measureKtx2(data, writeKTX2(corrupt), 5, 3)).rejects.toThrow(
            /TN_ASSETS_QUALITY_DECODE/,
          );
        }
      }
    },
  );

  it("rejects malformed final ASTC containers before quality scoring", async () => {
    const data = new Uint8Array(5 * 3 * 4).fill(128);
    const basis = await encodeToKTX2(data, {
      imageDecoder: async () => ({ data, width: 5, height: 3 }),
    });
    const astc = await transcodeKtx2ToAstc(basis);
    await expect(decodeAstcKtx2(astc, 0, 3)).rejects.toThrow(/TN_ASSETS_QUALITY_DECODE/);
    await expect(decodeAstcKtx2(astc, 4, 3)).rejects.toThrow(/TN_ASSETS_QUALITY_DECODE/);
    // Mutate the serialized header: the writer expects a consistent valid container.
    for (const [offset, value] of [
      [12, 159],
      [16, 2],
      [28, 1],
      [32, 1],
      [36, 6],
      [40, 2],
      [44, 2],
    ]) {
      const corrupt = astc.slice();
      new DataView(corrupt.buffer).setUint32(offset ?? 0, value ?? 0, true);
      await expect(decodeAstcKtx2(corrupt, 5, 3)).rejects.toThrow(/TN_ASSETS_QUALITY_DECODE/);
    }
    for (const offset of [88, 96]) {
      const corrupt = astc.slice();
      new DataView(corrupt.buffer).setBigUint64(offset, 16n, true);
      await expect(decodeAstcKtx2(corrupt, 5, 3)).rejects.toThrow(/TN_ASSETS_QUALITY_DECODE/);
    }
    const corrupt = astc.slice();
    const view = new DataView(corrupt.buffer);
    view.setUint8(view.getUint32(48, true) + 14, 1);
    await expect(decodeAstcKtx2(corrupt, 5, 3)).rejects.toThrow(/TN_ASSETS_QUALITY_DECODE/);
  });

  it("measures legacy one-level Basis without requiring a full pyramid", async () => {
    const data = new Uint8Array(8 * 8 * 4).fill(128);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const encoded = await encodeToKTX2(data, {
      imageDecoder: async () => ({ data, width: 8, height: 8 }),
      isUASTC: true,
      generateMipmap: false,
      isSetKTX2SRGBTransferFunc: true,
    });
    expect(readKTX2(encoded).levelCount).toBe(1);
    expect((await measureKtx2(data, encoded, 8, 8)).status).toBe("pass");
    await expect(transcodeKtx2ToAstc(encoded, 1)).rejects.toThrow("TN_ASSETS_ASTC_INPUT");
  });

  it("rejects invalid or incomplete Basis input for the mobile cook", async () => {
    await expect(transcodeKtx2ToAstc(new Uint8Array([0]))).rejects.toThrow();
    const data = new Uint8Array(8 * 8 * 4).fill(128);
    const encoded = await encodeToKTX2(data, {
      imageDecoder: async () => ({ data, width: 8, height: 8 }),
      generateMipmap: false,
    });
    await expect(transcodeKtx2ToAstc(encoded)).rejects.toThrow(/TN_ASSETS_ASTC_INPUT/);
  });
  it("encodes both RDO lambdas through the current vendored encoder with Zstd", async () => {
    const fixture = "examples/prd493-terrain-splat/public/world/terrain/tex/layer-00_diff.jpg";
    const input = await readFile(new URL(`../../../${fixture}`, import.meta.url));
    const decoded = await decodeImageBytes(input, fixture);
    const options = {
      imageDecoder: async () => decoded,
      isUASTC: true,
      needSupercompression: true,
    };
    const plain = await encodeToKTX2(input, options);
    for (const rdoLambda of [3, 1]) {
      const encoded = await encodeToKTX2(input, { ...options, rdoLambda });
      expect(readKTX2(encoded).supercompressionScheme).toBe(2);
      expect(encoded).not.toEqual(plain);
      expect(
        Number.isFinite(
          (await measureKtx2(decoded.data, encoded, decoded.width, decoded.height)).ssim,
        ),
      ).toBe(true);
    }
    await expect(encodeToKTX2(input, { ...options, rdoLambda: Number.NaN })).rejects.toThrow(
      /TN_ASSETS_KTX2_RDO/u,
    );
    await expect(encodeToKTX2(input, { ...options, isUASTC: false, rdoLambda: 3 })).rejects.toThrow(
      /TN_ASSETS_KTX2_RDO/u,
    );
  });
  it("should reproduce the pinned normal-map score", async () => {
    const fixture = "examples/prd493-terrain-splat/public/world/terrain/tex/layer-00_nrm.jpg";
    const input = await readFile(new URL(`../../../${fixture}`, import.meta.url));
    const { data, width, height } = await decodeImageBytes(input, fixture);
    const encoded = await encodeToKTX2(input, {
      imageDecoder: async () => ({ data, width, height }),
      generateMipmap: true,
      isUASTC: true,
      isNormalMap: true,
      isPerceptual: false,
      isSetKTX2SRGBTransferFunc: false,
      qualityLevel: 150,
      needSupercompression: true,
    });
    expect(readKTX2(encoded).supercompressionScheme).toBe(2);

    const paths = basisTranscoderPaths();
    const shim: { exports: unknown } = { exports: {} };
    new Function(
      "module",
      "exports",
      "require",
      "__filename",
      "__dirname",
      await readFile(paths.javascriptPath, "utf8"),
    )(
      shim,
      shim.exports,
      createRequire(import.meta.url),
      paths.javascriptPath,
      path.dirname(paths.javascriptPath),
    );
    const factory = shim.exports as (options: { wasmBinary: Uint8Array }) => Promise<{
      initializeBasis(): void;
      transcoder_texture_format: { cTFRGBA32: { value: number } };
      KTX2File: new (
        bytes: Uint8Array,
      ) => {
        isValid(): boolean;
        startTranscoding(): boolean;
        getWidth(): number;
        getHeight(): number;
        getImageTranscodedSizeInBytes(...args: number[]): number;
        transcodeImage(dst: Uint8Array, ...args: number[]): boolean;
        close(): void;
        delete(): void;
      };
    }>;
    const basis = await factory({ wasmBinary: await readFile(paths.wasmPath) });
    basis.initializeBasis();
    const file = new basis.KTX2File(encoded);
    try {
      expect(file.isValid()).toBeTruthy();
      expect([file.getWidth(), file.getHeight()]).toEqual([width, height]);
      expect(file.startTranscoding()).toBeTruthy();
      const format = basis.transcoder_texture_format.cTFRGBA32.value;
      const decoded = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
      expect(file.transcodeImage(decoded, 0, 0, 0, format, 0, -1, -1)).toBeTruthy();
      const score = imageQuality(data, decoded, width, height, { slots: ["normalTexture"] });
      // spike inputs were never committed; PRD-351 D31
      const pinned = 0.9945243217001697;
      const toleranceGate = (value: number) =>
        expect(Math.abs(value - pinned)).toBeLessThanOrEqual(0.005);
      toleranceGate(score.ssim);

      // Change only the SSIM windows from 8x8 to 1x1, retaining equal-window aggregation.
      let control = 0;
      for (let i = 0; i < data.length; i += 4) {
        control += ssim(data.subarray(i, i + 4), decoded.subarray(i, i + 4), 1, 1);
      }
      control /= width * height;
      expect(() => toleranceGate(control)).toThrow();
    } finally {
      file.close();
      file.delete();
    }
  });

  it("scores identical pixels at 1 and rejects unrelated noise", () => {
    const data = pixels();
    expect(imageQuality(data, data, 32, 32).ssim).toBe(1);
    expect(imageQuality(data, data, 32, 32).meanDeltaE00).toBe(0);
    expect(imageQuality(data, data, 32, 32, { alphaThresholds: [0.5] })).toEqual(
      imageQuality(data, data.slice(), 32, 32, { alphaThresholds: [0.5] }),
    );
    expect(imageQuality(data, pixels(true), 32, 32).status).toBe("below-floor");
  });

  it("matches CIEDE2000 reference pairs, including hue wrap", () => {
    expect(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaE00([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4);
    expect(deltaE00([50, 2.49, -0.001], [50, -2.49, 0.001])).toBeCloseTo(7.1792, 4);
  });

  it("a badly compressed synthetic image fails while a flat one passes", async () => {
    for (const noise of [false, true]) {
      const data = pixels(noise);
      const encoded = await encodeToKTX2(data, {
        imageDecoder: async () => ({ data, width: 32, height: 32 }),
        isUASTC: false,
        qualityLevel: 1,
      });
      const score = await measureKtx2(data, encoded, 32, 32);
      expect(score.status).toBe(noise ? "below-floor" : "pass");
    }
  });

  it("detects alpha coverage changes independently of identical RGB", () => {
    const source = pixels();
    const output = source.slice();
    source[3] = 127;
    output[3] = 128;
    const score = imageQuality(source, output, 32, 32, { alphaThresholds: [0.5] });
    expect(score.ssim).toBe(1);
    expect(score.meanDeltaE00).toBe(0);
    expect(score.alpha.coverage[0]).toMatchObject({ changedPixels: 1 });
    expect(score.status).toBe("below-floor");
    source[7] = 128;
    output[7] = 127;
    const swapped = imageQuality(source, output, 32, 32, { alphaThresholds: [0.5] });
    expect(swapped.alpha.coverage[0]?.source).toBe(swapped.alpha.coverage[0]?.decoded);
    expect(swapped.alpha.coverage[0]?.changedPixels).toBe(2);
    expect(swapped.status).toBe("below-floor");
  });

  it("fails the colour floor even when luma SSIM passes", () => {
    const source = pixels();
    const output = source.slice();
    for (let i = 0; i < output.length; i += 4) {
      output[i] = 255;
      output[i + 1] = 101;
      output[i + 2] = 21;
    }
    const score = imageQuality(source, output, 32, 32);
    expect(score.ssim).toBeGreaterThan(0.95);
    expect(score.meanDeltaE00).toBeGreaterThan(3);
    expect(score.status).toBe("below-floor");
  });

  it("does not certify normal/data slots with colour metrics", () => {
    const data = pixels();
    expect(imageQuality(data, data, 32, 32, { slots: ["normalTexture"] })).toMatchObject({
      status: "unvalidated-slots",
      meanDeltaE00: null,
    });
    expect(
      imageQuality(data, data, 32, 32, { slots: ["baseColorTexture", "normalTexture"] }).status,
    ).toBe("unvalidated-slots");
  });

  it("fails closed on invalid dimensions, pixels and alpha thresholds", () => {
    expect(() => imageQuality(pixels(), new Uint8Array(4), 32, 32)).toThrow();
    expect(() => imageQuality(pixels(), pixels(), 0, 32)).toThrow();
    expect(() =>
      imageQuality(pixels(), pixels(), 32, 32, { alphaThresholds: [Number.NaN] }),
    ).toThrow();
  });
});
