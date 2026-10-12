import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SPANS,
  SPAN_NAMES,
  SpanRecorder,
  beginSpan,
  endSpan,
  setSpanRecorder,
  spanRecorder,
  spansRequested,
} from "../src/profiling/Spans.js";

afterEach(() => {
  setSpanRecorder(undefined);
  (globalThis as { __tnFrameSpans?: unknown }).__tnFrameSpans = undefined;
});

describe("SpanRecorder residual", () => {
  it("reports a parent's own time minus its children", () => {
    const recorder = new SpanRecorder();
    // A 10 ms pass containing a 3 ms render-list build and a 4 ms draw: the residual is the 3 ms
    // nobody claimed, computed rather than filed under "other".
    recorder.begin(SPANS.mainPass, 0);
    recorder.begin(SPANS.projectObject, 0);
    recorder.end(SPANS.projectObject, 3);
    recorder.begin(SPANS.draw, 3);
    recorder.end(SPANS.draw, 7);
    recorder.end(SPANS.mainPass, 10);
    recorder.endFrame(10);

    const window = recorder.window();
    expect(window?.spans.mainPass?.p50).toBeCloseTo(10, 2);
    expect(window?.spans.mainPass?.residualP50).toBeCloseTo(3, 2);
    expect(window?.spans.projectObject?.p50).toBeCloseTo(3, 2);
    expect(window?.spans.draw?.p50).toBeCloseTo(4, 2);
    // Every top-level span is accounted for, so the phase's own residual is zero here.
    expect(window?.residualMs).toBeCloseTo(0, 2);
    expect(window?.coverage).toBeCloseTo(1, 3);
  });

  it("reports a child that outlives its parent as a negative residual rather than zero", () => {
    const recorder = new SpanRecorder();
    recorder.begin(SPANS.mainPass, 0);
    recorder.add(SPANS.draw, 7);
    recorder.end(SPANS.mainPass, 4);
    recorder.endFrame(4);

    const window = recorder.window();
    expect(window?.spans.mainPass?.p50).toBeCloseTo(4, 2);
    expect(window?.spans.mainPass?.residualP50).toBeCloseTo(-3, 2);
  });

  it("leaves the render phase's unattributed time visible as the window residual", () => {
    const recorder = new SpanRecorder();
    recorder.begin(SPANS.reconcile, 0);
    recorder.end(SPANS.reconcile, 1);
    recorder.endFrame(16.1);

    const window = recorder.window();
    expect(window?.renderMs).toBeCloseTo(16.1, 2);
    expect(window?.residualMs).toBeCloseTo(15.1, 2);
    expect(window?.coverage).toBeCloseTo(0.06, 3);
  });

  it("refuses a span that ends out of order instead of reporting a wrong tree", () => {
    const recorder = new SpanRecorder();
    recorder.begin(SPANS.mainPass, 0);
    expect(() => recorder.end(SPANS.draw, 1)).toThrow(/ended while mainPass was open/u);
  });

  it("counts a frame it had to abandon instead of recording a fabricated zero", () => {
    const recorder = new SpanRecorder();
    recorder.begin(SPANS.mainPass, 0);
    recorder.abandonFrame();
    expect(recorder.depth).toBe(0);
    expect(recorder.window()).toBeUndefined();
  });
});

describe("SpanRecorder zero cost when off", () => {
  it("reads no clock and allocates nothing through the module-level hot path", () => {
    const clock = vi.fn(() => 0);
    vi.stubGlobal("performance", { now: clock });
    try {
      expect(spanRecorder()).toBeUndefined();
      const started = Date.now();
      for (let index = 0; index < 1_000_000; index += 1) {
        beginSpan(SPANS.draw);
        endSpan(SPANS.draw);
      }
      const elapsed = Date.now() - started;
      expect(clock).not.toHaveBeenCalled();
      // A guarded return is a few nanoseconds; a clock read per call is not. The bound is loose on
      // purpose — it checks that the guard is there at all, it is not a benchmark.
      expect(elapsed).toBeLessThan(500);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names every span, so a report can never print an id as a bare number", () => {
    expect(SPAN_NAMES).toHaveLength(Object.keys(SPANS).length);
    expect(SPAN_NAMES.every((name) => name.length > 0)).toBe(true);
  });
});

describe("SpanRecorder reporting", () => {
  it("keeps a span that was entered and cost almost nothing, rather than omitting it", () => {
    const recorder = new SpanRecorder();
    recorder.begin(SPANS.mainPass, 0);
    // A render call whose CPU cost rounds to zero still happened, and a window that omits it
    // reads as "the render never ran" — the absent-versus-zero confusion this instrument exists
    // to avoid. Measured on the reference game in a browser at about 0.07 ms.
    recorder.end(SPANS.mainPass, 0);
    recorder.begin(SPANS.reconcile, 0);
    recorder.end(SPANS.reconcile, 4);
    recorder.endFrame(4);

    const window = recorder.window();
    expect(window?.spans.mainPass).toBeDefined();
    expect(window?.spans.mainPass?.p50).toBe(0);
    expect(window?.spans.mainPass?.perFrame).toBe(1);
    // A span nothing ever entered stays out of the report.
    expect(window?.spans.sort).toBeUndefined();
  });

  it("stores the recorder on a global symbol, so a second copy of this module sees it", () => {
    // Core is built once per entry: a game importing `@threenative/core/world` gets a second copy
    // of this module, and module state left the world's own spans recording nothing in a browser
    // walk — two copies, two states. The slot is a `Symbol.for`, one per realm.
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    const slot = Symbol.for("threenative.frameSpans.recorder");
    expect((globalThis as unknown as Record<symbol, unknown>)[slot]).toBe(recorder);
    expect(spanRecorder()).toBe(recorder);
  });
});

describe("spansRequested", () => {
  it("is off by default and on for any truthy spelling of the flag", () => {
    expect(spansRequested()).toBe(false);
    const host = globalThis as { __tnFrameSpans?: unknown };
    host.__tnFrameSpans = "1";
    expect(spansRequested()).toBe(true);
    host.__tnFrameSpans = "0";
    expect(spansRequested()).toBe(false);
    host.__tnFrameSpans = true;
    expect(spansRequested()).toBe(true);
  });

  it("reads the browser's own URL, so a page can be measured without rebuilding it", () => {
    const original = globalThis.location;
    try {
      vi.stubGlobal("location", { search: "?navigation&tnFrameSpans=1" });
      expect(spansRequested()).toBe(true);
      vi.stubGlobal("location", { search: "?tnFrameSpans=0" });
      expect(spansRequested()).toBe(false);
      vi.stubGlobal("location", { search: "?other=1" });
      expect(spansRequested()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.location).toBe(original);
    }
  });
});

it("routes span boundaries to the native monotonic sink without reading simulation time", () => {
  setSpanRecorder(undefined);
  const now = vi.spyOn(performance, "now");
  const sink = vi.fn();
  vi.stubGlobal("__tnGameSpan", sink);
  try {
    beginSpan(SPANS.sceneUpdate);
    endSpan(SPANS.sceneUpdate);
    expect(sink.mock.calls).toEqual([
      [SPANS.sceneUpdate, 0],
      [SPANS.sceneUpdate, 1],
    ]);
    expect(now).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    now.mockRestore();
  }
});
