import type { ICtx } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { initialDiagnosticsState } from "./diagnostics.js";
import type { ICanopyComparison } from "./render/pack.js";

/**
 * The state this game reports through: every measurement `diagnostics.ts` owns, plus the two values
 * that are a look decision rather than a measurement.
 *
 * It lives here rather than in `game.ts` because the scene's collaborators — the spawn gate, the
 * meadow build, the player rig — read and write the same store, and importing the state shape from
 * the scene that composes them would close a cycle.
 */
export const initialState = {
  ...initialDiagnosticsState,
  canopyComparison: { normals: "authored", specular: "disabled" } as ICanopyComparison,
  showcase: false,
};

export type TerrainState = typeof initialState;
export type TerrainCtx = ICtx<TerrainState, IPhysicsContext>;
