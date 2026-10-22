import { describe, expect, it } from "vitest";
import { pixelsOfType, targetTexelBytes } from "../src/render-target.js";

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
