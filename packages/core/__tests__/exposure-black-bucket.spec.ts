import { describe, expect, it } from "vitest";
import { blackBucketWeight } from "../src/look/exposure-graph.js";

// Unreal 5.8.3 gives the darkest histogram bucket no weight (r.EyeAdaptation.BlackHistogramBucketInfluence 0,
// Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessEyeAdaptation.cpp:110-115). A sample splits its
// weight between the two buckets around its position, and the share that lands in bucket 0 is dropped
// (Engine/Shaders/Private/PostProcessHistogram.usf:150-179). The histogram spans log2 luminance -10 to 20 in
// 64 buckets (Scene.cpp:498-509), so a black void does not open the eye.
describe("exposure meter black bucket", () => {
  const bucket = 30 / 63;

  it("drops a block at or below Unreal's floor and keeps one a bucket above it", () => {
    expect(blackBucketWeight(-13)).toBe(0);
    expect(blackBucketWeight(-10)).toBe(0);
    expect(blackBucketWeight(-10 + bucket / 4)).toBeCloseTo(0.25, 12);
    expect(blackBucketWeight(-10 + bucket)).toBe(1);
    expect(blackBucketWeight(Math.log2(0.18))).toBe(1);
  });
});
