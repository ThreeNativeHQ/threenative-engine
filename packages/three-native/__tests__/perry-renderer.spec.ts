import { describe, expect, it, vi } from "vitest";

vi.mock("../src/browser-backend.js", () => ({
  engineRef: (value: { ref?: unknown }) => value.ref,
}));
const { definePerryRenderer } = await import("../src/perry-renderer.js");

class Vec2 {
  x = 0;
  y = 0;
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
}

function renderer() {
  const calls: unknown[][] = [];
  const sync = vi.fn();
  const Renderer = definePerryRenderer({
    color: class {
      r = 1;
      g = 0;
      b = 0;
    },
    sync,
    renderInfo: () => ({ drawCalls: 0, triangles: 0 }),
    adapterInfo: () => "null",
    render: (...args) => calls.push(args),
  });
  return { renderer: new Renderer(), calls, sync };
}

describe("Perry WebGPURenderer", () => {
  it("reports the last native frame and the adapter fields core reads", async () => {
    let frame = { drawCalls: 0, triangles: 0 };
    let adapter = "null";
    const Renderer = definePerryRenderer({
      color: class {
        r = 0;
        g = 0;
        b = 0;
      },
      sync() {},
      render() {},
      renderInfo: () => frame,
      adapterInfo: () => adapter,
    });
    const r = new Renderer();
    expect(r.info.render).toMatchObject({ drawCalls: 0, calls: 0, triangles: 0 });
    expect(await r.backend.gpu.requestAdapter()).toBeNull();
    frame = { drawCalls: 7, triangles: 123456 };
    expect(r.info.render).toMatchObject({ drawCalls: 7, calls: 7, triangles: 123456 });
    r.info.reset();
    expect(r.info.render.triangles).toBe(123456);
    const info = {
      architecture: "swiftshader",
      description: "SwiftShader Device (Subzero)",
      device: 'SwiftShader "GPU"',
      vendor: "google",
    };
    adapter = JSON.stringify(info);
    expect(await r.backend.gpu.requestAdapter()).toEqual({ info, limits: {} });
    frame = { drawCalls: 1, triangles: 12 };
    expect(r.info.render).toMatchObject({ drawCalls: 1, calls: 1, triangles: 12 });
  });

  it("answers the renderer queries core and games make", () => {
    const { renderer: r } = renderer();
    r.setSize(640, 360);
    r.setPixelRatio(1.5);
    expect(r.getMaxAnisotropy()).toBe(16);
    expect(r.getPixelRatio()).toBe(1.5);
    expect(r.getSize(new Vec2())).toMatchObject({ x: 640, y: 360 });
    expect(r.getDrawingBufferSize(new Vec2())).toMatchObject({ x: 960, y: 540 });
    expect(r.autoClear).toBe(true);
    expect(r.getRenderTarget()).toBeNull();
    r.setRenderTarget(null);
    expect(() => r.setRenderTarget({})).toThrow("TN_PERRY_RENDER_TARGET");
    expect(() => r.setPixelRatio(0)).toThrow("TN_PERRY_RENDER_PIXEL_RATIO");
  });

  it("renders at the drawing-buffer size after one sync", () => {
    const { renderer: r, calls, sync } = renderer();
    r.setSize(640, 360);
    r.setPixelRatio(2);
    r.setClearColor("red", 0.5);
    r.render({ ref: "scene" }, { ref: "camera" });
    expect(sync).toHaveBeenCalledOnce();
    expect(calls).toEqual([["scene", "camera", 1280, 720, 0, 1, true, [1, 0, 0, 0.5]]]);
    expect(() => r.render({}, { ref: "camera" })).toThrow("TN_PERRY_RENDER_ARGUMENT");
  });
});
