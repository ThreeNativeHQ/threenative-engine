import {
  type IUiBridge,
  type IUiStateMirror,
  UI_READY_INTENT,
  connectUiBridge,
  publishHitRegions,
  sendUiIntent,
  subscribeUiState,
} from "@threenative/core/ui-layer";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * The root of a game's UI, on every target.
 *
 * A game writes `src/ui/` once. On the web target it renders into the page beside the canvas;
 * on a native target the same bundle renders in the platform's own browser-class renderer,
 * composited over the game surface. Both go through the same two channels — the game's
 * published state in, the player's intents out — so a HUD cannot accidentally work in one
 * place and not the other.
 *
 * This component owns three things a game should never write itself: connecting the bridge,
 * mirroring the published state, and publishing the interactive rectangles the native input
 * host needs in order to decide which surface a touch belongs to.
 */

interface IUiLayerValue {
  readonly bridge: IUiBridge;
  readonly mirror: IUiStateMirror<Record<string, unknown>>;
}

const UiLayerContext = createContext<IUiLayerValue | undefined>(undefined);

interface IStopHandle {
  readonly stop: () => void;
}

function useUiLayer(name: string): IUiLayerValue {
  const value = useContext(UiLayerContext);
  if (value === undefined) {
    throw new Error(`TN_UI_LAYER_MISSING: ${name} must be used inside <UiLayer>.`);
  }
  return value;
}

export function UiLayer({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<IUiLayerValue | undefined>(undefined);
  const registryRef = useRef<IStopHandle | undefined>(undefined);
  useEffect(() => {
    const bridge = connectUiBridge({ end: "ui" });
    const mirror = subscribeUiState<Record<string, unknown>>(bridge);
    setValue({ bridge, mirror });
    return () => {
      // Teardown order is load-bearing: the region registry must publish its empty set on an
      // open bridge — a host still holding the last snapshot would keep eating touches over a
      // UI that is gone — before the bridge closes underneath it.
      registryRef.current?.stop();
      registryRef.current = undefined;
      mirror.stop();
      bridge.close();
      setValue(undefined);
    };
  }, []);
  useEffect(() => {
    if (value === undefined) return;
    // Started after the first commit, so the first publication measures a UI that has rendered.
    // A registry started before the tree exists publishes an empty set, and an empty set means
    // every touch falls through to the game — a HUD whose buttons all look dead.
    const registry = publishHitRegions({ bridge: value.bridge });
    registryRef.current = registry;
    // Announce the UI once it has rendered AND published, so the game can tell an overlay that
    // never came up from one that came up empty. Sent by the framework rather than left to each
    // game, because a game that forgets it has no way to notice.
    sendUiIntent(value.bridge, UI_READY_INTENT, registry.regions().length);
    return () => {
      registryRef.current = undefined;
    };
  }, [value]);
  if (value === undefined) return null;
  return <UiLayerContext.Provider value={value}>{children}</UiLayerContext.Provider>;
}

/**
 * Read a slice of the game's published state.
 *
 * The UI holds a mirror, never the game object: on every native target the game is in another
 * realm, and a HUD written against a live store would work on web and read nothing on a phone.
 * The mirror is fed at the store's published cadence, which is not the game loop.
 *
 * **Reads `undefined` while the loading cover is up**, so a HUD cannot draw over the loading bar
 * and no game writes a `loaded` field to prevent it. A UI that draws its own loading screen reads
 * through `useUiStateDuringStartup`.
 */
export function useUiState<TState extends object>(): TState | undefined;
export function useUiState<TState extends object, TSelected>(
  selector: (state: TState) => TSelected,
): TSelected | undefined;
export function useUiState<TState extends object, TSelected>(
  selector?: (state: TState) => TSelected,
): TSelected | TState | undefined {
  return useMirrorState("useUiState", true, selector);
}

const reportedOverrides = new Set<string>();

/**
 * The named override of `useUiState`'s loading-cover gate, for a UI that draws the loading screen
 * itself (a staged overlay reading the startup progress the game publishes). It reads state while
 * the cover is up. `reason` is required and reported once as `TN_UI_STARTUP_OVERRIDE <reason>`,
 * so a HUD that merely skipped the gate shows up in the log.
 */
export function useUiStateDuringStartup<TState extends object>(options: {
  readonly reason: string;
}): TState | undefined;
export function useUiStateDuringStartup<TState extends object, TSelected>(
  options: { readonly reason: string },
  selector: (state: TState) => TSelected,
): TSelected | undefined;
export function useUiStateDuringStartup<TState extends object, TSelected>(
  options: { readonly reason: string },
  selector?: (state: TState) => TSelected,
): TSelected | TState | undefined {
  const reason = options.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      "TN_UI_STARTUP_OVERRIDE_REASON: useUiStateDuringStartup needs a non-empty reason.",
    );
  }
  if (!reportedOverrides.has(reason)) {
    reportedOverrides.add(reason);
    console.info(`TN_UI_STARTUP_OVERRIDE ${reason}`);
  }
  return useMirrorState("useUiStateDuringStartup", false, selector);
}

function useMirrorState<TState extends object, TSelected>(
  name: string,
  hideWhileCovered: boolean,
  selector?: (state: TState) => TSelected,
): TSelected | TState | undefined {
  const { mirror } = useUiLayer(name);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  return useSyncExternalStore(
    (onChange) => mirror.subscribe(onChange),
    () => {
      if (hideWhileCovered && mirror.covered()) return undefined;
      const state = mirror.get() as TState | undefined;
      if (state === undefined) return undefined;
      // No selector reads the whole snapshot, which is what a HUD that shows several fields
      // wants and what `useGameState(game, (value) => value)` used to give it.
      return selectorRef.current === undefined ? state : selectorRef.current(state);
    },
    () => undefined,
  );
}

/**
 * Send an intent to the game — `restart`, `pause`, whatever the game named.
 *
 * Intents are one-way and the game may ignore one; that is not an error. Anything the UI needs
 * back arrives as published state, which keeps a single source of truth on the side that owns
 * the simulation.
 */
export function useUiIntent(): (intent: string, payload?: unknown) => void {
  const { bridge } = useUiLayer("useUiIntent");
  return useMemo(
    () => (intent: string, payload?: unknown) => sendUiIntent(bridge, intent, payload),
    [bridge],
  );
}
