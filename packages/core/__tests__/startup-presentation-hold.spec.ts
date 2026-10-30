import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import type { ICtx } from "../src/scene.js";
import { Scene } from "../src/scene.js";

/**
 * The launch's first picture on the owned engine. Its post chain and its virtual shadow pages come up
 * cold: metering read `[0, -1, -2.473931, 0]` (log exposure 0, luminance -1, unsettled) and the cover
 * lifted on world frames of 185 and 124 mean brightness before the settled 108. Core holds the canvas
 * instead, and keeps drawing the world behind it: the frame that maps the pages and feeds the meter is
 * a frame the player never sees.
 */
type Step = "compile" | "draw:held" | "draw:surface" | "hold" | "release";

/** A renderer whose startup seams answer the way the Wasm engine's facade does, logging what happened. */
function stubRenderer(steps: Step[], native: boolean) {
  const startup = { shadowInputsReady: false, worldSubmissions: 0 };
  let held = false;
  return {
    startup,
    raw: {
      domElement: undefined as unknown as HTMLCanvasElement,
      // Not three's: the engine's own startup report, mirrored by the facade.
      info: { engine: { startup } },
      render: () => {
        steps.push(held ? "draw:held" : "draw:surface");
        // The host counts an ordinary submission whether or not it presented it: the frame is drawn, only
        // its surface texture is deferred.
        startup.worldSubmissions += 1;
      },
      setSize: () => undefined,
      compileAsync: async () => {
        steps.push("compile");
      },
      ...(native
        ? {
            setPresentationHeld: (next: boolean) => {
              if (next === held) return;
              held = next;
              steps.push(held ? "hold" : "release");
            },
          }
        : {}),
    },
  };
}

async function boot(native: boolean) {
  const steps: Step[] = [];
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 90 },
    clientWidth: { configurable: true, value: 160 },
    parentElement: { configurable: true, value: null },
  });
  const { raw, startup } = stubRenderer(steps, native);
  raw.domElement = canvas as HTMLCanvasElement;
  let capturedCtx: ICtx | undefined;
  class Covered extends Scene {
    static override readonly initialState = {};
    override enter(ctx: ICtx): undefined {
      // An opaque cover over a canvas nothing has drawn into yet: the case this hold exists for.
      ctx.canvasLayer.opaque = true;
      capturedCtx = ctx;
      return undefined;
    }
  }
  const game = defineGame({
    renderer: {
      canvas: canvas as never,
      preferWebGPU: false,
      webgl2Factory: () => raw as never,
    },
    scenes: { covered: Covered },
    start: "covered",
  });
  let frame: ((time: number) => void) | undefined;
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      frame = callback;
      return 1;
    },
  });
  let clock = 0;
  const pump = async (frames: number): Promise<void> => {
    for (let index = 0; index < frames; index += 1) {
      if (frame === undefined) throw new Error("Game did not start its loop.");
      clock += 16.7;
      frame(clock);
      // A whole task between frames, so the compile and warm-up the frame started can settle: they await
      // real work, not one microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  try {
    await game.start();
  } catch (error) {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
    throw error;
  }
  return {
    ctx: () => capturedCtx,
    pump,
    startup,
    steps,
    async stop(): Promise<void> {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    },
  };
}

describe("startup presentation hold", () => {
  it("holds the surface until the renderer's own first world frame is ready", async () => {
    const launch = await boot(true);
    try {
      await launch.pump(12);
      // Engaged where the renderer was set up, before the warm-up compiles or draws anything.
      expect(launch.steps[0]).toBe("hold");
      expect(launch.steps.indexOf("hold")).toBeLessThan(launch.steps.indexOf("compile"));
      // The world keeps drawing behind the cover with nothing ready yet: those draws are what maps the
      // shadow pages and feeds the meter, so skipping them would hold the cover for work nothing starts.
      expect(launch.steps).toContain("draw:held");
      expect(launch.steps).not.toContain("draw:surface");
      expect(launch.steps).not.toContain("release");
      expect(launch.ctx()?.startup.timeline.readyMs).toBeUndefined();

      // The shadow pages are mapped. Nothing measured yet on a cold meter, but this renderer installs no
      // exposure probe, so the second input is already satisfied and the hold comes off on the next frame.
      launch.startup.shadowInputsReady = true;
      await launch.pump(12);
      expect(launch.steps.filter((step) => step === "release")).toHaveLength(1);
      await launch.ctx()?.startup.whenReady();
      expect(launch.ctx()?.startup.timeline.readyMs).toBeTypeOf("number");
      // Nothing reached the surface while the inputs were cold.
      expect(launch.steps.indexOf("draw:surface")).toBe(-1);

      // The cover is the game's own moment; with it lifted, the next world frame is the first one seen.
      const ctx = launch.ctx();
      if (ctx === undefined) throw new Error("The scene never entered.");
      ctx.canvasLayer.opaque = false;
      await launch.pump(4);
      expect(launch.steps.indexOf("draw:surface")).toBeGreaterThan(launch.steps.indexOf("release"));
    } finally {
      await launch.stop();
    }
    // Stopping releases exactly the hold this launch engaged, and only once.
    expect(launch.steps.filter((step) => step === "hold")).toHaveLength(1);
    expect(launch.steps.filter((step) => step === "release")).toHaveLength(1);
  });

  it("leaves a renderer without the seam on its existing path", async () => {
    const launch = await boot(false);
    try {
      await launch.pump(12);
      expect(launch.steps).not.toContain("hold");
      expect(launch.steps).not.toContain("release");
      // three's own renderer presents the frame it draws: no cover, no deferral.
      expect(launch.steps).toContain("draw:surface");
      await launch.ctx()?.startup.whenReady();
      expect(launch.ctx()?.startup.timeline.readyMs).toBeTypeOf("number");
    } finally {
      await launch.stop();
    }
    expect(launch.steps).not.toContain("hold");
  });
});
