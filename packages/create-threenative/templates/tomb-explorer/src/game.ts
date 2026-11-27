import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState>({
  input: {
    // Tank controls, as the reference game has them: up runs, down steps back, left and right turn.
    // The axis is read relative to the explorer, never the screen.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Walking is slow and never steps off an edge.
    walk: { buttons: [5], keys: ["ShiftLeft", "ShiftRight"] },
    // Held: grab a ledge in mid-air, hold a hang, take an item.
    action: { buttons: [2], keys: ["KeyE", "ControlLeft"] },
    // A jump from standing, a running jump, a swim stroke, a dive.
    jump: { buttons: [0], keys: ["Space"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each puts her at a fixed test spot (see `STATIONS` in level.ts).
    // They answer only under a playtest runner, never in a real build.
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
    station10: { keys: ["Digit0"] },
    station11: { keys: ["Minus"] },
  },
  plugins: [playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1996,
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
