import { describe, expect, it, vi } from "vitest";
import {
  type IRenderChainStage,
  RENDER_CHAIN_STAGE_ORDER,
  RenderChain,
  readRenderChainObservation,
} from "../src/render/chain.js";
import type { IRenderOutputOptions, IRendererLike } from "../src/renderer.js";

function renderer(
  kind: IRendererLike["kind"],
): IRendererLike & { installed: unknown[]; velocityEnabled: { value: boolean } } {
  const installed: unknown[] = [];
  const velocityEnabled = { value: false };
  return {
    clearOutputNode: () => undefined,
    compileAsync: async () => undefined,
    compute: () => undefined,
    dispose: () => undefined,
    domElement: {} as HTMLCanvasElement,
    get info() {
      return {};
    },
    gpuFrameMs: () => undefined,
    installed,
    kind,
    raw: { mrt: new Set<string>() },
    readback: async () => new ArrayBuffer(0),
    render: () => undefined,
    renderOverlay: () => undefined,
    setRenderChainVelocityEnabled: (enabled) => {
      velocityEnabled.value = enabled;
    },
    resolveGpuFrame: () => undefined,
    setOutputNode: (node) => installed.push(node),
    setResolutionScale: () => undefined,
    setSize: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned",
    }),
    velocityEnabled,
  };
}

function stage(name: IRenderChainStage["name"], order: string[]): IRenderChainStage {
  return {
    build: (input) => {
      order.push(name);
      return { input, name };
    },
    name,
  };
}

describe("RenderChain", () => {
  it("drops a stage that cannot run and emits an honest marker", () => {
    const report: string[] = [];
    const chain = new RenderChain(renderer("webgl2"), {
      report: (line) => report.push(line),
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "high" },
    });

    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped).toEqual([{ name: "ssgi", reason: "renderer:webgl2" }]);
    expect(report[0]).toMatch(/^TN_RENDER_CHAIN:/u);
  });

  it("uses canonical order and reports the velocity provisioning route", () => {
    const order: string[] = [];
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const chain = new RenderChain(current, {
      stages: [stage("traa", order), stage("denoise", order), stage("ssgi", order)],
      request: { stages: ["traa", "ssgi", "denoise"], tier: "high" },
    });

    expect(order).toEqual(["ssgi", "denoise", "traa"]);
    expect(chain.applied.velocity).toMatchObject({ provisioned: true, source: "mrt" });
    expect(current.installed).toHaveLength(1);
  });

  it("accepts an authored outline stage anchored after bloom", () => {
    const order: string[] = [];
    const current = renderer("webgpu");
    const chain = new RenderChain(current, {
      stages: [
        { ...stage("bloom", order), name: "bloom" },
        {
          ...stage("outline", order),
          after: "bloom",
          name: "outline",
        },
        stage("ssgi", order),
      ],
      request: { stages: ["outline", "bloom", "ssgi"], tier: "high" },
    });

    expect(order).toEqual(["ssgi", "bloom", "outline"]);
    expect(chain.applied.stages).toEqual(["ssgi", "bloom", "outline"]);
  });

  it("preserves supplied order for authored siblings on one anchor", () => {
    const order: string[] = [];
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [
        stage("bloom", order),
        { ...stage("paint", order), after: "bloom" },
        { ...stage("ink", order), after: "bloom" },
      ],
      request: { stages: ["ink", "paint", "bloom"], tier: "high" },
    });

    expect(order).toEqual(["bloom", "paint", "ink"]);
    expect(chain.applied.stages).toEqual(["bloom", "paint", "ink"]);
  });

  it("reports whether each applied stage changed the graph output", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      input: { name: "scene" },
      stages: [
        { ...stage("bloom", []), build: (input) => input },
        { ...stage("outline", []), after: "bloom" },
      ],
      request: { stages: ["outline", "bloom"], tier: "high" },
    });

    expect(chain.applied.contributions).toEqual([
      { graphOutputChanged: false, name: "bloom" },
      { graphOutputChanged: true, name: "outline" },
    ]);
  });

  it("rejects malformed authored graphs before installing an output", () => {
    const cases: Array<{ message: RegExp; stages: IRenderChainStage[] }> = [
      {
        message: /non-blank/u,
        stages: [{ ...stage("  ", []), name: "  " }],
      },
      {
        message: /duplicate/u,
        stages: [stage("bloom", []), stage("bloom", [])],
      },
      {
        message: /anchor.*missing/u,
        stages: [{ ...stage("outline", []), after: "not-supplied" }],
      },
      {
        message: /exactly one/u,
        stages: [{ ...stage("outline", []), after: "bloom", before: "ssgi" }],
      },
      {
        message: /cycle.*ink.*paint.*ink/u,
        stages: [
          { ...stage("ink", []), after: "paint" },
          { ...stage("paint", []), after: "ink" },
        ],
      },
    ];

    for (const { message, stages } of cases) {
      const current = renderer("webgpu");
      const setOutputNode = vi.spyOn(current, "setOutputNode");
      expect(
        () =>
          new RenderChain(current, {
            stages,
            request: { stages: stages.map(({ name }) => name), tier: "high" },
          }),
      ).toThrow(message);
      expect(setOutputNode).not.toHaveBeenCalled();
    }
  });

  it("rejects a requested stage without a supplied definition", () => {
    const current = renderer("webgpu");
    const setOutputNode = vi.spyOn(current, "setOutputNode");

    expect(
      () =>
        new RenderChain(current, {
          request: { stages: ["outline"], tier: "high" },
        }),
    ).toThrow(/no supplied definition/u);
    expect(setOutputNode).not.toHaveBeenCalled();
  });

  it("reports a requested built-in whose provider is missing", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      request: { stages: ["traa"], tier: "off" },
    });

    expect(chain.applied.requested).toEqual(["traa"]);
    expect(chain.applied.dropped).toEqual([{ name: "traa", reason: "tier:off" }]);
  });

  it("disposes active authored stages exactly once across rebuilds", () => {
    const dispose = vi.fn();
    const current = renderer("webgpu");
    const chain = new RenderChain(current, {
      stages: [{ ...stage("outline", []), after: "bloom", dispose }, stage("bloom", [])],
      request: { stages: ["outline", "bloom"], tier: "high" },
    });

    expect(dispose).not.toHaveBeenCalled();
    chain.apply();
    expect(dispose).toHaveBeenCalledTimes(1);
    chain.dispose();
    chain.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("places probe-volume irradiance before screen-space GI", () => {
    const order: string[] = [];
    const current = renderer("webgpu");
    const chain = new RenderChain(current, {
      stages: [stage("ssgi", order), stage("probeVolume", order)],
      request: { stages: ["ssgi", "probeVolume"], tier: "high" },
    });

    expect(order).toEqual(["probeVolume", "ssgi"]);
    expect(chain.applied.stages).toEqual(["probeVolume", "ssgi"]);
  });

  it("passes the authored world pass through the renderer seam", () => {
    const current = renderer("webgpu");
    const worldPass = {
      getMRT: () => null,
      getTextureNode: () => ({}) as never,
      setMRT: () => undefined,
    };
    const input = { node: "world" };
    const setOutputNode = vi.spyOn(current, "setOutputNode");

    new RenderChain(current, {
      input,
      worldPass,
      request: { stages: ["bloom"], tier: "high" },
      stages: [stage("bloom", [])],
    });

    expect(setOutputNode).toHaveBeenCalledWith({ input, name: "bloom" }, worldPass);
  });

  it("places godRays between ssgi and ssr, and vignette after bloom, whatever was requested", () => {
    // GodRays add scattered light after the GI/contact terms and before reflections;
    // vignette is a camera-lens darkening applied to the lit frame before the other
    // camera stages. The caller cannot get the order wrong because the order is not
    // theirs to choose.
    const order: string[] = [];
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [
        stage("vignette", order),
        stage("bloom", order),
        stage("godRays", order),
        stage("ssr", order),
        stage("ssgi", order),
      ],
      request: { stages: ["vignette", "bloom", "godRays", "ssr", "ssgi"], tier: "high" },
    });

    expect(order).toEqual(["ssgi", "godRays", "ssr", "bloom", "vignette"]);
    expect(chain.applied.stages).toEqual(["ssgi", "godRays", "ssr", "bloom", "vignette"]);
  });

  it("drops a temporal stage when no velocity source is provisioned", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high" },
    });

    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped[0]?.reason).toBe("velocity:missing");
    expect(chain.applied.velocity).toMatchObject({ provisioned: false, source: null });
  });

  it("turns core-owned per-object history on only for an active temporal stage", () => {
    const current = renderer("webgpu");
    const chain = new RenderChain(current, {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high", velocity: { perObject: true } },
    });

    expect(chain.applied.stages).toEqual(["traa"]);
    expect(current.velocityEnabled.value).toBe(true);
    chain.dispose();
    expect(current.velocityEnabled.value).toBe(false);
  });

  it("reports measured temporal input/output sizes after a frame and updates them on resize", () => {
    const current = renderer("webgpu");
    const temporal = {
      active: false,
      inputWidth: 0,
      inputHeight: 0,
      outputWidth: 0,
      outputHeight: 0,
    };
    Object.assign(current, { raw: { mrt: new Set(["velocity"]), info: { engine: { temporal } } } });
    const report: string[] = [];
    const chain = new RenderChain(current, {
      report: (line) => report.push(line),
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "medium", velocity: { source: "mrt" } },
    });
    chain.observeFrame();
    expect(chain.applied).not.toHaveProperty("stageSizes");
    Object.assign(temporal, {
      active: true,
      inputWidth: 1280,
      inputHeight: 720,
      outputWidth: 1920,
      outputHeight: 1080,
    });
    chain.observeFrame();
    expect(readRenderChainObservation(current)).toMatchObject({
      stageSizes: { traa: { input: [1280, 720], output: [1920, 1080] } },
    });
    expect(
      JSON.parse(report.at(-1)?.slice("TN_RENDER_CHAIN:".length) ?? "{}").applied,
    ).toMatchObject({
      stageSizes: { traa: { input: [1280, 720], output: [1920, 1080] } },
    });
    const count = report.length;
    chain.observeFrame();
    expect(report).toHaveLength(count);
    temporal.inputWidth = 1382;
    temporal.inputHeight = 778;
    chain.observeFrame();
    expect(chain.applied).toMatchObject({
      stageSizes: { traa: { input: [1382, 778], output: [1920, 1080] } },
    });
    temporal.active = false;
    chain.observeFrame();
    expect(chain.applied).not.toHaveProperty("stageSizes");
  });

  it("samples temporal rejection only after a completed frame", () => {
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const rejectionMask = new Uint8Array(25);
    rejectionMask.set([1, 1, 1]);
    const chain = new RenderChain(current, {
      stages: [
        {
          ...stage("traa", []),
          readVelocityResult: () => ({ frame: 7, rejectionMask }),
        },
      ],
      request: {
        stages: ["traa"],
        tier: "high",
        velocity: { source: "mrt" },
      },
    });

    expect(chain.applied.velocity.rejectionFraction).toBeUndefined();
    chain.observeFrame();
    expect(chain.applied.velocity).toMatchObject({
      measurementFrame: 7,
      rejectionFraction: 0.12,
    });
  });

  it("preserves a temporal result reader when a later velocity stage has none", () => {
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const temporalNode = { name: "traa" };
    const blurNode = { name: "motionBlur" };
    const rejectionMask = new Uint8Array([0, 1, 0, 0]);
    const readVelocityResult = vi.fn((node: unknown) => {
      expect(node).toBe(temporalNode);
      return { frame: 7, rejectionMask };
    });
    const chain = new RenderChain(current, {
      stages: [
        {
          build: () => temporalNode,
          name: "traa",
          readVelocityResult,
        },
        {
          build: () => blurNode,
          name: "motionBlur",
        },
      ],
      request: { stages: ["traa", "motionBlur"], tier: "high", velocity: { source: "mrt" } },
    });

    chain.observeFrame();

    expect(readVelocityResult).toHaveBeenCalledTimes(1);
    expect(chain.applied.velocity).toMatchObject({
      measurementFrame: 7,
      rejectionFraction: 0.25,
    });
  });

  it("rejects a repeated temporal rejection measurement as stale", () => {
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const result = { frame: 2, rejectionMask: new Uint8Array([0, 1, 0, 0]) };
    const chain = new RenderChain(current, {
      stages: [
        {
          ...stage("traa", []),
          readVelocityResult: () => result,
        },
      ],
      request: {
        stages: ["traa"],
        tier: "high",
        velocity: { source: "mrt" },
      },
    });

    chain.observeFrame();
    expect(() => chain.observeFrame()).toThrow(/must advance/u);
  });

  it("uses the compatibility rejection callback when the active stage has no fresh result", () => {
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const callback = vi.fn(() => ({ frame: 11, rejectionFraction: 0.2 }));
    const chain = new RenderChain(current, {
      stages: [stage("traa", [])],
      request: {
        stages: ["traa"],
        tier: "high",
        velocity: { source: "mrt", rejectionMeasurement: callback },
      },
    });

    chain.observeFrame();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(chain.applied.velocity).toMatchObject({
      measurementFrame: 11,
      rejectionFraction: 0.2,
    });
    expect(() => chain.observeFrame()).toThrow(/must advance/u);
  });

  it.each(["auto", "high"] as const)(
    "keeps %s stages alive during compilation and resumes only on consecutive clean windows",
    (tier) => {
      const dispose = vi.fn();
      const chain = new RenderChain(renderer("webgpu"), {
        report: () => {},
        stages: [{ ...stage("ssgi", []), dispose }],
        request: { stages: ["ssgi"], tier },
        targetFps: 60,
      });
      const clean = { phases: { render: { p95: 30 } } };
      const compiling = { ...clean, surface: { compiling: true } };
      chain.observeFrameBudget(compiling);
      chain.observeFrameBudget(compiling);
      expect(chain.applied.tier).toBe("high");
      expect(chain.applied.stages).toEqual(["ssgi"]);
      expect(dispose).not.toHaveBeenCalled();

      chain.observeFrameBudget(clean);
      chain.observeFrameBudget(compiling);
      chain.observeFrameBudget(clean);
      expect(chain.applied.tier).toBe("high");
      expect(dispose).not.toHaveBeenCalled();
      chain.observeFrameBudget(clean);
      expect(chain.applied.tier).toBe(tier === "auto" ? "medium" : "high");
      expect(dispose).toHaveBeenCalledTimes(tier === "auto" ? 1 : 0);
    },
  );

  it("rejects malformed compilation observations for an automatic tier", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      report: () => {},
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "auto" },
    });
    expect(() =>
      chain.observeFrameBudget({
        phases: { render: { p95: 30 } },
        surface: { compiling: "true" as unknown as boolean },
      }),
    ).toThrow("compiling must be a boolean");
  });

  it("steps down an automatic tier after an over-budget window but never moves a pinned tier", () => {
    const automatic = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "auto" },
      targetFps: 60,
    });
    automatic.observeFrameBudget({ phases: { render: { p95: 30 } } });
    automatic.observeFrameBudget({ phases: { render: { p95: 30 } } });
    expect(automatic.applied.tier).toBe("medium");
    expect(automatic.applied.source).toBe("auto");

    const pinned = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "high" },
      targetFps: 60,
    });
    pinned.observeFrameBudget({ phases: { render: { p95: 30 } } });
    pinned.observeFrameBudget({ phases: { render: { p95: 30 } } });
    expect(pinned.applied.tier).toBe("high");
    expect(pinned.applied.source).toBe("pinned");
  });

  it("rejects unknown stages and malformed quality", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          request: { stages: ["not-a-stage"] },
        }),
    ).toThrow(/unknown render-chain stage/u);
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          request: { stages: [], tier: "ultra" as never },
        }),
    ).toThrow(/tier/u);
  });

  /**
   * The browser bridge reads this report from `dist/playtest.js`, which `tsup` emits as its own
   * entry with its own copy of this module — so a module-scoped map is written by one copy and
   * read by another, and every `renderChain` assertion fails closed as UNOBSERVABLE while the
   * chain is installed and printing its marker. Two `import()`s across `vi.resetModules()` are
   * that pair of copies.
   */
  it("publishes its report where a second copy of this module can read it", async () => {
    const current = renderer("webgpu");
    vi.resetModules();
    const first = await import("../src/render/chain.js");
    new first.RenderChain(current as never, {
      input: { node: "scene" },
      report: () => undefined,
      request: { stages: ["bloom"] },
      stages: [{ build: (input) => ({ bloomed: input }), name: "bloom" }],
    });
    vi.resetModules();
    const second = await import("../src/render/chain.js");

    expect(second.readRenderChainObservation(current)?.tier).toBe("high");
    expect(second.readRenderChainObservation(current)?.stages).toEqual(["bloom"]);
  });

  it("accepts an empty request as a no-op", () => {
    const current = renderer("webgpu");
    const marker = vi.fn();
    const chain = new RenderChain(current, { report: marker });

    expect(chain.applied.stages).toEqual([]);
    expect(current.installed).toEqual([]);
    expect(marker).not.toHaveBeenCalled();
  });

  it("reads no report from a non-object renderer", () => {
    expect(readRenderChainObservation(null)).toBeUndefined();
    expect(readRenderChainObservation(42)).toBeUndefined();
    expect(readRenderChainObservation("webgpu")).toBeUndefined();
  });

  it("rejects apply and observation calls after dispose", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [stage("bloom", [])],
      request: { stages: ["bloom"], tier: "high" },
    });
    chain.dispose();

    expect(chain.disposed).toBe(true);
    expect(() => chain.apply()).toThrow(/after dispose/u);
    expect(() => chain.observeFrame()).toThrow(/after dispose/u);
    expect(() => chain.observeFrameBudget({ phases: { render: { p95: 1 } } })).toThrow(
      /after dispose/u,
    );
  });

  it("drops stages below their minimum tier, unavailable stages, and named reasons", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [
        { ...stage("ssgi", []), minimumTier: "high" },
        { ...stage("denoise", []), available: () => false },
        { ...stage("bloom", []), available: () => "gpu:missing" },
      ],
      request: { stages: ["ssgi", "denoise", "bloom"], tier: "low" },
    });

    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped).toEqual([
      { name: "ssgi", reason: "tier:low" },
      { name: "denoise", reason: "unavailable:webgpu" },
      { name: "bloom", reason: "gpu:missing" },
    ]);
  });

  it("reports a stage that returns no node as a build drop and disposes it", () => {
    const dispose = vi.fn();
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [{ ...stage("bloom", []), build: () => null, dispose }],
      request: { stages: ["bloom"], tier: "high" },
    });

    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped).toEqual([
      { name: "bloom", reason: "build:stage returned no node" },
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error build failure into the drop reason", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [
        {
          ...stage("bloom", []),
          build: () => {
            throw "boom-string";
          },
        },
      ],
      request: { stages: ["bloom"], tier: "high" },
    });

    expect(chain.applied.dropped).toEqual([{ name: "bloom", reason: "build:boom-string" }]);
  });

  it("reports an install failure and releases the built stages", () => {
    const dispose = vi.fn();
    const clearOutputNode = vi.fn();
    const current = renderer("webgpu");
    current.setOutputNode = () => {
      throw new Error("install-nope");
    };
    current.clearOutputNode = clearOutputNode;
    const chain = new RenderChain(current, {
      stages: [{ ...stage("bloom", []), dispose }],
      request: { stages: ["bloom"], tier: "high" },
    });

    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped).toEqual([{ name: "bloom", reason: "install:install-nope" }]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(clearOutputNode).toHaveBeenCalledTimes(1);
  });

  it("returns the applied report without measuring when no velocity stage is active", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [stage("bloom", [])],
      request: { stages: ["bloom"], tier: "high" },
    });

    expect(chain.observeFrame()).toBe(chain.applied);
    expect(chain.applied.velocity.measurementFrame).toBeUndefined();
  });

  it("leaves the velocity report unmeasured without a reader or callback", () => {
    const current = renderer("webgpu");
    Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
    const chain = new RenderChain(current, {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high", velocity: { source: "mrt" } },
    });

    chain.observeFrame();

    expect(chain.applied.velocity.provisioned).toBe(true);
    expect(chain.applied.velocity.measurementFrame).toBeUndefined();
    expect(chain.applied.velocity.rejectionFraction).toBeUndefined();
  });

  it("keeps a pinned tier across budget windows and resets the auto counter on clean ones", () => {
    const pinned = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "high" },
    });
    expect(pinned.observeFrameBudget({ phases: { render: { p95: 30 } } })).toBe("high");

    const automatic = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "auto" },
      targetFps: 60,
    });
    expect(automatic.observeFrameBudget({ phases: { render: { p95: 1 } } })).toBe("high");
    expect(automatic.applied.tier).toBe("high");
  });

  it("rejects a malformed render p95 for an automatic tier", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "auto" },
    });

    expect(() => chain.observeFrameBudget({ phases: { render: { p95: Number.NaN } } })).toThrow(
      /finite non-negative/u,
    );
    expect(() => chain.observeFrameBudget({ phases: { render: { p95: -1 } } })).toThrow(
      /finite non-negative/u,
    );
  });

  // NOTE: owned-velocity-pass restore (#restoreOwnedVelocityOutput setMRT, velocityTexture /
  // withVelocityContext) needs a real TSL scene pass and is renderer-only; skipped on CPU.

  it("rejects a stage without a build function", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          stages: [{ name: "bloom" } as unknown as IRenderChainStage],
          request: { stages: ["bloom"], tier: "high" },
        }),
    ).toThrow(/needs a build function/u);
  });

  it("rejects an anchor constraint on a built-in stage", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          stages: [{ ...stage("ssgi", []), before: "bloom" }],
          request: { stages: ["ssgi"], tier: "high" },
        }),
    ).toThrow(/cannot declare before or after/u);
  });

  it("rejects a blank before anchor on an authored stage", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          stages: [{ ...stage("ink", []), before: "  " }],
          request: { stages: ["ink"], tier: "high" },
        }),
    ).toThrow(/non-blank/u);
  });

  it("rejects a duplicated requested stage", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          stages: [stage("bloom", [])],
          request: { stages: ["bloom", "bloom"], tier: "high" },
        }),
    ).toThrow(/duplicate requested/u);
  });

  it("provisions mrt velocity from a getMRT renderer and reports a throwing one as absent", () => {
    const withMrt = renderer("webgpu");
    Object.assign(withMrt, { raw: { getMRT: () => new Set(["velocity"]) } });
    const provisioned = new RenderChain(withMrt, {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high" },
    });
    expect(provisioned.applied.velocity).toMatchObject({ provisioned: true, source: "mrt" });

    const throwing = renderer("webgpu");
    Object.assign(throwing, {
      raw: {
        getMRT: () => {
          throw new Error("mrt-nope");
        },
      },
    });
    const absent = new RenderChain(throwing, {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high" },
    });
    expect(absent.applied.stages).toEqual([]);
    expect(absent.applied.dropped).toEqual([{ name: "traa", reason: "velocity:missing" }]);
  });

  it("reads velocity from an array mrt output and per-object scene flags", () => {
    const arrayMrt = renderer("webgpu");
    Object.assign(arrayMrt, { raw: { mrt: ["velocity"] } });
    const fromArray = new RenderChain(arrayMrt, {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high" },
    });
    expect(fromArray.applied.velocity).toMatchObject({ provisioned: true, source: "mrt" });

    const fromFlags = new RenderChain(renderer("webgpu"), {
      stages: [stage("traa", [])],
      request: { stages: ["traa"], tier: "high" },
      scene: {
        traverse: (callback) => callback({ userData: { useVelocity: true } }),
      },
    });
    expect(fromFlags.applied.velocity).toMatchObject({ provisioned: true, source: "per-object" });
  });

  it("rejects malformed velocity results and compatibility measurements", () => {
    const temporal = (result: unknown, rejectionMeasurement?: () => unknown) => {
      const current = renderer("webgpu");
      Object.assign(current, { raw: { mrt: new Set(["velocity"]) } });
      return new RenderChain(current, {
        stages: [{ ...stage("traa", []), readVelocityResult: () => result as never }],
        request: {
          stages: ["traa"],
          tier: "high",
          velocity: { source: "mrt", rejectionMeasurement: rejectionMeasurement as never },
        },
      });
    };

    expect(() =>
      temporal({ frame: -1, rejectionMask: new Uint8Array([0]) }).observeFrame(),
    ).toThrow(/non-negative integer/u);
    expect(() => temporal({ frame: 1, rejectionMask: new Uint8Array(0) }).observeFrame()).toThrow(
      /at least one pixel/u,
    );
    expect(() =>
      temporal({ frame: 1, rejectionMask: new Uint8Array([0, 2]) }).observeFrame(),
    ).toThrow(/must be 0 or 1/u);
    expect(() => temporal(undefined, () => 42).observeFrame()).toThrow(/must return an object/u);
    expect(() =>
      temporal(undefined, () => ({ frame: -1, rejectionFraction: 0.5 })).observeFrame(),
    ).toThrow(/non-negative integer/u);
    expect(() =>
      temporal(undefined, () => ({ frame: 1, rejectionFraction: 2 })).observeFrame(),
    ).toThrow(/between 0 and 1/u);
  });

  it("steps an automatic tier to off across sustained over-budget windows", () => {
    const chain = new RenderChain(renderer("webgpu"), {
      stages: [stage("ssgi", [])],
      request: { stages: ["ssgi"], tier: "auto" },
      targetFps: 60,
      dwellWindows: 1,
    });
    const over = { phases: { render: { p95: 30 } } };

    expect(chain.observeFrameBudget(over)).toBe("medium");
    expect(chain.observeFrameBudget(over)).toBe("low");
    expect(chain.observeFrameBudget(over)).toBe("off");
    expect(chain.observeFrameBudget(over)).toBe("off");
    expect(chain.applied.stages).toEqual([]);
  });

  it("rejects non-positive dwellWindows and targetFps", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          dwellWindows: 0,
          stages: [stage("bloom", [])],
          request: { stages: ["bloom"], tier: "high" },
        }),
    ).toThrow(/dwellWindows must be a positive integer/u);
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          targetFps: -1,
          stages: [stage("bloom", [])],
          request: { stages: ["bloom"], tier: "high" },
        }),
    ).toThrow(/targetFps must be a finite positive number/u);
  });
  // PRD-492: a colour grade is a display-referred effect, so it needs a place after the tone
  // curve and the sRGB encode. The chain owns where the transform happens and the renderer's
  // `outputColorTransform` owns whether it applies automatically; the stage owns only its look.
  it("runs an after-output-transform stage last and hands the renderer the transform to apply", () => {
    const order: string[] = [];
    const installed: { node: unknown; outputColorTransform: unknown }[] = [];
    const current = renderer("webgpu");
    const chain = new RenderChain(
      {
        ...current,
        setOutputNode: (node: unknown, _worldPass: unknown, options?: IRenderOutputOptions) => {
          installed.push({ node, outputColorTransform: options?.outputColorTransform });
        },
      } as unknown as IRendererLike,
      {
        input: { colour: true },
        stages: [
          {
            afterOutputTransform: true,
            build: (input) => {
              order.push("grade");
              return { input, name: "grade" };
            },
            name: "grade",
          },
          {
            build: (input) => {
              order.push("bloom");
              return { input, name: "bloom" };
            },
            name: "bloom",
          },
        ],
        request: { stages: ["bloom", "grade"], tier: "high" },
      },
    );

    expect(chain.applied.stages).toEqual(["bloom", "grade"]);
    expect(order).toEqual(["bloom", "grade"]);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.outputColorTransform).toBe(false);
  });

  it("leaves the automatic transform on when no after-output-transform stage actually ran", () => {
    const installed: (boolean | undefined)[] = [];
    const current = renderer("webgpu");
    const chain = new RenderChain(
      {
        ...current,
        setOutputNode: (_node: unknown, _worldPass: unknown, options?: IRenderOutputOptions) => {
          installed.push(options?.outputColorTransform);
        },
      } as unknown as IRendererLike,
      {
        input: { colour: true },
        stages: [
          {
            afterOutputTransform: true,
            available: () => "lut:pending",
            build: (input) => ({ input, name: "grade" }),
            name: "grade",
          },
          { build: (input) => ({ input, name: "bloom" }), name: "bloom" },
        ],
        request: { stages: ["bloom", "grade"], tier: "high" },
      },
    );

    // The grade was refused, so nothing applied the transform itself and the frame would have
    // reached the display un-tone-mapped. That is the failure this flag exists to prevent.
    expect(chain.applied.stages).toEqual(["bloom"]);
    expect(chain.applied.dropped).toEqual([{ name: "grade", reason: "lut:pending" }]);
    // Undefined is the renderer keeping its own transform, which is what an untaken
    // output transform must leave alone.
    expect(installed).toEqual([undefined]);
  });

  it("rejects an after-output-transform stage that also declares an anchor", () => {
    expect(
      () =>
        new RenderChain(renderer("webgpu"), {
          stages: [
            { after: "bloom", afterOutputTransform: true, build: (input) => input, name: "grade" },
            stage("bloom", []),
          ],
          request: { stages: ["bloom", "grade"], tier: "high" },
        }),
    ).toThrow(/afterOutputTransform/u);
  });
});

describe("subrect stage admission", () => {
  it.each(RENDER_CHAIN_STAGE_ORDER)("requires explicit sampling support for %s", (name) => {
    for (const supported of [false, true]) {
      const adapter = renderer("webgpu");
      const install = vi.fn();
      adapter.setOutputNode = install;
      const handle = {} as import("../src/render/resolution-subrect.js").ResolutionSubrect;
      const report = vi.fn();
      const chain = new RenderChain({
        renderer: adapter,
        input: {},
        resolutionSubrect: handle,
        report,
        request: { stages: [name], tier: "high" },
        stages: [
          {
            name,
            requiresVelocity: false,
            supportsResolutionSubrect: supported,
            build: (input) => input,
          },
        ],
      });
      expect(install.mock.calls[0]?.[2]?.resolutionSubrect).toBe(supported ? handle : undefined);
      expect(
        report.mock.calls.some(
          ([line]) =>
            line.includes("TN_RESOLUTION_SUBRECT") &&
            line.includes(supported ? "applied" : "refused") &&
            line.includes(name),
        ),
      ).toBe(true);
      chain.dispose();
    }
  });
});
