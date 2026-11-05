import { DepthTexture, GreaterEqualCompare, LessEqualCompare } from "three";
import { Fn, context, float, texture, vec2 } from "three/tsl";
import { WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";

/** A depth map as a shadow level makes one: a comparison texture. */
function shadowMap(compare: DepthTexture["compareFunction"] = LessEqualCompare): DepthTexture {
  const map = new DepthTexture(8, 8);
  map.compareFunction = compare;
  return map;
}

/** The WGSL three writes for one compute pass that compare-samples every map. */
function compile(maps: readonly DepthTexture[]): string {
  const gpu = {
    contextNode: context(),
    backend: {
      capabilities: { getUniformBufferLimit: () => 65_536 },
      compatibilityMode: false,
      device: {},
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    hasCompatibility: () => true,
    hasFeature: () => false,
    debug: { diagnostics: { keywords: false } },
  };
  // Three's declarations omit the compute-node path and its generated shader fields.
  const builder = new WGSLNodeBuilder(null as never, gpu as never) as unknown as {
    build(): void;
    computeShader: string;
  };
  const kernel = Fn(() => {
    const lit = float(0).toVar();
    for (const map of maps) lit.addAssign(texture(map, vec2(0.5)).compare(0.5));
  });
  Reflect.set(builder, "compute", kernel().compute(1));
  builder.build();
  return builder.computeShader;
}

const count = (wgsl: string, pattern: RegExp) => wgsl.match(pattern)?.length ?? 0;

describe("comparison samplers in the three.js WebGPU backend", () => {
  it("binds one sampler for ten shadow maps that compare the same way", () => {
    // Five clip levels, each with a static and a mover map: ten maps. One sampler each was 10 of
    // the 16 a fragment stage may bind, so the Strata ground (14 of its own) failed to draw.
    const wgsl = compile(Array.from({ length: 10 }, () => shadowMap()));
    expect(count(wgsl, /:\s*sampler_comparison;/g)).toBe(1);
    expect(count(wgsl, /:\s*texture_depth_2d;/g)).toBe(10);
  });

  it("keeps a separate sampler for a map that compares another way", () => {
    const wgsl = compile([shadowMap(), shadowMap(), shadowMap(GreaterEqualCompare)]);
    expect(count(wgsl, /:\s*sampler_comparison;/g)).toBe(2);
  });
});
