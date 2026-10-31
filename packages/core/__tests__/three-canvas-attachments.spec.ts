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
    "_beginTransientDepth",
    "_restoreTransientDepth",
    "_finishTransientDepth",
    "_releaseTransientDepth",
    "_isFullTransientViewport",
    "_resumeTransientDepth",
    "_validateTransientDepth",
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

describe.each(["source", "distribution"])("%s owned transient depth protocol", (mode) => {
  it("discards private depth, restores original 1 without a draw, and retires speculation after submit", () => {
    const state = fixture(mode);
    const methods = state.compiledBackend ?? WebGPUBackend.prototype;
    for (const name of [
      "_beginTransientDepth",
      "_restoreTransientDepth",
      "_finishTransientDepth",
      "_releaseTransientDepth",
      "_isFullTransientViewport",
    ])
      Reflect.set(state.backend, name, Reflect.get(methods, name));
    const starts: unknown[] = [];
    const events: string[] = [];
    const encoder = {
      beginRenderPass: (descriptor: object) => {
        starts.push(structuredClone(descriptor));
        return { end: () => events.push("end") };
      },
      finish: () => ({}),
    };
    Object.assign(state.backend.device, {
      features: new Set(["transient-attachments"]),
      createCommandEncoder: () => encoder,
      queue: { submit: () => events.push("submit") },
    });
    Object.assign(state.backend, {
      initTimestampQuery: () => undefined,
      getTimestampUID: () => "output",
      _isRenderCameraDepthArray: () => false,
      _getDefaultRenderPassDescriptor: state.passDescriptor,
    });
    const context = {
      id: 1,
      camera: {},
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
      _tnOutputOwner: {},
    };
    Reflect.get(methods, "beginRender").call(state.backend, context);
    expect(starts[0]).toMatchObject({
      depthStencilAttachment: {
        depthLoadOp: "clear",
        depthStoreOp: "discard",
        depthClearValue: 1,
        view: { allocation: { label: "tn-private-output-depth", sampleCount: 4 } },
      },
    });
    Reflect.get(methods, "finishRender").call(state.backend, context);
    expect(starts[1]).toMatchObject({
      colorAttachments: [],
      depthStencilAttachment: {
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1,
        view: { allocation: { label: "depthBuffer", sampleCount: 4 } },
      },
    });
    expect(events).toEqual(["end", "end", "submit"]);
    expect(
      state.allocations.find(({ label }) => label === "tn-private-output-depth")?.destroyed,
    ).toBe(1);
    expect(state.allocations.find(({ label }) => label === "depthBuffer")?.destroyed).toBe(0);
  });
});

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
    features: new Set(["transient-attachments"]),
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
    _tnOutputOwner: quad,
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

describe.each(["source", "distribution"])("%s compiled draw transient protocol", (mode) => {
  it.each([false, true])(
    "draws the shipped full triangle (uv=%s) through private depth and stores original 0",
    (withUv) => {
      const s = transientFixture(mode, withUv);
      if (withUv)
        expect(s.builder.attributes.some((a: { name: string }) => a.name === "uv")).toBe(true);
      expect(s.backend.get(s.renderObject.pipeline)._tnDepthProof).toBeTruthy();
      expect(s.backend.get(s.quad.geometry.attributes.position)._tnFullTriangle).toBe(true);
      s.begin();
      s.draw();
      s.finish();
      expect(s.draws).toHaveLength(1);
      expect(s.draws[0]?.depthStencilAttachment).toMatchObject({
        depthLoadOp: "clear",
        depthStoreOp: "discard",
        view: { allocation: { label: "tn-private-output-depth" } },
      });
      expect(s.starts).toHaveLength(2);
      expect(s.starts[1]).toMatchObject({
        colorAttachments: [],
        depthStencilAttachment: {
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          view: { allocation: { label: "depthBuffer" } },
        },
      });
      expect(
        s.allocations.find(({ label }) => label === "tn-private-output-depth")?.destroyed,
      ).toBe(0);
      s.target.dispose();
      s.textures.destroyTexture(s.target.colorTexture);
      expect(s.allocations.every(({ destroyed }) => destroyed === 1)).toBe(true);
    },
  );

  it.each(["before", "after"])(
    "restores canonical depth before a %s-draw framebuffer copy and never loads private depth",
    (when) => {
      const s = transientFixture(mode);
      s.begin();
      if (when === "after") s.draw();
      s.copy();
      if (when === "before") s.draw();
      s.finish();
      expect(s.starts[1]?.depthStencilAttachment.depthClearValue).toBe(when === "before" ? 1 : 0);
      expect(s.events.indexOf("copy")).toBeGreaterThan(s.events.indexOf("end"));
      expect(
        s.starts
          .filter(
            (p) => p.depthStencilAttachment.view.allocation.label === "tn-private-output-depth",
          )
          .map((p) => p.depthStencilAttachment.depthLoadOp),
      ).toEqual(["clear"]);
      expect(
        s.starts
          .slice(2)
          .every(
            (p) =>
              p.depthStencilAttachment.depthLoadOp === "load" &&
              p.depthStencilAttachment.view.allocation.label === "depthBuffer",
          ),
      ).toBe(true);
      if (when === "before")
        expect(
          s.allocations.find(({ label }) => label === "tn-private-output-depth")?.destroyed,
        ).toBe(1);
    },
  );

  describe.each(["cameraViewMatrix", "cameraProjectionMatrix", "world"])(
    "%s GPU matrix snapshot",
    (matrix) => {
      it.each([0, 8, "missing"] as const)("rejects %s observed floats before drawing", (length) => {
        const s = transientFixture(mode);
        s.begin();
        const group = s.groups.find(
          (g: { name: string }) => g.name === (matrix === "world" ? "object" : "render"),
        );
        if (!group) throw new Error("Missing matrix fixture group");
        const entries = s.backend.get(group)._tnBindings as {
          binding: object;
          uniforms: { name: string; itemSize: number; offset: number }[];
        }[];
        const entry = entries.find((e) =>
          e.uniforms.some((u) => u.itemSize === 16 && (matrix === "world" || u.name === matrix)),
        );
        if (!entry) throw new Error("Missing matrix fixture binding");
        const uniform = entry.uniforms.find(
          (u: { name: string; itemSize: number }) =>
            u.itemSize === 16 && (matrix === "world" || u.name === matrix),
        );
        if (!uniform) throw new Error("Missing matrix fixture uniform");
        if (length === "missing") {
          entry.uniforms = entry.uniforms.filter((u: object) => u !== uniform);
        } else {
          const uploaded = s.backend.get(entry.binding);
          const snapshot = uploaded._tnUniformBytes;
          if (!(snapshot instanceof Float32Array)) throw new Error("Missing GPU matrix snapshot");
          uploaded._tnUniformBytes = snapshot.slice(0, uniform.offset + length);
        }
        s.draw();
        expect(s.starts[1]).toMatchObject({
          colorAttachments: [],
          depthStencilAttachment: { depthClearValue: 1, depthStoreOp: "store" },
        });
        expect(s.draws[0]?.depthStencilAttachment.view.allocation.label).toBe("depthBuffer");
        expect(s.events.indexOf("draw")).toBeGreaterThan(s.events.indexOf("end"));
        s.finish();
      });
    },
  );

  it.each([
    "partial",
    "discard",
    "depth",
    "alpha",
    "mask",
    "geometry",
    "cpu-geometry",
    "gpu-geometry",
    "projection",
    "stale-shader",
    "stale-material",
    "indirect",
  ])("falls back before an uncertified %s draw", (guard) => {
    const s = transientFixture(mode);
    s.begin();
    if (guard === "partial") s.params.vertexCount = 2;
    if (guard === "discard") {
      s.renderObject.pipeline.fragmentProgram.code += "\nfn hidden() { discard; }";
      s.compile();
    }
    if (guard === "depth") {
      s.renderObject.pipeline.fragmentProgram.code =
        s.renderObject.pipeline.fragmentProgram.code.replace(
          "@location( 0 ) color:",
          "@builtin( frag_depth ) customDepth: f32,\n@location( 0 ) color:",
        );
      s.compile();
    }
    if (guard === "alpha") s.quad.material.alphaToCoverage = true;
    if (guard === "mask") {
      s.renderObject.pipeline.fragmentProgram.code =
        s.renderObject.pipeline.fragmentProgram.code.replace(
          "@location( 0 ) color:",
          "@builtin( sample_mask ) sampleMask: u32,\n@location( 0 ) color:",
        );
      s.compile();
    }
    if (guard === "geometry") {
      s.quad.geometry.attributes.position.needsUpdate = true;
      s.utilities.attributeUtils.updateAttribute(s.quad.geometry.attributes.position);
    }
    if (guard === "cpu-geometry") s.quad.geometry.attributes.position.array[0] = 0;
    if (guard === "gpu-geometry") s.backend.get(s.quad.geometry.attributes.position).buffer = {};
    if (guard === "projection") {
      const binding = s.groups.find((g: { name: string }) => g.name === "render").bindings[0];
      binding.buffer[0] = 2;
      binding.clearUpdateRanges();
      s.utilities.bindingUtils.updateBinding(binding);
    }
    if (guard === "stale-shader")
      s.backend.get(s.renderObject.pipeline.vertexProgram)._tnShaderCode += " ";
    if (guard === "stale-material") s.quad.material.needsUpdate = true;
    if (guard === "indirect") s.renderObject.getIndirect = () => ({}) as never;
    // Indirect draw itself is outside this protocol fixture; preserve its original method.
    if (guard === "indirect") Reflect.set(s.backend, "_draw", () => undefined);
    s.draw();
    s.finish();
    expect(s.starts[1]).toMatchObject({
      colorAttachments: [],
      depthStencilAttachment: { depthClearValue: 1, depthStoreOp: "store" },
    });
    expect(s.starts[2]?.depthStencilAttachment.view.allocation.label).toBe("depthBuffer");
    expect(s.allocations.find(({ label }) => label === "tn-private-output-depth")?.destroyed).toBe(
      1,
    );
  });
});

describe.each(["source", "distribution"])("%s transient depth boundaries", (mode) => {
  it.each([
    "off",
    "absent",
    "single",
    "load",
    "custom-clear",
    "nonfinite",
    "scissor",
    "viewport",
    "reversed",
    "layers",
    "xr",
    "stencil",
  ])("retains the ordinary allocation and pass for %s", (guard) => {
    const s = transientFixture(mode);
    if (guard === "off" || guard === "absent")
      s.backend.device.features.delete("transient-attachments");
    if (guard === "single") s.renderer.currentSamples = 1;
    if (guard === "load") s.context.clearDepth = false;
    if (guard === "custom-clear") s.context.clearDepthValue = 0.5;
    if (guard === "nonfinite") s.context.clearDepthValue = Number.NaN;
    if (guard === "scissor") s.context.scissor = true;
    if (guard === "viewport") {
      s.context.viewport = true;
      s.context.viewportValue.width = 10;
    }
    if (guard === "reversed") s.renderer.reversedDepthBuffer = true;
    if (guard === "layers") s.context.camera.isArrayCamera = true;
    if (guard === "xr") Reflect.set(s.renderer, "xr", { isPresenting: true });
    if (guard === "stencil") {
      s.context.stencil = true;
      s.renderer.stencil = true;
    }
    s.begin();
    s.finish();
    expect(s.allocations.some(({ label }) => label === "tn-private-output-depth")).toBe(false);
    expect(s.starts).toHaveLength(1);
    expect(s.starts[0]?.depthStencilAttachment.depthStoreOp).toBe("store");
  });

  it.each(["viewport", "scissor"])(
    "restores original depth before changing %s coverage",
    (operation) => {
      const s = transientFixture(mode);
      s.context.viewport = true;
      s.begin();
      expect(s.starts).toHaveLength(1); // Applying the initial full viewport must not fall back.
      if (operation === "viewport") s.context.viewportValue.width = 20;
      else s.context.scissor = true;
      Reflect.get(s.methods, operation === "viewport" ? "updateViewport" : "updateScissor").call(
        s.backend,
        s.context,
      );
      expect(s.starts[1]?.depthStencilAttachment.depthClearValue).toBe(1);
      expect(s.starts[2]?.depthStencilAttachment.depthLoadOp).toBe("load");
      s.draw();
      s.finish();
      expect(s.draws[0]?.depthStencilAttachment.view.allocation.label).toBe("depthBuffer");
    },
  );

  it.each(
    ["before", "after"].flatMap((when) =>
      ["clear", "depth-copy", "color-copy", "read", "depth-write"].map((operation) => [
        when,
        operation,
      ]),
    ),
  )(
    "keeps the separate encoder before pending main %s the quad for %s, matching feature-off",
    async (when, operation) => {
      const snapshots = [];
      for (const enabled of [false, true]) {
        const s = transientFixture(mode);
        if (!enabled) s.backend.device.features.delete("transient-attachments");
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
        if (enabled) expect(s.submissions[1]?.commands.at(-1)).toBe("pass:depthBuffer:0");
        snapshots.push(s.submissions[0]);
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
    },
  );

  it("retires used private depth on resize and creates it at the new physical size", () => {
    const s = transientFixture(mode);
    s.begin();
    s.draw();
    s.finish();
    const first = s.allocations.find(({ label }) => label === "tn-private-output-depth");
    s.target.setSize(640, 360, false);
    expect(first?.destroyed).toBe(1);
    s.context.width = 640;
    s.context.height = 360;
    s.begin();
    s.draw();
    s.finish();
    const sources = s.allocations.filter(({ label }) => label === "tn-private-output-depth");
    expect(sources).toHaveLength(2);
    expect(sources[1]?.size).toEqual({ width: 640, height: 360 });
    s.textures.dispose();
    expect(sources[1]?.destroyed).toBe(1);
  });

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

  it.each(["before", "after", "fallback", "nested"])(
    "discards the failed outer encoder %s the quad, matching feature-off submissions",
    (when) => {
      const snapshots = [];
      for (const enabled of [false, true]) {
        const s = transientFixture(mode);
        if (!enabled) s.backend.device.features.delete("transient-attachments");
        Reflect.set(s.renderer, "getClearDepth", () => 0.25);
        Object.assign(s.backend, { updateTimeStampUID: () => undefined });
        for (const name of ["beginRender", "finishRender", "_abortTransientDepth"])
          Reflect.set(s.backend, name, Reflect.get(s.methods, name));
        Object.assign(s.context, { viewportValue: new Vector4(), scissorValue: new Vector4() });
        const previous = {};
        const nodeFrame = { renderId: 99 };
        const lighting = { beginRender: vi.fn(), finishRender: vi.fn() };
        const renderList = {
          begin: () => undefined,
          finish: () => undefined,
          bundles: [],
          opaque: [s.quad],
          transparent: [],
          transparentDoublePass: [],
          occlusionQueryCount: 0,
        };
        let fail = true;
        const renderer = {
          backend: s.backend,
          _nodes: { nodeFrame },
          lighting,
          _currentRenderContext: previous,
          _currentRenderObjectFunction: previous,
          _handleObjectFunction: previous,
          _callDepth: 0,
          _renderTarget: null,
          _outputRenderTarget: null,
          _activeCubeFace: 0,
          _activeMipmapLevel: 0,
          _renderContexts: { get: () => s.context },
          _canvasTarget: s.target,
          _tnOutputOwner: s.quad,
          shadowMap: { type: PCFShadowMap },
          depth: true,
          stencil: false,
          opaque: true,
          info: { calls: 0, render: { calls: 0, frameCalls: 0 } },
          inspector: { beginRender: () => undefined, finishRender: () => undefined },
          _updateCamera: (camera: object) => camera,
          getDrawingBufferSize: (size: Vector2) => size.set(1920, 1080),
          xr: { isPresenting: false },
          _renderLists: { get: () => renderList, update: () => undefined },
          // r187 culls through renderer.drawingPipeline; projection stays a no-op here.
          drawingPipeline: {
            begin: () => undefined,
            beginRenderList: (list: typeof renderList) => list.begin(),
            project: () => undefined,
            finishRenderList: (list: typeof renderList) => list.finish(),
          },
          _background: { update: () => undefined },
          _renderObjects: () => {
            if (!fail) {
              s.draw();
              return;
            }
            if (when !== "before") {
              s.draw();
              if (enabled)
                expect(s.backend.get(s.context)).toMatchObject({
                  _tnDepth: { logical: 0, source: { used: false } },
                });
            }
            if (when === "fallback") s.copy();
            if (when === "nested") {
              const nested = { ...s.context, id: 2 };
              Reflect.get(s.methods, "beginRender").call(s.backend, nested);
              s.renderObject.context = nested;
              try {
                s.draw();
              } finally {
                s.renderObject.context = s.context;
              }
              Reflect.get(s.methods, "finishRender").call(s.backend, nested);
            }
            Reflect.get(s.methods, "clear").call(s.backend, false, true, false);
            throw new Error("graph callback failed");
          },
        };
        const render = () =>
          Reflect.get(
            (mode === "source" ? SourceWebGPURenderer : WebGPURenderer).prototype,
            "_renderScene",
          ).call(renderer, s.quad, s.quad.camera, false);
        expect(render).toThrow("graph callback failed");
        expect(s.submissions.map(({ id }) => id)).toEqual(when === "nested" ? [1, 2] : [1]);
        expect(renderer._currentRenderContext).toBe(previous);
        expect(renderer._currentRenderObjectFunction).toBe(previous);
        expect(renderer._handleObjectFunction).toBe(previous);
        expect(renderer._callDepth).toBe(0);
        expect(nodeFrame.renderId).toBe(99);
        expect(lighting.finishRender).toHaveBeenCalledTimes(1);
        expect(renderer._tnOutputOwner).toBe(s.quad);
        if (enabled) {
          const data = s.backend.get(s.context);
          expect(data._tnDepth).toBeUndefined();
          expect(data.encoder).toBeUndefined();
          expect(data.currentPass).toBeUndefined();
          expect(data.descriptor).toMatchObject({
            depthStencilAttachment: {
              view: { allocation: { label: "depthBuffer" } },
              depthStoreOp: "store",
            },
          });
          const privateDepth = s.allocations.find(
            ({ label }) => label === "tn-private-output-depth",
          );
          expect(privateDepth?.destroyed).toBe(when === "nested" ? 0 : 1);
          if (when === "before" || when === "after") expect(s.starts).toHaveLength(2);
        }
        snapshots.push(
          s.submissions.map(({ id, commands }) => ({
            id,
            commands: commands.filter((command) => command !== "pass:depthBuffer:0"),
          })),
        );
        fail = false;
        render();
        expect(s.submissions).toHaveLength(when === "nested" ? 3 : 2);
        expect(s.submissions.at(-1)?.commands).toContain("draw");
        if (enabled) expect(s.submissions.at(-1)?.commands.at(-1)).toBe("pass:depthBuffer:0");
      }
      // The nested render may use private depth; its independent clear and submission order agree.
      if (when === "nested") expect(snapshots[1]?.at(-1)).toEqual(snapshots[0]?.at(-1));
      else expect(snapshots[1]).toEqual(snapshots[0]);
    },
  );

  it("retires private depth if queue submission throws after an encoded validated draw", () => {
    const s = transientFixture(mode);
    s.begin();
    s.draw();
    expect(s.backend.get(s.context)).toMatchObject({
      _tnDepth: { logical: 0, source: { used: false } },
    });
    Reflect.get(s.backend.device, "queue").submit = () => {
      throw new Error("submit failed");
    };
    expect(s.finish).toThrow("submit failed");
    expect(s.backend.get(s.context)._tnDepth).toBeUndefined();
    expect(s.allocations.find(({ label }) => label === "tn-private-output-depth")?.destroyed).toBe(
      1,
    );
  });

  it("restores scoped ownership, XR and output state when the owned render throws", () => {
    const s = transientFixture(mode);
    const previous = {};
    Reflect.set(s.pipeline.renderer, "_tnOutputOwner", previous);
    const quad = Reflect.get(s.pipeline, "_quadMesh");
    quad.render = () => {
      expect(Reflect.get(s.pipeline.renderer, "_tnOutputOwner")).toBe(quad);
      throw new Error("graph callback failed");
    };
    const tone = s.pipeline.renderer.toneMapping;
    const output = s.pipeline.renderer.outputColorSpace;
    expect(() => s.pipeline.render()).toThrow("graph callback failed");
    expect(Reflect.get(s.pipeline.renderer, "_tnOutputOwner")).toBe(previous);
    expect(s.pipeline.renderer.toneMapping).toBe(tone);
    expect(s.pipeline.renderer.outputColorSpace).toBe(output);
    expect(s.pipeline.renderer.xr.enabled).toBe(false);
  });
});

describe.each(["source", "distribution"])("%s private attachment isolation", (mode) => {
  it("clears/discards both private aspects and loads/stores the original stencil unchanged", () => {
    const s = transientFixture(mode);
    s.renderer.stencil = true;
    s.begin();
    s.finish();
    expect(s.starts[0]?.depthStencilAttachment).toMatchObject({
      depthLoadOp: "clear",
      depthStoreOp: "discard",
      stencilLoadOp: "clear",
      stencilStoreOp: "discard",
    });
    expect(s.starts[1]?.depthStencilAttachment).toMatchObject({
      depthLoadOp: "clear",
      depthStoreOp: "store",
      stencilLoadOp: "load",
      stencilStoreOp: "store",
    });
  });

  it("keeps an outer private pass active while a different nested context renders", () => {
    const s = transientFixture(mode);
    s.begin();
    const nested = { ...s.context, id: 2, _tnOutputOwner: null };
    Reflect.get(s.methods, "beginRender").call(s.backend, nested);
    Reflect.get(s.methods, "finishRender").call(s.backend, nested);
    expect(s.backend.get(s.context)).toMatchObject({ _tnDepth: { active: true, logical: 1 } });
    s.draw();
    s.finish();
    expect(s.draws[0]?.depthStencilAttachment.view.allocation.label).toBe(
      "tn-private-output-depth",
    );
  });
});
