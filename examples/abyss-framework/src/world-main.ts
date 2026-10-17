import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import "./style.css";
import { WorldProbe, type WorldState, WorldWarmUpProbe } from "./scenes/WorldProbe.js";

const worldScene = new URLSearchParams(globalThis.location.search).has("warmup")
  ? WorldWarmUpProbe
  : WorldProbe;

const game = defineGame<WorldState>({
  camera: { far: 1_000, fov: 60, near: 0.1, projection: "perspective" },
  inputTarget: window,
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
  scenes: { world: worldScene },
  seed: 20260925,
  start: "world",
});

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas !== undefined) root.prepend(canvas);
});
