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
    // Mouse look, as a relative axis. The framework owns the pointer lock and the per-tick delta.
    look: { pointerRelative: true },
    fire: { buttons: [7], keys: ["Space"], mouseButtons: [0] },
    // Down the sights: the right mouse button, or F where a laptop has none.
    aim: { buttons: [6], keys: ["KeyF"], mouseButtons: [2] },
    reload: { buttons: [2], keys: ["KeyR"] },
    grenade: { buttons: [5], keys: ["KeyG"] },
    // Sprint is a time budget: hold it while moving forward.
    sprint: { buttons: [10], keys: ["ShiftLeft", "ShiftRight"] },
    // Stances toggle: the same key again stands up.
    crouch: { buttons: [1], keys: ["KeyC", "ControlLeft"] },
    prone: { buttons: [3], keys: ["KeyZ"] },
    restart: { buttons: [9], keys: ["Enter", "NumpadEnter"] },
    // Playtest stations and the playtest damage key (see `src/stations.ts`).
    // They answer only under a playtest runner, never in a real build.
    station1: { keys: ["Digit1"] },
    station2: { keys: ["Digit2"] },
    station3: { keys: ["Digit3"] },
    station4: { keys: ["Digit4"] },
    station5: { keys: ["Digit5"] },
    hurt: { keys: ["Digit8"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 2007,
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
