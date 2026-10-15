import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import "./style.css";
import { StreamingProbe, type StreamingState } from "./scenes/StreamingProbe.js";

const game = defineGame<StreamingState>({
  camera: { far: 500, fov: 60, near: 0.1, projection: "perspective" },
  inputTarget: window,
  input: { start: { keys: ["Enter"] } },
  initialState: { attached: 0, streamingDone: false },
  plugins: [playtest<StreamingState>()],
  renderer: { preferWebGPU: true },
  scenes: { streaming: StreamingProbe },
  seed: 20260903,
  start: "streaming",
});

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas !== undefined) root.prepend(canvas);
});
