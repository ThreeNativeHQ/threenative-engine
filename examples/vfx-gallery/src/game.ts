import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { Gallery, budgetKnob, drainGalleryEvents } from "./scenes/Gallery.js";
import type { GalleryState } from "./scenes/Gallery.js";

const game = defineGame<GalleryState>({
  camera: { far: 100, near: 0.1, projection: "perspective", fov: 60 },
  container:
    typeof document === "undefined" ? undefined : (document.getElementById("app") ?? undefined),
  input: {
    nextPage: { keys: ["KeyN"] },
    panRight: { keys: ["KeyD"] },
    panLeft: { keys: ["KeyA"] },
    toggleCull: { keys: ["KeyC"] },
    toggleBudget: { keys: ["KeyB"] },
  },
  // One-second windows, so a budget change reaches the effects within the scenario's wait.
  frameBudget: {
    reportEvery: 60,
    onWindow(window) {
      budgetKnob.gpuMs = window.gpuMs;
      if (
        budgetKnob.maxFps !== undefined &&
        window.gpuMs !== undefined &&
        window.gpuCompute !== undefined &&
        window.gpuCompute > 0 &&
        window.targetFps !== undefined &&
        window.gpuMs > 1000 / window.targetFps
      )
        budgetKnob.overBudgetWindows += 1;
    },
  },
  plugins: [playtest({ events: drainGalleryEvents })],
  // `maxFps` is read at every budget window, so the scene can move the frame target at run time.
  display: {
    ...config.display,
    get maxFps() {
      return budgetKnob.maxFps;
    },
  },
  render: config.renderer,
  scenes: { gallery: Gallery },
  seed: 316,
  start: "gallery",
});

export default game;
