import type { Vector2 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installApplicationLifecycle, quitGame } from "../src/app-lifecycle.js";
import { defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";

/**
 * PRD-906 Phase 1. A phone tells the app it is leaving: the scene hears Godot's
 * `NOTIFICATION_APPLICATION_PAUSED`/`RESUMED`, and `ctx.quit()` ends the native host. The web has
 * nothing to quit, so the call says so once by name instead of pretending it worked.
 */

/** The `visibilitychange` surface of a page — or of the native host's `document` stub. */
type FakeDocument = EventTarget & {
  readonly body: { append(): void };
  visibilityState: "visible" | "hidden";
  createElement(): unknown;
};

function installDocument(state: "visible" | "hidden" = "visible"): {
  hide(): void;
  show(): void;
} {
  const document = Object.assign(new EventTarget(), {
    body: { append: () => undefined },
    createElement: () => new EventTarget(),
    visibilityState: state,
  }) as unknown as FakeDocument;
  vi.stubGlobal("document", document);
  const to = (next: "visible" | "hidden"): void => {
    document.visibilityState = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { hide: () => to("hidden"), show: () => to("visible") };
}

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function stubRenderer(canvas: HTMLCanvasElement) {
  return {
    canvas,
    preferWebGPU: false,
    webgl2Factory: () => ({
      dispose: () => undefined,
      domElement: canvas,
      getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
      render: () => undefined,
      setSize: () => undefined,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app lifecycle", () => {
  it("calls each app hook once per real transition", () => {
    const page = installDocument();
    const paused = vi.fn();
    const resumed = vi.fn();
    const dispose = installApplicationLifecycle({ paused, resumed });

    page.hide();
    page.hide(); // a repeated event is not a second transition
    expect(paused).toHaveBeenCalledTimes(1);
    expect(resumed).not.toHaveBeenCalled();

    page.show();
    page.show();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(paused).toHaveBeenCalledTimes(1);

    dispose();
    page.hide();
    expect(paused).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the runtime has no document at all", () => {
    const paused = vi.fn();
    const dispose = installApplicationLifecycle({ paused, resumed: vi.fn() });
    expect(() => dispose()).not.toThrow();
    expect(paused).not.toHaveBeenCalled();
  });

  it("reads a worker host's forwarded copy of the document", () => {
    const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("__tnAppVisibility", visibility);
    const paused = vi.fn();
    const dispose = installApplicationLifecycle({ paused, resumed: vi.fn() });

    visibility.visibilityState = "hidden";
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(paused).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("reaches the live scene of a running game", async () => {
    const page = installDocument();
    const transitions: string[] = [];
    class Menu extends Scene {
      static override readonly initialState = {};
      override applicationPaused(): void {
        transitions.push("paused");
      }
      override applicationResumed(): void {
        transitions.push("resumed");
      }
    }
    const game = defineGame({
      initialState: {},
      renderer: stubRenderer(testCanvas()),
      scenes: { menu: Menu },
      start: "menu",
    });

    await game.start();
    try {
      page.hide();
      page.show();
    } finally {
      game.stop();
    }
    expect(transitions).toEqual(["paused", "resumed"]);
  });
});

describe("quit", () => {
  it("ends the native host with status 0", () => {
    vi.stubGlobal("__THREENATIVE_NATIVE__", { platform: {} });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    quitGame();
    expect(exit).toHaveBeenCalledWith(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports TN_QUIT_UNSUPPORTED once on a web page", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    quitGame();
    quitGame();
    const reported = warn.mock.calls.filter(([line]) =>
      String(line).startsWith("TN_QUIT_UNSUPPORTED"),
    );
    expect(reported).toHaveLength(1);
  });
});
