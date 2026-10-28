import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // The four directions of `input.vector("move")`. Declared rather than inherited from the
    // default binding, so the axis every scene reads is visible where the game is defined.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // `Player` reads `justPressed("jump")`; an action with no binding never fires.
    jump: { buttons: [0], keys: ["Space"] },
  },
  // `playtest()` installs the bridge a scenario needs to observe entities and state. Without
  // it, semantic assertions fail closed with TN_PLAYTEST_BRIDGE_MISSING rather than passing.
  plugins: [rapier(), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  start: "play",
});

export default game;
