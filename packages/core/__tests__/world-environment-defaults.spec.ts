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
import { pass, texture, vec4 } from "three/tsl";
import {
  type Node,
  NodeFrame,
  NodeMaterial,
  QuadMesh,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { afterEach, expect, it, vi } from "vitest";
import { aoRefusal } from "../src/look/ao-admission.js";
import { qualityPreset } from "../src/look/quality.js";
import {
  type OutputRenderer,
  WorldEnvironment,
  translucentTargetWanted,
} from "../src/look/world-environment.js";
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

it("never multisamples the world on a cheaper tier than the one above it", () => {
  // An unset count inherits the renderer's 4x MSAA. The adaptive loop stepped a forest from medium
  // (single-sample) to low and the frame cost rose 125 -> 158 ms on an Iris Xe (PRD-762).
  const samples = (tier: string) => qualityPreset(tier).samples ?? 4;
  expect(samples("low")).toBeLessThanOrEqual(samples("medium"));
  expect(samples("medium")).toBeLessThanOrEqual(samples("high"));
});

it("draws no screen-space reflections on the low tier, as Unreal's ReflectionQuality 0 (PRD-871)", () => {
  // UE 5.8.3 Engine/Config/BaseScalability.ini:514-515: [ReflectionQuality@0] r.SSR.Quality=0. The low tier left
  // `ssrEnabled` unset, the default turned it on, and its normal/metalness/roughness reads cost an Iris Xe a full
  // second geometry pass: 6.7 ms of a 26.7 ms stress frame.
  const { requested, target } = renderer("webgpu", { library: { addToneMapping() {} } });
  apply(qualityPreset("low"), target);
  expect(requested[0]?.stages).not.toContain("ssr");
  expect(requested[0]?.stages).toContain("bloom");
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

// PRD-617, PRD-635: the screen-reach occlusion darkens indirect light only. Upstream three cannot tell that share
// apart without a baked world cache, so the stage refuses there instead of darkening the sun. The owned engine writes
// the share to its own `indirectDiffuse` target, so it admits the stage on any frame, cache or not.
const passNode = Object.getPrototypeOf(pass(new Scene(), new PerspectiveCamera()));
const getTextureNode = passNode.getTextureNode;
function buildAo(
  engine: object | undefined,
  options: ConstructorParameters<typeof WorldEnvironment>[0],
) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const target = renderer("webgpu", engine === undefined ? {} : { info: { engine } }).target;
  const reads: string[] = [];
  vi.spyOn(passNode, "getTextureNode").mockImplementation(function (
    this: unknown,
    name = "output",
  ) {
    reads.push(name as string);
    return getTextureNode.call(this, name);
  });
  let error: unknown;
  target.createRenderChain = ({ stages }) => {
    const stage = stages?.find((entry) => entry.name === "ambientOcclusion");
    if (!stage) throw new Error("missing AO stage");
    try {
      stage.build(vec4(1), { tier: "high" });
    } catch (caught) {
      error = caught;
    }
    return { applied: { stages: [], dropped: [] }, dispose() {} };
  };
  apply(
    {
      autoExposureEnabled: false,
      bloomEnabled: false,
      finalGatherMethod: "none",
      gtaoEnabled: true,
      tonemapMode: "aces",
      ...options,
    },
    target,
  );
  return { error, reads };
}

it("refuses the screen-reach occlusion on upstream three with no world cache", () => {
  expect(String(buildAo(undefined, {}).error)).toMatch(/^Error: TN_AO_INDIRECT_UNSUPPORTED: /);
});

it("admits the screen-reach occlusion on the owned engine with no world cache", () => {
  // The test's GTAONode is upstream's, which has no `reachPx`: the stage gets past the admission to that check.
  expect(String(buildAo({ name: "native" }, {}).error)).toMatch(
    /^Error: TN_AO_REACH_UNSUPPORTED: /,
  );
});

it("darkens only the owned engine's indirect diffuse target, and the whole frame on upstream three", () => {
  const owned = buildAo({ name: "native" }, { gtaoRadius: 0.35 });
  expect(owned.error).toBeUndefined();
  expect(owned.reads).toContain("indirectDiffuse");
  const upstream = buildAo(undefined, { gtaoRadius: 0.35 });
  expect(upstream.error).toBeUndefined();
  expect(upstream.reads).not.toContain("indirectDiffuse");
  // The named override keeps the whole-frame multiply on the owned engine too.
  expect(
    buildAo({ name: "native" }, { gtaoRadius: 0.35, gtaoIndirectOnly: false }).reads,
  ).not.toContain("indirectDiffuse");
});

it.each([
  { hasIndirect: false, indirectOnly: true, reach: true, refused: true },
  { hasIndirect: true, indirectOnly: true, reach: true, refused: false },
  { hasIndirect: true, indirectOnly: true, reach: false, refused: false },
  { hasIndirect: false, indirectOnly: false, reach: true, refused: false },
  { hasIndirect: false, indirectOnly: true, reach: false, refused: false },
] as const)("admits the occlusion on %o", ({ refused, ...request }) => {
  const message = aoRefusal(request);
  expect(message === undefined).toBe(!refused);
  if (refused) expect(message).toMatch(/^TN_AO_INDIRECT_UNSUPPORTED: /);
});

it("draws the transparent draws' own target unless a launch asks a measurement for it off", () => {
  const host = globalThis as { __tnTranslucent?: unknown; process?: unknown };
  const save = { host, env: host.process, location: globalThis.location };
  try {
    expect(translucentTargetWanted()).toBe(true);
    // One launch names the switch once, on the three surfaces a launch has.
    host.process = { env: { TN_TRANSLUCENT: "0" } };
    expect(translucentTargetWanted()).toBe(false);
    host.process = { env: {} };
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://127.0.0.1:5173/?tnTranslucent=0"),
    });
    expect(translucentTargetWanted()).toBe(false);
    // Another query keeps the target: the switch is a name, not a substring.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://127.0.0.1:5173/?tnTranslucentOn=0"),
    });
    expect(translucentTargetWanted()).toBe(true);
    host.__tnTranslucent = false;
    expect(translucentTargetWanted()).toBe(false);
  } finally {
    host.process = save.env;
    Reflect.deleteProperty(host, "__tnTranslucent");
    Object.defineProperty(globalThis, "location", { configurable: true, value: save.location });
  }
});
