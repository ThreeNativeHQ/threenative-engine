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
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, ok: true, status: 200 };
    });
    await new GLTFLoader().parseAsync(MODEL, "assets/");
    expect(fetched).toEqual(["assets/shared/images/a%20b.jpg"]);
    expect(loadGltf).toHaveBeenCalledTimes(1);
    const files = loadGltf.mock.calls[0]?.[1];
    expect([...(files?.keys() ?? [])]).toEqual(["shared/images/a b.jpg"]);
    expect([...(files?.get("shared/images/a b.jpg") ?? [])]).toEqual([1, 2, 3]);
  });

  it("fails by name when an image file is missing, rather than loading the model bare", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(new GLTFLoader().parseAsync(MODEL, "assets/")).rejects.toThrow(
      "TN_WASM_GLTF_FETCH: 404 assets/shared/images/a%20b.jpg",
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

  it("refuses a plugin it does not host by name, rather than skipping it", async () => {
    const loader = new GLTFLoader().register(() => ({ name: "KHR_other" }));
    await expect(loader.parseAsync(glb({ asset: { version: "2.0" } }), "")).rejects.toThrow(
      "TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED",
    );
    expect(loadGltf).not.toHaveBeenCalled();
  });
});
