// The coastal kit's README step 3, plus the playtest plugin the proof reads GameState through.
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { COASTAL_GAME, CoastalScene } from "./terrain/coastal/scene.js";
import type { TerrainState } from "./terrain/coastal/sceneState.js";

export default defineGame<TerrainState, IPhysicsContext>({
  ...COASTAL_GAME,
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  scenes: { coastal: CoastalScene },
  start: "coastal",
});
