import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { LoadingLeakProbe } from "./scenes/LoadingLeakProbe.js";

const game = defineGame({
  camera: { far: 100, near: 0.1, projection: "perspective", fov: 60 },
  initialState: {},
  plugins: [playtest({ holdUntilAttached: true })],
  renderer: { preferWebGPU: true },
  scenes: { probe: LoadingLeakProbe },
  seed: 20260811,
  start: "probe",
});

export default game;
