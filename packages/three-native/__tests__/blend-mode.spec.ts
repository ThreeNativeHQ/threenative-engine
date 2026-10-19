import { describe, expect, it } from "vitest";
import { BlendMode } from "../src/blend-mode.js";

describe("BlendMode", () => {
  it("carries three's defaults and copies by value", () => {
    const mode = new BlendMode(5);
    expect(mode).toMatchObject({
      blending: 5,
      blendSrc: 204,
      blendDst: 205,
      blendEquation: 100,
      blendSrcAlpha: null,
      premultiplyAlpha: false,
    });
    const copy = mode.clone();
    expect(copy).not.toBe(mode);
    expect(copy).toEqual(mode);
  });
});
