import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Handoff } from "./scenes/Handoff.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {},
  plugins: [rapier(), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { handoff: Handoff },
  start: "handoff",
});

export default game;
