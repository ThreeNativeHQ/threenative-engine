import { describe, expect, it } from "vitest";
import {
  FrameCounters,
  counterDeviceOf,
  createCrossingReader,
} from "../src/profiling/FrameCounters.js";

interface IFakeEncoder extends Record<string, unknown> {
  drawIndexed: () => void;
  setBindGroup: () => void;
  setPipeline: () => void;
}

interface IFakeDevice {
  createCommandEncoder: () => IFakeEncoder;
  queue: { submit: () => void; writeBuffer: (...args: unknown[]) => void };
}

/** A stand-in for the slice of WebGPU the counters wrap: a device, a queue and its encoders. */
function fakeDevice(): IFakeDevice {
  return {
    createCommandEncoder: () => ({
      beginRenderPass: () => undefined,
      drawIndexed: () => undefined,
      finish: () => ({}),
      setBindGroup: () => undefined,
      setIndexBuffer: () => undefined,
      setPipeline: () => undefined,
      setVertexBuffer: () => undefined,
    }),
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  };
}

describe("crossing counter", () => {
  it("reports each frame's JS->Wasm crossings, not the run's total, and skips the first read", () => {
    let total = 12_000;
    const crossings = createCrossingReader({ __tnCrossingCount: () => total });
    // The first read is everything since boot: a run has no previous frame to difference.
    expect(crossings()).toBeUndefined();
    total += 1_810;
    expect(crossings()).toBe(1_810);
    total += 1_790;
    expect(crossings()).toBe(1_790);
  });

  it("answers undefined on a host whose back end counts no crossings", () => {
    const crossings = createCrossingReader({});
    expect(crossings()).toBeUndefined();
    expect(crossings()).toBeUndefined();
  });
});

describe("FrameCounters", () => {
  it("counts every command-encoder and queue call of one frame, and resets between frames", () => {
    const device = fakeDevice();
    const counters = FrameCounters.install(device);
    expect(counters).toBeDefined();

    // Three asks the device for an encoder once per pass; the wrapper must cover that encoder.
    // Asking for the encoder is itself a crossing, which is why the count is five and not four.
    const encoder = device.createCommandEncoder();
    encoder.setPipeline();
    encoder.setBindGroup();
    encoder.drawIndexed();
    device.queue.submit();
    const first = counters?.read();
    expect(first?.hostCalls).toBe(5);
    expect(first?.gpuBytes).toBe(0);
    // A second read is the next frame, not the same one twice.
    expect(counters?.read().hostCalls).toBe(0);
  });

  it("counts the bytes queue.writeBuffer was handed, honouring dataOffset and size", () => {
    const device = fakeDevice();
    const counters = FrameCounters.install(device);
    device.queue.writeBuffer({}, 0, new Uint8Array(64));
    device.queue.writeBuffer({}, 0, new Uint8Array(64), 16, 8);

    expect(counters?.read().gpuBytes).toBe(72);
  });

  it("wraps an encoder the first time it is seen, not once at install", () => {
    const device = fakeDevice();
    const counters = FrameCounters.install(device);
    device.createCommandEncoder().drawIndexed();
    device.createCommandEncoder().drawIndexed();
    device.queue.submit();
    expect(counters?.read().hostCalls).toBe(5);
  });

  it("stops counting once uninstalled", () => {
    const device = fakeDevice();
    const counters = FrameCounters.install(device);
    device.queue.submit();
    counters?.uninstall();
    device.queue.submit();
    // The read still reports the call made while installed; the one after it is not counted.
    expect(counters?.read().hostCalls).toBe(1);
  });

  it("never invokes a getter while looking for methods, which is what blanked a browser page", () => {
    // WebGPU puts `label`, `queue`, `features`, `limits` and `lost` on the prototype as accessors,
    // and calling one with the prototype as `this` throws `TypeError: Illegal invocation` in
    // Chrome. Enumerating by reading the property did exactly that and took the whole game down
    // with the flag on.
    let getterCalls = 0;
    class HostileDevice {
      get label(): string {
        getterCalls += 1;
        throw new TypeError("Illegal invocation");
      }
      createCommandEncoder(): Record<string, unknown> {
        return { drawIndexed: () => undefined };
      }
    }
    const device = new HostileDevice() as unknown as {
      createCommandEncoder: () => { drawIndexed: () => void };
      queue: Record<string, unknown>;
    };
    device.queue = { submit: () => undefined };
    Object.setPrototypeOf(device.queue, new HostileDevice());

    const counters = FrameCounters.install(device);
    expect(counters).toBeDefined();
    expect(() => device.createCommandEncoder().drawIndexed()).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(counters?.read().hostCalls).toBe(2);
    counters?.uninstall();
  });

  it("answers undefined for a renderer with no device, rather than counting nothing", () => {
    expect(FrameCounters.install(undefined)).toBeUndefined();
    expect(FrameCounters.install({})).toBeUndefined();
    const device = { queue: {} };
    expect(counterDeviceOf({ backend: { device } })).toBe(device);
    expect(counterDeviceOf({})).toBeUndefined();
  });
});
