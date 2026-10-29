import { Texture } from "three";
import { texture } from "three/tsl";
import { afterEach, expect, it, vi } from "vitest";
import { workerSafeSmaa } from "../src/look/world-environment.js";

// A worker (and this node environment) has no HTMLImageElement. three's SMAANode builds its area and
// search lookup textures with `new Image()`, so `engine: "threejs"` in a worker dropped the AA stage
// ("build:Image is not defined") and drew the frame without it.
afterEach(() => vi.unstubAllGlobals());

it("builds SMAA where Image does not exist and fills both lookup textures from the decoded data", async () => {
  expect(typeof (globalThis as { Image?: unknown }).Image).toBe("undefined");
  const bitmaps: object[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    return { blob: async () => new Blob([url]) };
  });
  vi.stubGlobal("createImageBitmap", async (_blob: Blob, options: ImageBitmapOptions) => {
    expect(options).toEqual({ premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const bitmap = { width: 1, height: 1 };
    bitmaps.push(bitmap);
    return bitmap;
  });
  const node = workerSafeSmaa(texture(new Texture())) as unknown as {
    _areaTexture: Texture;
    _searchTexture: Texture;
  };
  expect(typeof (globalThis as { Image?: unknown }).Image).toBe("undefined");
  await vi.waitFor(() => expect(bitmaps).toHaveLength(2));
  await vi.waitFor(() => expect(node._searchTexture.version).toBeGreaterThan(0));
  expect(node._areaTexture.image).toBe(bitmaps[0]);
  expect(node._searchTexture.image).toBe(bitmaps[1]);
  expect(node._areaTexture.version).toBeGreaterThan(0);
});
