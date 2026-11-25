/**
 * Rooms, from the page: create one, join one by code, or take the fullest public one open.
 *
 * A room is one WebSocket into a Durable Object that relays every member's messages and orders
 * the shared state. `peerId` is a random public room id, never the player's identity: a game can
 * show it. With no host, every call rejects with `no_host`, exactly like the cloud store.
 */
import {
  type IRoomCreateRequest,
  type IRoomInfo,
  ROOM_CODE_RE,
  type RoomClientMessage,
  type RoomServerMessage,
  decodeRoomFrame,
  parseRoomServerMessage,
} from "./protocol.js";
import { BackendError, type IBackendContext, failureOf, hosted, readJson, send } from "./wire.js";

export type { IRoomCreateRequest, IRoomInfo } from "./protocol.js";

/** The shared state of one room as this client has confirmed it from the room's order. */
export interface IRoomState {
  /** The value the room confirmed for `key`, or `undefined` when nobody has written it. */
  get(key: string): unknown;
  /** Asks the room to store `value`; every member, this one included, gets it back as a `state` event. */
  set(key: string, value: unknown): void;
}

export type RoomEvent = "join" | "leave" | "message" | "state";
export type RoomMessageHandler = (data: unknown, from: string) => void;
export type RoomPeerHandler = (peerId: string) => void;
export type RoomStateHandler = (key: string, value: unknown, from: string) => void;

/** What `welcome` was, narrowed out of the frame union. */
type RoomWelcome = Extract<RoomServerMessage, { readonly t: "welcome" }>;

function readCode(body: Record<string, unknown> | undefined): string {
  const code = body?.code;
  if (typeof code !== "string" || !ROOM_CODE_RE.test(code)) {
    throw new BackendError("room_not_found");
  }
  return code;
}

/** `https://…/_backend` becomes `wss://…/_backend`: the scheme follows the page's. */
function socketUrl(context: IBackendContext, code: string): string {
  const path = `${context.endpoint}/v1/rooms/${encodeURIComponent(code)}`;
  const relative = context.endpoint.startsWith("/");
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  // A relative endpoint off no origin is a page-less runtime: there is nowhere to open a socket.
  if (relative && origin === undefined) throw new BackendError("no_host");
  const url = new URL(relative ? `${origin}${path}` : path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Opens the socket and resolves with the room once its `welcome` arrives: from then on the room,
 * not this promise, owns the socket.
 */
function openRoom(context: IBackendContext, code: string): Promise<Room> {
  return new Promise<Room>((resolve, reject) => {
    const socket = new WebSocket(socketUrl(context, code));
    let room: Room | undefined;
    socket.addEventListener("message", (event) => {
      if (room !== undefined) return;
      const message = parseRoomServerMessage(decodeRoomFrame(event.data));
      if (message?.t !== "welcome") return;
      room = new Room(code, socket, message);
      resolve(room);
    });
    socket.addEventListener("error", () => {
      if (room === undefined) reject(new BackendError("room_not_found"));
    });
    socket.addEventListener("close", () => {
      if (room === undefined) reject(new BackendError("room_not_found"));
    });
  });
}

/**
 * One live room: a socket, its members and the shared state the room has confirmed.
 *
 * @situation play a round of a published game with another player in the same room
 * @situation exchange moves over a relay when a peer-to-peer connection is not available
 * @requires npm i @threenative/backend
 * @example const room = await createBackend().rooms.create({ max: 4 });
 * @example room.send({ move: "e4" }, room.peers[0]);
 */
export class Room {
  /** The code another player types to join: `room.code`. */
  readonly code: string;
  readonly state: IRoomState;
  readonly #socket: WebSocket;
  /** Everyone else in the room; this client's own id is `peerId`. */
  readonly #others = new Set<string>();
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<RoomEvent, Set<(...args: never[]) => void>>();
  #peerId: string;
  #open = true;

  constructor(code: string, socket: WebSocket, welcome: RoomWelcome) {
    this.code = code;
    this.#socket = socket;
    this.#peerId = welcome.peerId;
    for (const peerId of welcome.peers) this.#others.add(peerId);
    for (const [key, value] of Object.entries(welcome.state)) this.#values.set(key, value);
    this.state = {
      get: (key) => this.#values.get(key),
      set: (key, value) => this.#command({ t: "state", key, value }),
    };
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => {
      this.#open = false;
    });
  }

  /** This client's public id in the room, and the `to` another member sends to. */
  get peerId(): string {
    return this.#peerId;
  }

  /** Everyone else here, in the order the room admitted them. */
  get peers(): readonly string[] {
    return [...this.#others];
  }

  /** False once the room was left or the socket dropped. */
  get open(): boolean {
    return this.#open;
  }

  /** Sends `data` to everybody, or to one peer. Throws once the room is closed. */
  send(data: unknown, to?: string): void {
    this.#command({ t: "send", data, to });
  }

  /**
   * Listens for one event and returns its unsubscribe. Handlers run in the room's order: a
   * `message` handler sees the same sequence every member does.
   */
  on(type: "message", handler: RoomMessageHandler): () => void;
  on(type: "join" | "leave", handler: RoomPeerHandler): () => void;
  on(type: "state", handler: RoomStateHandler): () => void;
  on(type: RoomEvent, handler: (...args: never[]) => void): () => void {
    const listeners = this.#listeners.get(type) ?? new Set<(...args: never[]) => void>();
    listeners.add(handler);
    this.#listeners.set(type, listeners);
    return () => {
      listeners.delete(handler);
    };
  }

  /** Tells the room this client is gone, then closes the socket. Peers see a `leave` event. */
  leave(): void {
    if (!this.#open) return;
    try {
      this.#socket.send(JSON.stringify({ t: "leave" } satisfies RoomClientMessage));
    } catch {
      // A socket already closing needs no farewell; the room sees the close anyway.
    }
    this.#open = false;
    this.#listeners.clear();
    this.#socket.close(1000, "left");
  }

  #command(message: RoomClientMessage): void {
    if (!this.#open) throw new BackendError("room_not_found");
    this.#socket.send(JSON.stringify(message));
  }

  #receive(raw: unknown): void {
    const message = parseRoomServerMessage(decodeRoomFrame(raw));
    if (message === undefined || message.t === "welcome") return;
    if (message.t === "join") {
      this.#others.add(message.peerId);
      this.#emit("join", message.peerId);
      return;
    }
    if (message.t === "leave") {
      this.#others.delete(message.peerId);
      this.#emit("leave", message.peerId);
      return;
    }
    if (message.t === "message") {
      this.#emit("message", message.data, message.from);
      return;
    }
    this.#values.set(message.key, message.value);
    this.#emit("state", message.key, message.value, message.from);
  }

  #emit(type: RoomEvent, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

/**
 * The game's rooms: one call to open one, join one or list what is open.
 *
 * @situation add online play to a published game without writing a server
 * @situation let a player host a room another player joins by a six-character code
 * @situation find someone to play with by joining the fullest public room
 * @requires npm i @threenative/backend
 * @example const rooms = createBackend().rooms;
 * @example const room = await rooms.quickJoin();
 * @example const open = await rooms.list();
 */
export class BackendRooms {
  constructor(private readonly context: IBackendContext) {}

  /**
   * Creates a room and joins it. `max` is clamped to `[2, the host's cap]`; a `public` room is
   * listed and can be quick-joined. Resolves with the joined room, whose `code` you share.
   */
  async create(options: IRoomCreateRequest = {}): Promise<Room> {
    if (!(await hosted(this.context))) throw new BackendError("no_host");
    const body = await this.#post("/v1/rooms", { max: options.max, public: options.public });
    return this.join(readCode(body));
  }

  /**
   * Joins the room with this code. Rejects with `room_not_found` when no room has it and
   * `room_full` when it is at its player cap.
   */
  async join(code: string): Promise<Room> {
    if (!(await hosted(this.context))) throw new BackendError("no_host");
    const normalized = code.trim().toUpperCase();
    await this.#check(normalized);
    return openRoom(this.context, normalized);
  }

  /** Joins the fullest public room that is still fresh, or creates a public one at the cap. */
  async quickJoin(): Promise<Room> {
    if (!(await hosted(this.context))) throw new BackendError("no_host");
    const body = await this.#post("/v1/rooms/quick", {});
    return this.join(readCode(body));
  }

  /** The public rooms anyone may join, newest first, capped at `LIST_MAX`. */
  async list(): Promise<readonly IRoomInfo[]> {
    if (!(await hosted(this.context))) throw new BackendError("no_host");
    const response = await this.context.fetch?.(`${this.context.endpoint}/v1/rooms`);
    if (response === undefined || !response.ok) return [];
    const items = (await readJson(response))?.items;
    return Array.isArray(items) ? (items as readonly IRoomInfo[]) : [];
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await send(this.context, "POST", path, body);
    if (response === undefined) throw new BackendError("no_host");
    const parsed = await readJson(response);
    if (!response.ok) throw failureOf(response, parsed);
    return parsed ?? {};
  }

  /**
   * The preflight a browser needs: a failed WebSocket handshake reports no HTTP status, so the
   * typed `room_not_found`/`room_full` answer is taken from this plain request.
   */
  async #check(code: string): Promise<void> {
    const response = await this.context.fetch?.(
      `${this.context.endpoint}/v1/rooms/${encodeURIComponent(code)}`,
    );
    if (response === undefined) throw new BackendError("no_host");
    if (response.ok) return;
    throw failureOf(response, await readJson(response));
  }
}
