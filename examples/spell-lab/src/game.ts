import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { Lab } from "./scenes/Lab.js";
import type { LabState } from "./scenes/Lab.js";

const game = defineGame<LabState>({
  camera: { far: 120, fov: 55, near: 0.1, projection: "perspective" },
  container:
    typeof document === "undefined" ? undefined : (document.getElementById("app") ?? undefined),
  input: {
    arcaneBarrage: { keys: ["Digit4"] },
    aegis: { keys: ["Digit5"] },
    fireball: { keys: ["Digit1"] },
    glacialSpike: { keys: ["Digit3"] },
    inferno: { keys: ["Digit6"] },
    thunderstrike: { keys: ["Digit2"] },
  },
  plugins: [playtest({ events: Lab.drainEvents })],
  renderer: config.renderer,
  scenes: { lab: Lab },
  seed: 777,
  start: "lab",
});

export default game;
