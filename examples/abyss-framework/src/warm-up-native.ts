import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Abyss, type AbyssState } from "./scenes/Abyss.js";

const game = defineGame<AbyssState>({
  camera: { far: 7_000, near: 5_000, projection: "orthogonal", size: 520 },
  input: {
    move: {
      down: ["KeyS", "ArrowDown"],
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD", "ArrowRight"],
      up: ["KeyW", "ArrowUp"],
    },
    pulse: { keys: ["Space"], pointer: true },
    start: { keys: ["Enter"] },
    zoom: { gamepadAxes: [3], pinch: true, scroll: true },
  },
  plugins: [playtest<AbyssState>()],
  renderer: { preferWebGPU: true },
  scenes: { play: Abyss },
  seed: 90210,
  start: "play",
  warmUp: {},
});

export default game;
