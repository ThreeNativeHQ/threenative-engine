import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState>({
  input: {
    // The four directions of `input.vector("move")`. Declared rather than inherited from the
    // default binding, so the axis every scene reads is visible where the game is defined.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Fire: a press shoots, a hold repeats and charges, a release past a third of a second
    // sends the homing shot at whatever the reticle has marked.
    fire: { buttons: [0, 7], keys: ["Space"], mouseButtons: [0] },
    // Boost and brake share one gauge.
    boost: { buttons: [5], keys: ["ShiftLeft", "ShiftRight"] },
    brake: { buttons: [4], keys: ["KeyX", "ControlLeft"] },
    // Hold to bank hard; tap twice to barrel roll, which turns enemy shots back.
    bank: { left: ["KeyQ"], right: ["KeyE"] },
    rollLeft: { buttons: [2], keys: ["KeyQ"] },
    rollRight: { buttons: [1], keys: ["KeyE"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each sets up one test situation (see `scenes/stations.ts`).
    // They answer only under a playtest runner (`UNDER_PLAYTEST`), never in a real build.
    // They exist so a scenario proves one mechanic in a few ticks; delete them with the playtests.
    station1: { keys: ["Digit1"] },
    station2: { keys: ["Digit2"] },
    station3: { keys: ["Digit3"] },
    station4: { keys: ["Digit4"] },
    station5: { keys: ["Digit5"] },
    station6: { keys: ["Digit6"] },
    station7: { keys: ["Digit7"] },
    station8: { keys: ["Digit8"] },
    station9: { keys: ["Digit9"] },
  },
  plugins: [playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1993,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do.
 *
 * Intents are one-way and named by the game: the UI sends `restart`, `pause` or `resume` and the
 * game decides what each means. Nothing comes back this way — the UI reads the game's published
 * state instead, which keeps one source of truth on the side that owns the simulation.
 */
game.ui.onIntent((intent) => {
  if (intent === "restart") void game.goto("play");
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
