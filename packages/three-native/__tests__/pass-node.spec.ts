import { describe, expect, it } from "vitest";

import { definePass, markNormalTarget } from "../src/pass-node.js";

const normalView = Object.freeze({ name: "normalView" });
const tsl = {
  texture: (target: { name: string }) => ({ target: target.name }),
  uv: () => ({}),
  normalView,
};
const { mrt, output, metalness, roughness } = definePass(tsl);
const vec4 = markNormalTarget((...parts: unknown[]) => ({ parts }), normalView);

describe("native scene pass MRT", () => {
  it("accepts the normal target as normalView or as vec4(normalView, 0)", () => {
    expect(mrt({ output, normal: normalView }).outputs.normal).toBe(normalView);
    // The spelling the templates use: the zero alpha rides with a BlendMode on the same output.
    expect(mrt({ output, normal: vec4(normalView, 0), metalness, roughness }).outputs.normal).toBe(
      normalView,
    );
  });

  it("refuses every other normal spelling by name", () => {
    expect(() => mrt({ normal: vec4(normalView, 1) })).toThrow(
      /TN_NATIVE_MRT_UNSUPPORTED: normal/u,
    );
    expect(() => mrt({ normal: vec4({}, 0) })).toThrow(/TN_NATIVE_MRT_UNSUPPORTED: normal/u);
    expect(() => mrt({ velocity: {} })).toThrow(/TN_NATIVE_MRT_UNSUPPORTED: velocity/u);
  });

  it("records a blend mode per output without touching the others", () => {
    const node = mrt({ output, normal: vec4(normalView, 0) });
    const mode = { blending: 6 };
    expect(node.setBlendMode("normal", mode)).toBe(node);
    expect(node.getBlendMode("normal")).toBe(mode);
    expect(node.getBlendMode("output")).toBeUndefined();
  });
});
