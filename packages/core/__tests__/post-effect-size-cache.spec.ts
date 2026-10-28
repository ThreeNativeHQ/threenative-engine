import { Color, RenderTarget, Texture } from "three";
import { float, texture } from "three/tsl";
import { NodeFrame, type NodeMaterial, QuadMesh, type Renderer } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalExposureNode, localExposureSizes } from "../src/look/local-exposure.js";
import { UnrealBloomNode } from "../src/look/unreal-bloom.js";

type Extent = [number, number];

function rendererStub() {
  return {
    info: { engine: { environmentBake: false, frameGateSkips: 0 } },
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: "",
    autoClear: true,
    getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
      target.set(size[0], size[1]),
    setRenderTarget: vi.fn(),
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderObjectFunction: () => null,
    setRenderObjectFunction: vi.fn(),
    getPixelRatio: () => 1,
    setPixelRatio: vi.fn(),
    getMRT: () => null,
    setMRT: vi.fn(),
    getClearColor: () => new Color(),
    getClearAlpha: () => 1,
    setClearColor: vi.fn(),
    getScissorTest: () => false,
    setScissorTest: vi.fn(),
  } as unknown as Renderer;
}

let size: Extent = [1920, 1080];

function expectedExtents(width: number, height: number): Extent[] {
  const down = Array.from(
    { length: 6 },
    (_, i) =>
      [
        Math.max(1, Math.ceil(width / 2 ** (i + 1))),
        Math.max(1, Math.ceil(height / 2 ** (i + 1))),
      ] as Extent,
  );
  const stages = UnrealBloomNode.schedule(width, height).flatMap(
    ({ width: w, height: h }) =>
      [
        [w, h],
        [w, h],
      ] as Extent[],
  );
  const sizes = localExposureSizes(width, height);
  return [
    ...down,
    ...stages,
    sizes.log as Extent,
    sizes.blur as Extent,
    sizes.blur as Extent,
    sizes.blur as Extent,
    sizes.rows as Extent,
    sizes.grid as Extent,
  ];
}

function expectedGaussians(width: number, height: number): number {
  return UnrealBloomNode.schedule(width, height).reduce((sum, { taps }) => sum + 2 * taps - 1, 0);
}

function harness(width = 1920, height = 1080) {
  size = [width, height];
  const draws: unknown[] = [];
  vi.spyOn(QuadMesh.prototype, "render").mockImplementation(function (this: QuadMesh) {
    draws.push((this.material as NodeMaterial | null)?.fragmentNode ?? null);
  });
  const sizeCalls: Extent[] = [];
  vi.spyOn(RenderTarget.prototype, "setSize").mockImplementation(function (
    this: RenderTarget,
    w: number,
    h: number,
  ) {
    sizeCalls.push([w, h]);
  });
  const gaussians = vi.spyOn(Math, "exp");
  const bloom = new UnrealBloomNode(texture(new Texture()));
  const local = new LocalExposureNode(texture(new Texture()), float(1));
  const frame = new NodeFrame();
  frame.renderer = rendererStub();
  frame.deltaTime = 1 / 60;
  frame.time = 1;
  const update = () => {
    bloom.updateBefore(frame);
    local.updateBefore(frame);
  };
  const clear = () => {
    sizeCalls.length = 0;
    draws.length = 0;
    gaussians.mockClear();
  };
  const resize = (nextWidth: number, nextHeight: number) => {
    size = [nextWidth, nextHeight];
  };
  return { bloom, local, frame, sizeCalls, draws, gaussians, update, clear, resize };
}

describe("post-effect size cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rebuilds bloom and local exposure setup only when the drawing buffer size changes", () => {
    const { bloom, local, sizeCalls, draws, gaussians, update, clear, resize } = harness();
    update();
    expect(draws).toHaveLength(24);
    clear();

    // The same dimensions: no target sizing and no Gaussian normalization.
    update();
    expect(sizeCalls).toEqual([]);
    expect(gaussians).not.toHaveBeenCalled();
    expect(draws).toHaveLength(24);

    // A resize rebuilds each target at its new extent and the bloom normalization.
    resize(1280, 720);
    clear();
    update();
    expect(sizeCalls).toEqual(expectedExtents(1280, 720));
    expect(gaussians).toHaveBeenCalledTimes(expectedGaussians(1280, 720));
    expect(draws).toHaveLength(24);

    // Repeating the new dimensions performs no further setup.
    clear();
    update();
    expect(sizeCalls).toEqual([]);
    expect(gaussians).not.toHaveBeenCalled();
    expect(draws).toHaveLength(24);

    // Odd dimensions must size the same way as a fresh configuration.
    resize(1921, 1081);
    clear();
    update();
    expect(sizeCalls).toEqual(expectedExtents(1921, 1081));
    expect(gaussians).toHaveBeenCalledTimes(expectedGaussians(1921, 1081));
    expect(draws).toHaveLength(24);

    // A height-only resize invalidates the cache too.
    resize(1921, 1082);
    clear();
    update();
    expect(sizeCalls).toEqual(expectedExtents(1921, 1082));
    expect(gaussians).toHaveBeenCalledTimes(expectedGaussians(1921, 1082));
    expect(draws).toHaveLength(24);

    local.dispose();
    bloom.dispose();
  });

  it("keeps the same fragment nodes and pass order across a same-size update", () => {
    const { bloom, local, draws, update, clear } = harness();
    update();
    const before = draws.slice();
    clear();
    update();
    expect(draws).toHaveLength(before.length);
    expect(draws.every((node, i) => node === before[i])).toBe(true);
    local.dispose();
    bloom.dispose();
  });

  it("refuses a disposed node and restores renderer state when a draw throws", () => {
    const { bloom, local, frame, update } = harness();
    update();
    vi.mocked(QuadMesh.prototype.render).mockImplementationOnce(() => {
      throw new Error("draw failed");
    });
    expect(() => bloom.updateBefore(frame)).toThrow("draw failed");
    expect(frame.renderer?.setRenderTarget).toHaveBeenLastCalledWith(null, 0, 0);

    bloom.dispose();
    local.dispose();
    expect(() => bloom.updateBefore(frame)).toThrow(/disposed/i);
    expect(() => local.updateBefore(frame)).toThrow(/disposed/i);
  });
});
