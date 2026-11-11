/**
 * The browser back end's texture sources, DataUtils and HDRLoader over a recording runtime: what
 * reaches the engine when a game builds a DataTexture from a typed array and edits it in place
 * (Midway's ripples), draws a canvas, adopts an image, or loads an `.hdr`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DataUtils as SharedDataUtils } from "../src/addons/data-utils.js";
import {
  type EngineValue,
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { withTextureSources } from "../src/browser-entry.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

function recording() {
  const types = new Map<string, number>();
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const constructed: [string, EngineValue[]][] = [];
  const writes: [string, string, EngineValue][] = [];
  const invocations: [string, string][] = [];
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId,
    construct: (name, args) => {
      constructed.push([name, [...args]]);
      return { key: `${name}#${String(next++)}`, type: typeId(name) };
    },
    invoke: (self, method) => {
      invocations.push([self.key, method]);
      if (method !== "clone") throw new Error("not under test");
      const name = self.key.split("#")[0] as string;
      return { key: `${name}#${String(next++)}`, type: typeId(name) };
    },
    get: () => undefined,
    set: (self, property, value) => {
      writes.push([self.key, property, value]);
    },
    release: () => undefined,
    setCallback: () => undefined,
  };
  const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
  return { bound: withTextureSources(classes, runtime), constructed, writes, invocations };
}

type Ctor = new (...args: unknown[]) => Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe("browser texture sources", () => {
  it("clones through the engine while retaining the shared JS image for later uploads", () => {
    const { bound, writes, invocations } = recording();
    const DataTexture = bound.DataTexture as Ctor;
    const pixels = new Uint8Array([1, 2, 3, 255]);
    const texture = new DataTexture(pixels, 1, 1);
    const clone = (texture.clone as () => Record<string, unknown>)();
    expect(clone).not.toBe(texture);
    expect(clone).toBeInstanceOf(DataTexture);
    expect(clone.image).toBe(texture.image);
    pixels[0] = 9;
    clone.needsUpdate = true;
    expect(invocations.at(-1)?.[1]).toBe("clone");
    expect(writes.slice(-2).map(([, field, value]) => [field, value])).toEqual([
      ["image.data", [9, 2, 3, 255]],
      ["needsUpdate", true],
    ]);
  });

  it("re-sends a DataTexture's edited typed array on needsUpdate (Midway's ripples)", () => {
    const { bound, constructed, writes } = recording();
    const DataTexture = bound.DataTexture as Ctor;
    const data = new Uint16Array(2 * 1 * 4);
    const map = new DataTexture(data, 2, 1, 1023, 1016);
    expect(constructed.at(-1)).toEqual([
      "DataTexture",
      [[0, 0, 0, 0, 0, 0, 0, 0], 2, 1, 1023, 1016],
    ]);
    expect(map instanceof (bound.Texture as Ctor)).toBe(true);
    expect((map.image as { data: unknown }).data).toBe(data);
    data[0] = (bound.DataUtils as typeof SharedDataUtils).toHalfFloat(1);
    map.needsUpdate = true;
    const key = writes.at(-1)?.[0];
    expect(writes.slice(-2)).toEqual([
      [key, "image.data", [0x3c00, 0, 0, 0, 0, 0, 0, 0]],
      [key, "needsUpdate", true],
    ]);
  });

  it("keeps a volume's source array while the starter converts it to half floats", () => {
    const { bound, constructed, writes } = recording();
    const pixels = new Float32Array(2 * 2 * 2 * 4).fill(0.5);
    const texture = new (bound.Data3DTexture as Ctor)(pixels, 2, 2, 2);
    expect(constructed.at(-1)).toEqual(["Data3DTexture", [Array.from(pixels), 2, 2, 2]]);
    const image = texture.image as { data: Float32Array | Uint16Array };
    expect(image.data).toBe(pixels);
    image.data = Uint16Array.from(pixels, SharedDataUtils.toHalfFloat);
    texture.type = 1016;
    texture.needsUpdate = true;
    expect(writes.slice(-3).map(([, field, value]) => [field, value])).toEqual([
      ["type", 1016],
      ["image.data", Array(32).fill(0x3800)],
      ["needsUpdate", true],
    ]);
  });

  it("builds a volume from half-float bits and sends them once the type says so", () => {
    const { bound, constructed, writes } = recording();
    const bits = Uint16Array.from([0x3c00, 0x3800, 0, 0x3c00], (v) => v);
    const texture = new (bound.Data3DTexture as Ctor)(bits, 1, 1, 1);
    // The engine's constructor takes bytes or floats: it gets same-sized zero floats, never the bits.
    expect(constructed.at(-1)).toEqual(["Data3DTexture", [[0, 0, 0, 0], 1, 1, 1]]);
    expect((texture.image as { data: unknown }).data).toBe(bits);
    texture.type = 1016;
    texture.needsUpdate = true;
    expect(writes.slice(-3).map(([, field, value]) => [field, value])).toEqual([
      ["type", 1016],
      ["image.data", [0x3c00, 0x3800, 0, 0x3c00]],
      ["needsUpdate", true],
    ]);
  });

  it("keeps an empty volume's image record available for later source assignment", () => {
    const { bound, writes } = recording();
    const texture = new (bound.Data3DTexture as Ctor)();
    const image = texture.image as { data: Uint8Array | null };
    expect(image.data).toBeNull();
    image.data = new Uint8Array([1, 2, 3, 255]);
    texture.needsUpdate = true;
    expect(writes.slice(-2).map(([, field, value]) => [field, value])).toEqual([
      ["image.data", [1, 2, 3, 255]],
      ["needsUpdate", true],
    ]);
  });

  it("builds a DataArrayTexture over the engine's class and re-sends its layers on needsUpdate", () => {
    const { bound, constructed, writes } = recording();
    const layers = new Uint8Array(2 * 2 * 3 * 4).fill(7);
    const map = new (bound.DataArrayTexture as Ctor)(layers, 2, 2, 3);
    expect(constructed.at(-1)).toEqual(["DataArrayTexture", [Array(48).fill(7), 2, 2, 3]]);
    expect(map.isDataArrayTexture).toBe(true);
    expect(map.isArrayTexture).toBe(true);
    expect(map instanceof (bound.DataArrayTexture as Ctor)).toBe(true);
    expect((map.image as { data: unknown }).data).toBe(layers);
    layers[0] = 9;
    map.needsUpdate = true;
    expect(writes.slice(-2).map(([, field, value]) => [field, value])).toEqual([
      ["image.data", [9, ...Array(47).fill(7)]],
      ["needsUpdate", true],
    ]);
  });

  it("builds a CompressedTexture from its mipmaps, coarse first, and sends a streamed finer level alone", () => {
    const { bound, constructed, writes } = recording();
    const CompressedTexture = bound.CompressedTexture as Ctor;
    const coarse = new Uint8Array(16);
    const mipmaps = [
      { data: null as Uint8Array | null, width: 8, height: 8 },
      { data: coarse, width: 4, height: 4 },
    ];
    const texture = new CompressedTexture(mipmaps, 8, 8, 36492);
    expect(texture).toBeInstanceOf(CompressedTexture);
    expect(constructed.at(-1)).toEqual(["CompressedTexture", [2, 8, 8, 36492]]);
    expect(writes.map(([, field]) => field)).toEqual(["mipmaps.1.data"]);
    expect(texture.mipmaps).toBe(mipmaps);
    expect(texture.image).toEqual({ width: 8, height: 8 });
    const fine = new Uint8Array(64);
    (mipmaps[0] as { data: Uint8Array | null }).data = fine;
    texture.needsUpdate = true;
    expect(writes.slice(1).map(([, field, value]) => [field, value])).toEqual([
      ["mipmaps.0.data", Array.from(fine)],
      ["needsUpdate", true],
    ]);
  });

  it("reads a canvas through its 2D context when built and again on needsUpdate", () => {
    const { bound, constructed, writes } = recording();
    let reads = 0;
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({
        getImageData: () => {
          reads++;
          return { data: new Uint8ClampedArray([9, 8, 7, 255]), width: 1, height: 1 };
        },
      }),
    };
    const texture = new (bound.CanvasTexture as Ctor)(canvas);
    // The engine's own CanvasTexture: three's Texture defaults (flipped, linear, mipmapped) and the
    // first upload are its constructor's, so nothing more crosses until needsUpdate.
    expect(constructed.at(-1)).toEqual(["CanvasTexture", [[9, 8, 7, 255], 1, 1]]);
    expect(texture.isCanvasTexture).toBe(true);
    expect(texture instanceof (bound.Texture as Ctor)).toBe(true);
    expect(texture.image).toBe(canvas);
    expect(writes).toEqual([]);
    texture.needsUpdate = true;
    const key = writes[0]?.[0];
    expect(writes).toEqual([
      [key, "image.data", [9, 8, 7, 255]],
      [key, "needsUpdate", true],
    ]);
    expect(reads).toBe(2);
  });

  it("copies a canvas into a CPU-backed canvas, so a GPU-backed one still gives up its pixels", () => {
    const { bound, constructed, writes } = recording();
    // A canvas drawn with a default 2D context is GPU-backed on Chromium over Vulkan: its own
    // getImageData answers zeros for the red fillRect the caller drew. Drawing it into the facade's
    // own willReadFrequently canvas is a copy the browser performs correctly, whatever context drew
    // the caller's canvas, so the readback copies unless the caller's context is willReadFrequently.
    const drawn = new Uint8ClampedArray([255, 0, 0, 255]);
    let copied: Uint8ClampedArray | null = null;
    const contexts = vi.fn(() => ({
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    }));
    const canvas = { width: 1, height: 1, drawn, getContext: contexts };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext(_kind: string, options?: { willReadFrequently?: boolean }) {
          return {
            drawImage: (source: { drawn?: Uint8ClampedArray }) => {
              copied = source.drawn ?? null;
            },
            getImageData: () => ({
              data:
                options?.willReadFrequently === true && copied ? copied : new Uint8ClampedArray(4),
              width: 1,
              height: 1,
            }),
          };
        }
      },
    );
    const texture = new (bound.CanvasTexture as Ctor)(canvas);
    expect(constructed.at(-1)).toEqual(["CanvasTexture", [[255, 0, 0, 255], 1, 1]]);
    texture.needsUpdate = true;
    expect(writes.map(([, field, value]) => [field, value])).toEqual([
      ["image.data", [255, 0, 0, 255]],
      ["needsUpdate", true],
    ]);
    // The caller's context is asked only for its attributes: it is not willReadFrequently, so the
    // zeros its own getImageData would give never reach the upload (the red copy above did).
    expect(contexts).toHaveBeenCalled();
  });

  it("reads a willReadFrequently canvas directly, with no copy, on every needsUpdate", () => {
    const { bound, writes } = recording();
    let offscreen = 0;
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor() {
          offscreen++;
        }
        getContext() {
          return null;
        }
      },
    );
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({
        getContextAttributes: () => ({ willReadFrequently: true }),
        getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 }),
      }),
    };
    const texture = new (bound.CanvasTexture as Ctor)(canvas);
    texture.needsUpdate = true;
    texture.needsUpdate = true;
    expect(writes.filter(([, field]) => field === "image.data")).toHaveLength(2);
    expect(offscreen).toBe(0);
  });

  it("copies a canvas whose getContext('2d') is null (a webgl canvas) by drawing it", () => {
    const { bound, constructed } = recording();
    const canvas = { width: 1, height: 1, getContext: vi.fn(() => null) };
    const drawn: unknown[] = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage: (source: unknown) => drawn.push(source),
            getImageData: () => ({
              data: new Uint8ClampedArray([4, 5, 6, 255]),
              width: 1,
              height: 1,
            }),
          };
        }
      },
    );
    new (bound.CanvasTexture as Ctor)(canvas);
    expect(constructed.at(-1)).toEqual(["CanvasTexture", [[4, 5, 6, 255], 1, 1]]);
    expect(drawn).toEqual([canvas]);
  });

  it("uploads an image's pixels for new Texture(image), and refuses what it cannot read", () => {
    const { bound, constructed } = recording();
    const Texture = bound.Texture as Ctor;
    new Texture();
    expect(constructed.at(-1)).toEqual(["Texture", []]);
    new Texture({ data: new Uint8ClampedArray([1, 2, 3, 4]), width: 1, height: 1 });
    expect(constructed.at(-1)).toEqual(["DataTexture", [[1, 2, 3, 4], 1, 1]]);
    // A decoded ImageBitmap is drawn once into an OffscreenCanvas and read back.
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage: () => undefined,
            getImageData: () => ({
              data: new Uint8ClampedArray([5, 6, 7, 8]),
              width: 1,
              height: 1,
            }),
          };
        }
      },
    );
    const adopted = new Texture({ width: 1, height: 1, close: () => undefined });
    expect(constructed.at(-1)).toEqual(["DataTexture", [[5, 6, 7, 8], 1, 1]]);
    expect(adopted instanceof Texture).toBe(true);
    vi.unstubAllGlobals();
    expect(() => new Texture(42)).toThrow("TN_BROWSER_TEXTURE_SOURCE");
  });

  it("reads an adopted image through a CPU-backed canvas, the only kind whose getImageData returns its pixels", () => {
    const { bound, constructed } = recording();
    // A GPU-backed canvas answers getImageData with zeros on this Chromium over Vulkan: a red
    // fillRect reads back 0/0/0 there and 255/0/0 on a willReadFrequently canvas. The hint is the
    // only way to ask for the CPU-backed one, so the readback must pass it.
    const pixels = new Uint8ClampedArray([5, 6, 7, 8]);
    const asked: unknown[] = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext(_kind: string, options?: { willReadFrequently?: boolean }) {
          asked.push(options);
          return {
            drawImage: () => undefined,
            getImageData: () => ({
              data: options?.willReadFrequently === true ? pixels : new Uint8ClampedArray(4),
              width: 1,
              height: 1,
            }),
          };
        }
      },
    );
    new (bound.Texture as Ctor)({ width: 1, height: 1, close: () => undefined });
    expect(constructed.at(-1)).toEqual(["DataTexture", [[5, 6, 7, 8], 1, 1]]);
    expect(asked).toEqual([{ willReadFrequently: true }]);
    vi.unstubAllGlobals();
  });

  it("gives an adopted image three's mipmap chain, so a minified dial or label does not shimmer (Midway's cockpit)", () => {
    const { bound, writes } = recording();
    const Texture = bound.Texture as Ctor;
    new Texture({ data: new Uint8ClampedArray([1, 2, 3, 4]), width: 1, height: 1 });
    const set = (property: string) => writes.filter(([, name]) => name === property);
    // minFilter 1008 is LinearMipmapLinear: the engine only builds levels when generateMipmaps is true.
    expect(set("minFilter").map(([, , value]) => value)).toEqual([1008]);
    expect(set("generateMipmaps").map(([, , value]) => value)).toEqual([true]);
  });

  it("loads an ImageBitmap as three's ImageBitmapLoader does: fetch, then createImageBitmap", async () => {
    const { bound } = recording();
    const blob = new Blob([new Uint8Array([1])]);
    const decode = vi.fn(async () => ({ width: 1, height: 1 }));
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("missing.png") ? new Response(null, { status: 404 }) : new Response(blob),
    );
    const Loader = bound.ImageBitmapLoader as new () => {
      setOptions(options: object): unknown;
      loadAsync(url: string): Promise<unknown>;
    };
    const loader = new Loader();
    loader.setOptions({ imageOrientation: "flipY" });
    expect(await loader.loadAsync("/assets/dial.png")).toEqual({ width: 1, height: 1 });
    expect(decode).toHaveBeenCalledWith(expect.any(Blob), {
      colorSpaceConversion: "none",
      imageOrientation: "flipY",
    });
    await expect(loader.loadAsync("/assets/missing.png")).rejects.toThrow("TN_BROWSER_IMAGE_FETCH");
  });

  it("binds DataUtils to the shared, three-exact implementation", () => {
    expect(recording().bound.DataUtils).toBe(SharedDataUtils);
  });

  it("binds three's ColorManagement object, so working-space conversion runs unchanged", async () => {
    const { ColorManagement } = (await import("three/src/math/ColorManagement.js")) as {
      ColorManagement: {
        enabled: boolean;
        workingToColorSpace(color: { r: number; g: number; b: number }, space: string): void;
      };
    };
    const bound = recording().bound.ColorManagement as typeof ColorManagement;
    expect(bound).toBe(ColorManagement);
    expect(bound.enabled).toBe(true);
    const color = { r: 0.21404114, g: 0.21404114, b: 0.21404114 };
    bound.workingToColorSpace(color, "srgb");
    expect(color.r).toBeCloseTo(0.5, 4);
  });
});

describe("browser HDRLoader", () => {
  it("decodes a fetched .hdr into an engine DataTexture with DataTextureLoader's settings", async () => {
    const { bound, constructed, writes } = recording();
    vi.doMock("three", () => ({
      DataTexture: bound.DataTexture,
      LinearFilter: 1006,
      LinearSRGBColorSpace: "srgb-linear",
      RGBAFormat: 1023,
    }));
    const { HDRLoader } = await import("../src/addons/hdr-loader.js");
    const header = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n");
    const hdr = new Uint8Array([...header, 128, 64, 0, 129]);
    vi.stubGlobal("fetch", async () => new Response(hdr));
    const texture = await new HDRLoader().loadAsync("/assets/sky.hdr");
    const [name, args] = constructed.at(-1) ?? [];
    expect(name).toBe("DataTexture");
    // 128 * 2^(129-128) / 255 and 64 * 2 / 255 as binary16, blue 0, alpha 1.
    expect(args?.slice(1)).toEqual([1, 1, 1023, 1016]);
    expect(args?.[0]).toEqual([
      SharedDataUtils.toHalfFloat((128 * 2) / 255),
      SharedDataUtils.toHalfFloat((64 * 2) / 255),
      0,
      0x3c00,
    ]);
    expect(texture).toBeInstanceOf(bound.DataTexture as Ctor);
    const key = writes.at(-1)?.[0];
    expect(
      writes.filter(([owner]) => owner === key).map(([, property, value]) => [property, value]),
    ).toEqual([
      ["colorSpace", "srgb-linear"],
      ["magFilter", 1006],
      ["minFilter", 1006],
      ["flipY", true],
      ["image.data", args?.[0]],
      ["needsUpdate", true],
    ]);
    vi.doUnmock("three");
  });
});
