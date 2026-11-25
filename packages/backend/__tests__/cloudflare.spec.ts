/**
 * The client run against the real handler on a real D1 (Miniflare's workerd), with the package's
 * own migration applied: AC-2 plus the owner, scope, limit and cleanup rules the wire contract
 * promises.
 */
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBackend } from "../src/client.js";
import { deleteGameData, handleBackend } from "../src/cloudflare.js";
import { DOC_MAX, KEYS_MAX, MARKER_HEADER, MARKER_VALUE, VALUE_MAX } from "../src/protocol.js";
import { MemoryStorage } from "./support.js";

const ENDPOINT = "https://share.test/_backend";
const GAME = "project-1";

/** The real D1 the handler is pointed at: no stand-in, no `@cloudflare/workers-types` global. */
type D1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let miniflare: Miniflare;
let db: D1;

beforeAll(async () => {
  miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "backend",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch: () => new Response('ok') }",
              },
            },
          },
          env: { DB: { type: "d1", id: "backend" } },
        },
      },
    ],
  });
  db = await miniflare.getD1Database("DB", "backend");
  const migration = await readFile(
    new URL("../migrations/0001_backend.sql", import.meta.url),
    "utf8",
  );
  // `wrangler d1 migrations apply` runs the whole file; here each statement runs on its own, so
  // the comments come off first.
  for (const statement of migration.replace(/^--.*$/gmu, "").split(";")) {
    const sql = statement.trim();
    if (sql.length > 0) await db.prepare(sql).run();
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM kv"), db.prepare("DELETE FROM docs")]);
});

/** A client whose network is the handler, free of any real socket. */
function clientFor(playerId: string, gameId = GAME) {
  return createBackend({
    endpoint: ENDPOINT,
    storage: new MemoryStorage(),
    fetch: (input, init) => handleBackend(new Request(input, init), { db, gameId, playerId }),
  });
}

/** The same client with a switch that cuts the network mid-session, so a write stays local. */
function flakyClientFor(playerId: string) {
  const state = { offline: false };
  const backend = createBackend({
    endpoint: ENDPOINT,
    storage: new MemoryStorage(),
    fetch: (input, init) => {
      if (state.offline) throw new TypeError("Failed to fetch");
      return handleBackend(new Request(input, init), { db, gameId: GAME, playerId });
    },
  });
  return { backend, state };
}

function send(path: string, playerId: string, init?: RequestInit): Promise<Response> {
  return handleBackend(new Request(`${ENDPOINT}${path}`, init), {
    db,
    gameId: GAME,
    playerId,
  });
}

async function count(table: "kv" | "docs", gameId = GAME): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE game_id = ?`)
    .bind(gameId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("two clients, one key (AC-2)", () => {
  it("rejects the stale write with the newer copy and keeps the newer value", async () => {
    const first = clientFor("player-1");
    const stale = clientFor("player-1");

    await expect(first.db.set("save", { hp: 1 })).resolves.toBe(1);
    await expect(first.db.set("save", { hp: 2 })).resolves.toBe(2);

    const conflict = await stale.db.set("save", { hp: 99 }).catch((error: unknown) => error);
    expect(conflict).toMatchObject({ code: "version_conflict", value: { hp: 2 }, version: 2 });

    const stored = await db
      .prepare("SELECT value, version FROM kv WHERE game_id = ? AND player_id = ? AND key = ?")
      .bind(GAME, "player-1", "save")
      .first<{ value: string; version: number }>();
    expect(stored).toEqual({ value: JSON.stringify({ hp: 2 }), version: 2 });

    // The rejected client settled on the server copy, so its next write is accepted.
    await expect(stale.db.set("save", { hp: 3 })).resolves.toBe(3);
    await expect(first.db.set("save", { hp: 4 })).rejects.toMatchObject({
      code: "version_conflict",
      version: 3,
    });
  });
});

describe("a write the host never took", () => {
  it("keeps the key's last confirmed version so the next write is not rejected as stale", async () => {
    const { backend, state } = flakyClientFor("player-1");
    await expect(backend.db.set("save", 1)).resolves.toBe(1);

    state.offline = true;
    await expect(backend.db.set("save", 2)).resolves.toBe(1);
    await expect(backend.db.get("save")).resolves.toBe(2);

    state.offline = false;
    await expect(backend.db.set("save", 3)).resolves.toBe(2);
    const stored = await db
      .prepare("SELECT value, version FROM kv WHERE game_id = ? AND player_id = ? AND key = ?")
      .bind(GAME, "player-1", "save")
      .first<{ value: string; version: number }>();
    expect(stored).toEqual({ value: "3", version: 2 });
  });

  it("keeps a document's last confirmed version the same way", async () => {
    const { backend, state } = flakyClientFor("player-1");
    const board = () => backend.db.collection("board");
    await expect(board().put("level", { n: 1 }, "public")).resolves.toBe(1);

    state.offline = true;
    await expect(board().put("level", { n: 2 }, "public")).resolves.toBe(1);
    await expect(board().get("level")).resolves.toMatchObject({ data: { n: 2 }, version: 1 });

    state.offline = false;
    await expect(board().put("level", { n: 3 }, "public")).resolves.toBe(2);
    const stored = await db
      .prepare("SELECT data, version FROM docs WHERE game_id = ? AND collection = ? AND doc_id = ?")
      .bind(GAME, "board", "level")
      .first<{ data: string; version: number }>();
    expect(stored).toEqual({ data: JSON.stringify({ n: 3 }), version: 2 });
  });
});

describe("collections across two players", () => {
  it("keeps a private document to its owner and shares a public one without leaking identity", async () => {
    const alice = clientFor("player-a");
    const bob = clientFor("player-b");

    await alice.db.collection("board").put("secret", { score: 1 }, "private");
    await alice.db.collection("board").put("public", { score: 2 }, "public");

    expect(await bob.db.collection("board").get("secret")).toBeUndefined();
    await expect(bob.db.collection("board").get("public")).resolves.toMatchObject({
      id: "public",
      data: { score: 2 },
      scope: "public",
      isOwner: false,
    });

    const listed = await bob.db.collection("board").list();
    expect(listed.map((item) => item.id)).toEqual(["public"]);

    // Owner-only writes: the public document is readable, never rewritable, never deletable.
    await expect(
      bob.db.collection("board").put("public", { score: 9 }, "public"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(bob.db.collection("board").delete("public")).rejects.toMatchObject({
      code: "forbidden",
    });

    // Nothing on the wire names another player.
    const response = await send("/v1/collections/board", "player-b");
    expect(await response.text()).not.toContain("player-a");

    await alice.db.collection("board").put("secret", { score: 5 }, "private");
    await expect(alice.db.collection("board").get("secret")).resolves.toMatchObject({
      data: { score: 5 },
      version: 2,
      isOwner: true,
    });
  });

  it("deletes a document only for its owner", async () => {
    const alice = clientFor("player-a");
    await alice.db.collection("board").put("public", { score: 2 }, "public");
    await alice.db.collection("board").delete("public");
    await expect(
      clientFor("player-b").db.collection("board").get("public"),
    ).resolves.toBeUndefined();
    expect(await count("docs")).toBe(0);
  });
});

describe("limits and validation", () => {
  it("returns 413 for an over-limit write and stores no row", async () => {
    const backend = clientFor("player-1");

    await expect(backend.db.set("huge", "x".repeat(VALUE_MAX))).rejects.toMatchObject({
      code: "too_large",
    });
    expect(await count("kv")).toBe(0);

    await expect(
      backend.db.collection("board").put("huge", "x".repeat(DOC_MAX), "private"),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(await count("docs")).toBe(0);
  });

  it("returns 413 for a new key past the per-player cap", async () => {
    await db.batch(
      Array.from({ length: KEYS_MAX }, (_, index) =>
        db
          .prepare(
            "INSERT INTO kv (game_id, player_id, key, value, size, version, updated_at) VALUES (?, ?, ?, 'null', 4, 1, 0)",
          )
          .bind(GAME, "player-1", `key-${index}`),
      ),
    );

    await expect(clientFor("player-1").db.set("one-too-many", 1)).rejects.toMatchObject({
      code: "too_large",
    });
    expect(await count("kv")).toBe(KEYS_MAX);

    // An existing key is still updatable: the cap is on new keys, not on writes, and a read
    // hydrates the version the write then carries.
    const known = clientFor("player-1");
    await expect(known.db.get("key-0")).resolves.toBeNull();
    await expect(known.db.set("key-0", 2)).resolves.toBe(2);
  });

  it("returns 400 invalid_key before touching D1", async () => {
    const bad = await send("/v1/db/bad%20key", "player-1");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_key" });

    const long = await send(`/v1/db/${"a".repeat(129)}`, "player-1");
    expect(long.status).toBe(400);
    expect(await count("kv")).toBe(0);
  });

  it("marks every response, including an unknown route", async () => {
    const responses = [
      await send("/v1/db", "player-1"),
      await send("/v1/nope", "player-1"),
      await send("/v1/db/bad%20key", "player-1"),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 404, 400]);
    for (const response of responses) {
      expect(response.headers.get(MARKER_HEADER)).toBe(MARKER_VALUE);
    }
  });
});

describe("deleteGameData", () => {
  it("wipes one game's keys and documents and leaves the others alone", async () => {
    await clientFor("player-1", "game-1").db.set("save", 1);
    await clientFor("player-1", "game-1").db.collection("board").put("a", 1, "public");
    await clientFor("player-1", "game-2").db.set("save", 2);
    await clientFor("player-1", "game-2").db.collection("board").put("a", 2, "public");

    await deleteGameData(db, "game-1");

    expect(await count("kv", "game-1")).toBe(0);
    expect(await count("docs", "game-1")).toBe(0);
    expect(await count("kv", "game-2")).toBe(1);
    expect(await count("docs", "game-2")).toBe(1);
  });
});
