import { Data3DTexture, HalfFloatType, RGBAFormat } from "three";
// @ts-expect-error Three does not declare its internal texture descriptor builder.
import WebGPUTextureUtils from "three/src/renderers/webgpu/utils/WebGPUTextureUtils.js";
import { Storage3DTexture, StorageTexture } from "three/webgpu";
import { afterEach, expect, it, vi } from "vitest";

const usage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
afterEach(() => vi.unstubAllGlobals());

function descriptor(texture: Data3DTexture | Storage3DTexture | StorageTexture, options = {}) {
  vi.stubGlobal("GPUTextureUsage", usage);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  const descriptors: Array<{ usage: number }> = [];
  const utils = new WebGPUTextureUtils({
    get: () => ({}),
    device: {
      createTexture: (value: { usage: number }) => {
        descriptors.push(value);
        return {};
      },
      features: new Set(),
    },
    utils: {
      getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }),
      getCurrentColorFormat: () => "rgba16float",
    },
  });
  utils.createTexture(texture, options);
  return descriptors[0];
}

it("does not request render attachments for compute-only 3D storage textures", () => {
  expect(descriptor(new Storage3DTexture(4, 4, 4))?.usage).toBe(15);
});

it("preserves 2D storage render usage", () => {
  expect(descriptor(new StorageTexture(4, 4))?.usage).toBe(31);
});

it("does not request render attachments for a sampled 3D texture", () => {
  // The `.cube` grade table: a Data3DTexture no render pass ever writes. WebGPU forbids a 3D
  // texture as an attachment, so the usage makes wgpu-native reject the texture and every view,
  // bind group and pass that names it.
  expect(descriptor(new Data3DTexture(new Uint8Array(64), 4, 4, 4))?.usage).toBe(7);
});

it("preserves explicitly requested render-target and mipmap usage", () => {
  expect(descriptor(new Storage3DTexture(4, 4, 4), { renderTarget: {} })?.usage).toBe(31);
  expect(descriptor(new Storage3DTexture(4, 4, 4), { needsMipmaps: true })?.usage).toBe(31);
  const target = new Storage3DTexture(4, 4, 4);
  Object.assign(target, { isRenderTargetTexture: true });
  expect(descriptor(target)?.usage).toBe(31);
});
