import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { pushIntent } from "./intents.js";
import { drainPlaytestEvents as events } from "./playtest-events.js";
import { Battle } from "./scenes/Battle.js";
import { Boot } from "./scenes/Boot.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    cancel: { keys: ["Escape"] },
    help: { keys: ["KeyH"] },
    autosend: { keys: ["KeyN"] },
    launch: { keys: ["Space"] },
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    orbit: { mouseButtons: [2] },
    pause: { keys: ["KeyP"] },
    recycle: { keys: ["KeyX"] },
    restart: { keys: ["KeyR"] },
    safeBuild: { keys: ["KeyB"] },
    speed: { keys: ["KeyG"] },
    strike: { keys: ["KeyF"] },
    tower1: { keys: ["Digit1"] },
    tower2: { keys: ["Digit2"] },
    tower3: { keys: ["Digit3"] },
    tower4: { keys: ["Digit4"] },
    turnLeft: { keys: ["KeyQ"] },
    turnRight: { keys: ["KeyE"] },
    upgrade: { keys: ["KeyU"] },
    zoom: { scroll: true },
  },
  // Nothing in this game falls: the towers only *ask* who is in range, and the walkers follow a
  // curve. The world still needs a solver to answer those questions, so gravity is simply zero.
  plugins: [rapier({ gravity: { x: 0, y: 0, z: 0 } }), playtest({ events })],
  display: config.display,
  renderer: config.renderer,
  scenes: { battle: Battle, boot: Boot },
  seed: 47021,
  start: "boot",
});

export default game;

/**
 * What the UI can ask the game to do.
 *
 * Intents are one-way and named by the game: the UI sends `arm`, `launch`, `upgrade`, `recycle`,
 * `target`, `speed`, `pause`, `strike`, `restart` and the game decides what each means. Nothing
 * comes back this way — the UI reads the game's published state instead, which keeps one source
 * of truth on the side that owns the simulation. The listener only files the request; the scene
 * reads it inside its own frame, where changing the world is safe.
 */
game.ui.onIntent((intent, payload) => {
  if (intent === "restart") {
    void game.goto("battle");
    return;
  }
  pushIntent(intent, payload);
  game.state.set({
    // `game.ui.connected` is true only once the UI announced itself, which is what tells an
    // overlay that never came up apart from a game whose HUD is simply empty.
    uiReady: game.ui.connected,
  });
  game.state.flush();
});
