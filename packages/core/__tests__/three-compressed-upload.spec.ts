import {
  CompressedTexture,
  ExternalTexture,
  RGBA_ASTC_5x4_Format,
  RGBA_BPTC_Format,
  type Texture,
} from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createRenderer } from "../src/renderer.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { format: RGBA_BPTC_Format, width: 1024, blockWidth: 4, gpuFormat: "bc7-rgba-unorm" },
  { format: RGBA_ASTC_5x4_Format, width: 1000, blockWidth: 5, gpuFormat: "astc-5x4-unorm" },
])(
  "prepareTextures uploads $gpuFormat through bounded writes without the private Three lane",
  async ({ format, width, blockWidth, gpuFormat }) => {
    const height = 1024;
    const bytesPerRow = (width / blockWidth) * 16;
    const data = Uint8Array.from({ length: bytesPerRow * (height / 4) }, (_, i) => i % 251);
    const restored = new Uint8Array(data.length);
    const destroy = vi.fn();
    const backing = { destroy };
    const createTexture = vi.fn(() => backing);
    const writeTexture = vi.fn((destination, bytes, layout, extent) => {
      expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
      expect(destination.texture).toBe(backing);
      expect(destination.mipLevel).toBe(0);
      expect(destination.origin.z).toBe(0);
      const rowBytes = (extent.width / blockWidth) * 16;
      for (let row = 0; row < extent.height / 4; row++) {
        const offset = layout.offset + row * layout.bytesPerRow;
        restored.set(
          bytes.subarray(offset, offset + rowBytes),
          (destination.origin.y / 4 + row) * bytesPerRow + (destination.origin.x / blockWidth) * 16,
        );
      }
    });
    const canvas = Object.assign(new EventTarget(), { clientWidth: 320, clientHeight: 180 });
    vi.stubGlobal("navigator", { gpu: {} });
    const renderer = await createRenderer({
      canvas: canvas as HTMLCanvasElement,
      webgpuFactory: () => ({
        domElement: canvas as HTMLCanvasElement,
        render() {},
        setSize() {},
        backend: {
          device: {
            createTexture,
            queue: { writeTexture },
            features: new Set(["texture-compression-bc", "texture-compression-astc"]),
          },
        },
      }),
    });
    const texture = new CompressedTexture([{ data, width, height }], width, height, format);
    texture.needsUpdate = true;
    const replacements = new Map<Texture, Texture>();
    try {
      expect(await renderer.prepareTextures?.([texture], undefined, undefined, replacements)).toBe(
        1,
      );
      expect(createTexture).toHaveBeenCalledExactlyOnceWith({
        size: { width, height, depthOrArrayLayers: 1 },
        format: gpuFormat,
        mipLevelCount: 1,
        dimension: "2d",
        usage: 6,
      });
      const prepared = replacements.get(texture) as ExternalTexture;
      expect(prepared).toBeInstanceOf(ExternalTexture);
      expect(prepared.sourceTexture).toBe(backing);
      expect(writeTexture.mock.calls.length).toBeGreaterThan(1);
      expect(restored).toEqual(data);
    } finally {
      renderer.dispose();
    }
    expect(destroy).toHaveBeenCalledTimes(1);
  },
);
