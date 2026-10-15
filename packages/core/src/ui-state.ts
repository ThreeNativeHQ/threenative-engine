import {
  GAME_STATE_MESSAGE,
  type IUiBridge,
  type IUiMessage,
  UI_INTENT_MESSAGE,
  postUiState,
  serializeUiState,
} from "./ui-bridge.js";

/**
 * What crosses the bridge, in both directions: published state out, intents back.
 *
 * The UI is a different realm from the game on every native target, so it cannot hold the game
 * object, subscribe to its store, or call its methods. It holds a **mirror** — the last state
 * the game published — and it sends **intents**, which the game is free to ignore.
 *
 * That asymmetry is deliberate and it is what keeps one `src/ui/` honest. A HUD written against
 * a live store works on web and silently has nothing to read on a phone; a HUD written against
 * the mirror behaves identically on both, because on web the mirror is fed by the same
 * publication through an in-process channel.
 *
 * Publications are **coalesced**: many simulation writes produce one state message per rendered
 * frame. React consumes that snapshot in the UI realm, independently of the game's render work.
 */

/**
 * The minimum a store must offer to be published.
 *
 * `getPublishedState` is optional and preferred when present: ThreeNative's game store keeps a
 * live `getState()` that moves every tick and a stable `getPublishedState()` snapshot published
 * once per rendered frame, unless the game selected a slower `stateFlushMs` interval.
 */
export interface IPublishableStore<T> {
  getState(): T;
  getPublishedState?(): T;
  subscribe(listener: () => void): () => void;
}

export interface IUiStatePublisher {
  /** Send the current state now, whether or not it changed. */
  publish(): void;
  /** Stop publishing. The mirror keeps whatever it last received. */
  stop(): void;
}

export interface IUiStateMirror<T> {
  /** The last state the game published, or undefined before the first frame arrives. */
  get(): T | undefined;
  /** Called after each accepted publication. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Stop listening. */
  stop(): void;
}

interface IPublishOptions {
  /**
   * How a coalesced publication is deferred. Defaults to a microtask, which collapses every
   * write in one turn into one frame. A game with a chatty store may pass a frame scheduler.
   */
  readonly schedule?: (flush: () => void) => void;
}

const microtask = (flush: () => void): void => {
  void Promise.resolve().then(flush);
};

/**
 * Publish a store to the UI over `bridge`.
 *
 * Only the `game` end publishes: the UI is a mirror, and a UI that could write the game's state
 * directly would be a second source of truth that only diverges on the platform where the two
 * are actually separate processes.
 * @situation publish game state to a HUD in another realm
 * @situation keep a web and native UI mirror on the same coalesced state stream
 * @example const publisher = publishUiState(bridge, store);
 */
export function publishUiState<T>(
  bridge: IUiBridge,
  store: IPublishableStore<T>,
  options: IPublishOptions = {},
): IUiStatePublisher {
  if (bridge.end !== "game") {
    throw new Error(
      `TN_UI_STATE_WRONG_END: state is published by the 'game' end, not '${bridge.end}'.`,
    );
  }
  const schedule = options.schedule ?? microtask;
  const read = (): T =>
    store.getPublishedState === undefined ? store.getState() : store.getPublishedState();
  let stopped = false;
  let queued = false;
  let lastFrame = "";

  const send = (state: T, frame: string): void => {
    lastFrame = frame;
    postUiState(bridge, state, frame);
  };

  const publish = (): void => {
    if (stopped) return;
    const state = read();
    send(state, serializeUiState(state));
  };

  const flush = (): void => {
    queued = false;
    if (stopped) return;
    // Nothing is listening — a `native` renderer, or an overlay that has not come up. Serialising
    // the whole store several times a second for no reader is exactly the cost acceptance
    // criterion 5 says a game that did not opt in must not pay.
    if (!bridge.hasPeer()) return;
    // Skip a publication that would carry the bytes the UI already has. A store that writes the
    // same value every tick is common and must not become a message per tick.
    const state = read();
    const frame = serializeUiState(state);
    if (frame === lastFrame) return;
    send(state, frame);
  };

  const unsubscribe = store.subscribe(() => {
    if (stopped || queued) return;
    queued = true;
    schedule(flush);
  });

  if (bridge.hasPeer()) publish();
  return {
    publish,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}

/**
 * Mirror the game's published state on the UI end.
 *
 * Fail closed: a `tn:state` frame with no `state` object throws rather than leaving the mirror
 * showing stale values, which is the failure mode where a HUD keeps displaying the last health
 * it saw and nobody can tell it stopped updating.
 * @situation read published game state from a UI HUD
 * @situation subscribe a web or native UI to the game's mirrored state
 * @example const mirror = subscribeUiState<{ health: number }>(bridge);
 */
export function subscribeUiState<T>(bridge: IUiBridge): IUiStateMirror<T> {
  if (bridge.end !== "ui") {
    throw new Error(
      `TN_UI_STATE_WRONG_END: state is mirrored by the 'ui' end, not '${bridge.end}'.`,
    );
  }
  const listeners = new Set<() => void>();
  let current: T | undefined;
  const off = bridge.onMessage((message) => {
    if (message.type !== GAME_STATE_MESSAGE) return;
    const state = message.state;
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Error("TN_UI_STATE_FRAME_INVALID: a published state frame must carry an object.");
    }
    current = state as T;
    for (const listener of [...listeners]) listener();
  });
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      off();
      listeners.clear();
    },
  };
}

/**
 * Send one intent from the UI to the game. The game may ignore it; that is not an error.
 * @situation send a button or menu action from a UI HUD to game code
 * @situation keep UI input portable across web and native hosts
 * @example sendUiIntent(bridge, "restart");
 */
export function sendUiIntent(bridge: IUiBridge, intent: string, payload?: unknown): void {
  if (bridge.end !== "ui") {
    throw new Error(
      `TN_UI_INTENT_WRONG_END: intents are sent by the 'ui' end, not '${bridge.end}'.`,
    );
  }
  if (typeof intent !== "string" || intent.length === 0) {
    throw new Error("TN_UI_INTENT_INVALID: an intent needs a non-empty name.");
  }
  bridge.post({
    type: UI_INTENT_MESSAGE,
    intent,
    ...(payload === undefined ? {} : { payload }),
  } as IUiMessage);
}

/**
 * Receive UI intents on the game end. Returns an unsubscribe function.
 * @situation handle a HUD button action in game code
 * @situation route native and web UI commands through one listener
 * @example const stop = onUiIntent(bridge, (intent) => handleIntent(intent));
 */
export function onUiIntent(
  bridge: IUiBridge,
  listener: (intent: string, payload: unknown) => void,
): () => void {
  if (bridge.end !== "game") {
    throw new Error(
      `TN_UI_INTENT_WRONG_END: intents are received by the 'game' end, not '${bridge.end}'.`,
    );
  }
  return bridge.onMessage((message) => {
    if (message.type !== UI_INTENT_MESSAGE) return;
    if (typeof message.intent !== "string" || message.intent.length === 0) {
      throw new Error("TN_UI_INTENT_INVALID: an intent frame must carry a non-empty name.");
    }
    listener(message.intent, message.payload);
  });
}
