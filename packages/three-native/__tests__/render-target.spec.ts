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
      clear: () => {},
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
    // three 0.187.0 copyTextureToBuffer removes the row padding: the 3x4 RGBA16F region is tight.
    expect(rows.length).toBe(3 * 4 * 4);
  });

  it("returns tightly packed rows, so row 1 of a 4x2 byte target starts at texel 4", async () => {
    const prototype = { render(): void {} };
    defineRenderTargets(prototype, () => ({
      clear: () => {},
      draw: () => {},
      read: async () => {
        // RGBA16Float halves for a 4x2 region: row 0 is 0.0, row 1 is 1.0 (0x3c00).
        const halves = new Uint16Array(4 * 2 * 4);
        halves.fill(0x3c00, 16);
        return new Uint8Array(halves.buffer);
      },
    }));
    const read = Object.create(prototype) as {
      readRenderTargetPixelsAsync(...args: unknown[]): Promise<Uint8Array>;
    };
    const pixels = await read.readRenderTargetPixelsAsync({ texture: { type: 1009 } }, 0, 0, 4, 2);
    expect(pixels.length).toBe(4 * 2 * 4);
    expect([pixels[15], pixels[16], pixels[19]]).toEqual([0, 255, 255]);
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

describe("three's array render target and the impostor bake's seam (PRD-858)", () => {
  function renderer(draws: unknown[][]) {
    const prototype = { render(): void {} };
    defineRenderTargets(prototype, () => ({
      clear: () => {},
      draw: (...args: unknown[]) => void draws.push(args),
      read: async () => new Uint8Array(0),
    }));
    return Object.create(prototype) as {
      setRenderTarget(target: unknown, face?: number, mip?: number): void;
      getActiveCubeFace(): number;
      render(scene: unknown, camera: unknown): void;
      getMRT(): unknown;
      setMRT(mrt: unknown): unknown;
      initRenderTarget(target: unknown): void;
    };
  }

  it("draws the layer setRenderTarget names, and keeps it as the active face", () => {
    const draws: unknown[][] = [];
    const r = renderer(draws);
    const target = {};
    r.setRenderTarget(target, 3, 0);
    expect(r.getActiveCubeFace()).toBe(3);
    r.render("scene", "camera");
    expect(draws).toEqual([[target, "scene", "camera", 3]]);
    expect(() => r.setRenderTarget(target, 1.5)).toThrow(/TN_NATIVE_RENDER_TARGET_UNSUPPORTED/);
    expect(() => r.setRenderTarget(target, 0, 1)).toThrow(/mip level/);
  });

  it("has getMRT, setMRT(null) and initRenderTarget, and refuses a renderer-wide MRT by name", () => {
    const r = renderer([]);
    expect(r.getMRT()).toBeNull();
    expect(r.setMRT(null)).toBe(r);
    expect(() => r.initRenderTarget({})).not.toThrow();
    expect(() => r.setMRT({ isMRTNode: true })).toThrow(/TN_NATIVE_MRT_UNSUPPORTED/);
  });
});
