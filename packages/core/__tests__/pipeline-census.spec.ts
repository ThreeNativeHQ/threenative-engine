import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import {
  type IPipelineCensus,
  PIPELINE_CENSUS_CAPABILITY,
  createPipelineCensus,
} from "../src/pipeline-census.js";

function renderObject(
  pipeline: Record<string, unknown>,
  object: Record<string, unknown>,
  material: Record<string, unknown>,
): Record<string, unknown> {
  return {
    object,
    material,
    pipeline,
  };
}

function source(seed: string): string {
  return `@vertex fn vs() -> ${seed}`;
}

interface IStubDevice {
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipelineAsync: (descriptor: Record<string, unknown>) => Promise<unknown>;
  createComputePipeline: (descriptor: Record<string, unknown>) => unknown;
}

interface IStubBackend {
  device: IStubDevice;
  createProgram: (program: Record<string, unknown>) => void;
  createRenderPipeline: (renderObject?: Record<string, unknown>, promises?: unknown) => void;
  createComputePipeline: (pipeline: Record<string, unknown>) => void;
  get: (key: object) => Record<string, unknown>;
}

/** three's Pipelines: every stage becomes a module before the backend is asked for a pipeline. */
interface IStubPipelines {
  getForRender: (renderObject: Record<string, unknown>, promises: unknown) => void;
  getForCompute: (pipeline: Record<string, unknown>) => void;
}

/**
 * The shape three actually presents: the backend delegates every pipeline it owns to the device,
 * and three's own texture pass utils reach the same device directly for mipmap transfer pipelines.
 */
function webgpuStub(): { backend: IStubBackend; device: IStubDevice; pipelines: IStubPipelines } {
  let pipelineId = 0;
  const device: IStubDevice = {
    createShaderModule: (descriptor: Record<string, unknown>) => ({ label: descriptor.label }),
    createRenderPipeline: (_descriptor: Record<string, unknown>) => ({ _pipelineId: ++pipelineId }),
    createRenderPipelineAsync: async (_descriptor: Record<string, unknown>) => ({
      _pipelineId: ++pipelineId,
    }),
    createComputePipeline: (_descriptor: Record<string, unknown>) => ({
      _pipelineId: ++pipelineId,
    }),
  };
  const data = new WeakMap<object, Record<string, unknown>>();
  // three's DataMap creates the entry on first read, so a reader may reach a stage before its
  // module lands there.
  const get = (key: object): Record<string, unknown> => {
    const existing = data.get(key);
    if (existing !== undefined) return existing;
    const entry: Record<string, unknown> = {};
    data.set(key, entry);
    return entry;
  };
  // WebGPUBackend.createProgram: one module per stage, stored as { module, entryPoint }, once.
  const createProgram = (program: Record<string, unknown>): void => {
    const entry = get(program);
    if (entry.module !== undefined) return;
    entry.module = {
      module: device.createShaderModule({ label: "stage", code: program.code }),
      entryPoint: "main",
    };
  };
  // WebGPUPipelineUtils reads backend.get(program).module straight into the pipeline descriptor.
  const stageOf = (program: unknown): unknown =>
    program === null || typeof program !== "object" ? undefined : get(program).module;
  const backend: IStubBackend = {
    device,
    get,
    createProgram,
    createRenderPipeline: (renderObject, promises) => {
      if (renderObject === undefined) return;
      const pipeline = renderObject.pipeline as Record<string, unknown>;
      const descriptor = {
        label: "renderPipeline",
        vertex: stageOf(pipeline.vertexProgram),
        fragment: stageOf(pipeline.fragmentProgram),
      };
      if (Array.isArray(promises)) {
        const created = device.createRenderPipelineAsync(descriptor) as Promise<unknown>;
        promises.push(
          created.then((handle) => {
            get(pipeline).pipeline = handle;
          }),
        );
        return;
      }
      get(pipeline).pipeline = device.createRenderPipeline(descriptor);
    },
    createComputePipeline: (pipeline: Record<string, unknown>) => {
      get(pipeline).pipeline = device.createComputePipeline({
        label: "computePipeline",
        compute: stageOf(pipeline.computeProgram),
      });
    },
  };
  const program = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate === null || typeof candidate !== "object"
      ? undefined
      : (candidate as Record<string, unknown>);
  const pipelines: IStubPipelines = {
    getForRender: (renderObject: Record<string, unknown>, promises: unknown) => {
      const pipeline = renderObject.pipeline as Record<string, unknown>;
      for (const stage of [pipeline.vertexProgram, pipeline.fragmentProgram]) {
        const owned = program(stage);
        if (owned !== undefined) createProgram(owned);
      }
      backend.createRenderPipeline(renderObject, promises);
    },
    getForCompute: (pipeline: Record<string, unknown>) => {
      const owned = program(pipeline.computeProgram);
      if (owned !== undefined) createProgram(owned);
      backend.createComputePipeline(pipeline);
    },
  };
  return { backend, device, pipelines };
}

describe("pipeline census", () => {
  it("records the mipmap pipelines three creates straight on the device", () => {
    const { backend, device } = webgpuStub();
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });

    // three's WebGPUTexturePassUtils builds one module and one transfer pipeline per format.
    const module = device.createShaderModule({ label: "mipmap", code: source("mipmap") });
    device.createRenderPipeline({
      label: "mipmap-rgba8unorm-2d-array",
      vertex: { module },
      fragment: { module, entryPoint: "main_2d_array" },
      layout: "auto",
    });
    census.firstPresent();

    const report = census.snapshot();
    expect(report.counts).toMatchObject({
      creations: 1,
      deviceCreations: 1,
      directCreations: 1,
      recordedEvents: 1,
    });
    const event = report.events[0];
    expect(event?.label).toBe("mipmap-rgba8unorm-2d-array");
    expect(event?.pass).toBe("unknown");
    expect(event?.provenance).toEqual({ unknown: true });
    expect(event?.pipelineIdentity).toBe("native-render-1");
    expect(event?.vertex).toEqual(event?.fragment);
    expect(event?.vertex?.bytes).toBeGreaterThan(0);
    expect(report.complete).toBe(true);
  });

  it("does not double count a device creation reached through the backend", async () => {
    const { backend, pipelines } = webgpuStub();
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    const pipeline = (seed: string) => ({
      vertexProgram: { code: source(seed) },
      fragmentProgram: { code: source(`${seed}-fragment`) },
    });

    pipelines.getForRender(renderObject(pipeline("sync"), {}, {}), null);
    const promises: Promise<unknown>[] = [];
    pipelines.getForRender(renderObject(pipeline("async"), {}, {}), promises);
    pipelines.getForCompute({ computeProgram: { code: source("compute") } });
    await Promise.all(promises);
    census.firstPresent();

    const report = census.snapshot();
    expect(report.counts).toMatchObject({
      creations: 3,
      deviceCreations: 3,
      directCreations: 0,
      pending: 0,
      recordedEvents: 3,
    });
    expect(report.events.map(({ mode }) => mode)).toEqual(["sync", "async", "sync"]);
    expect(report.events.map(({ pipelineIdentity }) => pipelineIdentity)).toEqual([
      "native-render-1",
      "native-render-2",
      "native-compute-3",
    ]);
    expect(report.complete).toBe(true);
  });

  it("hashes a stage once by reusing the module observation the device already recorded", () => {
    const { backend, pipelines } = webgpuStub();
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    // three reads a stage's source once, to build its module. A census that hashes the same
    // source again at the pipeline boundary reads it a second time, and a shared stage pays
    // that again for every pipeline that uses it.
    let reads = 0;
    const stage = (code: string): Record<string, unknown> => ({
      get code() {
        reads += 1;
        return code;
      },
    });
    const vertexProgram = stage("hello");
    const fragmentProgram = stage("hello 🌍");

    pipelines.getForRender(renderObject({ vertexProgram, fragmentProgram }, {}, {}), null);
    pipelines.getForRender(
      renderObject({ cacheKey: "second", vertexProgram, fragmentProgram }, {}, {}),
      null,
    );

    expect(reads).toBe(2);
    const { events, counts } = census.snapshot();
    // The reused identity is the one the fallback hash produces for the same source.
    expect(events[0]?.vertex).toEqual({ bytes: 5, hash: "a430d84680aabd0b" });
    expect(events[0]?.fragment).toEqual({ bytes: 10, hash: "0e21106f2f89a3cf" });
    expect(events[1]?.vertex).toEqual(events[0]?.vertex);
    expect(counts).toMatchObject({ creations: 2, uniquePrograms: 1, uniquePipelines: 2 });
  });

  it("hashes the stage source when the backend exposes no module for it", () => {
    // A legacy or partially initialised backend hands back stage data with no module; the
    // observation still has to land, from the source, exactly once per stage.
    let reads = 0;
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    const vertexProgram = {
      get code() {
        reads += 1;
        return "hello";
      },
    };

    backend.createRenderPipeline(
      renderObject({ vertexProgram, fragmentProgram: { code: "hello 🌍" } }, {}, {}),
      null,
    );
    backend.createRenderPipeline(
      renderObject(
        { cacheKey: "second", vertexProgram, fragmentProgram: { code: "hello 🌍" } },
        {},
        {},
      ),
      null,
    );

    expect(reads).toBe(1);
    expect(census.snapshot().events[0]?.vertex).toEqual({ bytes: 5, hash: "a430d84680aabd0b" });
  });

  it("fails closed when a device pipeline names a shader module the collector never saw", () => {
    const { backend, device } = webgpuStub();
    // Installed too late: the module predates the collector, so its bytes are unknowable.
    const module = device.createShaderModule({ label: "mipmap", code: source("mipmap") });
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    device.createRenderPipeline({
      label: "mipmap-rgba8unorm-srgb-2d-array",
      vertex: { module },
      fragment: { module },
    });

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain(
      "a render pipeline is missing its vertex shader observation",
    );
    expect(report.events[0]?.vertex).toBeUndefined();
  });

  it("reports incomplete when a WebGPU backend exposes no observable device", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    backend.createRenderPipeline(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      null,
    );

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain("device creation observation unavailable");
    expect(report.counts.deviceCreations).toBeUndefined();
  });

  it("reports incomplete when one device creation method refuses the hook", () => {
    const { backend, device, pipelines } = webgpuStub();
    // A host binds some of its device methods as non-writable own properties. Observing the
    // rest is not observing the device: the creations reaching the refused method are invisible.
    Object.defineProperty(device, "createRenderPipeline", {
      value: device.createRenderPipeline,
      writable: false,
      configurable: true,
    });
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });

    pipelines.getForCompute({ computeProgram: { code: source("compute") } });
    const module = device.createShaderModule({ label: "mipmap", code: source("mipmap") });
    device.createRenderPipeline({
      label: "mipmap-rgba8unorm-2d-array",
      vertex: { module },
      fragment: { module },
    });

    const report = census.snapshot();
    expect(report.incompleteReasons).toContain(
      "device method createRenderPipeline could not be observed",
    );
    expect(report.complete).toBe(false);
    // What was observed is still reported, and reads short by exactly the refused method.
    expect(report.counts).toMatchObject({ creations: 1, deviceCreations: 1, directCreations: 0 });
  });

  it("stays complete when a device simply has no async creation methods", () => {
    // An absent method issues no work, so it is not a missing observation.
    const { backend, device, pipelines } = webgpuStub();
    const trimmed = device as { createRenderPipelineAsync?: unknown };
    trimmed.createRenderPipelineAsync = undefined;
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });

    pipelines.getForRender(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      null,
    );

    const report = census.snapshot();
    expect(report.incompleteReasons).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("distinguishes an absent fragment stage from an unobserved fragment stage", () => {
    const depthOnly = webgpuStub();
    const depthOnlyCensus = createPipelineCensus({ kind: "webgpu" });
    depthOnlyCensus.installRenderer({ backend: depthOnly.backend });
    depthOnly.pipelines.getForRender(
      renderObject({ vertexProgram: { code: source("depth-only") } }, {}, {}),
      null,
    );
    const depthOnlyReport = depthOnlyCensus.snapshot();
    expect(depthOnlyReport.complete).toBe(true);
    expect(depthOnlyReport.events[0]?.fragment).toBeUndefined();

    const unobserved = webgpuStub();
    const unobservedCensus = createPipelineCensus({ kind: "webgpu" });
    unobservedCensus.installRenderer({ backend: unobserved.backend });
    unobserved.pipelines.getForRender(
      renderObject({ vertexProgram: { code: source("vertex") }, fragmentProgram: {} }, {}, {}),
      null,
    );
    const unobservedReport = unobservedCensus.snapshot();
    expect(unobservedReport.complete).toBe(false);
    expect(unobservedReport.incompleteReasons).toEqual([
      "a render pipeline is missing its fragment shader observation",
    ]);
  });

  it("restores the device hooks it installed on dispose", () => {
    const { backend, device } = webgpuStub();
    const originalRenderPipeline = device.createRenderPipeline;
    const originalShaderModule = device.createShaderModule;
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    expect(device.createRenderPipeline).not.toBe(originalRenderPipeline);
    census.dispose();

    expect(device.createRenderPipeline).toBe(originalRenderPipeline);
    expect(device.createShaderModule).toBe(originalShaderModule);
    const module = device.createShaderModule({ label: "mipmap", code: source("mipmap") });
    device.createRenderPipeline({ label: "mipmap-rgba8unorm-2d-array", vertex: { module } });
    expect(census.snapshot().counts.creations).toBe(0);
  });

  it("leaves a browser device carrying no own pipeline methods after dispose", () => {
    // A real GPUDevice inherits these from its prototype, so restoring by assignment would leave an
    // own copy behind on an object the collector is only supposed to observe.
    const { device: prototype } = webgpuStub();
    const device = Object.create(prototype) as IStubDevice;
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: { device } });
    expect(Object.hasOwn(device, "createRenderPipeline")).toBe(true);
    census.dispose();

    expect(Object.hasOwn(device, "createRenderPipeline")).toBe(false);
    expect(Object.hasOwn(device, "createShaderModule")).toBe(false);
    expect(device.createRenderPipeline).toBe(prototype.createRenderPipeline);
  });

  it("leaves a device method another owner replaced after install alone on dispose", () => {
    // Teardown restores what this capture put there, never what it finds: a device lost and
    // rebound, or a second profiler installed above, owns the method now.
    const { device: prototype } = webgpuStub();
    const inherited = Object.create(prototype) as IStubDevice;
    const owned = webgpuStub().device;
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: { device: owned } });
    const second = createPipelineCensus({ kind: "webgpu" });
    second.installRenderer({ backend: { device: inherited } });

    const replacement = (_descriptor: Record<string, unknown>) => ({ _pipelineId: -1 });
    const replacementModule = (_descriptor: Record<string, unknown>) => ({ label: "later" });
    owned.createRenderPipeline = replacement;
    owned.createShaderModule = replacementModule;
    inherited.createRenderPipeline = replacement;
    census.dispose();
    second.dispose();

    expect(owned.createRenderPipeline).toBe(replacement);
    expect(owned.createShaderModule).toBe(replacementModule);
    // A prototype method was restored by deleting the own copy; the later owner keeps its own.
    expect(inherited.createRenderPipeline).toBe(replacement);
    expect(Object.hasOwn(inherited, "createShaderModule")).toBe(false);
  });

  it("retains native pipeline handles and the UTF-8 shader identity used by the host", () => {
    let id = 40;
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      // The host mints a handle for a pipeline and records nothing for a stage, so the stage
      // identity has to come from its source.
      get: (key: object) => ("code" in key ? {} : { pipeline: { _pipelineId: ++id } }),
    };
    const raw = { backend };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    const pipeline = {
      vertexProgram: { code: "hello" },
      fragmentProgram: { code: "hello 🌍" },
    };
    backend.createRenderPipeline(renderObject(pipeline, {}, {}), null);
    backend.createRenderPipeline(renderObject({ ...pipeline }, {}, {}), null);
    const { events, counts } = census.snapshot();
    expect(events.map((event) => event.pipelineIdentity)).toEqual([
      "native-render-41",
      "native-render-42",
    ]);
    expect(events[0]?.vertex).toEqual({ bytes: 5, hash: "a430d84680aabd0b" });
    expect(events[0]?.fragment).toEqual({ bytes: 10, hash: "0e21106f2f89a3cf" });
    expect(counts.uniquePrograms).toBe(1);
    expect(counts.uniquePipelines).toBe(2);
  });

  it("reconciles unique programs and pipeline creations across passes", async () => {
    let now = 100;
    const pending: Array<() => void> = [];
    const backend = {
      device: webgpuStub().device,
      createRenderPipeline: (
        pipelineObject: Record<string, unknown>,
        promises: Promise<void>[] | null,
      ) => {
        if (promises === null) return;
        let resolvePending: (() => void) | undefined;
        const settled = new Promise<void>((resolve) => {
          resolvePending = resolve;
        });
        if (resolvePending !== undefined) pending.push(resolvePending);
        promises.push(settled);
      },
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      _nodes: { getForRender: (_renderObject: unknown) => ({}) },
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(
          args[0] as Record<string, unknown>,
          args[1] as Promise<void>[] | null,
        );
      },
    };
    const census = createPipelineCensus({ kind: "webgpu", now: () => now });
    census.installRenderer(raw);

    const sharedProgram = source("vec4f");
    const firstPipeline = {
      cacheKey: "main-shared",
      vertexProgram: { code: sharedProgram },
      fragmentProgram: { code: source("vec4f") },
    };
    raw.renderObject(
      renderObject(firstPipeline, { id: 1, name: "town-house" }, { id: 2, name: "brick" }),
      null,
      null,
      null,
      { id: 2, name: "brick", type: "MeshStandardMaterial" },
      null,
      null,
      null,
      "main",
    );
    now += 4;
    const secondPipeline = {
      cacheKey: "shadow-variant",
      vertexProgram: { code: sharedProgram },
      fragmentProgram: { code: source("vec4f shadow") },
    };
    raw.renderObject(
      renderObject(secondPipeline, { id: 3, name: "town-house-shadow" }, { id: 4, type: "Shadow" }),
      [],
      null,
      null,
      { id: 4, type: "ShadowPassMaterial" },
      null,
      null,
      null,
      "shadow",
    );
    for (const resolve of pending.splice(0)) {
      now += 8;
      resolve();
    }
    await Promise.resolve();
    await Promise.resolve();

    census.firstPresent();
    const report = census.snapshot();
    expect(report.complete).toBe(true);
    expect(report.backend.kind).toBe("webgpu");
    expect(report.build?.identity).toContain("@threenative/core@");
    expect(report.adapter).toMatchObject({ identity: "webgpu:renderer", thermal: "unavailable" });
    expect(report.counts).toMatchObject({
      creations: 2,
      failures: 0,
      pending: 0,
      recordedEvents: 2,
      uniquePipelines: 2,
    });
    expect(report.counts.uniquePrograms).toBe(2);
    expect(report.events.map(({ pass }) => pass)).toEqual(["main", "shadow"]);
    expect(report.events[0]?.provenance.material?.name).toBe("brick");
    expect(report.events[0]?.vertex?.bytes).toBeGreaterThan(0);
    expect(report.events[0]?.vertex?.hash).not.toBe(sharedProgram);
    expect(report.firstPresent?.eventsSettled).toBe(2);
    expect(
      report.events.every(({ vertex, fragment }) => vertex !== undefined && fragment !== undefined),
    ).toBe(true);
  });

  it("counts distinct node-builder states on each side of the warm-up boundary", () => {
    let now = 0;
    const { backend, pipelines } = webgpuStub();
    const nodes = {
      getForRender: (renderObject: Record<string, unknown>) => renderObject.nodeBuilderState,
    };
    const raw = {
      backend,
      _nodes: nodes,
      renderObject: (...args: unknown[]) => {
        const object = args[0] as Record<string, unknown>;
        nodes.getForRender(object);
        pipelines.getForRender(object, args[1]);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu", now: () => now });
    census.installRenderer(raw);

    const firstState = {};
    const first = {
      ...renderObject(
        {
          vertexProgram: { code: source("first vertex") },
          fragmentProgram: { code: source("first fragment") },
        },
        { id: 1 },
        { id: 2 },
      ),
      nodeBuilderState: firstState,
    };
    raw.renderObject(first, null);
    census.warmUpSettled();
    now += 1;

    const secondState = {};
    const second = {
      ...renderObject(
        {
          vertexProgram: { code: source("second vertex") },
          fragmentProgram: { code: source("second fragment") },
        },
        { id: 3 },
        { id: 4 },
      ),
      nodeBuilderState: secondState,
    };
    raw.renderObject(second, null);
    census.warmUpScopeSettled("chunk:0");
    now += 1;
    raw.renderObject(second, null);

    const report = census.snapshot();
    expect(report.counts.nodeBuilds).toBe(2);
    expect(report.warmUpSettled).toMatchObject({
      eventsSettled: 1,
      nodeBuilds: 1,
      renderPipelineCreations: 1,
    });
    expect(report.warmUpScopes).toMatchObject([
      { label: "chunk:0", eventsSettled: 2, nodeBuilds: 2, renderPipelineCreations: 2 },
    ]);
    expect(
      report.events.map(({ nodeBuilds, beforeWarmUpSettled, afterWarmUpScope }) => ({
        nodeBuilds,
        beforeWarmUpSettled,
        ...(afterWarmUpScope === undefined ? {} : { afterWarmUpScope }),
      })),
    ).toEqual([
      { nodeBuilds: 1, beforeWarmUpSettled: true },
      { nodeBuilds: 1, beforeWarmUpSettled: false },
      { nodeBuilds: 0, beforeWarmUpSettled: false, afterWarmUpScope: "chunk:0" },
    ]);
    expect(report.nodeBuilds?.map(({ beforeWarmUpSettled }) => beforeWarmUpSettled)).toEqual([
      true,
      false,
    ]);
  });

  it("observes the renderer-owned node seam for a real Mesh instead of patching the Mesh", () => {
    const { backend } = webgpuStub();
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(geometry, material);
    const state = {};
    const internalRenderObject = {
      object: mesh,
      material,
      pipeline: {
        vertexProgram: { code: source("mesh vertex") },
        fragmentProgram: { code: source("mesh fragment") },
      },
    };
    const originalGetForRender = (_renderObject: unknown): object => state;
    const nodes = { getForRender: originalGetForRender };
    const originalRenderObject = (..._args: unknown[]): void => {
      nodes.getForRender(internalRenderObject);
      backend.createRenderPipeline?.(internalRenderObject, null);
    };
    const raw = { backend, _nodes: nodes, renderObject: originalRenderObject };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);

    raw.renderObject(mesh, {}, {}, geometry, material, null, null, null, "main");

    const report = census.snapshot();
    expect(report.complete).toBe(true);
    expect(report.counts.nodeBuilds).toBe(1);
    expect(report.events[0]?.nodeBuilds).toBe(1);
    expect("getNodeBuilderState" in mesh).toBe(false);

    census.dispose();
    expect(nodes.getForRender).toBe(originalGetForRender);
    expect(raw.renderObject).toBe(originalRenderObject);
    geometry.dispose();
    material.dispose();
  });

  it("binds a scope to its target's completed main frame, including node rebuilds without a pipeline event", () => {
    const { backend } = webgpuStub();
    const target = {};
    const otherTarget = {};
    const world = {};
    const material = { id: 7, name: "chunk-material" };
    const states = [{}, {}];
    let stateIndex = 0;
    let createPipeline = true;
    const nodes = {
      getForRender: (_renderObject: unknown) => states[stateIndex],
    };
    const pipeline = {
      vertexProgram: { code: source("scope vertex") },
      fragmentProgram: { code: source("scope fragment") },
    };
    const raw = {
      backend,
      _nodes: nodes,
      renderObject: (object: unknown, scene: unknown, _camera: unknown, ...rest: unknown[]) => {
        const internal = { object, material, pipeline };
        nodes.getForRender(internal);
        if (createPipeline) backend.createRenderPipeline?.(internal, null);
        void scene;
        void rest;
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);

    raw.renderObject(target, world, {}, {}, material, null, null, null, "main");
    census.warmUpScopeSettled("scope-a", target);
    census.warmUpScopeSettled("scope-b", otherTarget);
    stateIndex = 1;
    createPipeline = false;
    census.beginWorldFrame(world);
    raw.renderObject(target, world, {}, {}, material, null, null, null, "main");
    census.endWorldFrame(world, true);
    census.firstPresent();

    const report = census.snapshot();
    expect(report.counts.nodeBuilds).toBe(2);
    expect(report.warmUpScopes).toEqual([
      expect.objectContaining({
        label: "scope-a",
        firstDraw: {
          nodeBuilds: 1,
          renderPipelineCreations: 0,
        },
      }),
      expect.objectContaining({ label: "scope-b" }),
    ]);
    expect(report.warmUpScopes?.[1]?.firstDraw).toBeUndefined();
    expect(report.events).toHaveLength(1);
    expect(report.events[0]?.afterWarmUpScope).toBeUndefined();
    expect(report.nodeBuilds).toHaveLength(2);
    expect(report.nodeBuilds?.[1]?.provenance.material?.name).toBe("chunk-material");
  });

  it("records a completed zero-work target frame instead of passing a missing draw", () => {
    const { backend } = webgpuStub();
    const target = {};
    const world = {};
    const state = {};
    const pipeline = {
      vertexProgram: { code: source("zero vertex") },
      fragmentProgram: { code: source("zero fragment") },
    };
    const nodes = { getForRender: (_renderObject: unknown) => state };
    const internal = { object: target, material: { name: "warm" }, pipeline };
    const raw = {
      backend,
      _nodes: nodes,
      renderObject: () => {
        nodes.getForRender(internal);
        backend.createRenderPipeline?.(internal, null);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject();
    census.warmUpScopeSettled("zero", target);
    census.beginWorldFrame(world);
    // An unrelated UI frame must not close the target scope.
    raw.renderObject();
    census.endWorldFrame({}, true);
    expect(census.snapshot().warmUpScopes?.[0]?.firstDraw).toBeUndefined();
  });

  it("closes a target scope on a completed cached main draw with zero new node work", () => {
    const target = {};
    const world = {};
    const state = {};
    const nodes = { getForRender: (_renderObject: unknown) => state };
    const raw = {
      _nodes: nodes,
      backend: webgpuStub().backend,
      renderObject: (object: unknown, scene: unknown, _camera: unknown, ...rest: unknown[]) => {
        nodes.getForRender({ object });
        void scene;
        void rest;
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject(target, world, {}, {}, {}, null, null, null, "main");
    census.warmUpScopeSettled("cached", target);
    census.beginWorldFrame(world);
    raw.renderObject(target, world, {}, {}, {}, null, null, null, "main");
    census.endWorldFrame(world, true);

    expect(census.snapshot().warmUpScopes?.[0]?.firstDraw).toEqual({
      nodeBuilds: 0,
      renderPipelineCreations: 0,
    });
  });

  it("keeps draw-time scope matching flat as streamed targets accumulate", () => {
    const { backend } = webgpuStub();
    const world = {};
    const state = {};
    const nodes = { getForRender: (_renderObject: unknown) => state };
    const raw = {
      _nodes: nodes,
      backend,
      renderObject: (object: unknown, scene: unknown, _camera: unknown, ...rest: unknown[]) => {
        nodes.getForRender({ object });
        void scene;
        void rest;
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    const streamed = { parent: world };
    const drawn = { parent: streamed };
    const fastestDrawsMs = (): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 3; round += 1) {
        census.beginWorldFrame(world);
        const startedMs = performance.now();
        for (let draw = 0; draw < 100; draw += 1) {
          raw.renderObject(drawn, world, {}, {}, {}, null, null, null, "main");
        }
        fastest = Math.min(fastest, performance.now() - startedMs);
        census.endWorldFrame(world, true);
      }
      return fastest;
    };
    census.warmUpScopeSettled("streamed:0", streamed);
    const soloMs = fastestDrawsMs();
    for (let index = 1; index < 10_000; index += 1) {
      census.warmUpScopeSettled(`streamed:${index}`, { parent: world });
    }
    const crowdedMs = fastestDrawsMs();

    expect(census.snapshot().warmUpScopes?.[0]?.firstDraw).toBeDefined();
    expect(crowdedMs / Math.max(soloMs, 1), "draw cost with 10,000 scopes vs one").toBeLessThan(50);
  });

  it("fails closed when the renderer-owned node seam cannot be installed", () => {
    const { backend } = webgpuStub();
    const raw = {
      backend,
      _nodes: {},
      renderObject: () => backend.createRenderPipeline?.(),
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject();

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain("node builder observation unavailable");
  });

  it("rejects completeness when creation observation is missing or bounded out", () => {
    const census = createPipelineCensus({ kind: "webgpu", limit: 1 });
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    census.installRenderer(raw);
    const pipeline = {
      vertexProgram: { code: source("vec4f") },
      fragmentProgram: { code: source("vec4f") },
    };
    raw.renderObject(renderObject(pipeline, { id: 1 }, { id: 2 }), null);
    raw.renderObject(renderObject({ ...pipeline, cacheKey: "second" }, { id: 3 }, { id: 4 }), null);

    const report: IPipelineCensus = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.overflowed).toBe(true);
    expect(report.counts).toMatchObject({ creations: 2, droppedEvents: 1, recordedEvents: 1 });
    expect(report.incompleteReasons).toContain("bounded event buffer overflowed");
  });

  it("fails closed when a created pipeline has no shader observation", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      createComputePipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);

    raw.renderObject(renderObject({ fragmentProgram: { code: source("vec4f") } }, {}, {}), null);
    raw.renderObject(
      renderObject({ vertexProgram: { code: source("vertex-only") }, fragmentProgram: {} }, {}, {}),
      null,
    );
    backend.createComputePipeline?.({});

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain(
      "a render pipeline is missing its vertex shader observation",
    );
    expect(report.incompleteReasons).toContain(
      "a render pipeline is missing its fragment shader observation",
    );
    expect(report.incompleteReasons).toContain(
      "a compute pipeline is missing its shader observation",
    );
  });

  it("marks a bypassed collector as unsupported instead of returning an empty success", () => {
    const census = createPipelineCensus({ kind: "webgpu" });
    const report = census.snapshot();
    expect(PIPELINE_CENSUS_CAPABILITY).toBe("runtime.pipelineCensus");
    expect(report.complete).toBe(false);
    expect(report.unsupported).toBe(false);
    expect(report.incompleteReasons).toContain("no pipeline creations observed");
  });

  it("rejects an invalid event limit", () => {
    expect(() => createPipelineCensus({ kind: "webgpu", limit: 0 })).toThrow(
      /TN_PIPELINE_CENSUS_LIMIT_INVALID/u,
    );
    expect(() => createPipelineCensus({ kind: "webgpu", limit: 1.5 })).toThrow(
      /TN_PIPELINE_CENSUS_LIMIT_INVALID/u,
    );
  });

  it("marks a non-object backend install as unsupported and ignores a second renderer", () => {
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: 42 });
    census.installRenderer({ backend: 42 });

    const report = census.snapshot();
    expect(report.unsupported).toBe(true);
    expect(report.incompleteReasons).toContain("backend creation observation unavailable");
  });

  it("reports a device with no observable methods as unobserved", () => {
    const census = createPipelineCensus({ kind: "webgpu" });
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
      device: {},
    };
    census.installRenderer({ backend });
    backend.createRenderPipeline({}, null);

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain("device creation observation unavailable");
  });

  it("records a silently refused device method as unobservable", () => {
    const { device: real } = webgpuStub();
    const device = new Proxy(real, {
      get: (target, property, receiver) => Reflect.get(target, property, target),
      set: (target, property, value) => {
        if (property === "createRenderPipeline") return true;
        return Reflect.set(target, property, value);
      },
    });
    const census = createPipelineCensus({ kind: "webgpu" });
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
      device,
    };
    census.installRenderer({ backend });
    backend.createRenderPipeline({}, null);
    census.dispose();

    const report = census.snapshot();
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toContain(
      "device method createRenderPipeline could not be observed",
    );
  });

  it("reports async backend creations while their promises are still pending", () => {
    const backend = {
      createRenderPipeline: (
        _renderObject: Record<string, unknown>,
        promises: Promise<unknown>[] | null,
      ) => {
        if (Array.isArray(promises)) promises.push(new Promise<unknown>(() => undefined));
      },
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(
          args[0] as Record<string, unknown>,
          args[1] as Promise<unknown>[] | null,
        );
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      [],
    );

    const report = census.snapshot();
    expect(report.counts.pending).toBe(1);
    expect(report.incompleteReasons).toContain("1 pipeline event(s) are pending");
    expect(report.events[0]?.status).toBe("pending");
  });

  it("attributes a device creation nested inside a backend creation", () => {
    const { backend, device, pipelines } = webgpuStub();
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });
    const hooked = device.createRenderPipeline;
    device.createRenderPipeline = (descriptor: Record<string, unknown>) => {
      hooked(descriptor);
      return hooked(descriptor);
    };

    pipelines.getForRender(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      null,
    );

    const report = census.snapshot();
    expect(report.incompleteReasons).toContain(
      "1 device pipeline creation(s) were nested inside a backend creation",
    );
  });

  it("fails a backend async creation whose promise rejects", async () => {
    const backend = {
      createRenderPipeline: (
        _renderObject: Record<string, unknown>,
        promises: Promise<unknown>[] | null,
      ) => {
        if (Array.isArray(promises)) promises.push(Promise.reject(new Error("async-nope")));
      },
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(
          args[0] as Record<string, unknown>,
          args[1] as Promise<unknown>[] | null,
        );
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      [],
    );
    await Promise.resolve();
    await Promise.resolve();

    const report = census.snapshot();
    expect(report.counts).toMatchObject({ failures: 1, pending: 0 });
    expect(report.events[0]?.status).toBe("failed");
    expect(report.events[0]?.error).toBe("async-nope");
    expect(report.incompleteReasons).toContain("1 pipeline creation(s) failed");
  });

  it("fails closed when a sync render creation throws", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => {
        throw new Error("sync-nope");
      },
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);

    expect(() =>
      raw.renderObject(
        renderObject(
          { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
          {},
          {},
        ),
        null,
      ),
    ).toThrow("sync-nope");
    const report = census.snapshot();
    expect(report.counts.failures).toBe(1);
    expect(report.events[0]?.error).toBe("sync-nope");
  });

  it("fails closed when a compute creation throws", () => {
    const backend = {
      createComputePipeline: (..._args: unknown[]) => {
        throw new Error("compute-nope");
      },
      get: () => ({ pipeline: {} }),
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });

    expect(() => backend.createComputePipeline({})).toThrow("compute-nope");
    const report = census.snapshot();
    expect(report.counts.failures).toBe(1);
    expect(report.events[0]?.error).toBe("compute-nope");
  });

  it("observes a direct async device creation once its promise settles", async () => {
    const { backend, device } = webgpuStub();
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend });

    const pending = device.createRenderPipelineAsync({
      label: "direct-async",
      vertex: { module: {} },
      fragment: { module: {} },
    }) as Promise<unknown>;
    expect(census.snapshot().counts.pending).toBe(1);
    await pending;

    const report = census.snapshot();
    expect(report.counts).toMatchObject({ creations: 1, directCreations: 1, pending: 0 });
    expect(report.events[0]).toMatchObject({
      label: "direct-async",
      mode: "async",
      status: "created",
    });
  });

  it("fails a direct async device creation whose promise rejects", async () => {
    const { device } = webgpuStub();
    device.createRenderPipelineAsync = async (_descriptor: Record<string, unknown>) => {
      throw new Error("device-async-nope");
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: { device } });

    const pending = device.createRenderPipelineAsync({ label: "direct-async-reject" });
    await expect(pending).rejects.toThrow("device-async-nope");
    await Promise.resolve();

    const report = census.snapshot();
    expect(report.counts.failures).toBe(1);
    expect(report.events[0]?.error).toBe("device-async-nope");
  });

  it("times an async device method that returns no promise as a synchronous call", () => {
    const { device } = webgpuStub();
    device.createRenderPipelineAsync = ((_descriptor: Record<string, unknown>) => ({})) as never;
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: { device } });

    device.createRenderPipelineAsync({ label: "not-a-promise" });

    const report = census.snapshot();
    expect(report.events[0]).toMatchObject({ mode: "sync", status: "created" });
    expect(report.events[0]?.promiseMs).toBeUndefined();
  });

  it("fails a direct device creation whose call throws", () => {
    const { device } = webgpuStub();
    device.createRenderPipeline = (_descriptor: Record<string, unknown>) => {
      throw new Error("device-sync-nope");
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer({ backend: { device } });

    expect(() => device.createRenderPipeline({ label: "direct-throw" })).toThrow(
      "device-sync-nope",
    );
    const report = census.snapshot();
    expect(report.counts.failures).toBe(1);
  });

  it("hashes stage sources when the backend get throws", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: (_value: unknown): unknown => {
        throw new Error("get-nope");
      },
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject(
      renderObject(
        { vertexProgram: { code: "hello" }, fragmentProgram: { code: "hello 🌍" } },
        {},
        {},
      ),
      null,
    );

    const report = census.snapshot();
    expect(report.events[0]?.vertex).toEqual({ bytes: 5, hash: "a430d84680aabd0b" });
    expect(report.events[0]?.status).toBe("failed");
  });

  it("keeps the logical pipeline identity outside webgpu reconciliation", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgl2" });
    census.installRenderer(raw);
    raw.renderObject(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        {},
        {},
      ),
      null,
    );

    const report = census.snapshot();
    expect(report.complete).toBe(true);
    expect(report.events[0]?.pipelineIdentity).toMatch(/^logical-pipeline-/u);
  });

  it("reuses identities for a repeated pipeline object and names a keyless one unknown", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgl2" });
    census.installRenderer(raw);
    const pipeline = {
      vertexProgram: { code: source("v") },
      fragmentProgram: { code: source("f") },
    };
    raw.renderObject(renderObject(pipeline, {}, {}), null);
    raw.renderObject(renderObject(pipeline, {}, {}), null);
    raw.renderObject({ object: {}, material: {} }, null);

    const report = census.snapshot();
    expect(report.events).toHaveLength(3);
    expect(report.events[0]?.pipelineIdentity).toMatch(/^logical-pipeline-/u);
    expect(report.events[1]?.pipelineIdentity).toBe(report.events[0]?.pipelineIdentity);
    expect(report.events[2]?.pipelineIdentity).toBe("logical-pipeline-unknown");
    expect(report.counts.uniquePipelines).toBe(2);
  });

  it("reads a non-object device handle as unknown and reuses a repeated handle", () => {
    const first = webgpuStub();
    first.device.createRenderPipeline = ((_descriptor: Record<string, unknown>) => 42) as never;
    const unknownCensus = createPipelineCensus({ kind: "webgpu" });
    unknownCensus.installRenderer({ backend: { device: first.device } });
    first.device.createRenderPipeline({ label: "handle-42" });
    expect(unknownCensus.snapshot().events[0]?.pipelineIdentity).toBe("backend-pipeline-unknown");

    const second = webgpuStub();
    const shared = {};
    second.device.createRenderPipeline = ((_descriptor: Record<string, unknown>) =>
      shared) as never;
    const reusedCensus = createPipelineCensus({ kind: "webgpu" });
    reusedCensus.installRenderer({ backend: { device: second.device } });
    second.device.createRenderPipeline({ label: "shared" });
    second.device.createRenderPipeline({ label: "shared" });
    const reused = reusedCensus.snapshot();
    expect(reused.events.map(({ pipelineIdentity }) => pipelineIdentity)).toEqual([
      reused.events[0]?.pipelineIdentity,
      reused.events[0]?.pipelineIdentity,
    ]);
    expect(reused.counts.uniquePipelines).toBe(1);
  });

  it("hashes stage sources without TextEncoder", () => {
    const previous = (globalThis as Record<string, unknown>).TextEncoder;
    (globalThis as Record<string, unknown>).TextEncoder = undefined;
    try {
      const { backend, pipelines } = webgpuStub();
      const census = createPipelineCensus({ kind: "webgpu" });
      census.installRenderer({ backend });
      const program = { code: "hello" };
      pipelines.getForRender(renderObject({ vertexProgram: program }, {}, {}), null);

      expect(census.snapshot().events[0]?.vertex).toEqual({
        bytes: 5,
        hash: "a430d84680aabd0b",
      });
    } finally {
      (globalThis as Record<string, unknown>).TextEncoder = previous;
    }
  });

  it("classifies shadow and clipped passes from the render-object context", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    const pipeline = (seed: string) => ({
      cacheKey: seed,
      vertexProgram: { code: source(seed) },
      fragmentProgram: { code: source(`${seed}-fragment`) },
    });

    raw.renderObject(
      renderObject(pipeline("shadow-pass"), {}, {}),
      null,
      null,
      null,
      {},
      null,
      null,
      { shadowPass: true },
      null,
    );
    raw.renderObject(
      renderObject(pipeline("clipped"), {}, {}),
      null,
      null,
      null,
      {},
      null,
      null,
      {},
      null,
    );
    raw.renderObject(
      renderObject(pipeline("depth"), {}, { name: "depth-prepass" }),
      null,
      null,
      null,
      {},
      null,
      null,
      null,
      null,
    );

    expect(census.snapshot().events.map(({ pass }) => pass)).toEqual([
      "shadow",
      "main-clipped",
      "shadow",
    ]);
  });

  it("reports instancing and texture inputs as structural reasons", () => {
    const backend = {
      createRenderPipeline: (..._args: unknown[]) => undefined,
      get: () => ({ pipeline: {} }),
    };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    raw.renderObject(
      renderObject(
        { vertexProgram: { code: source("v") }, fragmentProgram: { code: source("f") } },
        { isInstancedMesh: true },
        { map: {}, name: "brick" },
      ),
      null,
    );

    const event = census.snapshot().events[0];
    expect(event?.reasons).toContain("instancing");
    expect(event?.reasons).toContain("map");
  });

  it("classifies main, shadow, PMREM, and output pipeline observations", () => {
    const backend = { createRenderPipeline: (..._args: unknown[]) => ({}) };
    const raw = {
      backend,
      renderObject: (...args: unknown[]) => {
        backend.createRenderPipeline?.(...args);
      },
    };
    const census = createPipelineCensus({ kind: "webgpu" });
    census.installRenderer(raw);
    const pipeline = (cacheKey: string) => ({
      cacheKey,
      vertexProgram: { code: source(cacheKey) },
      fragmentProgram: { code: source(`${cacheKey}-fragment`) },
    });

    raw.renderObject(renderObject(pipeline("main"), {}, { name: "Town" }), null);
    raw.renderObject(
      renderObject(pipeline("shadow"), {}, { name: "Town", isShadowPassMaterial: true }),
      null,
    );
    raw.renderObject(renderObject(pipeline("pmrem"), {}, { name: "PMREM_Background" }), null);
    raw.renderObject(renderObject(pipeline("output"), {}, { name: "outputColorTransform" }), null);

    expect(census.snapshot().events.map(({ pass }) => pass)).toEqual([
      "main",
      "shadow",
      "pmrem",
      "output",
    ]);
  });
});
