import {
  MATERIAL_IDS,
  Mask,
  Terrain,
  applyPlacementOverrides,
  bakeTerrain,
  decodeHeightPNG,
  decodeRAW16,
  makeExport,
} from "../../index.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import { inspectSpatial } from "../spatialInspector.js";
import { $, errorMessage } from "./dom.js";
import { editorKeyAction } from "./keyboard.js";
import type { EditorSession } from "./session.js";
export function addStroke(c: EditorSession, path: [number, number][], lower: boolean): void {
  if (!path[0]) return;
  const b = c.brush();
  const at = path[0];
  const mask = Mask.circle(at, b.radius, b.falloff);
  const tool = c.tools.find((t) => t[0] === c.active);
  if (!tool) throw new Error(`Unknown editor tool: ${c.active}`);
  const label = `${tool[1]} stroke`;
  c.terrain.transaction(() => {
    if (["sculpt", "smooth", "flatten"].includes(c.active)) {
      const p = { ...b, points: path, label };
      if (c.active === "sculpt") p.strength = b.strength * 22 * (lower ? -1 : 1);
      if (c.active === "smooth") c.terrain.smooth({ ...p, iterations: 4 });
      if (c.active === "flatten") c.terrain.flatten({ ...p, height: c.options.flatten.height });
      if (c.active === "sculpt") c.terrain.sculpt(p);
    } else if (c.active === "stamp")
      c.terrain.stamp({
        label: `${c.options.stamp.shape} stamp`,
        at,
        radius: b.radius,
        amplitude: b.strength * 130,
        shape: c.options.stamp.shape,
        rotation: b.rotation,
        roughness: 0.18,
        falloff: b.falloff,
      });
    else if (c.active === "erode")
      c.terrain.erode({
        label: `${c.options.erode.method} erosion`,
        ...b,
        at,
        method: c.options.erode.method,
        iterations: 14,
        droplets: 1600,
        maxSteps: 45,
        opacity: b.strength,
        strength: 1,
      });
    else if (c.active === "paint") {
      const p = { ...b, points: path, label };
      if (c.options.paint.mode === "biome")
        c.terrain.biome({ ...p, name: c.options.paint.biome, value: lower ? 0 : 1 });
      else c.terrain.paint({ ...p, material: c.options.paint.material });
    } else if (c.active === "scatter") {
      const o = c.options.scatter;
      if (o.erase)
        c.terrain.clear({ label: `Clear ${o.asset}`, target: "scatter", asset: o.asset, mask });
      else
        c.terrain.scatter({
          label: `Scatter ${o.asset}`,
          asset: o.asset,
          count: o.count,
          minDistance: o.asset === "pine" ? 4 : 1.5,
          scale: [0.7, 1.35],
          maxSlope: o.asset === "boulder" ? 65 : 36,
          mask,
        });
    } else if (c.active === "water") {
      const o = c.options.water;
      c.terrain.water({
        label: o.kind === "lake" ? "Lake water" : "Ocean water",
        kind: o.kind,
        at,
        radius: o.kind === "ocean" ? c.terrain.config.size : b.radius,
        level: o.level,
      });
    }
  });
  c.selected = c.terrain.layers.at(-1)?.id;
  c.renderLayers();
}

export function showPoints(c: EditorSession): void {
  c.view.showSpline(c.points);
  $("spline-bar").classList.toggle("hidden", !c.points.length);
  $("spline-count").textContent =
    `${c.points.length} control point${c.points.length === 1 ? "" : "s"}`;
  $("finish-spline").disabled = c.points.length < 2;
}

export function finishSpline(c: EditorSession): void {
  const [from, to] = c.points;
  if (!from || !to) return;
  c.attempt(() => {
    if (c.active === "ramp")
      c.terrain.ramp({
        label: "Terrain ramp",
        from,
        to,
        width: c.options.ramp.width,
        shoulder: c.options.ramp.width * 0.5,
      });
    else {
      const o = c.options.spline;
      const path: [number, number, number][] = c.points.map((p) => [...p]);
      if (o.kind === "river")
        for (let i = 1; i < path.length; i++) {
          const current = path[i];
          const previous = path[i - 1];
          if (current && previous) current[1] = Math.min(current[1], previous[1] - 0.1);
        }
      c.terrain[o.kind]({
        label: o.kind === "river" ? "River spline" : "Road spline",
        points: path,
        width: o.width,
        shoulder: o.width * 0.7,
        ...(o.kind === "river" ? { depth: o.depth, enforceDownhill: true } : {}),
      });
    }
    c.points = [];
    c.showPoints();
    c.selected = c.terrain.layers.at(-1)?.id;
    c.renderLayers();
  });
}
export function installStrokes(c: EditorSession): void {
  c.host = $("viewport");
  c.host.addEventListener("pointerdown", (e) => {
    if (
      e.target !== c.host &&
      (!(e.target instanceof Element) || !e.target.classList.contains("render-canvas"))
    )
      return;
    c.host.focus();
    if (e.button !== 0 || e.altKey || c.navigation) return;
    if (c.active === "select") return;
    const hit = c.view.pick(e.clientX, e.clientY);
    if (!hit) return;
    if (c.active === "spline" || c.active === "ramp") {
      c.points.push(hit);
      c.showPoints();
      if (c.active === "ramp" && c.points.length === 2) c.finishSpline();
      return;
    }
    c.stroke = { pointer: e.pointerId, path: [[hit[0], hit[2]]], lower: e.shiftKey };
    c.host.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  c.host.addEventListener("pointermove", (e) => {
    const hit = c.view.pick(e.clientX, e.clientY);
    if (!hit) {
      c.view.setBrush(null);
      return;
    }
    $("coordinates").textContent =
      `X ${hit[0].toFixed(1)} · Y ${hit[1].toFixed(1)} · Z ${hit[2].toFixed(1)} m`;
    const b = c.brush();
    c.view.setBrush(c.navigation || c.active === "select" ? null : { ...b, at: [hit[0], hit[2]] });
    if (c.stroke && ["sculpt", "smooth", "flatten", "paint"].includes(c.active)) {
      const last = c.stroke.path.at(-1);
      if (
        last &&
        Math.hypot(last[0] - hit[0], last[1] - hit[2]) > Math.max(0.3, b.radius * 0.04) &&
        c.stroke.path.length < 2048
      )
        c.stroke.path.push([hit[0], hit[2]]);
    }
  });
  c.host.addEventListener("pointerup", (e) => {
    if (c.stroke?.pointer === e.pointerId) {
      const current = c.stroke;
      c.stroke = null;
      if (c.host.hasPointerCapture(e.pointerId)) c.host.releasePointerCapture(e.pointerId);
      c.attempt(() => c.addStroke(current.path, current.lower));
    }
  });
  c.host.addEventListener("pointercancel", () => {
    c.stroke = null;
  });
  c.host.addEventListener("pointerleave", () => {
    if (!c.stroke) c.view.setBrush(null);
  });
  $("finish-spline").onclick = c.finishSpline;
  $("cancel-spline").onclick = () => {
    c.points = [];
    c.showPoints();
  };
  c.host.tabIndex = 0;
  c.host.setAttribute(
    "aria-label",
    "Terrain viewport. Arrows move the brush; Enter or Space applies; Shift lowers; Enter or Ctrl+Enter finishes a spline of two or more points; Escape cancels.",
  );
  let cursor: [number, number] | undefined;
  c.keydown = (e) => {
    const target = e.target instanceof Element ? e.target : undefined;
    const action = editorKeyAction(
      e,
      target?.tagName,
      target === c.host,
      (c.active === "spline" || c.active === "ramp") && c.points.length >= 2,
    );
    if (!action) return;
    if (action === "cancel") {
      if (c.stroke && c.host.hasPointerCapture(c.stroke.pointer))
        c.host.releasePointerCapture(c.stroke.pointer);
      c.stroke = null;
      c.points = [];
      c.showPoints();
      c.view.setBrush(null);
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (c.active === "select" && (action === "undo" || action === "redo")) return;
    e.preventDefault();
    if (action === "undo") c.terrain.undo();
    else if (action === "redo") c.terrain.redo();
    else if (action.startsWith("tool:")) {
      const tool = c.tools[Number(action.slice(5))];
      if (tool) c.selectTool(tool[0]);
    } else if (action === "select") c.selectTool("select");
    else if (action === "navigate") $("navigate-btn").click();
    else if (action === "frame") c.view.frame();
    else if (action === "finish") c.finishSpline();
    else if (!c.navigation && c.active !== "select") {
      const rect = c.host.getBoundingClientRect();
      cursor ??= [rect.width / 2, rect.height / 2];
      if (action === "arrowleft") cursor[0] -= 20;
      if (action === "arrowright") cursor[0] += 20;
      if (action === "arrowup") cursor[1] -= 20;
      if (action === "arrowdown") cursor[1] += 20;
      cursor = [
        Math.max(0, Math.min(rect.width - 1, cursor[0])),
        Math.max(0, Math.min(rect.height - 1, cursor[1])),
      ];
      const hit = c.view.pick(rect.left + cursor[0], rect.top + cursor[1]);
      if (!hit) {
        c.view.setBrush(null);
        return;
      }
      c.view.setBrush({ ...c.brush(), at: [hit[0], hit[2]] });
      if (action !== "apply") return;
      if (c.active === "spline" || c.active === "ramp") {
        c.points.push(hit);
        c.showPoints();
        if (c.active === "ramp" && c.points.length === 2) c.finishSpline();
      } else c.attempt(() => c.addStroke([[hit[0], hit[2]]], e.shiftKey));
    }
  };
  c.host.addEventListener(
    "keydown",
    (event) => {
      // Ctrl/Enter commits a keyboard-authored spline without stealing native button activation.
      if (event.ctrlKey && event.key === "Enter" && c.points.length >= 2) {
        event.preventDefault();
        event.stopPropagation();
        c.finishSpline();
      }
    },
    { signal: c.abort.signal },
  );
}
