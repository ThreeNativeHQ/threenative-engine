import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { BUTTONS } from "./rhythm/buttons.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, undefined>({
  input: {
    // One action per answer button, from the one table in `rhythm/buttons.ts`: keyboard and pad.
    ...Object.fromEntries(
      BUTTONS.map(({ action, keys, pad }) => [action, { buttons: [...pad], keys: [...keys] }]),
    ),
    restart: { buttons: [9], keys: ["KeyR"] },
  },
  plugins: [playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1999,
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
