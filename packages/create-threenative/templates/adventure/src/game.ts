import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  // Eight names, each one verb. Every scene reads the name, never the key, so a rebinding is one
  // line here. Gamepad buttons are the standard mapping: 0 A, 1 B, 2 X, 3 Y, 5 RB, 6 LT. Mouse
  // buttons: 0 left, 1 middle, 2 right.
  input: {
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    /** Sword slash: J or the gamepad. Needs the Ember Blade from the clearing chest. */
    attack: { buttons: [2], keys: ["KeyJ"] },
    /**
     * Sword slash on the left click, read apart from `attack` because the first click only
     * captures the pointer: `readHeroInput` ignores it until the pointer was already captured.
     */
    slash: { mouseButtons: [0] },
    /** Mouse look: relative movement turns the camera. The first click captures the pointer. */
    look: { pointerRelative: true },
    /** Roll when nothing is locked on; a short hop while locked. */
    action: { buttons: [0], keys: ["Space"] },
    /** Hold to raise the shield: right click, Shift or the right bumper. */
    block: { buttons: [5], keys: ["ShiftLeft", "ShiftRight"], mouseButtons: [2] },
    /** Press to lock onto the nearest hostile; press again for the next, then off. */
    lock: { keys: ["Tab"], mouseButtons: [1] },
    /** Hold to lock onto the nearest hostile; release and press again to move to the next. */
    target: { buttons: [6], keys: ["KeyQ"] },
    /** Open a chest, read a sign, unlock a door. */
    interact: { buttons: [3], keys: ["KeyE"] },
  },
  plugins: [rapier(), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  seed: 1986,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do. Intents are one-way: the UI sends `restart`, `pause` or
 * `resume` and reads the result back from published state.
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
