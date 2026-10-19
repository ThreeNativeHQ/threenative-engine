import { describe, expect, it } from "vitest";
import {
  type IScalerWindow,
  RESOLUTION_SCALER,
  ResolutionScaler,
} from "../src/resolution-scaler.js";

/**
 * The desktop floor. Ten rungs with no temporal reconstruction behind them end at 0.23, which on
 * a desktop panel is 5% of the pixels presented at display size and no way back: nothing in the
 * chain reconstructs the frame, so the picture is simply blocky. The rungs stay the device ladder
 * the phones measure with; a desktop stops at 0.61 and reports that it is out of room.
 */

/** A window whose GPU cost tracks the drawing buffer and never meets a 60 fps budget. */
const pixelBound = (scale: number): IScalerWindow => ({
  fps: 9.55,
  gpuAgeFrames: 3,
  gpuMs: 2 + 350 * scale * scale,
  presented: { max: 250, p50: 100, p95: 133.3, p99: 166.7 },
});

function scaler(
  options: { minScale?: number; start?: number; temporalUpscale?: () => boolean } = {},
) {
  const built = new ResolutionScaler({ start: options.start, targetFps: 60, ...options });
  built.observe(pixelBound(built.scale)); // the warm-up window is never a measurement
  return built;
}

function walkToTheEnd(built: ResolutionScaler): ResolutionScaler {
  for (let index = 0; index < 40; index += 1) built.observe(pixelBound(built.scale));
  return built;
}

describe("the desktop floor", () => {
  it("stops at 0.61 and reports being out of room instead of stepping past it", () => {
    const built = walkToTheEnd(scaler({ minScale: RESOLUTION_SCALER.desktopFloorScale }));
    expect(built.scale).toBe(0.61);
    expect(built.atFloor).toBe(true);
    expect(built.scaleSource).toBe("auto");
  });

  it("leaves the phone rungs unchanged when the host states no floor", () => {
    // What Android and iOS resolve to: the whole ladder, and `atFloor` at the last rung.
    const built = walkToTheEnd(scaler());
    expect(built.scale).toBe(0.23);
    expect(built.atFloor).toBe(true);
  });

  it("keeps a temporal reconstruction stage's reach, and reads it per step", () => {
    // Read lazily, because the chain is installed by the scene and can change under a running
    // game: a scaler that asked once at boot would hold the floor over a stage that arrived later.
    let temporal = false;
    const built = walkToTheEnd(scaler({ minScale: 0.61, temporalUpscale: () => temporal }));
    expect(built.scale).toBe(0.61);
    temporal = true;
    expect(walkToTheEnd(built).scale).toBe(0.23);
  });

  it("keeps a host's own start rung when it already sits above the floor", () => {
    // A host that asked to begin below the desktop floor is already sharper than the floor asks
    // for. There is nothing to give away to reach it, so the scaler reports being out of room and
    // keeps the rung it was given rather than climbing to the floor it never passed.
    const built = walkToTheEnd(scaler({ minScale: 0.61, start: 0.44 }));
    expect(built.scale).toBe(0.44);
    expect(built.atFloor).toBe(true);
  });

  it("refuses a floor that is not a registered rung", () => {
    expect(() => new ResolutionScaler({ minScale: 0.5, targetFps: 60 })).toThrow(/minScale/u);
  });
});
