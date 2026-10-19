import { describe, expect, it, vi } from "vitest";
import { defineGame } from "../src/game.js";
import { RESOLUTION_SCALER } from "../src/resolution-scaler.js";
import { Scene } from "../src/scene.js";

/**
 * PRD-563 Phase 2. The adapter family picks the scaler's first rung, and a class the table does not
 * name starts where every game started before the table existed.
 */
class Empty extends Scene {
  static override readonly initialState = {};
}

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

async function startOn(
  info: Record<string, string> | undefined,
  render: Record<string, unknown> = {},
): Promise<{ gpuClass?: string; scale: number; scaleSource: string }> {
  const canvas = testCanvas();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requestAdapter = vi.fn(async () => (info === undefined ? {} : { info }));
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: { requestAdapter } },
  });
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  const game = defineGame({
    display: { maxFps: 60 },
    frameBudget: { report: () => {} },
    render,
    renderer: {
      canvas,
      report: () => {},
      webgpuFactory: () => ({
        backend: { gpu: { requestAdapter } },
        domElement: canvas,
        init: async () => undefined,
        render: () => undefined,
        setSize: () => undefined,
      }),
    },
    scenes: { test: Empty },
    start: "test",
  });
  try {
    await game.start();
    const renderer = game.ctx?.renderer;
    const surface = renderer?.surface();
    return {
      ...(renderer?.gpuClass === undefined ? {} : { gpuClass: renderer.gpuClass.class }),
      scale: surface?.resolutionScale ?? Number.NaN,
      scaleSource: surface?.scaleSource ?? "?",
    };
  } finally {
    await game.stop();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", descriptor);
  }
}

describe("the first rung comes from the adapter family", () => {
  it("names only mobile-low in the start table", () => {
    expect(RESOLUTION_SCALER.startScaleByGpuClass).toEqual({ "mobile-low": 0.85 });
  });

  it("starts a mobile-low adapter one rung down, drawn from the first frame", async () => {
    const result = await startOn({
      architecture: "bifrost",
      description: "Mali-G52 MC2",
      device: "",
      vendor: "arm",
    });
    expect(result).toEqual({ gpuClass: "mobile-low", scale: 0.85, scaleSource: "auto" });
  });

  it.each([
    ["discrete", { architecture: "turing", description: "", device: "", vendor: "nvidia" }],
    ["integrated", { architecture: "gen-12lp", description: "", device: "", vendor: "intel" }],
    ["mobile-high", { architecture: "", description: "Mali-G715", device: "", vendor: "arm" }],
    ["unknown", { architecture: "", description: "", device: "", vendor: "" }],
  ])("starts a %s adapter at the ceiling", async (gpuClass, info) => {
    expect(await startOn(info)).toEqual({ gpuClass, scale: 1, scaleSource: "auto" });
  });

  it("starts at the ceiling when the adapter reported no info at all", async () => {
    expect(await startOn(undefined)).toEqual({ scale: 1, scaleSource: "auto" });
  });

  it("never overrules a pinned scale", async () => {
    const result = await startOn(
      { architecture: "bifrost", description: "Mali-G52 MC2", device: "", vendor: "arm" },
      { resolutionScale: 1 },
    );
    expect(result).toEqual({ gpuClass: "mobile-low", scale: 1, scaleSource: "pinned" });
  });
});
