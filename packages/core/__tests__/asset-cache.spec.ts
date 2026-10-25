import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetCache, manifestFingerprint } from "../src/asset-cache.js";
import { createAssetLoader } from "../src/assets.js";
import { FakeCacheStorage, seedEntry } from "./fixtures/fake-cache.js";

function stubStorage(quotaBytes?: number): FakeCacheStorage {
  const storage = new FakeCacheStorage({ quotaBytes });
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
    cache.setManifest(manifestFingerprint(entries), entries);

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
    cache.setManifest(manifestFingerprint(entries), entries);

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
    cache.setManifest(manifestFingerprint(entries), entries);

    await expect(cache.fetchBytes("retry.cccc.bin", "now", 4)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should reject after three retries and name the url and last status", async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => new Response("gone", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "dead.dddd.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0, 0, 0] });
    cache.setManifest(manifestFingerprint(entries), entries);

    await expect(cache.fetchBytes("dead.dddd.bin", "now", 4)).rejects.toThrow("status 503");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("should evict an earlier session's entry on a quota error and retry once", async () => {
    const storage = stubStorage(100);
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(50)));
    const entries = [
      { bytes: 80, url: "old.eeee.bin" },
      { bytes: 50, url: "new.ffff.bin" },
    ];
    const fingerprint = manifestFingerprint(entries);
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open(`threenative-assets-${fingerprint}`);
    seedEntry(disk, "old.eeee.bin", 80);
    cache.setManifest(fingerprint, entries);
    await vi.waitFor(() => expect(cache.report.bytesOnDisk).toBe(80));

    await cache.fetchBytes("new.ffff.bin", "now", 50);

    expect(disk.store.has("old.eeee.bin")).toBe(false);
    expect(disk.store.has("new.ffff.bin")).toBe(true);
  });

  it("should delete the previous release's cache when a new manifest names another one", async () => {
    const storage = stubStorage();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(4)));
    const old = await storage.open("threenative-assets-00000000");
    seedEntry(old, "stale.bin", 4);
    const entries = [{ bytes: 4, url: "fresh.gggg.bin" }];
    const cache = createAssetCache({ retryDelaysMs: [0] });
    cache.setManifest(manifestFingerprint(entries), entries);

    await vi.waitFor(() => expect(storage.caches.has("threenative-assets-00000000")).toBe(false));
    expect(cache.report.bytesTotal).toBe(4);
  });

  it("should drop a truncated cache entry and fetch the file again", async () => {
    const storage = stubStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4)));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ bytes: 4, url: "broken.hhhh.bin" }];
    const fingerprint = manifestFingerprint(entries);
    const cache = createAssetCache({ retryDelaysMs: [0] });
    const disk = await storage.open(`threenative-assets-${fingerprint}`);
    seedEntry(disk, "broken.hhhh.bin", 2);
    cache.setManifest(fingerprint, entries);

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
    cache.setManifest(manifestFingerprint(entries), entries);
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

    assets.startBackgroundFill();
    await assets.prefetch([]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(assets.cache.bytesOnDisk).toBe(0);
  });

  it("should honour backgroundFill: false", async () => {
    stubStorage();
    const fetchMock = assetFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubBitmap();
    const assets = createAssetLoader({ backgroundFill: false, manifest: "m.json" });

    assets.startBackgroundFill();
    await assets.prefetch([]);

    expect(assets.cache.bytesOnDisk).toBe(0);
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
