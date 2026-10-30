/**
 * The Wasm engine's WebGPURenderer over a recording host module (Midway cockpit): `antialias` and
 * `samples` reach the engine. The renderer ignored both, the surface stayed single-sampled, and
 * thin geometry (a canopy rivet bow, a trailing edge) stair-stepped where the three.js build was 4x MSAA.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  TSL_NODE,
  defineBrowserClasses,
  engineRef,
} from "../src/browser-backend.js";
import {
  PIPELINE_POST,
  WEB_HOST_ABI,
  type WebEngineModule,
  defineWebRenderer,
} from "../src/browser-renderer.js";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";
import { debugTelemetry } from "../src/debug-telemetry.js";
import { defineQuadMesh } from "../src/quad-mesh.js";
import { defineRendererUtils } from "../src/renderer-utils.js";

const REPO = process.cwd();
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

function host(
  frame: (field: number) => number = () => 0,
  render: (...args: number[]) => number = () => 0,
  secondary?: Parameters<typeof defineWebRenderer>[4],
  renderTarget: (...args: number[]) => number = () => 0,
  before?: Parameters<typeof defineWebRenderer>[2],
  tsl?: ITslRuntime,
  poll: () => number = () => 1,
  debugWords?: Uint32Array,
) {
  const types = new Map<string, number>();
  const runtime: IBrowserRuntime = {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: (name) => ({ key: `${String(types.get(name) ?? 1)}:0:1:1`, type: 1 }),
    invoke: () => null,
    get: (_self, path) =>
      path === "__hierarchy"
        ? 0
        : path === "__engineCounters"
          ? "gpuTimestampUnrequestedSamples@8"
          : undefined,
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
    ...(debugWords === undefined
      ? {}
      : { readWord: (address: number) => debugWords[address / 4] ?? 0 }),
  };
  const { classes, counters } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
  const state = vi.fn((..._args: number[]) => 0);
  const initCalls = vi.fn((..._args: unknown[]) => 0);
  let next = 16;
  const module = {
    HEAPU8: new Uint8Array(256),
    specialHTMLTargets: {},
    lengthBytesUTF8: (text: string) => text.length,
    stringToUTF8: () => undefined,
    UTF8ToString: () => "",
    _malloc: () => {
      next += 64;
      return next;
    },
    _free: () => undefined,
    _tnw_web_init: initCalls,
    _tnw_web_host_abi: () => WEB_HOST_ABI,
    _tnw_web_poll: poll,
    _tnw_web_adapter: () => 0,
    _tnw_web_error: () => 0,
    _tnw_web_resize: () => 0,
    _tnw_web_render: render,
    _tnw_web_render_target: renderTarget,
    _tnw_web_frame: frame,
    _tnw_web_renderer_state: state,
  } as unknown as WebEngineModule;
  const Renderer = defineWebRenderer(module, classes.Color as never, before, tsl, secondary);
  const canvas = { width: 300, height: 150, style: {}, setAttribute: () => undefined };
  const scene = new (classes.Scene as new () => object)();
  const camera = new (classes.PerspectiveCamera as new () => object)();
  return { Renderer, canvas, scene, camera, state, classes, initCalls, module, counters };
}

async function drawn(parameters: Record<string, unknown>) {
  const { Renderer, canvas, scene, camera, state } = host();
  const renderer = new Renderer({ canvas, ...parameters }) as {
    samples: number;
    init(): Promise<unknown>;
    render(scene: unknown, camera: unknown): void;
  };
  await renderer.init();
  renderer.render(scene, camera);
  return { samples: renderer.samples, handed: state.mock.calls.at(-1)?.[5] };
}

describe("the owned engine's CPU stage totals (PRD-771)", () => {
  const fieldsOf = (calls: number[]) => (field: number) => {
    calls.push(field);
    return field === 78 ? 64 : 0;
  };

  it("reads them in place from the host's array, so a steady frame pays no host call for them", async () => {
    const asked: number[] = [];
    const { Renderer, canvas, scene, camera, module } = host(fieldsOf(asked));
    const heap = new Float64Array(32);
    Reflect.set(module, "HEAPF64", heap);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      info: { engine: { cpuMs: Record<string, number> } };
    };
    await renderer.init();
    // Fifteen doubles at address 64, in the order of CPU_STAGE_FIELDS: pages, plan, shadow lists, prepare, encode, post,
    // then the scene half and the host's render, compute, submit, poll and tail, then `Renderer::render` itself, the whole database call and the render targets.
    heap.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 8);
    renderer.render(scene, camera);
    expect(renderer.info.engine.cpuMs).toEqual({
      cpuVirtualPagesMs: 1,
      cpuPlanMs: 2,
      cpuShadowBuildMs: 3,
      cpuPrepareMs: 4,
      cpuEncodeMs: 5,
      cpuPostMs: 6,
      cpuSceneMs: 7,
      hostRenderMs: 8,
      hostComputeMs: 9,
      hostSubmitMs: 10,
      hostPollMs: 11,
      hostTailMs: 12,
      rendererMs: 13,
      hostDatabaseMs: 14,
      hostTargetMs: 15,
    });
    // 71-72 are startup reads and 85 the per-frame shadow split (PRD-770); none is a stage total.
    expect(
      asked.filter((field) => field >= 66 && field !== 71 && field !== 72 && field !== 85),
    ).toEqual([78]);
  });

  it("publishes no totals on a module without the array, so core reads them as unmeasured", async () => {
    const { Renderer, canvas, scene, camera } = host(() => 0);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      info: { engine: { cpuMs?: unknown; work?: unknown } };
    };
    await renderer.init();
    renderer.render(scene, camera);
    expect(renderer.info.engine.cpuMs).toBeUndefined();
    expect(renderer.info.engine.work).toBeUndefined();
  });

  it("stops reading them, and tells the engine, when the meters are turned off", async () => {
    const asked: number[] = [];
    const { Renderer, canvas, scene, camera, module } = host(fieldsOf(asked));
    const heap = new Float64Array(32).fill(5);
    Reflect.set(module, "HEAPF64", heap);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      setStageMeters(enabled: boolean): void;
      info: { engine: { cpuMs: Record<string, number> } };
    };
    await renderer.init();
    renderer.setStageMeters(false);
    renderer.render(scene, camera);
    expect(asked).toContain(-4);
    expect(renderer.info.engine.cpuMs.cpuSceneMs).toBe(0);
    renderer.setStageMeters(true);
    renderer.render(scene, camera);
    expect(asked).toContain(-3);
    expect(renderer.info.engine.cpuMs.cpuSceneMs).toBe(5);
  });
});

describe("the owned engine's temporal render scale", () => {
  it("sends input scale while keeping the display-sized canvas", async () => {
    const fields: Record<number, number> = {};
    const { Renderer, canvas, scene, camera, state } = host((field) => fields[field] ?? 0);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      setSize(width: number, height: number): void;
      setRenderScale(scale: number): void;
      readonly temporalUpscale: boolean;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.setSize(1920, 1080);
    expect(renderer.temporalUpscale).toBe(false);
    fields[34] = 1;
    expect(renderer.temporalUpscale).toBe(true);
    renderer.setRenderScale(0.72);
    renderer.render(scene, camera);
    expect(state.mock.calls.at(-1)?.[6]).toBe(0.72);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    for (const scale of [0, 0.23, 1.1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => renderer.setRenderScale(scale)).toThrow(/renderScale/u);
    renderer.setRenderScale(1);
    renderer.render(scene, camera);
    expect(state.mock.calls.at(-1)?.[6]).toBe(1);
  });
});

describe("the Wasm engine's web host ABI", () => {
  async function init(engine: (() => number) | undefined) {
    const { Renderer, canvas, initCalls, module } = host();
    Reflect.set(module, "_tnw_web_host_abi", engine);
    const renderer = new Renderer({ canvas }) as { init(): Promise<unknown> };
    return { done: renderer.init(), initCalls };
  }

  it("hands its ABI to the matching engine's init", async () => {
    const { done, initCalls } = await init(() => WEB_HOST_ABI);
    await done;
    expect(initCalls.mock.calls[0]?.[3]).toBe(WEB_HOST_ABI);
  });

  it("refuses an engine of another ABI, or one older than the number, before init", async () => {
    const older = await init(() => WEB_HOST_ABI - 1);
    await expect(older.done).rejects.toThrow(
      `TN_WASM_ABI_MISMATCH: this facade speaks web host ABI ${WEB_HOST_ABI}, the engine ${WEB_HOST_ABI - 1}`,
    );
    expect(older.initCalls).not.toHaveBeenCalled();
    const unnumbered = await init(undefined);
    await expect(unnumbered.done).rejects.toThrow("the engine none (older than ABI 2)");
  });
});

describe("the Wasm engine's temporal pass readout", () => {
  async function readout(fields: Record<number, number>) {
    const { Renderer, canvas, scene, camera } = host((field) => fields[field] ?? 0);
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { temporal: unknown } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    return renderer.info.engine.temporal;
  }

  it("reads the engine's frame, history, jitter and counted history rejection while a traa() effect is in the graph", async () => {
    expect(
      await readout({
        13: 1,
        14: 7,
        15: 1,
        16: 0.25,
        17: -0.5,
        30: 12,
        31: 7,
        32: 3072,
        33: 48,
        35: 1280,
        36: 720,
        37: 31,
        38: 1920,
        39: 1080,
      }),
    ).toEqual({
      active: true,
      frame: 7,
      historyValid: true,
      jitter: [0.25, -0.5],
      rejected: 12,
      clamped: 7,
      pixels: 3072,
      countedFrame: 48,
      inputWidth: 1280,
      inputHeight: 720,
      outputWidth: 1920,
      outputHeight: 1080,
      jitterLength: 31,
    });
  });

  it("reports the samples the scene draws with, which the temporal pass sets to 1", async () => {
    const { Renderer, canvas, scene, camera } = host((field) => (field === 18 ? 1 : 0));
    const renderer = new Renderer({ canvas, antialias: true }) as {
      samples: number;
      info: { engine: { samples: number } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    expect({ asked: renderer.samples, drawn: renderer.info.engine.samples }).toEqual({
      asked: 4,
      drawn: 1,
    });
  });

  it("reports an inactive pass when no traa() effect reached the engine", async () => {
    expect(await readout({})).toEqual({
      active: false,
      frame: 0,
      historyValid: false,
      jitter: [0, 0],
      rejected: 0,
      clamped: 0,
      pixels: 0,
      countedFrame: 0,
      inputWidth: 0,
      inputHeight: 0,
      outputWidth: 0,
      outputHeight: 0,
      jitterLength: 0,
    });
  });
});

describe("the Wasm engine's WebGPURenderer sample count", () => {
  it("declares that its surface-owned frame pass cannot retain a target sub-rectangle", () => {
    const { Renderer, canvas } = host();
    const renderer = new Renderer({ canvas }) as {
      supportsRetainedTargetSubrect: boolean;
    };
    expect(renderer.supportsRetainedTargetSubrect).toBe(false);
  });

  it("is 4x MSAA for antialias, as three's WebGPURenderer, and the engine is told", async () => {
    expect(await drawn({ antialias: true })).toEqual({ samples: 4, handed: 4 });
  });

  it("is single-sampled without antialias, and an explicit samples wins", async () => {
    expect(await drawn({})).toEqual({ samples: 1, handed: 1 });
    expect(await drawn({ antialias: true, samples: 1 })).toEqual({ samples: 1, handed: 1 });
  });

  it("reports the submitted frame's sample, never the readback arrival frame", async () => {
    let gpuMs = -1;
    let gpuSamples = 0;
    let gpuSource = 0;
    const submitted: number[] = [];
    const { Renderer, canvas, scene, camera } = host(
      (field) => {
        if (field === 7) return gpuMs;
        if (field === 8) return gpuSamples;
        if (field === 9) return gpuSource;
        if (field === 10) return 1;
        return 0;
      },
      (...args) => {
        submitted.push(args[args.length - 1] ?? 0);
        return 0;
      },
    );
    const renderer = new Renderer({ canvas, trackTimestamp: true }) as {
      info: { frame: number; render: { timestamp: number } };
      backend: {
        trackTimestamp?: boolean;
        getTimestampFrames?(type: string): number[];
      };
      resolveTimestampsAsync?(type?: string): Promise<number | undefined>;
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    expect(renderer.backend.trackTimestamp).toBe(true);
    expect(typeof renderer.resolveTimestampsAsync).toBe("function");

    const draw = async (frame: number): Promise<void> => {
      renderer.info.frame = frame;
      renderer.render(scene, camera);
      await renderer.resolveTimestampsAsync?.();
    };

    // Unsupported or unresolved before any readback completes: absent, never zero.
    await draw(0);
    expect(renderer.backend.getTimestampFrames?.("render")).toEqual([]);
    expect(renderer.info.render.timestamp).toBe(0);

    // Frame 1 is submitted; its readback only lands at frame 4. The sample is frame 1, not frame 4.
    await draw(1);
    await draw(2);
    await draw(3);
    gpuMs = 1.75;
    gpuSamples = 1;
    gpuSource = 1;
    await draw(4);
    expect(renderer.backend.getTimestampFrames?.("render")).toEqual([1]);
    expect(renderer.info.render.timestamp).toBe(1.75);

    // Same duration, a distinct sample whose source is frame 3, arriving at frame 6: the source advances.
    await draw(5);
    gpuMs = 1.75;
    gpuSamples = 2;
    gpuSource = 3;
    await draw(6);
    expect(renderer.backend.getTimestampFrames?.("render")).toEqual([3]);
    expect(renderer.info.render.timestamp).toBe(1.75);

    // A non-finite duration despite a new sample is absent: the last valid sample stands.
    gpuMs = Number.NaN;
    gpuSamples = 3;
    gpuSource = 7;
    await draw(7);
    expect(renderer.backend.getTimestampFrames?.("render")).toEqual([3]);
    expect(renderer.info.render.timestamp).toBe(1.75);

    // Every caller frame id reaches the engine: the mapping is passed, never assumed.
    expect(submitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(renderer.backend.getTimestampFrames?.("compute")).toEqual([]);
  });

  it("reports the sample's labelled stage times beside its whole frame, and leaves a stage that drew nothing out", async () => {
    let gpuSamples = 0;
    let gatherMs = 0;
    let shadowMs = 0;
    const { Renderer, canvas, scene, camera } = host((field) => {
      if (field === 7) return 12.5;
      if (field === 19) return shadowMs; // the shadow passes' segment (web_host.cpp)
      if (field === 8) return gpuSamples;
      if (field === 9) return 4;
      if (field === 10) return 1;
      if (field === 23) return gatherMs; // the screen-space gather's segment (web_host.cpp 19 + 4)
      return 0;
    });
    const renderer = new Renderer({ canvas, trackTimestamp: true }) as {
      info: { engine: { gpuStages: Record<string, number> } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    expect(renderer.info.engine.gpuStages).toEqual({});
    gpuSamples = 1;
    gatherMs = 4.25;
    shadowMs = 0.75;
    renderer.render(scene, camera);
    expect(renderer.info.engine.gpuStages).toEqual({ SSGI: 4.25, Shadow: 0.75 });
    gpuSamples = 2;
    gatherMs = 0;
    shadowMs = 0;
    renderer.render(scene, camera);
    expect(renderer.info.engine.gpuStages).toEqual({});
  });

  it("reports the lamp shadow maps apart from the sun's (PRD-650)", async () => {
    let gpuSamples = 0;
    const { Renderer, canvas, scene, camera } = host((field) => {
      if (field === 7) return 1.5;
      if (field === 8) return gpuSamples;
      if (field === 10) return 1;
      if (field === 19) return 0.25; // the sun's shadow passes
      if (field === 24) return 0.5; // the lamp shadow passes
      if (field === 25) return 2; // lamp maps redrawn
      if (field === 26) return 13; // their draws
      if (field === 27) return 15; // every shadow draw
      if (field === 28) return 1024; // the smallest footprint-sized lamp map
      if (field === 29) return 2048; // and the largest
      if (field === 40) return 1; // maps kept from the last frame
      if (field === 41) return 4096; // per-draw uniform bytes uploaded
      return 0;
    });
    const renderer = new Renderer({ canvas, trackTimestamp: true }) as {
      info: { engine: { shadows: Record<string, number> } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    expect(renderer.info.engine.shadows).toEqual({
      lampRedraws: 2,
      lampDraws: 13,
      shadowDraws: 15,
      sunGpuMs: -1,
      lampGpuMs: -1,
      lampMapMin: 1024,
      lampMapMax: 2048,
      keptMaps: 1,
    });
    expect((renderer.info.engine as unknown as { uniformBytes: number }).uniformBytes).toBe(4096);
    gpuSamples = 1;
    renderer.render(scene, camera);
    expect(renderer.info.engine.shadows).toMatchObject({ sunGpuMs: 0.25, lampGpuMs: 0.5 });
  });

  it("does not claim enabled timestamps when the caller opts out or the device has none", async () => {
    const opted = host((field) => (field === 10 ? 1 : 0));
    const off = new opted.Renderer({ canvas: opted.canvas, trackTimestamp: false }) as {
      backend: { trackTimestamp: boolean };
      init(): Promise<unknown>;
    };
    await off.init();
    expect(off.backend.trackTimestamp).toBe(false);

    const bare = host((field) => (field === 10 ? 0 : 0));
    const unsupported = new bare.Renderer({ canvas: bare.canvas, trackTimestamp: true }) as {
      backend: { trackTimestamp: boolean };
      init(): Promise<unknown>;
    };
    await unsupported.init();
    expect(unsupported.backend.trackTimestamp).toBe(false);
  });

  it("counts a frame's draws and triangles over every render() call until info.reset(), as three's Info does", async () => {
    // The game draws the world, then its HUD overlay, as two render() calls in one frame; the
    // overlay's own few draws used to overwrite the world's (doctor: "4 draw calls, 7 triangles").
    const perCall = [
      { draws: 58, triangles: 13700 },
      { draws: 4, triangles: 7 },
    ];
    let call = -1;
    const { Renderer, canvas, scene, camera } = host(
      (field) =>
        field === 0
          ? (perCall[call]?.draws ?? 0)
          : field === 1
            ? (perCall[call]?.triangles ?? 0)
            : 0,
      () => {
        call += 1;
        return 0;
      },
    );
    const renderer = new Renderer({ canvas }) as {
      info: { reset(): void; render: { drawCalls: number; triangles: number; frameCalls: number } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    expect(renderer.info.render.drawCalls).toBe(62);
    expect(renderer.info.render.triangles).toBe(13707);
    renderer.info.reset();
    expect(renderer.info.render).toMatchObject({ drawCalls: 0, frameCalls: 0, triangles: 0 });
  });

  it("reports a lost device once and then stops drawing, instead of throwing every frame", async () => {
    // Chromium's headless shell cannot back a WebGPU canvas, so the GPU process destroys the device right
    // after start; the host stays Failed. The renderer threw "TN_WASM_DEVICE_LOST" from every render() (about
    // 950 page errors in 25 s).
    let hostState = 1;
    const render = vi.fn(() => {
      hostState = 2;
      return 1;
    });
    const secondary = vi.fn();
    const { Renderer, canvas, scene, camera } = host(
      undefined,
      render,
      secondary,
      undefined,
      undefined,
      undefined,
      () => hostState,
    );
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    const failures: unknown[] = [];
    for (let frame = 0; frame < 50; frame += 1) {
      try {
        renderer.render(scene, camera);
      } catch (error) {
        failures.push(error);
      }
    }
    expect(failures).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it("names a device lost while the frame gate declines, on backend.device.lost as three's backend does", async () => {
    // Hosted CI's SwiftShader lost the device with two frames still on the GPU: the gate declined every
    // later frame, no draw ever returned a status, and nothing named the loss (73 of 73 frames skipped).
    let hostState = 1;
    const { Renderer, canvas, scene, camera, module } = host(
      (field) => (field === 11 ? 1 : 0),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => hostState,
    );
    Reflect.set(module, "UTF8ToString", () => "TN_WASM_DEVICE_LOST: GPU connection lost");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderer = new Renderer({ canvas }) as {
      backend: { device?: { lost: Promise<{ reason: string; message: string }> } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    hostState = 2;
    for (let frame = 0; frame < 5; frame += 1) renderer.render(scene, camera);
    await expect(renderer.backend.device?.lost).resolves.toEqual({
      reason: "unknown",
      message: "TN_WASM_DEVICE_LOST: GPU connection lost",
    });
    const named = errors.mock.calls.filter((call) =>
      String(call[0]).startsWith("TN_WASM_RENDERER_LOST"),
    );
    expect(named).toHaveLength(1);
    errors.mockRestore();
  });

  it("draws renderOverlay as the host's overlay, so the canvas layer skips the world's post and temporal state", async () => {
    // Through render(), core's loading screen ran the world renderer's post chain and temporal step: the world
    // came back ghosted and blurred after the cover lifted (Lantern Vale, Hop Garden).
    const render = vi.fn(() => 0);
    const { Renderer, canvas, scene, camera } = host(undefined, render);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      renderOverlay(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    renderer.renderOverlay(scene, camera);
    renderer.render(scene, camera);
    const overlayArgument = (call: unknown[]) => call[6];
    expect(render.mock.calls.map((call) => overlayArgument(call as unknown[]))).toEqual([0, 1, 0]);
  });

  it("names the loss on the console, so a caller that swallows the one throw cannot hide a black page", async () => {
    // A warm-up or a frame hook may catch the single throw. Every later render() then returns without
    // drawing and nothing says why: auto exposure's refused shader killed the page that way.
    let hostState = 1;
    const render = vi.fn(() => {
      hostState = 2;
      return 1;
    });
    const { Renderer, canvas, scene, camera } = host(
      undefined,
      render,
      undefined,
      undefined,
      undefined,
      undefined,
      () => hostState,
    );
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let frame = 0; frame < 5; frame += 1) {
        try {
          renderer.render(scene, camera);
        } catch {
          // The caller swallows it, as startup warm-up does.
        }
      }
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("TN_WASM_RENDERER_LOST");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the Wasm engine's offscreen PassNode draw", () => {
  it("hands the drawing buffer and a deferred target draw to the passes before the frame is drawn", async () => {
    const order: string[] = [];
    const deferredFlags: number[] = [];
    let surface: { width: number; height: number } | undefined;
    const made = host(
      () => 0,
      () => {
        order.push("frame");
        return 0;
      },
      (read, draw) => {
        surface = read();
        draw(target as never, made.scene as never, made.camera as never);
      },
      (...args) => {
        order.push("target");
        deferredFlags.push(args[args.length - 1] ?? -1);
        return 0;
      },
    );
    const target = new (made.classes.RenderTarget as new (w: number, h: number) => object)(4, 4);
    const renderer = new made.Renderer({ canvas: made.canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(made.scene, made.camera);
    expect(surface).toEqual({ width: 300, height: 150 });
    expect(order).toEqual(["target", "frame"]);
    // The engine plans the target's draw now and records it in the frame that samples the target.
    expect(deferredFlags).toEqual([1]);
  });
});

/**
 * rain's performance scenario (--disable-frame-rate-limit) lost its device on the Wasm engine: rAF ran
 * 200+ times a second, the engine queued every frame, Chromium blocked the page until the GPU drained
 * (16 s) and the GPU process was killed ("A valid external Instance reference no longer exists").
 * The host reports field 11 = 1 while two frames are still on the GPU; render() draws nothing then.
 */
describe("the Wasm engine's WebGPURenderer backpressure", () => {
  it("draws nothing while the GPU is behind and draws again once it catches up", async () => {
    let behind = 0;
    const drawnFrames: number[] = [];
    const { Renderer, canvas, scene, camera } = host(
      (field) => (field === 11 ? behind : 0),
      (...args) => {
        drawnFrames.push(args[args.length - 1] ?? 0);
        return 0;
      },
    );
    const renderer = new Renderer({ canvas }) as {
      info: { frame: number };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    // The next frame: a draw in the same task would land on the frame just drawn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    behind = 1;
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    expect(drawnFrames).toEqual([0]);
    expect(renderer.info.frame).toBe(1);
    behind = 0;
    renderer.render(scene, camera);
    expect(drawnFrames).toEqual([0, 1]);
  });
});

describe("the Wasm engine's frame gate", () => {
  it("counts each render() it declines, so a meter can tell a drawn frame from a skipped one", async () => {
    let onGpu = 0;
    const drawnFrames: number[] = [];
    const { Renderer, canvas, scene, camera } = host(
      (field) => (field === 11 ? onGpu : 0),
      (...args) => {
        drawnFrames.push(args[args.length - 1] ?? 0);
        return 0;
      },
    );
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { frameGateSkips?: number } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    expect(renderer.info.engine.frameGateSkips).toBe(0);
    renderer.render(scene, camera);
    // The next frame: a draw in the same task would land on the frame just drawn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    onGpu = 1;
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    onGpu = 0;
    renderer.render(scene, camera);
    expect(drawnFrames).toHaveLength(2);
    expect(renderer.info.engine.frameGateSkips).toBe(2);
  });
});

describe("the Wasm engine's startup presentation hold", () => {
  it("startup presentation hold does not skip ordinary warm renders", async () => {
    // A host in miniature: field 71 counts the world frames that reached it, field 72 says the shadows are
    // mapped, and an overlay is the one draw that is not one of them (web_host.cpp tnw_web_render).
    const fields: Record<number, number> = {};
    const hold: number[] = [];
    const render = vi.fn((...args: number[]) => {
      if (args[6] !== 1) {
        fields[71] = (fields[71] ?? 0) + 1;
        fields[72] = 1;
      }
      return 0;
    });
    const { Renderer, canvas, scene, camera, module } = host((field) => fields[field] ?? 0, render);
    Reflect.set(module, "_tnw_web_set_presentation_hold", (held: number) => hold.push(held));
    const renderer = new Renderer({ canvas }) as {
      readonly info: {
        engine: { startup: { shadowInputsReady: boolean; worldSubmissions: number } };
      };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      renderOverlay(scene: unknown, camera: unknown): void;
      setPresentationHeld(held: boolean): void;
      dispose(): void;
    };
    await renderer.init();
    const startup = (): unknown => renderer.info.engine.startup;
    expect(startup()).toEqual({ shadowInputsReady: false, worldSubmissions: 0 });

    renderer.setPresentationHeld(true);
    expect(hold).toEqual([1]);
    // The hold defers the surface texture, never the passes. The covered draw is the frame that maps the shadow
    // pages and feeds the meter, so skipping it would hold the cover waiting for work nothing else starts.
    renderer.render(scene, camera);
    expect(render).toHaveBeenCalledTimes(1);
    expect(startup()).toEqual({ shadowInputsReady: true, worldSubmissions: 1 });

    // A frame the gate declined never reached the engine, and the loading cover's overlay is not a world
    // frame: neither may read as the startup's first one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fields[11] = 1;
    renderer.render(scene, camera);
    expect(render).toHaveBeenCalledTimes(1);
    fields[11] = 0;
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.renderOverlay(scene, camera);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[6]).toBe(1);
    expect(startup()).toEqual({ shadowInputsReady: true, worldSubmissions: 1 });

    // Engaging the same hold twice does not stack, and only this renderer's own dispose releases it.
    renderer.setPresentationHeld(true);
    expect(hold).toEqual([1]);
    renderer.dispose();
    expect(hold).toEqual([1, 0]);
  });
});

describe("the Wasm engine's environment preparation", () => {
  it("prepares one step per task until the engine reports the environment baked", async () => {
    // Pending for two steps, then baked. A step per macrotask, because the work-done callbacks that
    // advance the bake arrive between tasks; the loop stops at the first baked answer.
    const statuses = [0, 0, 1, 0];
    const prepare = vi.fn((..._args: number[]) => statuses.shift() ?? 0);
    const render = vi.fn((..._args: number[]) => 0);
    const { Renderer, canvas, scene, camera, module } = host(() => 0, render);
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(scene: unknown, camera: unknown): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual([0]); // the step after the baked answer is never asked for
    expect(render).not.toHaveBeenCalled();
  });

  it("never presents its final bake frame", async () => {
    // The bake reached the canvas through render(), so its last draw was the first picture the browser
    // presented: bright, without the next frame's cast shadows, held 0.7-1.6 s (VSM and plain shadow).
    const render = vi.fn((..._args: number[]) => 0);
    const statuses = [0, 0, 1];
    const prepare = vi.fn((..._args: number[]) => statuses.shift() ?? 1);
    const { Renderer, canvas, scene, camera, module } = host(() => 0, render);
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const sky = { version: 1 };
    Object.defineProperty(scene, "environment", { value: sky, configurable: true });
    const renderer = new Renderer({ canvas }) as {
      info: { frame: number; engine: { environmentBake: boolean } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(scene: unknown, camera: unknown): Promise<boolean>;
    };
    await renderer.init();
    const frame = renderer.info.frame;
    expect(await renderer.prepareEnvironmentAsync(scene, camera)).toBe(true);
    // Preparation is not a draw: no surface submission, no frame counted.
    expect(render).not.toHaveBeenCalled();
    expect(renderer.info.frame).toBe(frame);
    expect(prepare).toHaveBeenCalledTimes(3);
    const [sceneHandle, cameraHandle] = prepare.mock.calls[0] as [number, number];
    expect(
      prepare.mock.calls.every(([at, view]) => at === sceneHandle && view === cameraHandle),
    ).toBe(true);
    expect(cameraHandle).toBe(sceneHandle + 12);
    const view = new DataView(module.HEAPU8.buffer);
    const packed = (at: number) => [
      view.getUint16(at, true),
      view.getUint16(at + 2, true),
      view.getUint32(at + 4, true),
      view.getUint32(at + 8, true),
    ];
    const ref = (object: object) => (engineRef(object)?.key ?? "").split(":").map(Number);
    expect(packed(sceneHandle)).toEqual(ref(scene));
    expect(packed(cameraHandle)).toEqual(ref(camera));
    expect(renderer.info.engine.environmentBake).toBe(false);
  });

  it("prepares the held scene on every step after the cover painted between them", async () => {
    // The cover paints through render(), which rewrites the handle slots the preparer reads.
    const statuses = [0, 0, 1];
    const { Renderer, canvas, scene, camera, module } = host(() => 0);
    const view = new DataView(module.HEAPU8.buffer);
    const packed = (at: number) => [
      view.getUint16(at, true),
      view.getUint16(at + 2, true),
      view.getUint32(at + 4, true),
      view.getUint32(at + 8, true),
    ];
    const seen: number[][][] = [];
    let slots = 0;
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = (at: number, cameraAt: number) => {
      slots = at;
      seen.push([packed(at), packed(cameraAt)]);
      return statuses.shift() ?? 1;
    };
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs?: number,
        afterDraw?: () => void,
      ): Promise<boolean>;
    };
    await renderer.init();
    const cover = () => module.HEAPU8.fill(0, slots, slots + 24);
    expect(
      await renderer.prepareEnvironmentAsync(scene, camera, Number.POSITIVE_INFINITY, cover),
    ).toBe(true);
    const ref = (object: object) => (engineRef(object)?.key ?? "").split(":").map(Number);
    expect(seen).toEqual([0, 1, 2].map(() => [ref(scene), ref(camera)]));
  });

  it("gives up at its deadline on a bake that still pends, presenting nothing", async () => {
    const render = vi.fn((..._args: number[]) => 0);
    const prepare = vi.fn((..._args: number[]) => 0);
    const { Renderer, canvas, scene, camera, module } = host(() => 0, render);
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { environmentBake: boolean } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 20)).toBe(
      false,
    );
    expect(prepare.mock.calls.length).toBeGreaterThan(0);
    expect(render).not.toHaveBeenCalled();
    expect(renderer.info.engine.environmentBake).toBe(false);
  });

  it("refuses a refused bake by the host's diagnostic, preparing no further step", async () => {
    const prepare = vi.fn((..._args: number[]) => -1);
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    engine.UTF8ToString = () => "TN_WASM_PREPARE: the environment source is gone";
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { environmentBake: boolean } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(scene: unknown, camera: unknown): Promise<boolean>;
    };
    await renderer.init();
    await expect(renderer.prepareEnvironmentAsync(scene, camera)).rejects.toThrow(
      "TN_WASM_PREPARE: the environment source is gone",
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(renderer.info.engine.environmentBake).toBe(false);
  });
});

describe("the Wasm engine's environment preparation across a restart", () => {
  it("waits on no step for an environment an earlier preparation already baked", async () => {
    // A restart re-enters the same sky. The engine kept its bake (keyed by the texture), so the
    // restart must not step it again: on SwiftShader shooter debug-restart's one advance took 28 s
    // against a 20.25 s bound.
    let pending = false;
    const prepare = vi.fn((..._args: number[]) => (pending ? 0 : 1));
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    // An own property shadows the engine-backed accessor, which this stub runtime cannot answer.
    const disposed: Array<() => void> = [];
    const sky = {
      version: 1,
      addEventListener: (_type: string, listener: () => void) => disposed.push(listener),
    };
    Object.defineProperty(scene, "environment", { value: sky, configurable: true });
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1000)).toBe(
      true,
    );
    const before = prepare.mock.calls.length;
    const started = performance.now();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1000)).toBe(
      true,
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(prepare.mock.calls.length).toBe(before);
    // A new version, or a disposed sky, is a new bake: back to the bounded wait.
    pending = true;
    sky.version = 2;
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 20)).toBe(
      false,
    );
    for (const listener of disposed) listener();
    sky.version = 1;
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 20)).toBe(
      false,
    );
  });
});

describe("the Wasm engine's environment preparation after its deadline", () => {
  it("learns the bake finished from a later frame, so the restart after it waits on no step", async () => {
    // SwiftShader's first boot gives the bake up at the deadline; play then draws the baked sky.
    let pending = 1;
    const prepare = vi.fn((..._args: number[]) => (pending ? 0 : 1));
    const { Renderer, canvas, scene, camera, module } = host((field) =>
      field === 12 ? pending : 0,
    );
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const sky = { version: 1 };
    Object.defineProperty(scene, "environment", { value: sky, configurable: true });
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 20)).toBe(
      false,
    );
    // A restart before any frame found it done: the boot already waited its budget for this bake,
    // which keeps running, so the restart does not wait it again.
    const started = performance.now();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1000)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(500);
    pending = 0;
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);
    const before = prepare.mock.calls.length;
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1000)).toBe(
      true,
    );
    expect(prepare.mock.calls.length).toBe(before);
  });
});

describe("the Wasm engine's environment preparation in flight", () => {
  it("does not start a second wait for a bake an earlier preparation is still waiting on", async () => {
    // Shooter on SwiftShader: the boot's 45 s hold warm-up was still waiting on the sky when the
    // restart prepared the same sky, and the restart waited its own 15 s budget beside it.
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = () => 0;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const sky = { version: 1 };
    Object.defineProperty(scene, "environment", { value: sky, configurable: true });
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    const boot = renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = performance.now();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 1000)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(await boot).toBe(false);
  });
});

describe("the Wasm engine's environment preparation presents", () => {
  it("lets the caller paint its cover in every step's task, presenting no world frame", async () => {
    // A step presents nothing, so the cover over the frame last presented is the only thing to keep
    // painting while the bake runs: it has to follow every step before the task ends.
    const statuses = [0, 0, 1];
    const order: string[] = [];
    const prepare = vi.fn((..._args: number[]) => {
      const status = statuses.shift() ?? 1;
      order.push(status === 0 ? "step" : "baked");
      return status;
    });
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { environmentBake: boolean } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
        afterDraw: () => void,
      ): Promise<boolean>;
    };
    await renderer.init();
    const bakeStates: boolean[] = [];
    await renderer.prepareEnvironmentAsync(scene, camera, Number.POSITIVE_INFINITY, () => {
      bakeStates.push(renderer.info.engine.environmentBake);
      order.push("cover");
    });
    expect(order).toEqual(["step", "cover", "step", "cover", "baked", "cover"]);
    // The cover repaint in the same task is not a presented world frame, but the bake flag holds for it.
    expect(bakeStates).toEqual([true, true, true]);
    expect(renderer.info.engine.environmentBake).toBe(false);
  });
});

describe("the Wasm engine's cover repaint under the frame gate", () => {
  it("is not refused by the gate that refuses a second draw while frames are still on the GPU", async () => {
    // The host counts a frame on the GPU for every draw. The bake presents nothing, so the cover
    // repaint in each step's task is that task's only draw: a refused one leaves the unfinished sky
    // on screen instead of the cover.
    const statuses = [0, 0, 1];
    let coverDraws = 0;
    let onGpu = 0;
    const { Renderer, canvas, scene, camera, module } = host(
      (field) => (field === 11 ? (onGpu >= 1 ? 1 : 0) : 0),
      (...args) => {
        if (args[6] === 1) coverDraws += 1;
        onGpu += 1;
        return 0;
      },
    );
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = () => statuses.shift() ?? 1;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { frameGateSkips: number } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
        afterDraw: () => void,
      ): Promise<boolean>;
      renderOverlay(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    await renderer.prepareEnvironmentAsync(scene, camera, Number.POSITIVE_INFINITY, () => {
      renderer.renderOverlay(scene, camera);
      onGpu = 0; // the GPU finishes before the next timer task
    });
    expect(coverDraws).toBe(3);
    expect(renderer.info.engine.frameGateSkips).toBe(0);
  });

  it("holds back a frame, not a draw: the overlay over a drawn world draws, the next frame waits", async () => {
    // The frame loop draws the world and then its overlay in one callback. A refused overlay presents
    // the world without its loading cover; the next frame is where the gate saves the GPU a frame.
    let onGpu = 0;
    let drawn = 0;
    const { Renderer, canvas, scene, camera } = host(
      (field) => (field === 11 ? (onGpu >= 1 ? 1 : 0) : 0),
      () => {
        drawn += 1;
        onGpu += 1;
        return 0;
      },
    );
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { frameGateSkips: number } };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    expect(drawn).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);
    expect(drawn).toBe(2);
    expect(renderer.info.engine.frameGateSkips).toBe(1);
  });
});

describe("the Wasm engine's environment preparation deadline", () => {
  it("gives up at the caller's deadline instead of preparing an unbaked environment forever", async () => {
    const prepare = vi.fn((..._args: number[]) => 0);
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_prepare_environment = prepare;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 1;
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, performance.now() + 20)).toBe(
      false,
    );
    const after = prepare.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepare.mock.calls.length).toBe(after);
  });
});

describe("the Wasm engine's WebGPURenderer across a hot update", () => {
  it("lets a renderer replace a disposed one on the engine's own canvas, and refuses a second live one", async () => {
    const { Renderer, canvas, scene, camera, state } = host();
    type Wasm = {
      domElement: object;
      init(): Promise<unknown>;
      dispose(): void;
      render(a: unknown, b: unknown): void;
    };
    const first = new Renderer({ canvas }) as Wasm;
    await first.init();
    expect(() => new Renderer({ canvas })).toThrow(/TN_WASM_RENDERER_SINGLE/u);
    first.dispose();
    first.dispose();
    const nextCanvas = { ...canvas };
    const second = new Renderer({ canvas: nextCanvas }) as Wasm;
    await second.init();
    expect(second.domElement).toBe(canvas);
    second.render(scene, camera);
    expect(state).toHaveBeenCalled();
    first.dispose();
    expect(() => new Renderer({ canvas })).toThrow(/TN_WASM_RENDERER_SINGLE/u);
  });

  it("starts the engine once however many renderers the page builds", async () => {
    const { Renderer, canvas, initCalls } = host();
    for (let index = 0; index < 3; index += 1) {
      const renderer = new Renderer({ canvas }) as { init(): Promise<unknown>; dispose(): void };
      await renderer.init();
      renderer.dispose();
    }
    expect(initCalls).toHaveBeenCalledTimes(1);
  });
});

describe("the clear colour", () => {
  it("converts a repeated number clear colour once, as every post pass resets it to 0", () => {
    const { module, canvas } = host();
    let made = 0;
    class CountingColor {
      r: number;
      g: number;
      b: number;
      constructor(hex: number) {
        made += 1;
        this.r = ((hex >> 16) & 255) / 255;
        this.g = ((hex >> 8) & 255) / 255;
        this.b = (hex & 255) / 255;
      }
    }
    const Renderer = defineWebRenderer(module, CountingColor as never);
    const renderer = new Renderer({ canvas }) as {
      setClearColor(color: unknown, alpha?: number): void;
      getClearColor<T>(target: T): T;
      getClearAlpha(): number;
    };
    const out = {
      r: -1,
      g: -1,
      b: -1,
      setRGB(r: number, g: number, b: number) {
        Object.assign(this, { r, g, b });
        return this;
      },
    };
    const cost: Record<string, number> = {};
    (globalThis as { __tnEngineCost?: Record<string, number> }).__tnEngineCost = cost;
    for (let index = 0; index < 3; index += 1) renderer.setClearColor(0, 1);
    expect(made).toBe(1);
    expect(cost).toEqual({ clearColorConversions: 1 });
    renderer.setClearColor(0xff0000, 0.5);
    expect(made).toBe(2);
    expect(renderer.getClearColor(out)).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(renderer.getClearAlpha()).toBe(0.5);
    renderer.setClearColor({ r: 0, g: 1, b: 0 }, 1);
    expect(renderer.getClearColor(out)).toMatchObject({ r: 0, g: 1, b: 0 });
    renderer.setClearColor(0xff0000, 1);
    expect(made).toBe(2);
    expect(renderer.getClearColor(out)).toMatchObject({ r: 1, g: 0, b: 0 });
  });
});

describe("Wasm TempNode render lifecycle", () => {
  it("draws a subclass quad through the existing target path once per frame and restores state", async () => {
    let next = 0;
    const runtime: ITslRuntime = {
      call: () => ++next,
      release() {},
      set() {},
      setUniform() {},
      effectParameter: () => 0,
      setPost() {},
      compute() {},
      readStorage: async () => new ArrayBuffer(0),
      deleteStorage() {},
    };
    const tsl = defineTsl(runtime);
    const draw = vi.fn(() => 0);
    const { Renderer, canvas, scene, camera, classes } = host(
      undefined,
      undefined,
      undefined,
      draw,
      tsl.sync,
    );
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<void>;
      render(scene: unknown, camera: unknown): void;
      setRenderTarget(target: unknown): void;
      getRenderTarget(): unknown;
      setClearColor(color: unknown, alpha: number): void;
      getClearAlpha(): number;
      autoClear: boolean;
    };
    const utils = defineRendererUtils(classes.Color as never);
    const QuadMesh = defineQuadMesh(classes as never);
    const quad = new QuadMesh();
    const TempNode = tsl.exports.TempNode as new (
      type: string,
    ) => {
      setup(builder: unknown): unknown;
      updateBefore(frame: unknown): unknown;
      updateBeforeType: string;
      dispose(): void;
    };
    const target = new (classes.RenderTarget as new () => object)();
    const update = vi.fn();
    class Exposure extends TempNode {
      constructor() {
        super("float");
        this.updateBeforeType = "frame";
      }
      override setup(builder: unknown) {
        super.setup(builder);
        return (tsl.exports.float as (v: number) => unknown)(2);
      }
      override updateBefore(frame: unknown) {
        expect((frame as { renderer: unknown }).renderer).toBe(renderer);
        update();
        const state = utils.resetRendererState(renderer as never);
        try {
          renderer.setRenderTarget(target);
          quad.render(renderer);
        } finally {
          utils.restoreRendererState(renderer as never, state);
        }
      }
    }
    const node = new Exposure();
    (tsl.exports.float as (v: unknown) => unknown)(node);
    await renderer.init();
    renderer.setClearColor(0, 0.25);
    renderer.autoClear = false;
    renderer.render(scene, camera);
    expect(update).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(renderer.getRenderTarget()).toBe(null);
    expect(renderer.getClearAlpha()).toBe(0.25);
    expect(renderer.autoClear).toBe(false);
    renderer.render(scene, camera);
    expect(update).toHaveBeenCalledTimes(2);
    node.dispose();
    renderer.render(scene, camera);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("custom tone mapping", () => {
  it("refuses mode 5 precisely until a curve is registered", async () => {
    const { Renderer, canvas, scene, camera } = host();
    const renderer = new Renderer({ canvas }) as {
      toneMapping: number;
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    renderer.toneMapping = 5;
    expect(() => renderer.render(scene, camera)).toThrow("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING");
  });

  it("installs the registered TSL curve before rendering mode 5", async () => {
    let id = 0;
    const runtime = {
      call: vi.fn(() => ++id),
      release: vi.fn(),
      setToneMapping: vi.fn(),
    } as unknown as ITslRuntime;
    const { Renderer, canvas, scene, camera, state } = host(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    const renderer = new Renderer({ canvas }) as {
      library: ReturnType<typeof import("../src/tone-mapping.js").defineToneMappingLibrary>;
      toneMapping: number;
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    const curve = vi.fn((color: { mul(value: number): { [TSL_NODE]: number } }) => color.mul(0.25));
    renderer.library.addToneMapping(curve, 5);
    expect(renderer.library.getToneMappingFunction(5)).toBe(curve);
    renderer.toneMapping = 5;
    await renderer.init();
    renderer.render(scene, camera);
    expect(curve).toHaveBeenCalledTimes(1);
    expect(runtime.setToneMapping).toHaveBeenCalledWith(curve.mock.results[0]?.value[TSL_NODE]);
    expect(state.mock.calls.at(-1)?.[0]).toBe(5);
  });
});

describe("the Wasm engine's compileAsync", () => {
  async function compiling(statuses: number[], id = 7) {
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    const start = vi.fn((..._args: number[]) => id);
    const status = vi.fn((_id: number) => statuses.shift() ?? 1);
    engine._tnw_web_compile_async = start;
    engine._tnw_web_compile_status = status;
    engine.UTF8ToString = () => "TN_WASM_PIPELINE_REFUSED: the fragment did not validate";
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      compileAsync(scene: unknown, camera: unknown, target?: unknown): Promise<void>;
    };
    await renderer.init();
    return { compile: () => renderer.compileAsync(scene, camera), start, status };
  }

  it("builds the pipelines in the engine and resolves once every one is built (Lantern Vale compiled 205 in its first frames)", async () => {
    const { compile, start, status } = await compiling([0, 0, 1]);
    await compile();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[2]).toBe(0); // no target scene
    expect(status.mock.calls.map(([id]) => id)).toEqual([7, 7, 7]);
  });

  it("rejects, naming the refusal, when a pipeline is refused or the compile cannot start", async () => {
    await expect((await compiling([0, -1])).compile()).rejects.toThrow("TN_WASM_PIPELINE_REFUSED");
    await expect((await compiling([], 0)).compile()).rejects.toThrow("TN_WASM_PIPELINE_REFUSED");
  });

  it("compiles and bakes with the game's RenderPipeline graph installed first (Lantern Vale built a 4x pass it never drew)", async () => {
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    const order: string[] = [];
    engine._tnw_web_compile_async = () => {
      order.push("compile");
      return 7;
    };
    engine._tnw_web_compile_status = () => 1;
    engine._tnw_web_prepare_environment = () => {
      order.push("prepare");
      return 1;
    };
    const render = engine._tnw_web_render as (...args: unknown[]) => number;
    engine._tnw_web_render = (...args: unknown[]) => {
      order.push("draw");
      return render(...args);
    };
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      compileAsync(scene: unknown, camera: unknown): Promise<void>;
      prepareEnvironmentAsync(scene: unknown, camera: unknown): Promise<boolean>;
      [PIPELINE_POST]?: () => void;
    };
    await renderer.init();
    renderer[PIPELINE_POST] = () => order.push("post");
    await renderer.compileAsync(scene, camera);
    await renderer.prepareEnvironmentAsync(scene, camera);
    // The bake compiles the scene off the queue before the frame that would compile it synchronously.
    expect(order).toEqual(["post", "compile", "post", "post", "compile", "prepare"]);
    expect(order).not.toContain("draw");
  });

  it("still bakes inside its deadline when the scene compile never settles", async () => {
    const { Renderer, canvas, scene, camera, module } = host();
    const engine = module as unknown as Record<string, unknown>;
    engine._tnw_web_compile_async = () => 7;
    engine._tnw_web_compile_status = () => 0;
    let steps = 0;
    engine._tnw_web_prepare_environment = () => {
      steps += 1;
      return 1;
    };
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      prepareEnvironmentAsync(
        scene: unknown,
        camera: unknown,
        deadlineMs: number,
      ): Promise<boolean>;
    };
    await renderer.init();
    const started = performance.now();
    expect(await renderer.prepareEnvironmentAsync(scene, camera, started + 400)).toBe(true);
    expect(steps).toBe(1);
    // The compile waits half the time left at most: the bake drew near 200 ms, not at its deadline.
    expect(performance.now() - started).toBeLessThan(320);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("debug renderer observations", () => {
  it("forwards source-frame requests and preserves batched unrequested deliveries when the latest was requested", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    const words = new Uint32Array(4);
    const requests: boolean[] = [];
    let requested = false;
    const fields: Record<number, number> = { 10: 1, 7: 2 };
    const { Renderer, canvas, scene, camera, module, counters } = host(
      (field) => {
        if (field === -1 || field === -2) requested = field === -1;
        return fields[field] ?? 0;
      },
      () => {
        requests.push(requested);
        return 0;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      words,
    );
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      backend: { trackTimestamp: boolean };
      render(scene: object, camera: object): void;
    };
    await renderer.init();
    for (let source = 0; source < 8; source++) {
      renderer.backend.trackTimestamp = source === 7;
      renderer.render(scene, camera);
    }
    expect(requests).toEqual([false, false, false, false, false, false, false, true]);
    // All eight native readbacks complete together, with requested frame 7 delivered last.
    fields[8] = 8;
    fields[9] = 7;
    words[2] = requests.filter((value) => !value).length;
    renderer.backend.trackTimestamp = false;
    renderer.render(scene, camera);
    expect(counters().gpuTimestampUnrequestedSamples).toBe(7);
    expect(debugTelemetry(module)?.totals).toMatchObject({
      gpuTimestampRequests: 1,
      gpuTimestampSamples: 8,
    });
  });

  it("keeps a legitimate delayed sample separate from the arrival frame's request", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    const words = new Uint32Array(4);
    const fields: Record<number, number> = { 10: 1, 7: 2 };
    const { Renderer, canvas, scene, camera, counters } = host(
      (field) => fields[field] ?? 0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      words,
    );
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      backend: { trackTimestamp: boolean };
      render(scene: object, camera: object): void;
    };
    await renderer.init();
    renderer.backend.trackTimestamp = true;
    renderer.render(scene, camera);
    fields[8] = 1;
    fields[9] = 0;
    renderer.backend.trackTimestamp = false;
    renderer.render(scene, camera);
    expect(counters().gpuTimestampUnrequestedSamples).toBe(0);
  });

  it("leaves the temporal totals the native renderer counts to it, adding only the pixel sizes it alone knows", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    const fields: Record<number, number> = {
      13: 1,
      15: 0,
      30: 30,
      31: 20,
      32: 100,
      33: 1,
      35: 10,
      36: 10,
      38: 20,
      39: 20,
    };
    const { Renderer, canvas, scene, camera, module } = host((field) => fields[field] ?? 0);
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: object, camera: object): void;
    };
    await renderer.init();
    renderer.render(scene, camera);
    fields[15] = 1;
    renderer.render(scene, camera);
    const totals = debugTelemetry(module)?.totals ?? {};
    expect(totals).toMatchObject({ temporalInputPixels: 200, temporalOutputPixels: 800 });
    // The native renderer exports these under these exact names (foundation/waste_counters.h), so a
    // JS copy double-counts nothing it overwrites and silently keeps a stale value when it does not.
    for (const name of [
      "temporalActiveFrames",
      "temporalHistoryInvalidFrames",
      "temporalMeasuredPixels",
      "temporalRejectedPixels",
      "temporalClampedPixels",
    ])
      expect(totals).not.toHaveProperty(name);
  });

  it("adds no host calls or allocations with debug off", async () => {
    vi.stubEnv("TN_DEBUG", "0");
    const frame = vi.fn(() => 0);
    const { Renderer, canvas, scene, camera, module } = host(frame);
    Reflect.set(module, "_tnw_web_set_presentation_hold", () => undefined);
    const malloc = vi.spyOn(module, "_malloc");
    const renderer = new Renderer({ canvas }) as {
      init(): Promise<unknown>;
      render(scene: object, camera: object): void;
      setPresentationHeld(held: boolean): void;
    };
    await renderer.init();
    frame.mockClear();
    malloc.mockClear();
    renderer.render(scene, camera);
    // Existing renderer ABI census; debug reads existing observations only. The startup's own submission
    // count and shadow-input answer (fields 71, 72) are a held startup's, so a steady frame pays for neither.
    // Field 85 (the shadow passes' triangles) is the one PRD-770 call that splits main from shadow.
    expect(frame.mock.calls).toHaveLength(38);
    // 73-84 are PRD-771's stage totals; the split read must not reuse one of them.
    expect((frame.mock.calls as unknown as number[][]).map(([field]) => field)).toContain(85);
    expect(malloc).toHaveBeenCalledTimes(1); // existing state-string allocation
    expect(debugTelemetry(module)).toBeUndefined();

    // Only a cover that is waiting reads them: two more host calls while held, and none again after.
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.setPresentationHeld(true);
    frame.mockClear();
    renderer.render(scene, camera);
    expect(frame.mock.calls).toHaveLength(40);
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.setPresentationHeld(false);
    frame.mockClear();
    renderer.render(scene, camera);
    expect(frame.mock.calls).toHaveLength(38);
  });
});

describe("Wasm timestamp sampling", () => {
  it("forwards the current sampling flag before secondary and main draws", async () => {
    const flags: number[] = [];
    const { Renderer, canvas, scene, camera, state, classes } = host(
      (field) => (field === 10 ? 1 : 0),
      () => {
        flags.push(state.mock.calls.at(-1)?.[7] as number);
        return 0;
      },
      (_size, draw) => draw(target as never, scene as never, camera as never),
      () => {
        flags.push(state.mock.calls.at(-1)?.[7] as number);
        return 0;
      },
    );
    const target = new (classes.RenderTarget as new () => object)();
    const renderer = new Renderer({ canvas }) as {
      backend: { trackTimestamp: boolean };
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    };
    await renderer.init();
    for (let frame = 0; frame < 16; frame += 1) {
      renderer.backend.trackTimestamp = frame % 8 === 0;
      renderer.render(scene, camera);
    }
    expect(flags).toEqual(
      Array.from({ length: 16 }, (_, i) => [i % 8 === 0 ? 1 : 0, i % 8 === 0 ? 1 : 0]).flat(),
    );
  });
});
