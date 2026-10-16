import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

class Empty extends Scene {
  static override readonly initialState = {};
}

/**
 * `resolutionScale: "auto"` has to move the drawing buffer, and a pinned number has to stop it
 * dead. Both halves are the contract; the second is what makes the first safe to ship on by
 * default, because a game that found its own constant keeps exactly the frame it tuned.
 */
async function run(
  render: Record<string, unknown>,
  presentedP95: number,
  windows: number,
  duringCompile: boolean | "last-frame" | "between-frames" = false,
  cleanFrames = 0,
): Promise<{ scale: number; scaleSource: string }> {
  const canvas = testCanvas();
  let frame: ((time: number) => void) | undefined;
  let holdCompile = false;
  let releaseCompile = () => {};
  const compileWindows: boolean[] = [];
  const game = defineGame({
    step: presentedP95 / 1000,
    display: { maxFps: 60 },
    frameBudget: {
      report: () => {},
      reportEvery: typeof duringCompile === "string" ? 2 : 1,
      onWindow: (window) => {
        compileWindows.push(window.surface?.compiling === true);
      },
    },
    render,
    renderer: {
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        compileAsync: () =>
          holdCompile
            ? new Promise<void>((resolve) => {
                releaseCompile = resolve;
              })
            : Promise.resolve(),
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    },
    scenes: { test: Empty },
    start: "test",
  });
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      frame = callback;
      return 1;
    },
  });
  try {
    await game.start();
    if (frame === undefined) throw new Error("Game did not start its loop.");
    let time = performance.now();
    // Reach readiness before measuring anything. The scaler deliberately ignores windows that
    // close before the world is up — the ones that close during a launch are asset decode, scene
    // construction and first-use compilation, not the game — and this harness used to drive
    // straight past that and assert on windows the scaler now refuses. Its assertions were
    // therefore passing *because* of the defect: on a real 46,190-instance forest the first two
    // windows reported 18.8 and 27.3 fps and the buffer fell three rungs before the player had
    // control. So the ramp is in-budget frames, awaited so the readiness promise chain can settle.
    for (let index = 0; index < 10; index += 1) {
      time += 8;
      frame(time);
      await Promise.resolve();
    }
    await game.ctx?.startup.whenReady();
    compileWindows.length = 0;
    holdCompile = Boolean(duringCompile) && duringCompile !== "between-frames";
    const compilation =
      holdCompile && game.ctx !== undefined
        ? game.ctx.renderer.compileAsync(game.ctx.scene, game.ctx.camera)
        : Promise.resolve();
    for (let index = 0; index < windows; index += 1) {
      if (duringCompile === "between-frames" && game.ctx !== undefined) {
        await game.ctx.renderer.compileAsync(game.ctx.scene, game.ctx.camera);
      }
      if (duringCompile === "last-frame" && index === windows - 1) {
        releaseCompile();
        await compilation;
      }
      time += presentedP95;
      frame(time);
      await Promise.resolve();
    }
    releaseCompile();
    await compilation;
    if (duringCompile) expect(compileWindows).toContain(true);
    if (duringCompile === "last-frame") expect(compileWindows.at(-1)).toBe(true);
    if (duringCompile === "between-frames") {
      expect(compileWindows.length).toBeGreaterThan(0);
      expect(compileWindows.every(Boolean)).toBe(true);
    }
    for (let index = 0; index < cleanFrames; index += 1) {
      time += presentedP95;
      frame(time);
      await Promise.resolve();
    }
    if (cleanFrames > 0) expect(compileWindows.at(-1)).toBe(false);
    const surface = game.ctx?.renderer.surface();
    return {
      scale: surface?.resolutionScale ?? Number.NaN,
      scaleSource: surface?.scaleSource ?? "?",
    };
  } finally {
    releaseCompile();
    await game.stop();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
  }
}

describe('resolutionScale: "auto"', () => {
  it("scales a game that said nothing about resolution", async () => {
    // The owner rule, in plain words: if the engine can measure a value where it is used, it
    // decides. A game that never wrote the key used to get a pinned full-resolution buffer and no
    // scaler at all — on a HiDPI desktop that is a 4527x2207 drawing buffer at 4x MSAA until the
    // GPU device is lost. Silence now resolves to auto, and `scaleSource` is where a harness sees
    // that it happened: "pinned" here would mean the loop was never built.
    const result = await run({}, 40, 6);
    expect(result).toEqual({ scale: 1, scaleSource: "auto" });
  });

  it("resumes automatic scaling on clean windows after between-frame compilation", async () => {
    // Six compiling windows the scaler skips, then six over-budget windows with no GPU timing:
    // a probe rung is spent, refunded when fewer pixels earn nothing, and then held. The
    // scaler is deciding throughout — source stays "auto", never pinned, never collapsed.
    const result = await run({ resolutionScale: "auto" }, 40, 6, "between-frames", 6);
    expect(result).toEqual({ scale: 1, scaleSource: "auto" });
  });
  it.each(["auto", 0.44] as const)(
    "observes compilation entirely between frames with resolution %s",
    async (resolutionScale) => {
      const result = await run({ resolutionScale }, 40, 6, "between-frames");
      expect(result).toEqual({
        scale: resolutionScale === "auto" ? 1 : resolutionScale,
        scaleSource: resolutionScale === "auto" ? "auto" : "pinned",
      });
    },
  );
  it("keeps partial compilation-window reporting when resolution is pinned", async () => {
    const result = await run({ resolutionScale: 0.44 }, 40, 6, "last-frame");
    expect(result).toEqual({ scale: 0.44, scaleSource: "pinned" });
  });
  it("discards a partly compiled window even when compilation settles before its final frame", async () => {
    const result = await run({ resolutionScale: "auto" }, 40, 6, "last-frame");
    expect(result).toEqual({ scale: 1, scaleSource: "auto" });
  });
  it("does not bank down-steps from frames spent compiling after readiness", async () => {
    const result = await run({ resolutionScale: "auto" }, 40, 6, true);
    expect(result).toEqual({ scale: 1, scaleSource: "auto" });
  });
  it("holds the ceiling when only the presented tail is over budget", async () => {
    // Six 40 ms windows with no GPU timing is host-shaped load the scaler cannot attribute to
    // pixels: it probes one rung, refunds it when the frame rate does not improve, and holds.
    // A collapse here would spend the picture on evidence that never existed.
    const result = await run({ resolutionScale: "auto" }, 40, 6);
    expect(result).toEqual({ scale: 1, scaleSource: "auto" });
  });

  it("does not move a pinned scale, however far over budget the frame runs", async () => {
    const result = await run({ resolutionScale: 0.44 }, 40, 12);
    expect(result).toEqual({ scale: 0.44, scaleSource: "pinned" });
  });

  it("reports atFloor once the scaler has run out of rungs and the frame is still over budget", async () => {
    // Measured on a physical Pixel 8 the same day: Bayview walked all ten rungs to 0.23 and was
    // still under 60 fps. A window reporting 0.23 and nothing else would read as a budget met at a
    // low resolution. A desktop stops earlier — the floor is 0.61, because nothing reconstructs a
    // frame from 5% of its pixels — and the phone walk itself is covered in
    // resolution-scaler.spec.ts and resolution-scaler-desktop-floor.spec.ts.
    //
    // Reaching the floor takes measured GPU cost that genuinely falls with the pixels: an fps
    // deficit alone only ever probes, and a *constant* GPU cost is now the insensitivity guard's
    // case — it would hold the sharp rung rather than surrender pixels for nothing. So the mock
    // reports a fresh GPU timestamp that tracks the drawing buffer and is still over the 16.67 ms
    // budget at the lowest rung, so the scaler runs out of room and must report it.
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let gpuFrame = 0;
    let bufferWidth = 2400;
    const gpuInfo = { frame: 0, render: { timestamp: 0 } };
    const windows: Array<{ surface?: { atFloor: boolean; resolutionScale: number } }> = [];
    const game = defineGame({
      display: { maxFps: 60 },
      frameBudget: { onWindow: (w) => windows.push(w), report: () => {}, reportEvery: 1 },
      render: { resolutionScale: "auto" },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info: gpuInfo,
          backend: { getTimestampFrames: () => [gpuFrame - 3] },
          render: () => {
            gpuFrame += 1;
            gpuInfo.frame = gpuFrame;
            // Pixel-bound cost: 352 ms at full resolution, 20.5 ms at 0.23 — still over budget.
            gpuInfo.render.timestamp = 2 + 350 * (bufferWidth / 2400) ** 2;
          },
          setSize: (width: number) => {
            bufferWidth = width;
          },
        }),
      },
      scenes: { test: Empty },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      // Thirty windows is many more rungs than the scaler needs to reach its floor.
      const startTime = performance.now();
      for (let index = 1; index <= 30; index += 1) frame(startTime + index * 60);
      const last = windows.at(-1);
      expect(last?.surface?.resolutionScale).toBe(0.61);
      expect(last?.surface?.atFloor).toBe(true);
      expect(windows[0]?.surface?.atFloor).toBe(false);
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("moves only the 3D drawing buffer: not the camera, the aspect or the CSS surface", async () => {
    // The arrangement the device ladder measured and accepted. A scaler that reframed the shot or
    // shrank the UI would buy its frame budget by changing the game, which is not mechanism.
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const sized: Array<readonly [number, number, boolean | undefined]> = [];
    const game = defineGame({
      display: { maxFps: 60 },
      frameBudget: { report: () => {}, reportEvery: 1 },
      render: { resolutionScale: "auto" },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: (width: number, height: number, updateStyle?: boolean) => {
            sized.push([width, height, updateStyle]);
          },
        }),
      },
      scenes: { test: Empty },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      const camera = game.ctx?.camera as { aspect?: number } | undefined;
      const aspectBefore = camera?.aspect;
      // Same readiness ramp as `run()` above, and for the same reason: the scaler ignores windows
      // that close before the world is up, so a loop that never reaches readiness measures a
      // scaler that was never allowed to act.
      let time = performance.now();
      for (let index = 0; index < 10; index += 1) {
        time += 8;
        frame(time);
        await Promise.resolve();
      }
      await game.ctx?.startup.whenReady();
      for (let index = 0; index < 6; index += 1) {
        time += 40;
        frame(time);
        await Promise.resolve();
      }
      expect(sized.length).toBeGreaterThan(1);
      // Every resize leaves the CSS/UI surface alone; only the drawing buffer moves.
      expect(sized.every(([, , updateStyle]) => updateStyle === false)).toBe(true);
      // Six over-budget windows with no GPU timing: the probe spends one rung of buffer and
      // the refund restores it. Something moved, and the last move gave every pixel back.
      expect(sized.some(([width]) => width < 2400)).toBe(true);
      expect(sized.at(-1)?.[0]).toBe(2400);
      expect(camera?.aspect).toBe(aspectBefore);
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("does not sell resolution for frames measured before the world was up", async () => {
    // The blur bug, as a gate. The owner's report was "after a while everything becomes blurry,
    // and keeps getting worse", and the mechanism was measured on a 46,190-instance forest: the
    // first frame-budget windows close during asset decode, scene construction and first-use
    // compilation, they reported 18.8 and 27.3 fps against a 60 fps budget, `#rungsToDrop` crossed
    // three rungs on a deficit that large, and the drawing buffer went 1600x900 -> 976x549 before
    // the player had control. It then settled at 0.72 — 52% of the pixels — re-probed 0.85 every
    // thirty seconds, missed, and fell back, so the picture never fully recovered.
    //
    // Those windows are not the game. This asserts the scaler never acts on them.
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let releaseTier: () => void = () => undefined;
    const postReadiness: number[] = [];
    class Streaming extends Scene {
      static override readonly initialState = {};
      override load(ctx: Parameters<Scene["load"]>[0]): void {
        ctx.startup.hold(
          "detail-tier",
          new Promise<void>((resolve) => {
            releaseTier = resolve;
          }),
        );
      }
    }
    const game = defineGame({
      display: { maxFps: 60 },
      frameBudget: {
        report: () => {},
        reportEvery: 1,
        onWindow: (w) => {
          if (w.surface !== undefined) postReadiness.push(w.surface.resolutionScale);
        },
      },
      render: { resolutionScale: "auto" },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Streaming },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      // Frames far over a 60 fps budget — 100 ms apart, which is the shape of a launch window.
      // Twenty of them is many more rungs than the scaler needs to reach its floor.
      //
      // The scene holds startup, which is what keeps this window pre-readiness. That is not a
      // contrivance: it is exactly what a game with a second asset tier does, and it is why the
      // real forest spent twenty seconds before readiness with its slowest windows inside that
      // span. Note also that readiness cannot be held off simply by driving slow frames here —
      // `observe()` measures the frame callback's own duration, not the interval between frames,
      // and this fake callback is nearly free.
      let time = performance.now();
      for (let index = 0; index < 20; index += 1) {
        time += 100;
        frame(time);
        await Promise.resolve();
      }
      const duringLoad = game.ctx?.renderer.surface();
      expect(duringLoad?.resolutionScale).toBe(1);
      expect(duringLoad?.atFloor).toBe(false);

      // And the control: the same over-budget windows *after* readiness must still move the
      // scaler, or this test would pass just as well against a scaler that had been switched
      // off entirely. Without GPU timing the move is a probe, not a priced jump: 0.85 appears
      // in the window record, then the refund gives it back because 100 ms frames never
      // improve on fewer pixels.
      releaseTier();
      // Final settlement observes rendered frames after the held warm-up, including two quiet ones.
      for (let index = 0; index < 10; index += 1) {
        time += 8;
        frame(time);
        await Promise.resolve();
      }
      await game.ctx?.startup.whenReady();
      postReadiness.length = 0;
      for (let index = 0; index < 6; index += 1) {
        time += 100;
        frame(time);
        await Promise.resolve();
      }
      expect(postReadiness).toContain(0.85);
      expect(postReadiness.at(-1)).toBe(1);
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });
});
