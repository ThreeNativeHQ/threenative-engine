import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { drainPlaytestEvents } from "./playtest-events.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, undefined>({
  input: {
    // Only the stick's horizontal and down are bound: down fast-falls and drops through a platform.
    // Jumping is a button, so a tap hops short and a hold hops tall.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: [],
    },
    jump: { buttons: [0], keys: ["Space", "KeyW", "ArrowUp"] },
    // A tap swings the neutral attack (the aerial in the air). Hold the strong attack to charge it.
    attack: { buttons: [2], keys: ["KeyJ"] },
    strong: { buttons: [3], keys: ["KeyK"] },
    shield: { buttons: [5, 7], keys: ["KeyL"] },
    dodge: { buttons: [1], keys: ["ShiftLeft", "ShiftRight"] },
    restart: { buttons: [9], keys: ["KeyR"] },
    // Playtest stations: each puts the fighters at a fixed test setup (see `STATIONS` in
    // `scenes/stations.ts`). They answer only under a playtest runner, never in a real build.
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
    station11: { keys: ["KeyZ"] },
    station12: { keys: ["KeyX"] },
    station13: { keys: ["KeyC"] },
  },
  plugins: [playtest({ events: drainPlaytestEvents })],
  display: config.display,
  renderer: config.renderer,
  scenes: { play: Play },
  seed: 1999,
  start: "play",
});

export default game;

/** The UI sends `restart`, `pause` or `resume`; the game decides what each means. */
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
