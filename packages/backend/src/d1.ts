/**
 * The handler's D1 layer: the four statements it reuses, the row shapes it reads, and the size and
 * per-game budget math. Every statement is bound; nothing here builds SQL from a key.
 */
import type { ICollectionItem } from "./protocol.js";
import { GAME_BYTES_MAX, GAME_ROWS_MAX } from "./protocol.js";

export interface IBackendD1Result {
  readonly meta?: { readonly changes?: number };
}

/** The slice of a prepared D1 statement this handler uses; a real `D1PreparedStatement` fits. */
export interface IBackendD1Statement {
  bind(...values: readonly unknown[]): IBackendD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<IBackendD1Result>;
}

/**
 * The slice of `D1Database` the handler needs, declared structurally so this package owns no
 * `@cloudflare/workers-types` dependency and a plain SQLite driver can stand in during a test.
 */
export interface IBackendD1 {
  prepare(query: string): IBackendD1Statement;
  batch(statements: readonly IBackendD1Statement[]): Promise<readonly IBackendD1Result[]>;
}

export interface IKvRow {
  readonly value: string;
  readonly size: number;
  readonly version: number;
}

export interface IDocRow {
  readonly doc_id: string;
  readonly owner_id: string;
  readonly scope: string;
  readonly data: string;
  readonly version: number;
}

/** A lobby row as `list` and `quickJoin` read it. */
export interface IRoomRow {
  readonly code: string;
  readonly players: number;
  readonly max: number;
}

/** The same row plus the visibility the join route forwards into the room. */
export interface IRoomLobbyRow extends IRoomRow {
  readonly public: number;
}

export interface ITotalsRow {
  readonly rows: number;
  readonly bytes: number;
}

const encoder = new TextEncoder();

export const SELECT_KV =
  "SELECT value, size, version FROM kv WHERE game_id = ? AND player_id = ? AND key = ?";
export const SELECT_DOC =
  "SELECT doc_id, owner_id, scope, data, version FROM docs WHERE game_id = ? AND collection = ? AND doc_id = ?";
export const UPDATE_KV =
  "UPDATE kv SET value = ?, size = ?, version = ?, updated_at = ? WHERE game_id = ? AND player_id = ? AND key = ? AND version = ?";
export const UPDATE_DOC =
  "UPDATE docs SET data = ?, size = ?, scope = ?, version = ?, updated_at = ? WHERE game_id = ? AND collection = ? AND doc_id = ? AND version = ?";
const SELECT_TOTALS =
  "SELECT (SELECT COUNT(*) FROM kv WHERE game_id = ?) + (SELECT COUNT(*) FROM docs WHERE game_id = ?) AS rows, " +
  "(SELECT COALESCE(SUM(size), 0) FROM kv WHERE game_id = ?) + (SELECT COALESCE(SUM(size), 0) FROM docs WHERE game_id = ?) AS bytes";

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export function parseStored(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function changes(result: IBackendD1Result): number {
  return result.meta?.changes ?? 0;
}

export function docItem(row: IDocRow, playerId: string): ICollectionItem {
  return {
    id: row.doc_id,
    data: parseStored(row.data),
    scope: row.scope === "public" ? "public" : "private",
    version: row.version,
    isOwner: row.owner_id === playerId,
  };
}

/** Rows and bytes one game holds, across both tables: the 50 MB / 10,000 row budget. */
export async function overGameLimit(
  db: IBackendD1,
  gameId: string,
  rowDelta: number,
  byteDelta: number,
): Promise<boolean> {
  const totals = await db
    .prepare(SELECT_TOTALS)
    .bind(gameId, gameId, gameId, gameId)
    .first<ITotalsRow>();
  return (
    (totals?.rows ?? 0) + rowDelta > GAME_ROWS_MAX ||
    (totals?.bytes ?? 0) + byteDelta > GAME_BYTES_MAX
  );
}
