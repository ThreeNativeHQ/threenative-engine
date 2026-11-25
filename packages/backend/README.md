# @threenative/backend

## What it is

Cloud saves, shared documents and online rooms for a published game: one local-first client, one
Cloudflare Worker handler and the D1 schema behind them. A write lands in `localStorage` first and reaches
the host second, so progress is already durable when the network answers — or never does. With no
host, no `fetch` and no `localStorage`, every call still resolves and the game keeps running.

The package owns the whole protocol, so the same code runs on the ThreeNative share host and on
anybody's own Cloudflare account. It has zero runtime dependencies.

```
game code ── backend.db.set("save", v) ─▶ localStorage (at once)
                                       └▶ PUT /_backend/v1/db/save { value, ifVersion }
Worker ──▶ handleBackend(request, { db, gameId, playerId }) ──▶ D1
```

## Install

```sh
pnpm add @threenative/backend
```

## Client

```ts
import { createBackend } from "@threenative/backend";

const backend = createBackend();

await backend.db.set("save", { level: 4, gold: 20 });
const save = await backend.db.get("save");
const keys = await backend.db.list();
await backend.db.delete("save");

const levels = backend.db.collection("levels");
await levels.put("canyon", { blocks: 12, title: "Canyon run" }, "public");
const shared = await levels.list();
```

`db.set` and `collection.put` resolve with the version the host holds for that key — the last
confirmed one when the upload never landed — and reject with a `BackendError`
whose `code` is `version_conflict`, `too_large`, `forbidden`, `invalid_key`, `no_host` or
`rate_limited`. A `version_conflict` carries the host's copy in `error.value`/`error.version` and
the client has already settled its cache on it: re-read, merge, write again.

Scope: a `private` document is readable by its owner alone; a `public` document is readable by
every player of the same game and writable only by its owner. Responses identify other players by
`isOwner: false` and never by id.

### Rooms

```ts
const rooms = createBackend().rooms;

const room = await rooms.create({ max: 4 });
room.code; // share it: six characters, no I/L/O/0/1

const other = await rooms.join(room.code);
room.send({ move: "e4" }, other.peerId);
other.on("message", (data, from) => play(data, from));

other.state.set("turn", 2);
room.on("state", (key, value) => apply(key, value));
room.state.get("turn");

await rooms.list();      // public rooms with space, newest first
await rooms.quickJoin(); // the fullest public room, or a new one
```

A room is one WebSocket into a Durable Object that relays messages and orders the shared state, so
every member sees the same sequence. A created room is private unless it asks for `public: true`:
only public rooms are listed and quick-joined, and every room is still joinable by its code.
`peerId` is a random public room id, never the player's identity. `create`, `join` and `quickJoin`
resolve with a joined room and reject with `no_host` (no host), `room_not_found` (no such code) or
`room_full` (at its cap); `on` returns an unsubscribe. A socket that sends a frame over 16 KB, more
than 30 frames per second, or state over 64 KB is closed with a reason (1009/1008), and a frame
that is not JSON with 1003.

`createBackend` takes `endpoint` (default `/_backend`), `fetch` and `storage`. The client treats a
missing `x-threenative-backend: 1` header, a 404, a network error or a missing `fetch` as "no
host" and remembers that for its lifetime; concurrent first-load calls share one probe.

## Server

```ts
import { BackendRoom, deleteGameData, handleBackend } from "@threenative/backend/cloudflare";

export { BackendRoom }; // what `new_sqlite_classes: ["BackendRoom"]` names

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/_backend"))
      return handleBackend(request, {
        db: env.BACKEND_DB,
        gameId,
        playerId,
        rooms: env.ROOMS, // a Durable Object namespace bound to BackendRoom
        maxPlayers: 4,    // the owner's plan cap on players per room
      });
    return new Response("not found", { status: 404 });
  },
};
```

Without `rooms` every `/v1/rooms` route is a 404. The handler builds the headers the room trusts
(`x-backend-game`, `x-backend-code`, `x-backend-max`, `x-backend-public`) itself and never copies
a client's, so a forged cap or game id cannot reach a room. `BackendRoom` keeps room metadata and
shared state in its own SQLite storage and the lobby row (`rooms`) in `BACKEND_DB`, refreshing it
on every join, leave and 60 s alarm so a room whose object died goes stale (not listed, not
quick-joined, after 120 s).

The host resolves `gameId` from the published game and `playerId` from its own cookie, and checks
the origin before calling in — the handler trusts both and reads no cookie itself. `db` is
structural: any D1-shaped `prepare`/`bind`/`first`/`all`/`run`/`batch` satisfies it, and every
statement is bound, never string-built. `deleteGameData(db, gameId)` wipes one game's rows in all three
tables and nothing else.

## Schema

`migrations/0001_backend.sql` creates `kv` and `docs` with their indexes on plain SQLite, and
`migrations/0002_rooms.sql` adds the `rooms` lobby:

```sh
wrangler d1 migrations apply backend --migrations-dir node_modules/@threenative/backend/migrations
```

## Limits

Returned as 413 `too_large`, storing nothing: 64 KB per value, 16 KB per document, 50 keys per
player per game, 100 documents per player per collection, 50 MB and 10,000 rows per game. A list
call returns at most 100 items. Keys, collection names and document ids are 1–128 characters of
`[a-zA-Z0-9._:-]`; anything else is 400 `invalid_key` before D1 is touched.

The client writes every value, so players can edit their own saves. Progress and game data are
fine; anything with money value is not.
