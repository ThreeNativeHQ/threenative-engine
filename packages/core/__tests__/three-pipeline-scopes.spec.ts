import { setImmediate } from "node:timers/promises";
import { BufferGeometry, Mesh, MeshBasicMaterial, NoBlending } from "three";
// @ts-expect-error Three's private pipeline utility has no public declaration.
import WebGPUPipelineUtils from "three/src/renderers/webgpu/utils/WebGPUPipelineUtils.js";
import { WebGPURenderer } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

interface IScope {
  error: { message: string } | null;
}

interface IPendingPipeline {
  resolve: (pipeline: object) => void;
  reject: (error: Error) => void;
}

function fixture(mode: string) {
  const records = new WeakMap<object, Record<string, unknown>>();
  const scopes: IScope[] = [];
  const uncaptured: string[] = [];
  const pending: IPendingPipeline[] = [];
  const device = {
    pushErrorScope: () => scopes.push({ error: null }),
    popErrorScope: vi.fn(() => Promise.resolve(scopes.pop()?.error ?? null)),
    createPipelineLayout: () => ({}),
    createRenderPipelineAsync: () =>
      new Promise<object>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
  const backend = {
    device,
    parameters: { reversedDepthBuffer: false },
    get(object: object) {
      let record = records.get(object);
      if (record === undefined) {
        record = {};
        records.set(object, record);
      }
      return record;
    },
    attributeUtils: { createShaderVertexBuffers: () => [] },
    utils: {
      getPrimitiveTopology: () => "triangle-list",
      getCurrentColorFormat: () => "bgra8unorm",
      getCurrentDepthStencilFormat: () => "depth24plus",
      getSampleCountRenderContext: () => 1,
    },
  };
  const createRenderObject = (name = "async-probe") => {
    const material = new MeshBasicMaterial({ blending: NoBlending });
    material.name = name;
    const object = new Mesh(new BufferGeometry(), material);
    const pipeline = { vertexProgram: {}, fragmentProgram: {} };
    for (const program of [pipeline.vertexProgram, pipeline.fragmentProgram]) {
      backend.get(program).module = { module: {} };
    }
    return {
      object,
      material,
      geometry: object.geometry,
      pipeline,
      context: { textures: null, depth: false, stencil: false },
      getBindings: () => [],
    };
  };
  const utilities =
    mode === "source"
      ? new WebGPUPipelineUtils(backend)
      : Reflect.get(
          new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement }).backend,
          "pipelineUtils",
        );
  utilities.backend = backend;
  const shaderDiagnostics = vi.fn().mockResolvedValue(undefined);
  utilities._reportShaderDiagnostics = shaderDiagnostics;
  const error = (message: string) => {
    const current = scopes.at(-1);
    if (current === undefined) uncaptured.push(message);
    else current.error ??= { message };
  };
  return {
    utilities,
    backend,
    device,
    renderObject: createRenderObject(),
    createRenderObject,
    shaderDiagnostics,
    scopes,
    uncaptured,
    pending,
    error,
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["source", "distribution"])("%s async render pipeline validation scope", (mode) => {
  it("does not capture an unrelated render error while compilation is pending", async () => {
    const state = fixture(mode);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    state.error("invalid overlay command");
    state.pending[0]?.resolve({});
    await Promise.all(promises);
    expect(state.uncaptured).toEqual(["invalid overlay command"]);
    expect(state.backend.get(state.renderObject.pipeline).error).not.toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(state.scopes).toHaveLength(0);
  });

  it("closes its scope synchronously before the pipeline promise settles", async () => {
    const state = fixture(mode);
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    const remaining = state.scopes.length;
    state.pending[0]?.resolve({});
    await Promise.all(promises);
    expect(remaining).toBe(0);
  });

  it("preserves the caller's scope while compilation is pending", async () => {
    const state = fixture(mode);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.device.pushErrorScope();
    const callerScope = state.scopes[0];
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    state.error("caller validation error");
    const callerError = callerScope?.error;
    state.pending[0]?.resolve({});
    await Promise.all(promises);
    expect(callerError).toEqual({ message: "caller validation error" });
    expect(state.scopes).toEqual([callerScope]);
    expect(state.backend.get(state.renderObject.pipeline).error).not.toBe(true);
  });

  it("attributes a rejection to its own pipeline when compilations settle in reverse order", async () => {
    const state = fixture(mode);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = state.createRenderObject("second-pipeline");
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    state.utilities.createRenderPipeline(second, promises);
    state.pending[1]?.reject(new Error("second shader failed"));
    await promises[1];
    expect(state.backend.get(second.pipeline).error).toBe(true);
    expect(state.backend.get(state.renderObject.pipeline).error).not.toBe(true);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("second shader failed"));
    expect(state.shaderDiagnostics).toHaveBeenCalledOnce();
    state.pending[0]?.resolve({});
    await promises[0];
    expect(state.scopes).toHaveLength(0);
    expect(errors).toHaveBeenCalledOnce();
  });

  it("handles a scope-pop rejection before the pipeline settles", async () => {
    const state = fixture(mode);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectScope: (error: Error) => void = () => undefined;
    const scopeResult = new Promise<null>((_, reject) => {
      rejectScope = reject;
    });
    state.device.popErrorScope.mockImplementation(() => {
      state.scopes.pop();
      return scopeResult;
    });
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    rejectScope(new Error("scope unavailable"));
    // Leave a full event-loop turn for an unhandled rejection to be reported.
    await setImmediate();
    const scopesClosedBeforeSettlement = state.device.popErrorScope.mock.calls.length;
    state.pending[0]?.resolve({});
    await Promise.all(promises);
    expect(scopesClosedBeforeSettlement).toBe(1);
    expect(state.backend.get(state.renderObject.pipeline).error).toBe(true);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("scope unavailable"));
    expect(state.shaderDiagnostics).toHaveBeenCalledOnce();
    expect(state.scopes).toHaveLength(0);
  });

  it("waits for delayed scope results and reports their validation error", async () => {
    const state = fixture(mode);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveScope: (error: { message: string } | null) => void = () => undefined;
    const scopeResult = new Promise<{ message: string } | null>((resolve) => {
      resolveScope = resolve;
    });
    state.device.popErrorScope.mockImplementation(() => {
      state.scopes.pop();
      return scopeResult;
    });
    const promises: Promise<unknown>[] = [];
    state.utilities.createRenderPipeline(state.renderObject, promises);
    let settled = false;
    void promises[0]?.then(() => {
      settled = true;
    });
    state.pending[0]?.resolve({});
    await setImmediate();
    expect(settled).toBe(false);
    resolveScope({ message: "pipeline layout validation failed" });
    await Promise.all(promises);
    expect(settled).toBe(true);
    expect(state.backend.get(state.renderObject.pipeline).error).toBe(true);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("pipeline layout validation failed"),
    );
    expect(state.shaderDiagnostics).toHaveBeenCalledOnce();
  });
});
