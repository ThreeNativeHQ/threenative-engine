import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterTextureLimits } from "../src/renderer.js";

function withAdapter(limits: Record<string, number> | null): void {
  vi.stubGlobal("navigator", {
    gpu: { requestAdapter: async () => (limits === null ? null : { limits }) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("adapterTextureLimits", () => {
  it("requests the adapter's texture limits when they exceed the portable 16", async () => {
    withAdapter({
      maxSampledTexturesPerShaderStage: 48,
      maxSamplersPerShaderStage: 16,
      maxBindGroups: 4,
    });
    expect(await adapterTextureLimits()).toEqual({
      requiredLimits: { maxSampledTexturesPerShaderStage: 48 },
    });
  });

  it("requests texture array layers past the portable 256, which morph-heavy rigs need", async () => {
    // A MetaHuman head stores 821 morph targets as layers of one texture array.
    withAdapter({ maxTextureArrayLayers: 2048, maxSampledTexturesPerShaderStage: 16 });
    expect(await adapterTextureLimits()).toEqual({
      requiredLimits: { maxTextureArrayLayers: 2048 },
    });
    withAdapter({ maxTextureArrayLayers: 256 });
    expect(await adapterTextureLimits()).toEqual({});
  });

  it("raises color attachment bytes past the portable 32, which a 7-target RGBA16Float MRT needs", async () => {
    // 7 RGBA16Float attachments = 56 bytes per sample; the device default of 32 rejects the pipeline.
    withAdapter({ maxColorAttachmentBytesPerSample: 128 });
    expect(await adapterTextureLimits()).toEqual({
      requiredLimits: { maxColorAttachmentBytesPerSample: 128 },
    });
  });

  it("asks for nothing for color attachment bytes at the portable 32 or when the adapter omits it", async () => {
    withAdapter({ maxColorAttachmentBytesPerSample: 32 });
    expect(await adapterTextureLimits()).toEqual({});
    withAdapter({ maxSampledTexturesPerShaderStage: 16 });
    expect(await adapterTextureLimits()).toEqual({});
  });

  it("asks for nothing on a 16-limit adapter, with no adapter, or without WebGPU", async () => {
    withAdapter({ maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 });
    expect(await adapterTextureLimits()).toEqual({});
    withAdapter(null);
    expect(await adapterTextureLimits()).toEqual({});
    vi.stubGlobal("navigator", {});
    expect(await adapterTextureLimits()).toEqual({});
  });
});
