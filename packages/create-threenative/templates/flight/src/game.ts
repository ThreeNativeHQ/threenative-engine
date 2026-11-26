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
    // The gamepad stick reaches the game through `move`; the keys have their own two axes.
    // `vector()` ends in `clampLength(0, 1)`, so a dive and a bank on one binding would each lose a
    // third of their reach. Two bindings keep a full bank while the nose is down.
    move: {},
    bank: { left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"] },
    // Up is the stick forward: the glider dives, the rocket belt leans forward.
    pitch: { down: ["ArrowDown", "KeyS"], up: ["ArrowUp", "KeyW"] },
    // Rocket belt only: thrust up, and let it sink.
    climb: { buttons: [0], keys: ["Space"] },
    descend: { buttons: [1], keys: ["ShiftLeft", "ShiftRight"] },
    // Swap the craft: a glider or a rocket belt, on the same island.
    vehicle: { buttons: [3], keys: ["KeyV"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each puts the craft at a fixed test spot (see `stations.ts`).
    // They answer only under a playtest runner (`UNDER_PLAYTEST`), never in a real build.
    station1: { keys: ["Digit1"] },
    station2: { keys: ["Digit2"] },
    station3: { keys: ["Digit3"] },
    station4: { keys: ["Digit4"] },
    station5: { keys: ["Digit5"] },
    station6: { keys: ["Digit6"] },
    station7: { keys: ["Digit7"] },
    station8: { keys: ["Digit8"] },
  },
  plugins: [rapier(), playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1996,
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
