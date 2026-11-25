/**
 * AC-1: with no host, no `fetch` and no `localStorage`, every call resolves and the game keeps
 * running. The same spec proves host detection (the marker header, an SPA fallback, a network
 * error) and that concurrent first-load calls share one bootstrap request.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BackendError, createBackend } from "../src/client.js";
import { MARKER_HEADER, MARKER_VALUE } from "../src/protocol.js";
import { MemoryStorage } from "./support.js";

const ENDPOINT = "https://share.test/_backend";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The whole AC-1 sweep: every documented call, on a client that has nothing to talk to. */
async function expectEveryCallResolves(
  options: Parameters<typeof createBackend>[0],
): Promise<void> {
  const backend = createBackend(options);
  const collection = backend.db.collection("leaderboard");

  await expect(backend.db.get("save")).resolves.toBeUndefined();
  await expect(backend.db.set("save", { level: 2 })).resolves.toBe(1);
  await expect(backend.db.list()).resolves.toEqual([]);
  await expect(backend.db.delete("save")).resolves.toBeUndefined();

  await expect(collection.get("a")).resolves.toBeUndefined();
  await expect(collection.put("a", { score: 3 }, "public")).resolves.toBe(1);
  await expect(collection.list()).resolves.toEqual([]);
  await expect(collection.delete("a")).resolves.toBeUndefined();
}

describe("createBackend without a host", () => {
  it("resolves every db and collection call with no fetch and no storage", async () => {
    Reflect.deleteProperty(globalThis, "fetch");
    await expectEveryCallResolves({ storage: null });
  });

  it("resolves every call when there is no storage to write to", async () => {
    await expectEveryCallResolves({ fetch: async () => new Response("null"), storage: null });
  });

  it("treats a SPA fallback HTML 200 as no host", async () => {
    const calls: string[] = [];
    await expectEveryCallResolves({
      endpoint: ENDPOINT,
      storage: null,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("<!doctype html><title>app</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    // Only the single host probe reached the network: no route ran without the marker.
    expect(calls).toEqual([`${ENDPOINT}/v1/db`]);
  });

  it("treats a network error as no host", async () => {
    const backend = createBackend({
      endpoint: ENDPOINT,
      storage: null,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(backend.db.list()).resolves.toEqual([]);
    await expect(backend.db.set("save", 1)).resolves.toBe(1);
  });

  it("keeps a local value readable when the host never answers", async () => {
    const backend = createBackend({
      endpoint: ENDPOINT,
      storage: new MemoryStorage(),
      fetch: async () => new Response(""),
    });
    await backend.db.set("save", { level: 4 });
    await expect(backend.db.get("save")).resolves.toEqual({ level: 4 });
    expect(await backend.db.list()).toEqual([{ key: "save", value: { level: 4 }, version: 1 }]);
  });
});

describe("createBackend host detection", () => {
  it("shares one bootstrap request across N concurrent first-load calls", async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = createBackend({
      endpoint: ENDPOINT,
      storage: new MemoryStorage(),
      fetch: async (input) => {
        calls.push(String(input));
        await gate;
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { [MARKER_HEADER]: MARKER_VALUE, "content-type": "application/json" },
        });
      },
    });

    const pending = Promise.all([
      backend.db.get("save"),
      backend.db.collection("board").list(),
      backend.db.get("other"),
    ]);
    // One shared probe is in flight; nothing else has been asked of the host yet.
    expect(calls).toEqual([`${ENDPOINT}/v1/db`]);
    release();
    await pending;

    expect(calls.filter((call) => call === `${ENDPOINT}/v1/db`)).toHaveLength(1);
  });
});

describe("createBackend key validation", () => {
  it("rejects an invalid key before touching the network", async () => {
    const calls: string[] = [];
    const backend = createBackend({
      endpoint: ENDPOINT,
      storage: null,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { [MARKER_HEADER]: MARKER_VALUE },
        });
      },
    });
    await expect(backend.db.set("has space", 1)).rejects.toBeInstanceOf(BackendError);
    await expect(backend.db.get("x".repeat(129))).rejects.toMatchObject({ code: "invalid_key" });
    // A synchronous factory rejects a bad literal the moment a game asks for it.
    expect(() => backend.db.collection("bad name")).toThrow(BackendError);
    expect(calls).toEqual([]);
  });
});
