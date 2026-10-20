/**
 * The Wasm engine's WebGPURenderer over a recording host module (Midway cockpit): `antialias` and
 * `samples` reach the engine. The renderer ignored both, the surface stayed single-sampled, and
 * thin geometry (a canopy rivet bow, a trailing edge) stair-stepped where the three.js build was 4x MSAA.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { type WebEngineModule, defineWebRenderer } from "../src/browser-renderer.js";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";
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
  poll: () => number = () => 1,
) {
  const types = new Map<string, number>();
  const runtime: IBrowserRuntime = {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: (name) => ({ key: `${String(types.get(name) ?? 1)}:0:1:1`, type: 1 }),
    invoke: () => null,
    get: () => undefined,
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
  };
  const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
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
    _tnw_web_poll: poll,
    _tnw_web_adapter: () => 0,
    _tnw_web_error: () => 0,
    _tnw_web_resize: () => 0,
    _tnw_web_render: render,
    _tnw_web_render_target: renderTarget,
    _tnw_web_frame: frame,
    _tnw_web_renderer_state: state,
  } as unknown as WebEngineModule;
  const Renderer = defineWebRenderer(module, classes.Color as never, before, undefined, secondary);
  const canvas = { width: 300, height: 150, style: {}, setAttribute: () => undefined };
  const scene = new (classes.Scene as new () => object)();
  const camera = new (classes.PerspectiveCamera as new () => object)();
  return { Renderer, canvas, scene, camera, state, classes, initCalls };
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
    onGpu = 1;
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    onGpu = 0;
    renderer.render(scene, camera);
    expect(drawnFrames).toHaveLength(2);
    expect(renderer.info.engine.frameGateSkips).toBe(2);
  });
});

describe("the Wasm engine's environment preparation", () => {
  it("draws the held scene until a render is neither gated nor skipped for an unbaked environment", async () => {
    // Pending for two drawn renders, then gated once while two frames are on the GPU, then baked.
    const pending = [1, 1, 0];
    let gateOnce = false;
    let drawn = 0;
    const { Renderer, canvas, scene, camera } = host(
      (field) => {
        if (field === 11 && gateOnce) {
          gateOnce = false;
          return 1;
        }
        return field === 12 ? (pending[drawn - 1] ?? 0) : 0;
      },
      () => {
        drawn += 1;
        if (drawn === 2) gateOnce = true;
        return 0;
      },
    );
    const renderer = new Renderer({ canvas }) as {
      info: { engine: { frameGateSkips: number } };
      init(): Promise<unknown>;
      prepareEnvironmentAsync(scene: unknown, camera: unknown): Promise<boolean>;
    };
    await renderer.init();
    expect(await renderer.prepareEnvironmentAsync(scene, camera)).toBe(true);
    expect(drawn).toBe(3);
    expect(renderer.info.engine.frameGateSkips).toBe(1);
  });
});

describe("the Wasm engine's environment preparation deadline", () => {
  it("gives up at the caller's deadline instead of drawing an unbaked environment forever", async () => {
    let drawn = 0;
    const { Renderer, canvas, scene, camera } = host(
      (field) => (field === 12 ? 1 : 0),
      () => {
        drawn += 1;
        return 0;
      },
    );
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
    const after = drawn;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drawn).toBe(after);
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
