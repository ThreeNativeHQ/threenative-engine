import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Grip } from "./scenes/Grip.js";

/**
 * The one thing this example exists to prove: the opt-in IK adapter
 * (`examples/integrations/ik/src/constrained-ik.ts`) runs inside a real ThreeNative game — the
 * engine's own loop, scene lifecycle, `beforeRender` phase and playtest bridge — and the playtest
 * scenarios in `playtests/` read its measurements off a running frame.
 */
const game = defineGame({
  plugins: [playtest()],
  initialState: {},
  renderer: { preferWebGPU: true },
  scenes: { grip: Grip },
  start: "grip",
});

export default game;
