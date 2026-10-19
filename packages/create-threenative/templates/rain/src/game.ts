import { type IGame, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { UI_READY_INTENT } from "@threenative/core/ui-layer";
import config from "../threenative.config.js";
import { type IStormAudio, STORM_AUDIO_ENTITY } from "./audio/storm.js";
import { Coast } from "./scenes/Boot.js";
import { type GameState, VISIBILITY_INTENT, intentPatch } from "./state.js";

const game = defineGame<GameState>({
  input: {
    ascend: { keys: ["KeyE"] },
    boost: { keys: ["ShiftLeft", "ShiftRight"] },
    descend: { keys: ["KeyQ"] },
    // The drag's own motion, sampled at the tick. No click capture: the study looks by dragging,
    // and a locked pointer would take the cursor away from the panel beside it.
    look: { captureOnClick: false, pointerRelative: true },
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // The study's own shortcuts live here, in the game's input map, rather than in a browser
    // keydown listener: on a native host the interface is a web view that never has keyboard
    // focus, so a shortcut only the UI realm hears is a shortcut native players do not have.
    // F (fullscreen) and P (save image) stay in the UI realm because both are browser APIs.
    hideUi: { keys: ["KeyH"] },
    pause: { keys: ["Space"] },
    resetCamera: { keys: ["KeyR"] },
    safe: { keys: ["KeyX"] },
    sound: { keys: ["KeyM"] },
    strike: { keys: ["KeyL"] },
  },
  plugins: [playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { coast: Coast },
  seed: 607,
  start: "coast",
});

export default game;

game.ui.onIntent((intent, payload) => {
  // The framework's own "my tree has rendered" signal, and the one control that is not a player's:
  // it arrives on the same door but carries no weather, so it is answered before the validator
  // ever sees it. `uiReady` mirrors `game.ui.connected` rather than being set optimistically, so a
  // UI that never came up leaves the loading study up instead of hiding it over nothing.
  if (intent === UI_READY_INTENT) {
    game.state.set({ uiReady: game.ui.connected });
    game.state.flush();
    return;
  }
  // The two audio holds, answered at the door: a hidden tab stops the loop, so nothing in `Boot.ts`
  // runs to notice it, and the pause hold has to land on the same edge as the press. Neither is a
  // weather intent and neither needs a state field of its own.
  const storm = (): IStormAudio | undefined =>
    game.ctx?.entities.get<IStormAudio>(STORM_AUDIO_ENTITY);
  if (intent === "pause" || intent === "resume") storm()?.setSilenced(intent === "pause");
  if (intent === VISIBILITY_INTENT) {
    if (typeof payload !== "boolean") {
      console.warn(`TN_RAIN_INTENT ${intent}: expected a boolean payload`);
      return;
    }
    storm()?.setHidden(payload);
    return;
  }
  let patch: Partial<GameState>;
  try {
    patch = intentPatch(intent, payload, game.state.getState().target);
  } catch (why) {
    // Reported and dropped rather than thrown: one malformed control must not take the gesture
    // flow down with it, and the rejection is visible in the console where the next agent looks.
    console.warn(`TN_RAIN_INTENT ${intent}: ${(why as Error).message}`);
    return;
  }
  game.state.set(patch);
  // The frame loop flushes too, but a control must feel instant: a slider that waits for the next
  // frame reads as a dropped drag.
  game.state.flush();
});
