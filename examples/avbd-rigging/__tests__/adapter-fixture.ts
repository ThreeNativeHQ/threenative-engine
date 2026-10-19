import type { IComputeDriven } from "@threenative/core";
import { vi } from "vitest";
type IRendererLike = Parameters<IComputeDriven["process"]>[0];
import {
  AvbdRigging,
  type IAvbdOptions,
  type ISecondarySolver,
} from "../src/physics/avbd-adapter.js";
import { type IRiggingInput, referenceRigging } from "../src/physics/topology.js";
import { gpuParams3D } from "../src/physics/vendor/avbd3d/gpu/solver.js";

export function fixture(custom?: IRiggingInput, options: Partial<IAvbdOptions> = {}) {
  const input = custom ?? referenceRigging();
  if (custom === undefined) {
    input.patches = [input.patches[1]].filter((p) => p !== undefined);
    input.ropes = [];
  }
  let land: ((bytes: ArrayBuffer) => void) | undefined;
  const read = new Promise<ArrayBuffer>((resolve) => {
    land = resolve;
  });
  let landed = new ArrayBuffer(0);
  const buffers: { originalDestroy: ReturnType<typeof vi.fn> }[] = [];
  const device = {
    limits: { maxBufferSize: 1024 * 1024, maxStorageBufferBindingSize: 1024 * 1024 },
    createBuffer: vi.fn((descriptor: { size: number }) => {
      const originalDestroy = vi.fn();
      const buffer = {
        size: descriptor.size,
        originalDestroy,
        destroy: originalDestroy,
        mapState: "unmapped",
        mapAsync: () =>
          read.then((bytes) => {
            landed = bytes;
            buffer.mapState = "mapped";
          }),
        getMappedRange: () => landed,
        unmap: () => {
          buffer.mapState = "unmapped";
        },
      };
      buffers.push(buffer);
      return buffer;
    }),
    createCommandEncoder: () => ({ copyBufferToBuffer: vi.fn(), finish: () => ({}) }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
    queue: { onSubmittedWorkDone: vi.fn(async () => undefined), submit: vi.fn() },
    destroy: vi.fn(),
  };
  const leases: { released: boolean; dispose: ReturnType<typeof vi.fn> }[] = [];
  const renderer = {
    readback: vi.fn(() => read),
    storageBuffer: vi.fn((attribute) => {
      const lease = {
        device,
        buffer: { size: attribute.array.byteLength },
        byteLength: attribute.array.byteLength,
        released: false,
        assertCurrent: vi.fn(),
        dispose: vi.fn(() => {
          lease.released = true;
        }),
      };
      leases.push(lease);
      return lease;
    }),
  } as unknown as IRendererLike;
  const order: string[] = [];
  const solver: ISecondarySolver = {
    params: { ...gpuParams3D(), iterations: 12 },
    contactStorage: { counters: {} as GPUBuffer },
    setWorldAnchor: vi.fn(() => order.push("anchor")),
    rewriteFixed: vi.fn(),
    step: vi.fn(() => order.push("step")),
  };
  const rigging = new AvbdRigging({
    input,
    proxies: [],
    readbackEveryTicks: 1,
    snapshot: (model) => {
      order.push("snapshot");
      return { anchors: model.anchors.map((a) => [...a.position]), proxies: [] };
    },
    ...options,
    solverFactory: (borrowed) => {
      borrowed.createBuffer({ size: 64, usage: 128 });
      return solver;
    },
  });
  return { rigging, renderer, solver, order, device, land, leases, buffers };
}
