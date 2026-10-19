import { afterEach, describe, expect, it, vi } from "vitest";

import { installGpuPipelineDiagnostics } from "../src/runner/traceRun.js";

const PIPELINE_DIAGNOSTICS = "__TN_TRACE_INVALID_GPU_PIPELINES__";
const originalGpuDevice = Object.getOwnPropertyDescriptor(globalThis, "GPUDevice");

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, PIPELINE_DIAGNOSTICS);
  Reflect.deleteProperty(globalThis, "__TN_TRACE_GPU_PIPELINES_INSTALLED__");
  if (originalGpuDevice === undefined) Reflect.deleteProperty(globalThis, "GPUDevice");
  else Object.defineProperty(globalThis, "GPUDevice", originalGpuDevice);
});

describe("GPU pipeline diagnostics", () => {
  it("records the call-site stack for an invalid depth pipeline and still calls WebGPU", async () => {
    const descriptors: unknown[] = [];
    const rejected = Promise.reject(new Error("WebGPU validation rejected the pipeline"));
    class FakeGpuDevice {
      readonly marker = "receiver-preserved";

      createRenderPipelineAsync(descriptor: unknown): Promise<never> {
        expect(this.marker).toBe("receiver-preserved");
        descriptors.push(descriptor);
        return rejected;
      }
    }
    Object.defineProperty(globalThis, "GPUDevice", { configurable: true, value: FakeGpuDevice });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    installGpuPipelineDiagnostics();
    const descriptor = { depthStencil: { depthWriteEnabled: true }, label: "water-depth" };
    const result = new FakeGpuDevice().createRenderPipelineAsync(descriptor);
    const diagnostics = (globalThis as Record<string, unknown>)[PIPELINE_DIAGNOSTICS] as Array<{
      depthStencil: unknown;
      label?: string;
      stack: string;
    }>;

    expect(result).toBe(rejected);
    await expect(result).rejects.toThrow("WebGPU validation rejected the pipeline");
    expect(descriptors).toEqual([descriptor]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ depthStencil: descriptor.depthStencil, label: "water-depth" });
    expect(diagnostics[0]?.stack).toContain("trace-run.spec.ts");
  });

  it("does not report a valid depth pipeline", async () => {
    class FakeGpuDevice {
      createRenderPipelineAsync(_descriptor: unknown): Promise<string> {
        return Promise.resolve("ok");
      }
    }
    Object.defineProperty(globalThis, "GPUDevice", { configurable: true, value: FakeGpuDevice });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const original = FakeGpuDevice.prototype.createRenderPipelineAsync;
    installGpuPipelineDiagnostics();
    expect(FakeGpuDevice.prototype.createRenderPipelineAsync).not.toBe(original);
    await new FakeGpuDevice().createRenderPipelineAsync({ depthStencil: { format: "depth24plus" } });

    expect((globalThis as Record<string, unknown>)[PIPELINE_DIAGNOSTICS]).toEqual([]);
  });
});
