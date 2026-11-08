import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import "./style.css";
import {
  SCALER_PROBE_REPORT_EVERY,
  ScalerProbe,
  type ScalerState,
  observeScalerWindow,
} from "./scenes/ScalerProbe.js";

const game = defineGame<ScalerState>({
  camera: { far: 500, fov: 60, near: 0.1, projection: "perspective" },
  display: { maxFps: 60 },
  // Short windows so the climb is seconds rather than minutes. The controller reads windows, not
  // seconds, so this changes how long the proof takes and nothing about what it proves.
  frameBudget: { onWindow: observeScalerWindow, reportEvery: SCALER_PROBE_REPORT_EVERY },
  inputTarget: window,
  initialState: { phase: "burn" },
  plugins: [playtest<ScalerState>()],
  // The point of the probe, and it goes in the portable config block a game's
  // `threenative.config.ts` carries (the old `render` key), not on the numeric `resolutionScale`
  // override. Every other entry in this example leaves the scale pinned, so none of them
  // has a controller to prove anything about.
  renderer: { preferWebGPU: true, resolutionScale: "auto" },
  scenes: { scaler: ScalerProbe },
  seed: 20260903,
  start: "scaler",
});

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas !== undefined) root.prepend(canvas);
});
