import { HALF, WORLD } from "../sim/terrain.js";

/** The client-space box of the overview's canvas, which is what a click is measured against. */
export interface IMapRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * The battlefield point under a client position on the tactical overview.
 *
 * The overview is the whole map in a frame, so the mapping is the frame's own proportion — the
 * canvas is stretched to the panel, and a point read off the raster's 28 cells instead of the DOM
 * box lands a few metres off every time the panel is not exactly square. A click outside the frame
 * is clamped to its edge rather than dropped: a drag that leaves the panel still means the edge.
 */
export function minimapWorld(
  clientX: number,
  clientY: number,
  rect: IMapRect,
): { x: number; z: number } {
  const u = rect.width <= 0 ? 0.5 : (clientX - rect.left) / rect.width;
  const v = rect.height <= 0 ? 0.5 : (clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(1, u)) * WORLD - HALF,
    z: Math.max(0, Math.min(1, v)) * WORLD - HALF,
  };
}
