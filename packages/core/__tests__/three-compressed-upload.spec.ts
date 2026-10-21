import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
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

// renderer-texture-preparation.spec.ts proves prepareTextures with real transcoded mip data.
// This guard pins that proof to an installed Three.js and generated patches without the old lane.
it("keeps the private compressed upload lane out of generated patches and installed Three.js", () => {
  const patchRoot = new URL("../patches/", import.meta.url);
  const base = readFileSync(new URL("three@0.185.1.patch", patchRoot), "utf8");
  const upgrade = readFileSync(new URL("three@0.185.1-prd269-upgrade.patch", patchRoot), "utf8");
  const targetTexts = brotliDecompressSync(
    Buffer.from(JSON.parse(upgrade).bundleBrotliBase64, "base64"),
  ).toString("utf8");
  const root = resolve(dirname(createRequire(import.meta.url).resolve("three")), "..");
  const installed = [
    "src/renderers/common/Renderer.js",
    "src/renderers/common/Textures.js",
    "src/renderers/webgpu/WebGPUBackend.js",
    "src/renderers/webgpu/utils/WebGPUTextureUtils.js",
    "build/three.webgpu.js",
    "build/three.webgpu.nodes.js",
  ].map((file) => readFileSync(resolve(root, file), "utf8"));
  // PMREMNode.prepareTextureAsync is the unrelated PMREM preparation seam, not the removed upload lane.
  const pmremSeam =
    /PMREMNode\.prepareTextureAsync|static async prepareTextureAsync\( renderer, texture \)/g;
  for (const text of [base, upgrade, targetTexts, ...installed])
    expect(
      text
        .replace(pmremSeam, "")
        .match(
          /prepareTextureAsync|updateTextureAsync|_uploadTail|_pendingUploads|uploadError|_waitForUpload|_uploadSlice|_uploadDisposed/,
        )?.[0],
    ).toBeUndefined();
});
