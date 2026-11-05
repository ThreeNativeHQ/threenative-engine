import { describe, expect, it } from "vitest";
import { defineRenderTargets, pixelsOfType, targetTexelBytes } from "../src/render-target.js";

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
        return new Uint8Array(8);
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
    expect(Array.from(rows)).toEqual([0, 0, 0, 0]);
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
