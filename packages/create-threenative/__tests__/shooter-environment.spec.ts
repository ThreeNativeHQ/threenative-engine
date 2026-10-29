import { CanvasTexture, Scene, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSky } from "../templates/shooter/src/render/sky.js";

class CanvasWithDraw {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return { drawImage: () => undefined };
  }
}

// The native host's OffscreenCanvas polyfill: a context object with no drawImage.
class NativePolyfillCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return { canvas: this };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("shooter environment source", () => {
  it("bakes a 1024x512 copy and keeps the full sky as the background", () => {
    vi.stubGlobal("OffscreenCanvas", CanvasWithDraw);
    const scene = new Scene();
    const sky = new Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    setupSky(scene, sky);
    expect(scene.background).toBe(sky);
    expect(scene.environment).toBeInstanceOf(CanvasTexture);
    const source = (scene.environment as CanvasTexture).image as { width: number; height: number };
    expect([source.width, source.height]).toEqual([1024, 512]);
  });

  it("keeps the full sky on a host whose canvas cannot draw an image (the native polyfill)", () => {
    vi.stubGlobal("OffscreenCanvas", NativePolyfillCanvas);
    const scene = new Scene();
    const sky = new Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    expect(() => setupSky(scene, sky)).not.toThrow();
    expect(scene.environment).toBe(sky);
  });

  it("keeps the full sky on a host with no OffscreenCanvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const scene = new Scene();
    const sky = new Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    setupSky(scene, sky);
    expect(scene.environment).toBe(sky);
  });
});
