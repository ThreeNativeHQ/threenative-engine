/**
 * The wire contract shared by the browser client and the Worker handler: names, limits, error
 * codes and the bodies of `/_backend/v1`. It owns no dependency and touches no database.
 */

/** A key, collection name or document id: 1–128 URL-safe characters. */
export const NAME_RE = /^[a-zA-Z0-9._:-]{1,128}$/u;

/** Largest JSON a single value may store, in UTF-8 bytes. */
export const VALUE_MAX = 64 * 1024;
/** Keys one player may own in one game. */
export const KEYS_MAX = 50;
/** Largest JSON a single document may store, in UTF-8 bytes. */
export const DOC_MAX = 16 * 1024;
/** Documents one player may own in one collection. */
export const DOCS_MAX = 100;
/** Items one list call returns. */
export const LIST_MAX = 100;
/** Bytes one game may store across both tables. */
export const GAME_BYTES_MAX = 50 * 1024 * 1024;
/** Rows one game may store across both tables. */
export const GAME_ROWS_MAX = 10_000;

/**
 * Every handler response carries `MARKER_HEADER: MARKER_VALUE`. The client treats its absence as
 * "no host", which is what a static host answering with an SPA fallback HTML page looks like.
 */
export const MARKER_HEADER = "x-threenative-backend";
export const MARKER_VALUE = "1";

/** Where a host mounts the handler unless it says otherwise. */
export const DEFAULT_PREFIX = "/_backend";

/** Every failure a caller has to handle, on the wire and in the client. */
export type BackendErrorCode =
  | "version_conflict"
  | "too_large"
  | "forbidden"
  | "invalid_key"
  | "not_found"
  | "no_host"
  | "rate_limited";

/** A document is readable by its owner alone, or by every player of the same game. */
export type DocScope = "private" | "public";

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** A JSON object, which is the only body shape `/_backend/v1` accepts or stores. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface IBackendErrorResponse {
  readonly error: BackendErrorCode;
  /** The server's copy, on `version_conflict`, so the caller can settle on it. */
  readonly value?: unknown;
  readonly version?: number;
}

export interface IDbItem {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

export interface IDbListResponse {
  readonly items: readonly IDbItem[];
}

export interface IDbValueResponse {
  readonly value: unknown;
  readonly version: number;
}

export interface IVersionResponse {
  readonly version: number;
}

/** `ifVersion` omitted writes unconditionally, `0` creates, anything else must match. */
export interface IDbWriteRequest {
  readonly value: unknown;
  readonly ifVersion?: number;
}

export interface IDbDeleteRequest {
  readonly ifVersion?: number;
}

export interface ICollectionItem {
  readonly id: string;
  readonly data: unknown;
  readonly scope: DocScope;
  readonly version: number;
  /** True for the caller's own documents. Another player's identity is never sent. */
  readonly isOwner: boolean;
}

export interface ICollectionListResponse {
  readonly items: readonly ICollectionItem[];
}

export interface ICollectionWriteRequest {
  readonly data: unknown;
  readonly scope: DocScope;
  readonly ifVersion?: number;
}
