import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Range } from "./scenes/Range.js";
import type { IRangeState } from "./state.js";

/**
 * The four call sites the FPS sweep could not write portably, and the framework APIs that
 * replaced them. See `docs/verification/fps-friction-batch-2026-08-18.md`.
 */
const game = defineGame<IRangeState, IPhysicsContext>({
  input: {
    fire: { buttons: [0], keys: ["Space"] },
    // PRD-138. Without this the game has to read `document` for a mouse delta, which is
    // web-only by construction.
    look: { pointerRelative: true },
  },
  plugins: [rapier(), playtest()],
  renderer: { preferWebGPU: true },
  scenes: { range: Range },
  seed: 90210,
  start: "range",
});

export default game;
