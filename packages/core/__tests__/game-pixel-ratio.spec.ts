import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";

function testCanvas(logicalWidth: number, logicalHeight: number): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: logicalHeight },
    clientWidth: { configurable: true, value: logicalWidth },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/**
 * Web unified onto device density, 2026-09-01. The buffer was deliberately DPR 1 on web while
 * native drew at the real ratio, so a HiDPI desktop browser upscaled every web game: the
 * compositor stretched a CSS-pixel canvas and the game read as pixelated. The platform branch
 * also silently clobbered an explicit `renderer.pixelRatio`, a value the renderer options
 * document as honored. Now both runtimes take one rule — the device's real ratio, with an
 * explicit config value winning over it — and the resolution scaler composes on top:
 * `logical × pixelRatio × resolutionScale`. Headless capture lanes run at DPR 1 and are
 * unaffected; real-density behaviour is proven here at the boot seam where it is decided.
 */
async function bootGame(
  rendererOptions: { pixelRatio?: number },
  canvas: HTMLCanvasElement,
): Promise<{ stop: () => Promise<void>; setSizeCalls: Array<[number, number, unknown]> }> {
  class Empty extends Scene {
    static override readonly initialState = {};
  }
  const setSizeCalls: Array<[number, number, unknown]> = [];
  const game = defineGame({
    renderer: {
      ...rendererOptions,
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        render: () => undefined,
        setSize: (width: number, height: number, updateStyle?: boolean) => {
          setSizeCalls.push([width, height, updateStyle]);
        },
      }),
    },
    scenes: { test: Empty },
    start: "test",
  });
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  try {
    await game.start();
  } finally {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
  }
  return { stop: async () => game.stop(), setSizeCalls };
}

describe("the game boots at the device's real density by default", () => {
  it("does not re-scale its own drawing buffer when an unsized canvas reports it back", async () => {
    // A canvas with no CSS size lays out at its drawing buffer: every buffer the engine sets comes
    // back through the resize observer as the new layout size. Scaling that again compounded on
    // each echo; Midway's canvas fell to 3x3 under a 0.8 resolution scale.
    const devicePixelRatio = globalThis.devicePixelRatio;
    const observer = globalThis.ResizeObserver;
    const callbacks: (() => void)[] = [];
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2 });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    });
    try {
      let layout: [number, number] = [1920, 1080];
      const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
      Object.defineProperties(canvas, {
        clientWidth: { configurable: true, get: () => layout[0] },
        clientHeight: { configurable: true, get: () => layout[1] },
        parentElement: { configurable: true, value: null },
        style: { configurable: true, value: { width: "", height: "" } },
      });
      const booted = await bootGame({}, canvas as HTMLCanvasElement);
      expect(booted.setSizeCalls.at(-1)?.slice(0, 2)).toEqual([3840, 2160]);
      for (let echo = 0; echo < 3; echo++) {
        const last = booted.setSizeCalls.at(-1) as [number, number, unknown];
        layout = [last[0], last[1]];
        for (const callback of callbacks) callback();
      }
      expect(booted.setSizeCalls.at(-1)?.slice(0, 2)).toEqual([3840, 2160]);
      // The echo proves the canvas lays out at its buffer, so it is pinned at its layout size;
      // otherwise any ratio or scale other than 1 resizes it on the page (Midway's canvas shrank to
      // 1088x612 when the adaptive scale dropped to 0.85).
      expect(canvas.style).toMatchObject({ width: "1920px", height: "1080px" });
      // A real layout change still resizes.
      layout = [1280, 720];
      for (const callback of callbacks) callback();
      expect(booted.setSizeCalls.at(-1)?.slice(0, 2)).toEqual([2560, 1440]);
      await booted.stop();
    } finally {
      Object.defineProperty(globalThis, "devicePixelRatio", {
        configurable: true,
        value: devicePixelRatio,
      });
      Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: observer });
    }
  });

  it("multiplies the logical canvas by devicePixelRatio without being told", async () => {
    const devicePixelRatio = globalThis.devicePixelRatio;
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2 });
    try {
      // A 4K panel at 200%: 1920×1080 logical, 2 device pixels per CSS pixel.
      const booted = await bootGame({}, testCanvas(1920, 1080));
      const last = booted.setSizeCalls.at(-1);
      expect(last, "the engine never sized the drawing buffer").toBeDefined();
      expect(last?.[0]).toBe(3840);
      expect(last?.[1]).toBe(2160);
      await booted.stop();
    } finally {
      Object.defineProperty(globalThis, "devicePixelRatio", {
        configurable: true,
        value: devicePixelRatio,
      });
    }
  });

  it("still honours an explicit renderer.pixelRatio over the device's own", async () => {
    const devicePixelRatio = globalThis.devicePixelRatio;
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2.625 });
    try {
      const booted = await bootGame({ pixelRatio: 1 }, testCanvas(1280, 720));
      const last = booted.setSizeCalls.at(-1);
      expect(last, "the engine never sized the drawing buffer").toBeDefined();
      expect(last?.[0]).toBe(1280);
      expect(last?.[1]).toBe(720);
      await booted.stop();
    } finally {
      Object.defineProperty(globalThis, "devicePixelRatio", {
        configurable: true,
        value: devicePixelRatio,
      });
    }
  });
});
