import type { IRenderPerformanceMetrics } from "./loop.js";
import type { RendererKind } from "./renderer.js";

/** The measured draw count on its own, for the projection line that reads it every frame. */
export function rendererDrawCallCount(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return undefined;
  const render = (info as { render?: unknown }).render;
  if (typeof render !== "object" || render === null) return undefined;
  const drawCalls = (render as { drawCalls?: unknown }).drawCalls;
  const calls = drawCalls ?? (render as { calls?: unknown }).calls;
  return typeof calls === "number" && Number.isFinite(calls) && calls >= 0 ? calls : undefined;
}

export function rendererPerformanceMetrics(raw: unknown): {
  drawCalls?: number;
  triangles?: number;
} {
  if (typeof raw !== "object" || raw === null) return {};
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return {};
  const render = (info as { render?: unknown }).render;
  if (typeof render !== "object" || render === null) return {};
  const triangles = (render as { triangles?: unknown }).triangles;
  const drawCalls = rendererDrawCallCount(raw);
  return {
    ...(drawCalls === undefined ? {} : { drawCalls }),
    ...(typeof triangles === "number" && Number.isFinite(triangles) && triangles >= 0
      ? { triangles }
      : {}),
  };
}

export function resetRendererPerformanceMetrics(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return;
  const reset = (info as { reset?: unknown }).reset;
  if (typeof reset === "function") reset.call(info);
}

/**
 * One frame's two render calls, combined.
 *
 * The two renderers' `info` do not mean the same thing, and the old sum only ever held for one of
 * them. `WebGLRenderer` ends every `render()` with `info.reset()`, so the world sample and the
 * overlay sample are disjoint and add up. WebGPU never resets: the engine owns the
 * requestAnimationFrame loop, so it calls `info.reset()` itself once per frame before the world
 * draw (see the render block), which leaves the overlay sample *cumulative* — world plus overlay.
 * Adding it to the world sample reported every world draw twice, and the packed racing scenario
 * read 358 draw calls against a 330 ceiling on a frame that submits far fewer.
 *
 * The world pass split belongs to the world call in both renderers and rides the same sample, so
 * it is carried across rather than summed — a summed split attributes the world's shadow and
 * reflection passes to the overlay too.
 */
export function combineRenderPerformanceMetrics(
  kind: RendererKind,
  world: IRenderPerformanceMetrics | undefined,
  overlay: IRenderPerformanceMetrics,
): IRenderPerformanceMetrics {
  const passes = world?.passes;
  if (kind === "webgpu") {
    return passes === undefined ? overlay : { ...overlay, passes };
  }
  if (world === undefined) return overlay;
  return {
    ...(world.drawCalls === undefined || overlay.drawCalls === undefined
      ? {}
      : { drawCalls: world.drawCalls + overlay.drawCalls }),
    ...(world.triangles === undefined || overlay.triangles === undefined
      ? {}
      : { triangles: world.triangles + overlay.triangles }),
    ...(passes === undefined ? {} : { passes }),
  };
}
