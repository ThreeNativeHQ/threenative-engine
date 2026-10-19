import { RippleField, Scene, SpectralOcean, WaterSurface3D } from "@threenative/core";
import { describe, expect, it, vi } from "vitest";
import { createClearwater } from "../template-assets/clearwater/src/clearwater.js";
import { ClearwaterDemo } from "../template-assets/clearwater/src/clearwaterDemo.js";
import { createClearwaterAppearance } from "../template-assets/clearwater/src/render/clearwater.js";
import { resolveClearwaterOptions } from "../template-assets/clearwater/src/render/clearwaterOptions.js";

// Real Three.js/engine nodes, not a fake shader API. This catches graph construction errors;
// it does not pretend to compile WGSL or prove pixels without a WebGPU adapter.
describe("Clearwater graph construction", () => {
  it("loads the public factory and optional scene without allocating a renderer", () => {
    expect(createClearwater).toBeTypeOf("function");
    expect(new ClearwaterDemo()).toBeInstanceOf(Scene);
  });
  it("composes real fields, three dispersion passes and idempotent owned-resource disposal", () => {
    const options = resolveClearwaterOptions({ center: [4, -3], level: 2 });
    const ocean = new SpectralOcean({
      resolution: 32,
      cascades: [{ patchSize: 8 }, { patchSize: 2 }],
      windSpeed: 1.8,
      windDirection: 0.55,
      gravity: 9.81,
      amplitude: 0.00012,
      directionality: 1.5,
      choppiness: 0,
      smallWaveCutoff: 0.08,
      seed: 1,
      readbackResolution: 0,
      readbackEveryFrames: 1,
    });
    const ripples = new RippleField({ resolution: 32, size: 7, speed: 1.2 });
    const surface = new WaterSurface3D({
      level: 2,
      maxThickness: 24,
      reflection: { resolutionScale: 0.5 },
    });
    try {
      const water = createClearwaterAppearance(ocean, ripples, surface, options);
      try {
        expect(water.material.positionNode).toBeDefined();
        expect(water.material.colorNode).toBeDefined();
        expect(water.material.transparent).toBe(true);
        expect(water.material.depthWrite).toBe(false);
        expect(water.caustics?.scene.children).toHaveLength(3);
        expect(water.caustics?.texture.image).toMatchObject({ width: 512 });
        expect(water.level.value).toBe(2);
        let geometryReleases = 0;
        let materialReleases = 0;
        water.mesh.geometry.addEventListener("dispose", () => {
          geometryReleases++;
        });
        water.material.addEventListener("dispose", () => {
          materialReleases++;
        });
        ripples.impulse(0, 0, 0.3, -0.04);
        ripples.advance(1 / 60);
        water.uploadRipples();
        water.dispose();
        water.dispose();
        expect(geometryReleases).toBe(1);
        expect(materialReleases).toBe(1);
      } finally {
        water.dispose();
      }
    } finally {
      surface.dispose();
      ocean.detach();
    }
  });
});

// Keep real fields/material graphs; only the renderer context and asynchronous FFT readback are
// substituted. This is a CPU sampling contract, not a claim that a renderer or GPU was exercised.
function sampledWater() {
  const ctx = {
    renderer: { kind: "webgpu", raw: { isWebGPURenderer: true } },
    every: () => ({ cancel: () => {} }),
    beforeRender: () => () => {},
    add: () => {},
  } as unknown as Parameters<typeof createClearwater>[0];
  const water = createClearwater(ctx, {
    size: 128,
    level: 2,
    resolution: 32,
    rippleResolution: 16,
    rippleSize: 8,
    reflection: false,
    caustics: false,
  });
  vi.spyOn(water.ocean, "sampleHeight").mockReturnValue({
    height: 0.25,
    staleFrames: 2,
    verticalVelocity: 0,
  });
  water.ripples.height.fill(0.125);
  return water;
}

it.each([
  { name: "interior", x: 0, z: 0, height: 2.375 },
  { name: "west edge", x: -3.5, z: 0, height: 2.3125 },
  { name: "east edge", x: 3.5, z: 0, height: 2.3125 },
  { name: "north edge", x: 0, z: 3.5, height: 2.3125 },
  { name: "south edge", x: 0, z: -3.5, height: 2.3125 },
  { name: "outside patch", x: 5, z: 0, height: 2.25 },
])("matches the rendered ripple fade at $name", ({ x, z, height }) => {
  const water = sampledWater();
  try {
    // Halfway through the shader's two-texel band, smoothstep is 0.5, not full amplitude.
    expect(water.sampleHeight(x, z)?.height).toBeCloseTo(height, 12);
    expect(water.sampleHeight(x, z)?.staleFrames).toBe(2);
  } finally {
    water.dispose();
  }
});

it("keeps the sampled edge fade aligned after following a character", () => {
  const water = sampledWater();
  try {
    water.follow(16, -16);
    water.ripples.height.fill(0.125);
    const { centerX, centerZ } = water.ripples;
    expect(water.sampleHeight(centerX + 3.5, centerZ)?.height).toBeCloseTo(2.3125, 12);
    expect(water.sampleHeight(centerX, centerZ)?.height).toBeCloseTo(2.375, 12);
    expect(water.sampleHeight(0, 0)?.height).toBeCloseTo(2.25, 12);
  } finally {
    water.dispose();
  }
});
