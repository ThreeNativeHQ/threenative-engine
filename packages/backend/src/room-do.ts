/**
 * One room: the relay and ordering authority behind `/_backend/v1/rooms/:code`.
 *
 * The host gives this object `gameId`, the room's cap and whether it is public in headers it
 * builds itself; nothing a client sent reaches them. Each member gets a WebSocket and a random
 * public peer id. Messages go to everybody (or to one peer), and `state` is written to the
 * object's SQLite storage before it is echoed, so a hibernation wake or a crash loses nothing and
 * every member converges on the room's order rather than on a client's.
 *
 * The lobby row lives in the host's D1 (`rooms`), not here: it is what `list` and `quickJoin`
 * read, so a room keeps refreshing it while anyone is connected and deletes it when the last
 * member leaves. That is also how a room whose object crashed ungracefully goes stale.
 *
 * The class takes the runtime's `(ctx, env)` pair in its constructor instead of extending the
 * `DurableObject` base class from `cloudflare:workers`: that import would sit in the module graph
 * of `./cloudflare`, and `handleBackend` has to stay importable in plain Node — the package's own
 * handler tests and the capability census (which imports the built `./cloudflare` entry) both run
 * in Node, where a `cloudflare:` specifier cannot even be resolved.
 */
import { type IBackendD1, byteLength } from "./d1.js";
import {
  ROOM_ALARM_MS,
  ROOM_CLOSE_BAD_FRAME,
  ROOM_CLOSE_LIMIT,
  ROOM_CLOSE_TOO_BIG,
  ROOM_FRAME_MAX,
  ROOM_PEER_LENGTH,
  ROOM_PLAYERS_DEFAULT,
  ROOM_PLAYERS_MIN,
  ROOM_RATE_MAX,
  ROOM_RATE_WINDOW_MS,
  ROOM_STATE_MAX,
  type RoomServerMessage,
  type RoomState,
  decodeRoomFrame,
  isRecord,
  parseRoomClientMessage,
  randomHex,
} from "./protocol.js";
import type { IWorkerDurableObjectContext, IWorkerSocket } from "./room-runtime.js";

/** The runtime's paired sockets; `workerd` provides `WebSocketPair` as a global. */
declare const WebSocketPair: {
  new (): { readonly 0: IWorkerSocket; readonly 1: IWorkerSocket };
};

/** The bindings a room reads. `BACKEND_DB` is the host's D1; a room without it relays only. */
export interface IBackendRoomEnv {
  readonly BACKEND_DB?: IBackendD1;
}

/** What a socket carries across a hibernation wake, so it never has to be re-identified. */
interface IRoomAttachment {
  readonly peerId: string;
  readonly joinedAt: number;
}

/** Room identity and policy, written once from the host's trusted headers. */
interface IRoomMeta {
  readonly gameId: string;
  readonly code: string;
  readonly public: boolean;
  readonly max: number;
  readonly createdAt: number;
}

const META_KEY = "meta";
const STATE_PREFIX = "state:";

function attachmentOf(socket: IWorkerSocket): IRoomAttachment | undefined {
  const raw = socket.deserializeAttachment();
  return isRecord(raw) && typeof raw.peerId === "string" && typeof raw.joinedAt === "number"
    ? { peerId: raw.peerId, joinedAt: raw.joinedAt }
    : undefined;
}

function peerIdOf(socket: IWorkerSocket): string | undefined {
  return attachmentOf(socket)?.peerId;
}

/**
 * The relay a room's players talk through, and the one place its shared state is ordered.
 *
 * @situation bind one room class in a Cloudflare Worker so players of a published game can play together
 */
export class BackendRoom {
  /**
   * Frame budgets, per socket, for this wake only: a hibernated socket starts with a fresh
   * window, which is the smallest state that still bounds a burst.
   */
  readonly #windows = new Map<IWorkerSocket, { start: number; count: number }>();

  constructor(
    private readonly ctx: IWorkerDurableObjectContext,
    private readonly env: IBackendRoomEnv,
  ) {}

  /** The host's half of the upgrade: admit, welcome, and answer with the client socket. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({ error: "room_not_found" }), { status: 404 });
    }
    const meta = await this.#meta(request);
    if (meta === undefined) {
      return new Response(JSON.stringify({ error: "room_not_found" }), { status: 404 });
    }
    const members = this.ctx.getWebSockets();
    if (members.length >= meta.max) {
      return new Response(JSON.stringify({ error: "room_full" }), { status: 409 });
    }

    // The lobby knows about the member before the member is told it is in: `list` and `quickJoin`
    // answer from that row the moment a join resolves.
    await this.#syncLobby(members.length + 1);
    await this.#schedule(members.length + 1);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const peerId = randomHex(ROOM_PEER_LENGTH / 2);
    pair[1].serializeAttachment({ peerId, joinedAt: Date.now() } satisfies IRoomAttachment);
    const welcome: RoomServerMessage = {
      t: "welcome",
      peerId,
      peers: members.map(peerIdOf).filter((id): id is string => id !== undefined),
      state: await this.#state(),
    };
    // Before the newcomer hears anything, so a message the welcome did not carry cannot follow it.
    pair[1].send(JSON.stringify(welcome));
    this.#broadcast({ t: "join", peerId }, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** One frame from one member: a message, a signal, a state write, or a request to leave. */
  async webSocketMessage(socket: IWorkerSocket, raw: string | ArrayBuffer): Promise<void> {
    const peerId = peerIdOf(socket);
    if (peerId === undefined) return;
    if (typeof raw !== "string") return this.#close(socket, ROOM_CLOSE_BAD_FRAME, "json");
    if (byteLength(raw) > ROOM_FRAME_MAX) return this.#close(socket, ROOM_CLOSE_TOO_BIG, "frame");

    const message = parseRoomClientMessage(decodeRoomFrame(raw));
    if (message === undefined) return this.#close(socket, ROOM_CLOSE_BAD_FRAME, "json");
    // Signaling is control traffic: one pair sends offer, answer and several candidates in a burst,
    // so it rides past the budget that bounds a game's own messages. Its size is still checked here
    // and it reaches one peer, so a burst costs the room no more than the socket that sent it.
    if (message.t === "signal") return this.#relaySignal(peerId, message.to, message.data);
    if (!this.#allow(socket)) return this.#close(socket, ROOM_CLOSE_LIMIT, "rate");
    if (message.t === "leave") return this.#close(socket, 1000, "left");
    if (message.t === "state") return this.#writeState(socket, peerId, message.key, message.value);

    const frame: RoomServerMessage = { t: "message", from: peerId, data: message.data };
    // Never back to the sender: a data channel is one way per sender, so the relay has to match it.
    if (message.to === undefined) return this.#broadcast(frame, socket);
    this.#sendTo(message.to, frame);
  }

  /** WebRTC signaling for one pair: relayed to that peer alone, never stored, never ordered. */
  #relaySignal(from: string, to: string, data: unknown): void {
    this.#sendTo(to, { t: "signal", from, data });
  }

  #sendTo(peerId: string, frame: RoomServerMessage): void {
    const payload = JSON.stringify(frame);
    for (const member of this.ctx.getWebSockets()) {
      if (peerIdOf(member) === peerId) member.send(payload);
    }
  }

  /** A state write: bounded, then stored, then echoed to every member in the room's order. */
  async #writeState(
    socket: IWorkerSocket,
    peerId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const storageKey = STATE_PREFIX + key;
    const json = JSON.stringify(value);
    if (json === undefined) return this.#close(socket, ROOM_CLOSE_LIMIT, "state value");
    const previous = await this.ctx.storage.get<unknown>(storageKey);
    const previousBytes =
      previous === undefined
        ? 0
        : byteLength(storageKey) + byteLength(JSON.stringify(previous) ?? "");
    const size =
      (await this.#stateBytes()) - previousBytes + byteLength(storageKey) + byteLength(json);
    if (size > ROOM_STATE_MAX) return this.#close(socket, ROOM_CLOSE_TOO_BIG, "state");
    // The room's storage is the source of truth, so the write lands before anyone is told about it.
    await this.ctx.storage.put(storageKey, value);
    this.#broadcast({ t: "state", key, value, from: peerId });
  }

  /** A member left or its connection dropped: tell the rest, and settle the lobby row. */
  async webSocketClose(socket: IWorkerSocket): Promise<void> {
    await this.#departed(socket);
  }

  /** The same cleanup as a close: the runtime follows an error with a close, and both are cheap. */
  async webSocketError(socket: IWorkerSocket): Promise<void> {
    await this.#departed(socket);
  }

  /** Keeps a live room's lobby row fresh, so a room whose object died stops being joinable. */
  async alarm(): Promise<void> {
    const members = this.ctx.getWebSockets();
    await this.#syncLobby(members.length);
    await this.#schedule(members.length);
  }

  #allow(socket: IWorkerSocket): boolean {
    const now = Date.now();
    const window = this.#windows.get(socket);
    if (window === undefined || now - window.start >= ROOM_RATE_WINDOW_MS) {
      this.#windows.set(socket, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= ROOM_RATE_MAX;
  }

  #close(socket: IWorkerSocket, code: number, reason: string): void {
    this.#windows.delete(socket);
    socket.close(code, reason);
  }

  #broadcast(message: RoomServerMessage, except?: IWorkerSocket): void {
    const frame = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      socket.send(frame);
    }
  }

  async #departed(socket: IWorkerSocket): Promise<void> {
    const peerId = peerIdOf(socket);
    this.#windows.delete(socket);
    if (peerId !== undefined) this.#broadcast({ t: "leave", peerId }, socket);
    const remaining = this.ctx.getWebSockets().filter((member) => member !== socket).length;
    await this.#syncLobby(remaining);
    await this.#schedule(remaining);
  }

  /** The room's policy, read from storage after the first join and from trusted headers before it. */
  async #meta(request: Request): Promise<IRoomMeta | undefined> {
    const stored = await this.ctx.storage.get<IRoomMeta>(META_KEY);
    if (stored !== undefined) return stored;
    const gameId = request.headers.get("x-backend-game");
    const code = request.headers.get("x-backend-code");
    if (gameId === null || gameId.length === 0 || code === null || code.length === 0) {
      return undefined;
    }
    const max = Number(request.headers.get("x-backend-max"));
    const meta: IRoomMeta = {
      gameId,
      code,
      public: request.headers.get("x-backend-public") === "1",
      max: Number.isInteger(max) && max >= ROOM_PLAYERS_MIN ? max : ROOM_PLAYERS_DEFAULT,
      createdAt: Date.now(),
    };
    // Before anything can reply from it, and before any wake has to reconstruct it.
    await this.ctx.storage.put(META_KEY, meta);
    return meta;
  }

  async #state(): Promise<RoomState> {
    const entries = await this.ctx.storage.list<unknown>({ prefix: STATE_PREFIX });
    const state: Record<string, unknown> = {};
    for (const [key, value] of entries) state[key.slice(STATE_PREFIX.length)] = value;
    return state;
  }

  async #stateBytes(): Promise<number> {
    const entries = await this.ctx.storage.list<unknown>({ prefix: STATE_PREFIX });
    let total = 0;
    for (const [key, value] of entries)
      total += byteLength(key) + byteLength(JSON.stringify(value));
    return total;
  }

  /** The lobby row `list` and `quickJoin` read: it disappears with the last member. */
  async #syncLobby(players: number): Promise<void> {
    const db = this.env.BACKEND_DB;
    const meta = await this.ctx.storage.get<IRoomMeta>(META_KEY);
    if (db === undefined || meta === undefined) return;
    if (players <= 0) {
      await db
        .prepare("DELETE FROM rooms WHERE game_id = ? AND code = ?")
        .bind(meta.gameId, meta.code)
        .run();
      return;
    }
    await db
      .prepare("UPDATE rooms SET players = ?, updated_at = ? WHERE game_id = ? AND code = ?")
      .bind(players, Date.now(), meta.gameId, meta.code)
      .run();
  }

  /** One alarm every `ROOM_ALARM_MS` while anyone is here; none once the room is empty. */
  async #schedule(players: number): Promise<void> {
    if (players <= 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_ALARM_MS);
  }
}
