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
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId,
    construct: (name, args) => {
      constructed.push([name, [...args]]);
      return { key: `${name}#${String(next++)}`, type: typeId(name) };
    },
    invoke: () => {
      throw new Error("not under test");
    },
    get: () => undefined,
    set: (self, property, value) => {
      writes.push([self.key, property, value]);
    },
    release: () => undefined,
    setCallback: () => undefined,
  };
  const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
  return { bound: withTextureSources(classes, runtime), constructed, writes };
}

type Ctor = new (...args: unknown[]) => Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe("browser texture sources", () => {
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
