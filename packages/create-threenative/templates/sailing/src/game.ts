import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Boot } from "./scenes/Boot.js";
import { Sailing } from "./scenes/Sailing.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // Three bindings over the same keys, and the split is deliberate.
    //
    // `vector()` ends in `clampLength(0, 1)`, which is exactly right for a thumbstick and exactly
    // wrong for a ship: a stick pushed into a corner is one direction and must not exceed unit
    // length, but a helm and a set of sheets are two independent controls. Read through `move`,
    // holding forward *and* starboard handed the ship 0.707 of each — so the one input a player
    // holds for the entire passage was also the one that could never reach full sail or full
    // rudder, and the ship felt mushy in every turn it ever made.
    //
    // `move` is kept for the touch stick, where the clamp is the correct behaviour.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    /** The helm, on its own axis: hard over is hard over whatever the sails are doing. */
    helm: { left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"] },
    /** The sheets, on their own axis: full sail is full sail whatever the helm is doing. */
    sheets: { down: ["ArrowDown", "KeyS"], up: ["ArrowUp", "KeyW"] },
    // The loss path `playtests/fail.playtest.json` drives; deliberately not in the players' hint.
    capsize: { keys: ["KeyC"] },
    restart: { keys: ["KeyR"] },
  },
  plugins: [rapier({ gravity: { x: 0, y: -9.81, z: 0 } }), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { boot: Boot, sailing: Sailing },
  seed: 23_600,
  start: "boot",
});

export default game;

game.ui.onIntent((intent) => {
  if (intent === "restart") void game.goto("sailing");
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  } as Partial<GameState>);
  game.state.flush();
});
