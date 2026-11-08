import type { IBootState } from "./game-boot-phase.js";
import type { IGameUi } from "./game.js";
import {
  type IUiBridge,
  UI_READY_INTENT,
  UI_STARTUP_MESSAGE,
  connectUiBridge,
} from "./ui-bridge.js";
import { type IUiStatePublisher, onUiIntent, publishUiState } from "./ui-state.js";

/** The slice of the boot state the UI seam reads and writes. */
export type IGameUiState<TState extends Record<string, unknown>> = Pick<
  IBootState<TState, unknown>,
  "state" | "uiBridge" | "uiReady" | "uiRevealed"
>;

/** The game's UI seam: one bridge, connected on first use, with the state published through it. */
export interface IGameUiSeam {
  /** Connects the bridge once, however many callers ask. */
  connect(): IUiBridge;
  /** Closes the bridge and forgets that a UI was ready or the cover had lifted. */
  disconnect(): void;
  /** What `game.ui` returns; it connects early so a game can register intents before `start()`. */
  facade(): IGameUi;
  /** Tells a waiting page whether the loading cover is still up. */
  postStartup(): void;
}

export function createGameUi<TState extends Record<string, unknown>>(
  boot: IGameUiState<TState>,
): IGameUiSeam {
  let publisher: IUiStatePublisher | undefined;

  const postStartup = (): void => {
    boot.uiBridge?.post({
      type: UI_STARTUP_MESSAGE,
      phase: boot.uiRevealed ? "ready" : "covered",
    });
  };

  const connect = (): IUiBridge => {
    if (boot.uiBridge !== undefined) return boot.uiBridge;
    const bridge = connectUiBridge({ end: "game" });
    boot.uiBridge = bridge;
    // The store already coalesces writes at flush. Deferring this again waits for the native
    // host's next microtask pump, after that frame's WebView event pump has already passed.
    // Ahead of the first state, which `publishUiState` sends at once when a UI is already waiting.
    if (bridge.hasPeer()) postStartup();
    publisher = publishUiState(bridge, boot.state, { schedule: (flush) => flush() });
    onUiIntent(bridge, (intent) => {
      if (intent !== UI_READY_INTENT) return;
      boot.uiReady = true;
      // Before the state: a UI that mounts after the reveal must learn the cover is gone, and one
      // that mounts before it must learn to hide.
      postStartup();
      // Publish immediately: the UI has just rendered against nothing, and waiting for the store's
      // next change would leave a HUD showing its initial values for up to a tick.
      publisher?.publish();
    });
    return bridge;
  };

  const disconnect = (): void => {
    boot.uiRevealed = false;
    publisher?.stop();
    publisher = undefined;
    boot.uiReady = false;
    boot.uiBridge?.close();
    boot.uiBridge = undefined;
  };

  const facade = (): IGameUi => {
    const bridge = connect();
    return {
      get connected() {
        return bridge.hasPeer() && boot.uiReady;
      },
      onIntent: (listener) => onUiIntent(bridge, listener),
      publish: () => publisher?.publish(),
    };
  };

  return { connect, disconnect, facade, postStartup };
}
