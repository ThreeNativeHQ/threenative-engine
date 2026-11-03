import {
  ACESFilmicToneMapping,
  type Color,
  CustomToneMapping,
  PerspectiveCamera,
  type RenderTarget,
  Scene,
  Texture,
  type Vector2,
} from "three";
import DenoiseNode from "three/addons/tsl/display/DenoiseNode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { texture, vec4 } from "three/tsl";
import {
  type Node,
  NodeFrame,
  NodeMaterial,
  QuadMesh,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { afterEach, expect, it, vi } from "vitest";
import { qualityPreset } from "../src/look/quality.js";
import { type OutputRenderer, WorldEnvironment } from "../src/look/world-environment.js";
import { readRenderChainObservation } from "../src/render/chain.js";
import { ResolutionSubrect } from "../src/render/resolution-subrect.js";

const host = vi.hoisted(() => ({ native: false }));
vi.mock("../src/platform.js", () => ({ isNative: () => host.native }));

// Owner 2026-10-22: a scene with no look options gets a fresh Unreal 5.8.3 project's look (PRD-722 Phase 2).
afterEach(() => {
  vi.restoreAllMocks();
  host.native = false;
});

function renderer(kind: string, raw: object = {}) {
  const requested: { stages?: readonly string[]; tier?: string }[] = [];
  const target: OutputRenderer = {
    kind,
    raw,
    createRenderChain(options) {
      requested.push(options.request ?? {});
      return { applied: { stages: [], dropped: [] }, dispose() {} };
    },
  };
  return { requested, target };
}

function apply(options: ConstructorParameters<typeof WorldEnvironment>[0], target: OutputRenderer) {
  new WorldEnvironment(options).apply(target, new Scene(), new PerspectiveCamera())?.dispose?.();
}

it("starts a WebGPU renderer on Unreal's filmic curve and the high tier with no options", () => {
  const addToneMapping = vi.fn();
  const raw: { toneMapping?: number; library: object } = { library: { addToneMapping } };
  const { requested, target } = renderer("webgpu", raw);
  apply({}, target);
  expect(raw.toneMapping).toBe(CustomToneMapping);
  expect(addToneMapping).toHaveBeenCalledTimes(1);
  expect(requested[0]?.tier).toBe("high");
  expect(requested[0]?.stages).toEqual(
    expect.arrayContaining(["ambientOcclusion", "bloom", "antialias"]),
  );
});

it('keeps "aces" as the named override and installs no custom curve', () => {
  const addToneMapping = vi.fn();
  const raw: { toneMapping?: number; library: object } = { library: { addToneMapping } };
  apply({ tonemapMode: "aces" }, renderer("webgpu", raw).target);
  expect(raw.toneMapping).toBe(ACESFilmicToneMapping);
  expect(addToneMapping).not.toHaveBeenCalled();
});

function report(options: ConstructorParameters<typeof WorldEnvironment>[0], kind: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return new WorldEnvironment(options).apply(
    renderer(kind).target,
    new Scene(),
    new PerspectiveCamera(),
  );
}

it("defaults auto exposure on, so a renderer without WebGPU reports the fixed fallback", () => {
  expect(report({}, "webgl2").dropped).toContainEqual({
    name: "autoExposure",
    reason: "renderer:webgl2",
  });
});

it("keeps the meter on a native host, where the engine player runs its passes", () => {
  host.native = true;
  const dropped = report({}, "webgpu").dropped.map((d) => d.name);
  expect(dropped).not.toContain("autoExposure");
});

it("keeps autoExposureEnabled: false as the named override for the fixed exposure", () => {
  const dropped = report({ autoExposureEnabled: false }, "webgl2").dropped.map((d) => d.name);
  expect(dropped).not.toContain("autoExposure");
});

it("starts from the tier named by renderChainTier, and an explicit option beats the tier", () => {
  const { requested, target } = renderer("webgpu", { library: { addToneMapping() {} } });
  apply({ renderChainTier: "low" }, target);
  apply({ gtaoEnabled: false, bloomEnabled: false }, target);
  expect(requested[0]?.tier).toBe("low");
  expect(requested[0]?.stages).not.toContain("ambientOcclusion");
  expect(requested[1]?.stages).not.toContain("ambientOcclusion");
  expect(requested[1]?.stages).not.toContain("bloom");
});

it("gathers screen-space GI at half resolution by default, reports it, and keeps 1 as the named override", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const marker = (options: ConstructorParameters<typeof WorldEnvironment>[0]) => {
    info.mockClear();
    apply(options, renderer("webgpu", { library: { addToneMapping() {} } }).target);
    const line = info.mock.calls
      .map(String)
      .find((text) => text.startsWith("TN_WORLD_ENVIRONMENT:"));
    return JSON.parse(line?.slice("TN_WORLD_ENVIRONMENT:".length) ?? "{}");
  };
  expect(marker({}).ssgiResolutionScale).toBe(0.5);
  expect(marker({ ssgiResolutionScale: 1 }).ssgiResolutionScale).toBe(1);
});

it("caps the reflection march at Unreal's steps per tier, reports it, and keeps ssrMaxSteps as the override", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const marker = (options: ConstructorParameters<typeof WorldEnvironment>[0]) => {
    info.mockClear();
    apply(options, renderer("webgpu", { library: { addToneMapping() {} } }).target);
    const line = info.mock.calls
      .map(String)
      .find((text) => text.startsWith("TN_WORLD_ENVIRONMENT:"));
    return JSON.parse(line?.slice("TN_WORLD_ENVIRONMENT:".length) ?? "{}").ssrMaxSteps;
  };
  expect(marker({})).toBe(32);
  expect(marker({ renderChainTier: "medium" })).toBe(16);
  expect(marker({ renderChainTier: "low" })).toBe(8);
  expect(marker({ ssrMaxSteps: 64 })).toBe(64);
  // The core three patch adds the cap to the mirror trace; stock three has no such uniform.
  const node = ssr(texture(new Texture()), texture(new Texture()), texture(new Texture()).xyz, {
    camera: new PerspectiveCamera(),
  }) as unknown as { maxSteps?: { value: number } };
  expect(node.maxSteps?.value).toBe(1e6);
});

it("gathers contact occlusion at half resolution on medium only, as Unreal's Medium cuts its AO budget", () => {
  expect(qualityPreset("medium").gtaoResolutionScale).toBe(0.5);
  expect(qualityPreset("high").gtaoResolutionScale).toBeUndefined();
});

it("does not let an undefined option cancel the preset", () => {
  const { requested, target } = renderer("webgpu", { library: { addToneMapping() {} } });
  apply({ gtaoEnabled: undefined }, target);
  expect(requested[0]?.stages).toContain("ambientOcclusion");
});

it.each([
  [0.25, false, 1, 1],
  [1, false, 1, 0],
  [0.25, true, 1, 0],
  [0.25, false, 0, 0],
] as const)(
  "compiles AO scale %s, owned %s, filter radius %s with %s filter producers",
  (scale, owned, radius, count) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const controller = new ResolutionSubrect();
    const target = renderer("webgpu", { info: owned ? { engine: "native" } : {} }).target;
    target.createResolutionSubrect = () => controller;
    let composite: Node | undefined;
    let release = () => {};
    target.createRenderChain = ({ stages }) => {
      const stage = stages?.find((entry) => entry.name === "ambientOcclusion");
      if (!stage) throw new Error("missing AO stage");
      composite = stage.build(vec4(1), { tier: "medium" }) as Node;
      release = () => stage.dispose?.();
      return { applied: { stages: ["ambientOcclusion"], dropped: [] }, dispose: release };
    };
    const environment = new WorldEnvironment({
      autoExposureEnabled: false,
      tonemapMode: "aces",
      gtaoEnabled: true,
      gtaoRadius: 0.35,
      gtaoResolutionScale: scale,
      gtaoDenoiseRadius: radius,
      bloomEnabled: false,
      screenSpaceAA: "disabled",
    }).apply(target, new Scene(), new PerspectiveCamera());
    if (!environment.dispose) throw new Error("missing environment disposal");
    const gpu = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    vi.spyOn(gpu, "hasFeature").mockReturnValue(false);
    vi.spyOn(Reflect.get(gpu.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
      65536,
    );
    const material = new NodeMaterial();
    material.fragmentNode = composite ?? null;
    const builder = new WGSLNodeBuilder(new QuadMesh(material), gpu) as WGSLNodeBuilder & {
      setShaderStage(stage: string): void;
      flowStagesNode(node: unknown, output: string): { code: string; result: string };
      nodes: Set<Node>;
      getBindings(): { bindings: object[] }[];
      buildUpdateNodes(): void;
      updateBeforeNodes: Node[];
    };
    builder.setShaderStage("fragment");
    const flow = builder.flowStagesNode(composite, "vec4");
    expect(flow.result).toBeTruthy();
    const producers = [...builder.nodes].filter(
      (node) =>
        Reflect.get(node, "isRTTNode") === true && Reflect.get(node, "node") instanceof DenoiseNode,
    );
    expect(producers).toHaveLength(count);
    if (count === 1) {
      const producer = producers[0] as Node & {
        renderTarget: RenderTarget;
        _quadMesh: QuadMesh & { material: NodeMaterial };
        updateBefore(frame: NodeFrame): void;
        getResolutionScale(): number;
      };
      expect(producer.getResolutionScale()).toBe(scale);
      const texture = producer.renderTarget.texture;
      expect(
        builder
          .getBindings()
          .some((group) =>
            group.bindings.some((binding) => Reflect.get(binding, "texture") === texture),
          ),
      ).toBe(true);
      const draw = vi.spyOn(QuadMesh.prototype, "render").mockImplementation(() => {});
      const frame = {
        renderer: {
          getRenderTarget: () => null,
          getDrawingBufferSize: (size: Vector2) => size.set(1920, 1080),
          setRenderTarget: vi.fn(),
          // r187 RTTNode saves, resets and restores the whole renderer state around its draw.
          getActiveCubeFace: () => 0,
          getActiveMipmapLevel: () => 0,
          getRenderObjectFunction: () => null,
          getPixelRatio: () => 1,
          getMRT: () => null,
          getClearColor: (colour: Color) => colour,
          getClearAlpha: () => 1,
          getScissorTest: () => false,
          setMRT: vi.fn(),
          setRenderObjectFunction: vi.fn(),
          setClearColor: vi.fn(),
          setPixelRatio: vi.fn(),
          setScissorTest: vi.fn(),
        },
      } as unknown as NodeFrame;
      producer.updateBefore(frame);
      expect([producer.renderTarget.width, producer.renderTarget.height]).toEqual([480, 270]);
      controller.setSize(1920, 1080);
      controller.activate(0.5);
      producer.updateBefore(frame);
      expect([producer.renderTarget.width, producer.renderTarget.height]).toEqual([480, 272]);
      expect(producer.renderTarget.viewport.toArray()).toEqual([0, 0, 240, 136]);
      const filterBuilder = new WGSLNodeBuilder(producer._quadMesh, gpu) as typeof builder;
      filterBuilder.setShaderStage("fragment");
      const filterFlow = filterBuilder.flowStagesNode(
        producer._quadMesh.material.fragmentNode,
        "vec4",
      );
      expect(filterFlow.code).toMatch(/< 16/);
      expect(flow.code).not.toMatch(/< 16/);
      builder.buildUpdateNodes();
      expect(builder.updateBeforeNodes).toContain(producer);
      filterBuilder.buildUpdateNodes();
      expect(filterBuilder.updateBeforeNodes).toContain(Reflect.get(producer, "node"));
      expect(
        filterBuilder.updateBeforeNodes.some((node) => node.constructor.name === "GTAONode"),
      ).toBe(true);
      controller.setSize(2560, 1440);
      producer.updateBefore(frame);
      expect([producer.renderTarget.width, producer.renderTarget.height]).toEqual([640, 360]);
      expect(producer.renderTarget.viewport.toArray()).toEqual([0, 0, 320, 180]);
      const disposeTarget = vi.spyOn(producer.renderTarget, "dispose");
      producer.updateBefore(frame);
      expect(disposeTarget).not.toHaveBeenCalled();
      expect(draw).toHaveBeenCalledTimes(4);
      draw.mockClear();
      const scheduledFrame = new NodeFrame();
      scheduledFrame.renderer = frame.renderer;
      scheduledFrame.frameId = 1;
      for (let renderId = 1; renderId <= 5; renderId++) {
        scheduledFrame.renderId = renderId;
        scheduledFrame.updateBeforeNode(producer);
      }
      expect(draw).toHaveBeenCalledTimes(1);
      scheduledFrame.frameId++;
      scheduledFrame.renderId++;
      scheduledFrame.updateBeforeNode(producer);
      expect(draw).toHaveBeenCalledTimes(2);
      const disposeMaterial = vi.spyOn(producer._quadMesh.material, "dispose");
      release();
      environment.dispose();
      environment.dispose();
      expect(disposeTarget).toHaveBeenCalledTimes(1);
      expect(disposeMaterial).toHaveBeenCalledTimes(1);
    } else environment.dispose();
    material.dispose();
  },
);

const noPost = {
  autoExposureEnabled: false,
  bloomEnabled: false,
  godraysEnabled: false,
  motionBlurEnabled: false,
  sharpenEnabled: false,
  ssgiEnabled: false,
  ssrEnabled: false,
  gtaoEnabled: false,
  localExposureEnabled: false,
  renderChainTier: "low",
  screenSpaceAA: "disabled",
  vignetteAmount: 0,
} as const;

it("still reports its render-chain tier when every post stage is off", () => {
  const raw = {};
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
  const applied = new WorldEnvironment(noPost).apply(
    renderer("webgpu", raw).target,
    new Scene(),
    new PerspectiveCamera(),
  );
  const marker = lines.find((line) => line.startsWith("TN_RENDER_CHAIN:"));
  expect(JSON.parse(marker?.slice("TN_RENDER_CHAIN:".length) ?? "{}").applied).toMatchObject({
    stages: [],
    tier: "low",
  });
  expect(readRenderChainObservation(raw)).toMatchObject({ stages: [], tier: "low" });
  applied.dispose?.();
  expect(readRenderChainObservation(raw)).toBeUndefined();
});
