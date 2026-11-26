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
    // Use the selected tool or seed bag on the tile ahead.
    use: { buttons: [0], keys: ["Space", "KeyJ"], mouseButtons: [0] },
    // Pick a ripe crop, ship it at the bin, buy at the stall, sleep at the door, close the night screen.
    interact: { buttons: [2], keys: ["KeyE", "Enter"] },
    // The hotbar: keys 1 to 7, and cycle with Q and R (or the bumpers).
    slot1: { keys: ["Digit1"] },
    slot2: { keys: ["Digit2"] },
    slot3: { keys: ["Digit3"] },
    slot4: { keys: ["Digit4"] },
    slot5: { keys: ["Digit5"] },
    slot6: { keys: ["Digit6"] },
    slot7: { keys: ["Digit7"] },
    prevTool: { buttons: [4], keys: ["KeyQ"] },
    nextTool: { buttons: [5], keys: ["KeyR"] },
    // Playtest keys: stations and clock cheats (see `scenes/stations.ts`). They answer only under
    // a playtest runner, never in a real build. Delete them with the playtests.
    station1: { keys: ["Numpad1"] },
    station2: { keys: ["Numpad2"] },
    station3: { keys: ["Numpad3"] },
    station4: { keys: ["Numpad4"] },
    station5: { keys: ["Numpad5"] },
    station6: { keys: ["Numpad6"] },
    station7: { keys: ["Numpad7"] },
    station8: { keys: ["Numpad8"] },
    station9: { keys: ["Numpad9"] },
    cheatDry: { keys: ["Numpad0"] },
    cheatNoon: { keys: ["NumpadAdd"] },
    cheatNight: { keys: ["NumpadSubtract"] },
    cheatLate: { keys: ["NumpadMultiply"] },
    cheatTired: { keys: ["NumpadDivide"] },
    cheatSeason: { keys: ["NumpadDecimal"] },
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
 * Intents are one-way and named by the game: the UI sends `pause` or `resume` and the game decides
 * what each means. Nothing comes back this way — the UI reads the game's published state instead,
 * which keeps one source of truth on the side that owns the simulation.
 */
game.ui.onIntent((intent) => {
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
});
