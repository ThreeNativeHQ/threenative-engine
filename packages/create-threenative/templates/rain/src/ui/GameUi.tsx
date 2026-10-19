import { UiLayer, useUiIntent, useUiState } from "@threenative/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type GameState, VISIBILITY_INTENT } from "../state.js";
import { Hud, captureScene, toggleFullscreen } from "./Hud.js";
import { LoadingOverlay } from "./LoadingOverlay.js";
import { Menu } from "./Menu.js";
import { automationRequest } from "./automation.js";

const TOAST_MS = 3600;
/** Preserve the source study's one-time window-width default on hardware. */
const NARROW_PX = 700;

export function GameUi() {
  return (
    <UiLayer>
      <RainInterface />
    </UiLayer>
  );
}

/**
 * The interface, and the three things that are behaviour rather than markup.
 *
 * `useUiState` and `useUiIntent` need the bridge `UiLayer` opened, so they live in this inner
 * component rather than in `GameUi` itself — a hook above the provider throws. Everything the page
 * does that is not a control lives here: the status toast, the keyboard, and the two one-time
 * defaults that have to be applied against a real snapshot rather than guessed at mount.
 */
function RainInterface() {
  const state = useUiState<GameState>();
  const send = useUiIntent();
  const [toast, setToast] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const say = useCallback((text: string) => {
    setToast(text);
    setToastVisible(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /** Photosensitivity mode; the intent itself also takes automatic lightning down. */
  const setSafeMode = useCallback((on: boolean) => send("setSafe", on), [send]);

  /**
   * The status line, said on what the game reports rather than on what a control asked for: a
   * shortcut from the game's input map and a click on the panel change the same state, so both are
   * announced the same way, and a strike reads its distance and delay off the strike itself.
   */
  const previous = useRef<GameState | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (state === undefined || before === undefined) return;
    const soundOn = state.audioEnabled && !state.muted;
    if (state.safe !== before.safe)
      say(state.safe ? "LIGHTNING DISABLED · photosensitivity mode" : "Lightning flashes enabled");
    if (state.paused !== before.paused)
      say(state.paused ? "SIMULATION PAUSED" : "SIMULATION RESUMED");
    if (soundOn !== (before.audioEnabled && !before.muted))
      say(soundOn ? "Stereo rain, wind and distance-delayed thunder enabled" : "Sound muted");
    if (state.strikes > before.strikes) {
      const { delay, metres } = state.lastStrike;
      say(
        `LIGHTNING · ${(metres / 1000).toFixed(2)} km${soundOn ? ` · thunder in ${delay.toFixed(1)} s` : ""}`,
      );
    }
  }, [say, state]);

  const toggleAutoLightning = useCallback(() => {
    if (state?.safe === true) {
      say("Disable photosensitivity mode first to enable lightning.");
      return;
    }
    send("setAutoLightning", state?.autoLightning !== true);
  }, [say, send, state?.autoLightning, state?.safe]);

  /**
   * The keyboard, and only the keys that are browser APIs. Everything else — `W A S D`, `Q E`,
   * `Shift`, `R`, `L`, `X`, `H`, `M` and `Space` — is the game's input map, which a native host
   * delivers too; handling them here as well would act twice per press.
   */
  useEffect(() => {
    if (state === undefined) return;
    const actions: Record<string, () => void> = {
      KeyF: () => void toggleFullscreen(say),
      KeyP: () => {
        void captureScene(say).catch((why: Error) => say(`Scene image failed: ${why.message}`));
      },
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        send("closeHelp");
        return;
      }
      // A focused slider, select or text field owns its own keys.
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (event.repeat) return;
      const run = actions[event.code];
      if (run === undefined) return;
      // Space scrolls the page and the shortcuts must not reach the browser's own bindings.
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [say, send, state]);

  /**
   * Tab visibility, held in the UI realm because `document` is a browser API: this is the only
   * place that knows whether the frame is still on screen, and a hidden tab stops the engine loop,
   * so nothing in a scene frame would ever notice. Separate from the pause intent on purpose — the
   * two clear independently, and a tab that comes back must not resume a paused storm.
   */
  useEffect(() => {
    const report = () => send(VISIBILITY_INTENT, document.hidden);
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [send]);

  /**
   * Reduced motion, read in the UI realm and applied once. A reader who then flips a switch has
   * said something newer than their operating system, so the preference is never re-applied over a
   * snapshot — which is also why it needs a ref rather than an effect dependency.
   */
  const reducedApplied = useRef(false);
  useEffect(() => {
    if (state === undefined || reducedApplied.current) return;
    reducedApplied.current = true;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    send("setSafe", true);
    send("setAutoLightning", false);
    send("setCinematic", false);
  }, [send, state]);

  /** Scene loading owns the default; the query and later player choices override it. */
  const qualityChosen = useRef(false);
  useEffect(() => {
    if (state === undefined || state.softwareRendering === undefined || qualityChosen.current)
      return;
    qualityChosen.current = true;
    // An operator asking for high on a phone or software adapter keeps that explicit choice.
    const asked = automationRequest(window.location.search).quality;
    if (asked !== undefined) {
      send("setQuality", asked);
      return;
    }
    if (state.qualityExplicit === true || state.softwareRendering) return;
    send("setQuality", window.innerWidth < NARROW_PX ? "performance" : "high");
  }, [send, state]);

  // Nothing yet from the game, so nothing is claimed: the engine's own loading screen is still up.
  if (state === undefined) return null;

  // Until the storm is ready, the curtain is all there is, as in the study: no controls over a
  // world that is not on screen yet.
  if (!state.loading.ready)
    return <LoadingOverlay progress={state.loading.progress} ready={false} />;

  return (
    <>
      <Hud
        panelOpen={panelOpen}
        say={say}
        send={send}
        setPanelOpen={setPanelOpen}
        state={state}
        toast={toast}
        toastVisible={toastVisible}
      />
      <Menu
        panelOpen={panelOpen}
        say={say}
        send={send}
        setPanelOpen={setPanelOpen}
        setSafeMode={setSafeMode}
        state={state}
        toggleAutoLightning={toggleAutoLightning}
      />
      <LoadingOverlay progress={state.loading.progress} ready={state.loading.ready} />
    </>
  );
}
