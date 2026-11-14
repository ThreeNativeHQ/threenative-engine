// The forest kit's README step 3, plus the playtest plugin the proof reads GameState through.
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { FOREST_GAME, ForestScene } from "./terrain/forest/scene.js";
import type { TerrainState } from "./terrain/forest/sceneState.js";

export default defineGame<TerrainState, IPhysicsContext>({
  ...FOREST_GAME,
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  scenes: { forest: ForestScene },
  start: "forest",
});
