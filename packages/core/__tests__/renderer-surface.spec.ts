import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/renderer.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

async function renderer(options: {
  antialias?: boolean;
  resolutionScale?: number;
  samples?: number;
}) {
  const canvas = testCanvas();
  return createRenderer({
    ...options,
    canvas,
    preferWebGPU: false,
    webgl2Factory: () => ({
      domElement: canvas,
      render: () => undefined,
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      setSize: () => undefined,
    }),
  });
}

describe("renderer.surface()", () => {
  it("reports the applied scale and the drawing buffer it produced", async () => {
    const created = await renderer({ resolutionScale: 0.32 });
    expect(created.surface()).toEqual({
      atFloor: false,
      drawingBufferHeight: 346,
      drawingBufferWidth: 768,
      resolutionScale: 0.32,
      sampleCount: 1,
      scaleSource: "pinned",
    });
    created.dispose();
  });

  it("reports the sample count the renderer actually got, not the boolean it was asked for", async () => {
    // `antialias: true` is a request; three answers it with a sample count, and only the answer
    // describes the image. A window reporting the request would have said 4 on a renderer that
    // silently gave 1.
    const asked = await renderer({ antialias: true, resolutionScale: 1, samples: 4 });
    expect(asked.surface().sampleCount).toBe(4);
    asked.dispose();
    const refused = await renderer({ antialias: true, resolutionScale: 1, samples: 0 });
    expect(refused.surface().sampleCount).toBe(1);
    refused.dispose();
  });

  it("defaults to an unscaled, unsampled surface", async () => {
    const created = await renderer({});
    expect(created.surface()).toEqual({
      atFloor: false,
      drawingBufferHeight: 1080,
      drawingBufferWidth: 2400,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned",
    });
    created.dispose();
  });
});

describe("renderer.setResolutionScale()", () => {
  it("re-applies the drawing buffer and reports the new scale and its source", async () => {
    const created = await renderer({ resolutionScale: 1 });
    created.setResolutionScale(0.44, "auto");
    expect(created.surface()).toEqual({
      atFloor: false,
      drawingBufferHeight: 475,
      drawingBufferWidth: 1056,
      resolutionScale: 0.44,
      sampleCount: 1,
      scaleSource: "auto",
    });
    created.setResolutionScale(0.32, "auto-pinned");
    expect(created.surface().scaleSource).toBe("auto-pinned");
    expect(created.surface().drawingBufferWidth).toBe(768);
    created.dispose();
  });
});

describe("owned temporal upsampling", () => {
  it("scales the engine input while retaining display pixels only while the temporal resolve runs", async () => {
    const canvas = testCanvas();
    let active = false;
    const scales: number[] = [];
    const created = await createRenderer({
      canvas,
      resolutionScale: 0.72,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: () => undefined,
        setSize: () => undefined,
        get temporalUpscale() {
          return active;
        },
        setRenderScale: (scale: number) => scales.push(scale),
      }),
    });
    expect(created.surface().drawingBufferWidth).toBe(1728);
    active = true;
    created.setResolutionScale(0.72, "auto");
    expect(created.surface().drawingBufferWidth).toBe(2400);
    expect(created.surface().drawingBufferHeight).toBe(1080);
    expect(scales.at(-1)).toBe(0.72);
    active = false;
    created.setResolutionScale(0.85, "auto");
    expect(created.surface().drawingBufferWidth).toBe(2040);
    expect(scales.at(-1)).toBe(1);
    created.dispose();
  });
});
