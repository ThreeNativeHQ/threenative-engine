/**
 * The server half of `@threenative/backend`: one request handler a Worker mounts at
 * `DEFAULT_PREFIX`, and the wipe a delete or account purge calls.
 *
 * The handler trusts `gameId` and `playerId` from its caller — the host resolves the share,
 * verifies the player cookie and enforces rate limits before this runs — and touches D1 only
 * through bound parameters, so a key can never reach SQL as syntax.
 */
import {
  type IBackendD1,
  type IDocRow,
  type IKvRow,
  SELECT_DOC,
  SELECT_KV,
  UPDATE_DOC,
  UPDATE_KV,
  byteLength,
  changes,
  docItem,
  overGameLimit,
  parseStored,
} from "./d1.js";
import { conflict, fail, ifVersionOf, readObject, respond, segment } from "./http.js";
import {
  DEFAULT_PREFIX,
  DOCS_MAX,
  DOC_MAX,
  KEYS_MAX,
  LIST_MAX,
  VALUE_MAX,
  isValidName,
} from "./protocol.js";

export type {
  IBackendD1,
  IBackendD1Result,
  IBackendD1Statement,
} from "./d1.js";

export interface IBackendHandlerOptions {
  readonly db: IBackendD1;
  /** The game the request belongs to, resolved by the host from the share. Never from the client. */
  readonly gameId: string;
  /** The verified player, resolved by the host from its cookie. Never from the client. */
  readonly playerId: string;
  /** Where the host mounted the routes. Default `DEFAULT_PREFIX`. */
  readonly prefix?: string;
}

interface IRouteContext {
  readonly db: IBackendD1;
  readonly gameId: string;
  readonly playerId: string;
  readonly request: Request;
}

async function listValues(context: IRouteContext): Promise<Response> {
  const rows = await context.db
    .prepare(
      "SELECT key, value, version FROM kv WHERE game_id = ? AND player_id = ? ORDER BY key LIMIT ?",
    )
    .bind(context.gameId, context.playerId, LIST_MAX)
    .all<{ key: string; value: string; version: number }>();
  const items = rows.results.map((row) => ({
    key: row.key,
    value: parseStored(row.value),
    version: row.version,
  }));
  return respond({ items });
}

async function readValue(context: IRouteContext, key: string): Promise<Response> {
  if (!isValidName(key)) return fail("invalid_key", 400);
  const row = await context.db
    .prepare(SELECT_KV)
    .bind(context.gameId, context.playerId, key)
    .first<IKvRow>();
  if (row === null) return fail("not_found", 404);
  return respond({ value: parseStored(row.value), version: row.version });
}

async function writeValue(context: IRouteContext, key: string): Promise<Response> {
  if (!isValidName(key)) return fail("invalid_key", 400);
  const body = await readObject(context.request);
  if (body === undefined || body.value === undefined) return fail("invalid_key", 400);
  const ifVersion = ifVersionOf(body);
  if (ifVersion === null) return fail("invalid_key", 400);

  const text = JSON.stringify(body.value);
  if (text === undefined) return fail("invalid_key", 400);
  const size = byteLength(text);
  if (size > VALUE_MAX) return fail("too_large", 413);

  const existing = await context.db
    .prepare(SELECT_KV)
    .bind(context.gameId, context.playerId, key)
    .first<IKvRow>();
  if (existing !== null && ifVersion !== undefined && existing.version !== ifVersion) {
    return conflict(parseStored(existing.value), existing.version);
  }
  if (existing === null && ifVersion !== undefined && ifVersion !== 0) return conflict(null, 0);

  if (existing === null) {
    const owned = await context.db
      .prepare("SELECT COUNT(*) AS count FROM kv WHERE game_id = ? AND player_id = ?")
      .bind(context.gameId, context.playerId)
      .first<{ count: number }>();
    if ((owned?.count ?? 0) >= KEYS_MAX) return fail("too_large", 413);
  }
  const rowDelta = existing === null ? 1 : 0;
  if (await overGameLimit(context.db, context.gameId, rowDelta, size - (existing?.size ?? 0))) {
    return fail("too_large", 413);
  }

  const now = Date.now();
  const next = (existing?.version ?? 0) + 1;
  const result =
    existing === null
      ? await context.db
          .prepare(
            "INSERT INTO kv (game_id, player_id, key, value, size, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
          )
          .bind(context.gameId, context.playerId, key, text, size, now)
          .run()
      : await context.db
          .prepare(UPDATE_KV)
          .bind(text, size, next, now, context.gameId, context.playerId, key, existing.version)
          .run();
  if (changes(result) === 0) {
    // Another request won the version between the read and the write.
    const current = await context.db
      .prepare(SELECT_KV)
      .bind(context.gameId, context.playerId, key)
      .first<IKvRow>();
    return current === null
      ? conflict(null, 0)
      : conflict(parseStored(current.value), current.version);
  }
  return respond({ version: next });
}

async function deleteValue(context: IRouteContext, key: string): Promise<Response> {
  if (!isValidName(key)) return fail("invalid_key", 400);
  const body = (await readObject(context.request)) ?? {};
  const ifVersion = ifVersionOf(body);
  if (ifVersion === null) return fail("invalid_key", 400);

  const existing = await context.db
    .prepare(SELECT_KV)
    .bind(context.gameId, context.playerId, key)
    .first<IKvRow>();
  if (existing === null) return respond({});
  if (ifVersion !== undefined && existing.version !== ifVersion) {
    return conflict(parseStored(existing.value), existing.version);
  }
  const result = await context.db
    .prepare("DELETE FROM kv WHERE game_id = ? AND player_id = ? AND key = ? AND version = ?")
    .bind(context.gameId, context.playerId, key, existing.version)
    .run();
  if (changes(result) === 0) {
    const current = await context.db
      .prepare(SELECT_KV)
      .bind(context.gameId, context.playerId, key)
      .first<IKvRow>();
    if (current !== null) return conflict(parseStored(current.value), current.version);
  }
  return respond({});
}

async function listDocs(context: IRouteContext, name: string): Promise<Response> {
  if (!isValidName(name)) return fail("invalid_key", 400);
  const rows = await context.db
    .prepare(
      "SELECT doc_id, owner_id, scope, data, version FROM docs WHERE game_id = ? AND collection = ? AND (owner_id = ? OR scope = 'public') ORDER BY doc_id LIMIT ?",
    )
    .bind(context.gameId, name, context.playerId, LIST_MAX)
    .all<IDocRow>();
  return respond({ items: rows.results.map((row) => docItem(row, context.playerId)) });
}

async function readDoc(context: IRouteContext, name: string, id: string): Promise<Response> {
  if (!isValidName(name) || !isValidName(id)) return fail("invalid_key", 400);
  const row = await context.db.prepare(SELECT_DOC).bind(context.gameId, name, id).first<IDocRow>();
  // Another player's private document does not exist as far as this caller can tell.
  if (row === null || (row.scope !== "public" && row.owner_id !== context.playerId)) {
    return fail("not_found", 404);
  }
  return respond(docItem(row, context.playerId));
}

async function writeDoc(context: IRouteContext, name: string, id: string): Promise<Response> {
  if (!isValidName(name) || !isValidName(id)) return fail("invalid_key", 400);
  const body = await readObject(context.request);
  if (body === undefined || body.data === undefined) return fail("invalid_key", 400);
  const scope = body.scope;
  if (scope !== "private" && scope !== "public") return fail("invalid_key", 400);
  const ifVersion = ifVersionOf(body);
  if (ifVersion === null) return fail("invalid_key", 400);

  const text = JSON.stringify(body.data);
  if (text === undefined) return fail("invalid_key", 400);
  const size = byteLength(text);
  if (size > DOC_MAX) return fail("too_large", 413);

  const existing = await context.db
    .prepare(SELECT_DOC)
    .bind(context.gameId, name, id)
    .first<IDocRow>();
  if (existing !== null && existing.owner_id !== context.playerId) return fail("forbidden", 403);
  if (existing !== null && ifVersion !== undefined && existing.version !== ifVersion) {
    return conflict(parseStored(existing.data), existing.version);
  }
  if (existing === null && ifVersion !== undefined && ifVersion !== 0) return conflict(null, 0);

  if (existing === null) {
    const owned = await context.db
      .prepare(
        "SELECT COUNT(*) AS count FROM docs WHERE game_id = ? AND collection = ? AND owner_id = ?",
      )
      .bind(context.gameId, name, context.playerId)
      .first<{ count: number }>();
    if ((owned?.count ?? 0) >= DOCS_MAX) return fail("too_large", 413);
  }
  const rowDelta = existing === null ? 1 : 0;
  const byteDelta = size - byteLength(existing?.data ?? "");
  if (await overGameLimit(context.db, context.gameId, rowDelta, byteDelta)) {
    return fail("too_large", 413);
  }

  const now = Date.now();
  const next = (existing?.version ?? 0) + 1;
  const result =
    existing === null
      ? await context.db
          .prepare(
            "INSERT INTO docs (game_id, collection, doc_id, owner_id, scope, data, size, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
          )
          .bind(context.gameId, name, id, context.playerId, scope, text, size, now)
          .run()
      : await context.db
          .prepare(UPDATE_DOC)
          .bind(text, size, scope, next, now, context.gameId, name, id, existing.version)
          .run();
  if (changes(result) === 0) {
    const current = await context.db
      .prepare(SELECT_DOC)
      .bind(context.gameId, name, id)
      .first<IDocRow>();
    return current === null
      ? conflict(null, 0)
      : conflict(parseStored(current.data), current.version);
  }
  return respond({ version: next });
}

async function deleteDoc(context: IRouteContext, name: string, id: string): Promise<Response> {
  if (!isValidName(name) || !isValidName(id)) return fail("invalid_key", 400);
  const existing = await context.db
    .prepare(SELECT_DOC)
    .bind(context.gameId, name, id)
    .first<IDocRow>();
  if (existing === null) return respond({});
  if (existing.owner_id !== context.playerId) return fail("forbidden", 403);
  await context.db
    .prepare("DELETE FROM docs WHERE game_id = ? AND collection = ? AND doc_id = ?")
    .bind(context.gameId, name, id)
    .run();
  return respond({});
}

/**
 * Answers one `/_backend` request: `200` with the body, or `{ error }` with 400/403/404/409/413.
 *
 * Every response carries the marker header, errors included, because the client decides whether a
 * host exists at all by looking for it — an SPA fallback HTML 200 is not a backend.
 *
 * @situation mount cloud saves and shared documents on a Cloudflare Worker
 * @situation run the ThreeNative backend on your own Cloudflare account
 * @requires npm i @threenative/backend
 * @example export default { async fetch(request, env) { return handleBackend(request, { db: env.BACKEND_DB, gameId, playerId }); } }; // gameId and playerId are the host's, never the client's
 */
export async function handleBackend(
  request: Request,
  options: IBackendHandlerOptions,
): Promise<Response> {
  const prefix = (options.prefix ?? DEFAULT_PREFIX).replace(/\/+$/u, "");
  const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix)) return fail("not_found", 404);

  const parts = path.slice(prefix.length).split("/").filter(Boolean).map(segment);
  if (parts.includes(undefined) || parts[0] !== "v1") return fail("not_found", 404);

  const context: IRouteContext = {
    db: options.db,
    gameId: options.gameId,
    playerId: options.playerId,
    request,
  };
  const method = request.method.toUpperCase();
  const [, group, name, id] = parts as (string | undefined)[];

  if (group === "db") {
    if (name === undefined) return method === "GET" ? listValues(context) : fail("not_found", 404);
    if (id !== undefined) return fail("not_found", 404);
    if (method === "GET") return readValue(context, name);
    if (method === "PUT") return writeValue(context, name);
    if (method === "DELETE") return deleteValue(context, name);
    return fail("not_found", 404);
  }
  if (group === "collections" && name !== undefined) {
    if (id === undefined) {
      return method === "GET" ? listDocs(context, name) : fail("not_found", 404);
    }
    if (parts.length > 4) return fail("not_found", 404);
    if (method === "GET") return readDoc(context, name, id);
    if (method === "PUT") return writeDoc(context, name, id);
    if (method === "DELETE") return deleteDoc(context, name, id);
  }
  return fail("not_found", 404);
}

/**
 * Removes every row a game owns, in both tables, and nothing else — what a game or account
 * deletion calls, while revoking a share link keeps the players' saves.
 *
 * @situation delete a published game and all of its players' data in one call
 * @requires npm i @threenative/backend
 * @example await deleteGameData(env.BACKEND_DB, projectId);
 */
export async function deleteGameData(db: IBackendD1, gameId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM kv WHERE game_id = ?").bind(gameId),
    db.prepare("DELETE FROM docs WHERE game_id = ?").bind(gameId),
  ]);
}
