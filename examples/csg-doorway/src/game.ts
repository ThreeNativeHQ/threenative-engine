import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Doorway, type IDoorwayState } from "./scenes/Doorway.js";

const game = defineGame<IDoorwayState, IPhysicsContext>({
  input: {
    // One button: the two walkers only move while it is held, so a scenario drives the crossing.
    walk: { keys: ["KeyW"] },
  },
  plugins: [playtest(), rapier()],
  display: config.display,
  renderer: config.renderer,
  scenes: { doorway: Doorway },
  start: "doorway",
});

export default game;
