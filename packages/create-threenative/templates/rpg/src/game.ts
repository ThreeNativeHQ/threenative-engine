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
    // The leader runs by default, as in the reference; hold Shift to walk.
    walk: { buttons: [5], keys: ["ShiftLeft", "ShiftRight"] },
    // Queue an attack on the target, a medpack on the weakest member, or a talk with the nearest villager.
    attack: { buttons: [0], keys: ["KeyF", "Space"] },
    heal: { buttons: [2], keys: ["KeyG"] },
    talk: { buttons: [1], keys: ["KeyE"] },
    target: { buttons: [3], keys: ["KeyT"] },
    rotate: { buttons: [4], keys: ["KeyQ"] },
    journal: { buttons: [8], keys: ["KeyJ"] },
    leave: { keys: ["Escape"] },
    choice1: { keys: ["Digit1"] },
    choice2: { keys: ["Digit2"] },
    choice3: { keys: ["Digit3"] },
    choice4: { keys: ["Digit4"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations (F1 to F12): teleports and rigged dice, see `STATIONS` in Play.ts. They
    // answer only under a playtest runner (`UNDER_PLAYTEST`), never in a real build.
    // They exist so a scenario proves one mechanic in a few ticks; delete them with the playtests.
    station1: { keys: ["F1"] },
    station2: { keys: ["F2"] },
    station3: { keys: ["F3"] },
    station4: { keys: ["F4"] },
    station5: { keys: ["F5"] },
    station6: { keys: ["F6"] },
    station7: { keys: ["F7"] },
    station8: { keys: ["F8"] },
    station9: { keys: ["F9"] },
    station10: { keys: ["F10"] },
    station11: { keys: ["F11"] },
    station12: { keys: ["F12"] },
    station13: { keys: ["Digit7"] },
    station14: { keys: ["Digit8"] },
    station15: { keys: ["Digit9"] },
    station16: { keys: ["Digit0"] },
    station17: { keys: ["Digit5"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1977,
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
