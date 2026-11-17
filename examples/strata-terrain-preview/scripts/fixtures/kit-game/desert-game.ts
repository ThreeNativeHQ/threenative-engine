// The desert kit's README step 3, plus the playtest plugin the proof reads GameState through.
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { DESERT_GAME, DesertScene } from "./terrain/desert/scene.js";
import type { TerrainState } from "./terrain/desert/sceneState.js";

export default defineGame<TerrainState, IPhysicsContext>({
  ...DESERT_GAME,
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  scenes: { desert: DesertScene },
  start: "desert",
});
