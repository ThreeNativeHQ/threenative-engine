import { Color, Object3D, PerspectiveCamera, Scene } from "three";
import { pass } from "three/tsl";
import { NodeFrame, NodeUpdateType, RenderPipeline } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createRenderer, prewarm } from "../src/renderer.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

describe("createRenderer", () => {
  it("keeps its browser-created canvas layout independent of drawing-buffer scale", async () => {
    const canvas = testCanvas();
    const style = { width: "", height: "" };
    Object.defineProperty(canvas, "style", { value: style });
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => canvas },
    });
    let renderer: Awaited<ReturnType<typeof createRenderer>> | undefined;
    try {
      renderer = await createRenderer({
        preferWebGPU: false,
        resolutionScale: 0.5,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      expect(style).toEqual({ width: "100%", height: "100%" });
    } finally {
      renderer?.dispose();
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
  it("reports the age of the resolved GPU frame without treating a repeated duration as fresh", async () => {
    const canvas = testCanvas();
    const info = { frame: 10, render: { timestamp: 6.25 } };
    let timestampFrames = [7, 8];
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        info,
        backend: { getTimestampFrames: () => timestampFrames },
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      expect(renderer.gpuFrameAge?.()).toBe(2);
      info.frame = 310;
      expect(renderer.gpuFrameMs()).toBe(6.25);
      expect(renderer.gpuFrameAge?.()).toBe(302);
      timestampFrames = [309];
      expect(renderer.gpuFrameAge?.()).toBe(1);
      for (const invalid of [[], [Number.NaN], [311], [-1], [1.5]]) {
        timestampFrames = invalid;
        expect(renderer.gpuFrameAge?.()).toBeUndefined();
      }
      timestampFrames = [309];
      Reflect.deleteProperty(info, "frame");
      expect(renderer.gpuFrameAge?.()).toBeUndefined();
    } finally {
      renderer.dispose();
    }
  });

  it("keeps reading its own frame id when three's animation loop overwrites info.frame", async () => {
    // Three's Renderer.init starts its own rAF loop, which writes `info.frame = nodeFrame.frameId`
    // every animation frame. The timestamp queries are keyed by the engine's counter, so a sample
    // must stay readable when that loop has just written a smaller number.
    const canvas = testCanvas();
    const info = { frame: 0, render: { timestamp: 4.5 } };
    let timestampFrames: number[] = [];
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        info,
        backend: { getTimestampFrames: () => timestampFrames },
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      const scene = new Scene();
      const camera = new PerspectiveCamera();
      for (let frame = 0; frame < 20; frame += 1) renderer.render(scene, camera);
      timestampFrames = [16];
      info.frame = 9;
      expect(renderer.gpuFrameSample?.()).toEqual({ frame: 16, ms: 4.5 });
      expect(renderer.gpuFrameAge?.()).toBe(3);
    } finally {
      renderer.dispose();
    }
  });

  it("smooths the main-pass GPU time and reports it absent once the samples go stale", async () => {
    const canvas = testCanvas();
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        info: { frame: 0 },
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      expect(renderer.gpuMainMs?.()).toBeUndefined();
      renderer.noteGpuMainMs?.(8, 1);
      expect(renderer.gpuMainMs?.()).toBe(8);
      // A repeated frame id is the previous resolve still in flight, not a second measurement.
      renderer.noteGpuMainMs?.(12, 1);
      expect(renderer.gpuMainMs?.()).toBe(8);
      renderer.noteGpuMainMs?.(12, 2);
      expect(renderer.gpuMainMs?.()).toBe(10);
      // No fresh sample for long enough reads absent rather than as the last number forever.
      for (let frame = 0; frame < 8; frame += 1) renderer.noteGpuMainMs?.(undefined);
      expect(renderer.gpuMainMs?.()).toBeUndefined();
    } finally {
      renderer.dispose();
    }
  });

  it("records GPU timestamps on one of every eight renderer frames by default", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const states: boolean[] = [];
    const info = { frame: 0, render: { timestamp: 0 } };
    const backend = { trackTimestamp: false };
    const raw = {
      backend,
      domElement: canvas,
      info,
      init: async () => {
        backend.trackTimestamp = true;
      },
      render: () => states.push(backend.trackTimestamp),
      setSize: () => undefined,
    };
    try {
      const renderer = await createRenderer({ canvas, webgpuFactory: () => raw });
      for (let frame = 0; frame < 16; frame += 1) {
        info.frame = frame;
        renderer.render(new Scene(), new PerspectiveCamera());
      }

      expect(states.filter(Boolean)).toHaveLength(2);
      expect(states.filter((enabled, frame) => enabled && frame % 8 === 0)).toEqual([true, true]);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("uses the named GPU timestamp frame interval override", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const states: boolean[] = [];
    const info = { frame: 0, render: { timestamp: 0 } };
    const backend = { trackTimestamp: false };
    const raw = {
      backend,
      domElement: canvas,
      info,
      init: async () => {
        backend.trackTimestamp = true;
      },
      render: () => states.push(backend.trackTimestamp),
      setSize: () => undefined,
    };
    try {
      const renderer = await createRenderer({
        canvas,
        gpuTimestampFrameInterval: 3,
        webgpuFactory: () => raw,
      });
      for (let frame = 0; frame < 6; frame += 1) {
        info.frame = frame;
        renderer.render(new Scene(), new PerspectiveCamera());
      }

      expect(states).toEqual([true, false, false, true, false, false]);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("keeps an eight-frame-old GPU sample available to the renderer", async () => {
    const canvas = testCanvas();
    const info = { frame: 8, render: { timestamp: 6.25 } };
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        info,
        backend: { getTimestampFrames: () => [0] },
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      expect(renderer.gpuFrameMs()).toBe(6.25);
      expect(renderer.gpuFrameAge?.()).toBe(8);
    } finally {
      renderer.dispose();
    }
  });

  it("defers platform resize and reports the old buffer until compilation releases it", async () => {
    const canvas = testCanvas();
    let resize = () => {};
    let width = 320;
    let finish = () => {};
    const sizes: number[] = [];
    const renderer = await createRenderer({
      source: {
        createCanvas: () => canvas,
        hasWebGPU: () => false,
        readSize: () => [width, 180],
        observeResize: (_canvas, callback) => {
          resize = callback;
          return () => {};
        },
      },
      webgl2Factory: () => ({
        domElement: canvas,
        render: () => undefined,
        setSize: (nextWidth: number) => {
          sizes.push(nextWidth);
        },
        compileAsync: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      }),
    });
    const compilation = renderer.compileAsync(new Scene(), new PerspectiveCamera());
    try {
      expect(
        renderer.gpuFrameAge?.(),
        "a renderer without a timestamp backend has no age",
      ).toBeUndefined();
      width = 640;
      resize();
      width = 800;
      resize();
      expect(sizes).toEqual([320]);
      expect(renderer.surface().drawingBufferWidth).toBe(320);
      finish();
      await compilation;
      expect(sizes).toEqual([320, 800]);
      expect(renderer.surface().drawingBufferWidth).toBe(800);
    } finally {
      finish();
      await compilation;
      renderer.dispose();
    }
  });

  it("stops scheduling hidden-root compilation and deferred resize after disposal", async () => {
    const canvas = testCanvas();
    let finish = () => {};
    const calls: Object3D[] = [];
    const sizes: number[] = [];
    let disposed = false;
    const first = new Object3D();
    const second = new Object3D();
    const hidden = new Object3D();
    hidden.visible = false;
    hidden.add(first, second);
    const scene = new Scene();
    scene.add(hidden);
    prewarm([first, second]);
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        render: () => undefined,
        dispose: () => {
          disposed = true;
        },
        setSize: (width: number) => {
          sizes.push(width);
        },
        compileAsync: async (root: Object3D) => {
          calls.push(root);
          if (calls.length === 1)
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
        },
      }),
    });
    const compilation = renderer.compileAsync(scene, new PerspectiveCamera());
    renderer.setResolutionScale(0.61, "auto");
    renderer.dispose();
    expect(disposed).toBe(true);
    finish();
    await compilation;
    expect(calls).toEqual([first]);
    expect(sizes).toEqual([320]);
  });
  it.each([false, true])(
    "keeps resolution targets alive until pending compilation settles (reject=%s)",
    async (reject) => {
      const canvas = testCanvas();
      let finish: (() => void) | undefined;
      let targetAlive = true;
      let compiling = false;
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => {
            if (compiling) targetAlive = false;
          },
          compileAsync: async () => {
            compiling = true;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            const retained = targetAlive;
            compiling = false;
            if (!retained) throw new Error("compile read a disposed depth target");
            if (reject) throw new Error("compile failed independently");
          },
        }),
      });
      const compilation = renderer.compileAsync(new Scene(), new PerspectiveCamera());
      const settled = compilation.catch((error: Error) => error.message);
      try {
        expect(renderer.compiling).toBe(true);
        expect(renderer.surface()).toMatchObject({ compiling: true });
        renderer.setResolutionScale(0.61, "auto");
        expect(renderer.surface()).toMatchObject({ resolutionScale: 1, drawingBufferWidth: 320 });
        finish?.();
        expect(await settled).toBe(reject ? "compile failed independently" : undefined);
        expect(renderer.compiling).toBe(false);
        expect(renderer.surface()).toMatchObject({
          resolutionScale: 0.61,
          drawingBufferWidth: 195,
        });
      } finally {
        finish?.();
        await settled;
        renderer.dispose();
      }
    },
  );
  // Without this on the wrapper a game must cast through `.raw` to warm up, and a game that
  // cannot warm up without a cast will not warm up. 2,500 ms of a 2,882 ms Pixel 8 cold start is
  // spent compiling pipelines on first draw.
  it("forwards compileAsync so a game can warm up pipelines before the first visible frame", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      const warmed: unknown[] = [];
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: async (...args: unknown[]) => {
            warmed.push(args);
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const scene = {} as never;
      const camera = {} as never;
      const targetScene = {} as never;
      await renderer.compileAsync(scene, camera, targetScene);
      expect(warmed).toEqual([[scene, camera, targetScene]]);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("binds the frame-buffer target while compiling, so a depth sampler is not compiled against the wrong sample count", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      // three's own compile() reads the frame-buffer target for its render context but never binds
      // it, so a viewport-depth copy destination is sized from that target while the bind group
      // layout for the same binding is sized from `currentSamples`. Dawn refuses the bind group and
      // the device is lost. The wrapper has to bind what is being compiled for, and put back what
      // was bound.
      const frameBufferTarget = { samples: 4 };
      const seenDuringCompile: unknown[] = [];
      // What a concurrent frame sees. three's compile yields to the render loop between objects, so
      // this must not move while the compile runs.
      const rendered: unknown[] = [];
      const raw: Record<string, unknown> = {
        needsFrameBufferTarget: true,
        _renderTarget: null,
        getRenderTarget(this: Record<string, unknown>) {
          return this._renderTarget;
        },
        _getFrameBufferTarget: () => frameBufferTarget,
        compileAsync: async () => {
          seenDuringCompile.push((raw.getRenderTarget as () => unknown).call(raw));
          rendered.push(raw._renderTarget);
        },
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      };
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => raw as never,
      });
      await renderer.compileAsync({} as never, {} as never);
      // The sample-count question is answered ...
      expect(seenDuringCompile).toEqual([frameBufferTarget]);
      // ... without moving what a frame arriving mid-compile renders into.
      expect(rendered).toEqual([null]);
      // and the accessor is handed back afterwards.
      expect((raw.getRenderTarget as () => unknown).call(raw)).toBe(null);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("leaves no frame-buffer target behind when two compiles overlap", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      // Two compiles do overlap in a real launch: the framework's own warm-up runs while a game
      // warms its own views, and this fork's compile yields to the frame loop between objects. The
      // second compile then captures the first one's override as "what was here before" and puts it
      // back when it finishes, so `getRenderTarget()` answers the frame-buffer target forever after.
      // Nothing is drawn into the swapchain from then on: measured as a game that renders at 59 fps
      // with its presents frozen at 160 and a five-second-old picture on the screen.
      const frameBufferTarget = { samples: 4 };
      let bound: unknown = null;
      let release: (() => void) | undefined;
      const firstCompileStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      let compiles = 0;
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          needsFrameBufferTarget: true,
          getRenderTarget: () => bound,
          setRenderTarget: (target: unknown) => {
            bound = target;
          },
          _getFrameBufferTarget: () => frameBufferTarget,
          compileAsync: async () => {
            compiles += 1;
            // The first compile stays open across the second one's whole lifetime.
            if (compiles === 1) await firstCompileStarted;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const first = renderer.compileAsync({} as never, {} as never);
      await renderer.compileAsync({} as never, {} as never);
      release?.();
      await first;
      // The renderer must be exactly as it was found: a frame that renders now goes to the screen.
      expect((renderer.raw as { getRenderTarget: () => unknown }).getRenderTarget()).toBe(null);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("hides the compile-time render target from frames that run while the compile yields", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      // This fork's compile yields to the frame loop between objects, so frames really do run
      // inside the window where `getRenderTarget` is answering the compile's question. three's own
      // reflector saves `renderer.getRenderTarget()` at the top of its `updateBefore` and restores
      // it after drawing its mirror — so if it sees the frame-buffer target it puts the
      // frame-buffer target back, and every later frame renders into it instead of the swapchain.
      //
      // Measured before this guard, on a game whose water has a reflection: the swapchain image
      // was never acquired again after the first world frame (`TN_FRAME_NOT_PRESENTED` with
      // `texture:false`), presents froze at 137 while the loop ran at 59 fps, and the window kept
      // showing the loading screen for the rest of the session.
      const frameBufferTarget = { samples: 4 };
      let bound: unknown = null;
      const seenByCompile: unknown[] = [];
      const seenByFrame: unknown[] = [];
      const hooks: { renderDuringCompile?: () => void; reflectInsideFrame?: () => void } = {};
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          needsFrameBufferTarget: true,
          getRenderTarget: () => bound,
          setRenderTarget: (target: unknown) => {
            bound = target;
          },
          _getFrameBufferTarget: () => frameBufferTarget,
          compileAsync: async (): Promise<void> => {
            seenByCompile.push(
              (renderer.raw as { getRenderTarget: () => unknown }).getRenderTarget(),
            );
            // The yield three's compile makes between objects: a frame lands here.
            hooks.renderDuringCompile?.();
            await Promise.resolve();
          },
          domElement: canvas,
          render: () => hooks.reflectInsideFrame?.(),
          setSize: () => undefined,
        }),
      });
      // A frame, through the renderer the game holds — and inside it, what three's reflector does
      // exactly: save the bound target, draw its mirror elsewhere, put back what it saved.
      hooks.reflectInsideFrame = () => {
        const raw = renderer.raw as {
          getRenderTarget: () => unknown;
          setRenderTarget: (target: unknown) => void;
        };
        const saved = raw.getRenderTarget();
        seenByFrame.push(saved);
        raw.setRenderTarget({ mirror: true });
        raw.setRenderTarget(saved);
      };
      hooks.renderDuringCompile = () => renderer.render({} as never, {} as never);
      await renderer.compileAsync({} as never, {} as never);

      // The compile still gets its answer...
      expect(seenByCompile).toEqual([frameBufferTarget]);
      // ...and a frame running inside the same window sees the screen, and restores the screen.
      expect(seenByFrame).toEqual([null]);
      expect((renderer.raw as { getRenderTarget: () => unknown }).getRenderTarget()).toBe(null);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("leaves the screen bound when a node's own pass saves and restores inside the compile", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      // three's compile runs node `updateBefore` hooks, and a reflector's does exactly this: save
      // `getRenderTarget()`, draw its mirror into its own target, put back what it saved. Inside a
      // compile that answer is the frame-buffer target, so it gets *bound* and stays bound — and
      // every frame after it renders into that target instead of the swapchain. Measured: presents
      // frozen at 137 with the loop still at 59 fps, and the window stuck on the loading screen.
      const frameBufferTarget = { samples: 4 };
      let bound: unknown = null;
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          needsFrameBufferTarget: true,
          getRenderTarget: () => bound,
          setRenderTarget: (target: unknown) => {
            bound = target;
          },
          _getFrameBufferTarget: () => frameBufferTarget,
          compileAsync: async (): Promise<void> => {
            const raw = renderer.raw as {
              getRenderTarget: () => unknown;
              setRenderTarget: (target: unknown) => void;
            };
            const saved = raw.getRenderTarget();
            raw.setRenderTarget({ mirror: true });
            raw.setRenderTarget(saved);
            await Promise.resolve();
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      await renderer.compileAsync({} as never, {} as never);
      // Nothing is bound, so the next frame goes to the screen.
      expect(bound).toBe(null);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("binds the screen before every surface frame, whatever a warm-up or a pass left bound", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      // `getRenderTarget()` answers null across the compile window while the field stays stale, and
      // a later pass can leave one bound again; neither belongs on the screen.
      const frameBufferTarget = { samples: 4 };
      const staleTarget = { name: "stale" };
      let bound: unknown = null;
      let insideCompileWindow = false;
      const seenAtDraw: unknown[] = [];
      const hooks: { frameDuringCompile?: () => void } = {};
      const setTarget = (target: unknown): void => {
        bound = target;
      };
      const raw: Record<string, unknown> = {
        needsFrameBufferTarget: true,
        get _renderTarget() {
          return bound;
        },
        getRenderTarget(this: Record<string, unknown>) {
          return insideCompileWindow ? null : this._renderTarget;
        },
        setRenderTarget: setTarget,
        _getFrameBufferTarget: () => frameBufferTarget,
        compileAsync: async () => {
          insideCompileWindow = true;
          try {
            setTarget(staleTarget);
            hooks.frameDuringCompile?.();
            await Promise.resolve();
          } finally {
            insideCompileWindow = false;
          }
        },
        domElement: canvas,
        render: () => {
          seenAtDraw.push(bound);
        },
        setSize: () => undefined,
      };
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => raw as never,
      });
      hooks.frameDuringCompile = () => renderer.render({} as never, {} as never);
      await renderer.compileAsync({} as never, {} as never);
      renderer.render({} as never, {} as never);
      // A later pass leaves one bound again, and the overlay is a surface draw like the world.
      setTarget(staleTarget);
      renderer.renderOverlay({} as never, {} as never);

      // The frame that overlapped the compile, the frame after it, and the overlay all drew to the
      // screen rather than to the stale target.
      expect(seenAtDraw).toEqual([null, null, null]);
      expect(bound).toBe(null);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("records the actual WebGPU adapter identity in the pipeline census", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const adapter = {
      info: {
        architecture: "rdna3",
        description: "Acme Discrete GPU",
        device: "gpu-42",
        vendor: "acme",
      },
    };
    const requestAdapter = vi.fn(async () => adapter);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          backend: { gpu: { requestAdapter } },
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });

      expect(renderer.pipelineCensus?.().adapter.identity).toContain("vendor=acme");
      expect(renderer.pipelineCensus?.().adapter.identity).toContain("device=gpu-42");
      expect(renderer.pipelineCensus?.().adapter.identity).not.toBe("webgpu:Object");
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  // A game cannot ask `navigator.gpu` what it is running on without becoming the thing that has to
  // know about WebGPU, a platform seam and the driver strings each one uses, so the fact rides on
  // the renderer it already has. A `swiftshader` adapter running the desktop tier has been measured
  // losing the device inside its first frame — a tier the game could have chosen differently had
  // anything told it.
  it.each([
    ["architecture", "swiftshader"],
    ["description", "llvmpipe (LLVM 15.0.7, 256 bits)"],
    ["device", "Microsoft Basic Render Driver"],
  ])("names a software adapter reported in %s", async (field, value) => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requestAdapter = vi.fn(async () => ({
      info: { architecture: "", description: "", device: "", vendor: "", [field]: value },
    }));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          backend: { gpu: { requestAdapter } },
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });

      expect(renderer.softwareAdapter).toBe(value);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("classifies the adapter and prints TN_GPU_CLASS once with the rule and raw fields", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const info = {
      architecture: "bifrost",
      description: "Mali-G52 MC2",
      device: "",
      vendor: "arm",
    };
    const requestAdapter = vi.fn(async () => ({ info }));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    const lines: string[] = [];

    try {
      const renderer = await createRenderer({
        canvas,
        report: (line) => lines.push(line),
        webgpuFactory: () => ({
          backend: { gpu: { requestAdapter } },
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });

      expect(renderer.gpuClass).toEqual({ class: "mobile-low", fields: info, rule: "mali-model" });
      expect(lines.filter((line) => line.startsWith("TN_GPU_CLASS:"))).toEqual([
        `TN_GPU_CLASS:${JSON.stringify(renderer.gpuClass)}`,
      ]);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("reports no gpuClass when the renderer fell back to WebGL2", async () => {
    const canvas = testCanvas();
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    expect(renderer.gpuClass).toBeUndefined();
    renderer.dispose();
  });

  it("reports no software adapter for a hardware one rather than claiming a proof", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requestAdapter = vi.fn(async () => ({
      info: { architecture: "turing", description: "Acme GPU", device: "gpu-42", vendor: "acme" },
    }));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          backend: { gpu: { requestAdapter } },
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });

      expect(renderer.softwareAdapter).toBeUndefined();
      expect(renderer.pipelineCensus?.().adapter.identity).toContain("vendor=acme");
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  // A renderer that compiles on first draw needs no warm-up and must not fail one. Throwing here
  // would push a platform branch into every game that calls it.
  it("resolves quietly when the renderer has no compileAsync of its own", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      await expect(renderer.compileAsync({} as never, {} as never)).resolves.toBeUndefined();
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("should fall back to WebGL2 when navigator.gpu is absent", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    let size: [number, number] | undefined;
    let disposed = false;

    try {
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: true,
        webgl2Factory: () => ({
          dispose: () => {
            disposed = true;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: (width: number, height: number) => {
            size = [width, height];
          },
        }),
      });

      expect(renderer.kind).toBe("webgl2");
      expect(size).toEqual([320, 180]);
      renderer.dispose();
      expect(disposed).toBe(true);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("should use an explicit resolution scale while keeping CSS size unchanged", async () => {
    const canvas = testCanvas();
    const sizes: Array<[number, number]> = [];
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      resolutionScale: 0.5,
      webgl2Factory: () => ({
        dispose: () => undefined,
        domElement: canvas,
        render: () => undefined,
        setSize: (width: number, height: number) => sizes.push([width, height]),
      }),
    });

    expect(sizes).toEqual([[160, 90]]);
    renderer.dispose();
  });

  it("forwards the requested antialias setting to renderer backends", async () => {
    const canvas = testCanvas();
    const received: boolean[] = [];
    const renderer = await createRenderer({
      antialias: false,
      canvas,
      preferWebGPU: false,
      webgl2Factory: (_canvas, options) => {
        received.push(options.antialias);
        return {
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        };
      },
    });

    expect(received).toEqual([false]);
    renderer.dispose();
  });

  it("should reject an invalid resolution scale at construction", async () => {
    await expect(createRenderer({ resolutionScale: 0 })).rejects.toThrow(
      "renderer.resolutionScale must be finite and positive.",
    );
  });

  it("dispatches compute only through WebGPU and fails closed on WebGL2", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const dispatched: unknown[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });

    try {
      const webgpu = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          compute: (node: unknown) => dispatched.push(node),
          dispose: () => undefined,
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const node = {};
      webgpu.compute(node);
      expect(dispatched).toEqual([node]);
      const originalRender = (webgpu.raw as { render: () => void }).render;
      expect(() => webgpu.setOutputNode({})).not.toThrow();
      expect((webgpu.raw as { render: () => void }).render).toBe(originalRender);
      webgpu.dispose();

      const webgl = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      expect(() => webgl.compute(node)).toThrow("webgl2");
      expect(() => webgl.setOutputNode({})).toThrow("webgl2");
      webgl.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("does not let an obsolete output owner clear its replacement", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});
    const rawRender = vi.fn();
    const renderer = await createRenderer({
      canvas,
      webgpuFactory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: rawRender,
        setSize: () => undefined,
      }),
    });
    try {
      const first = {};
      const replacement = {};
      renderer.setOutputNode(first);
      renderer.setOutputNode(replacement);
      renderer.clearOutputNode?.(first);
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(renderPipeline).toHaveBeenCalledTimes(1);
      expect(rawRender).not.toHaveBeenCalled();
      renderer.clearOutputNode?.(replacement);
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(rawRender).toHaveBeenCalledTimes(1);
      // Legacy no-argument calls keep their unconditional behavior.
      renderer.setOutputNode(first);
      renderer.clearOutputNode?.();
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(rawRender).toHaveBeenCalledTimes(2);
    } finally {
      renderer.dispose();
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("keeps a direct replacement when an older render chain is disposed", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});
    const rawRender = vi.fn();
    const renderer = await createRenderer({
      canvas,
      webgpuFactory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: rawRender,
        setSize: () => undefined,
      }),
    });
    try {
      const previous = renderer.createRenderChain?.({
        input: {},
        request: { stages: ["bloom"], tier: "high" },
        stages: [{ name: "bloom", build: (input) => input }],
      });
      expect(previous?.applied.stages).toEqual(["bloom"]);
      const direct = {};
      renderer.setOutputNode(direct);
      previous?.dispose();
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(renderPipeline).toHaveBeenCalledTimes(1);
      expect(rawRender).not.toHaveBeenCalled();
      renderer.clearOutputNode?.(direct);
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(rawRender).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("does not resurrect a superseded automatic chain during budget observation", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});
    const renderer = await createRenderer({
      canvas,
      webgpuFactory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: () => {},
        setSize: () => undefined,
      }),
    });
    try {
      const build = vi.fn((input) => input);
      const previous = renderer.createRenderChain?.({
        input: {},
        request: { stages: ["bloom"], tier: "auto" },
        stages: [{ name: "bloom", build }],
      });
      renderer.setOutputNode({});
      for (let index = 0; index < 4; index += 1) {
        renderer.observeRenderChainBudget?.({ phases: { render: { p95: 40 } } });
        renderer.observeRenderChainFrame?.();
      }
      expect(build).toHaveBeenCalledTimes(1);
      expect(previous?.disposed).toBe(false);
      previous?.dispose();
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(renderPipeline).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("gives same-node output installations distinct ownership receipts", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});
    const rawRender = vi.fn();
    const renderer = await createRenderer({
      canvas,
      webgpuFactory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: rawRender,
        setSize: () => undefined,
      }),
    });
    try {
      const shared = {};
      const first = renderer.setOutputNode(shared);
      const second = renderer.setOutputNode(shared);
      if (!first || !second) throw new Error("Missing installation receipt");
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(true);
      first.dispose();
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(renderPipeline).toHaveBeenCalledTimes(1);
      second.dispose();
      second.dispose();
      expect(second.isCurrent()).toBe(false);
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(rawRender).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("does not observe or clear an obsolete chain after a same-node direct reinstall", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});
    const renderer = await createRenderer({
      canvas,
      webgpuFactory: () => ({
        domElement: canvas,
        init: async () => undefined,
        render: () => {},
        setSize: () => undefined,
      }),
    });
    try {
      const shared = {};
      const build = vi.fn((input) => input);
      const chain = renderer.createRenderChain?.({
        input: shared,
        request: { stages: ["bloom"], tier: "auto" },
        stages: [{ name: "bloom", build }],
      });
      renderer.setOutputNode(shared);
      for (let index = 0; index < 2; index += 1)
        renderer.observeRenderChainBudget?.({ phases: { render: { p95: 40 } } });
      expect(build).toHaveBeenCalledTimes(1);
      chain?.dispose();
      renderer.render(new Scene(), new PerspectiveCamera());
      expect(renderPipeline).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("replaces and disposes only the framework-owned output pipeline", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    let disposed = 0;
    const originalRender = () => undefined;

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          compute: () => undefined,
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          init: async () => undefined,
          render: originalRender,
          setSize: () => undefined,
          toneMapping: 0,
        }),
      });
      const raw = renderer.raw as { render: () => void };
      expect(raw.render).toBe(originalRender);
      renderer.setOutputNode({});
      renderer.setOutputNode({});
      expect(raw.render).toBe(originalRender);
      renderer.dispose();
      expect(disposed).toBe(1);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("retargets the explicit world pass when the rendered scene changes", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    const renderPipeline = vi
      .spyOn(RenderPipeline.prototype, "render")
      .mockImplementation(() => {});

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const sceneA = new Scene();
      const sceneB = new Scene();
      const cameraA = new PerspectiveCamera();
      const cameraB = new PerspectiveCamera();
      const worldPass = pass(sceneA, cameraA);
      const auxiliaryPass = pass(new Scene(), new PerspectiveCamera());
      const outputNode = worldPass.add(auxiliaryPass);

      renderer.setOutputNode(outputNode, worldPass);
      renderer.render(sceneA, cameraA);
      renderer.render(sceneB, cameraB);

      expect(renderPipeline).toHaveBeenCalledTimes(2);
      expect(worldPass.scene).toBe(sceneB);
      expect(worldPass.camera).toBe(cameraB);
      expect(auxiliaryPass.scene).not.toBe(sceneB);
      renderer.dispose();
    } finally {
      renderPipeline.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it.each([
    { throws: false, nextFrame: false },
    { throws: false, nextFrame: true },
    { throws: true, nextFrame: false },
    { throws: true, nextFrame: true },
  ])(
    "refreshes a scoped world warm-up and its following main render in one outer render with nested post passes: %j",
    async ({ throws, nextFrame }) => {
      const canvas = testCanvas();
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: {} },
      });
      const nodeFrame = new NodeFrame();
      nodeFrame.frameId = 1;
      const draws: {
        scene: Object3D;
        visibleObjects: string[];
        target: unknown;
        warm: boolean;
      }[] = [];
      const canvasSubmissions: Object3D[] = [];
      let boundTarget: unknown = null;
      let boundMrt: unknown = null;
      let warm = false;
      let targetScene: Scene | undefined;
      let worldPass: ReturnType<typeof pass> | undefined;
      const renderPipeline = vi.spyOn(RenderPipeline.prototype, "render").mockImplementation(() => {
        nodeFrame.renderId += 1;
        if (worldPass === undefined) throw new Error("Missing world pass");
        nodeFrame.updateBeforeNode(worldPass);
        // Bloom/temporal quads sample the same pass under a new renderId.
        nodeFrame.renderId += 1;
        nodeFrame.updateBeforeNode(worldPass);
        if (!warm) canvasSubmissions.push(worldPass.scene as Object3D);
      });
      const rawRender = (scene: Object3D): void => {
        draws.push({
          scene,
          visibleObjects: scene.children
            .filter((child) => child.visible)
            .map((child) => child.name),
          target: boundTarget,
          warm,
        });
        if (throws && warm && scene === targetScene) throw new Error("scoped warm failed");
      };
      const raw = {
        _renderTarget: boundTarget,
        autoClear: true,
        contextNode: null,
        dispose: () => undefined,
        domElement: canvas,
        getActiveCubeFace: () => 0,
        getActiveMipmapLevel: () => 0,
        getClearAlpha: () => 1,
        getClearColor: (target: Color) => target.set(0),
        getDrawingBufferSize: (size: { set: (width: number, height: number) => unknown }) =>
          size.set(320, 180),
        getMRT: () => boundMrt,
        getOutputRenderTarget: () => null,
        getPixelRatio: () => 1,
        getRenderObjectFunction: () => null,
        getRenderTarget: () => boundTarget,
        getScissorTest: () => false,
        init: async () => undefined,
        opaque: false,
        outputColorSpace: "srgb",
        render: rawRender,
        setClearColor: () => undefined,
        setMRT: (value: unknown) => {
          boundMrt = value;
        },
        setPixelRatio: () => undefined,
        setRenderObjectFunction: () => undefined,
        setRenderTarget: (value: unknown) => {
          boundTarget = value;
          raw._renderTarget = value;
        },
        setScissorTest: () => undefined,
        setSize: () => undefined,
        toneMapping: 0,
        toneMappingExposure: 1,
        transparent: false,
        xr: { enabled: false },
      };
      nodeFrame.renderer = raw as never;

      try {
        const renderer = await createRenderer({ canvas, webgpuFactory: () => raw });
        const authoredScene = new Scene();
        const authoredCamera = new PerspectiveCamera();
        worldPass = pass(authoredScene, authoredCamera);
        const outputNode = worldPass.add(pass(new Scene(), new PerspectiveCamera()));
        renderer.setOutputNode(outputNode, worldPass);
        const authoredUpdateBeforeType = worldPass.updateBeforeType;
        const authoredUpdateBefore = worldPass.updateBefore;
        const hadOwnUpdateBefore = Object.hasOwn(worldPass, "updateBefore");
        expect(authoredUpdateBeforeType).toBe(NodeUpdateType.FRAME);
        targetScene = new Scene();
        const terrain = new Object3D();
        terrain.name = "terrain";
        targetScene.add(terrain);
        const worldObject = new Object3D();
        worldObject.name = "world-object";
        targetScene.add(worldObject);
        const chunk = new Object3D();
        chunk.name = "requested-chunk";

        renderer.render(authoredScene, authoredCamera);
        const warmStart = canvasSubmissions.length;
        warm = true;
        const warmUp = () =>
          renderer.warmUpWorldPass?.(chunk, new PerspectiveCamera(), targetScene);
        if (throws) expect(warmUp).toThrow("scoped warm failed");
        else warmUp();
        warm = false;

        expect(worldPass.updateBeforeType).toBe(authoredUpdateBeforeType);
        expect(canvasSubmissions).toHaveLength(warmStart);
        expect(draws[1]?.scene).toBe(targetScene);
        expect(draws[1]?.visibleObjects).toEqual(["terrain", "world-object", "requested-chunk"]);
        expect(draws[1]?.target).not.toBeNull();
        expect(draws[1]?.warm).toBe(true);

        if (nextFrame) nodeFrame.frameId += 1;
        renderer.render(authoredScene, authoredCamera);
        expect(worldPass.updateBefore).toBe(authoredUpdateBefore);
        expect(Object.hasOwn(worldPass, "updateBefore")).toBe(hadOwnUpdateBefore);
        expect(draws.map((draw) => draw.scene)).toEqual([
          authoredScene,
          targetScene,
          authoredScene,
        ]);
        expect(draws[2]?.visibleObjects).toEqual([]);
        expect(canvasSubmissions).toEqual([authoredScene, authoredScene]);
        expect(worldPass.updateBeforeType).toBe(authoredUpdateBeforeType);
        renderer.dispose();
      } finally {
        renderPipeline.mockRestore();
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
        else Object.defineProperty(globalThis, "navigator", descriptor);
      }
    },
  );

  it.each([false, true])(
    "warms a scoped output pass offscreen and restores state after %s failure",
    async (throws) => {
      const canvas = testCanvas();
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { gpu: {} },
      });
      let boundTarget: unknown = "previous-target";
      let boundMrt: unknown = "previous-mrt";
      let renderObjectFunction: ((...args: unknown[]) => void) | null = null;
      let pixelRatio = 1;
      let clearAlpha = 0.25;
      let scissorTest = true;
      const clearColor = new Color(0x123456);
      const targetCalls: unknown[] = [];
      let chunk: Object3D | undefined;
      let worldPass: ReturnType<typeof pass> | undefined;
      let invokePassUpdate: (() => void) | undefined;
      let seenScene: unknown;
      let seenChunkParent: unknown;
      const originalContextNode = { getFlowContextData: () => ({ original: true }) };
      const rawRender = vi.fn(() => {
        seenScene = worldPass?.scene;
        seenChunkParent = chunk?.parent;
        const update = invokePassUpdate;
        invokePassUpdate = undefined;
        update?.();
        if (throws) throw new Error("covered output render failed");
      });
      const raw = {
        _renderTarget: boundTarget,
        autoClear: false,
        compute: () => undefined,
        contextNode: originalContextNode,
        dispose: () => undefined,
        domElement: canvas,
        getActiveCubeFace: () => 3,
        getActiveMipmapLevel: () => 2,
        getClearAlpha: () => clearAlpha,
        getClearColor: (target: Color) => target.copy(clearColor),
        getMRT: () => boundMrt,
        getPixelRatio: () => pixelRatio,
        getDrawingBufferSize: (size: { set: (width: number, height: number) => unknown }) =>
          size.set(320, 180),
        getOutputRenderTarget: () => null,
        getRenderObjectFunction: () => renderObjectFunction,
        // Match compileAsync's temporary getter without changing the bound target.
        getRenderTarget: () => "compiler-target",
        getScissorTest: () => scissorTest,
        init: async () => undefined,
        opaque: false,
        outputColorSpace: "original-output-color-space",
        render: rawRender,
        setMRT: (value: unknown) => {
          boundMrt = value;
        },
        setClearColor: (value: Color, alpha?: number) => {
          clearColor.copy(value);
          if (alpha !== undefined) clearAlpha = alpha;
        },
        setPixelRatio: (value: number) => {
          pixelRatio = value;
        },
        setRenderObjectFunction: (value: ((...args: unknown[]) => void) | null) => {
          renderObjectFunction = value;
        },
        setRenderTarget: (value: unknown) => {
          targetCalls.push(value);
          boundTarget = value;
          raw._renderTarget = value;
        },
        setScissorTest: (value: boolean) => {
          scissorTest = value;
        },
        setSize: () => undefined,
        toneMapping: 17,
        transparent: false,
        xr: { enabled: true },
      };

      try {
        const renderer = await createRenderer({ canvas, webgpuFactory: () => raw });
        const authoredScene = new Scene();
        const authoredCamera = new PerspectiveCamera();
        worldPass = pass(authoredScene, authoredCamera);
        const outputNode = worldPass.add(pass(new Scene(), new PerspectiveCamera()));
        worldPass.name = "warm-world-pass";
        worldPass.contextNode = { getFlowContextData: () => ({ pass: true }) } as never;
        worldPass.overrideMaterial = {} as never;
        worldPass.setLayers({ mask: 2 } as never);
        renderer.setOutputNode(outputNode, worldPass);

        const targetScene = new Scene();
        chunk = new Object3D();
        chunk.position.set(3, 4, 5);
        const originalMatrix = chunk.matrix.clone();
        const camera = new PerspectiveCamera();
        const originalCameraMask = camera.layers.mask;
        targetScene.name = "target-scene";
        targetScene.overrideMaterial = {} as never;
        const originalTargetName = targetScene.name;
        const targetOverrideMaterial = targetScene.overrideMaterial;
        invokePassUpdate = () => worldPass?.updateBefore({ renderer: raw } as never);

        const warm = () => renderer.warmUpWorldPass?.(chunk as Object3D, camera, targetScene);
        if (throws) expect(warm).toThrow("covered output render failed");
        else warm();

        expect(seenScene).toBe(targetScene);
        expect(seenChunkParent).toBe(targetScene);
        expect(worldPass.scene).toBe(authoredScene);
        expect(worldPass.camera).toBe(authoredCamera);
        expect(chunk.parent).toBeNull();
        expect(chunk.matrix.equals(originalMatrix)).toBe(true);
        expect(boundTarget).toBe("previous-target");
        expect(boundMrt).toBe("previous-mrt");
        expect(raw.autoClear).toBe(false);
        expect(raw.transparent).toBe(false);
        expect(raw.opaque).toBe(false);
        expect(raw.contextNode).toBe(originalContextNode);
        expect(raw.toneMapping).toBe(17);
        expect(raw.outputColorSpace).toBe("original-output-color-space");
        expect(raw.xr.enabled).toBe(true);
        expect(camera.layers.mask).toBe(originalCameraMask);
        expect(targetScene.name).toBe(originalTargetName);
        expect(targetScene.overrideMaterial).toBe(targetOverrideMaterial);
        expect(targetCalls.length).toBeGreaterThan(0);
        expect(targetCalls).not.toContain(null);
        expect(rawRender).toHaveBeenCalled();
        renderer.dispose();
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
        else Object.defineProperty(globalThis, "navigator", descriptor);
      }
    },
  );

  it("rejects an output graph with multiple passes when no world pass is named", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const outputNode = pass(new Scene(), new PerspectiveCamera()).add(
        pass(new Scene(), new PerspectiveCamera()),
      );

      expect(() => renderer.setOutputNode(outputNode)).toThrow("TN_RENDER_OUTPUT_PASS_AMBIGUOUS");
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("feeds automatic render-chain tiers from the renderer's frame-budget observer", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });

    try {
      const renderer = await createRenderer({
        canvas,
        webgpuFactory: () => ({
          domElement: canvas,
          init: async () => undefined,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      const chain = renderer.createRenderChain?.({
        input: {},
        request: { stages: ["bloom"], tier: "auto" },
        stages: [{ build: (input) => input, name: "bloom" }],
      });
      if (chain === undefined || renderer.observeRenderChainBudget === undefined)
        throw new Error("render-chain observer is unavailable");

      renderer.observeRenderChainBudget({ phases: { render: { p95: 30 } } });
      renderer.observeRenderChainBudget({ phases: { render: { p95: 30 } } });

      expect(chain.applied.tier).toBe("medium");
      renderer.dispose();
      expect(chain.disposed).toBe(true);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("draws an overlay without clearing or entering the world output pipeline", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    const calls: Array<{ autoClear: boolean | undefined; camera: unknown; scene: unknown }> = [];

    try {
      const raw = {
        autoClear: true,
        compute: () => undefined,
        domElement: canvas,
        init: async () => undefined,
        render(scene: unknown, camera: unknown) {
          calls.push({ autoClear: this.autoClear, camera, scene });
        },
        setSize: () => undefined,
      };
      const renderer = await createRenderer({ canvas, webgpuFactory: () => raw });
      const scene = {} as never;
      const camera = {} as never;
      renderer.setOutputNode({});

      renderer.renderOverlay(scene, camera);

      expect(calls).toEqual([{ autoClear: false, camera, scene }]);
      expect(raw.autoClear).toBe(true);
      renderer.dispose();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });
});

describe("renderer info", () => {
  it("exposes the underlying renderer's info through the wrapper", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      const info = { render: { drawCalls: 7, triangles: 12 } };
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
          info,
        }),
      });
      expect(renderer.info).toBe(info);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("throws when the underlying renderer has no info instead of returning undefined", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      const renderer = await createRenderer({
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      });
      expect(() => renderer.info).toThrow(/info is unavailable on the webgl2 renderer/u);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });
});

/**
 * `compileAsync` builds pipelines, not pixels, so a streamed chunk's textures reached the device
 * inside `_renderObjectDirect` on the frame the chunk first drew. `uploadTextures` moves that to
 * admission, and through three's own `Textures.updateTexture` rather than the backend's, because that
 * path owns the bookkeeping (`initialized`, `generation`) the first draw reads to skip the upload.
 */
describe("uploadTextures", () => {
  const textured = (): Scene => {
    const scene = new Scene();
    const mesh = new Object3D();
    const map = { isTexture: true, version: 1 };
    const normal = { isTexture: true, version: 1 };
    (mesh as unknown as { material: unknown }).material = { map, normalMap: normal, opacity: 1 };
    const shader = new Object3D();
    (shader as unknown as { material: unknown }).material = {
      uniforms: { albedo: { value: map }, gain: { value: 2 } },
    };
    scene.add(mesh, shader);
    return scene;
  };

  const withGpu = <T>(raw: unknown): { descriptor?: PropertyDescriptor; restore: () => void } => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    void raw;
    return {
      descriptor,
      restore: () => {
        if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
      },
    };
  };

  it("hands every texture in the subtree to three's own texture path, once each", async () => {
    const canvas = testCanvas();
    const asked: unknown[] = [];
    const gpu = withGpu(undefined);
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: true,
      webgpuFactory: () => ({
        _textures: {
          updateTexture: (texture: unknown, options: object) => {
            asked.push(texture);
            // three fills width, height, mip levels and the image list into the object it is handed,
            // so each texture needs one of its own.
            expect(options).toEqual({});
          },
        },
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      expect(renderer.kind).toBe("webgpu");
      expect(renderer.uploadTextures?.(textured())).toBe(2);
      expect(asked.length).toBe(2);
    } finally {
      renderer.dispose();
      gpu.restore();
    }
  });

  it("answers 0 on a renderer with no texture path instead of throwing", async () => {
    const canvas = testCanvas();
    const gpu = withGpu(undefined);
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: true,
      webgpuFactory: () => ({
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    try {
      expect(renderer.uploadTextures?.(textured())).toBe(0);
    } finally {
      renderer.dispose();
      gpu.restore();
    }
  });
});
