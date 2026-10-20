import type { RenderTarget } from "three";
import type { Renderer } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExposureReadback } from "../template-assets/exposureReadback.js";

const COLD = new Float32Array([0, 0, 0, 1]);
const DRAWN = new Float32Array([-0.5, 0.26, -0.55, 0]);

function harness(reads: Float32Array[]) {
  const queue = [...reads];
  const renderer = {
    readRenderTargetPixelsAsync: vi.fn(async () => queue.shift() ?? DRAWN),
  } as unknown as Renderer;
  const readback = new ExposureReadback(1, () => true);
  const frame = async (time: number) => {
    readback.report(renderer, {} as RenderTarget, time, 0.5);
    await vi.waitFor(() => expect(readback.get()).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { readback, frame, renderer };
}

describe("exposure readback on a cold start", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats the undrawn first target as not measured yet, not as an error, and retries next frame", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { readback, frame, renderer } = harness([COLD, COLD]);
    await frame(1);
    await frame(1.01); // inside the 0.5 s interval: the cold read reopened the gate
    await frame(1.02);
    expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(readback.get()).toMatchObject({ measured: true, luminance: expect.closeTo(0.26) });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("still fails closed on a drawn but invalid measurement", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { readback, frame } = harness([new Float32Array([0, -1, 0, 1])]);
    await frame(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(readback.get()).toMatchObject({ measured: false });
  });

  it("fails closed when the target never gets drawn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { readback, frame } = harness(Array.from({ length: 200 }, () => COLD));
    for (let i = 0; i < 120; i++) await frame(1 + i * 0.01);
    expect(error).toHaveBeenCalledTimes(1);
    expect(readback.get()).toMatchObject({ measured: false });
  });
});
