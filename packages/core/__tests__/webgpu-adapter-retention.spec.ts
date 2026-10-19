import { describe, expect, it, vi } from "vitest";
import { adapterTextureLimits, createRenderer, retainedWebGpuAdapters } from "../src/renderer.js";

/**
 * Chromium collects a `GPUAdapter` the page no longer references, and the WebGPU wire reports the
 * consequence on every operation still in flight on it:
 * `Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer
 * exists.` — Dawn completes those callbacks with `EventCompletionType::Shutdown`
 * (`src/dawn/wire/client/Instance.cpp`), which is also what a device-lost event carries. Once that
 * happens the canvas stops presenting and every later `mapAsync` rejects, so a game freezes with a
 * black screen and stale reads.
 *
 * Core asks `navigator.gpu` for an adapter in two places and kept neither: `adapterTextureLimits`
 * (the limits for the device three is about to create) and `readWebGpuAdapterFacts` (the identity
 * the capture and the software-adapter gate are read from). Both are locals that go out of scope
 * the moment the function returns, so the only strong reference left is three's backend — which
 * holds the device and `navigator.gpu`, and still not the adapter it was handed
 * (`node_modules/three/build/three.webgpu.js` has no `this.adapter`).
 *
 * A collector needs heap pressure, so this fires late and only in long runs: the CI job `fluid
 * consumers` loses its device about 40 s into its 820 fixed steps (runs 37183659465, 37183344148)
 * and then fails `TN_CAPTURE_BLANK` with all four captures byte-identical black, while the 2m46s
 * `fluid collision` job on the same software adapter passes.
 */

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/** A `navigator.gpu` that hands out a distinct adapter per request, the way Chromium does. */
function stubGpu() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const handedOut: unknown[] = [];
  const requestAdapter = vi.fn(async () => {
    const adapter = {
      info: { architecture: "", description: "swiftshader", device: "", vendor: "" },
      limits: {
        maxSampledTexturesPerShaderStage: 32,
        maxSamplersPerShaderStage: 32,
        maxTextureArrayLayers: 512,
      },
    };
    handedOut.push(adapter);
    return adapter;
  });
  const gpu = { requestAdapter };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu } });
  return {
    gpu,
    handedOut,
    restore: () => {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    },
  };
}

describe("an adapter core asked navigator.gpu for outlives the call that asked", () => {
  it("holds the adapter the device's texture limits were read from", async () => {
    const gpu = stubGpu();
    try {
      await adapterTextureLimits();
      expect(gpu.handedOut).toHaveLength(1);
      expect(retainedWebGpuAdapters().has(gpu.handedOut[0])).toBe(true);
    } finally {
      gpu.restore();
    }
  });

  it("holds the adapter the renderer's identity and software tier were read from", async () => {
    const gpu = stubGpu();
    try {
      const renderer = await createRenderer({
        canvas: testCanvas(),
        webgpuFactory: (canvas) =>
          ({
            backend: {
              device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
              gpu: gpu.gpu,
            },
            domElement: canvas,
            init: async () => undefined,
            render: () => undefined,
            setSize: () => undefined,
          }) as never,
      });
      try {
        expect(renderer.softwareAdapter).toBe("swiftshader");
        expect(gpu.handedOut).toHaveLength(1);
        expect(retainedWebGpuAdapters().has(gpu.handedOut[0])).toBe(true);
      } finally {
        renderer.dispose();
      }
    } finally {
      gpu.restore();
    }
  });
});
