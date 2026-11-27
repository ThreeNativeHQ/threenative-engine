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
    // Walking is the default and is silent; running is fast and every footstep is a noise.
    run: { buttons: [5], keys: ["ShiftLeft", "ShiftRight"] },
    crouch: { buttons: [1], keys: ["KeyC", "ControlLeft"] },
    // Grab from behind, then press again to pump the choke.
    cqc: { buttons: [2], keys: ["KeyF"], mouseButtons: [0] },
    // Pick up, open, and — held over a downed guard — drag the body.
    interact: { buttons: [0], keys: ["KeyE", "Space"] },
    // Knock on the wall you are pressed against: a noise that pulls one guard over to look.
    knock: { buttons: [3], keys: ["KeyQ"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each puts the player at a fixed test spot (see `STATIONS` in Play.ts).
    // They answer only under a playtest runner (`UNDER_PLAYTEST`), never in a real build.
    // They exist so a scenario proves one mechanic in a few ticks; delete them with the playtests.
    station1: { keys: ["Digit1"] },
    station2: { keys: ["Digit2"] },
    station3: { keys: ["Digit3"] },
    station4: { keys: ["Digit4"] },
    station5: { keys: ["Digit5"] },
    station6: { keys: ["Digit6"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1998,
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
