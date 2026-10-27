import { afterEach, describe, expect, it, vi } from "vitest";
import type { IGamePlatformSource } from "../src/game.js";
import { serveWorkerGame, startWorkerGame } from "../src/worker.js";

// PRD-752: a web game runs in a dedicated worker on an OffscreenCanvas. The page keeps the DOM, the
// HUD and the input; the worker runs the unchanged portable `game.ts`. These tests link the two ends
// in one process: what the page posts reaches the worker scope and back, one task later.

type Scope = EventTarget & Record<string, unknown> & { postMessage(data: unknown): void };
type FakeWorker = EventTarget & {
  postMessage(data: unknown, transfer?: unknown[]): void;
  terminate(): void;
};

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function link() {
  const scope = new EventTarget() as Scope;
  const worker = new EventTarget() as FakeWorker;
  const toWorker: { type?: string }[] = [];
  worker.postMessage = (data) => {
    toWorker.push(data as { type?: string });
    setTimeout(() => scope.dispatchEvent(new MessageEvent("message", { data })));
  };
  worker.terminate = vi.fn();
  scope.postMessage = (data) =>
    setTimeout(() => worker.dispatchEvent(new MessageEvent("message", { data })));
  scope.fetch = vi.fn(async () => new Response("ok"));
  scope.Request = Request;
  return { scope, toWorker, worker };
}

function page() {
  const offscreen = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    clientHeight: 180,
    clientWidth: 320,
    getBoundingClientRect: () => ({ height: 180, left: 10, top: 20, width: 320 }),
    style: {} as Record<string, string>,
    transferControlToOffscreen: () => offscreen,
  });
  const container = { append: vi.fn() };
  const view = Object.assign(new EventTarget(), {
    devicePixelRatio: 2,
    location: { href: "http://127.0.0.1:5173/game/index.html?tnWorker=1" },
  }) as unknown as EventTarget & Record<string, unknown>;
  let resize: (() => void) | undefined;
  vi.stubGlobal("window", view);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { createElement: () => canvas }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return { canvas, container, offscreen, resize: () => resize?.(), view };
}

function keyEvent(type: string, code: string): Event {
  return Object.assign(new Event(type), { code, key: code.replace("Key", "").toLowerCase() });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker game host (PRD-752)", () => {
  it("sends the canvas only after the worker reports ready", async () => {
    // A message sent while the worker module is still in its top-level await reaches no handler
    // and is lost, so the page waits for the worker's own ready message.
    const { scope, toWorker, worker } = link();
    const { container, offscreen } = page();
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await tick();
    expect(toWorker.some((message) => message.type === "tn-worker-init")).toBe(false);
    serveWorkerGame({ start: async () => undefined }, scope);
    await handle.ready;
    const init = toWorker.find((message) => message.type === "tn-worker-init") as Record<
      string,
      unknown
    >;
    expect(init).toMatchObject({ canvas: offscreen, dpr: 2, height: 180, width: 320 });
    expect(container.append).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("installs the platform source before start and keeps its size current", async () => {
    const { scope, worker } = link();
    const { canvas, container, offscreen, resize } = page();
    let platform: IGamePlatformSource | undefined;
    serveWorkerGame(
      {
        start: async () => {
          platform = scope.__tnGamePlatform as IGamePlatformSource;
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    expect(platform?.renderer.createCanvas()).toBe(offscreen);
    expect(platform?.renderer.readSize(offscreen as HTMLCanvasElement)).toEqual([320, 180]);
    expect(scope.devicePixelRatio).toBe(2);

    const resized = vi.fn();
    platform?.viewport.observeResize(offscreen as HTMLCanvasElement, resized);
    canvas.clientWidth = 640;
    canvas.clientHeight = 360;
    resize();
    await tick();
    expect(resized).toHaveBeenCalled();
    expect(platform?.viewport.readSize(offscreen as HTMLCanvasElement)).toEqual({
      aspect: 640 / 360,
      height: 360,
      width: 640,
    });
    handle.stop();
  });

  it("forwards keys to the input target and pointers to the canvas, in canvas coordinates", async () => {
    const { scope, worker } = link();
    const { canvas, container, offscreen, view } = page();
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const platform = scope.__tnGamePlatform as IGamePlatformSource;
    const keys: string[] = [];
    platform.inputTarget?.addEventListener("keydown", (event) =>
      keys.push((event as KeyboardEvent).code),
    );
    const pointers: number[][] = [];
    offscreen.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      pointers.push([pointer.clientX, pointer.clientY, pointer.button, pointer.pointerId]);
    });

    view.dispatchEvent(keyEvent("keydown", "KeyW"));
    canvas.dispatchEvent(
      Object.assign(new Event("pointerdown"), {
        button: 0,
        buttons: 1,
        clientX: 110,
        clientY: 70,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
    await tick();
    expect(keys).toEqual(["KeyW"]);
    expect(pointers).toEqual([[100, 50, 0, 1]]);
    handle.stop();
  });

  it("resolves the game's relative URLs against the page, not the worker script", async () => {
    // A worker's base URL is its own script (`/assets/worker-<hash>.js`), so `sky.jpg` and
    // three's `new Request("grade.cube")` fetched the wrong path.
    const { scope, worker } = link();
    const { container } = page();
    const fetched = scope.fetch as ReturnType<typeof vi.fn>;
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    await (scope.fetch as typeof fetch)("sky.jpg");
    expect(String(fetched.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:5173/game/sky.jpg");
    const request = new (scope.Request as typeof Request)("grade.cube");
    expect(request.url).toBe("http://127.0.0.1:5173/game/grade.cube");
    handle.stop();
  });

  it("carries the HUD bridge both ways over its own port", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    const gameReceive = vi.fn();
    const uiReceive = vi.fn();
    scope.__tnUiGameReceive = gameReceive;
    view.__tnUiReceive = uiReceive;
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    // The UI side connects as soon as React mounts, before the worker is ready: the host globals
    // must exist from the first call.
    (view.tnHost as { postMessage(frame: string): void }).postMessage('{"intent":"pause"}');
    await handle.ready;
    (scope.__tnUiPost as (frame: string) => void)('{"state":{"score":1}}');
    expect((scope.__tnUiOverlayAttached as () => boolean)()).toBe(true);
    await tick(20);
    expect(gameReceive).toHaveBeenCalledWith('{"intent":"pause"}');
    expect(uiReceive).toHaveBeenCalledWith('{"state":{"score":1}}');
    handle.stop();
  });

  it("holds a UI frame sent before the game connects, then delivers it", async () => {
    // UiLayer announces itself at mount; the worker game connects its bridge partway through a
    // slow start. A dropped ready intent leaves the HUD blank.
    const { scope, worker } = link();
    const { container, view } = page();
    const gameReceive = vi.fn();
    const game = {
      start: async () => {
        await tick(20);
        scope.__tnUiGameReceive = gameReceive;
      },
    };
    serveWorkerGame(game, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    (view.tnHost as { postMessage(frame: string): void }).postMessage('{"intent":"ready"}');
    await handle.ready;
    await tick();
    expect(gameReceive).toHaveBeenCalledWith('{"intent":"ready"}');
    handle.stop();
  });

  it("delivers game frames posted before the page's port arrived", async () => {
    // The starter's `game.ui.onIntent` connects the bridge while game.ts evaluates, before init.
    const { scope, worker } = link();
    const { container, view } = page();
    const uiReceive = vi.fn();
    view.__tnUiReceive = uiReceive;
    serveWorkerGame({ start: async () => undefined }, scope);
    (scope.__tnUiPost as (frame: string) => void)('{"state":{"lives":3}}');
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    await tick();
    expect(uiReceive).toHaveBeenCalledWith('{"state":{"lives":3}}');
    handle.stop();
  });

  it("installs the UI host globals when it loads in a worker, before the game module runs", async () => {
    vi.resetModules();
    vi.stubGlobal("WorkerGlobalScope", class {});
    try {
      await import("../src/worker.js");
      const scope = globalThis as Record<string, unknown>;
      expect(typeof scope.__tnUiPost).toBe("function");
      expect((scope.__tnUiOverlayAttached as () => boolean)()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      const scope = globalThis as Record<string, unknown>;
      scope.__tnUiPost = undefined;
      scope.__tnUiOverlayAttached = undefined;
      scope.__tnUiGameReceive = undefined;
      scope.__tnWorkerUi = undefined;
    }
  });

  it("copies the harness's page globals into the worker before start", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    view.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
    let clock: unknown;
    serveWorkerGame(
      {
        start: async () => {
          clock = scope.__THREENATIVE_PLAYTEST_CLOCK__;
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    expect(clock).toBe("wall-clock");
    handle.stop();
  });

  it("mirrors the playtest bridge onto the page as async calls", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    serveWorkerGame(
      {
        start: async () => {
          // The playtest plugin installs its bridge while the game starts.
          scope.__THREENATIVE_PLAYTEST_BRIDGE__ = {
            describe: () => ({ name: "worker" }),
            sample: async (request: unknown) => ({ echo: request }),
          };
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const bridge = view.__THREENATIVE_PLAYTEST_BRIDGE__ as {
      describe(): Promise<unknown>;
      sample(request: unknown): Promise<unknown>;
    };
    await expect(bridge.describe()).resolves.toEqual({ name: "worker" });
    await expect(bridge.sample({ ticks: 3 })).resolves.toEqual({ echo: { ticks: 3 } });
    handle.stop();
  });

  it("rejects ready with the worker's start failure", async () => {
    const { scope, worker } = link();
    const { container } = page();
    serveWorkerGame(
      {
        start: async () => {
          throw new Error("TN_NO_RENDERER: boom");
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await expect(handle.ready).rejects.toThrow("TN_NO_RENDERER: boom");
    handle.stop();
  });

  it("stop terminates the worker and forwards nothing more", async () => {
    const { scope, toWorker, worker } = link();
    const { container, view } = page();
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    handle.stop();
    const sent = toWorker.length;
    view.dispatchEvent(keyEvent("keydown", "KeyW"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(toWorker.length).toBe(sent);
  });

  it("lets a canvas gesture reach the input target too, as it bubbles to the window on a page", async () => {
    // AudioBus unlocks on a pointerdown it hears on its gesture target, the input target here.
    const { scope, worker } = link();
    const { canvas, container } = page();
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const platform = scope.__tnGamePlatform as IGamePlatformSource;
    const heard = vi.fn();
    platform.inputTarget?.addEventListener("pointerdown", heard);
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 10, clientY: 20 }));
    await tick();
    expect(heard).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("gives the worker an AudioContext that plays through the page's own", async () => {
    // The Wasm engine's AudioListener asks `globalThis.AudioContext`; a worker has none.
    const { scope, worker } = link();
    const { container, view } = page();
    const created: unknown[] = [];
    view.AudioContext = class {
      currentTime = 0;
      destination = {};
      listener = {};
      sampleRate = 44_100;
      state = "suspended";
      createGain() {
        const gain = { connect: vi.fn(), gain: { setTargetAtTime: vi.fn(), value: 1 } };
        created.push(gain);
        return gain;
      }
      resume = vi.fn(async () => undefined);
    };
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const Context = scope.AudioContext as new () => AudioContext;
    const context = new Context();
    expect(context.sampleRate).toBe(44_100);
    context.createGain().gain.setTargetAtTime(0.25, 0, 0.1);
    await tick(20);
    expect(created).toHaveLength(1);
    expect(
      (created[0] as { gain: { setTargetAtTime: ReturnType<typeof vi.fn> } }).gain.setTargetAtTime,
    ).toHaveBeenCalledWith(0.25, 0, 0.1);
    handle.stop();
  });
});
