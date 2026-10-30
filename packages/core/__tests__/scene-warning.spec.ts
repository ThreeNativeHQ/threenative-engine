import { afterEach, describe, expect, it } from "vitest";
import type { IFrameBudgetSummary, IFrameBudgetWindow } from "../src/frame-budget.js";
import {
  describeSceneShape,
  describeSceneWarning,
  sceneWarning,
} from "../src/profiling/scene-warning.js";
import type { IRenderCameraCullReport } from "../src/render-camera-cull.js";

afterEach(() => {
  (globalThis as { __tnPresentationCap?: unknown }).__tnPresentationCap = undefined;
});

function summary(value: number): IFrameBudgetSummary {
  return { max: value, mean: value, p50: value, p95: value, p99: value, samples: 300 };
}

/**
 * The reference game's own window: 20.2 ms frames, a 16.1 ms render phase, 1.9 ms of GPU, and the
 * 573 draws behind 1.04M triangles. The numbers are the measured ones so the fixture cannot drift
 * away from the scene it is supposed to describe.
 */
function midwayWindow(overrides: Partial<IFrameBudgetWindow> = {}): IFrameBudgetWindow {
  return {
    fps: 49.5,
    drawn: summary(20.2),
    drawnFps: 49.5,
    drawnFrames: 300,
    frame: summary(18.4),
    frames: 300,
    gpu: summary(1.9),
    gpuStale: 0,
    hitches: 0,
    longTasks: { available: false },
    passes: {
      main: { draws: summary(158), frames: 300, triangles: summary(287_000) },
      reflection: { draws: summary(51), frames: 300, triangles: summary(93_000) },
      shadow: { draws: summary(364), frames: 300, triangles: summary(660_000) },
    },
    phases: {
      hostGap: summary(2.7),
      overlay: summary(0.1),
      render: summary(17.2),
      residual: summary(0.09),
      ui: summary(0.03),
      update: summary(2.1),
    },
    presented: summary(20.2),
    shares: { hostGap: 0.13, overlay: 0, render: 0.8, residual: 0, ui: 0, update: 0.1 },
    substeps: summary(1),
    window: 4,
    ...overrides,
  };
}

const MIDWAY_CULL: IRenderCameraCullReport = {
  cameraResolved: true,
  considered: 1_680,
  culled: 409,
  enabled: true,
  exemptCameraAttached: 0,
  exemptFrustumCulled: 0,
  exemptDynamicBounds: 0,
  exemptMarked: 0,
  exemptShadowCasters: 856,
  exemptWithoutBounds: 0,
  schemaVersion: 1,
  thresholdPixels: 2,
};

describe("sceneWarning", () => {
  it("fires on the reference game's own shape and names the dominant term", () => {
    const window = midwayWindow();
    const warning = sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60);

    expect(warning).toBeDefined();
    expect(warning?.dominantTerm).toBe("objectsConsidered");
    expect(warning?.shape.trianglesPerDraw).toBe(1_815);
    expect(warning?.shape.draws.shadow).toBe(364);
    expect(warning?.shape.shadowExemptCasters).toBe(856);
    expect(warning?.gpuShare).toBeLessThan(1 / 3);
    expect(warning?.displayPeriodMs).toBeCloseTo(16.667, 2);
    expect(warning?.displaySource).toBe("declared-target");
    expect(describeSceneWarning(warning as NonNullable<typeof warning>)).toContain(
      "objectsConsidered",
    );
  });

  it("stays silent on a GPU-bound scene with the same draws, so a heavy scene is not scolded", () => {
    // Same 573 draws and the same render phase; the device is the constraint this time.
    const window = midwayWindow({ gpu: summary(12.4) });
    expect(sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60)).toBeUndefined();
  });

  it("stays silent when the render phase fits inside the display's period", () => {
    const window = midwayWindow({
      phases: { ...midwayWindow().phases, render: summary(6.2) },
    });
    expect(sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60)).toBeUndefined();
  });

  it("stays silent when one first-use compile stall, not the scene's shape, lifts the mean", () => {
    // The sailing kit's second window on a software adapter: four frames, three of them 3.8 ms and
    // one 494 ms node build, with the GPU 13% of the frame. The mean is 126 ms; the typical frame fits.
    const window = midwayWindow({
      frames: 4,
      phases: {
        ...midwayWindow().phases,
        render: { max: 494, mean: 126.32, p50: 3.8, p95: 494, p99: 494, samples: 4 },
      },
    });
    expect(sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60)).toBeUndefined();
  });

  it("refuses a verdict on a software adapter, whose rasteriser runs inside the render phase", () => {
    const window = midwayWindow();
    const shape = describeSceneShape(window, MIDWAY_CULL);
    expect(sceneWarning(window, shape, 60)).toBeDefined();
    expect(sceneWarning(window, shape, 60, "software")).toBeUndefined();
  });

  it("refuses a verdict on a window whose GPU was never measured", () => {
    const { gpu: _gpu, ...rest } = midwayWindow();
    const window = rest as IFrameBudgetWindow;
    expect(sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60)).toBeUndefined();
  });

  it("prefers the host's own presentation cap to the rate the game declared", () => {
    (globalThis as { __tnPresentationCap?: unknown }).__tnPresentationCap = () => 30;
    const window = midwayWindow();
    const warning = sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60);
    // A 30 Hz cap is a 33.3 ms period, and a 17.2 ms render phase fits inside it.
    expect(warning).toBeUndefined();
  });

  it("names the shadow lane when it is the largest thing the frame describes", () => {
    const window = midwayWindow({
      passes: {
        main: { draws: summary(20), frames: 300, triangles: summary(40_000) },
        shadow: { draws: summary(900), frames: 300, triangles: summary(900_000) },
      },
    });
    const warning = sceneWarning(
      window,
      describeSceneShape(window, { ...MIDWAY_CULL, considered: 120 }),
      60,
    );
    expect(warning?.dominantTerm).toBe("shadowDraws");
  });

  it("describes dominant object and draw counts with their own units", () => {
    const window = midwayWindow();
    const warning = sceneWarning(window, describeSceneShape(window, MIDWAY_CULL), 60);
    const text = describeSceneWarning(warning as NonNullable<typeof warning>);

    // 1,680 is the census's object count; 1,815 is triangles per draw. Printing the second as the
    // first is how a reader came to believe one scene held 52,298 JS objects.
    expect(text).toContain("objectsConsidered is the largest count");
    expect(text).toContain("1680 objects");
    expect(text).toContain("1815 triangles per draw");
    expect(text).not.toContain("1815 objects");
    expect(text).not.toMatch(/largest count: 1815/u);

    const shadowWindow = midwayWindow({
      passes: {
        main: { draws: summary(20), frames: 300, triangles: summary(40_000) },
        shadow: { draws: summary(900), frames: 300, triangles: summary(900_000) },
      },
    });
    const shadowWarning = sceneWarning(
      shadowWindow,
      describeSceneShape(shadowWindow, { ...MIDWAY_CULL, considered: 120 }),
      60,
    );
    const shadowText = describeSceneWarning(shadowWarning as NonNullable<typeof shadowWarning>);
    expect(shadowText).toContain("shadowDraws is the largest count");
    expect(shadowText).toContain("900 draws");
    expect(shadowText).not.toContain("900 triangles");

    // A term this engine never measured says so instead of borrowing the triangles figure.
    const unknown = {
      ...(warning as NonNullable<typeof warning>),
      dominantTerm: "mysteryTerm",
    };
    const unknownText = describeSceneWarning(unknown);
    expect(unknownText).toContain("mysteryTerm");
    expect(unknownText).toContain("count unavailable");
    expect(unknownText).not.toMatch(/largest count: \d/u);
  });

  it("has no verdict without a pass census, rather than one about a scene nobody measured", () => {
    const { passes: _passes, ...rest } = midwayWindow();
    const window = rest as IFrameBudgetWindow;
    expect(describeSceneShape(window, MIDWAY_CULL)).toBeUndefined();
    expect(sceneWarning(window, undefined, 60)).toBeUndefined();
  });
});
