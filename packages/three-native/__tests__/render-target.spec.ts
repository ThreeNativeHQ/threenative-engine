import { describe, expect, it } from "vitest";
import {
  defineRenderTargets,
  padReadbackRows,
  pixelsOfType,
  targetTexelBytes,
} from "../src/render-target.js";

describe("pixelsOfType", () => {
  it("returns a FloatType target's float32 rows as stored, not rounded to half", () => {
    const value = 1 + 2 ** -12;
    const rows = new Uint8Array(new Float32Array([value, 0, 0, 1]).buffer);
    const typed = pixelsOfType(rows, 1015);
    expect(typed).toBeInstanceOf(Float32Array);
    expect(Array.from(typed)).toEqual([value, 0, 0, 1]);
  });

  it("types half rows as half bits or clamped bytes", () => {
    const rows = new Uint8Array(new Uint16Array([0x3800, 0x3c00, 0x0000, 0x3c00]).buffer);
    expect(Array.from(pixelsOfType(rows, 1016))).toEqual([0x3800, 0x3c00, 0, 0x3c00]);
    expect(Array.from(pixelsOfType(rows, 1009))).toEqual([128, 255, 0, 255]);
  });

  it("sizes a pixel by the target format", () => {
    expect(targetTexelBytes(1015)).toBe(16);
    expect(targetTexelBytes(1016)).toBe(8);
    expect(targetTexelBytes(1009)).toBe(8);
  });
});

describe("three's readRenderTargetPixelsAsync over a pass's attachments", () => {
  const texture = (name: string) => ({ name, type: 1016 });

  function renderer(calls: unknown[][]) {
    const prototype = { render(): void {} };
    defineRenderTargets(prototype, (self) => ({
      draw: () => {},
      read: async (...args: unknown[]) => {
        calls.push([self, ...args]);
        // The engine crops tightly: the region's own texels, 8 bytes each for RGBA16Float.
        return new Uint8Array(Number(args[3]) * Number(args[4]) * 8);
      },
    }));
    return Object.create(prototype) as {
      readRenderTargetPixelsAsync(...args: unknown[]): Promise<Uint16Array>;
    };
  }

  it("passes the attachment index to the engine, as three's textureIndex does", async () => {
    const calls: unknown[][] = [];
    const target = {
      texture: texture("output"),
      textures: [texture("output"), texture("diagnostic")],
    };
    const rows = await renderer(calls).readRenderTargetPixelsAsync(target, 1, 2, 3, 4, 1);
    expect(calls[0]?.slice(1)).toEqual([target, 1, 2, 3, 4, 1]);
    expect(calls[0]?.[0]).toBeDefined();
    // three's copy layout: rows padded to 256 bytes, the last trimmed to its data (3x4 RGBA16F).
    expect(rows.length).toBe((256 * (4 - 1) + 3 * 8) / 2);
  });

  it("reads the first attachment when no index is given, and refuses a cube face", async () => {
    const calls: unknown[][] = [];
    const target = { texture: texture("output") };
    const read = renderer(calls);
    await read.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    expect(calls[0]?.slice(1)).toEqual([target, 0, 0, 1, 1, 0]);
    await expect(read.readRenderTargetPixelsAsync(target, 0, 0, 1, 1, 0, 2)).rejects.toThrow(
      /TN_NATIVE_RENDER_TARGET_UNSUPPORTED/u,
    );
  });
});

describe("three's padded readback rows", () => {
  // three's WebGPU readback copies with bytesPerRow aligned to 256 and reads the last row to its data,
  // so a region's array carries that padding. A caller that indexes rows by the aligned stride (the
  // Strata water proof's diagnostic classifier) reads garbage from a tight copy and refuses it.
  const texel = 8; // RGBA16Float
  const rowBytes = (width: number) => Math.ceil((width * texel) / 256) * 256;

  it("pads every row but the last, as copyTextureToBuffer lays it out", () => {
    const width = 280;
    const height = 3;
    const tight = new Uint8Array(width * height * texel);
    for (let row = 0; row < height; row++)
      tight.fill(row + 1, row * width * texel, (row + 1) * width * texel);
    const padded = padReadbackRows(tight, width, height, texel);
    expect(padded.length).toBe(rowBytes(width) * (height - 1) + width * texel);
    for (let row = 0; row < height; row++) {
      const start = row * rowBytes(width);
      expect(padded[start]).toBe(row + 1);
      expect(padded[start + width * texel - 1]).toBe(row + 1);
    }
  });

  it("leaves an already aligned region, or a one-pixel read, unchanged", () => {
    const aligned = new Uint8Array(64 * 2 * texel);
    expect(padReadbackRows(aligned, 64, 2, texel)).toEqual(aligned);
    const single = new Uint8Array(texel);
    expect(padReadbackRows(single, 1, 1, texel)).toEqual(single);
    // An empty region is refused, as the engine refuses a zero extent.
    expect(() => padReadbackRows(new Uint8Array(0), 4, 0, texel)).toThrow(/TN_NATIVE_READBACK/u);
    // A region whose size disagrees with its rows is refused, not padded into nonsense.
    expect(() => padReadbackRows(new Uint8Array(3), 4, 2, texel)).toThrow(/TN_NATIVE_READBACK/u);
  });
});
