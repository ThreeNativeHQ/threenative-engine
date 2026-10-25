import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetCache, manifestFingerprint } from "../src/asset-cache.js";
import { FakeCacheStorage } from "./fixtures/fake-cache.js";

interface IGate {
  readonly promise: Promise<Response>;
  release(): void;
}

/** A fetch that records the order requests start and waits for the test to release each one. */
function gatedFetch(): {
  fetch: (url: string) => Promise<Response>;
  order: string[];
  gates: Map<string, IGate>;
} {
  const order: string[] = [];
  const gates = new Map<string, IGate>();
  const fetch = (url: string): Promise<Response> => {
    order.push(url);
    let release = (): void => undefined;
    const promise = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(new Uint8Array([1])));
    });
    gates.set(url, { promise, release });
    return promise;
  };
  return { fetch, gates, order };
}

function stub(): FakeCacheStorage {
  const storage = new FakeCacheStorage();
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("navigator", { connection: { saveData: false }, storage: {} });
  return storage;
}

describe("asset fetch priority", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should start now, then soon, then idle", async () => {
    stub();
    const gated = gatedFetch();
    vi.stubGlobal("fetch", gated.fetch);
    const cache = createAssetCache({ concurrency: 1, retryDelaysMs: [0] });

    const idle = cache.fetchBytes("idle", "idle");
    const soon = cache.fetchBytes("soon", "soon");
    const now = cache.fetchBytes("now", "now");

    // The idle request is in flight, and the awaited one starts beside it at once. The soon
    // request waits for both to clear.
    expect(gated.order).toEqual(["idle", "now"]);
    gated.gates.get("idle")?.release();
    gated.gates.get("now")?.release();
    await vi.waitFor(() => expect(gated.order).toEqual(["idle", "now", "soon"]));
    gated.gates.get("soon")?.release();

    await Promise.all([idle, soon, now]);
  });

  it("should start a now request at once and hold new idle starts until it settles", async () => {
    stub();
    const gated = gatedFetch();
    vi.stubGlobal("fetch", gated.fetch);
    const cache = createAssetCache({ concurrency: 1, retryDelaysMs: [0] });

    const first = cache.fetchBytes("idle-a", "idle");
    expect(gated.order).toEqual(["idle-a"]);
    const second = cache.fetchBytes("idle-b", "idle");
    const urgent = cache.fetchBytes("urgent", "now");

    // The fill's lane is busy with a large idle file; the awaited file starts beside it rather
    // than waiting for that download, which is what bounds its latency.
    await vi.waitFor(() => expect(gated.order).toEqual(["idle-a", "urgent"]));
    // While `urgent` runs, the second idle still may not start.
    expect(gated.order).not.toContain("idle-b");
    gated.gates.get("urgent")?.release();
    gated.gates.get("idle-a")?.release();
    await vi.waitFor(() => expect(gated.order).toContain("idle-b"));
    gated.gates.get("idle-b")?.release();

    await Promise.all([first, second, urgent]);
  });

  it("should start a queued request the moment it is promoted to now", async () => {
    stub();
    const gated = gatedFetch();
    vi.stubGlobal("fetch", gated.fetch);
    const cache = createAssetCache({ concurrency: 1, retryDelaysMs: [0] });

    const idle = cache.fetchBytes("idle-promote", "idle");
    const soon = cache.fetchBytes("target-promote", "soon");
    const now = cache.fetchBytes("target-promote", "now");

    await vi.waitFor(() => expect(gated.order).toEqual(["idle-promote", "target-promote"]));
    gated.gates.get("idle-promote")?.release();
    gated.gates.get("target-promote")?.release();
    await Promise.all([idle, soon, now]);
  });

  it("should stop the fill when the cache is cleared", async () => {
    stub();
    const gated = gatedFetch();
    vi.stubGlobal("fetch", gated.fetch);
    const entries = [
      { bytes: 1, url: "clear-a" },
      { bytes: 1, url: "clear-b" },
    ];
    const cache = createAssetCache({ concurrency: 1, retryDelaysMs: [0] });
    cache.setManifest(manifestFingerprint(entries), entries);
    const fill = cache.startFill();
    await vi.waitFor(() => expect(gated.order).toEqual(["clear-a"]));

    await cache.clear();
    gated.gates.get("clear-a")?.release();
    await fill;

    expect(gated.order).toEqual(["clear-a"]);
    expect(cache.report.filling).toBe(false);
  });

  it("should let a now request overtake the background fill", async () => {
    stub();
    const gated = gatedFetch();
    vi.stubGlobal("fetch", gated.fetch);
    const entries = [
      { bytes: 1, url: "fill-a" },
      { bytes: 1, url: "fill-b" },
    ];
    const cache = createAssetCache({ concurrency: 1, retryDelaysMs: [0] });
    cache.setManifest(manifestFingerprint(entries), entries);
    cache.startFill();

    await vi.waitFor(() => expect(gated.order).toEqual(["fill-a"]));
    expect(cache.report.filling).toBe(true);
    const urgent = cache.fetchBytes("urgent-now", "now");
    gated.gates.get("fill-a")?.release();

    await vi.waitFor(() => expect(gated.order).toEqual(["fill-a", "urgent-now"]));
    gated.gates.get("urgent-now")?.release();
    await vi.waitFor(() => expect(gated.order).toEqual(["fill-a", "urgent-now", "fill-b"]));
    gated.gates.get("fill-b")?.release();

    await urgent;
    await vi.waitFor(() => expect(cache.report.filling).toBe(false));
  });
});
