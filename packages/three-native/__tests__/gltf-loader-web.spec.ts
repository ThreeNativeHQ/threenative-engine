/**
 * PRD-540: the web GLTFLoader under engine "native" hands the bytes to the engine glTF loader and
 * answers in GLTFLoader's shape; a codec or plugin the engine loader lacks is refused by name.
 */
import { describe, expect, it, vi } from "vitest";

const loaded: Uint8Array[] = [];
const calls: { images: readonly unknown[]; clips: number }[] = [];
vi.mock("three", () => ({
  __tnLoadGltf(bytes: Uint8Array, images: readonly unknown[], clips: number) {
    loaded.push(bytes);
    calls.push({ images, clips });
    return { scene: { name: "scene" }, animations: [{ name: "fly" }] };
  },
}));

const { GLTFLoader } = await import("../src/addons/gltf-loader-web.js");

describe("web GLTFLoader over the engine", () => {
  it("parses through the engine loader into GLTFLoader's result", async () => {
    const bytes = new Uint8Array([103, 108, 84, 70]).buffer;
    const gltf = await new GLTFLoader().parseAsync(bytes, "aircraft.glb");
    expect(loaded.at(-1)).toEqual(new Uint8Array([103, 108, 84, 70]));
    expect(gltf.scene).toEqual({ name: "scene" });
    expect(gltf.scenes).toEqual([{ name: "scene" }]);
    expect(gltf.animations).toEqual([{ name: "fly" }]);
  });

  it("decodes the images its textures draw in the page, by glTF image index, before the engine loads", async () => {
    // A GLB: image 0 (PNG) and image 2 (WebP, texture 1's EXT_texture_webp source); image 1 is the
    // WebP texture's fallback and image 3 no texture draws, so neither is decoded.
    const json = {
      images: [
        { bufferView: 0, mimeType: "image/png" },
        { bufferView: 1, mimeType: "image/png" },
        { bufferView: 2, mimeType: "image/webp" },
        { bufferView: 0, mimeType: "image/png" },
      ],
      bufferViews: [
        { byteOffset: 0, byteLength: 2 },
        { byteOffset: 2, byteLength: 2 },
        { byteOffset: 4, byteLength: 4 },
      ],
      textures: [{ source: 0 }, { source: 1, extensions: { EXT_texture_webp: { source: 2 } } }],
      animations: [{}, {}],
    };
    const text = new TextEncoder().encode(
      JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4),
    );
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const glb = new Uint8Array(12 + 8 + text.length + 8 + bin.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, text.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(text, 20);
    view.setUint32(20 + text.length, bin.length, true);
    view.setUint32(24 + text.length, 0x004e4942, true);
    glb.set(bin, 28 + text.length);
    const decoded: { bytes: number[]; type: string; options: unknown }[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob, options: unknown) => {
      decoded.push({
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
        type: blob.type,
        options,
      });
      return { width: decoded.length, height: 1 };
    });
    // The Blob copies the image bytes itself; copying them out of the GLB first doubles the work.
    const slice = vi.spyOn(Uint8Array.prototype, "slice");
    await new GLTFLoader().parseAsync(glb.buffer, "ship.glb");
    expect(slice).not.toHaveBeenCalled();
    slice.mockRestore();
    vi.unstubAllGlobals();
    const call = calls.at(-1);
    expect(call?.clips).toBe(2);
    expect(call?.images.length).toBe(4);
    expect(call?.images[1]).toBeUndefined();
    expect(call?.images[3]).toBeUndefined();
    expect(call?.images[0]).toBeDefined();
    expect(call?.images[2]).toBeDefined();
    expect(decoded.map(({ bytes, type }) => [bytes, type]).sort()).toEqual([
      [[1, 2], "image/png"],
      [[5, 6, 7, 8], "image/webp"],
    ]);
    for (const { options } of decoded)
      expect(options).toEqual({ premultiplyAlpha: "none", colorSpaceConversion: "none" });
  });

  it("refuses the decoders and plugins the engine loader does not take", () => {
    const loader = new GLTFLoader();
    expect(() => loader.setKTX2Loader()).toThrow("TN_NATIVE_GLTF_KTX2_UNSUPPORTED");
    expect(() => loader.setMeshoptDecoder()).toThrow("TN_NATIVE_GLTF_MESHOPT_UNSUPPORTED");
    expect(() => loader.register()).toThrow("TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED");
  });
});
