import { describe, expect, it, vi } from "vitest";
import {
  type IScalerWindow,
  RESOLUTION_SCALER,
  ResolutionScaler,
} from "../src/resolution-scaler.js";

/**
 * The desktop floor. Ten rungs with no temporal reconstruction behind them end at 0.23, which on
 * a desktop panel is 5% of the pixels presented at display size and no way back: nothing in the
 * chain reconstructs the frame, so the picture is simply blocky. The rungs stay the device ladder
 * the phones measure with; a desktop holds full resolution and reports that it is out of room.
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
  it("holds a desktop at full resolution and says once why, instead of stretching fewer pixels", () => {
    // Unreal ships dynamic resolution off (r.DynamicRes.OperationMode 0) and lets it lower the
    // pixels only under its temporal upscaler: 0.61 bilinearly stretched read as a blurred frame.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const built = walkToTheEnd(scaler({ minScale: RESOLUTION_SCALER.desktopFloorScale }));
    expect(built.scale).toBe(1);
    expect(built.atFloor).toBe(true);
    expect(built.scaleSource).toBe("auto");
    const floor = info.mock.calls.filter(([line]) =>
      String(line).startsWith("TN_RESOLUTION_FLOOR"),
    );
    expect(floor).toEqual([
      ["TN_RESOLUTION_FLOOR scale=1 reason=no-reconstruction override=renderer.resolutionScale"],
    ]);
    info.mockRestore();
  });

  it("holds an integrated GPU's desktop at full resolution from its class's start rung", () => {
    // The Intel laptop: GPU-bound at 42 ms on medium at 1080p, the case that walked the old floor.
    const start = RESOLUTION_SCALER.startScaleByGpuClass.integrated;
    const built = walkToTheEnd(scaler({ minScale: RESOLUTION_SCALER.desktopFloorScale, start }));
    expect(built.scale).toBe(1);
    expect(built.atFloor).toBe(true);
  });

  it("names the end of the ladder when the floor is the last rung", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    walkToTheEnd(scaler());
    expect(info.mock.calls.map(([line]) => String(line))).toContain(
      "TN_RESOLUTION_FLOOR scale=0.23 reason=ladder-end override=renderer.resolutionScale",
    );
    info.mockRestore();
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
