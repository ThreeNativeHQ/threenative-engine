import type { ICtx } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** Godot-style collision layers: what each body occupies, and so what a query can ask for. */
export const WORLD_LAYER = 1;
export const CAR_LAYER = 4;
