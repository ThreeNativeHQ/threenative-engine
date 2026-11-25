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
export const BACKEND_ERROR_CODES = [
  "version_conflict",
  "too_large",
  "forbidden",
  "invalid_key",
  "not_found",
  "no_host",
  "rate_limited",
  "room_not_found",
  "room_full",
] as const;

export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];

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

/**
 * Rooms: one WebSocket per player into a Durable Object that relays messages and orders the
 * shared state. A code is short enough to say out loud; a peer id is a public room id, never the
 * player's.
 */
export const ROOM_CODE_LENGTH = 6;
/** No `I`, `L`, `O`, `0` or `1`: a code read off a screen or over voice is unambiguous. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** A room name a client may join: exactly `ROOM_CODE_LENGTH` characters of the alphabet. */
export const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`, "u");
/** Players in a room whose host names no cap. */
export const ROOM_PLAYERS_DEFAULT = 4;
/** Smallest room: one player alone is not a room. */
export const ROOM_PLAYERS_MIN = 2;
/** Largest JSON one room frame may carry, in UTF-8 bytes. */
export const ROOM_FRAME_MAX = 16 * 1024;
/** Frames one socket may send per rate window before the room closes it. */
export const ROOM_RATE_MAX = 30;
/** The rate window, in milliseconds. */
export const ROOM_RATE_WINDOW_MS = 1000;
/** UTF-8 bytes of key plus value one room's shared state may hold. */
export const ROOM_STATE_MAX = 64 * 1024;
/** A room its host has not refreshed in this long is stale: not listed, not quick-joined. */
export const ROOM_STALE_MS = 120_000;
/** How often a live room refreshes its lobby row, so a crashed room goes stale. */
export const ROOM_ALARM_MS = 60_000;
/** Close codes: policy limit, oversized frame, malformed frame. */
export const ROOM_CLOSE_LIMIT = 1008;
export const ROOM_CLOSE_TOO_BIG = 1009;
export const ROOM_CLOSE_BAD_FRAME = 1003;
/** Hex characters in a peer id. The value is random, so it says nothing about the player. */
export const ROOM_PEER_LENGTH = 12;

/** One public room as `list` and `quickJoin` see it. */
export interface IRoomInfo {
  readonly code: string;
  readonly players: number;
  readonly max: number;
}

export interface IRoomListResponse {
  readonly items: readonly IRoomInfo[];
}

/** `max` is clamped to `[ROOM_PLAYERS_MIN, the host's cap]`; `public` lists the room and quick-joins it. */
export interface IRoomCreateRequest {
  readonly max?: number;
  readonly public?: boolean;
}

export interface IRoomCodeResponse {
  readonly code: string;
}

/** What one room's members share, ordered by the room rather than by any client. */
export type RoomState = Readonly<Record<string, unknown>>;

export type RoomClientMessage =
  | { readonly t: "send"; readonly data: unknown; readonly to?: string }
  | { readonly t: "state"; readonly key: string; readonly value: unknown }
  /** WebRTC offer, answer or candidate for one peer: the room relays it and never reads it. */
  | { readonly t: "signal"; readonly to: string; readonly data: unknown }
  | { readonly t: "leave" };

export type RoomServerMessage =
  | {
      readonly t: "welcome";
      readonly peerId: string;
      readonly peers: readonly string[];
      readonly state: RoomState;
    }
  | { readonly t: "join"; readonly peerId: string }
  | { readonly t: "leave"; readonly peerId: string }
  | { readonly t: "message"; readonly from: string; readonly data: unknown }
  | { readonly t: "signal"; readonly from: string; readonly data: unknown }
  | { readonly t: "state"; readonly key: string; readonly value: unknown; readonly from: string };

/** Random lowercase hex from the platform's crypto: peer ids, never derived from the player. */
export function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A room code a client can share: `ROOM_CODE_LENGTH` characters from the unambiguous alphabet. */
export function randomRoomCode(): string {
  const buffer = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(buffer, (byte) =>
    ROOM_CODE_ALPHABET.charAt(byte % ROOM_CODE_ALPHABET.length),
  ).join("");
}

function roomPeerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A client frame, or `undefined` when it is not one this room speaks. */
export function parseRoomClientMessage(raw: unknown): RoomClientMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.t === "send")
    return { t: "send", data: raw.data, to: roomPeerId(raw.to) ? raw.to : undefined };
  if (raw.t === "signal" && roomPeerId(raw.to)) {
    return { t: "signal", to: raw.to, data: raw.data };
  }
  if (raw.t === "state" && typeof raw.key === "string" && isValidName(raw.key)) {
    return { t: "state", key: raw.key, value: raw.value };
  }
  if (raw.t === "leave") return { t: "leave" };
  return undefined;
}

/** A room frame, or `undefined` when it is not one this client speaks. */
export function parseRoomServerMessage(raw: unknown): RoomServerMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.t === "welcome" && roomPeerId(raw.peerId)) {
    return {
      t: "welcome",
      peerId: raw.peerId,
      peers: Array.isArray(raw.peers) ? raw.peers.filter(roomPeerId) : [],
      state: isRecord(raw.state) ? raw.state : {},
    };
  }
  if (raw.t === "join" && roomPeerId(raw.peerId)) return { t: "join", peerId: raw.peerId };
  if (raw.t === "leave" && roomPeerId(raw.peerId)) return { t: "leave", peerId: raw.peerId };
  if (raw.t === "message" && roomPeerId(raw.from)) {
    return { t: "message", from: raw.from, data: raw.data };
  }
  if (raw.t === "signal" && roomPeerId(raw.from)) {
    return { t: "signal", from: raw.from, data: raw.data };
  }
  if (
    raw.t === "state" &&
    typeof raw.key === "string" &&
    isValidName(raw.key) &&
    roomPeerId(raw.from)
  ) {
    return { t: "state", key: raw.key, value: raw.value, from: raw.from };
  }
  return undefined;
}

/** The JSON one frame carries, or `undefined` when it is not JSON this room accepts. */
export function decodeRoomFrame(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
