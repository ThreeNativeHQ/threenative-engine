import {
  AgXToneMapping,
  DepthTexture,
  PCFShadowMap,
  RenderTarget,
  SRGBColorSpace,
  Vector2,
  Vector4,
  WebGPUCoordinateSystem,
} from "three";
import { uv as sourceUv, vec4 as sourceVec4 } from "three/src/nodes/TSL.js";
import SourceNodeFrame from "three/src/nodes/core/NodeFrame.js";
import CanvasTarget from "three/src/renderers/common/CanvasTarget.js";
import SourceRenderPipeline from "three/src/renderers/common/RenderPipeline.js";
import WebGPUBackend from "three/src/renderers/webgpu/WebGPUBackend.js";
import SourceWebGPURenderer from "three/src/renderers/webgpu/WebGPURenderer.js";
import SourceWGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
// @ts-expect-error Three's private texture allocator has no public declaration.
import WebGPUTextureUtils from "three/src/renderers/webgpu/utils/WebGPUTextureUtils.js";
// @ts-expect-error Three's private WebGPU utilities have no public declaration.
import WebGPUUtils from "three/src/renderers/webgpu/utils/WebGPUUtils.js";
import { uv, vec4 } from "three/tsl";
import { NodeFrame, RenderPipeline, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

interface IAllocation {
  readonly label: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly sampleCount: number;
  readonly format: string;
  destroyed: number;
}

function fixture(mode: string) {
  vi.stubGlobal("GPUTextureUsage", {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
  // r187 draw() tests the current pass with `instanceof GPURenderBundleEncoder`.
  vi.stubGlobal("GPURenderBundleEncoder", class {});
  const canvas = { width: 1920, height: 1080 };
  const target = new CanvasTarget(canvas as HTMLCanvasElement);
  const data = new WeakMap<object, Record<string, unknown>>();
  const allocations: IAllocation[] = [];
  const renderer = {
    currentSamples: 4,
    depth: true,
    stencil: false,
    reversedDepthBuffer: false,
    getRenderTarget: () => null,
    getCanvasTarget: () => target,
  };
  const backend = {
    renderer,
    getDrawingBufferSize: () =>
      backend.renderer.getCanvasTarget().getDrawingBufferSize(new Vector2()),
    get(object: object) {
      let entry = data.get(object);
      if (!entry) {
        entry = {};
        data.set(object, entry);
      }
      return entry;
    },
    delete: (object: object) => data.delete(object),
    context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    device: {
      features: new Set(["depth32float-stencil8"]),
      createTexture(descriptor: Omit<IAllocation, "destroyed">) {
        const allocation: IAllocation = { ...structuredClone(descriptor), destroyed: 0 };
        allocations.push(allocation);
        return {
          destroy: () => allocation.destroyed++,
          createView: () => ({ allocation }),
        };
      },
    },
    utils: undefined as unknown,
    textureUtils: undefined as unknown,
  };
  const utils = new WebGPUUtils(backend);
  utils.getPreferredCanvasFormat = () => "bgra8unorm";
  backend.utils = utils;
  // Construction does not initialize a GPU device. Exercise the shipped bundle as well as src.
  const compiledBackend =
    mode === "distribution"
      ? new WebGPURenderer({ canvas: canvas as HTMLCanvasElement }).backend
      : undefined;
  const textures = compiledBackend
    ? Reflect.get(compiledBackend, "textureUtils")
    : new WebGPUTextureUtils(backend);
  const passDescriptor = Reflect.get(
    compiledBackend ?? WebGPUBackend.prototype,
    "_getDefaultRenderPassDescriptor",
  );
  for (const name of [
    "updateViewport",
    "updateScissor",
    "getOcclusionData",
    "_resetRenderContextData",
    "_copyFramebufferToTexture",
    "getBufferAttribute",
    "_hasExternalTexture",
  ])
    Reflect.set(backend, name, Reflect.get(compiledBackend ?? WebGPUBackend.prototype, name));
  textures.backend = backend;
  backend.textureUtils = textures;
  return {
    canvas,
    target,
    renderer,
    backend,
    textures,
    passDescriptor,
    allocations,
    compiledBackend,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("executes a graph framebuffer copy and depth LOAD restart before the existing quad draw", () => {
  const state = fixture("source");
  const events: string[] = [];
  const starts: string[] = [];
  const encoder = {
    beginRenderPass(descriptor: { depthStencilAttachment: { depthLoadOp: string } }) {
      starts.push(descriptor.depthStencilAttachment.depthLoadOp);
      events.push("begin");
      return { end: () => events.push("end") };
    },
    copyTextureToTexture: () => events.push("copy"),
  };
  Object.assign(state.backend.device, { createCommandEncoder: () => encoder });
  Object.assign(state.backend, {
    initTimestampQuery: () => undefined,
    getTimestampUID: () => "output",
    _isRenderCameraDepthArray: () => false,
    _getDefaultRenderPassDescriptor: state.passDescriptor,
    _draw: () => events.push("draw"),
  });
  const context = {
    id: 1,
    camera: {},
    textures: null,
    renderTarget: null,
    depth: true,
    stencil: false,
    clearDepth: true,
    clearDepthValue: 1,
    clearColor: false,
    occlusionQueryCount: 0,
    viewport: false,
    scissor: false,
  };
  const destination = { generateMipmaps: false };
  const source = { format: "bgra8unorm", createView: () => ({}) };
  state.backend.context.getCurrentTexture = () => source;
  state.backend.get(destination).texture = { format: source.format };
  const object = { geometry: { drawRange: { start: 0, count: 3 } } };
  const renderObject = {
    object,
    context,
    camera: {},
    pipeline: {},
    getDrawParameters: () => ({ vertexCount: 3 }),
    getBindings: () => [],
    getVertexBuffers: () => [],
  };
  state.backend.get(renderObject.pipeline).pipeline = {};
  const renderer = {
    _objects: { get: () => renderObject },
    _currentRenderContext: context,
    _currentRenderBundle: null,
    _nodes: {
      needsRefresh: () => events.push("refresh"),
      updateBefore: () => {
        events.push("updateBefore");
        Reflect.get(WebGPUBackend.prototype, "copyFramebufferToTexture").call(
          state.backend,
          destination,
          context,
          new Vector4(0, 0, 4, 4),
        );
      },
      updateForRender: () => undefined,
      updateAfter: () => events.push("updateAfter"),
    },
    _geometries: { updateForRender: () => undefined },
    _bindings: { updateForRender: () => undefined },
    _pipelines: {
      updateForRender: () => events.push("pipeline"),
      isReady: () => true,
    },
    backend: {
      draw: () =>
        Reflect.get(WebGPUBackend.prototype, "draw").call(state.backend, renderObject, {}),
    },
    info: {},
  };
  Reflect.get(WebGPUBackend.prototype, "beginRender").call(state.backend, context);
  Reflect.get(SourceWebGPURenderer.prototype, "_renderObjectDirect").call(renderer, object);
  expect(events).toEqual([
    "begin",
    "refresh",
    "updateBefore",
    "end",
    "copy",
    "begin",
    "pipeline",
    "draw",
    "updateAfter",
  ]);
  expect(starts).toEqual(["clear", "load"]);
  expect(state.backend.get(context).descriptor).toMatchObject({
    depthStencilAttachment: { depthLoadOp: "load", depthStoreOp: "store" },
  });
  expect(state.allocations.filter(({ label }) => label === "depthBuffer")).toHaveLength(1);
});

describe.each(["source", "distribution"])(
  "%s default canvas attachment allocation lifecycle",
  (mode) => {
    it("reuses an unchanged MSAA color attachment across repeated requests", () => {
      const state = fixture(mode);
      const first = state.textures.getColorBuffer();
      for (let call = 0; call < 50; call++) state.textures.getColorBuffer();
      expect(state.allocations).toHaveLength(1);
      expect(state.textures.getColorBuffer()).toBe(first);
      expect(state.allocations[0]?.destroyed).toBe(0);
      expect([state.target.colorTexture.width, state.target.colorTexture.height]).toEqual([
        1920, 1080,
      ]);
      expect(state.canvas).toEqual({ width: 1920, height: 1080 });
    });

    it("retains the same MSAA color texture across output and direct render passes", () => {
      const state = fixture(mode);
      for (let frame = 0; frame < 50; frame++) {
        for (const samples of [4, 0]) {
          state.renderer.currentSamples = samples;
          state.passDescriptor.call(state.backend);
        }
      }
      const color = state.allocations.filter((allocation) => allocation.label === "colorBuffer");
      const depth = state.allocations.filter((allocation) => allocation.label === "depthBuffer");
      expect(color).toHaveLength(1);
      expect(color[0]?.destroyed).toBe(0);
      expect(depth).toHaveLength(2);
      expect(depth.every((allocation) => allocation.destroyed === 0)).toBe(true);
      expect(depth.map((allocation) => allocation.sampleCount)).toEqual([4, 1]);
      expect(
        state.allocations.every(
          (allocation) => allocation.size.width === 1920 && allocation.size.height === 1080,
        ),
      ).toBe(true);
      state.textures.destroyTexture(state.target.colorTexture);
      state.textures.destroyTexture(state.target.depthTexture);
      expect(state.allocations.every((allocation) => allocation.destroyed === 1)).toBe(true);
    });

    it("replaces color attachments only when size or sample count changes", () => {
      const state = fixture(mode);
      for (const [width, height, samples] of [
        [1920, 1080, 4],
        [1280, 720, 4],
        [3, 3, 4],
        [1920, 1080, 4],
        [1920, 1080, 1],
      ] as const) {
        state.target.setSize(width, height, false);
        state.renderer.currentSamples = samples;
        state.textures.getColorBuffer();
        state.textures.getColorBuffer();
        expect(state.canvas).toEqual({ width, height });
      }
      expect(
        state.allocations.map(({ size, sampleCount }) => [size.width, size.height, sampleCount]),
      ).toEqual([
        [1920, 1080, 4],
        [1280, 720, 4],
        [3, 3, 4],
        [1920, 1080, 4],
        [1920, 1080, 1],
      ]);
      expect(state.allocations.slice(0, -1).every((allocation) => allocation.destroyed === 1)).toBe(
        true,
      );
      expect(state.allocations.at(-1)?.destroyed).toBe(0);
    });

    it("recreates a destroyed color attachment at the same size", () => {
      const state = fixture(mode);
      const first = state.textures.getColorBuffer();
      state.textures.destroyTexture(state.target.colorTexture);
      const replacement = state.textures.getColorBuffer();
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(first);
      expect(state.allocations).toHaveLength(2);
      expect(state.allocations[0]?.destroyed).toBe(1);
      expect(state.allocations[1]?.destroyed).toBe(0);
    });

    it("retains both depth attachments across the real output-pipeline sample transition", () => {
      const state = fixture(mode);
      const Renderer = mode === "source" ? SourceWebGPURenderer : WebGPURenderer;
      const renderer = new Renderer({ canvas: state.canvas as HTMLCanvasElement, samples: 4 });
      renderer.setCanvasTarget(state.target);
      renderer.toneMapping = AgXToneMapping;
      renderer.outputColorSpace = SRGBColorSpace;
      Reflect.set(state.backend, "renderer", renderer);
      const samples: number[] = [];
      const render = Reflect.get(
        (mode === "source" ? SourceRenderPipeline : RenderPipeline).prototype,
        "render",
      );
      const pipeline = {
        renderer,
        _update: () => undefined,
        _contextData: { onBeforePipelineCallbacks: [], onAfterPipelineCallbacks: [] },
        _quadMesh: {
          render: () => {
            samples.push(renderer.currentSamples);
            state.passDescriptor.call(state.backend);
          },
        },
      };
      for (let frame = 0; frame < 50; frame++) {
        render.call(pipeline);
        // Direct overlay output restores authored tone/color conversion and its single-sample
        // canvas pass. Its offscreen scene attachment belongs to a distinct RenderTarget.
        samples.push(renderer.currentSamples);
        state.passDescriptor.call(state.backend);
        expect(renderer.toneMapping).toBe(AgXToneMapping);
        expect(renderer.outputColorSpace).toBe(SRGBColorSpace);
      }
      expect(samples).toEqual(Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 4 : 0)));
      expect(state.allocations.filter(({ label }) => label === "depthBuffer")).toHaveLength(2);
      expect(state.allocations.every(({ destroyed }) => destroyed === 0)).toBe(true);
    });

    it("normalizes equivalent sample requests into only two live depth attachments", () => {
      const state = fixture(mode);
      const handles = new Map<number, unknown>();
      for (const samples of [4, 0, 1, 2, 3, 8, 16, 4, 0]) {
        state.renderer.currentSamples = samples;
        const texture = state.textures.getDepthBuffer();
        const effective = samples >= 4 ? 4 : 1;
        const canonical = state.backend.get(state.target.depthTexture);
        expect(canonical.texture).toBe(texture);
        expect(canonical.initialized).toBe(true);
        expect(canonical.format).toBe("depth24plus");
        expect(Reflect.get(canonical.textureDescriptorGPU as object, "sampleCount")).toBe(
          effective,
        );
        expect(Reflect.get(state.target.depthTexture, "samples")).toBe(samples);
        if (handles.has(effective)) expect(texture).toBe(handles.get(effective));
        else handles.set(effective, texture);
      }
      expect(state.allocations.map(({ sampleCount }) => sampleCount)).toEqual([4, 1]);
      expect(state.allocations.every(({ destroyed }) => destroyed === 0)).toBe(true);
    });

    it("retires both depth variants on resize and pixel-ratio changes", () => {
      const state = fixture(mode);
      for (const samples of [4, 0]) {
        state.renderer.currentSamples = samples;
        state.textures.getDepthBuffer();
      }
      for (const [width, height, ratio] of [
        [1280, 720, 1],
        [640, 360, 2],
      ] as const) {
        const old = state.allocations.slice();
        state.target.setSize(width, height, false);
        state.target.setPixelRatio(ratio);
        for (const samples of [4, 0]) {
          state.renderer.currentSamples = samples;
          state.textures.getDepthBuffer();
        }
        expect(old.every(({ destroyed }) => destroyed === 1)).toBe(true);
        const live = state.allocations.filter(({ destroyed }) => destroyed === 0);
        expect(live.map(({ size, sampleCount }) => [size.width, size.height, sampleCount])).toEqual(
          [
            [width * ratio, height * ratio, 4],
            [width * ratio, height * ratio, 1],
          ],
        );
      }
    });

    it("replaces both depth variants when stencil or reversed depth changes the format", () => {
      const state = fixture(mode);
      for (const [stencil, reversed, format] of [
        [false, false, "depth24plus"],
        [true, false, "depth24plus-stencil8"],
        [true, true, "depth32float-stencil8"],
        [false, true, "depth32float"],
      ] as const) {
        const old = state.allocations.slice();
        state.renderer.stencil = stencil;
        state.renderer.reversedDepthBuffer = reversed;
        for (const samples of [4, 0]) {
          state.renderer.currentSamples = samples;
          state.textures.getDepthBuffer(true, stencil);
        }
        expect(old.every(({ destroyed }) => destroyed === 1)).toBe(true);
        const live = state.allocations.filter(({ destroyed }) => destroyed === 0);
        expect(live.map(({ format: actual, sampleCount }) => [actual, sampleCount])).toEqual([
          [format, 4],
          [format, 1],
        ]);
      }
    });

    it("refreshes the actual canvas descriptor when depth format changes at unchanged samples", () => {
      const state = fixture(mode);
      const views: unknown[] = [];
      for (const [stencil, reversed, format] of [
        [false, false, "depth24plus"],
        [true, false, "depth24plus-stencil8"],
        [true, true, "depth32float-stencil8"],
        [false, true, "depth32float"],
      ] as const) {
        state.renderer.stencil = stencil;
        state.renderer.reversedDepthBuffer = reversed;
        const descriptor = state.passDescriptor.call(state.backend);
        const view = descriptor.depthStencilAttachment.view;
        views.push(view);
        expect(view.allocation.format).toBe(format);
      }
      expect(new Set(views).size).toBe(4);
      expect(
        state.allocations
          .filter(({ label }) => label === "depthBuffer")
          .slice(0, -1)
          .every(({ destroyed }) => destroyed === 1),
      ).toBe(true);
      state.renderer.depth = false;
      state.renderer.stencil = false;
      expect(state.passDescriptor.call(state.backend).depthStencilAttachment).toBeUndefined();
    });

    it.each(["texture", "texture-event", "canvas", "allocator"])(
      "disposes both depth variants through %s ownership",
      (owner) => {
        const state = fixture(mode);
        for (const samples of [4, 0]) {
          state.renderer.currentSamples = samples;
          state.textures.getDepthBuffer();
        }
        const dispose = () => {
          if (owner === "texture") state.textures.destroyTexture(state.target.depthTexture);
          else if (owner === "texture-event") state.target.depthTexture.dispose();
          else if (owner === "canvas") state.target.dispose();
          else state.textures.dispose();
        };
        dispose();
        dispose();
        expect(state.allocations.every(({ destroyed }) => destroyed === 1)).toBe(true);
        state.renderer.currentSamples = 4;
        const replacement = state.textures.getDepthBuffer();
        expect(replacement).toBeDefined();
        expect(state.allocations).toHaveLength(3);
        expect(state.allocations[2]?.destroyed).toBe(0);
      },
    );

    it("invalidates the same-sample descriptor after explicitly destroying its depth attachment", () => {
      const state = fixture(mode);
      const first = state.passDescriptor.call(state.backend).depthStencilAttachment.view;
      state.textures.destroyTexture(state.target.depthTexture);
      const next = state.passDescriptor.call(state.backend).depthStencilAttachment.view;
      expect(next).not.toBe(first);
      expect(next.allocation.destroyed).toBe(0);
      expect(first.allocation.destroyed).toBe(1);
    });

    it("keeps two live canvas targets isolated through switching and disposing one owner", () => {
      const state = fixture(mode);
      const other = new CanvasTarget({ width: 1920, height: 1080 } as HTMLCanvasElement);
      const handles = new Map<CanvasTarget, unknown[]>();
      for (let frame = 0; frame < 3; frame++) {
        for (const target of [state.target, other]) {
          state.renderer.getCanvasTarget = () => target;
          const current = [];
          for (const samples of [4, 0]) {
            state.renderer.currentSamples = samples;
            current.push(state.textures.getDepthBuffer());
          }
          expect(current).toEqual(handles.get(target) ?? current);
          handles.set(target, current);
        }
      }
      expect(state.allocations).toHaveLength(4);
      expect(new Set([...handles.values()].flat()).size).toBe(4);
      state.target.dispose();
      expect(state.allocations.map(({ destroyed }) => destroyed)).toEqual([1, 1, 0, 0]);
      for (const [index, samples] of [4, 0].entries()) {
        state.renderer.currentSamples = samples;
        expect(state.textures.getDepthBuffer()).toBe(handles.get(other)?.[index]);
      }
      state.textures.dispose();
      expect(state.allocations.every(({ destroyed }) => destroyed === 1)).toBe(true);
    });

    it("retires a resized inactive canvas without affecting the selected canvas", () => {
      const state = fixture(mode);
      const other = new CanvasTarget({ width: 1920, height: 1080 } as HTMLCanvasElement);
      for (const target of [state.target, other]) {
        state.renderer.getCanvasTarget = () => target;
        for (const samples of [4, 0]) {
          state.renderer.currentSamples = samples;
          state.textures.getDepthBuffer();
        }
      }
      const selected = state.backend.get(other.depthTexture).texture;
      state.target.setSize(960, 540, false);
      expect(state.allocations.map(({ destroyed }) => destroyed)).toEqual([1, 1, 0, 0]);
      expect(state.textures.getDepthBuffer()).toBe(selected);
      expect(state.allocations).toHaveLength(4);
    });

    it("keeps genuinely live offscreen depth allocations independent of the canvas cache", () => {
      const state = fixture(mode);
      const target = new RenderTarget(1920, 1080, { samples: 4 });
      const depth = new DepthTexture(1920, 1080);
      depth.name = "live-offscreen-depth";
      depth.renderTarget = target;
      state.textures.createTexture(depth, { width: 1920, height: 1080 });
      for (const samples of [4, 0, 4, 0]) {
        state.renderer.currentSamples = samples;
        state.textures.getDepthBuffer();
      }
      const offscreen = state.allocations.find(({ label }) => label === depth.name);
      expect(offscreen?.destroyed).toBe(0);
      state.target.dispose();
      expect(offscreen?.destroyed).toBe(0);
      expect(
        state.allocations
          .filter(({ label }) => label === "depthBuffer")
          .every(({ destroyed }) => destroyed === 1),
      ).toBe(true);
      state.textures.destroyTexture(depth);
      expect(offscreen?.destroyed).toBe(1);
    });
  },
);

interface IRecordedPass {
  colorAttachments: object[];
  depthStencilAttachment: {
    depthLoadOp: string;
    depthStoreOp: string;
    depthClearValue: number;
    view: { allocation: IAllocation };
  };
}

function transientFixture(mode: string, withUv = false) {
  const state = fixture(mode);
  const Renderer = mode === "source" ? SourceWebGPURenderer : WebGPURenderer;
  const gpu = new Renderer({ canvas: state.canvas as HTMLCanvasElement });
  gpu.hasFeature = () => false;
  Reflect.get(gpu.backend, "capabilities").getUniformBufferLimit = () => 65536;
  // r187 builders share bind groups through renderer._bindings, which init() creates. A fresh
  // Bindings returns an unseen group as is.
  Reflect.set(gpu, "_bindings", { getSharedBindGroup: (group: object) => group });
  const Pipeline = mode === "source" ? SourceRenderPipeline : RenderPipeline;
  const output = withUv
    ? mode === "source"
      ? sourceVec4(sourceUv(), 0, 1)
      : vec4(uv(), 0, 1)
    : undefined;
  const pipeline = new Pipeline(gpu, output);
  Reflect.get(pipeline, "_update").call(pipeline);
  const quad = Reflect.get(pipeline, "_quadMesh");
  // The shipped QuadMesh shares geometry across instances; isolate mutations in these tests.
  quad.geometry = quad.geometry.clone();
  quad.camera = quad.camera.clone();
  quad.camera.coordinateSystem = WebGPUCoordinateSystem;
  quad.camera.updateProjectionMatrix();
  quad.updateMatrixWorld();
  quad.camera.updateMatrixWorld();
  const Builder = mode === "source" ? SourceWGSLNodeBuilder : WGSLNodeBuilder;
  const builder = Reflect.construct(Builder, [quad, gpu]);
  builder.camera = quad.camera;
  builder.scene = quad;
  builder.build();
  const frame = new (mode === "source" ? SourceNodeFrame : NodeFrame)();
  Object.assign(frame, {
    renderer: gpu,
    object: quad,
    camera: quad.camera,
    scene: quad,
    renderId: 1,
    frameId: 1,
  });
  for (const node of builder.updateNodes) frame.updateNode(node);
  const groups = builder.getBindings();
  const methods = state.compiledBackend ?? WebGPUBackend.prototype;
  const starts: IRecordedPass[] = [];
  const events: string[] = [];
  const draws: IRecordedPass[] = [];
  const submissions: { id: number; commands: string[] }[] = [];
  const copies: { encoder: number; source: unknown; destination: unknown }[] = [];
  let encoderId = 0;
  const createCommandEncoder = () => {
    const id = encoderId++;
    const commands: string[] = [];
    return {
      beginRenderPass: (descriptor: object) => {
        const captured = structuredClone(descriptor) as IRecordedPass;
        starts.push(captured);
        events.push("begin");
        commands.push(
          `pass:${captured.depthStencilAttachment.view.allocation.label}:${captured.depthStencilAttachment.depthClearValue}`,
        );
        return {
          end: () => events.push("end"),
          setViewport: () => events.push("viewport"),
          setScissorRect: () => events.push("scissor"),
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => {
            draws.push(captured);
            events.push("draw");
            commands.push("draw");
          },
        };
      },
      finish: () => ({ id, commands: [...commands] }),
      copyTextureToTexture: (source: { texture: unknown }, destination: { texture: unknown }) => {
        copies.push({ encoder: id, source: source.texture, destination: destination.texture });
        events.push("copy");
        commands.push("copy");
      },
      copyTextureToBuffer: (source: { texture: unknown }, destination: { buffer: unknown }) => {
        copies.push({ encoder: id, source: source.texture, destination: destination.buffer });
        events.push("read");
        commands.push("read");
      },
    };
  };
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, COPY_DST: 8, UNIFORM: 64 });
  Object.assign(state.backend.device, {
    features: new Set(["depth32float-stencil8"]),
    createCommandEncoder,
    createBuffer: (descriptor: { size: number }) => {
      const buffer = new ArrayBuffer(descriptor.size);
      return {
        getMappedRange: () => buffer,
        mapAsync: async () => undefined,
        unmap: () => undefined,
        destroy: () => undefined,
      };
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    queue: {
      submit: (buffers: { id: number; commands: string[] }[]) => {
        events.push("submit");
        submissions.push(...buffers);
      },
      writeBuffer: () => undefined,
    },
  });
  const utilities = {
    attributeUtils: Reflect.get(gpu.backend, "attributeUtils"),
    bindingUtils: Reflect.get(gpu.backend, "bindingUtils"),
    pipelineUtils: Reflect.get(gpu.backend, "pipelineUtils"),
  };
  for (const name of ["attributeUtils", "bindingUtils", "pipelineUtils"] as const) {
    utilities[name].backend = state.backend;
    Reflect.set(state.backend, name, utilities[name]);
  }
  Object.assign(state.backend, {
    parameters: { reversedDepthBuffer: false },
    initTimestampQuery: () => undefined,
    getTimestampUID: () => "output",
    _isRenderCameraDepthArray: () => false,
    _getDefaultRenderPassDescriptor: state.passDescriptor,
    _draw: Reflect.get(methods, "_draw"),
  });
  const context = {
    id: 1,
    textures: null,
    depthTexture: null,
    renderTarget: null,
    depth: true,
    stencil: false,
    clearDepth: true,
    clearDepthValue: 1,
    clearColor: false,
    occlusionQueryCount: 0,
    viewport: false,
    scissor: false,
    width: 1920,
    height: 1080,
    camera: quad.camera,
    viewportValue: { x: 0, y: 0, width: 1920, height: 1080, minDepth: 0, maxDepth: 1 },
    scissorValue: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  Object.assign(state.renderer, { _currentRenderContext: context, info: { calls: 1 } });
  const params = { vertexCount: 3, firstVertex: 0, instanceCount: 1, firstInstance: 0 };
  const attributes = builder.attributes.map(
    (attribute: { name: string }) => quad.geometry.attributes[attribute.name],
  );
  const renderObject = {
    object: quad,
    material: quad.material,
    geometry: quad.geometry,
    context,
    camera: quad.camera,
    pipeline: {
      vertexProgram: { stage: "vertex", name: "output", code: builder.vertexShader },
      fragmentProgram: { stage: "fragment", name: "output", code: builder.fragmentShader },
    },
    getAttributes: () => attributes,
    getVertexBuffers: () => attributes,
    getBindings: () => groups,
    getIndex: () => null,
    getIndirect: () => null,
    getDrawParameters: () => params,
  };
  for (const attribute of attributes) utilities.attributeUtils.createAttribute(attribute, 32);
  for (const group of groups) {
    for (const binding of group.bindings) {
      binding.update();
      Reflect.get(methods, "createUniformBuffer").call(state.backend, binding);
      utilities.bindingUtils.updateBinding(binding);
    }
    utilities.bindingUtils.createBindings(group, groups, 0);
  }
  const compile = () => {
    for (const program of [
      renderObject.pipeline.vertexProgram,
      renderObject.pipeline.fragmentProgram,
    ])
      Reflect.get(methods, "createProgram").call(state.backend, program);
    utilities.pipelineUtils.createRenderPipeline(renderObject, null);
  };
  compile();
  const begin = () => Reflect.get(methods, "beginRender").call(state.backend, context);
  const draw = () =>
    Reflect.get(methods, "draw").call(state.backend, renderObject, { update: () => undefined });
  const finish = () => Reflect.get(methods, "finishRender").call(state.backend, context);
  const copy = () => {
    const target = { generateMipmaps: false };
    state.backend.context.getCurrentTexture = () => ({
      format: "bgra8unorm",
      createView: () => ({}),
    });
    state.backend.get(target).texture = { format: "bgra8unorm" };
    Reflect.get(methods, "copyFramebufferToTexture").call(
      state.backend,
      target,
      context,
      new Vector4(0, 0, 4, 4),
    );
  };
  return {
    ...state,
    methods,
    utilities,
    pipeline,
    quad,
    builder,
    groups,
    context,
    renderObject,
    params,
    starts,
    events,
    draws,
    submissions,
    copies,
    begin,
    draw,
    finish,
    copy,
    compile,
  };
}

describe.each(["source", "distribution"])("%s separate-encoder and copy ordering", (mode) => {
  it.each(
    ["before", "after"].flatMap((when) =>
      ["clear", "depth-copy", "color-copy", "read", "depth-write"].map((operation) => [
        when,
        operation,
      ]),
    ),
  )(
    "keeps the separate encoder before pending main %s the quad for %s",
    async (when, operation) => {
      const s = transientFixture(mode);
      Reflect.set(s.renderer, "getClearDepth", () => 0.25);
      vi.stubGlobal("GPUMapMode", { READ: 1 });
      s.textures.getColorBuffer();
      s.begin();
      if (when === "after") s.draw();
      const alias = { id: 2, image: { width: 1920, height: 1080 } };
      const destination = { id: 3, image: { width: 1920, height: 1080 }, generateMipmaps: false };
      const canonical = s.backend.get(
        operation === "color-copy" || operation === "read"
          ? s.target.colorTexture
          : s.target.depthTexture,
      ).texture;
      s.backend.get(alias).texture = canonical;
      s.backend.get(alias).textureDescriptorGPU = { format: "rgba8unorm" };
      s.backend.get(destination).texture = {};
      if (operation === "clear")
        Reflect.get(s.methods, "clear").call(s.backend, false, true, false);
      else if (operation === "read") {
        // Mapping waits only for the submitted read encoder: the outer pass is still open.
        const result = await Reflect.get(s.methods, "copyTextureToBuffer").call(
          s.backend,
          alias,
          0,
          0,
          1,
          1,
          0,
        );
        expect(result).toEqual(new Uint8Array(4));
      } else
        Reflect.get(s.methods, "copyTextureToTexture").call(
          s.backend,
          ...(operation === "depth-write" ? [destination, alias] : [alias, destination]),
        );
      if (operation !== "clear") {
        expect(s.copies[0]?.encoder).toBe(1);
        expect(operation === "depth-write" ? s.copies[0]?.destination : s.copies[0]?.source).toBe(
          canonical,
        );
      }
      expect(s.submissions).toHaveLength(1);
      expect(s.submissions[0]?.id).toBe(1);
      expect(s.submissions[0]?.commands).toEqual([
        operation === "clear" ? "pass:depthBuffer:0.25" : operation === "read" ? "read" : "copy",
      ]);
      if (when === "before") s.draw();
      s.finish();
      expect(s.submissions.map(({ id }) => id)).toEqual([1, 0]);
      expect(s.submissions[1]?.commands).toContain("draw");
    },
  );

  it("executes the 939 graph updateBefore copy before pipeline construction and the original draw", () => {
    const s = transientFixture(mode);
    const renderer = {
      _objects: { get: () => s.renderObject },
      _currentRenderContext: s.context,
      _currentRenderBundle: null,
      _nodes: {
        needsRefresh: () => undefined,
        updateBefore: () => {
          s.events.push("updateBefore");
          s.copy();
        },
        updateForRender: () => undefined,
        updateAfter: () => undefined,
      },
      _geometries: { updateForRender: () => undefined },
      _bindings: { updateForRender: () => undefined },
      _pipelines: {
        updateForRender: () => {
          s.events.push("pipeline");
          s.compile();
        },
        isReady: () => true,
      },
      backend: { draw: s.draw },
      info: {},
    };
    s.begin();
    Reflect.get(
      (mode === "source" ? SourceWebGPURenderer : WebGPURenderer).prototype,
      "_renderObjectDirect",
    ).call(renderer, s.quad);
    s.finish();
    expect(s.starts[1]?.depthStencilAttachment.depthClearValue).toBe(1);
    expect(s.events.indexOf("copy")).toBeLessThan(s.events.indexOf("pipeline"));
    expect(s.events.indexOf("pipeline")).toBeLessThan(s.events.indexOf("draw"));
    expect(s.draws[0]?.depthStencilAttachment.depthLoadOp).toBe("load");
  });
});
