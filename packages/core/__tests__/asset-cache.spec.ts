import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetCache } from "../src/asset-cache.js";
import { createAssetLoader } from "../src/assets.js";
import { FakeCacheStorage, fakeKey, seedEntry } from "./fixtures/fake-cache.js";

function stubStorage(
  quotaBytes?: number,
  extra: { failPuts?: number; openError?: boolean } = {},
): FakeCacheStorage {
  const storage = new FakeCacheStorage({ quotaBytes, ...extra });
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("navigator", {
    connection: { saveData: false },
    storage: {
      estimate: async () => (quotaBytes === undefined ? {} : { quota: quotaBytes, usage: 0 }),
      persist: async () => true,
    },
  });
  return storage;
}

describe("asset cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should serve a second request from disk without touching the network", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "a.aaaa.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(entries);

    await cache.fetchBytes("a.aaaa.bin", "now", 4);
    const second = await cache.fetchBytes("a.aaaa.bin", "now", 4);

    expect(new Uint8Array(second)).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.report).toMatchObject({ bytesOnDisk: 4, hits: 1, misses: 1, persisted: true });
  });

  it("should never write a body shorter than the manifest size", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(2)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "short.bbbb.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(entries);

    await expect(cache.fetchBytes("short.bbbb.bin", "now", 4)).rejects.toThrow(
      "incomplete download (2 of 4 bytes)",
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cache.report.bytesOnDisk).toBe(0);
  });

  it("should retry a failed fetch and resolve on the next attempt", async () => {
    stubStorage();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(new Uint8Array(4));
    });
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "retry.cccc.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(entries);

    await expect(cache.fetchBytes("retry.cccc.bin", "now", 4)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should reject after three retries and name the url and last status", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response("gone", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "dead.dddd.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(entries);

    await expect(cache.fetchBytes("dead.dddd.bin", "now", 4)).rejects.toThrow("status 503");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("should not retry a 404, so the next candidate url starts at once", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "missing.jjjj.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(entries);

    await expect(cache.fetchBytes("missing.jjjj.bin", "now", 4)).rejects.toThrow("status 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should still load from the network when the cache cannot be opened", async () => {
    stubStorage(undefined, { openError: true });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "blocked.kkkk.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(entries);

    await expect(cache.fetchBytes("blocked.kkkk.bin", "now", 4)).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should evict an earlier session's entry on a quota error and retry once", async () => {
    const storage = stubStorage(100, { failPuts: 1 });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(50)));
    const entries = [
      { bytes: 80, url: "old.eeee.bin" },
      { bytes: 50, url: "new.ffff.bin" },
    ];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open("threenative-assets");
    seedEntry(disk, "old.eeee.bin", 80);
    cache.setManifest(entries);
    await vi.waitFor(() => expect(cache.report.bytesOnDisk).toBe(80));

    await cache.fetchBytes("new.ffff.bin", "now", 50);
    // A `now` caller gets its bytes before the disk write lands.
    await vi.waitFor(() => expect(disk.store.has(fakeKey("new.ffff.bin"))).toBe(true));

    expect(disk.store.has(fakeKey("old.eeee.bin"))).toBe(false);
    expect(disk.store.has(fakeKey("new.ffff.bin"))).toBe(true);
  });

  it("should drop a truncated cache entry and fetch the file again", async () => {
    const storage = stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "broken.hhhh.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open("threenative-assets");
    seedEntry(disk, "broken.hhhh.bin", 2);
    cache.setManifest(entries);

    const bytes = await cache.fetchBytes("broken.hhhh.bin", "now", 4);

    expect(new Uint8Array(bytes)).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.report).toMatchObject({ hits: 0, misses: 1 });
  });

  it("should free the whole cache on clear()", async () => {
    const storage = stubStorage();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(4)));
    const entries = [{ bytes: 4, url: "clear.iiii.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(entries);
    await cache.fetchBytes("clear.iiii.bin", "now", 4);
    expect(storage.caches.size).toBe(1);

    await cache.clear();

    expect(storage.caches.size).toBe(0);
    expect(cache.report.bytesOnDisk).toBe(0);
  });

  it("should stay off on a native host and name the reason", () => {
    // The native host installs no `caches` global; the loader must not invent one.
    vi.stubGlobal("caches", undefined);
    vi.stubGlobal("__THREENATIVE_NATIVE__", {
      platform: { formFactor: "desktop", maxTouchPoints: 0, os: "linux", runtime: "native" },
    });
    const cache = createAssetCache();

    expect(cache.enabled).toBe(false);
    expect(cache.report).toMatchObject({
      enabled: false,
      reason: "native host reads installed files",
    });
  });

  it("should serve any GET from disk, including a loader the framework does not wrap", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "shared.aaaa.ktx2" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(entries);
    await cache.fetchBytes("shared.aaaa.ktx2", "now", 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const viaLoader = await fetch("shared.aaaa.ktx2");

    expect(new Uint8Array(await viaLoader.arrayBuffer())).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("should match a Request url to the cache key a string put produced", async () => {
    stubStorage();
    vi.stubGlobal("location", { href: "http://localhost/app/" });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "shared.bbbb.ktx2" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(entries);
    await cache.fetchBytes("shared.bbbb.ktx2", "now", 4);

    const viaLoader = await fetch(new Request("http://localhost/app/shared.bbbb.ktx2"));

    expect(new Uint8Array(await viaLoader.arrayBuffer())).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("should evict the least recently accessed entry, not the first inserted", async () => {
    const storage = stubStorage(100);
    vi.stubGlobal("navigator", {
      connection: { saveData: false },
      storage: {
        estimate: async () => ({ quota: 100, usage: 80 }),
        persist: async () => true,
      },
    });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(50)));
    const entries = [
      { bytes: 40, url: "first-inserted.llll.bin" },
      { bytes: 40, url: "second-inserted.mmmm.bin" },
      { bytes: 50, url: "fresh.nnnn.bin" },
    ];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open("threenative-assets");
    // The first entry was accessed most recently, so insertion order and access order disagree.
    seedEntry(disk, "first-inserted.llll.bin", 40, 2);
    seedEntry(disk, "second-inserted.mmmm.bin", 40, 1);
    cache.setManifest(entries);
    await vi.waitFor(() => expect(cache.report.bytesOnDisk).toBe(80));

    await cache.fetchBytes("fresh.nnnn.bin", "now", 50);
    // A `now` caller gets its bytes before the disk write lands.
    await vi.waitFor(() => expect(disk.store.has(fakeKey("fresh.nnnn.bin"))).toBe(true));

    expect(disk.store.has(fakeKey("first-inserted.llll.bin"))).toBe(true);
    expect(disk.store.has(fakeKey("second-inserted.mmmm.bin"))).toBe(false);
    expect(disk.store.has(fakeKey("fresh.nnnn.bin"))).toBe(true);
  });

  it("should not evict an entry this session read", async () => {
    const storage = stubStorage(100);
    vi.stubGlobal("navigator", {
      connection: { saveData: false },
      storage: {
        estimate: async () => ({ quota: 100, usage: 80 }),
        persist: async () => true,
      },
    });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(50)));
    const entries = [
      { bytes: 40, url: "read-now.oooo.bin" },
      { bytes: 40, url: "untouched.pppp.bin" },
      { bytes: 50, url: "fresh.qqqq.bin" },
    ];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open("threenative-assets");
    // The one this session reads has the oldest access stamp; it still must not be evicted.
    seedEntry(disk, "read-now.oooo.bin", 40, 1);
    seedEntry(disk, "untouched.pppp.bin", 40, 2);
    cache.setManifest(entries);
    await vi.waitFor(() => expect(cache.report.bytesOnDisk).toBe(80));
    await cache.fetchBytes("read-now.oooo.bin", "now", 40);

    await cache.fetchBytes("fresh.qqqq.bin", "now", 50);
    // A `now` caller gets its bytes before the disk write lands.
    await vi.waitFor(() => expect(disk.store.has(fakeKey("fresh.qqqq.bin"))).toBe(true));

    expect(disk.store.has(fakeKey("read-now.oooo.bin"))).toBe(true);
    expect(disk.store.has(fakeKey("untouched.pppp.bin"))).toBe(false);
    expect(disk.store.has(fakeKey("fresh.qqqq.bin"))).toBe(true);
  });

  it("should not download both candidates when there is no manifest to cache", async () => {
    stubStorage();
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("m.json")
        ? new Response("gone", { status: 404 })
        : new Response(new Uint8Array(4)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assets = createAssetLoader({ manifest: "m.json" });

    await expect(assets.prefetch(["rock.png"])).resolves.toMatchObject({ settled: 1 });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["m.json"]);
  });

  it("should release the fill gate when the manifest is malformed", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const assets = createAssetLoader({ manifest: "m.json" });

    await expect(assets.startBackgroundFill()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assets.cache.filling).toBe(false);
  });

  it("should keep another game's cache on the same origin", async () => {
    const storage = stubStorage();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(4)));
    const one = createAssetCache({ namespace: "/game-one|assets", retryDelaysMs: [0] });
    const entriesOne = [{ bytes: 4, url: "one.rrrr.bin" }];
    one.setManifest(entriesOne);
    await vi.waitFor(() => expect(storage.caches.size).toBe(1));
    const two = createAssetCache({ namespace: "/game-two|assets", retryDelaysMs: [0] });
    const entriesTwo = [{ bytes: 4, url: "two.ssss.bin" }];
    two.setManifest(entriesTwo);

    await vi.waitFor(() => expect(storage.caches.size).toBe(2));
    one.dispose();
    two.dispose();
  });

  it("should keep a file the next release still lists and drop only the files it removed", async () => {
    const storage = stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const first = [
      { bytes: 4, url: "kept.aaaa.bin" },
      { bytes: 4, url: "stale.bbbb.bin" },
    ];
    const one = createAssetCache({ retryDelaysMs: [0] });
    one.setManifest(first);
    await one.prefetch(first);
    one.dispose();
    const second = [
      { bytes: 4, url: "kept.aaaa.bin" },
      { bytes: 4, url: "fresh.cccc.bin" },
    ];
    const two = createAssetCache({ retryDelaysMs: [0] });
    two.setManifest(second);
    await vi.waitFor(() => expect(two.report.bytesOnDisk).toBe(4));

    await two.fetchBytes("kept.aaaa.bin", "now", 4);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.caches.size).toBe(1);
    const disk = [...storage.caches.values()][0];
    expect(disk?.store.has(fakeKey("stale.bbbb.bin"))).toBe(false);
    two.dispose();
  });

  it("should hand over the first file while the browser still asks about persistent storage", async () => {
    stubStorage();
    vi.stubGlobal("navigator", {
      connection: { saveData: false },
      // Firefox answers `persist()` only after the player answers its permission prompt.
      storage: { persist: () => new Promise<boolean>(() => undefined) },
    });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(4)));
    const entries = [{ bytes: 4, url: "first.dddd.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(entries);

    const bytes = await cache.fetchBytes("first.dddd.bin", "now", 4);

    expect(bytes.byteLength).toBe(4);
    cache.dispose();
  }, 1000);

  it("should send a GET outside the manifest to the network, never to disk", async () => {
    const storage = stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(2)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "model.cccc.glb" }];
    const cache = createAssetCache({ backgroundFill: false, retryDelaysMs: [0] });
    cache.setManifest(entries);
    await cache.startFill();
    const disk = [...storage.caches.values()][0];
    if (disk === undefined) throw new Error("the cache was not opened");
    seedEntry(disk, "api/scores", 9);

    const response = await fetch("api/scores");

    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("should honour assets.cache: false", () => {
    stubStorage();
    const cache = createAssetCache({ enabled: false });
    expect(cache.enabled).toBe(false);
    expect(cache.report.reason).toBe("assets.cache is false");
  });
});

describe("asset loader disk cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  const manifest = {
    entries: {
      "rock.png": { bytes: 4, kind: "texture", output: "rock.aaaa.png" },
      "tree.png": { bytes: 4, kind: "texture", output: "tree.bbbb.png" },
    },
    version: 1,
  };

  function assetFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL | RequestInfo) =>
      String(url).endsWith("m.json") ? Response.json(manifest) : new Response(new Uint8Array(4)),
    );
  }

  function stubBitmap(): void {
    vi.stubGlobal("Image", class {});
    vi.stubGlobal("createImageBitmap", async () => ({ height: 4, width: 4 }) as ImageBitmap);
  }

  it("should prefetch to disk, then load the texture with no network call", async () => {
    stubStorage();
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ manifest: "m.json" });

    const progress = await assets.prefetch(["rock.png"]);

    expect(progress).toMatchObject({ requestedBytes: 4, settled: 1, settledBytes: 4 });
    const before = fetchMock.mock.calls.length;
    await assets.texture("rock.png");
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(assets.cache).toMatchObject({ enabled: true, hits: 1, misses: 1 });
  });

  it("should not download a path the manifest does not list, since the disk could not keep it", async () => {
    stubStorage();
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    const assets = createAssetLoader({ manifest: "m.json" });

    const progress = await assets.prefetch(["unbaked.png"]);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["m.json"]);
    expect(progress).toMatchObject({ requested: 0, settled: 0 });
  });

  it("should fill the rest of the release after the reveal", async () => {
    stubStorage();
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ manifest: "m.json" });

    assets.startBackgroundFill();

    await vi.waitFor(() => expect(assets.cache.bytesOnDisk).toBe(8));
    expect(assets.cache).toMatchObject({ bytesTotal: 8, filling: false });
  });

  it("should not fill when the browser reports saveData", async () => {
    stubStorage();
    vi.stubGlobal("navigator", {
      connection: { saveData: true },
      storage: { persist: async () => true },
    });
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ manifest: "m.json" });

    await assets.startBackgroundFill();

    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requested).toEqual(["m.json"]);
    expect(assets.cache.bytesOnDisk).toBe(0);
    expect(assets.cache.backgroundFill).toBe(false);
  });

  it("should honour backgroundFill: false", async () => {
    stubStorage();
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ backgroundFill: false, manifest: "m.json" });

    await assets.startBackgroundFill();

    expect(assets.cache.bytesOnDisk).toBe(0);
    expect(assets.cache.backgroundFill).toBe(false);
  });

  it("should resolve prefetch at once on native, with no asset request", async () => {
    vi.stubGlobal("caches", undefined);
    vi.stubGlobal("__THREENATIVE_NATIVE__", {
      platform: { formFactor: "desktop", maxTouchPoints: 0, os: "linux", runtime: "native" },
    });
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ manifest: "m.json" });

    await expect(assets.prefetch(["rock.png"])).resolves.toMatchObject({ settled: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assets.cache).toMatchObject({
      enabled: false,
      reason: "native host reads installed files",
    });
  });
});
