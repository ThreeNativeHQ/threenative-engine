import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import type { RunnerPhysics } from "./physics.js";
import { Boot } from "./scenes/Boot.js";
import { Run } from "./scenes/Run.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, RunnerPhysics>({
  input: {
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    jump: { keys: ["Space"] },
    restart: { keys: ["KeyR"] },
  },
  // Gravity is zero on purpose: nothing in this game falls. The jump is an authored arc in
  // `Runner`, and the only physics the runner needs is the overlap query its `Area3D` performs.
  // The look is the arena's: `sky.jpg` lights and fogs the scene, the track is the light metre
  // grid, and the accent belongs to obstacles — never to the runner.
  plugins: [rapier({ gravity: { x: 0, y: 0, z: 0 } }), playtest()],
  display: config.display,
  renderer: config.renderer,
  scenes: { boot: Boot, run: Run },
  // The track is built from `ctx.random`, so this seed is the level. Change it for a new one.
  seed: 77_412,
  start: "boot",
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
  if (intent === "restart") void game.goto("run");
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
