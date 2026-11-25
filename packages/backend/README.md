# @threenative/backend

## What it is

Cloud saves and shared documents for a published game: one local-first client, one Cloudflare
Worker handler and the D1 schema behind them. A write lands in `localStorage` first and reaches
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

`db.set` and `collection.put` resolve with the stored version and reject with a `BackendError`
whose `code` is `version_conflict`, `too_large`, `forbidden`, `invalid_key`, `no_host` or
`rate_limited`. A `version_conflict` carries the host's copy in `error.value`/`error.version` and
the client has already settled its cache on it: re-read, merge, write again.

Scope: a `private` document is readable by its owner alone; a `public` document is readable by
every player of the same game and writable only by its owner. Responses identify other players by
`isOwner: false` and never by id.

`createBackend` takes `endpoint` (default `/_backend`), `fetch` and `storage`. The client treats a
missing `x-threenative-backend: 1` header, a 404, a network error or a missing `fetch` as "no
host" and remembers that for its lifetime; concurrent first-load calls share one probe.

## Server

```ts
import { deleteGameData, handleBackend } from "@threenative/backend/cloudflare";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/_backend"))
      return handleBackend(request, { db: env.BACKEND_DB, gameId, playerId });
    return new Response("not found", { status: 404 });
  },
};
```

The host resolves `gameId` from the published game and `playerId` from its own cookie, and checks
the origin before calling in — the handler trusts both and reads no cookie itself. `db` is
structural: any D1-shaped `prepare`/`bind`/`first`/`all`/`run`/`batch` satisfies it, and every
statement is bound, never string-built. `deleteGameData(db, gameId)` wipes one game's rows in both
tables and nothing else.

## Schema

`migrations/0001_backend.sql` creates `kv` and `docs` with their indexes on plain SQLite:

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
