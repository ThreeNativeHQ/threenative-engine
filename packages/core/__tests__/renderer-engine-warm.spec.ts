import { describe, expect, it, vi } from "vitest";

// The ThreeNative engine refuses three's RendererUtils on any access, as its facade does.
vi.mock("three/webgpu", async (original) => ({
  ...(await original<typeof import("three/webgpu")>()),
  RendererUtils: new Proxy(
    {},
    {
      get: () => {
        throw new Error("TN_NATIVE_UNSUPPORTED_RENDERERUTILS: RendererUtils is not available.");
      },
    },
  ),
}));

const { createRenderer } = await import("../src/renderer.js");

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

describe("world-pass warm-up on the ThreeNative engine", () => {
  it("offers no world-pass warm-up when the engine refuses RendererUtils", async () => {
    // The pass cannot restore the renderer state it changes there. Offered anyway, it threw on
    // every held warm-up, and sailing's startup failed (CI run 39564551248, engine parity).
    vi.stubGlobal("navigator", { gpu: {} });
    const canvas = testCanvas();
    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      renderer.setOutputNode({});
      expect(renderer.warmUpWorldPass).toBeUndefined();
      renderer.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
