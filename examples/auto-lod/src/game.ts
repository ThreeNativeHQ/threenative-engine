import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { Lod } from "./scenes/Lod.js";

const game = defineGame({
  input: {
    // One button: far by default, Space brings the camera close. Two scenarios drive this so the
    // same build can be measured at each end of the route.
    toggleNear: { keys: ["Space"] },
  },
  // The bridge a scenario needs to observe entities, performance and the scene graph.
  plugins: [playtest()],
  display: config.display,
  renderer: config.renderer,
  scenes: { lod: Lod },
  start: "lod",
});

export default game;
