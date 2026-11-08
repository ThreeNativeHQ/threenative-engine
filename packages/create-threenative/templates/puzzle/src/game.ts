import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

// game.state is the single store: the fixed-step loop writes it, and React/playtests read it.
const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // The four directions of `input.vector("move")`. Arrows are what the sealed proof presses;
    // WASD is here so a human plays the same game.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // V runs the vault twice on the same scripted input and reports whether it landed the same.
    verify: { keys: ["KeyV"] },
    restart: { keys: ["KeyR"] },
  },
  plugins: [rapier(), playtest()],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 6132,
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
    // `game.ui.connected` is true only once the UI announced itself, which is what tells an
    // overlay that never came up apart from a game whose HUD is simply empty.
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
