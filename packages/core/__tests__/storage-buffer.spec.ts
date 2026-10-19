import { DynamicDrawUsage } from "three";
import { ReadbackBuffer, StorageBufferAttribute } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createRenderer } from "../src/renderer.js";
import { StorageBufferLeases } from "../src/storage-buffer.js";

function fixture() {
  const records = new Map<unknown, { buffer?: unknown }>();
  const destroy = vi.fn();
  const device = {
    createBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
    limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
    destroy: vi.fn(),
  };
  const backend = {
    isWebGPUBackend: true,
    device,
    get: (key: unknown) => records.get(key) ?? {},
  };
  const attributes = {
    update: vi.fn((attribute: StorageBufferAttribute, type: number) => {
      expect(type).toBe(3);
      records.set(attribute, {
        buffer: { size: attribute.array.byteLength, usage: 140, mapState: "unmapped", destroy },
      });
    }),
    delete: vi.fn((attribute: StorageBufferAttribute) => {
      const buffer = records.get(attribute)?.buffer as { destroy(): void } | undefined;
      buffer?.destroy();
      records.delete(attribute);
    }),
  };
  const source = { backend, _attributes: attributes };
  const leases = new StorageBufferLeases(() => source);
  return { leases, source, records, destroy, device, attributes };
}

const attribute = () => new StorageBufferAttribute(new Float32Array(16), 4);

describe("exclusive renderer storage-buffer receipts", () => {
  it("retries destruction after Three removes its manager record before the backend throws", () => {
    const f = fixture();
    const a = attribute();
    const lease = f.leases.allocate(a);
    let managerOwns = true;
    const backendDestroy = vi.fn((key: StorageBufferAttribute) => {
      f.destroy();
      f.records.delete(key);
    });
    const infoDestroy = vi.fn();
    Object.assign(f.source.backend, { destroyAttribute: backendDestroy });
    Object.assign(f.attributes, { info: { destroyAttribute: infoDestroy } });
    f.attributes.delete.mockImplementation((key) => {
      if (!managerOwns) return;
      managerOwns = false;
      backendDestroy(key);
      infoDestroy(key);
    });
    f.destroy.mockImplementationOnce(() => {
      throw new Error("busy buffer");
    });
    expect(() => lease.dispose()).toThrow(/busy buffer/);
    expect(lease.released).toBe(false);
    expect(f.records.has(a)).toBe(true);
    lease.dispose();
    expect(lease.released).toBe(true);
    expect(f.records.has(a)).toBe(false);
    expect(f.destroy).toHaveBeenCalledTimes(2);
    expect(infoDestroy).toHaveBeenCalledOnce();
    expect(f.device.destroy).not.toHaveBeenCalled();
  });
  it("uses the actual renderer wrapper and releases an aborted pre-render allocation", async () => {
    const f = fixture();
    const canvas = new EventTarget() as HTMLCanvasElement;
    const rawDispose = vi.fn();
    const renderer = await createRenderer({
      canvas,
      pipelineCensus: false,
      source: {
        createCanvas: () => canvas,
        hasWebGPU: () => true,
        observeResize: () => () => undefined,
        readSize: () => [320, 180],
      },
      webgpuFactory: () => ({
        ...f.source,
        domElement: canvas,
        init: async () => undefined,
        render: () => undefined,
        setSize: () => undefined,
        dispose: rawDispose,
      }),
    });
    if (renderer.storageBuffer === undefined) throw new Error("Missing storage seam.");
    const receipt = renderer.storageBuffer(attribute());
    expect(receipt.device).toBe(f.device);
    receipt.assertCurrent();
    renderer.dispose();
    expect(receipt.released).toBe(true);
    expect(f.records.size).toBe(0);
    expect(f.device.destroy).not.toHaveBeenCalled();
    expect(rawDispose).toHaveBeenCalledOnce();
    expect(() => receipt.assertCurrent()).toThrow(/TN_STORAGE_BUFFER_STALE/);
  });

  it("retries cleanup through renderer.dispose after a release failure", async () => {
    const f = fixture();
    const canvas = new EventTarget() as HTMLCanvasElement;
    const rawDispose = vi.fn();
    const renderer = await createRenderer({
      canvas,
      pipelineCensus: false,
      source: {
        createCanvas: () => canvas,
        hasWebGPU: () => true,
        observeResize: () => () => undefined,
        readSize: () => [320, 180],
      },
      webgpuFactory: () => ({
        ...f.source,
        domElement: canvas,
        init: async () => undefined,
        render: () => undefined,
        setSize: () => undefined,
        dispose: rawDispose,
      }),
    });
    if (renderer.storageBuffer === undefined) throw new Error("Missing storage seam.");
    const lease = renderer.storageBuffer(attribute());
    f.attributes.delete.mockImplementationOnce(() => {
      throw new Error("release failed");
    });
    expect(() => renderer.dispose()).toThrow(/release failed/);
    expect(lease.released).toBe(false);
    renderer.dispose();
    expect(lease.released).toBe(true);
    expect(f.records.size).toBe(0);
    expect(rawDispose).toHaveBeenCalledOnce();
  });

  it("retains a failed initialization allocation when its immediate cleanup also fails", () => {
    const f = fixture();
    f.attributes.update.mockImplementationOnce((a) => {
      f.records.set(a, { buffer: { destroy: f.destroy } });
      throw new Error("allocation failed");
    });
    f.attributes.delete.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });
    expect(() => f.leases.allocate(attribute())).toThrow();
    expect(f.records.size).toBe(1);
    f.leases.dispose();
    expect(f.records.size).toBe(0);
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("allocates through Three accounting and returns the same borrowed device and buffer", () => {
    const f = fixture();
    const a = attribute();
    const lease = f.leases.allocate(a);
    expect(lease.device).toBe(f.device);
    expect(lease.buffer).toBe(f.records.get(a)?.buffer);
    expect(lease.byteLength).toBe(64);
    expect(f.attributes.update).toHaveBeenCalledOnce();
    lease.assertCurrent();
    lease.dispose();
    lease.dispose();
    expect(f.attributes.delete).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.device.destroy).not.toHaveBeenCalled();
    expect(() => lease.assertCurrent()).toThrow(/TN_STORAGE_BUFFER_STALE/);
  });

  it("rejects a second receipt and pre-existing buffers without taking their ownership", () => {
    const f = fixture();
    const a = attribute();
    f.leases.allocate(a);
    expect(() => f.leases.allocate(a)).toThrow(/TN_STORAGE_BUFFER_LEASED/);
    const b = attribute();
    const foreign = { destroy: vi.fn() };
    f.records.set(b, { buffer: foreign });
    expect(() => f.leases.allocate(b)).toThrow(/TN_STORAGE_BUFFER_OWNERSHIP/);
    expect(foreign.destroy).not.toHaveBeenCalled();
  });

  it.each([
    (a: StorageBufferAttribute) => {
      a.itemSize = 3;
    },
    (a: StorageBufferAttribute) => {
      a.array = new Uint32Array(16);
    },
    (a: StorageBufferAttribute) => {
      a.array = new Float32Array(0);
    },
    (a: StorageBufferAttribute) => {
      Object.defineProperty(a, "count", { value: 3 });
    },
    (a: StorageBufferAttribute) => {
      a.setUsage(DynamicDrawUsage);
    },
    (a: StorageBufferAttribute) => {
      a.array[0] = Number.NaN;
    },
  ])("rejects invalid layout before allocating", (mutate) => {
    const f = fixture();
    const a = attribute();
    mutate(a);
    expect(() => f.leases.allocate(a)).toThrow(/TN_STORAGE_BUFFER_LAYOUT/);
    expect(f.attributes.update).not.toHaveBeenCalled();
  });

  it("fails named for internal WebGL fallback and missing private cohort seam", () => {
    const f = fixture();
    f.source.backend.isWebGPUBackend = false;
    expect(() => f.leases.allocate(attribute())).toThrow(/TN_STORAGE_BUFFER_UNSUPPORTED/);
    const missing = new StorageBufferLeases(() => ({}));
    expect(() => missing.allocate(attribute())).toThrow(/TN_STORAGE_BUFFER_UNSUPPORTED/);
  });

  it.each([undefined, Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid attribute versions before allocation",
    (version) => {
      const f = fixture();
      const a = attribute();
      Object.defineProperty(a, "version", { value: version });
      expect(() => f.leases.allocate(a)).toThrow(/TN_STORAGE_BUFFER_LAYOUT/);
      expect(f.attributes.update).not.toHaveBeenCalled();
    },
  );

  it("retains ownership after a failed release so renderer teardown can retry", () => {
    const f = fixture();
    const a = attribute();
    const lease = f.leases.allocate(a);
    f.attributes.delete.mockImplementationOnce(() => {
      throw new Error("release failed");
    });
    expect(() => f.leases.dispose()).toThrow(/release failed/);
    expect(lease.released).toBe(false);
    expect(f.records.size).toBe(1);
    f.leases.dispose();
    expect(lease.released).toBe(true);
    expect(f.records.size).toBe(0);
    expect(f.device.destroy).not.toHaveBeenCalled();
  });

  it("checks device byte limits before allocation", () => {
    const f = fixture();
    f.device.limits.maxStorageBufferBindingSize = 32;
    expect(() => f.leases.allocate(attribute())).toThrow(/TN_STORAGE_BUFFER_CAPACITY.*64.*32/);
    expect(f.attributes.update).not.toHaveBeenCalled();
  });

  it.each([
    (a: StorageBufferAttribute) => {
      a.needsUpdate = true;
    },
    (a: StorageBufferAttribute) => {
      a.array = new Float32Array(16);
    },
    (a: StorageBufferAttribute) => {
      a.itemSize = 2;
    },
    (a: StorageBufferAttribute) => {
      Object.defineProperty(a, "count", { value: 8 });
    },
    (a: StorageBufferAttribute) => {
      a.setUsage(DynamicDrawUsage);
    },
  ])("rejects stale layout before dispatch but still releases the owned buffer", (mutate) => {
    const f = fixture();
    const a = attribute();
    const lease = f.leases.allocate(a);
    mutate(a);
    expect(() => lease.assertCurrent()).toThrow(/TN_STORAGE_BUFFER_STALE/);
    lease.dispose();
    expect(f.attributes.delete).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a replaced buffer without destroying its foreign replacement", () => {
    const f = fixture();
    const a = attribute();
    const lease = f.leases.allocate(a);
    const replacement = { destroy: vi.fn() };
    f.records.set(a, { buffer: replacement });
    expect(() => lease.assertCurrent()).toThrow(/TN_STORAGE_BUFFER_STALE/);
    lease.dispose();
    expect(f.attributes.delete).not.toHaveBeenCalled();
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(f.records.get(a)?.buffer).toBe(replacement);
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("rejects an attribute changed during allocation and cleans its allocation", () => {
    const f = fixture();
    const create = f.attributes.update.getMockImplementation();
    if (create === undefined) throw new Error("Missing allocation fixture.");
    f.attributes.update.mockImplementation((a, type) => {
      create(a, type);
      a.needsUpdate = true;
    });
    expect(() => f.leases.allocate(attribute())).toThrow(/TN_STORAGE_BUFFER_LAYOUT/);
    expect(f.records.size).toBe(0);
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("cleans failed allocations and all live receipts on teardown without destroying the device", () => {
    const f = fixture();
    f.attributes.update.mockImplementationOnce((a) => {
      f.records.set(a, { buffer: { destroy: f.destroy } });
      throw new Error("allocation failure");
    });
    expect(() => f.leases.allocate(attribute())).toThrow(/allocation failure/);
    expect(f.records.size).toBe(0);
    const one = f.leases.allocate(attribute());
    const two = f.leases.allocate(attribute());
    f.leases.dispose();
    f.leases.dispose();
    expect(f.records.size).toBe(0);
    expect(one.released).toBe(true);
    expect(two.released).toBe(true);
    expect(f.device.destroy).not.toHaveBeenCalled();
    expect(() => f.leases.allocate(attribute())).toThrow(/TN_STORAGE_BUFFER_DISPOSED/);
  });
});

it("forwards the public caller-owned readback target and detaches copied CPU bytes before disposal", async () => {
  const canvas = new EventTarget() as HTMLCanvasElement;
  const target = new ReadbackBuffer(64);
  const bytes = new Float32Array([1, 2, 3, 4]).buffer;
  const copy = vi.fn(async (_attribute: unknown, supplied?: ReadbackBuffer) => {
    if (supplied === undefined) return bytes;
    supplied.buffer = bytes;
    return supplied;
  });
  const renderer = await createRenderer({
    canvas,
    pipelineCensus: false,
    source: {
      createCanvas: () => canvas,
      hasWebGPU: () => true,
      observeResize: () => () => undefined,
      readSize: () => [320, 180],
    },
    webgpuFactory: () => ({
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: () => undefined,
      getArrayBufferAsync: copy,
    }),
  });
  try {
    const result = await renderer.readback(attribute(), target);
    expect(copy.mock.calls[0]?.[1]).toBe(target);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result).not.toBe(bytes);
    expect(new Float32Array(result)).toEqual(new Float32Array([1, 2, 3, 4]));
  } finally {
    target.dispose();
    renderer.dispose();
  }
});
