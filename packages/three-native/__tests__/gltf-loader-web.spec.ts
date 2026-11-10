import { afterEach, describe, expect, it, vi } from "vitest";

// PRD-617: the web GLTFLoader hands a model to the engine's own loader, which reads no files. A cooked
// model names its shared images by relative uri, so the page fetches them and passes the bytes along;
// without them the engine refused the model (TN_NATIVE_GLTF_IMAGE_UNSUPPORTED) and the game never booted.
const loadGltf = vi.hoisted(() =>
  vi.fn((_bytes: Uint8Array, _files: ReadonlyMap<string, Uint8Array>) => ({
    animations: [],
    scene: { name: "scene" },
  })),
);
vi.mock("three", () => ({ __tnLoadGltf: loadGltf }));

const { GLTFLoader, externalImageUris } = await import("../src/addons/gltf-loader-web.js");

function glb(json: object): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(20 + padded.length);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46]);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  return out.buffer;
}

const MODEL = glb({
  asset: { version: "2.0" },
  images: [
    { uri: "shared/images/a%20b.jpg" },
    { uri: "data:image/png;base64,AAAA" },
    { bufferView: 0 },
    { uri: "shared/images/a%20b.jpg" },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  loadGltf.mockClear();
});

describe("the web GLTFLoader's image files", () => {
  it("names only the relative uris, once each", () => {
    expect(externalImageUris(MODEL)).toEqual(["shared/images/a%20b.jpg"]);
    expect(externalImageUris(JSON.stringify({ images: [{ uri: "x.png" }] }))).toEqual(["x.png"]);
    expect(externalImageUris(new ArrayBuffer(3))).toEqual([]);
  });

  it("fetches them beside the model and hands the engine their bytes by decoded uri", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return {
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: new Headers({ "content-type": "image/jpeg" }),
        ok: true,
        status: 200,
      };
    });
    await new GLTFLoader().parseAsync(MODEL, "assets/");
    expect(fetched).toEqual(["assets/shared/images/a%20b.jpg"]);
    expect(loadGltf).toHaveBeenCalledTimes(1);
    const files = loadGltf.mock.calls[0]?.[1];
    expect([...(files?.keys() ?? [])]).toEqual(["shared/images/a b.jpg"]);
    expect([...(files?.get("shared/images/a b.jpg") ?? [])]).toEqual([1, 2, 3]);
  });

  // The Strata forest loads ten spruce models at once that share one 12 MB atlas: ten fetches of it,
  // 835 MB of a 1,051 MB load, before this.
  it("fetches an image once while models that share it load at the same time", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return {
        arrayBuffer: async () => new Uint8Array([7]).buffer,
        headers: new Headers({ "content-type": "image/png" }),
        ok: true,
        status: 200,
      };
    });
    await Promise.all([
      new GLTFLoader().parseAsync(MODEL, "shared-load/a/"),
      new GLTFLoader().parseAsync(MODEL, "shared-load/a/"),
      new GLTFLoader().parseAsync(MODEL, "shared-load/b/../a/"),
    ]);
    expect(fetched).toEqual(["shared-load/a/shared/images/a%20b.jpg"]);
    expect(loadGltf).toHaveBeenCalledTimes(3);
    for (const call of loadGltf.mock.calls)
      expect([...(call[1].get("shared/images/a b.jpg") ?? [])]).toEqual([7]);
  });

  it("fails by name when an image file is missing, rather than loading the model bare", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(new GLTFLoader().parseAsync(MODEL, "assets/")).rejects.toThrow(
      "TN_WASM_GLTF_FETCH: 404 assets/shared/images/a%20b.jpg",
    );
    expect(loadGltf).not.toHaveBeenCalled();
  });

  // PRD-637: a dev server answers a missing file with its index.html and a 200 (Vite's SPA fallback).
  // Those bytes reached the engine as the image, which then refused the model as "undecoded images".
  it("fails by name when the server answers an image with a page, rather than handing the engine HTML", async () => {
    vi.stubGlobal("fetch", async () => ({
      arrayBuffer: async () => new TextEncoder().encode("<!doctype html>").buffer,
      headers: new Headers({ "content-type": "text/html" }),
      ok: true,
      status: 200,
    }));
    await expect(new GLTFLoader().parseAsync(MODEL, "assets/")).rejects.toThrow(
      "TN_WASM_GLTF_FETCH: text/html assets/shared/images/a%20b.jpg",
    );
    expect(loadGltf).not.toHaveBeenCalled();
  });

  it("loads a model with no image files without a fetch", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("no fetch expected");
    });
    await new GLTFLoader().parseAsync(glb({ asset: { version: "2.0" } }), "");
    expect(loadGltf).toHaveBeenCalledWith(expect.any(Uint8Array), new Map());
  });

  // PRD-861: core wires three's MeshoptDecoder for every model that declares meshopt, and the web bake
  // emits meshopt for this engine. The engine's own loader decodes the mesh; the JS decoder reads only a
  // hosted LOD chain's compressed index views (model-lod-engine-loader.spec.ts).
  it("takes a meshopt decoder and hands a meshopt model to the engine", async () => {
    const loader = new GLTFLoader();
    const decoder = { decodeGltfBuffer: () => undefined, ready: Promise.resolve() };
    expect(loader.setMeshoptDecoder(decoder)).toBe(loader);
    await loader.parseAsync(
      glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] }),
      "",
    );
    expect(loadGltf).toHaveBeenCalledTimes(1);
  });

  it("takes a KTX2 loader and hands a KHR_texture_basisu model to the engine", async () => {
    const loader = new GLTFLoader();
    expect(loader.setKTX2Loader({})).toBe(loader);
    await loader.parseAsync(
      glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"] }),
      "",
    );
    expect(loadGltf).toHaveBeenCalledTimes(1);
  });

  it("refuses a plugin it does not host by name, rather than skipping it", async () => {
    const loader = new GLTFLoader().register(() => ({ name: "KHR_other" }));
    await expect(loader.parseAsync(glb({ asset: { version: "2.0" } }), "")).rejects.toThrow(
      "TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED",
    );
    expect(loadGltf).not.toHaveBeenCalled();
  });
});
