import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { sendSceneIntent } from "./orders.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

// game.state is the single store: the fixed-step loop writes it, and React and the playtest read it.
const game = defineGame<GameState, undefined>({
  // An orthographic rig, because a battlefield's far side is the same size as its near side.
  // The scene owns the framing; this only says which kind of camera it is driving.
  camera: { far: 600, near: 1, projection: "orthogonal", size: 30 },
  input: {
    // The four directions of `input.vector("move")`, which pan the camera. Declared rather than
    // inherited from the default binding, so the axis the scene reads is visible where the game is
    // defined — and so nothing else can quietly claim a key this camera already owns.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Wheel, pinch and the right stick share one portable camera intent. Negative DOM deltaY
    // (toward the user) is positive scroll intent on browser and native.
    zoom: { gamepadAxes: [3], pinch: true, scroll: true },
    // A button per player gesture, so a press is read as a press and never as a polled key set.
    attack: { keys: ["KeyA"] },
    army: { keys: ["F2"] },
    base: { keys: ["Space"] },
    cancel: { keys: ["Escape"] },
    hold: { keys: ["KeyH"] },
    moveOrder: { keys: ["KeyM"] },
    stopOrder: { keys: ["KeyX"] },
  },
  // `playtest()` installs the bridge a scenario needs to observe entities and state. Without it,
  // semantic assertions fail closed with TN_PLAYTEST_BRIDGE_MISSING rather than passing.
  plugins: [playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  // Seeded worldgen: one number makes the whole match — the map, the rocks, the AI — reproducible.
  seed: 471,
  start: "play",
});

export default game;

/**
 * What the UI can ask the game to do.
 *
 * Intents are one-way and named by the game: the UI sends `army`, `place` or `train` and the scene
 * decides what each means. Nothing comes back this way — the HUD reads the published state
 * instead, which keeps one source of truth on the side that owns the simulation.
 */
game.ui.onIntent((intent, payload) => {
  if (intent === "pause") {
    game.pause();
    sendSceneIntent("cancel");
  }
  if (intent === "resume") game.resume();
  // Only the pause and resume intents move the flag: an order sent while paused leaves it held.
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  });
  game.state.flush();
  if (intent !== "pause" && intent !== "resume") sendSceneIntent(intent, payload);
});
