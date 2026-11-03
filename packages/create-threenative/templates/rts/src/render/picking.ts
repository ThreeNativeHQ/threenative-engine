// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Selection, in screen space, the way a strategy game does it: a click is the nearest thing to
// the cursor, a drag is everything whose footprint the rectangle touched. Both work off the
// simulation's own positions, so there is no picking layer to keep in step with the rules — what
// you can click is what exists, under the same fog of war the fog of war draws.
import type { Camera } from "three";
import type { Game } from "../sim/game.js";
import { terrainHeight } from "../sim/terrain.js";
import type { IEntity } from "../sim/types.js";
import { type IRtsView, type IViewSize, toScreen } from "./camera.js";

export interface IPoint2 {
  readonly x: number;
  readonly y: number;
}

/** A drag shorter than this is a click, not a box. */
export const DRAG_SLOP = 4;

/**
 * The rubber band, in client pixels: `[left, top, width, height]` from a press and its pointer.
 *
 * Dragging in any direction gives the same rectangle — the top-left corner is the smaller of the
 * two coordinates and the size is the gap — and a press that has not travelled past `DRAG_SLOP` is
 * `null` rather than a two-pixel band: under it the gesture is a click, and a band that flashes on
 * every press is a selection the player did not make.
 */
export function dragBoxRect(from: IPoint2, to: IPoint2): [number, number, number, number] | null {
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  if (Math.hypot(width, height) <= DRAG_SLOP) return null;
  return [Math.min(from.x, to.x), Math.min(from.y, to.y), width, height];
}

/** What a click landed on: a unit or a building, or nothing. */
export type PickTarget = IEntity | undefined;

/** Everything the player is allowed to know about: their own, and what their units can see. */
function visible(game: Game, entity: IEntity): boolean {
  if (entity.team === 0) return true;
  return game.visibleAt(entity.x, entity.z);
}

/** Height a click aims at: the middle of the model, not its feet. */
function aimHeight(entity: IEntity): number {
  return terrainHeight(entity.x, entity.z) + (entity.altitude || 0) + entity.r + 0.4;
}

/**
 * The nearest selectable thing under the cursor.
 *
 * A screen-space radius rather than a ray: at this zoom a `ranger` is about thirteen pixels
 * across, which is smaller than the cursor, and a ray against a nine-part instanced model would
 * need the whole instancing layer behind it to answer. The radius is derived from the same
 * collision radius the pathfinder uses, so what is clickable is what is walkable-around.
 */
export function pickEntity(
  game: Game,
  camera: Camera,
  view: IRtsView,
  size: IViewSize,
  x: number,
  y: number,
): PickTarget {
  let best: PickTarget;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of game.entities) {
    if (entity.garrisonId !== null || !visible(game, entity)) continue;
    const point = toScreen(camera, entity.x, aimHeight(entity), entity.z, size);
    const radius = Math.max(entity.building ? 24 : 13, entity.r * (size.height / view.zoom) * 0.55);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < radius && distance < bestDistance) {
      bestDistance = distance;
      best = entity;
    }
  }
  return best;
}

/**
 * The player's own mobile units whose footprint the drag rectangle touched.
 *
 * Workers are excluded unless the drag started with Alt held: an army box that scooped up the
 * mining crew is the single most common way to lose a strategy game, and the modifier is how every
 * genre in this shape solves it.
 */
export function unitsInBox(
  game: Game,
  camera: Camera,
  view: IRtsView,
  size: IViewSize,
  from: IPoint2,
  to: IPoint2,
  includeWorkers: boolean,
  into: number[],
): number[] {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  into.length = 0;
  for (const entity of game.own()) {
    if (entity.building || entity.garrisonId !== null) continue;
    const point = toScreen(camera, entity.x, aimHeight(entity), entity.z, size);
    if (point.x < left || point.x > right || point.y < top || point.y > bottom) continue;
    if (!includeWorkers && entity.type === "worker") continue;
    into.push(entity.id);
  }
  return into;
}
