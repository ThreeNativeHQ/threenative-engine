import { AgXToneMapping, DepthTexture, RenderTarget, SRGBColorSpace, Vector2 } from "three";
import CanvasTarget from "three/src/renderers/common/CanvasTarget.js";
import SourceRenderPipeline from "three/src/renderers/common/RenderPipeline.js";
import WebGPUBackend from "three/src/renderers/webgpu/WebGPUBackend.js";
import SourceWebGPURenderer from "three/src/renderers/webgpu/WebGPURenderer.js";
// @ts-expect-error Three's private texture allocator has no public declaration.
import WebGPUTextureUtils from "three/src/renderers/webgpu/utils/WebGPUTextureUtils.js";
// @ts-expect-error Three's private WebGPU utilities have no public declaration.
import WebGPUUtils from "three/src/renderers/webgpu/utils/WebGPUUtils.js";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
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
  textures.backend = backend;
  backend.textureUtils = textures;
  return { canvas, target, renderer, backend, textures, passDescriptor, allocations };
}

afterEach(() => vi.unstubAllGlobals());

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
        _context: { onBeforeRenderPipeline: null, onAfterRenderPipeline: null },
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
