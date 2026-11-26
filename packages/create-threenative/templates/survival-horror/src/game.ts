import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { Play, forgetSave } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // Tank controls: up walks forward, down backs up, left and right turn the body. The axis is
    // read relative to the survivor, never the screen, so a camera cut cannot flip what "up" means.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    run: { keys: ["ShiftLeft", "ShiftRight"] },
    // Hold to raise the gun. While it is up, up and down aim high and low.
    aim: { keys: ["KeyJ", "ControlLeft"], mouseButtons: [2] },
    // One button does what is in front of you, the classic way: fire while aiming, otherwise open,
    // pick up, read. It is also the struggle button when something has hold of you.
    action: { keys: ["KeyE", "Space"], mouseButtons: [0] },
    reload: { keys: ["KeyR"] },
    inventory: { keys: ["KeyI", "Tab"] },
    back: { keys: ["Escape", "Backspace"] },
    // Mashing left and right breaks a hold too.
    struggle: { keys: ["KeyA", "KeyD", "ArrowLeft", "ArrowRight"] },
    // Enter answers the end screens; N starts a new game at any moment.
    restart: { keys: ["Enter"] },
    newGame: { keys: ["KeyN"] },
    // In the case: mix the selected herb with another.
    combine: { keys: ["KeyC"] },
    // Playtest probes: a fixed hurt and the study key, so a scenario can reach a condition or the
    // locked door without a scripted fight. Delete them with the scenarios that press them.
    probeHurt: { keys: ["KeyH"] },
    probeKey: { keys: ["KeyK"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  // Seeded: the damage roll and the critical chance repeat run to run, so a scenario can count them.
  seed: 1996,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do. Intents are one-way and named by the game; nothing comes back
 * this way — the UI reads the game's published state instead.
 */
game.ui.onIntent((intent) => {
  if (intent === "restart") {
    forgetSave();
    void game.goto("play");
  }
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
