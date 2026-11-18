// The tundra kit's README step 3, plus the playtest plugin the proof reads GameState through.
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { TUNDRA_GAME, TundraScene } from "./terrain/tundra/scene.js";
import type { TerrainState } from "./terrain/tundra/sceneState.js";

export default defineGame<TerrainState, IPhysicsContext>({
  ...TUNDRA_GAME,
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  scenes: { tundra: TundraScene },
  start: "tundra",
});
