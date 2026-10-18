import { DepthTexture, RenderTarget, Texture } from "three";
import { PerspectiveCamera, Scene } from "three";
import { pass } from "three/tsl";
import { describe, expect, it, vi } from "vitest";
import { readRenderChainObservation } from "../src/render/chain.js";
import { ResolutionSubrect } from "../src/render/resolution-subrect.js";
import { createRenderer } from "../src/renderer.js";

describe("retained render targets", () => {
  it("reserves a halving mip chain for the quantized viewport, so no scale near 1 outgrows it", () => {
    // A bloom-style chain: each mip floors half of the one above. Height 653 gives 326, 163, 81, 40, 20,
    // while the viewport at scale 1 quantizes to 656 and halves to 41 at mip 3.
    const mips = [0, 1, 2, 3, 4].map(() => new RenderTarget(1, 1));
    const node = {
      setSize: (width: number, height: number) => {
        mips.forEach((mip, level) => {
          const divisor = 2 ** (level + 1);
          mip.setSize(
            Math.max(1, Math.floor(width / divisor)),
            Math.max(1, Math.floor(height / divisor)),
          );
        });
      },
    };
    const controller = new ResolutionSubrect();
    controller.retain(node, mips);
    controller.activate(1);
    for (const scale of [1, 0.9923, 0.9]) {
      controller.setScale(scale);
      expect(() => node.setSize(1024, 653), `scale ${scale}`).not.toThrow();
    }
    controller.dispose();
  });

  it("changes the active rectangle without disposing the allocation, and grows once", () => {
    const target = new RenderTarget(1, 1);
    const disposed = vi.fn();
    target.addEventListener("dispose", disposed);
    const node = { setSize: (width: number, height: number) => target.setSize(width, height) };
    const original = node.setSize;
    const controller = new ResolutionSubrect();
    controller.retain(node, [target]);
    controller.activate(1);
    node.setSize(1280, 720);
    expect([target.width, target.height]).toEqual([1280, 720]);
    const allocations = disposed.mock.calls.length;
    for (const scale of [0.85, 0.61, 1]) {
      controller.setScale(scale);
      expect(disposed).toHaveBeenCalledTimes(allocations);
      expect(target.viewport.toArray()).toEqual([
        0,
        0,
        Math.ceil((1280 * scale) / 8) * 8,
        Math.ceil((720 * scale) / 8) * 8,
      ]);
      expect(target.scissor.toArray()).toEqual(target.viewport.toArray());
      expect(target.scissorTest).toBe(true);
      const view = controller.textureView(target.texture);
      if (!view) throw new Error("Missing retained texture view");
      expect(view.viewFraction.x).toBe(target.viewport.z / target.width);
      expect(view.halfTexel.x).toBe(0.5 / target.width);
    }
    node.setSize(640, 360);
    expect([target.width, target.height]).toEqual([1280, 720]);
    expect(disposed).toHaveBeenCalledTimes(allocations);
    node.setSize(1401, 801);
    expect([target.width, target.height]).toEqual([1408, 808]);
    expect(disposed).toHaveBeenCalledTimes(allocations + 1);
    controller.dispose();
    expect(node.setSize).toBe(original);
    node.setSize(800, 600);
    expect([target.width, target.height]).toEqual([800, 600]);
    target.dispose();
  });

  it("keeps the stock resize path until the graph declares sampling support", () => {
    const target = new RenderTarget(1, 1);
    const controller = new ResolutionSubrect();
    const node = { setSize: (width: number, height: number) => target.setSize(width, height) };
    controller.retain(node, [target]);
    node.setSize(321, 181);
    expect([target.width, target.height]).toEqual([321, 181]);
    expect(controller.textureView(target.texture)?.viewFraction.toArray()).toEqual([1, 1]);
    controller.dispose();
    target.dispose();
  });

  it("reapplies the retained viewport after a real stock PassNode updates its target", () => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    const controller = new ResolutionSubrect();
    controller.retain(scenePass, [scenePass.renderTarget]);
    controller.activate(0.72);
    scenePass.setSize(1280, 720);
    expect([scenePass.renderTarget.width, scenePass.renderTarget.height]).toEqual([1280, 720]);
    expect(scenePass.renderTarget.viewport.toArray()).toEqual([0, 0, 928, 520]);
    expect(scenePass.renderTarget.scissorTest).toBe(true);
    controller.dispose();
    scenePass.dispose();
  });

  it("rejects duplicate registration before changing methods", () => {
    const target = new RenderTarget();
    const node = { setSize: (w: number, h: number) => target.setSize(w, h) };
    const original = target.setSize;
    const controller = new ResolutionSubrect();
    expect(() => controller.retain(node, [target, target])).toThrow("TN_RESOLUTION_SUBRECT");
    expect(target.setSize).toBe(original);
    controller.dispose();
  });

  it("leaves stock resizing intact after invalid activation", () => {
    const target = new RenderTarget();
    const node = { setSize: (w: number, h: number) => target.setSize(w, h) };
    const controller = new ResolutionSubrect();
    controller.retain(node, [target]);
    expect(() => controller.activate(0)).toThrow();
    expect(controller.active).toBe(false);
    node.setSize(321, 181);
    expect(target.width).toBe(321);
    controller.dispose();
  });

  it("rejects an unreserved direct resize without destroying the target", () => {
    const target = new RenderTarget(100, 80);
    const disposed = vi.fn();
    target.addEventListener("dispose", disposed);
    const controller = new ResolutionSubrect();
    controller.retain({ setSize: (w, h) => target.setSize(w, h) }, [target]);
    controller.activate(1);
    expect(() => target.setSize(20, 20)).toThrow("TN_RESOLUTION_SUBRECT");
    expect([target.width, target.height]).toEqual([100, 80]);
    expect(disposed).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("refuses disposed mutations and forgets texture ownership", () => {
    const target = new RenderTarget();
    const controller = new ResolutionSubrect();
    controller.retain({ setSize: (w, h) => target.setSize(w, h) }, [target]);
    expect(controller.textureView(target.texture)).toBeDefined();
    controller.dispose();
    expect(() => controller.setScale(0.7)).toThrow("disposed");
    expect(() => controller.setSize(100, 80)).toThrow("disposed");
    expect(controller.textureView(target.texture)).toBeUndefined();
  });

  it("tracks current colour and depth attachments", () => {
    const target = new RenderTarget();
    target.depthTexture = new DepthTexture(1, 1);
    const colour = target.texture;
    const depth = target.depthTexture;
    const controller = new ResolutionSubrect();
    controller.retain({ setSize: (w, h) => target.setSize(w, h) }, [target]);
    expect(controller.textureView(colour)).toBeDefined();
    expect(controller.textureView(depth)).toBeDefined();
    target.texture = new Texture();
    target.depthTexture = new DepthTexture(1, 1);
    expect(controller.textureView(colour)).toBeUndefined();
    expect(controller.textureView(depth)).toBeUndefined();
    expect(controller.textureView(target.texture)).toBeDefined();
    expect(controller.textureView(target.depthTexture)).toBeDefined();
    controller.dispose();
  });

  it.each([0, -1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid scale %s",
    (scale) => {
      expect(() => new ResolutionSubrect().activate(scale)).toThrow("TN_RESOLUTION_SUBRECT");
    },
  );
});

it("owns subrect installations while keeping the full drawing buffer", async () => {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 320,
    clientHeight: 180,
    parentElement: null,
  }) as unknown as HTMLCanvasElement;
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
  const resize = vi.fn();
  const renderer = await createRenderer({
    canvas,
    webgpuFactory: () => ({
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: resize,
    }),
  });
  try {
    const handle = renderer.createResolutionSubrect?.();
    if (!handle) throw new Error("Missing controller factory");
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    handle.retain(scenePass, [scenePass.renderTarget]);
    const node = {};
    const first = renderer.setOutputNode(node, scenePass, { resolutionSubrect: handle });
    renderer.setResolutionScale(0.72, "auto");
    expect(renderer.surface().drawingBufferWidth).toBe(320);
    expect(scenePass.renderTarget.width).toBe(320);
    expect(scenePass.renderTarget.viewport.z).toBe(232);
    const calls = resize.mock.calls.length;
    renderer.setResolutionScale(0.61, "auto");
    expect(resize).toHaveBeenCalledTimes(calls);
    const second = renderer.setOutputNode(node, scenePass, { resolutionSubrect: handle });
    if (!first || !second) throw new Error("Missing output receipts");
    first.dispose();
    expect(handle.active).toBe(true);
    expect(second.isCurrent()).toBe(true);
    second.dispose();
    expect(handle.active).toBe(false);
    expect(renderer.surface().drawingBufferWidth).toBe(195);
    scenePass.dispose();
  } finally {
    renderer.dispose();
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

it("updates scene viewport/scissor without allocations and reallocates once on renderer canvas growth", async () => {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1280,
    clientHeight: 720,
    parentElement: null,
  }) as unknown as HTMLCanvasElement;
  const resize = vi.fn();
  const renderer = await createRenderer({
    canvas,
    source: {
      createCanvas: () => canvas,
      hasWebGPU: () => true,
      readSize: () => [canvas.clientWidth, canvas.clientHeight],
      observeResize: (element, callback) => {
        element.addEventListener("resize", callback);
        return () => element.removeEventListener("resize", callback);
      },
    },
    webgpuFactory: () => ({
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: resize,
    }),
  });
  const scenePass = pass(new Scene(), new PerspectiveCamera());
  const target = scenePass.renderTarget;
  const allocations = vi.fn();
  // Three invalidates the target allocation via dispose when its extent changes; no GPU is used.
  target.addEventListener("dispose", allocations);
  try {
    const handle = renderer.createResolutionSubrect?.();
    if (!handle) throw new Error("Missing controller factory");
    handle.retain(scenePass, [target]);
    renderer.setOutputNode({}, scenePass, { resolutionSubrect: handle });
    expect([target.width, target.height]).toEqual([1280, 720]);
    expect(allocations).toHaveBeenCalledTimes(1);
    allocations.mockClear();
    resize.mockClear();

    for (const [scale, width, height] of [
      [0.72, 928, 520],
      [0.61, 784, 440],
      [1, 1280, 720],
    ] as const) {
      renderer.setResolutionScale(scale, "auto");
      expect(target.viewport.toArray()).toEqual([0, 0, width, height]);
      expect(target.scissor.toArray()).toEqual([0, 0, width, height]);
      expect(target.scissorTest).toBe(true);
      expect([target.width, target.height]).toEqual([1280, 720]);
      expect(allocations).not.toHaveBeenCalled();
      expect(resize).not.toHaveBeenCalled();
    }

    Object.assign(canvas, { clientWidth: 1401, clientHeight: 801 });
    canvas.dispatchEvent(new Event("resize"));
    expect(resize).toHaveBeenCalledExactlyOnceWith(1401, 801, false);
    expect(renderer.surface()).toMatchObject({
      drawingBufferWidth: 1401,
      drawingBufferHeight: 801,
    });
    expect([target.width, target.height]).toEqual([1408, 808]);
    expect(target.viewport.toArray()).toEqual([0, 0, 1408, 808]);
    expect(target.scissor.toArray()).toEqual([0, 0, 1408, 808]);
    expect(target.scissorTest).toBe(true);
    expect(allocations).toHaveBeenCalledTimes(1);

    Object.assign(canvas, { clientWidth: 640, clientHeight: 360 });
    canvas.dispatchEvent(new Event("resize"));
    expect(resize).toHaveBeenLastCalledWith(640, 360, false);
    expect(renderer.surface()).toMatchObject({ drawingBufferWidth: 640, drawingBufferHeight: 360 });
    expect([target.width, target.height]).toEqual([1408, 808]);
    expect(target.viewport.toArray()).toEqual([0, 0, 640, 360]);
    expect(target.scissor.toArray()).toEqual([0, 0, 640, 360]);
    expect(target.scissorTest).toBe(true);
    expect(allocations).toHaveBeenCalledTimes(1);
  } finally {
    renderer.dispose();
    scenePass.dispose();
  }
});

it("keeps the ordinary resize and allocation path when an installed stage refuses the sub-rectangle", async () => {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1280,
    clientHeight: 720,
    parentElement: null,
  }) as unknown as HTMLCanvasElement;
  const resize = vi.fn();
  const renderer = await createRenderer({
    canvas,
    source: {
      createCanvas: () => canvas,
      hasWebGPU: () => true,
      readSize: () => [canvas.clientWidth, canvas.clientHeight],
      observeResize: (element, callback) => {
        element.addEventListener("resize", callback);
        return () => element.removeEventListener("resize", callback);
      },
    },
    webgpuFactory: () => ({
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: resize,
    }),
  });
  const scenePass = pass(new Scene(), new PerspectiveCamera());
  const target = scenePass.renderTarget;
  const allocations = vi.fn();
  target.addEventListener("dispose", allocations);
  try {
    const handle = renderer.createResolutionSubrect?.();
    if (!handle) throw new Error("Missing controller factory");
    handle.retain(scenePass, [target]);
    const report: string[] = [];
    const createChain = renderer.createRenderChain;
    if (!createChain) throw new Error("Missing chain factory");
    // The stage declares no sampling support, so the chain composes its graph and refuses the
    // rectangle instead of dropping the stage or claiming it.
    const chain = createChain({
      input: {},
      report: (line) => report.push(line),
      request: { stages: ["bloom"], tier: "high" },
      resolutionSubrect: handle,
      stages: [{ build: (input) => input, name: "bloom", supportsResolutionSubrect: false }],
      worldPass: scenePass,
    });

    const refusal = report.find((line) => line.includes("TN_RESOLUTION_SUBRECT"));
    if (!refusal) throw new Error("Missing named refusal");
    expect(JSON.parse(refusal.slice(refusal.indexOf("{")))).toEqual({
      applied: [],
      refused: [{ name: "bloom", reason: "sampling support not declared" }],
    });
    // A refusal that dropped the stage instead of installing it would land here as install:*.
    expect(chain.applied.stages).toEqual(["bloom"]);
    expect(chain.applied.dropped).toEqual([]);
    expect(readRenderChainObservation(renderer)?.stages).toEqual(["bloom"]);
    // The refused graph reached the real renderer without the controller: setOutputNode activates
    // the handle it is given, so an inactive handle is the observable absence.
    expect(handle.active).toBe(false);
    expect(renderer.surface().resolutionSubrect).toBeUndefined();

    // Ordinary scaling survives: the drawing buffer follows the requested scale instead of
    // holding the full canvas for a rectangle nothing samples.
    renderer.setResolutionScale(0.5, "auto");
    Object.assign(canvas, { clientWidth: 1000, clientHeight: 500 });
    canvas.dispatchEvent(new Event("resize"));
    expect(resize).toHaveBeenLastCalledWith(500, 250, false);
    expect(renderer.surface()).toMatchObject({
      drawingBufferWidth: 500,
      drawingBufferHeight: 250,
      resolutionScale: 0.5,
    });

    // Ordinary target allocation survives: the stock pass resize reallocates at exactly the asked
    // extent, with the full-target viewport the retained rectangle would have shrunk.
    allocations.mockClear();
    scenePass.setSize(500, 250);
    expect([target.width, target.height]).toEqual([500, 250]);
    expect(target.viewport.toArray()).toEqual([0, 0, 500, 250]);
    expect(target.scissorTest).toBe(false);
    expect(allocations).toHaveBeenCalledTimes(1);
    expect(handle.textureView(target.texture)?.viewFraction.toArray()).toEqual([1, 1]);
    chain.dispose();
  } finally {
    renderer.dispose();
    scenePass.dispose();
  }
});

it("restores actual capacity after deactivation and reactivation", () => {
  const target = new RenderTarget();
  const controller = new ResolutionSubrect();
  controller.retain({ setSize: (w, h) => target.setSize(w, h) }, [target]);
  controller.activate(0.5);
  controller.setSize(1920, 1080);
  controller.deactivate();
  expect([target.width, target.height]).toEqual([960, 540]);
  controller.activate(1);
  expect([target.width, target.height]).toEqual([1920, 1080]);
  expect(target.viewport.toArray()).toEqual([0, 0, 1920, 1080]);
  controller.dispose();
});

it("sizes targets registered after lazy shader setup at the current scale", () => {
  const controller = new ResolutionSubrect();
  controller.activate(0.72);
  controller.setSize(1280, 720);
  const target = new RenderTarget();
  controller.retain({ setSize: (w, h) => target.setSize(w, h) }, [target]);
  expect([target.width, target.height]).toEqual([1280, 720]);
  expect(target.viewport.toArray()).toEqual([0, 0, 928, 520]);
  controller.dispose();
});

it("releases a retired stage before subsequent scale changes", () => {
  const controller = new ResolutionSubrect();
  const target = new RenderTarget();
  const node = { setSize: (w: number, h: number) => target.setSize(w, h) };
  const original = node.setSize;
  controller.retain(node, [target]);
  controller.activate(1);
  controller.setSize(1280, 720);
  controller.release(node);
  expect(node.setSize).toBe(original);
  expect(controller.textureView(target.texture)).toBeUndefined();
  const resize = vi.spyOn(target, "setSize");
  controller.setScale(0.72);
  expect(resize).not.toHaveBeenCalled();
  controller.dispose();
});

it("does not resize retained nodes twice when only scale changes", () => {
  const target = new RenderTarget();
  const resize = vi.fn((w: number, h: number) => target.setSize(w, h));
  const controller = new ResolutionSubrect();
  controller.retain({ setSize: resize }, [target]);
  controller.activate(1);
  controller.setSize(1280, 720);
  resize.mockClear();
  controller.setScale(0.72);
  const calls = resize.mock.calls.length;
  controller.setSize(1280, 720);
  expect(resize).toHaveBeenCalledTimes(calls);
  expect(controller.viewSize.toArray()).toEqual([928, 520]);
  expect(target.viewport.toArray()).toEqual([0, 0, 928, 520]);
  controller.dispose();
});
