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
    // On foot the stick walks camera-relative; in a car W/S are the pedals and A/D the wheel.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Mouse motion turns the camera; a click on the canvas captures the pointer.
    look: { pointerRelative: true },
    sprint: { buttons: [1], keys: ["ShiftLeft", "ShiftRight"] },
    // Fire punches bare-handed and shoots with the pistol out; in a car, Space is the handbrake.
    fire: { buttons: [7], keys: ["Space", "KeyJ"], mouseButtons: [0] },
    // Hold to lock on to the nearest target ahead (the pistol must be out).
    aim: { buttons: [6], keys: ["KeyE"], mouseButtons: [2] },
    weapon: { buttons: [3], keys: ["KeyQ"] },
    enter: { buttons: [2], keys: ["KeyF", "Enter"] },
    handbrake: { buttons: [0], keys: ["Space"] },
    restart: { keys: ["KeyR"] },
    // Playtest stations: each key sets up one mechanic (see `STATIONS` in systems/World.ts).
    // They answer only under a playtest runner, never in a real build; delete them with the playtests.
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
    station11: { keys: ["Minus"] },
    station12: { keys: ["Equal"] },
    station13: { keys: ["BracketRight"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 30_301,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do. Intents are one-way: the UI sends `restart`, `pause` or
 * `resume` and reads the game's published state back, so the simulation stays the one truth.
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
