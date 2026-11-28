/**
 * Rooms on the real runtime: this client, `handleBackend` and `BackendRoom` in `workerd` (through
 * Miniflare), over a real D1 and a real WebSocket. Covers PRD-100 AC-1..AC-3 plus the forged-header
 * and unhosted rules the wire contract promises.
 */
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type IBackend, createBackend } from "../src/client.js";
import { type IBackendRoomsNamespace, deleteGameData, handleBackend } from "../src/cloudflare.js";
import { ROOM_FRAME_MAX, ROOM_RATE_MAX } from "../src/protocol.js";
import type { Room } from "../src/rooms.js";
import "./support.js";
import { workerModules } from "./worker.js";

const GAME = "project-1";
const PLAYER = "player-1";

type D1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let miniflare: Miniflare;
let db: D1;
/** The origin Miniflare serves the test Worker on: a real HTTP server, so real WebSockets. */
let base: string;

beforeAll(async () => {
  miniflare = new Miniflare({
    port: 0,
    workers: [
      {
        config: {
          name: "backend",
          compatibilityDate: "2026-11-01",
          manifest: { mainModule: "worker.js", modules: await workerModules() },
          env: {
            BACKEND_DB: { type: "d1", id: "backend" },
            ROOMS: { type: "durable-object", worker: "backend", exportName: "BackendRoom" },
          },
          // `new_sqlite_classes: ["BackendRoom"]`, as the host's migration declares it.
          exports: { BackendRoom: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  base = (await miniflare.ready).origin;
  db = await miniflare.getD1Database("BACKEND_DB", "backend");
  for (const name of ["0001_backend.sql", "0002_rooms.sql"]) {
    await applyMigration(name);
  }
});

afterAll(async () => {
  await miniflare?.dispose();
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM kv"),
    db.prepare("DELETE FROM docs"),
    db.prepare("DELETE FROM rooms"),
  ]);
});

/** `wrangler d1 migrations apply` runs a whole file; here each statement runs on its own. */
async function applyMigration(name: string): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of sql.replace(/^--.*$/gmu, "").split(";")) {
    if (statement.trim().length > 0) await db.prepare(statement.trim()).run();
  }
}

/** A client whose network and socket are the real host Miniflare started. */
function client(): IBackend {
  return createBackend({ endpoint: `${base}/_backend`, storage: null });
}

function rooms(): IBackend["rooms"] {
  return client().rooms;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(room: Room): Promise<{ data: unknown; from: string }> {
  return new Promise((resolve) => {
    const off = room.on("message", (data, from) => {
      off();
      resolve({ data, from });
    });
  });
}

function joined(room: Room): Promise<string> {
  return new Promise((resolve) => {
    const off = room.on("join", (peerId) => {
      off();
      resolve(peerId);
    });
  });
}

function left(room: Room): Promise<string> {
  return new Promise((resolve) => {
    const off = room.on("leave", (peerId) => {
      off();
      resolve(peerId);
    });
  });
}

function confirmed(room: Room, key: string, count = 1): Promise<void> {
  let remaining = count;
  return new Promise((resolve) => {
    const off = room.on("state", (written) => {
      if (written !== key || --remaining > 0) return;
      off();
      resolve();
    });
  });
}

/** One socket the runtime closed, with the code and reason it was closed with. */
function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });
}

/** A raw socket into a room: the limits are per socket, so they are tested below the client. */
async function rawSocket(code: string): Promise<WebSocket> {
  const socket = new WebSocket(`${base.replace(/^http/u, "ws")}/_backend/v1/rooms/${code}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("socket did not open")));
  });
  await new Promise<void>((resolve) => {
    const welcome = (event: MessageEvent) => {
      if ((JSON.parse(String(event.data)) as { t?: string }).t !== "welcome") return;
      socket.removeEventListener("message", welcome);
      resolve();
    };
    socket.addEventListener("message", welcome);
  });
  return socket;
}

describe("two clients in one room (AC-1)", () => {
  it("relays messages in send order and reports the join and the leave", async () => {
    const host = rooms();
    const a = await host.create();
    expect(a.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/u);

    // A hears about B before B's join resolves, so the listener goes in first.
    const ghost = joined(a);
    const b = await client().rooms.join(a.code);
    expect(await ghost).toBe(b.peerId);
    expect(b.peers).toEqual([a.peerId]);

    // 50 messages, paced under the 30/s budget the same socket is held to (AC-3).
    const received: unknown[] = [];
    const senders: string[] = [];
    const all = new Promise<void>((resolve) => {
      const off = b.on("message", (data, from) => {
        received.push(data);
        senders.push(from);
        if (received.length === 50) {
          off();
          resolve();
        }
      });
    });
    for (let index = 0; index < 50; index += 1) {
      a.send({ index });
      if (index === 24) await wait(1_100);
    }
    await all;
    expect(received).toEqual(Array.from({ length: 50 }, (_, index) => ({ index })));
    expect(new Set(senders)).toEqual(new Set([a.peerId]));

    const gone = left(a);
    b.leave();
    expect(await gone).toBe(b.peerId);
    expect(a.peers).toEqual([]);
  });
});

describe("shared state (AC-2)", () => {
  it("hands a late joiner the whole state and converges concurrent writes on every member", async () => {
    const a = await rooms().create();
    const written = confirmed(a, "phase");
    a.state.set("phase", "battle");
    await written;

    const late = await client().rooms.join(a.code);
    expect(late.state.get("phase")).toBe("battle");

    // Two clients write the same key and different keys at once: the room orders them, so every
    // member ends on the same value and no write is lost.
    const delivered = [a, late].flatMap((member) => [
      confirmed(member, "score", 2),
      confirmed(member, "left"),
      confirmed(member, "right"),
    ]);
    a.state.set("score", 1);
    late.state.set("score", 2);
    a.state.set("left", "a");
    late.state.set("right", "b");
    await Promise.all(delivered);

    expect(a.state.get("score")).toBe(late.state.get("score"));
    expect([1, 2]).toContain(a.state.get("score"));
    expect(a.state.get("left")).toBe("a");
    expect(late.state.get("left")).toBe("a");
    expect(a.state.get("right")).toBe("b");
    expect(late.state.get("right")).toBe("b");
  });

  it("keeps the state when the room's object is evicted from memory", async () => {
    const a = await rooms().create();
    const written = confirmed(a, "phase");
    a.state.set("phase", "battle");
    await written;

    // Hibernation, forced: the object holding the room is discarded from memory with its sockets
    // hibernated. Whatever the next join is told has to come from the object's SQLite storage.
    await miniflare.unsafeEvictDurableObject("backend", "BackendRoom", {
      name: `${GAME}:${a.code}`,
      webSockets: "hibernate",
    });

    const after = await client().rooms.join(a.code);
    // The state is the SQLite copy; the peer list is the hibernated socket's restored attachment.
    expect(after.state.get("phase")).toBe("battle");
    expect(after.peers).toEqual([a.peerId]);
  });
});

describe("the lobby (AC-3)", () => {
  it("quick-joins the fullest open public room, and creates one when none is open", async () => {
    const quiet = await rooms().create({ public: true });
    const busy = await client().rooms.create({ public: true });
    await client().rooms.join(busy.code);
    expect(busy.code).not.toBe(quiet.code);

    const quick = await client().rooms.quickJoin();
    expect(quick.code).toBe(busy.code);
    expect((await rooms().list()).map((room) => room.code)).toContain(busy.code);
  });

  it("creates a public room when nothing is open", async () => {
    const quick = await client().rooms.quickJoin();
    expect((await rooms().list()).map((room) => room.code)).toEqual([quick.code]);
  });

  it("refuses the join past the room's cap with room_full", async () => {
    const room = await rooms().create({ max: 2 });
    await client().rooms.join(room.code);
    await expect(client().rooms.join(room.code)).rejects.toMatchObject({ code: "room_full" });
  });

  it("answers room_not_found for a code no room of this game holds", async () => {
    await expect(rooms().join("ZZZZZZ")).rejects.toMatchObject({ code: "room_not_found" });
  });

  it("closes a socket that sends a frame over the limit, and one that bursts past the rate", async () => {
    const room = await rooms().create();

    const oversized = await rawSocket(room.code);
    const tooBig = closed(oversized);
    oversized.send(`"${"x".repeat(ROOM_FRAME_MAX)}"`);
    expect((await tooBig).code).toBe(1009);

    const burst = await rawSocket(room.code);
    const tooFast = closed(burst);
    for (let index = 0; index < ROOM_RATE_MAX + 5; index += 1) {
      burst.send(JSON.stringify({ t: "send", data: index }));
    }
    const closedWith = await tooFast;
    expect(closedWith.code).toBe(1008);
    expect(closedWith.reason).toContain("rate");
  });

  it("closes a socket whose frame is not JSON", async () => {
    const room = await rooms().create();
    const socket = await rawSocket(room.code);
    const shut = closed(socket);
    socket.send("not json");
    expect((await shut).code).toBe(1003);
  });
});

describe("trusted room headers", () => {
  it("forwards the lobby's values and never the client's x-backend-* headers", async () => {
    const created = await rooms().create({ max: 2 });
    const forwarded: { name: string; request: Request }[] = [];
    const namespace: IBackendRoomsNamespace<string> = {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: (request) => {
          forwarded.push({ name, request });
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      }),
    };

    const response = await handleBackend(
      new Request(`${base}/_backend/v1/rooms/${created.code}`, {
        headers: {
          upgrade: "websocket",
          "x-backend-game": "forged-game",
          "x-backend-code": "ZZZZZZ",
          "x-backend-max": "999",
          "x-backend-public": "1",
        },
      }),
      { db, gameId: GAME, playerId: PLAYER, rooms: namespace, maxPlayers: 4 },
    );

    expect(response.status).toBe(200);
    expect(forwarded[0]?.name).toBe(`${GAME}:${created.code}`);
    const headers = forwarded[0]?.request.headers;
    expect(headers?.get("x-backend-game")).toBe(GAME);
    expect(headers?.get("x-backend-code")).toBe(created.code);
    expect(headers?.get("x-backend-max")).toBe("2");
    expect(headers?.get("x-backend-public")).toBe("0");
    expect(headers?.get("upgrade")).toBe("websocket");
  });

  it("answers 404 for every room route when the host binds no namespace", async () => {
    const response = await handleBackend(
      new Request(`${base}/_backend/v1/rooms`, { method: "POST" }),
      { db, gameId: GAME, playerId: PLAYER },
    );
    expect(response.status).toBe(404);
  });
});

describe("a game with no host", () => {
  it("rejects every room call with no_host", async () => {
    const offline = createBackend({
      fetch: () => Promise.resolve(new Response("<html></html>", { status: 200 })),
      storage: null,
    });
    await expect(offline.rooms.create()).rejects.toMatchObject({ code: "no_host" });
    await expect(offline.rooms.join("ABCDEF")).rejects.toMatchObject({ code: "no_host" });
    await expect(offline.rooms.quickJoin()).rejects.toMatchObject({ code: "no_host" });
    await expect(offline.rooms.list()).rejects.toMatchObject({ code: "no_host" });
  });
});

describe("deleteGameData", () => {
  it("deletes the game's rooms with its other data", async () => {
    await rooms().create();
    const count = async (): Promise<number> =>
      (await db.prepare("SELECT COUNT(*) AS count FROM rooms").first<{ count: number }>())?.count ??
      0;
    expect(await count()).toBe(1);

    await deleteGameData(db, GAME);
    expect(await count()).toBe(0);
  });
});
