import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { drainPlaytestEvents as events } from "./playtest-events.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // The four directions of `input.vector("move")`, read relative to the camera in `Hero.ts`.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    jump: { buttons: [0], keys: ["Space"] },
    // Crouch on the ground (backflip, long jump), ground pound in the air.
    crouch: { buttons: [6, 7], keys: ["ShiftLeft", "ShiftRight", "KeyC"] },
    // Dive at speed.
    attack: { buttons: [2], keys: ["KeyX", "KeyJ"] },
  },
  plugins: [rapier({ gravity: { x: 0, y: -36, z: 0 } }), playtest({ events })],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  // The course is procedural; the seed makes its rocks, grass and coin wobble the same every run.
  seed: 6402,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do. Intents are one-way: the UI sends `restart`, `pause` or
 * `resume`, and reads the game's published state back instead of getting an answer.
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
