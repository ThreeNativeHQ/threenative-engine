import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssetMemo, decodeMemo, encodeMemo } from "../src/asset-memo.js";
import { FakeCacheStorage } from "./fixtures/fake-cache.js";

const scope = globalThis as { caches?: unknown; __TN_BUILD_ID__?: unknown };

describe("ctx.assets.memo (PRD-860)", () => {
  let storage: FakeCacheStorage;
  beforeEach(() => {
    storage = new FakeCacheStorage();
    scope.caches = storage;
    scope.__TN_BUILD_ID__ = "/assets/index-AAAA.js";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    Reflect.deleteProperty(scope, "caches");
    Reflect.deleteProperty(scope, "__TN_BUILD_ID__");
    vi.restoreAllMocks();
  });

  it("builds once, then a later run of the same build reads the stored arrays back", async () => {
    const build = vi.fn(() => ({
      pixels: new Uint8Array([1, 2, 3]),
      at: new Float32Array([0.5, -2]),
    }));
    const first = await createAssetMemo("game")("sky", build);
    await vi.waitFor(async () =>
      expect((await storage.open([...storage.caches.keys()][0] ?? "")).store.size).toBe(1),
    );
    const second = await createAssetMemo("game")("sky", build);
    expect(build).toHaveBeenCalledTimes(1);
    expect([...second.pixels]).toEqual([...first.pixels]);
    expect(second.at).toBeInstanceOf(Float32Array);
    expect([...second.at]).toEqual([0.5, -2]);
  });

  it("rebuilds after a new build and deletes the old build's entries", async () => {
    const build = vi.fn(() => ({ v: new Uint16Array([7]) }));
    await createAssetMemo("game")("k", build);
    await vi.waitFor(() => expect(storage.caches.size).toBe(1));
    scope.__TN_BUILD_ID__ = "/assets/index-BBBB.js";
    await createAssetMemo("game")("k", build);
    expect(build).toHaveBeenCalledTimes(2);
    const cache = [...storage.caches.values()][0];
    await vi.waitFor(async () => {
      const urls = (await cache?.keys())?.map((request) => request.url) ?? [];
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain(encodeURIComponent("/assets/index-BBBB.js"));
    });
  });

  it("builds every run, and says why, with no build id or no cache storage", async () => {
    Reflect.deleteProperty(scope, "__TN_BUILD_ID__");
    const build = vi.fn(() => ({ v: new Int32Array([1]) }));
    await createAssetMemo("game")("k", build);
    await createAssetMemo("game")("k", build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(storage.caches.size).toBe(0);
    expect(String(vi.mocked(console.info).mock.calls.at(-1)?.[0])).toContain(
      '"reason":"no build id',
    );
  });

  it("takes a build typed by an interface, the shape a generator module exports", async () => {
    interface IPainted {
      readonly sky: Float32Array;
      readonly mask: Uint8Array;
    }
    const paint = (): IPainted => ({ mask: new Uint8Array([1]), sky: new Float32Array([0.5]) });
    const painted: IPainted = await createAssetMemo("game")("painted", paint);
    expect([...painted.mask]).toEqual([1]);
  });

  it("rebuilds over a corrupt entry instead of failing the load", async () => {
    const build = vi.fn(() => ({ v: new Float64Array([3]) }));
    const memo = createAssetMemo("game");
    await memo("k", build);
    const cache = [...storage.caches.values()][0];
    await vi.waitFor(async () => expect((await cache?.keys())?.length).toBe(1));
    const url = (await cache?.keys())?.[0]?.url ?? "";
    await cache?.put(url, new Response(new Uint8Array([9, 9])));
    const again = await createAssetMemo("game")("k", build);
    expect(build).toHaveBeenCalledTimes(2);
    expect([...again.v]).toEqual([3]);
  });

  it("rejects a key or a value it cannot store", async () => {
    const memo = createAssetMemo("game");
    await expect(memo("", () => ({ v: new Uint8Array(1) }))).rejects.toThrow(
      "TN_ASSET_MEMO_INVALID",
    );
    await expect(memo("k", () => ({ v: [1, 2] as unknown as Uint8Array }))).rejects.toThrow(
      "TN_ASSET_MEMO_INVALID",
    );
  });

  it("round-trips every typed array kind with its exact values", () => {
    const value = {
      a: new Float32Array([1.5]),
      b: new Float64Array([Math.PI]),
      c: new Int8Array([-3]),
      d: new Int16Array([-300]),
      e: new Int32Array([-70000]),
      f: new Uint8Array([250]),
      g: new Uint8ClampedArray([255]),
      h: new Uint16Array([65000]),
      i: new Uint32Array([4000000000]),
      empty: new Float32Array(0),
    };
    const decoded = decodeMemo(encodeMemo(value));
    for (const [name, array] of Object.entries(value)) {
      expect(decoded[name]?.constructor).toBe(array.constructor);
      expect([...(decoded[name] ?? [])]).toEqual([...array]);
    }
  });
});
