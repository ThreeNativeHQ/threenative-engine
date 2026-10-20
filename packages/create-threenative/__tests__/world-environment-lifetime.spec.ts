import { PerspectiveCamera, Scene, Texture } from "three";
import BloomNode from "three/addons/tsl/display/BloomNode.js";
import FXAANode from "three/addons/tsl/display/FXAANode.js";
import { rtt, texture, vec4 } from "three/tsl";
import type { Node, NodeBuilder } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { ResolutionSubrect } from "../../core/src/render/resolution-subrect.js";
import { type OutputRenderer, WorldEnvironment } from "../template-assets/worldEnvironment.js";

it.each([undefined, 0, 4])(
  "honours authored world-pass samples %s without removing post AA",
  (samples) => {
    let observed: number | undefined;
    let requested: readonly string[] | undefined;
    const renderer: OutputRenderer = {
      kind: "webgpu",
      raw: {},
      createRenderChain(options) {
        observed = (options.worldPass as { options: { samples?: number } }).options.samples;
        requested = options.request?.stages;
        return { applied: { stages: [], dropped: [] }, dispose() {} };
      },
    };
    const applied = new WorldEnvironment({ gtaoEnabled: true, samples }).apply(
      renderer,
      new Scene(),
      new PerspectiveCamera(),
    );
    expect(observed).toBe(samples);
    expect(requested).toContain("antialias");
    applied.dispose?.();
  },
);

it("releases the bloom effect and its materialized input when its chain is replaced", () => {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain(options) {
      const bloomStage = options.stages?.find((stage) => stage.name === "bloom");
      if (bloomStage === undefined) throw new Error("bloom stage missing");
      const graph = bloomStage.build(options.input, { tier: "low" }) as Node;
      graph.traverse((node) => {
        if (!(node instanceof BloomNode)) return;
        releases.push(vi.spyOn(node, "dispose"));
        const scratch = node.inputNode as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        };
        releases.push(vi.spyOn(scratch.renderTarget, "dispose"));
        releases.push(vi.spyOn(scratch._quadMesh.material, "dispose"));
      });
      return {
        applied: { stages: ["bloom"], dropped: [] },
        dispose: () => bloomStage.dispose?.(),
      };
    },
  };
  const applied = new WorldEnvironment({ bloomEnabled: true }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  expect(releases).toHaveLength(3);
  applied.dispose?.();
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

it.each(["smaa", "fxaa"] as const)(
  "releases retired %s targets on repeated stage rebuilds with and without subrect support",
  (screenSpaceAA) => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        onload = () => {};
      },
    );
    try {
      for (const subrect of [true, false]) {
        const controller = new ResolutionSubrect();
        const renderer: OutputRenderer = {
          kind: "webgpu",
          raw: {},
          ...(subrect ? { createResolutionSubrect: () => controller } : {}),
          createRenderChain(options) {
            const stage = options.stages?.find((entry) => entry.name === "antialias");
            if (!stage) throw new Error("Missing antialias");
            controller.activate(0.72);
            for (let generation = 1; generation <= 3; generation++) {
              const graph = stage.build(options.input, { tier: "high" }) as Node;
              const targets: import("three").RenderTarget[] = [];
              const releases: ReturnType<typeof vi.fn>[] = [];
              const seen = new Set<Node>();
              graph.traverse((node) => {
                if (!(node instanceof FXAANode) && !Reflect.has(node, "_renderTargetEdges")) return;
                if (seen.has(node)) return;
                seen.add(node);
                releases.push(vi.spyOn(node, "dispose"));
                const scratch = Reflect.get(node, "textureNode") as {
                  renderTarget: import("three").RenderTarget;
                  _quadMesh: { material: { dispose(): void } };
                };
                targets.push(scratch.renderTarget);
                releases.push(vi.spyOn(scratch._quadMesh.material, "dispose"));
                if (Reflect.has(node, "_renderTargetEdges")) {
                  const owned = node as unknown as {
                    _renderTargetEdges: import("three").RenderTarget;
                    _renderTargetWeights: import("three").RenderTarget;
                    _renderTargetBlend: import("three").RenderTarget;
                  };
                  targets.push(
                    owned._renderTargetEdges,
                    owned._renderTargetWeights,
                    owned._renderTargetBlend,
                  );
                }
              });
              expect(targets).toHaveLength(screenSpaceAA === "smaa" ? 4 : 1);
              controller.setSize(128 * generation, 64 * generation);
              for (const target of targets) {
                if (subrect) expect(controller.textureView(target.texture)).toBeDefined();
                releases.push(vi.spyOn(target, "dispose"));
              }
              stage.dispose?.();
              stage.dispose?.();
              for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
              const retiredSizes = targets.map((target) => [
                target.width,
                target.height,
                target.viewport.toArray(),
              ]);
              for (const target of targets)
                expect(controller.textureView(target.texture)).toBeUndefined();
              controller.setScale(0.61);
              controller.setSize(128 * (generation + 1), 64 * (generation + 1));
              expect(
                targets.map((target) => [target.width, target.height, target.viewport.toArray()]),
              ).toEqual(retiredSizes);
              for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
            }
            return {
              applied: { stages: ["antialias"], dropped: [] },
              dispose: () => stage.dispose?.(),
            };
          },
        };
        const applied = new WorldEnvironment({ bloomEnabled: true, screenSpaceAA }).apply(
          renderer,
          new Scene(),
          new PerspectiveCamera(),
        );
        applied.dispose?.();
        controller.dispose();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("keeps default exposure direct and installs the authored opt-in on its existing world pass", () => {
  const output = vi.fn();
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    setOutputNode: output,
    clearOutputNode: vi.fn(),
  };
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const direct = new WorldEnvironment({ exposure: 0.62, bloomEnabled: false }).apply(
    renderer,
    scene,
    camera,
  );
  expect(output).not.toHaveBeenCalled();
  expect(direct.exposure).toBeUndefined();
  expect(renderer.raw).toMatchObject({ toneMappingExposure: 0.62 });

  const installed = new WorldEnvironment({ autoExposureEnabled: true, bloomEnabled: false }).apply(
    renderer,
    scene,
    camera,
  );
  expect(output).toHaveBeenCalledTimes(1);
  const worldPass = output.mock.calls[0]?.[1] as { dispose(): void };
  expect(worldPass).toBeDefined();
  const exposure = installed.exposure;
  expect(exposure).toBeDefined();
  expect(exposure?.settings.enabled).toBe(false);
  expect(exposure?.getObservation()).toEqual({ measured: false, applied: false });
  if (exposure === undefined) throw new Error("Actual consumer exposure missing.");
  const releaseExposure = vi.spyOn(exposure, "dispose");
  const releasePass = vi.spyOn(worldPass, "dispose");
  installed.dispose?.();
  expect(releaseExposure).toHaveBeenCalledTimes(1);
  expect(releasePass).toHaveBeenCalledTimes(1);
  expect(() => exposure?.reset()).toThrow(/disposed/);
});

it("rejects authored auto-exposure on an unsupported renderer rather than silently omitting it", () => {
  expect(() =>
    new WorldEnvironment({ autoExposureEnabled: true }).apply(
      { kind: "webgl", raw: {}, setOutputNode: vi.fn() },
      new Scene(),
      new PerspectiveCamera(),
    ),
  ).toThrow(/requires WebGPU/);
});

it("requires actual consumer installation evidence, rejecting missing wiring", async () => {
  const { assertExposureConsumer } = await import("./fixtures/auto-exposure/proof.js");
  const report = (text: string) => ({ observations: { console: [{ text }] } });
  expect(() =>
    assertExposureConsumer(report('TN_EXPOSURE_CONSUMER:{"installed":true,"owned":true}')),
  ).not.toThrow();
  expect(() => assertExposureConsumer(report("unrelated"))).toThrow(/one actual installation/);
  expect(() =>
    assertExposureConsumer(report('TN_EXPOSURE_CONSUMER:{"installed":true,"owned":false}')),
  ).toThrow(/actual graph/);
});

it("owns the direct base-colour graph without requiring an unrelated post stage", () => {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const worldPasses: unknown[] = [];
  const outputs: unknown[] = [];
  const clearOutputNode = vi.fn();
  const renderer = {
    kind: "webgpu",
    raw: {},
    clearOutputNode,
    setOutputNode(node: unknown, worldPass?: unknown) {
      outputs.push(node);
      worldPasses.push(worldPass);
      // traverse visits a node once per reference: exposure reads the colour twice (rgb, alpha).
      const seen = new Set<unknown>();
      (node as Node).traverse((candidate) => {
        if (Reflect.get(candidate, "isRTTNode") !== true || seen.has(candidate)) return;
        seen.add(candidate);
        const scratch = candidate as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        };
        releases.push(vi.spyOn(scratch.renderTarget, "dispose"));
        releases.push(vi.spyOn(scratch._quadMesh.material, "dispose"));
      });
    },
  };
  let suppliedPass: unknown;
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
    {
      baseColour(scenePass) {
        suppliedPass = scenePass;
        releases.push(vi.spyOn(scenePass, "dispose"));
        return scenePass.getTextureNode("output").mul(0.5);
      },
    },
  );
  expect(applied.stages).toEqual([]);
  expect(applied.dispose).toBeTypeOf("function");
  expect(worldPasses).toEqual([suppliedPass]);
  expect(releases).toHaveLength(3);
  applied.dispose?.();
  applied.dispose?.();
  expect(clearOutputNode).toHaveBeenCalledExactlyOnceWith(outputs[0]);
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

it("refuses a direct graph on an unsupported renderer without invoking its allocation factory", () => {
  const baseColour = vi.fn();
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgl2", raw: {} },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour },
  );
  expect(baseColour).not.toHaveBeenCalled();
  expect(applied.dropped).toEqual([{ name: "baseColour", reason: "renderer:webgl2" }]);
});

it("disposes a base-colour PassNode without mistaking its borrowed texture for an owned RTT", () => {
  let releasePass: ReturnType<typeof vi.fn> | undefined;
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgpu", raw: {}, setOutputNode: () => {}, clearOutputNode: () => {} },
    new Scene(),
    new PerspectiveCamera(),
    {
      baseColour(scenePass) {
        releasePass = vi.spyOn(scenePass, "dispose");
        return scenePass;
      },
    },
  );
  expect(() => applied.dispose?.()).not.toThrow();
  applied.dispose?.();
  expect(releasePass).toHaveBeenCalledTimes(1);
});

it.each(["texture", "rtt"])("leaves caller-owned %s resources alive", (kind) => {
  const supplied = kind === "rtt" ? rtt(vec4(0.2, 0.3, 0.4, 1)) : texture(new Texture());
  const release = vi.spyOn(supplied.value, "dispose");
  const borrowedRtt =
    Reflect.get(supplied, "isRTTNode") === true
      ? (supplied as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        })
      : undefined;
  const targetRelease =
    borrowedRtt === undefined ? undefined : vi.spyOn(borrowedRtt.renderTarget, "dispose");
  const materialRelease =
    borrowedRtt === undefined ? undefined : vi.spyOn(borrowedRtt._quadMesh.material, "dispose");
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgpu", raw: {}, setOutputNode: () => {}, clearOutputNode: () => {} },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour: () => supplied },
  );
  applied.dispose?.();
  applied.dispose?.();
  expect(release).not.toHaveBeenCalled();
  if (targetRelease !== undefined) expect(targetRelease).not.toHaveBeenCalled();
  if (materialRelease !== undefined) expect(materialRelease).not.toHaveBeenCalled();
  borrowedRtt?.renderTarget.dispose();
  borrowedRtt?._quadMesh.material.dispose();
  supplied.value.dispose();
});

it("releases the unique direct installation receipt rather than the legacy node identity", () => {
  const dispose = vi.fn();
  const clearOutputNode = vi.fn();
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    {
      kind: "webgpu",
      raw: {},
      clearOutputNode,
      setOutputNode: () => ({ isCurrent: () => true, dispose }),
    },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour: (scenePass) => scenePass },
  );
  applied.dispose?.();
  applied.dispose?.();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(clearOutputNode).not.toHaveBeenCalled();
});

it("admits default spatial stages and explicitly refuses unadapted graphs", () => {
  const handle = {
    active: false,
    retain: vi.fn(),
    release: vi.fn(),
    textureView: () => undefined,
    dispose: vi.fn(),
  };
  const optionsSeen: Parameters<NonNullable<OutputRenderer["createRenderChain"]>>[0][] = [];
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createResolutionSubrect: () => handle,
    createRenderChain(options) {
      optionsSeen.push(options);
      return { applied: { stages: [], dropped: [] }, dispose() {} };
    },
  };
  const graph = new WorldEnvironment({ gtaoEnabled: true, bloomEnabled: true }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  const options = optionsSeen[0];
  expect(options?.resolutionSubrect).toBe(handle);
  for (const name of ["ambientOcclusion", "bloom", "vignette", "antialias"])
    expect(options?.stages?.find((stage) => stage.name === name)?.supportsResolutionSubrect).toBe(
      true,
    );
  for (const name of ["ssgi", "ssr", "godRays", "sharpen"])
    expect(
      options?.stages?.find((stage) => stage.name === name)?.supportsResolutionSubrect,
    ).not.toBe(true);
  expect(handle.retain).toHaveBeenCalled();
  graph.dispose?.();
  expect(handle.dispose).toHaveBeenCalledOnce();
});

it.each([
  {
    name: "custom base colour",
    environment: new WorldEnvironment({ bloomEnabled: true }),
    target: { baseColour: (scenePass: ReturnType<typeof import("three/tsl").pass>) => scenePass },
    refusal: "baseColour",
  },
  {
    name: "automatic exposure",
    environment: new WorldEnvironment({ autoExposureEnabled: true, bloomEnabled: true }),
    target: undefined,
    refusal: "autoExposure",
  },
])("keeps the sub-rectangle fallback for $name", ({ environment, target, refusal }) => {
  const createResolutionSubrect = vi.fn(() => ({
    active: false,
    textureView: () => undefined,
    retain: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn(),
  }));
  const createRenderChain = vi.fn(
    (_options: Parameters<NonNullable<OutputRenderer["createRenderChain"]>>[0]) => ({
      applied: { stages: [], dropped: [] },
      dispose() {},
    }),
  );
  const report = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const renderer: OutputRenderer = {
      kind: "webgpu",
      raw: {},
      createRenderChain,
      createResolutionSubrect,
    };
    const applied = environment.apply(renderer, new Scene(), new PerspectiveCamera(), target);
    expect(createResolutionSubrect).not.toHaveBeenCalled();
    expect(createRenderChain.mock.calls[0]?.[0].resolutionSubrect).toBeUndefined();
    expect(report.mock.calls.some(([line]) => line.includes(refusal))).toBe(true);
    applied.dispose?.();
  } finally {
    report.mockRestore();
  }
});

it("retains every spatial intermediate target rather than only the scene pass", () => {
  const retain = vi.fn();
  const handle = {
    active: false,
    retain,
    release: vi.fn(),
    textureView: () => undefined,
    dispose: vi.fn(),
  };
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = () => {};
    },
  );
  let release: (() => void) | undefined;
  try {
    const renderer: OutputRenderer = {
      kind: "webgpu",
      raw: {},
      createResolutionSubrect: () => handle,
      createRenderChain(options) {
        let node = options.input;
        for (const name of ["ambientOcclusion", "bloom", "vignette", "antialias"]) {
          const stage = options.stages?.find((entry) => entry.name === name);
          if (!stage) throw new Error(`Missing ${name}`);
          node = stage.build(node, { tier: "high" });
        }
        const prepared = new Set<Node>();
        (node as Node).traverse((entry) => {
          if (entry instanceof BloomNode && !prepared.has(entry)) {
            prepared.add(entry);
            entry.setup({ getSharedContext: () => ({}) } as unknown as NodeBuilder);
          }
        });
        return { applied: { stages: [], dropped: [] }, dispose() {} };
      },
    };
    const graph = new WorldEnvironment({ gtaoEnabled: true, bloomEnabled: true }).apply(
      renderer,
      new Scene(),
      new PerspectiveCamera(),
    );
    release = graph.dispose;
    const targets = retain.mock.calls.flatMap(([, targets]) => targets as unknown[]);
    // Scene + GTAO + bloom input/11 mips + SMAA input/3 targets.
    expect(targets.length).toBeGreaterThanOrEqual(18);
    expect(new Set(targets).size).toBe(targets.length);
  } finally {
    release?.();
    vi.unstubAllGlobals();
  }
});

it("sets up stock bloom at the macOS starter window without outgrowing its reserved mips", () => {
  // The hosted macOS starter window is 1024x653, and the subrect runs at scale 1 there.
  const controller = new ResolutionSubrect();
  let effect: BloomNode | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createResolutionSubrect: () => controller,
    createRenderChain(options) {
      const stage = options.stages?.find((entry) => entry.name === "bloom");
      if (!stage) throw new Error("Missing bloom");
      const graph = stage.build(options.input, { tier: "high" }) as Node;
      graph.traverse((node) => {
        if (node instanceof BloomNode) effect ??= node;
      });
      return {
        applied: { stages: ["bloom"], dropped: [] },
        dispose() {},
      };
    },
  };
  const graph = new WorldEnvironment({ bloomEnabled: true, screenSpaceAA: "disabled" }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  try {
    if (!effect) throw new Error("Missing stock bloom");
    controller.activate(1);
    controller.setSize(1024, 653);
    expect(() =>
      effect?.setup({ getSharedContext: () => ({}) } as unknown as NodeBuilder),
    ).not.toThrow();
  } finally {
    graph.dispose?.();
  }
});

it("keeps lazy bloom mips valid at small viewports and releases retired bindings", () => {
  const controller = new ResolutionSubrect();
  let effect: BloomNode | undefined;
  let stageDispose: (() => void) | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createResolutionSubrect: () => controller,
    createRenderChain(options) {
      const stage = options.stages?.find((entry) => entry.name === "bloom");
      if (!stage) throw new Error("Missing bloom");
      const graph = stage.build(options.input, { tier: "high" }) as Node;
      graph.traverse((node) => {
        if (node instanceof BloomNode) effect ??= node;
      });
      stageDispose = stage.dispose;
      return {
        applied: { stages: ["bloom"], dropped: [] },
        dispose() {
          stageDispose?.();
        },
      };
    },
  };
  const graph = new WorldEnvironment({ bloomEnabled: true, screenSpaceAA: "disabled" }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  try {
    if (!effect) throw new Error("Missing stock bloom");
    controller.activate(0.23);
    controller.setSize(128, 64);
    expect(() =>
      effect?.setup({ getSharedContext: () => ({}) } as unknown as NodeBuilder),
    ).not.toThrow();
    const retained = effect as unknown as {
      _renderTargetBright: import("three").RenderTarget;
      _renderTargetsHorizontal: import("three").RenderTarget[];
      _renderTargetsVertical: import("three").RenderTarget[];
      _separableBlurMaterials: { invSize: { value: import("three").Vector2 } }[];
    };
    for (const target of retained._renderTargetsHorizontal) {
      expect(target.width).toBeGreaterThan(0);
      expect(target.height).toBeGreaterThan(0);
    }
    for (const material of retained._separableBlurMaterials)
      expect(material.invSize.value.toArray().every(Number.isFinite)).toBe(true);
    controller.setSize(960, 540);
    controller.setScale(0.72);
    expect(() => controller.setScale(1)).not.toThrow();
    const lastMip = retained._renderTargetsVertical.at(-1);
    expect(lastMip?.viewport.toArray().slice(2)).toEqual([30, 17]);
    expect([lastMip?.width, lastMip?.height]).toEqual([32, 24]);
    stageDispose?.();
    expect(controller.textureView(retained._renderTargetBright.texture)).toBeUndefined();
    const resize = vi.spyOn(retained._renderTargetBright, "setSize");
    controller.setScale(0.72);
    expect(resize).not.toHaveBeenCalled();
  } finally {
    graph.dispose?.();
  }
});

it("scales a fixed exposure into light only, never into the alpha the output transform divides by", () => {
  // RenderOutputNode unpremultiplies before tone mapping: an exposure that also scales alpha cancels
  // there and returns as a display-space multiply (cornell at 1/32 capped every pixel at 8/255).
  let input: unknown;
  new WorldEnvironment({ exposure: 0.25 }).apply(
    {
      kind: "webgpu",
      raw: {},
      createRenderChain(options) {
        input = options.input;
        return { applied: { stages: [], dropped: [] }, dispose() {} };
      },
    },
    new Scene(),
    new PerspectiveCamera(),
  );
  const seen = new Set<object>();
  const products: { aNode: unknown; bNode: unknown }[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const n = node as { isNode?: boolean; op?: string; aNode?: unknown; bNode?: unknown };
    if (n.isNode && n.op === "*") products.push(n as { aNode: unknown; bNode: unknown });
    for (const value of Object.values(node)) if (typeof value === "object") walk(value);
  };
  walk(input);
  // TSL wraps operands in VarNodes; the operand itself is the node they hold.
  const unwrap = (node: unknown): unknown => {
    let n = node as { isVarNode?: boolean; node?: unknown } | null;
    while (n?.isVarNode) n = n.node as typeof n;
    return n;
  };
  const isExposure = (node: unknown) => (unwrap(node) as { value?: unknown } | null)?.value === 0.25;
  const exposed = products.filter((p) => isExposure(p.aNode) || isExposure(p.bNode));
  expect(exposed).toHaveLength(1);
  const [product] = exposed as [{ aNode: unknown; bNode: unknown }];
  const light = isExposure(product.bNode) ? product.aNode : product.bNode;
  // `.rgb`, which TSL stores as the xyz swizzle: the alpha lane never sees the exposure.
  expect((unwrap(light) as { components?: string }).components).toBe("xyz");
});
