import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type WorldState, WorldWarmUpProbe } from "./scenes/WorldProbe.js";

const game = defineGame<WorldState>({
  camera: { far: 1_000, fov: 60, near: 0.1, projection: "perspective" },
  input: { fly: { keys: ["KeyF"] } },
  initialState: {
    evictions: 0,
    failures: 0,
    instances: 0,
    loadsInFlight: 0,
    maxResidentCells: 0,
    residenceChanges: 0,
    residentCells: 0,
    shadowDeferrals: 0,
    shadowFrame: 0,
    shadowLevels: 0,
    shadowPartialDone: 0,
    shadowRendered: 0,
  },
  plugins: [playtest<WorldState>()],
  renderer: { preferWebGPU: true },
  scenes: { world: WorldWarmUpProbe },
  seed: 20260925,
  start: "world",
});

export default game;
