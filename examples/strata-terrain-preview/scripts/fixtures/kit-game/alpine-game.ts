// The alpine kit's README step 3, plus the playtest plugin the proof reads GameState through.
import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { ALPINE_GAME, AlpineScene } from "./terrain/alpine/scene.js";
import type { TerrainState } from "./terrain/alpine/sceneState.js";

export default defineGame<TerrainState, IPhysicsContext>({
  ...ALPINE_GAME,
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  scenes: { alpine: AlpineScene },
  start: "alpine",
});
