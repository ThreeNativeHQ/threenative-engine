import { afterEach, describe, expect, it, vi } from "vitest";
import { hangingRigging } from "../src/game.js";
import { buildRiggingModel } from "../src/physics/model.js";
import { PASS_STRIDE } from "../src/physics/vendor/avbd2d/gpu/layout.js";
import { GpuSolver3D } from "../src/physics/vendor/avbd3d/gpu/solver.js";
import { Rigid } from "../src/physics/vendor/avbd3d/ref/body.js";
import { Solver } from "../src/physics/vendor/avbd3d/ref/solver.js";

function fixture(reference?: Solver) {
  vi.stubGlobal("GPUBufferUsage", {
    MAP_READ: 1,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  const events: string[] = [];
  const writes: { label: string; data: ArrayBuffer }[] = [];
  const raw = {
    features: new Set(["timestamp-query"]),
    limits: { maxStorageBuffersPerShaderStage: 8 },
    createBuffer: (d: { size: number; label: string }) => {
      const data = new ArrayBuffer(d.size);
      return {
        label: d.label,
        size: d.size,
        destroy: vi.fn(),
        getMappedRange: () => data,
        unmap: vi.fn(),
      };
    },
    createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      clearBuffer: () => events.push("clear"),
      beginComputePass: (descriptor: GPUComputePassDescriptor) => {
        events.push(`phase:${descriptor.label}`);
        return {
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => undefined,
          dispatchWorkgroupsIndirect: () => undefined,
          end: () => events.push("phase-end"),
        };
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (
        buffer: { label: string },
        _offset: number,
        data: ArrayBuffer | ArrayBufferView,
      ) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        writes.push({ label: buffer.label, data: bytes.slice().buffer });
        events.push("upload");
      },
      submit: () => events.push("submit"),
    },
  };
  const ref = reference ?? new Solver();
  if (reference === undefined) new Rigid(ref, [0.1, 0.1, 0.1], 1, 0.3, [0, 0, 1]);
  const solver = new GpuSolver3D(raw as unknown as GPUDevice, ref, {
    profileTimings: false,
    spatialSort: false,
  });
  events.length = 0;
  writes.length = 0;
  return { solver, raw, events, writes };
}
afterEach(() => vi.unstubAllGlobals());

describe("pinned donor qualification timestamp hooks", () => {
  it("packs Windward alpha into the actual solver parameters and all twelve iteration passes", () => {
    const f = fixture(buildRiggingModel(hangingRigging(), []).solver);
    try {
      f.solver.step();
      const params = f.writes.find((w) => w.label === "params 3d");
      const passes = f.writes.find((w) => w.label === "pass constants");
      expect(params).toBeDefined();
      expect(passes).toBeDefined();
      const packed = new Float32Array(params?.data ?? new ArrayBuffer(0));
      expect(packed[0]).toBe(Math.fround(1 / 60));
      expect(packed[1]).toBe(Math.fround(-9.81));
      expect(packed[5]).toBe(Math.fround(0.95));
      const constants = new Float32Array(passes?.data ?? new ArrayBuffer(0));
      const count = 12 * (f.solver.colorCap + 1);
      expect(constants.byteLength).toBe(count * PASS_STRIDE);
      for (let i = 0; i < count; i++)
        expect(constants[(i * PASS_STRIDE) / 4 + 1]).toBe(Math.fround(0.95));
    } finally {
      f.solver.destroy();
    }
  });

  it("disables the unused single-map profiler and freezes fourpasses with a stamp before allthreeclears", () => {
    const f = fixture();
    expect(f.raw.createQuerySet).not.toHaveBeenCalled();
    f.solver.splitPasses = true;
    f.solver.stepTiming = {
      beforeClears: () => f.events.push("preclear-stamp"),
      phase: (index) => {
        f.events.push(`timestamp:${index}`);
        return {} as GPUComputePassTimestampWrites;
      },
    };
    f.solver.step();
    const start = f.events.indexOf("preclear-stamp");
    expect(f.events.slice(start, start + 4)).toEqual(["preclear-stamp", "clear", "clear", "clear"]);
    expect(f.events.filter((e) => e.startsWith("timestamp:"))).toEqual([
      "timestamp:0",
      "timestamp:1",
      "timestamp:2",
      "timestamp:3",
    ]);
    expect(f.events.filter((e) => e === "phase-end")).toHaveLength(4);
    expect(f.events.at(-1)).toBe("submit");
  });
  it("rejects a changed pass partition before anyupload or dispatch", () => {
    const f = fixture();
    f.solver.stepTiming = { beforeClears: vi.fn(), phase: vi.fn() };
    expect(() => f.solver.step()).toThrow(/TN_AVBD_TIMING_PARTITION/);
    expect(f.events).toEqual([]);
  });
  it("retains the same fourpasses when hooks areoff", () => {
    const f = fixture();
    f.solver.splitPasses = true;
    f.solver.step();
    expect(f.events.filter((e) => e.startsWith("phase:")).length).toBe(4);
    expect(f.events).not.toContain("preclear-stamp");
    expect(f.raw.createQuerySet).not.toHaveBeenCalled();
  });
});
