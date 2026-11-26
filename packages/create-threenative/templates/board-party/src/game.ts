import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { pushIntent } from "./intents.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // The four directions of `input.vector("move")`. Declared rather than inherited from the
    // default binding, so the axis every scene reads is visible where the game is defined.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Roll, take the shortcut, buy the star, or hop in the rope game.
    confirm: { buttons: [0], keys: ["Space", "Enter", "KeyE", "KeyY"] },
    // Stay on the ring, or leave the star.
    decline: { buttons: [1], keys: ["KeyN", "Escape", "KeyQ"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each sets up one mechanic in one tick (see `STATIONS` in Play.ts).
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
    station10: { keys: ["Digit0"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1998,
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
  if (intent === "restart") {
    void game.goto("play");
    return;
  }
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  if (intent === "confirm" || intent === "decline") pushIntent(intent);
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
