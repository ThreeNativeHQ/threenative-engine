import { WebGPUBackend } from "three/webgpu";
import { expect, it } from "vitest";

/**
 * The backend must hold both halves of what it asks `navigator.gpu` for. Chromium collects an
 * adapter the page stops referencing and takes the wire instance with it, so the operations still
 * in flight then complete with a shutdown the page reads as
 * 'A valid external Instance reference no longer exists.' — presentation stops and later reads
 * reject forever. Holding the device is not enough; the adapter owns the instance. The fix lives
 * in `packages/core/patches/three@0.185.1.patch`.
 */
it("retains the WebGPU instance and the adapter for the lifetime of its backend", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const device = {
    features: { has: () => false },
    lost: new Promise(() => undefined),
    onuncapturederror: null,
  };
  const adapter = {
    features: { has: () => false },
    requestDevice: async () => device,
  };
  const gpu = { requestAdapter: async () => adapter };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu },
  });

  try {
    const canvasTarget = {};
    const backend = new WebGPUBackend();
    await backend.init({
      getCanvasTarget: () => canvasTarget,
      onDeviceLost: () => undefined,
      onError: () => undefined,
      xr: { enabled: false },
    } as never);

    expect((backend as WebGPUBackend & { gpu?: unknown }).gpu).toBe(gpu);
    expect((backend as WebGPUBackend & { adapter?: unknown }).adapter).toBe(adapter);
  } finally {
    if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});
