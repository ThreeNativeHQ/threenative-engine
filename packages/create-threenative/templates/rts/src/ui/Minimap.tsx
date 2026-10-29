import { useUiIntent } from "@threenative/ui";
import { useEffect, useRef } from "react";
import { HALF, STARTS, WORLD } from "../sim/terrain.js";
import { useUiStateShown } from "./Hud.js";
import { minimapWorld } from "./minimapPoint.js";

const SIZE = 28;
/** Side of the minimap canvas in device pixels; the coarse raster is upscaled into it. */
const EDGE = "#d4f8ec";
const UNSEEN = "#0c171d";
const EXPLORED = "#1d3134";
const VISIBLE = "#3a5b58";
const ORE = "#76d3e7";
const GAS = "#b7dd77";

/**
 * The tactical overview.
 *
 * A 28×28 character raster of the fog and a flat run of quads for everything on it, both
 * published by the scene. Deliberately a canvas in the *UI* layer: this is a map, drawn in the
 * layer that is allowed to be a document, and it is rebuilt only when the game replaces the
 * payload, so the HUD and the map never disagree about a frame. The rival start sectors are
 * public map knowledge, framed until that commander falls.
 *
 * It is also the overview, not a picture of one: a click recentres the camera, dragging it pans
 * while the button is held, and a right-click issues the selection's order at that ground point,
 * exactly as AstraCraft's map does. The click is turned into world metres here and handed to the
 * scene as an intent, so the map never touches the rules.
 */
export function Minimap() {
  const state = useUiStateShown((s) => [s.minimapFog, s.minimapDots, s.minimapView, s.rivals]);
  const send = useUiIntent();
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  /** The click as a ground point, from the rect the browser reports for the canvas. */
  const point = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const host = event.currentTarget;
    const rect = host.getBoundingClientRect();
    return minimapWorld(event.clientX, event.clientY, rect);
  };
  // The payloads change on the simulation's clock (the view only when the camera moves), and the
  // snapshot is renewed only then: this map repaints twenty times a second, not once per frame.
  const fog = state?.minimapFog;
  const dots = state?.minimapDots;
  const view = state?.minimapView;
  const rivals = state?.rivals;
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
    context.font = "8px monospace";
    for (const base of STARTS) {
      if (base.team === 0 || rivals?.[base.team - 1] === "DEFEATED") continue;
      const x = ((base.x + HALF) / WORLD) * size;
      const z = ((base.z + HALF) / WORLD) * size;
      context.strokeStyle = base.css;
      context.fillStyle = base.css;
      context.lineWidth = 1;
      context.strokeRect(x - 6, z - 6, 12, 12);
      context.fillText(base.name.charAt(0), x - 2.5, z + 3);
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
        context.fillRect(x - 1.2, z - 1.2, 2.4, 2.4);
        continue;
      }
      context.fillStyle = STARTS[team]?.css ?? EDGE;
      if (kind === 1) context.fillRect(x - 3, z - 3, 6, 6);
      else context.fillRect(x - 1.55, z - 1.55, 3.1, 3.1);
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
  }, [fog, dots, view, rivals]);

  return (
    <section className="map-panel panel" data-tn-interactive>
      <div className="panel-label">
        TACTICAL OVERVIEW <span className="live-dot" />
      </div>
      <div className="map-frame">
        <canvas
          aria-label="Tactical overview. Click to move the camera, right-click to issue orders."
          height={256}
          onContextMenu={(event) => {
            event.preventDefault();
            send("orderAt", point(event));
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            if (event.button === 2) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            send("focus", point(event));
          }}
          onPointerMove={(event) => {
            if (dragging.current) send("focus", point(event));
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          ref={canvas}
          role="img"
          width={256}
        />
        <span className="map-n">N</span>
        <span className="map-coord">K–09</span>
      </div>
      <div className="map-footer">
        {STARTS.map((base) => (
          <span key={base.team}>
            <i style={{ background: base.css }} /> {base.name.toUpperCase()}
          </span>
        ))}
      </div>
    </section>
  );
}
