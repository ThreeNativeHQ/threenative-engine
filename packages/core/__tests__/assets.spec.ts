import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  type CompressedTexture,
  Float32BufferAttribute,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MirroredRepeatWrapping,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";
import { defineGame } from "../src/game.js";
import { type ICtx, Scene } from "../src/scene.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/** A game with no compiled output: the manifest probe 404s and every path is served verbatim. */
function noManifestFetch(): (url: string) => Promise<Response> {
  return async (url: string) =>
    url.endsWith("assets.manifest.json")
      ? new Response("gone", { status: 404 })
      : new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
}

describe("IAssetLoader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should return the same promise for a repeated model request", async () => {
    const requests: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    const first = assets.model<{ url: string }>("a.glb");
    const second = assets.model<{ url: string }>("a.glb");

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ url: "/assets/a.glb" });
    expect(requests).toEqual(["/assets/a.glb"]);
  });

  it("should release one cached asset and reload it on the next request", async () => {
    const requests: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    await assets.model("a.glb");

    expect(assets.release("model", "a.glb")).toBe(true);
    expect(assets.release("model", "a.glb")).toBe(false);
    await assets.model("a.glb");

    expect(requests).toEqual(["/assets/a.glb", "/assets/a.glb"]);
  });

  it("should dispose a texture once and ignore a double release", async () => {
    const texture = new Texture();
    const dispose = vi.spyOn(texture, "dispose");
    const assets = createAssetLoader({ texture: async () => texture });

    await assets.texture("albedo.png");

    expect(assets.release("texture", "albedo.png")).toBe(true);
    expect(assets.release("texture", "albedo.png")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("should dispose model geometry, material, and material textures once on clear", async () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const texture = new Texture();
    const material = new MeshBasicMaterial({ map: texture });
    const mesh = new Mesh(geometry, material);
    const scene = new Group().add(mesh);
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const textureDispose = vi.spyOn(texture, "dispose");
    const assets = createAssetLoader({ model: async () => ({ scene }) });

    await assets.model("model.glb");
    assets.clear();
    assets.clear();

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it("should release one model's material texture once, spare another cached model's, and reload", async () => {
    const loaded: Texture[] = [];
    const assets = createAssetLoader({
      model: async () => {
        const texture = new Texture();
        loaded.push(texture);
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ map: texture }));
        return { scene: new Group().add(mesh) };
      },
    });
    await assets.model("a.glb");
    await assets.model("b.glb");
    const [textureA, textureB] = loaded as [Texture, Texture];
    const disposeA = vi.spyOn(textureA, "dispose");
    const disposeB = vi.spyOn(textureB, "dispose");

    expect(assets.release("model", "a.glb")).toBe(true);
    expect(assets.release("model", "a.glb")).toBe(false);
    expect(disposeA).toHaveBeenCalledTimes(1);
    // b.glb is still cached and owns its own material texture: releasing a must not touch it.
    expect(disposeB).not.toHaveBeenCalled();

    await assets.model("a.glb");
    expect(loaded.at(-1)).not.toBe(textureA);
    expect(disposeA).toHaveBeenCalledTimes(1);
  });

  it("should release a model's material texture once when released before its load settles", async () => {
    const texture = new Texture();
    const dispose = vi.spyOn(texture, "dispose");
    let settle: (() => void) | undefined;
    const assets = createAssetLoader({
      model: () =>
        new Promise((resolve) => {
          settle = () => {
            const mesh = new Mesh(
              new BoxGeometry(1, 1, 1),
              new MeshBasicMaterial({ map: texture }),
            );
            resolve({ scene: new Group().add(mesh) });
          };
        }),
    });

    const pending = assets.model("a.glb");
    await vi.waitUntil(() => settle !== undefined);
    expect(assets.release("model", "a.glb")).toBe(true);
    (settle as () => void)();
    await pending;

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("times each asset only when the caller asked, and names the path when it does", async () => {
    // The group totals a game logs cannot say *which* asset is slow; this seam is the engine's one
    // place that sees every settle. Off by default and silent when off.
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const quiet = createAssetLoader({ model: async () => ({ scene: new Group() }) });
      await quiet.model("quiet.glb");
      expect(logged).toEqual([]);

      (globalThis as { __TN_ASSET_TRACE__?: boolean }).__TN_ASSET_TRACE__ = true;
      const traced = createAssetLoader({ model: async () => ({ scene: new Group() }) });
      await traced.model("traced.glb");
      const marker = logged.find((line) => line.startsWith("TN_ASSET:"));
      expect(marker).toBeDefined();
      const payload = JSON.parse((marker as string).slice("TN_ASSET:".length));
      expect(payload).toMatchObject({ kind: "model", path: "traced.glb" });
      expect(Number.isFinite(payload.ms)).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "__TN_ASSET_TRACE__");
      spy.mockRestore();
    }
  });

  it("loads textures through fetch and createImageBitmap when Image is unavailable", async () => {
    const bitmap = { height: 16, width: 16 } as ImageBitmap;
    const createBitmap = vi.fn(async () => bitmap);
    // The loader probes for a compiled-asset manifest first; this game serves none.
    const fetchAsset = vi.fn(async (url: string) =>
      url === "assets.manifest.json"
        ? new Response("gone", { status: 404 })
        : new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }),
    );
    vi.stubGlobal("Image", undefined);
    vi.stubGlobal("createImageBitmap", createBitmap);
    vi.stubGlobal("fetch", fetchAsset);

    const texture = await createAssetLoader().texture("native-proof.png");

    expect(fetchAsset).toHaveBeenCalledWith("native-proof.png");
    expect(createBitmap).toHaveBeenCalledOnce();
    expect(texture.image).toBe(bitmap);
    expect(texture.version).toBe(1);
  });

  it("should decode a texture's pixels before resolving it in a browser", async () => {
    // A browser has `Image`, so before this the loader took `TextureLoader` and resolved on the
    // <img>'s onload — with the pixels still undecoded and the cost due later, on the main thread,
    // during play. `createImageBitmap` is the same choice three's own GLTFLoader already makes.
    const bitmap = { height: 2048, width: 2048 } as ImageBitmap;
    const createBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal("Image", class {});
    vi.stubGlobal("createImageBitmap", createBitmap);
    vi.stubGlobal("fetch", noManifestFetch());

    const texture = await createAssetLoader().texture("rock.png");

    expect(createBitmap).toHaveBeenCalledOnce();
    expect(texture.image).toBe(bitmap);
  });

  it("should keep a WebGL2 texture in the orientation TextureLoader produced", async () => {
    // WebGL cannot flip an ImageBitmap and ignores `flipY` outright, so the browser has to decode
    // it flipped. Getting this wrong turns every standalone texture upside down, silently.
    const createBitmap = vi.fn(
      async (_blob: Blob, _options?: ImageBitmapOptions) =>
        ({ height: 4, width: 4 }) as ImageBitmap,
    );
    vi.stubGlobal("Image", class {});
    vi.stubGlobal("createImageBitmap", createBitmap);
    vi.stubGlobal("fetch", noManifestFetch());

    const texture = await createAssetLoader({
      renderer: { isWebGPURenderer: false },
    }).texture("rock.png");

    expect(createBitmap.mock.calls[0]?.[1]).toEqual({ imageOrientation: "flipY" });
    expect(texture.flipY).toBe(false);
  });

  it("should let a WebGPU renderer flip the texture at upload", async () => {
    // WebGPU's copyExternalImageToTexture takes flipY natively, so the bitmap arrives unflipped
    // and `flipY` stays true — which is also what the native host has always done.
    const createBitmap = vi.fn(
      async (_blob: Blob, _options?: ImageBitmapOptions) =>
        ({ height: 4, width: 4 }) as ImageBitmap,
    );
    vi.stubGlobal("Image", class {});
    vi.stubGlobal("createImageBitmap", createBitmap);
    vi.stubGlobal("fetch", noManifestFetch());

    const texture = await createAssetLoader({
      renderer: { isWebGPURenderer: true },
    }).texture("rock.png");

    expect(createBitmap.mock.calls[0]?.[1]).toBeUndefined();
    expect(texture.flipY).toBe(true);
  });

  it("should weight progress by the bytes the manifest records", async () => {
    // One small asset out of two files is half the files and a hundredth of the download. A bar
    // reading the file count tells the player they are halfway through a 101 MB fetch.
    const manifest = {
      entries: {
        "huge.glb": { bytes: 100_000_000, kind: "model", output: "huge.aaaa.glb" },
        "tiny.png": { bytes: 1_000_000, kind: "texture", output: "tiny.bbbb.png" },
      },
      version: 1,
    };
    let releaseHuge = (): void => undefined;
    const assets = createAssetLoader({
      manifest: "m.json",
      model: async () =>
        new Promise<Group>((resolve) => {
          releaseHuge = () => resolve(new Group());
        }),
      texture: async () => new Texture(),
    });
    vi.stubGlobal("fetch", async () => Response.json(manifest));

    await assets.texture("tiny.png");
    const pending = assets.model<Group>("huge.glb");
    await vi.waitUntil(() => assets.progress.requestedBytes === 101_000_000);

    expect(assets.progress.settled / assets.progress.requested).toBe(0.5);
    expect(assets.progress.settledBytes / assets.progress.requestedBytes).toBeCloseTo(0.0099, 4);

    releaseHuge();
    await pending;
    await vi.waitUntil(() => assets.progress.settledBytes === 101_000_000);
  });

  it("should leave the byte ledger at zero when no manifest names a size", async () => {
    // A project that never ran the compile step keeps the file ratio; there is nothing else to
    // know before the bytes arrive, and a fabricated denominator would be worse than a count.
    const assets = createAssetLoader({ texture: async () => new Texture() });
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

    await assets.texture("rock.png");

    expect(assets.progress.settled).toBe(1);
    expect(assets.progress.requestedBytes).toBe(0);
    expect(assets.progress.settledBytes).toBe(0);
  });

  it("should enter the scene only after load resolves", async () => {
    const events: string[] = [];
    class OrderedScene extends Scene<{ loaded: boolean }> {
      override async load(_ctx: ICtx<{ loaded: boolean }>): Promise<void> {
        await Promise.resolve();
        events.push("load");
      }

      override enter(_ctx: ICtx<{ loaded: boolean }>): void {
        events.push("enter");
      }
    }

    const canvas = testCanvas();
    const game = defineGame<{ loaded: boolean }>({
      initialState: { loaded: false },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { ordered: OrderedScene },
      start: "ordered",
    });

    await game.start();

    expect(events).toEqual(["load", "enter"]);
    game.stop();
  });
});

describe("IAssetLoader.texture options", () => {
  it("should apply the options to a copy and leave the cached instance untouched", async () => {
    const cached = new Texture();
    // What an image file arrives as: sRGB. A normal map is not, and asking for one must not say so
    // to every other material sharing the same bytes.
    cached.colorSpace = SRGBColorSpace;
    cached.anisotropy = 16;
    const assets = createAssetLoader({ texture: async () => cached });

    const configured = await assets.texture("normal.png", {
      anisotropy: 8,
      data: true,
      repeat: [2, 3],
      wrap: RepeatWrapping,
    });

    expect(configured).not.toBe(cached);
    expect(configured.image).toBe(cached.image);
    expect(configured.colorSpace).toBe(NoColorSpace);
    expect(configured.wrapS).toBe(RepeatWrapping);
    expect(configured.wrapT).toBe(RepeatWrapping);
    expect(configured.repeat.toArray()).toEqual([2, 3]);
    expect(configured.anisotropy).toBe(8);
    // The shared instance other callers of the same path hold.
    expect(cached.colorSpace).toBe(SRGBColorSpace);
    expect(cached.wrapS).not.toBe(RepeatWrapping);
    expect(cached.repeat.toArray()).toEqual([1, 1]);
    expect(cached.anisotropy).toBe(16);
    // And a configured load is not cached, so the next one is configured again from the same bytes.
    expect(await assets.texture("normal.png", { data: true })).not.toBe(configured);
    expect((await assets.texture("normal.png", { data: true })).colorSpace).toBe(NoColorSpace);
  });

  it("should treat one repeat number as both axes and sRGB as the explicit non-data space", async () => {
    const assets = createAssetLoader({ texture: async () => new Texture() });

    const tiled = await assets.texture("tile.png", { data: false, repeat: 5 });
    const wrapped = await assets.texture("tile.png", { wrap: MirroredRepeatWrapping });

    expect(tiled.colorSpace).toBe(SRGBColorSpace);
    expect(tiled.repeat.toArray()).toEqual([5, 5]);
    expect(tiled.wrapS).not.toBe(MirroredRepeatWrapping);
    expect(wrapped.wrapS).toBe(MirroredRepeatWrapping);
    expect(wrapped.wrapT).toBe(MirroredRepeatWrapping);
    // Options without `data` are colour: a loader's linear default must not wash out an albedo.
    expect(wrapped.colorSpace).toBe(SRGBColorSpace);
  });

  it("should hand back the same cached instance when no options are given", async () => {
    const cached = new Texture();
    const assets = createAssetLoader({ texture: async () => cached });

    const first = await assets.texture("albedo.png");
    const second = await assets.texture("albedo.png");

    expect(first).toBe(cached);
    expect(second).toBe(cached);
    expect(assets.progress.requested).toBe(1);
  });
});

describe("IAssetLoader through the asset manifest", () => {
  afterEach(() => vi.unstubAllGlobals());

  function manifestResponse(body: string | unknown, status = 200): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }

  it("should resolve a logical path to the manifest output when a manifest exists", async () => {
    const fetchAsset = vi.fn(async () =>
      manifestResponse({
        version: 1,
        entries: {
          "rock.png": { output: "rock.a1b2c3.png", kind: "texture", bytes: 184320, passes: [] },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      manifest: "my-assets.json",
      texture: async (url) => {
        requests.push(url);
        return new Texture();
      },
    });

    const texture = await assets.texture("rock.png");

    expect(texture).toBeInstanceOf(Texture);
    expect(fetchAsset).toHaveBeenCalledWith("/assets/my-assets.json");
    expect(requests).toEqual(["/assets/rock.a1b2c3.png"]);
  });

  it("should record the manifest output that served a load", async () => {
    // `progress` counts loads and cannot say which url answered. A project whose manifest 404s
    // and one whose manifest named the output are indistinguishable from the game's own side,
    // which is how a silently-unreadable manifest became an invisible uncompiled fallback.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": { output: "rock.a1b2c3.png", kind: "texture", bytes: 1, passes: [] },
          },
        }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets", texture: async () => new Texture() });

    await assets.texture("rock.png");

    expect(assets.resolved.get("rock.png")).toEqual({
      url: "/assets/rock.a1b2c3.png",
      via: "manifest",
    });
  });

  it("should hand a game the served urls of a path its own loader has to fetch", async () => {
    // An HDR sky, a font, a data file: loaders this surface does not wrap. Without this a game
    // hard-codes the hashed output name and breaks on the next bake — Wildwood's sky did.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "hdri/sky.hdr": {
              output: "hdri/sky.da8e1984.hdr",
              kind: "other",
              bytes: 5,
              passes: [],
            },
          },
        }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/", manifest: "assets.manifest.json" });
    await expect(assets.resolve("hdri/sky.hdr")).resolves.toEqual(["/hdri/sky.da8e1984.hdr"]);
    await expect(assets.resolve("hdri/missing.hdr")).rejects.toThrow(
      /not listed in the asset manifest/u,
    );
  });

  it("should count requested and settled loads for a loading view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse("gone", 404)),
    );
    const assets = createAssetLoader({
      basePath: "/",
      // Settles on the next macrotask, so the counters can be read while the load is in flight.
      texture: (url) =>
        url.includes("nope")
          ? Promise.reject(new Error("no such texture"))
          : new Promise<Texture>((resolve) => setTimeout(() => resolve(new Texture()), 0)),
    });
    expect(assets.progress).toEqual({
      pending: [],
      requested: 0,
      requestedBytes: 0,
      settled: 0,
      settledBytes: 0,
    });
    const first = assets.texture("a.png");
    void assets.texture("a.png"); // cached: one request, not two
    // No manifest here, so no size is knowable and the byte ledger stays at zero throughout.
    // A loading view reads `pending` to say *what* it is waiting for, not just how much is left.
    expect(assets.progress).toEqual({
      pending: ["a.png"],
      requested: 1,
      requestedBytes: 0,
      settled: 0,
      settledBytes: 0,
    });
    await first;
    expect(assets.progress).toEqual({
      pending: [],
      requested: 1,
      requestedBytes: 0,
      settled: 1,
      settledBytes: 0,
    });
    await expect(assets.texture("nope.png")).rejects.toThrow(/no such texture/u);
    // A rejected load settles too: a bar that waits for a texture that failed never finishes.
    // A rejected load leaves `pending` too, or the bar names a file nothing is waiting for.
    expect(assets.progress).toEqual({
      pending: [],
      requested: 2,
      requestedBytes: 0,
      settled: 2,
      settledBytes: 0,
    });
  });

  it("should load the raw path when no manifest is served", async () => {
    const fetchAsset = vi.fn(async () => manifestResponse("gone", 404));
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    await expect(assets.model("rock.png")).resolves.toEqual({ url: "/assets/rock.png" });
    expect(fetchAsset).toHaveBeenCalledWith("/assets/assets.manifest.json");
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(["/assets/rock.png"]);
  });

  it("should fall back to the source directory when the compiled output is gone", async () => {
    // The delete-test: the bake produced `rock.a1b2c3.png` and the manifest that named it, both
    // were deleted, and only `assets/rock.png` is left. Before this the loader asked for
    // `/rock.png`, which exists nowhere in a compiled project, and the game did not boot.
    const fetchAsset = vi.fn(async () => manifestResponse("gone", 404));
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      model: async (url) => {
        requests.push(url);
        if (url === "assets/rock.png") return { url };
        throw new Error(`404: ${url}`);
      },
    });

    await expect(assets.model("rock.png")).resolves.toEqual({ url: "assets/rock.png" });
    // Verbatim first: a project with no pipeline at all keeps working, and pays nothing.
    expect(requests).toEqual(["rock.png", "assets/rock.png"]);
  });

  it("should record the candidate that actually answered, not the one that was tried first", async () => {
    // The delete-test's own shape: the verbatim path 404s and the source directory serves it. The
    // record names the winner, so a reader can tell this apart from a manifest-served load.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse("gone", 404)),
    );
    const assets = createAssetLoader({
      basePath: "/",
      model: async (url) => {
        if (url !== "/assets/rock.png") throw new Error(`404: ${url}`);
        return { url };
      },
    });

    await assets.model("rock.png");

    expect(assets.resolved.get("rock.png")).toEqual({ url: "/assets/rock.png", via: "source" });
  });

  it("should not reach for the source directory when the verbatim path works", async () => {
    const fetchAsset = vi.fn(async () => manifestResponse("gone", 404));
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    await expect(assets.model("rock.png")).resolves.toEqual({ url: "rock.png" });
    expect(requests).toEqual(["rock.png"]);
  });

  it("should honour a project that moved its sources", async () => {
    const fetchAsset = vi.fn(async () => manifestResponse("gone", 404));
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      sourcePath: "art",
      model: async (url) => {
        requests.push(url);
        if (url === "art/rock.png") return { url };
        throw new Error(`404: ${url}`);
      },
    });

    await expect(assets.model("rock.png")).resolves.toEqual({ url: "art/rock.png" });
    expect(requests).toEqual(["rock.png", "art/rock.png"]);
  });

  it("should name every url it tried when none of them load", async () => {
    const fetchAsset = vi.fn(async () => manifestResponse("gone", 404));
    vi.stubGlobal("fetch", fetchAsset);
    const assets = createAssetLoader({
      model: async (url) => {
        throw new Error(`404: ${url}`);
      },
    });

    // One error naming both places, not a single last-url message that reads as one missing file.
    await expect(assets.model("rock.png")).rejects.toThrow(/TN_ASSETS_UNRESOLVED/u);
    await expect(assets.model("rock.png")).rejects.toThrow(/rock\.png.*assets\/rock\.png/su);
  });

  it("should keep a manifest miss an error rather than a search", async () => {
    const fetchAsset = vi.fn(async () =>
      manifestResponse({ version: 1, entries: { "other.png": { output: "other.a1b2c3.png" } } }),
    );
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    // A served manifest is authoritative: a path it does not list is a build mistake, and probing
    // the source directory behind its back would hide it.
    await expect(assets.model("rock.png")).rejects.toThrow(/is not listed in the asset manifest/u);
    expect(requests).toEqual([]);
  });

  it("should treat an SPA fallback page as an absent manifest", async () => {
    const fetchAsset = vi.fn(
      async () =>
        new Response("<!doctype html><html><body>app</body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchAsset);
    const requests: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async (url) => {
        requests.push(url);
        return { url };
      },
    });

    await expect(assets.model("rock.png")).resolves.toEqual({ url: "/assets/rock.png" });
    expect(fetchAsset).toHaveBeenCalledWith("/assets/assets.manifest.json");
    expect(requests).toEqual(["/assets/rock.png"]);
  });

  it("should throw when the manifest is present but the path is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse({ version: 1, entries: {} })),
    );
    const assets = createAssetLoader({ basePath: "/assets", model: async () => ({}) });

    await expect(assets.model("rock.png")).rejects.toThrow(/rock\.png/u);
  });

  it("should fail the load when a manifest entry points at a missing output", async () => {
    // The negative control for manifest trust: a corrupted `output` value must surface as a
    // broken load naming the compiled file, never silently fall through to the raw path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": { output: "rock.deadbeef.png", kind: "texture", bytes: 1, passes: [] },
          },
        }),
      ),
    );
    const requested: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      texture: async (url) => {
        requested.push(url);
        throw new Error(`404: ${url}`);
      },
    });

    await expect(assets.texture("rock.png")).rejects.toThrow(/rock\.deadbeef\.png/u);
    expect(requested).toEqual(["/assets/rock.deadbeef.png"]);
  });

  it("should throw when the manifest version is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse({ version: 2, entries: {} })),
    );
    const assets = createAssetLoader({ basePath: "/assets", model: async () => ({}) });

    await expect(assets.model("rock.png")).rejects.toThrow(/version/u);
  });

  it("should throw when the manifest body does not parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse("{not json")),
    );
    const assets = createAssetLoader({ basePath: "/assets", model: async () => ({}) });

    await expect(assets.model("rock.png")).rejects.toThrow(/manifest/u);
  });

  it("should throw when the manifest response is an error other than 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => manifestResponse("boom", 500)),
    );
    const assets = createAssetLoader({ basePath: "/assets", model: async () => ({}) });

    await expect(assets.model("rock.png")).rejects.toThrow(/500/u);
  });

  it("should memoise the manifest fetch across kinds and repeats", async () => {
    const fetchAsset = vi.fn(async () =>
      manifestResponse({
        version: 1,
        entries: {
          "a.png": { output: "a.111111.png" },
          "b.glb": { output: "b.222222.glb" },
          "c.ogg": { output: "c.333333.ogg" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchAsset);
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async () => ({}),
      texture: async () => new Texture(),
      audio: async () => ({ length: 0 }) as unknown as AudioBuffer,
    });

    await Promise.all([
      assets.texture("a.png"),
      assets.model("b.glb"),
      assets.audio("c.ogg"),
      assets.texture("a.png"),
    ]);

    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
});

describe("IAssetLoader compressed textures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function manifestResponse(body: string | unknown, status = 200): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }

  /** A WebGL-shaped renderer stub whose extension surface reports exactly `supported`. */
  function webglRenderer(supported: Record<string, boolean>): object {
    return { extensions: { has: (name: string) => supported[name] ?? false } };
  }

  const S3TC = { WEBGL_compressed_texture_s3tc: true };

  it("should not reject an unsupported renderer when the manifest has no KTX2 output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": { output: "rock.a1b2c3d4.png" },
          },
        }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });

    await expect(assets.compressedTextures?.ready).resolves.toBeUndefined();
  });

  it("should throw when no compressed format is supported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": { output: "rock.a1b2c3d4.ktx2" },
          },
        }),
      ),
    );
    // Nothing reports a compressed-texture extension: a build that actually publishes KTX2
    // must reject at construction rather than let three silently transcode to RGBA32 later.
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });

    await expect(assets.compressedTextures?.ready).rejects.toThrow(/TN_ASSETS_KTX2_UNSUPPORTED/u);
    await expect(assets.compressedTextures?.ready).rejects.toThrow(/webgl2/u);
  });

  it("should configure the shared loader from the real detected support", async () => {
    const assets = createAssetLoader({
      basePath: "/assets",
      renderer: webglRenderer(S3TC),
    });

    const loader = (await assets.compressedTextures?.loader) as unknown as {
      transcoderPath: string;
      workerConfig: Record<string, boolean>;
    };
    expect(loader.workerConfig).toEqual(expect.objectContaining({ dxtSupported: true }));
    expect(loader.transcoderPath).toBe("/assets/basis/");
  });

  it("should call detectSupport exactly once for repeated loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": {
              output: "rock.a1b2c3d4.ktx2",
              kind: "texture",
              bytes: 9,
              passes: ["ktx2"],
            },
            "wall.png": {
              output: "wall.e5f6a7b8.ktx2",
              kind: "texture",
              bytes: 9,
              passes: ["ktx2"],
            },
          },
        }),
      ),
    );
    vi.spyOn(KTX2Loader.prototype, "load").mockImplementation(
      (_url: string, onLoad: (data: CompressedTexture) => void) => {
        onLoad(new Texture() as unknown as CompressedTexture);
        return undefined;
      },
    );
    const detectSpy = vi.spyOn(KTX2Loader.prototype, "detectSupport");
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer(S3TC) });

    // Two distinct textures: both go through the loader, detection must still run once.
    await Promise.all([assets.texture("rock.png"), assets.texture("wall.png")]);

    expect(detectSpy).toHaveBeenCalledTimes(1);
  });

  it("should throw when compiled compressed output loads without a renderer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": {
              output: "rock.a1b2c3d4.ktx2",
              kind: "texture",
              bytes: 9,
              passes: ["ktx2"],
            },
          },
        }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets" });

    await expect(assets.texture("rock.png")).rejects.toThrow(/TN_ASSETS_KTX2_NO_RENDERER/u);
  });

  it("should share one KTX2 loader between model and texture loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "rock.png": {
              output: "rock.a1b2c3d4.ktx2",
              kind: "texture",
              bytes: 9,
              passes: ["ktx2"],
            },
            "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
          },
        }),
      ),
    );
    const detectSpy = vi.spyOn(KTX2Loader.prototype, "detectSupport");
    vi.spyOn(KTX2Loader.prototype, "load").mockImplementation(
      (_url: string, onLoad: (data: CompressedTexture) => void) => {
        onLoad(new Texture() as unknown as CompressedTexture);
        return undefined;
      },
    );
    const setKtx2Spy = vi.spyOn(GLTFLoader.prototype, "setKTX2Loader").mockReturnThis();
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ url: "loaded.glb" });
      return this;
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(
              JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"] }),
            )
          : manifestResponse({
              version: 1,
              entries: {
                "rock.png": {
                  output: "rock.a1b2c3d4.ktx2",
                  kind: "texture",
                  bytes: 9,
                  passes: ["ktx2"],
                },
                "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
              },
            }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer(S3TC) });
    const shared = await assets.compressedTextures?.loader;

    await Promise.all([assets.texture("rock.png"), assets.model("b.glb")]);

    expect(setKtx2Spy).toHaveBeenCalledTimes(1);
    expect(setKtx2Spy.mock.calls[0]?.[0]).toBe(shared);
    expect(detectSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * `KHR_mesh_quantization` positions are normalized int16: every component means a value in
   * [-1, 1], and `BufferAttribute.setXYZ` re-normalizes with a **clamp**. So every three.js
   * geometry helper that writes back — `applyMatrix4`, `translate`, `scale`, `rotateY`, `center` —
   * silently flattens a quantized mesh onto the unit cube. Wildwood lost 99.7% of a pine's canopy
   * to exactly this, with zero errors, so the loader must widen positions before a game sees them.
   */
  const quantizedModel = (interleaved: boolean): { scene: Group } => {
    // A unit cube in quantized space; the node scale carries the real 5 m size.
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, 1],
    ].flat();
    const raw = Int16Array.from(corners.map((value) => value * 32_767));
    const geometry = new BufferGeometry();
    if (interleaved) {
      geometry.setAttribute(
        "position",
        new InterleavedBufferAttribute(new InterleavedBuffer(raw, 3), 3, 0, true),
      );
    } else {
      geometry.setAttribute("position", new BufferAttribute(raw, 3, true));
    }
    // A cooked application scalar in [0, 1] — the vegetation wind weight — as the cook writes it.
    const weights = Uint16Array.from([0, 32_768, 65_535]);
    geometry.setAttribute(
      "_wind",
      interleaved
        ? new InterleavedBufferAttribute(new InterleavedBuffer(weights, 1), 1, 0, true)
        : new BufferAttribute(weights, 1, true),
    );
    const scene = new Group();
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.scale.setScalar(5);
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    return { scene };
  };

  const loadQuantized = async (interleaved: boolean): Promise<{ scene: Group }> => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(
              JSON.stringify({
                asset: { version: "2.0" },
                extensionsUsed: ["KHR_mesh_quantization"],
              }),
            )
          : manifestResponse({
              version: 1,
              entries: {
                "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
              },
            }),
      ),
    );
    const model = quantizedModel(interleaved);
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)(model);
      return this;
    } as never);
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });
    return assets.model<{ scene: Group }>("b.glb");
  };

  it.each([
    ["a plain quantized attribute", false],
    ["a meshopt-interleaved quantized attribute", true],
  ])(
    "should widen %s so baking a node transform does not clamp the mesh",
    async (_name, interleaved) => {
      const loaded = await loadQuantized(interleaved as boolean);
      const mesh = loaded.scene.children[0] as Mesh;
      const position = mesh.geometry.getAttribute("position");

      expect(position.normalized).toBe(false);
      expect(position.array).toBeInstanceOf(Float32Array);

      // What the game does with an imported prop: bake the world matrix into a clone.
      const baked = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const bounds = new Box3().setFromBufferAttribute(
        baked.getAttribute("position") as BufferAttribute,
      );
      // The node scale is 5, so the baked cube must span 10 units — not the 2 units of the
      // quantization cube it collapses to when `setXYZ` clamps.
      expect(bounds.max.x - bounds.min.x).toBeCloseTo(10, 2);
      expect(bounds.max.y - bounds.min.y).toBeCloseTo(10, 2);
      expect(bounds.max.z - bounds.min.z).toBeCloseTo(10, 2);
    },
  );

  it.each([
    ["a plain normalized scalar", false],
    ["a meshopt-interleaved normalized scalar", true],
  ])("should widen %s, which WebGPU cannot fetch as a float", async (_name, interleaved) => {
    // three picks a one-component vertex format from the array type alone, so a normalized
    // uint16 stays `uint16` where a TSL float attribute expects a float and the pipeline fails.
    const loaded = await loadQuantized(interleaved as boolean);
    const weight = (loaded.scene.children[0] as Mesh).geometry.getAttribute("_wind");

    expect(weight.normalized).toBe(false);
    expect(weight.array).toBeInstanceOf(Float32Array);
    for (const [index, value] of [0, 32_768 / 65_535, 1].entries())
      expect(weight.getX(index)).toBeCloseTo(value, 6);
  });

  it("should leave a float model's positions untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(JSON.stringify({ asset: { version: "2.0" } }))
          : manifestResponse({
              version: 1,
              entries: {
                "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
              },
            }),
      ),
    );
    const scene = new Group();
    const source = new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
    scene.add(new Mesh(new BufferGeometry().setAttribute("position", source)));
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ scene });
      return this;
    } as never);
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });

    const loaded = await assets.model<{ scene: Group }>("b.glb");

    expect((loaded.scene.children[0] as Mesh).geometry.getAttribute("position")).toBe(source);
  });

  it("should tell a float model's position type without reading its array", async () => {
    // On the native back end each `.array` read copies the whole buffer out of the engine.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(JSON.stringify({ asset: { version: "2.0" } }))
          : manifestResponse({
              version: 1,
              entries: {
                "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
              },
            }),
      ),
    );
    const source = new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3);
    const array = source.array;
    let reads = 0;
    Object.defineProperty(source, "array", {
      get: () => {
        reads += 1;
        return array;
      },
    });
    const scene = new Group();
    scene.add(new Mesh(new BufferGeometry().setAttribute("position", source)));
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ scene });
      return this;
    } as never);
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });

    await assets.model<{ scene: Group }>("b.glb");

    expect(reads).toBe(0);
  });

  it("should not require KTX2 support for a model that does not declare Basis textures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(JSON.stringify({ asset: { version: "2.0" } }))
          : manifestResponse({
              version: 1,
              entries: {
                "b.glb": { output: "b.22222222.glb", kind: "model", bytes: 9, passes: [] },
              },
            }),
      ),
    );
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ url: "loaded.glb" });
      return this;
    } as never);
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer({}) });

    await expect(assets.model("b.glb")).resolves.toEqual({ url: "loaded.glb" });
  });

  it("should assign a manifest lightmap through the shared KTX2 loader", async () => {
    const geometry = new BufferGeometry().setAttribute(
      "uv1",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    );
    const material = new MeshStandardMaterial({ name: "stone" });
    const scene = new Group().add(new Mesh(geometry, material));
    const lightmap = new Texture();
    const dispose = vi.spyOn(lightmap, "dispose");
    vi.spyOn(KTX2Loader.prototype, "load").mockImplementation(
      (_url: string, onLoad: (data: CompressedTexture) => void) => {
        onLoad(lightmap as unknown as CompressedTexture);
        return undefined;
      },
    );
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ scene });
      return this;
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(JSON.stringify({ asset: { version: "2.0" } }))
          : manifestResponse({
              version: 1,
              entries: {
                "level.glb": {
                  lightmaps: [
                    {
                      materialTargets: ["stone"],
                      output: "level.lightmap.11111111.ktx2",
                      texCoord: 1,
                    },
                  ],
                  output: "level.22222222.glb",
                },
              },
            }),
      ),
    );
    const detect = vi.spyOn(KTX2Loader.prototype, "detectSupport");
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer(S3TC) });

    await assets.model("level.glb");

    expect(material.lightMap).toBe(lightmap);
    expect(lightmap.channel).toBe(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(assets.release("model", "level.glb")).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("should fail closed when manifest lightmap geometry has no UV2", async () => {
    const material = new MeshStandardMaterial({ name: "stone" });
    const scene = new Group().add(new Mesh(new BufferGeometry(), material));
    vi.spyOn(KTX2Loader.prototype, "load").mockImplementation(
      (_url: string, onLoad: (data: CompressedTexture) => void) => {
        onLoad(new Texture() as unknown as CompressedTexture);
        return undefined;
      },
    );
    vi.spyOn(GLTFLoader.prototype, "parse").mockImplementation(function (
      this: GLTFLoader,
      _data: ArrayBuffer,
      _path: string,
      onLoad: never,
    ) {
      (onLoad as (value: unknown) => void)({ scene });
      return this;
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith(".glb")
          ? new Response(JSON.stringify({ asset: { version: "2.0" } }))
          : manifestResponse({
              version: 1,
              entries: {
                "level.glb": {
                  lightmaps: [
                    {
                      materialTargets: ["stone"],
                      output: "level.lightmap.11111111.ktx2",
                      texCoord: 1,
                    },
                  ],
                  output: "level.22222222.glb",
                },
              },
            }),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets", renderer: webglRenderer(S3TC) });

    await expect(assets.model("level.glb")).rejects.toThrow("TN_ASSETS_LIGHTMAP_UV2_MISSING");
    expect(material.lightMap).toBeNull();
  });

  it("should fail closed when a manifest lightmap output is missing", async () => {
    const geometry = new BufferGeometry().setAttribute(
      "uv1",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    );
    const material = new MeshStandardMaterial({ name: "stone" });
    const scene = new Group().add(new Mesh(geometry, material));
    vi.spyOn(KTX2Loader.prototype, "load").mockImplementation(
      (
        _url: string,
        _onLoad: (data: CompressedTexture) => void,
        _onProgress: ((event: ProgressEvent<EventTarget>) => void) | undefined,
        onError: ((error: unknown) => void) | undefined,
      ) => {
        onError?.(new Error("404"));
        return undefined;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestResponse({
          version: 1,
          entries: {
            "level.glb": {
              lightmaps: [
                {
                  materialTargets: ["stone"],
                  output: "level.lightmap.missing.ktx2",
                  texCoord: 1,
                },
              ],
              output: "level.22222222.glb",
            },
          },
        }),
      ),
    );
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async () => ({ scene }),
      renderer: webglRenderer(S3TC),
    });

    await expect(assets.model("level.glb")).rejects.toThrow("TN_ASSETS_LIGHTMAP_MISSING");
    expect(material.lightMap).toBeNull();
  });
});

describe("IAssetLoader model decoders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * A genuinely meshopt-compressed `.glb` (quantized positions, required
   * EXT_meshopt_compression), built from the committed fixture generator minus its
   * textures so the parse runs in a bare-node environment.
   */
  async function compressedModelGlb(): Promise<ArrayBuffer> {
    const { EXTMeshoptCompression } = await import("@gltf-transform/extensions");
    const { MeshoptEncoder } = await import("meshoptimizer");
    const { NodeIO } = await import("@gltf-transform/core");
    const { buildFixtureDocument } = await import(
      "../../../test-support/generate-fixture-model.js"
    );
    const document = buildFixtureDocument({ textured: false });
    await MeshoptEncoder.ready;
    document
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    const binary = await new NodeIO()
      .registerExtensions([EXTMeshoptCompression])
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
      .writeBinary(document);
    return binary.buffer.slice(
      binary.byteOffset,
      binary.byteOffset + binary.byteLength,
    ) as ArrayBuffer;
  }

  /** Serves the model bytes verbatim; no manifest, so the raw-path fallback applies. */
  function serveModel(data: ArrayBuffer): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | RequestInfo) =>
        String(url).endsWith("assets.manifest.json")
          ? new Response("gone", { status: 404 })
          : new Response(new Uint8Array(data), { status: 200 }),
      ),
    );
  }

  it("should configure the meshopt decoder before loading a compressed model", async () => {
    const data = await compressedModelGlb();
    serveModel(data);
    const setDecoderSpy = vi.spyOn(GLTFLoader.prototype, "setMeshoptDecoder");
    const assets = createAssetLoader();

    const gltf = await assets.model<{ scene: unknown }>("character.glb");

    // The decoder was wired and the file really parsed through it: the scene graph exists.
    expect(setDecoderSpy).toHaveBeenCalledTimes(1);
    expect(gltf.scene).toBeDefined();
  });

  it("should fail a compressed model when the decoder wiring is removed", async () => {
    const data = await compressedModelGlb();
    serveModel(data);
    // Simulate the revert check: with the wiring gone the loader never receives a decoder,
    // and three's own loader refuses the compressed file by name.
    vi.spyOn(GLTFLoader.prototype, "setMeshoptDecoder").mockImplementation(
      (() => undefined) as unknown as () => GLTFLoader,
    );
    const assets = createAssetLoader();

    await expect(assets.model("character.glb")).rejects.toThrow(
      /setMeshoptDecoder must be called/u,
    );
  });

  it("should wire the Draco decoder only when the model declares it", async () => {
    // A meshopt-only project must never construct a DRACOLoader.
    const data = await compressedModelGlb();
    serveModel(data);
    const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
    const dracoSpy = vi.spyOn(DRACOLoader.prototype, "setDecoderPath");
    const assets = createAssetLoader({ basePath: "/assets" });

    await assets.model("character.glb");

    expect(dracoSpy).not.toHaveBeenCalled();
  });

  it("should point the Draco decoder at the served draco directory when declared", async () => {
    // A payload whose header declares KHR_draco_mesh_compression but whose body is not a
    // valid Draco file: the wiring is observable before the (expected) decode failure.
    const header = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ componentType: 5126, count: 3, type: "VEC3" }],
        extensionsUsed: ["KHR_draco_mesh_compression"],
        extensionsRequired: ["KHR_draco_mesh_compression"],
      }),
      "utf8",
    );
    const chunkHeader = Buffer.alloc(8 + header.length + ((4 - (header.length % 4)) % 4));
    chunkHeader.writeUInt32LE(header.length, 0);
    chunkHeader.write("JSON", 4, "ascii");
    header.copy(chunkHeader, 8);
    const total = 12 + chunkHeader.length;
    const glb = Buffer.alloc(total);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(total, 8);
    chunkHeader.copy(glb, 12);
    serveModel(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));

    const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
    const dracoSpy = vi.spyOn(DRACOLoader.prototype, "setDecoderPath");
    const assets = createAssetLoader({ basePath: "/assets" });

    await expect(assets.model("legacy.glb")).rejects.toThrow();

    expect(dracoSpy).toHaveBeenCalledWith("/assets/draco/");
  });
});
