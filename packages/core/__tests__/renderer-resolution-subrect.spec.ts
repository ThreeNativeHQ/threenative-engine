import { DepthTexture, RenderTarget, Texture } from "three";
import { PerspectiveCamera, Scene } from "three";
import { pass } from "three/tsl";
import { describe, expect, it, vi } from "vitest";
import { ResolutionSubrect } from "../src/render/resolution-subrect.js";
import { createRenderer } from "../src/renderer.js";

describe("retained render targets", () => {
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
