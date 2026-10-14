import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { WorldProbe, type WorldState } from "./scenes/WorldProbe.js";

// Native entry for the `?world` fly-through (PRD-448 phase 4b). It is the same scene and the same
// logical package path as the web entry: `threenative build --target desktop` compiles
// `assets/world/` into content-addressed output and stages it beside the bundle with its
// `assets.manifest.json`, so `ctx.assets` resolves `world/world.json` on the host exactly as it
// does in the browser. PRD-448's `/world.json` override is gone with the reason it existed — the
// host had no manifest to resolve and the raw fetch needed a root-relative name.

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
  scenes: { world: WorldProbe },
  seed: 20260925,
  start: "world",
});

export default game;
