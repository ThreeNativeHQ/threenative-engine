import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
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
    ability: { buttons: [1], keys: ["KeyE"] },
    attack: { buttons: [0], keys: ["Space", "KeyF"] },
    damage: { keys: ["KeyH"] },
    dodge: { keys: ["ShiftLeft", "ShiftRight"] },
    dropProbe: { keys: ["KeyT"] },
    equip: { keys: ["KeyQ"] },
    fill: { keys: ["KeyP"] },
    lethal: { keys: ["KeyX"] },
    loot: { keys: ["KeyL"] },
    restart: { keys: ["KeyR"] },
    save: { keys: ["KeyC"] },
    unequip: { keys: ["KeyU"] },
  },
  plugins: [rapier({ gravity: { x: 0, y: 0, z: 0 } }), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  seed: 93093,
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
