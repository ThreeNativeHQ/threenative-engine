import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { drainPlaytestEvents as events } from "./playtest-events.js";
import { Race } from "./scenes/Race.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState>({
  input: {
    // Steering is the x of `input.vector("move")`: the arrows, A/D or the left stick. No keys on
    // up or down: a vector is normalised, so W held with D would steer at only 0.71.
    move: { up: [], down: [], left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"] },
    accel: { buttons: [0], keys: ["ArrowUp", "KeyW"] },
    brake: { buttons: [1], keys: ["ArrowDown", "KeyS"] },
    // Hop; hold it through a turn to power-slide, wiggle against the slide to charge a mini-turbo.
    drift: { buttons: [5, 7], keys: ["Space", "ShiftLeft", "ShiftRight"] },
    item: { buttons: [4, 6], keys: ["KeyE", "KeyX"] },
    // The player's kart drives itself while this is on (the scenarios use it for whole laps).
    autopilot: { keys: ["KeyP"] },
    restart: { keys: ["KeyR"] },
  },
  plugins: [playtest({ events })],
  display: config.display,
  render: config.renderer,
  scenes: { race: Race },
  seed: 734,
  start: "race",
});

export default game;

/**
 * What the UI can ask the game to do. Intents are one-way: the UI sends `restart`, `pause` or
 * `resume`, and reads the game's published state back instead of getting an answer.
 */
game.ui.onIntent((intent) => {
  if (intent === "restart") void game.goto("race");
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
