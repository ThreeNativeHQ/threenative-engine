import { NoToneMapping, Scene, Texture, Vector3, WebGPUCoordinateSystem } from "three";
import type { WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { SkyCapture, SkyCaptureSchedule } from "../src/render/sky-capture.js";

const filter = vi.hoisted(() => ({ fromCubemap: vi.fn(), dispose: vi.fn() }));
vi.mock("three/webgpu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three/webgpu")>()),
  PMREMGenerator: class {
    fromCubemap = filter.fromCubemap;
    dispose = filter.dispose;
  },
}));

function renderer() {
  return {
    coordinateSystem: WebGPUCoordinateSystem,
    xr: { enabled: true },
    autoClear: false,
    toneMapping: 4,
    getRenderTarget: () => null,
    getActiveCubeFace: () => 3,
    getActiveMipmapLevel: () => 2,
    setRenderTarget: vi.fn(),
    render: vi.fn(),
  };
}

const sun = (degrees: number) =>
  new Vector3(Math.sin((degrees * Math.PI) / 180), Math.cos((degrees * Math.PI) / 180), 0);

describe("SkyCaptureSchedule", () => {
  it("captures initially, stays idle at/below the threshold, and accumulates small moves", () => {
    const schedule = new SkyCaptureSchedule({ thresholdAngle: 0.1, facesPerFrame: 6 });
    expect(schedule.next(sun(0))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(schedule.next(sun(0))).toEqual([]);
    expect(schedule.next(sun(3))).toEqual([]);
    expect(schedule.next(sun(5))).toEqual([]);
    expect(schedule.next(sun(6))).toHaveLength(6);
    expect(schedule.next(sun(6).multiplyScalar(10))).toEqual([]);
    const exact = new SkyCaptureSchedule({ thresholdAngle: Math.PI / 2, facesPerFrame: 6 });
    exact.next(new Vector3(1, 0, 0));
    expect(exact.next(new Vector3(0, 1, 0))).toEqual([]);
    expect(exact.next(new Vector3(-1, 0, 0))).toHaveLength(6);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "spreads all six faces with budget %i, even while the sun moves",
    (facesPerFrame) => {
      const schedule = new SkyCaptureSchedule({ facesPerFrame });
      const frames = Math.ceil(6 / facesPerFrame);
      const faces = Array.from({ length: frames }, (_, i) => schedule.next(sun(i * 10)));
      expect(faces.flat()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(faces.every((batch) => batch.length <= facesPerFrame)).toBe(true);
      expect(schedule.next(sun(90))).toHaveLength(facesPerFrame);
    },
  );

  it("rejects invalid options and directions", () => {
    for (const thresholdAngle of [-1, Number.NaN, Number.POSITIVE_INFINITY, Math.PI + 0.01]) {
      expect(() => new SkyCaptureSchedule({ thresholdAngle })).toThrow(/thresholdAngle/);
    }
    for (const facesPerFrame of [0, 7, 1.5, Number.NaN]) {
      expect(() => new SkyCaptureSchedule({ facesPerFrame })).toThrow(/facesPerFrame/);
    }
    const schedule = new SkyCaptureSchedule();
    expect(() => schedule.next(new Vector3())).toThrow(/sun/);
    expect(() => schedule.next(new Vector3(Number.NaN, 1, 0))).toThrow(/sun/);
  });
});

describe("SkyCapture", () => {
  it("captures each face once, masks before filtering, and reuses its PMREM target", () => {
    const raw = renderer();
    const sky = new Scene();
    const target = { texture: new Texture(), dispose: vi.fn() };
    filter.fromCubemap.mockReset().mockReturnValue(target);
    filter.dispose.mockClear();
    const capture = new SkyCapture(raw as unknown as WebGPURenderer, sky, { facesPerFrame: 2 });
    expect(capture.texture).toBeUndefined();
    expect(capture.update(sun(0))).toBe(false);
    expect(capture.update(sun(0))).toBe(false);
    expect(filter.fromCubemap).not.toHaveBeenCalled();
    expect(capture.update(sun(0))).toBe(true);
    expect(raw.render).toHaveBeenCalledTimes(12);
    expect(raw.render.mock.calls.filter(([scene]) => scene === sky)).toHaveLength(6);
    expect(filter.fromCubemap).toHaveBeenCalledWith(capture.cubeTarget.texture, undefined);
    expect(capture.texture).toBe(target.texture);
    const mask = raw.render.mock.calls.find(([scene]) => scene !== sky)?.[0] as Scene;
    const mesh = mask.children[0] as import("three").Mesh<
      import("three").SphereGeometry,
      import("three/webgpu").MeshBasicNodeMaterial
    >;
    expect(mesh.material.color.getHex()).toBe(0);
    expect(mesh.material.depthTest).toBe(false);
    expect(mesh.geometry.parameters.thetaStart).toBe(Math.PI / 2);
    expect(mesh.geometry.parameters.thetaLength).toBe(Math.PI / 2);
    expect(capture.update(sun(0))).toBe(false);
    for (let i = 0; i < 3; i++) capture.update(sun(10));
    expect(filter.fromCubemap).toHaveBeenLastCalledWith(capture.cubeTarget.texture, target);
    expect(raw.setRenderTarget).toHaveBeenLastCalledWith(null, 3, 2);
    expect(raw.xr.enabled).toBe(true);
    expect(raw.autoClear).toBe(false);
    expect(raw.toneMapping).toBe(4);
    capture.dispose();
    capture.dispose();
    expect(target.dispose).toHaveBeenCalledTimes(1);
    expect(filter.dispose).toHaveBeenCalledTimes(1);
  });

  it("restores renderer state after a render failure and retries from face zero", () => {
    const raw = renderer();
    raw.render.mockImplementationOnce(() => {
      expect(raw.xr.enabled).toBe(false);
      expect(raw.toneMapping).toBe(NoToneMapping);
      throw new Error("render failed");
    });
    const capture = new SkyCapture(raw as unknown as WebGPURenderer, new Scene(), {
      lowerHemisphereBlack: false,
    });
    expect(() => capture.update(sun(0))).toThrow("render failed");
    expect(raw.setRenderTarget).toHaveBeenLastCalledWith(null, 3, 2);
    expect(raw.xr.enabled).toBe(true);
    expect(raw.autoClear).toBe(false);
    expect(raw.toneMapping).toBe(4);
    raw.setRenderTarget.mockClear();
    capture.update(sun(0));
    expect(raw.setRenderTarget).toHaveBeenNthCalledWith(1, capture.cubeTarget, 0, 0);
    expect(raw.render).toHaveBeenCalledTimes(2);
    capture.dispose();
  });

  it("refuses malformed resolution and hemisphere options before allocating GPU resources", () => {
    for (const resolution of [0, 1, 127, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SkyCapture({} as never, new Scene(), { resolution })).toThrow(/resolution/);
    }
    expect(
      () => new SkyCapture({} as never, new Scene(), { lowerHemisphereBlack: 1 as never }),
    ).toThrow(/lowerHemisphereBlack/);
  });

  it("disposes once without a GPU and refuses subsequent updates", () => {
    const capture = new SkyCapture({} as never, new Scene());
    const cubeDispose = vi.spyOn(capture.cubeTarget, "dispose");
    capture.dispose();
    capture.dispose();
    expect(cubeDispose).toHaveBeenCalledTimes(1);
    expect(() => capture.update(sun(0))).toThrow(/disposed/);
  });
});
