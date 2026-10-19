import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { KitScene, noteFrameBudget } from "./scenes/KitScene.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    edge: { keys: ["Digit2"] },
    ground: { keys: ["Digit1"] },
    overview: { keys: ["Digit3"] },
    lake: { keys: ["Digit4"] },
    boulders: { keys: ["Digit4"] },
  },
  // A short window so a playtest run closes several per view; the scene reads them into state,
  // which is what puts the measured per-view frame cost into the run report.
  frameBudget: { onWindow: noteFrameBudget, reportEvery: 10 },
  plugins: [rapier(), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { kit: KitScene },
  start: "kit",
});

export default game;
