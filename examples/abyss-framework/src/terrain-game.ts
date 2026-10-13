import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { TerrainProbe, type TerrainState } from "./scenes/TerrainProbe.js";

const game = defineGame<TerrainState, IPhysicsContext>({
  assets: {
    basePath: "/terrain-assets",
    model: async () => ({}),
  },
  camera: { far: 1_000, near: 1, projection: "orthogonal", size: 150 },
  input: {
    move: {
      down: ["ArrowDown"],
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
      up: ["ArrowUp"],
    },
  },
  initialState: { chunks: 0, playerX: 0 },
  plugins: [rapier(), playtest<TerrainState, IPhysicsContext>()],
  renderer: { preferWebGPU: true },
  scenes: { terrain: TerrainProbe },
  seed: 20260808,
  start: "terrain",
});

export default game;
