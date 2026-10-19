import { describe, expect, it, vi } from "vitest";
import { GpuResourceScope } from "../src/physics/resources.js";

function device() {
  const made: { size: number; destroy(): void; originalDestroy: ReturnType<typeof vi.fn> }[] = [];
  const raw = {
    limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512 },
    createBuffer: vi.fn((d: { size: number }) => {
      const originalDestroy = vi.fn();
      const b = { size: d.size, destroy: originalDestroy, originalDestroy };
      made.push(b);
      return b;
    }),
    destroy: vi.fn(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
    queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
  };
  return { raw, made, scope: new GpuResourceScope(raw as unknown as GPUDevice, 1024) };
}

describe("borrowed GPU allocation scope", () => {
  it("owns constructor allocations and waits for submitted work before cleanup", async () => {
    const { scope, raw, made } = device();
    scope.device.createBuffer({ size: 64, usage: 128 });
    await scope.finish();
    expect(scope.stats).toEqual({ buffers: 1, bytes: 64, querySets: 0 });
    await scope.dispose();
    expect(made[0]?.originalDestroy).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(scope.stats).toEqual({ buffers: 0, bytes: 0, querySets: 0 });
    await scope.dispose();
    expect(made[0]?.originalDestroy).toHaveBeenCalledTimes(1);
  });
  it("tracks a consumer's actual destruction and frees its allocation budget", async () => {
    const { scope, raw } = device();
    const buffer = scope.device.createBuffer({ size: 512, usage: 128 });
    expect(buffer).toBe(raw.createBuffer.mock.results[0]?.value);
    buffer.destroy();
    expect(scope.stats).toEqual({ buffers: 0, bytes: 0, querySets: 0 });
    scope.device.createBuffer({ size: 512, usage: 128 });
    scope.device.createBuffer({ size: 512, usage: 128 });
    await scope.dispose();
    expect(scope.stats.bytes).toBe(0);
  });
  it("retains a failed consumer destruction until cleanup can retry", async () => {
    const { scope, made } = device();
    const buffer = scope.device.createBuffer({ size: 64, usage: 128 });
    made[0]?.originalDestroy.mockImplementationOnce(() => {
      throw new Error("busy");
    });
    expect(() => buffer.destroy()).toThrow(/busy/);
    expect(scope.stats.bytes).toBe(64);
    await scope.dispose();
    expect(scope.stats.bytes).toBe(0);
    expect(made[0]?.originalDestroy).toHaveBeenCalledTimes(2);
  });
  it("releases owned staging after a failed map", async () => {
    const { scope, raw, made } = device();
    const originalCreate = raw.createBuffer.getMockImplementation();
    raw.createBuffer.mockImplementation((descriptor) => {
      const buffer = originalCreate?.(descriptor);
      Object.assign(buffer ?? {}, {
        mapState: "unmapped",
        mapAsync: async () => {
          throw new Error("map failed");
        },
      });
      return buffer as never;
    });
    Object.assign(raw, {
      createCommandEncoder: () => ({ copyBufferToBuffer: vi.fn(), finish: () => ({}) }),
    });
    Object.assign(raw.queue, { submit: vi.fn() });
    await expect(scope.read({ size: 64 } as GPUBuffer)).rejects.toThrow(/map failed/);
    expect(scope.stats.bytes).toBe(0);
    expect(made[0]?.originalDestroy).toHaveBeenCalledOnce();
    await scope.dispose();
    expect(made[0]?.originalDestroy).toHaveBeenCalledOnce();
  });
  it("waits for a donor timestamp map before destroying its owned buffer", async () => {
    const { scope, raw, made } = device();
    let land: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      land = resolve;
    });
    const originalCreate = raw.createBuffer.getMockImplementation();
    raw.createBuffer.mockImplementation((descriptor) => {
      const buffer = originalCreate?.(descriptor);
      Object.assign(buffer ?? {}, { mapAsync: () => pending });
      return buffer as never;
    });
    const buffer = scope.device.createBuffer({ size: 64, usage: 9 });
    void buffer.mapAsync(1);
    const disposal = scope.dispose();
    for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve();
    expect(made[0]?.originalDestroy).not.toHaveBeenCalled();
    land?.();
    await disposal;
    expect(made[0]?.originalDestroy).toHaveBeenCalledOnce();
    expect(scope.stats.bytes).toBe(0);
  });
  it("rejects unsupported and oversized buffers before raw allocation", () => {
    const { scope, raw } = device();
    for (const size of [0, 513, Number.POSITIVE_INFINITY])
      expect(() => scope.device.createBuffer({ size, usage: 128 })).toThrow(/TN_AVBD_CAPACITY/);
    expect(raw.createBuffer).not.toHaveBeenCalled();
    expect(() => scope.device.destroy()).toThrow(/TN_AVBD_SHARED_DEVICE/);
    expect(raw.destroy).not.toHaveBeenCalled();
  });
  it("cleans partial initialization after a GPU validation failure", async () => {
    const { scope, raw, made } = device();
    scope.device.createBuffer({ size: 64, usage: 128 });
    raw.popErrorScope.mockResolvedValueOnce({ message: "bad pipeline" } as never);
    await expect(scope.finish()).rejects.toThrow(/TN_AVBD_INITIALIZATION.*bad pipeline/);
    await expect(scope.dispose()).rejects.toThrow(/TN_AVBD_RELEASE/);
    expect(made[0]?.originalDestroy).toHaveBeenCalledTimes(1);
    expect(raw.popErrorScope).toHaveBeenCalledTimes(1);
  });
  it("still releases every buffer after queue completion rejects", async () => {
    const { scope, raw, made } = device();
    scope.device.createBuffer({ size: 64, usage: 128 });
    scope.device.createBuffer({ size: 64, usage: 128 });
    await scope.finish();
    raw.queue.onSubmittedWorkDone.mockRejectedValueOnce(new Error("lost"));
    await expect(scope.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "lost" })],
    });
    expect(made.every((b) => b.originalDestroy.mock.calls.length === 1)).toBe(true);
    expect(raw.destroy).not.toHaveBeenCalled();
  });
});
