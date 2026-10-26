import { useUiState } from "@threenative/ui";
import { useEffect, useRef } from "react";
import { STARTS } from "../sim/terrain.js";
import type { GameState } from "../state.js";

const SIZE = 28;
/** Side of the minimap canvas in device pixels; the coarse raster is upscaled into it. */
const EDGE = "#d4f8ec";
const UNSEEN = "#0b1a20";
const EXPLORED = "#1b2f33";
const VISIBLE = "#33585a";
const ORE = "#76d3e7";
const GAS = "#b7dd77";

/**
 * The tactical overview.
 *
 * A 28×28 character raster of the fog and a flat run of quads for everything on it, both
 * published by the scene. Deliberately a canvas in the *UI* layer: this is a map, drawn in the
 * layer that is allowed to be a document, and it is rebuilt only when the game replaces the
 * payload, so the HUD and the map never disagree about a frame.
 */
export function Minimap() {
  const state = useUiState<GameState>();
  const canvas = useRef<HTMLCanvasElement>(null);
  // The two payloads are replaced only on the simulation's clock, so their identity is the
  // redraw signal: this map repaints twenty times a second, not once per published frame.
  const fog = state?.minimapFog;
  const dots = state?.minimapDots;
  const view = state?.minimapView;
  useEffect(() => {
    const host = canvas.current;
    if (host === null || fog === undefined || fog === "") return;
    const size = host.width;
    const context = host.getContext("2d");
    if (context === null) return;
    const cell = size / SIZE;
    for (let row = 0; row < SIZE; row += 1)
      for (let column = 0; column < SIZE; column += 1) {
        const mark = fog.charAt(row * SIZE + column);
        context.fillStyle = mark === "#" ? VISIBLE : mark === "," ? EXPLORED : UNSEEN;
        context.fillRect(column * cell, row * cell, cell + 0.5, cell + 0.5);
      }
    const contacts = dots ?? [];
    for (let index = 0; index < contacts.length; index += 4) {
      // Published in tenths of a raster cell; the canvas is `cell` pixels per raster cell.
      const x = ((contacts[index] ?? 0) / 10) * cell;
      const z = ((contacts[index + 1] ?? 0) / 10) * cell;
      const team = contacts[index + 2] ?? 0;
      const kind = contacts[index + 3] ?? 0;
      if (team === 9) {
        context.fillStyle = kind === 2 ? ORE : GAS;
        context.fillRect(x - 1, z - 1, 2.5, 2.5);
        continue;
      }
      context.fillStyle = STARTS[team]?.css ?? EDGE;
      if (kind === 1) context.fillRect(x - 2.5, z - 2.5, 5, 5);
      else context.fillRect(x - 1.5, z - 1.5, 3, 3);
    }
    // The view: the ground under the frame's four corners, which is what the camera really sees.
    const corners = view ?? [];
    if (corners.length === 8) {
      context.strokeStyle = EDGE;
      context.lineWidth = 1;
      context.beginPath();
      for (let index = 0; index < 8; index += 2)
        context.lineTo(
          ((corners[index] ?? 0) / 10) * cell,
          ((corners[index + 1] ?? 0) / 10) * cell,
        );
      context.closePath();
      context.stroke();
    }
  }, [fog, dots, view]);

  return (
    <section className="pointer-events-none bg-black/80 p-2">
      <div className="mb-1 text-[9px] uppercase tracking-[0.18em] text-dim">tactical overview</div>
      <canvas
        aria-label="Tactical overview"
        className="block h-40 w-40 border border-line"
        height={SIZE * 5}
        ref={canvas}
        role="img"
        width={SIZE * 5}
      />
    </section>
  );
}
