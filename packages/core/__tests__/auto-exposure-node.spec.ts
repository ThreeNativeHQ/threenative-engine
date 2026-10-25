import { Color, type RenderTarget, Texture } from "three";
import { float, texture, vec4 } from "three/tsl";
import {
  NodeFrame,
  NodeMaterial,
  QuadMesh,
  type Renderer,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoExposureNode, applyExposure } from "../src/look/auto-exposure.js";
import { exposureSettings } from "../src/look/exposure-settings.js";

function harness(enabled = true) {
  const settings = { ...exposureSettings, enabled };
  const node = new AutoExposureNode(texture(new Texture()), settings, 2);
  const frame = new NodeFrame();
  let size: [number, number] = [17, 5];
  const targets: RenderTarget[] = [];
  const info = { engine: { environmentBake: false, frameGateSkips: 0 } };
  frame.renderer = {
    info,
    getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
      target.set(size[0], size[1]),
    setRenderTarget: vi.fn((target: RenderTarget | null) => {
      if (target !== null) targets.push(target);
    }),
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
    readRenderTargetPixelsAsync: vi.fn().mockResolvedValue(new Float32Array([2, 0.045, 2, 1])),
  } as unknown as Renderer;
  frame.deltaTime = 1 / 60;
  frame.time = 1;
  return {
    node,
    frame,
    targets,
    renderer: frame.renderer,
    info,
    settings,
    resize: (width: number, height: number) => {
      size = [width, height];
    },
  };
}

describe("GPU exposure lifecycle", () => {
  it("changes RGB without multiplying alpha into the compositor a second time", () => {
    const colour = vec4(0.8, 0.4, 0.2, 0.3);
    const exposed = applyExposure(colour, float(0.125));
    const parts = Reflect.get(Reflect.get(exposed, "node"), "nodes") as unknown[];
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe(colour.a);
    const rgb = parts[0];
    expect(Reflect.get(Reflect.get(rgb as object, "node"), "aNode")).toBe(colour.rgb);
  });
  beforeEach(() => {
    vi.spyOn(QuadMesh.prototype, "render").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reduces to 16x16 blocks, tiles then bins a 64x1 histogram and retains its 1x1 ping-pong history across resize", () => {
    const { node, frame, targets, resize } = harness();
    node.updateBefore(frame);
    expect(targets.map(({ width, height }) => [width, height])).toEqual([
      [5, 2],
      [2, 1],
      [64, 64],
      [64, 1],
      [1, 1],
    ]);
    const firstHistory = targets.at(-1);
    if (firstHistory === undefined) throw new Error("missing history draw");
    const release = vi.spyOn(firstHistory, "dispose");
    targets.length = 0;
    resize(8, 4);
    node.updateBefore(frame);
    expect(targets.map(({ width, height }) => [width, height])).toEqual([
      [2, 1],
      [1, 1],
      [64, 64],
      [64, 1],
      [1, 1],
    ]);
    expect(targets.at(-1)).not.toBe(firstHistory);
    expect(release).not.toHaveBeenCalled();
    node.updateBefore(frame);
    expect(targets.at(-1)).toBe(firstHistory);
    node.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("continues measuring while disabled and reports the game's fixed exposure", async () => {
    const { node, frame, targets } = harness(false);
    expect(node.getObservation()).toEqual({ measured: false, applied: false });
    node.updateBefore(frame);
    await Promise.resolve();
    expect(targets).toHaveLength(5);
    expect(node.getObservation()).toMatchObject({
      measured: true,
      applied: false,
      luminance: expect.closeTo(0.045),
      exposureStops: 1,
    });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"applied":false'));
    node.dispose();
  });

  it("reports GPU history rather than a CPU adaptation estimate", async () => {
    const { node, frame } = harness();
    node.updateBefore(frame);
    await Promise.resolve();
    expect(node.getObservation()).toMatchObject({
      luminance: expect.closeTo(0.045),
      exposureStops: 2,
      settled: true,
    });
    node.dispose();
  });

  it("restores renderer state after draw failure and disposes each target once", () => {
    const { node, frame, targets, renderer } = harness();
    vi.mocked(QuadMesh.prototype.render).mockImplementationOnce(() => {
      throw new Error("draw failed");
    });
    expect(() => node.updateBefore(frame)).toThrow("draw failed");
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null, 0, 0);
    const first = targets[0];
    if (first === undefined) throw new Error("missing meter target");
    const release = vi.spyOn(first, "dispose");
    node.dispose();
    node.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => node.updateBefore(frame)).toThrow(/disposed/i);
  });

  it("invalidates pending observations after reset or disposal", async () => {
    const { node, frame } = harness();
    expect(() => node.reset(0)).toThrow(/exposure/i);
    node.updateBefore(frame);
    node.reset(4);
    await Promise.resolve();
    expect(node.getObservation()).toEqual({ measured: false, applied: true });
    node.reset();
    node.dispose();
  });

  it("builds the actual meter, reduction and log2 adaptation graphs to WGSL without a GPU", () => {
    const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
    const capabilities = Reflect.get(renderer.backend, "capabilities");
    vi.spyOn(capabilities, "getUniformBufferLimit").mockReturnValue(65_536);
    const generated: string[] = [];
    vi.mocked(QuadMesh.prototype.render).mockImplementation(function (this: QuadMesh) {
      if (!(this.material instanceof NodeMaterial)) throw new Error("missing node material");
      const graph = this.material.fragmentNode;
      const builder = new WGSLNodeBuilder(this, renderer) as WGSLNodeBuilder & {
        setShaderStage(stage: string): void;
        flowStagesNode(node: unknown, output: string): { code: string; result: string };
      };
      builder.setShaderStage("fragment");
      const flow = builder.flowStagesNode(graph, "vec4");
      generated.push(`${flow.code}\n${flow.result}`);
    });
    const { node, frame, settings } = harness();
    settings.rateUp = 99999; // A caller mutation cannot replace the validated shader policy.
    node.updateBefore(frame);
    expect(generated).toHaveLength(5);
    // The metered scene can be smaller than the display before the temporal resolve.
    expect(generated[0]).toContain("textureDimensions(");
    expect(generated[0]?.match(/textureLoad\(/gu)).toHaveLength(16);
    expect(generated[1]?.match(/textureLoad\(/gu)).toHaveLength(16);
    expect(generated[4]).toContain("log2(");
    expect(generated[4]).toContain("smoothstep(");
    expect(generated[4]).toContain("exp(");
    expect(generated[4]).not.toContain("99999");
    expect(generated.join("\n")).not.toContain("textureSample(");
    node.dispose();
  });

  // Unreal forces the eye-adaptation target on a view's first frame (UE 5.8.3:
  // Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:5495 and :5552,
  // PostProcess/PostProcessEyeAdaptation.cpp:723). Seeded at 1 instead, with the first adapt draws
  // skipped while the Wasm engine compiled them, Lantern Vale opened 1.8 stops under its target
  // and the first second of play brightened by 9%.
  it("adopts the measured target on the first frame and while the history holds no measurement", () => {
    const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
    const capabilities = Reflect.get(renderer.backend, "capabilities");
    vi.spyOn(capabilities, "getUniformBufferLimit").mockReturnValue(65_536);
    const draws: { code: string; scalars: unknown[] }[] = [];
    vi.mocked(QuadMesh.prototype.render).mockImplementation(function (this: QuadMesh) {
      if (!(this.material instanceof NodeMaterial)) throw new Error("missing node material");
      const builder = new WGSLNodeBuilder(this, renderer) as WGSLNodeBuilder & {
        setShaderStage(stage: string): void;
        flowStagesNode(node: unknown, output: string): { code: string };
        uniforms: Record<string, Array<{ value: unknown }>>;
      };
      builder.setShaderStage("fragment");
      const { code } = builder.flowStagesNode(this.material.fragmentNode, "vec4");
      const values = builder.uniforms.fragment?.map(({ value }) => value) ?? [];
      draws.push({ code, scalars: values.filter((value) => typeof value === "number") });
    });
    const { node, frame } = harness();
    node.updateBefore(frame);
    node.updateBefore(frame);
    // The adaptation draw is the fifth; its scalars are the reset mode, the seed and the delta.
    expect(draws[4]?.scalars).toEqual([2, 0, 1 / 60]);
    expect(draws[9]?.scalars).toEqual([0, 0, 1 / 60]);
    // In history mode, a history luminance at or below zero (never drawn, or an empty histogram)
    // takes the target.
    expect(draws[4]?.code).toMatch(/== 0\.0 \) && \( nodeVar\d+\.y <= 0\.0 \)/u);
    node.dispose();
  });

  // The owned engine draws the held scene while it bakes the environment
  // (`prepareEnvironmentAsync`). Under the loading cover that frame is black: metering it clamped
  // the target to maxStops (8.53), the first-frame adoption took it, and the world opened 5.7
  // stops bright. A bake draw is not the view's first frame; the first presented frame adopts its
  // target, as Unreal forces it.
  it("does not meter the renderer's environment bake", () => {
    const { node, frame, targets, info } = harness();
    info.engine.environmentBake = true;
    node.updateBefore(frame);
    expect(targets).toHaveLength(0);
    expect(node.getObservation()).toEqual({ measured: false, applied: true });
    info.engine.environmentBake = false;
    node.updateBefore(frame);
    expect(targets).toHaveLength(5);
    node.dispose();
  });

  // The Wasm engine's frame gate declines a render() while two frames are on the GPU. The drawn
  // frame's deltaTime covers the whole gap (the declined calls never reach the node), but maxDelta
  // clamped it to 0.1 s, so on SwiftShader the eye adapted at a fifth of its authored rate and the
  // parity capture caught it 0.9 stops high. A delta with no declined frame is still a suspension.
  it("spends the time of the frames the renderer declined and still clamps a suspended frame", () => {
    const draws: { code: string; scalars: unknown[] }[] = [];
    const gpu = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    vi.spyOn(gpu, "hasFeature").mockReturnValue(false);
    const capabilities = Reflect.get(gpu.backend, "capabilities");
    vi.spyOn(capabilities, "getUniformBufferLimit").mockReturnValue(65_536);
    vi.mocked(QuadMesh.prototype.render).mockImplementation(function (this: QuadMesh) {
      if (!(this.material instanceof NodeMaterial)) throw new Error("missing node material");
      const builder = new WGSLNodeBuilder(this, gpu) as WGSLNodeBuilder & {
        setShaderStage(stage: string): void;
        flowStagesNode(node: unknown, output: string): { code: string };
        uniforms: Record<string, Array<{ value: unknown }>>;
      };
      builder.setShaderStage("fragment");
      const { code } = builder.flowStagesNode(this.material.fragmentNode, "vec4");
      const values = builder.uniforms.fragment?.map(({ value }) => value) ?? [];
      draws.push({ code, scalars: values.filter((value) => typeof value === "number") });
    });
    const { node, frame, info } = harness();
    node.updateBefore(frame);
    info.engine.frameGateSkips = 4;
    frame.deltaTime = 0.5;
    frame.time += 0.5;
    node.updateBefore(frame);
    frame.deltaTime = 2;
    frame.time += 2;
    node.updateBefore(frame);
    // One declined call stands for one frame, not for a suspended page's whole gap.
    info.engine.frameGateSkips = 5;
    frame.deltaTime = 5;
    frame.time += 5;
    node.updateBefore(frame);
    // The adaptation draw is the fifth of each frame; its last scalar is the delta.
    expect(draws[4]?.scalars.at(-1)).toBeCloseTo(1 / 60);
    expect(draws[9]?.scalars.at(-1)).toBeCloseTo(0.5);
    expect(draws[14]?.scalars.at(-1)).toBeCloseTo(0.1);
    expect(draws[19]?.scalars.at(-1)).toBeCloseTo(0.2);
    node.dispose();
  });

  it("refuses invalid readback rather than reporting a made-up luminance", async () => {
    const { node, frame, renderer } = harness();
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockResolvedValueOnce(
      new Float32Array([0, Number.NaN, 0, 1]),
    );
    node.updateBefore(frame);
    await Promise.resolve();
    await Promise.resolve();
    expect(node.getObservation()).toMatchObject({
      measured: false,
      reason: expect.stringContaining("invalid"),
    });
    node.dispose();
  });
});
