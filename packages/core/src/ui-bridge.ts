/**
 * The UI bridge — one message channel between the game and the UI, identical on every host.
 *
 * The UI runs in the platform's own browser-class renderer (a `WebView` on Android, a
 * `WKWebView` on iOS, a child web view on desktop) while the game runs in the native
 * runtime beside it. They are two JavaScript realms in, usually, two processes, so
 * everything that crosses is a message.
 *
 * Every host already offers a `MessagePort`-shaped primitive — `addWebMessageListener` on
 * Android, `WKScriptMessageHandler` on iOS, an IPC handler on desktop — so this file adopts
 * that shape rather than inventing one, and each host only has to fill in two slots:
 *
 * - **outbound**, a function that takes one JSON string;
 * - **inbound**, a global the host calls with one JSON string.
 *
 * On the web target there is no host and no second realm: the game and the UI are the same
 * page, so both ends connect to an in-process broker and the same `src/ui/` code runs
 * unchanged. That is the whole point — the transport differs, the protocol does not.
 *
 * Fail closed: a message that is not a JSON object with a string `type` throws on the way
 * out, and a malformed frame throws on the way in. A dropped message is a UI that silently
 * stops updating, which is the failure this refuses to have.
 */

/** Which side of the bridge a caller is on. `ui` runs in the web view; `game` in the runtime. */
export type UiBridgeEnd = "game" | "ui";

/** How a connected bridge actually moves bytes. Reported, never chosen by a game. */
export type UiBridgeTransport = "host" | "in-process";

/** Every frame on the bridge is a JSON object whose `type` names it. */
export interface IUiMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface IUiBridge {
  /** Which end this handle is. */
  readonly end: UiBridgeEnd;
  /** `host` when a platform channel was found, `in-process` on the web target. */
  readonly transport: UiBridgeTransport;
  /**
   * Whether anything is listening on the other end.
   *
   * A game whose UI renderer is `native` has no peer and never will, and publishing state to
   * nobody is a JSON serialisation of the whole store several times a second for no reader.
   * Reported rather than assumed: on a host transport this asks the host, so it also answers
   * "did the overlay actually come up" honestly.
   */
  hasPeer(): boolean;
  /** Send one message to the other end. Throws if it is not a typed JSON object. */
  post(message: IUiMessage): void;
  /** Listen for messages from the other end. Returns an unsubscribe function. */
  onMessage(listener: (message: IUiMessage) => void): () => void;
  /** Detach every listener and release the host slots this end installed. */
  close(): void;
}

/** The message the UI end publishes whenever its interactive rectangles move. */
export const HIT_REGIONS_MESSAGE = "tn:hit-regions";
/** The message the game end publishes when its shared state changes. */
export const GAME_STATE_MESSAGE = "tn:state";
/** The message the UI end sends when the player acts on a control. */
export const UI_INTENT_MESSAGE = "tn:intent";
/**
 * The scene-shape verdict the game end publishes when it was launched in dev mode.
 *
 * Separate from the state stream because it is not game state: it is the engine's own measurement
 * of the scene, and a game that never asked for dev mode never sends it. No frame rate rides it —
 * the loop's rAF rate reads throttled under a compositor or a virtual display, so a number drawn
 * from it lies in exactly the sessions where somebody is trying to measure.
 */
export const UI_DEV_METRICS_MESSAGE = "tn:dev-metrics";
/**
 * The startup phase the game end publishes: `covered` while the loading cover is up, `ready` from
 * the frame the cover lifts. The UI realm cannot read `ctx.startup`, so this is how `useUiState`
 * knows to return `undefined` until the player can see the page. A game that never sends it (an
 * older core) reads as uncovered.
 */
export const UI_STARTUP_MESSAGE = "tn:startup";
/**
 * The intent the UI layer sends once, when its tree has rendered and its rectangles are published.
 *
 * Namespaced so it cannot collide with a game's own vocabulary, and framework-sent so a game does
 * not have to remember to announce itself. It is what lets "the overlay never came up" be told
 * apart from "the game has no HUD" — two states that look identical in a screenshot.
 */
export const UI_READY_INTENT = "tn:ready";

/**
 * The globals each host fills in. Named here so a host implementation and this file cannot
 * drift: an Android, iOS or desktop host that writes different names has no bridge at all,
 * and a typo is a silent dead channel rather than a build error.
 */
export const UI_BRIDGE_GLOBALS = {
  /** UI end, inbound: the host calls this with one JSON string. */
  uiReceive: "__tnUiReceive",
  /** UI end, outbound: an injected object with `postMessage(string)`. */
  uiHost: "tnHost",
  /** Game end, inbound: the runtime calls this with one JSON string. */
  gameReceive: "__tnUiGameReceive",
  /** Game end, outbound: the runtime installs this and forwards to the web view. */
  gamePost: "__tnUiPost",
} as const;

/**
 * The realm a bridge end installs into.
 *
 * Indexed rather than typed as `Window`, because the host globals it looks for are ones no
 * TypeScript DOM library has heard of and the tests drive it with a plain object.
 */
interface IScope {
  [key: string]: unknown;
}

interface IConnectOptions {
  readonly end: UiBridgeEnd;
  /** The realm to install into. Defaults to `globalThis`; injected by tests and by hosts. */
  readonly scope?: IScope;
}

// Prepared state frames stay internal; ordinary posts always validate and serialise themselves.
const stateFrames = new WeakMap<IUiMessage, string>();

/** @internal Serialise the complete envelope to preserve JSON's `toJSON` key semantics. */
export function serializeUiState(state: unknown): string {
  return assertSendable({ type: GAME_STATE_MESSAGE, state });
}

/** @internal Reuse the publisher's frame without extending the public bridge interface. */
export function postUiState(bridge: IUiBridge, state: unknown, frame: string): void {
  const message = { type: GAME_STATE_MESSAGE, state };
  stateFrames.set(message, frame);
  try {
    bridge.post(message);
  } finally {
    stateFrames.delete(message);
  }
}

function assertSendable(message: IUiMessage): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("TN_UI_BRIDGE_MESSAGE_INVALID: a bridge message must be a JSON object.");
  }
  if (typeof message.type !== "string" || message.type.length === 0) {
    throw new Error("TN_UI_BRIDGE_MESSAGE_INVALID: a bridge message must carry a string 'type'.");
  }
  let frame: string;
  try {
    frame = stateFrames.get(message) ?? JSON.stringify(message);
  } catch (error) {
    throw new Error(
      `TN_UI_BRIDGE_MESSAGE_INVALID: '${message.type}' is not JSON-serialisable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (frame === undefined) {
    throw new Error(`TN_UI_BRIDGE_MESSAGE_INVALID: '${message.type}' serialised to nothing.`);
  }
  return frame;
}

function parseFrame(frame: unknown): IUiMessage {
  const text = typeof frame === "string" ? frame : (frame as { data?: unknown })?.data;
  if (typeof text !== "string") {
    throw new Error("TN_UI_BRIDGE_FRAME_INVALID: expected a JSON string from the host.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `TN_UI_BRIDGE_FRAME_INVALID: not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TN_UI_BRIDGE_FRAME_INVALID: a bridge frame must be a JSON object.");
  }
  if (typeof (parsed as IUiMessage).type !== "string") {
    throw new Error("TN_UI_BRIDGE_FRAME_INVALID: a bridge frame must carry a string 'type'.");
  }
  return parsed as IUiMessage;
}

/**
 * The outbound half, per end. Every host shape reduces to one function taking a JSON string,
 * which is what lets the sibling-layer hosts and an offscreen-texture host share this file.
 */
function findOutbound(scope: IScope, end: UiBridgeEnd): ((frame: string) => void) | undefined {
  if (end === "game") {
    const post = scope[UI_BRIDGE_GLOBALS.gamePost];
    return typeof post === "function" ? (frame) => (post as (f: string) => void)(frame) : undefined;
  }
  const injected = scope[UI_BRIDGE_GLOBALS.uiHost] as { postMessage?: unknown } | undefined;
  if (typeof injected?.postMessage === "function") {
    return (frame) => (injected.postMessage as (f: string) => void)(frame);
  }
  // iOS installs its handlers under `webkit.messageHandlers`; the name is the host's, not ours.
  const webkit = scope.webkit as
    | { messageHandlers?: Record<string, { postMessage?: unknown }> }
    | undefined;
  const handler = webkit?.messageHandlers?.[UI_BRIDGE_GLOBALS.uiHost];
  if (typeof handler?.postMessage === "function") {
    return (frame) => (handler.postMessage as (f: string) => void)(frame);
  }
  const ipc = scope.ipc as { postMessage?: unknown } | undefined;
  if (typeof ipc?.postMessage === "function") {
    return (frame) => (ipc.postMessage as (f: string) => void)(frame);
  }
  return undefined;
}

const BROKER_KEY = "__tnUiBridgeBroker";

interface IInbound {
  readonly receivers: Set<(frame: unknown) => void>;
  readonly dispatch: (frame: unknown) => void;
}

interface IBroker {
  game: Set<(message: IUiMessage) => void>;
  ui: Set<(message: IUiMessage) => void>;
  /** One dispatcher per host inbound global, however many connections share it. */
  inbound: Map<string, IInbound>;
}

function broker(scope: IScope): IBroker {
  const existing = scope[BROKER_KEY] as IBroker | undefined;
  if (existing !== undefined) return existing;
  const created: IBroker = { game: new Set(), ui: new Set(), inbound: new Map() };
  scope[BROKER_KEY] = created;
  return created;
}

/**
 * Install `deliver` as one receiver of a host inbound global.
 *
 * The host calls one global with each frame, so a second connection that simply assigned it would
 * silence the first — a game's own `game.ui` bridge starting after a React host had connected took
 * every click away from the React host. Receivers share one dispatcher instead, and a closed
 * connection removes only itself.
 */
function installInbound(scope: IScope, key: string, deliver: (frame: unknown) => void): () => void {
  const bus = broker(scope);
  let slot = bus.inbound.get(key);
  if (slot === undefined) {
    const receivers = new Set<(frame: unknown) => void>();
    slot = {
      receivers,
      dispatch: (frame) => {
        // One throwing receiver must not starve the others; the first error is rethrown after
        // the loop so the host still logs it.
        let firstError: unknown;
        let failed = false;
        for (const receiver of [...receivers]) {
          try {
            receiver(frame);
          } catch (error) {
            if (!failed) {
              failed = true;
              firstError = error;
            }
          }
        }
        if (failed) throw firstError;
      },
    };
    bus.inbound.set(key, slot);
  }
  slot.receivers.add(deliver);
  scope[key] = slot.dispatch;
  const installed = slot;
  return () => {
    installed.receivers.delete(deliver);
    if (installed.receivers.size === 0 && scope[key] === installed.dispatch) scope[key] = undefined;
  };
}

const LOOPBACK_KEY = "__tnUiLoopback";

/**
 * `?tnUiLoopback=1`: both ends stay in this realm but talk over a `MessageChannel`, so every
 * frame arrives a task later, the hop a game in a worker adds (PRD-752). Installed once, as the
 * host globals, by whichever end connects first; the game and the UI never know.
 */
function installLoopback(scope: IScope): void {
  const search = (scope.location as { search?: unknown } | undefined)?.search;
  if (typeof search !== "string" || new URLSearchParams(search).get("tnUiLoopback") !== "1") return;
  if (scope[LOOPBACK_KEY] !== undefined) return;
  const { port1: gamePort, port2: uiPort } = new MessageChannel();
  const receive = (key: string) => (event: MessageEvent) =>
    (scope[key] as ((frame: unknown) => void) | undefined)?.(event.data);
  gamePort.onmessage = receive(UI_BRIDGE_GLOBALS.gameReceive);
  uiPort.onmessage = receive(UI_BRIDGE_GLOBALS.uiReceive);
  scope[UI_BRIDGE_GLOBALS.gamePost] = (frame: string) => gamePort.postMessage(frame);
  scope[UI_BRIDGE_GLOBALS.uiHost] = { postMessage: (frame: string) => uiPort.postMessage(frame) };
  scope.__tnUiOverlayAttached = () => true;
  scope[LOOPBACK_KEY] = {
    close() {
      gamePort.close();
      uiPort.close();
      for (const key of [UI_BRIDGE_GLOBALS.gamePost, UI_BRIDGE_GLOBALS.uiHost, LOOPBACK_KEY])
        scope[key] = undefined;
      scope.__tnUiOverlayAttached = undefined;
    },
  };
}

/**
 * Connect one end of the bridge.
 *
 * The transport is discovered, never configured: a game asks for `ui` or `game` and gets the
 * platform channel when one exists and the in-process broker when it does not. That is what
 * keeps the backend — which web view, which host API — out of every game's source.
 * @situation connect game code to a platform-owned UI realm
 * @situation share one UI bridge implementation across web, Android, iOS, and desktop
 * @example const bridge = connectUiBridge({ end: "game" });
 */
export function connectUiBridge(options: IConnectOptions): IUiBridge {
  const { end } = options;
  if (end !== "game" && end !== "ui") {
    throw new Error(`TN_UI_BRIDGE_END_INVALID: expected 'game' or 'ui', got '${String(end)}'.`);
  }
  const scope: IScope = options.scope ?? globalThis;
  installLoopback(scope);
  const listeners = new Set<(message: IUiMessage) => void>();
  const deliver = (frame: unknown): void => {
    const message = parseFrame(frame);
    for (const listener of [...listeners]) listener(message);
  };

  const outbound = findOutbound(scope, end);
  const inboundKey = end === "ui" ? UI_BRIDGE_GLOBALS.uiReceive : UI_BRIDGE_GLOBALS.gameReceive;
  let closed = false;

  if (outbound === undefined) {
    // No host channel: the web target, where both ends share one realm.
    const bus = broker(scope);
    const peer = end === "ui" ? "game" : "ui";
    const own = (message: IUiMessage): void => {
      for (const listener of [...listeners]) listener(message);
    };
    bus[end].add(own);
    return {
      end,
      transport: "in-process",
      hasPeer: () => bus[peer].size > 0,
      post(message) {
        // The in-process peer shares this realm, so the frame is round-tripped through JSON
        // anyway: a game must not be able to hand the UI a live object on web and a copy on
        // native, or it will only find out on the phone.
        const frame = assertSendable(message);
        if (closed) throw new Error("TN_UI_BRIDGE_CLOSED: post on a closed bridge.");
        const copy = JSON.parse(frame) as IUiMessage;
        for (const listener of [...bus[peer]]) listener(copy);
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        closed = true;
        listeners.clear();
        bus[end].delete(own);
      },
    };
  }

  const uninstall = installInbound(scope, inboundKey, deliver);
  // Android's injected object also raises `onmessage`; wiring it to the same entry point keeps
  // one inbound path on every host rather than one per host.
  const injected = scope[UI_BRIDGE_GLOBALS.uiHost] as { onmessage?: unknown } | undefined;
  if (end === "ui" && injected !== undefined && typeof injected === "object") {
    injected.onmessage = (event: unknown) => deliver(event);
  }

  return {
    end,
    transport: "host",
    hasPeer() {
      const attached = scope.__tnUiOverlayAttached;
      // Only the game end can ask the host. The UI end is itself the peer the host attached,
      // so if this code is running the overlay exists.
      if (end === "ui") return true;
      return typeof attached === "function" ? (attached as () => boolean)() === true : false;
    },
    post(message) {
      const frame = assertSendable(message);
      if (closed) throw new Error("TN_UI_BRIDGE_CLOSED: post on a closed bridge.");
      outbound(frame);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      uninstall();
      if (end === "ui" && injected !== undefined && typeof injected === "object") {
        injected.onmessage = undefined;
      }
    },
  };
}
