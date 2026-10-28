import { afterEach, describe, expect, it, vi } from "vitest";
import type { IGamePlatformSource } from "../src/game.js";
import { detectPlatform } from "../src/platform.js";
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
  const children: unknown[] = [];
  const container = { append: vi.fn((child: unknown) => children.push(child)), children };
  Object.assign(canvas, {
    remove: () => {
      const index = children.indexOf(canvas);
      if (index >= 0) children.splice(index, 1);
    },
  });
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const view = Object.assign(new EventTarget(), {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
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
  return {
    canvas,
    container,
    offscreen,
    resize: () => resize?.(),
    view,
    frame: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    frames,
  };
}

function keyEvent(type: string, code: string): Event {
  return Object.assign(new Event(type), { code, key: code.replace("Key", "").toLowerCase() });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker game host (PRD-752)", () => {
  it("forwards gamepad snapshots each connected frame and stops polling on disconnect or stop", async () => {
    const { scope, worker, toWorker } = link();
    const { container, view, frame, frames } = page();
    const pad = {
      id: "controller",
      index: 1,
      connected: true,
      mapping: "standard",
      timestamp: 10,
      buttons: [{ pressed: true, value: 1, touched: true }],
      axes: [0.5, -0.25],
    };
    let pads: (typeof pad | null)[] = [null, pad];
    const getGamepads = vi.fn(() => pads);
    view.navigator = { getGamepads };
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const platform = scope.__tnGamePlatform as IGamePlatformSource;
    try {
      getGamepads.mockClear();
      frame();
      await tick();
      expect(platform.input()).toEqual([
        null,
        {
          id: "controller",
          index: 1,
          connected: true,
          mapping: "standard",
          timestamp: 10,
          buttons: [{ pressed: true, value: 1, touched: true }],
          axes: [0.5, -0.25],
        },
      ]);
      expect(getGamepads).toHaveBeenCalledTimes(1);
      const button = pad.buttons[0];
      if (button !== undefined) button.pressed = false;
      pad.axes[0] = -1;
      expect(platform.input()[1]?.buttons[0]?.pressed).toBe(true);
      frame();
      await tick();
      expect(platform.input()[1]?.buttons[0]?.pressed).toBe(false);
      pads = [null, null];
      view.dispatchEvent(new Event("gamepaddisconnected"));
      await tick();
      expect(platform.input()).toEqual([null, null]);
      expect(frames.size).toBe(0);
      pads = [null, pad];
      view.dispatchEvent(new Event("gamepadconnected"));
      await tick();
      expect(frames.size).toBe(1);
      handle.stop();
      const sent = toWorker.length;
      frame();
      view.dispatchEvent(new Event("gamepadconnected"));
      expect(frames.size).toBe(0);
      expect(toWorker).toHaveLength(sent);
    } finally {
      handle.stop();
    }
  });

  it("bounds HUD snapshots while the page is stalled and preserves non-state frames", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    const received = vi.fn();
    const gameReceive = vi.fn();
    view.__tnUiReceive = received;
    scope.__tnUiGameReceive = gameReceive;
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const posts = vi.spyOn(MessagePort.prototype, "postMessage");
    try {
      const post = scope.__tnUiPost as (frame: string) => void;
      for (let score = 0; score < 100; score++)
        post(JSON.stringify({ type: "tn:state", state: { score } }));
      post('{"type":"tn:notice","value":1}');
      post('{"type":"tn:notice","value":2}');
      post("opaque legacy frame");
      const sentStates = posts.mock.calls.filter(
        ([frame]) => typeof frame === "string" && frame.includes('"tn:state"'),
      ).length;
      await tick(30);
      expect(sentStates).toBe(1);
      expect(
        received.mock.calls
          .map(([frame]) => frame)
          .filter((frame: string) => frame.includes('"tn:state"')),
      ).toEqual([
        '{"type":"tn:state","state":{"score":0}}',
        '{"type":"tn:state","state":{"score":99}}',
      ]);
      expect(
        received.mock.calls
          .map(([frame]) => frame)
          .filter((frame: string) => !frame.includes('"tn:state"')),
      ).toEqual([
        '{"type":"tn:notice","value":1}',
        '{"type":"tn:notice","value":2}',
        "opaque legacy frame",
      ]);
      expect(gameReceive).not.toHaveBeenCalled();
    } finally {
      posts.mockRestore();
      handle.stop();
    }
  });

  it.each(["pointermove", "mousemove"])(
    "coalesces 100 %s events per frame and flushes motion before edges",
    async (type) => {
      const { scope, worker, toWorker } = link();
      const { canvas, container, view, frame, frames } = page();
      const bounds = vi.spyOn(canvas, "getBoundingClientRect");
      serveWorkerGame({ start: async () => undefined }, scope);
      const handle = startWorkerGame(
        worker as unknown as Worker,
        container as unknown as HTMLElement,
      );
      await handle.ready;
      const moves = () => {
        for (let i = 0; i < 100; i++)
          (type === "pointermove" ? canvas : view).dispatchEvent(
            Object.assign(new Event(type), {
              pointerId: 1,
              movementX: 1,
              movementY: -2,
              clientX: 10 + i,
              clientY: 20 + i,
            }),
          );
      };
      const sent: unknown[] = [];
      try {
        moves();
        const beforeFrame = toWorker.filter((message) => message.type === "tn-worker-event").length;
        frame();
        sent.push(...toWorker.filter((message) => message.type === "tn-worker-event"));
        expect(beforeFrame).toBe(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          event: {
            type,
            movementX: 100,
            movementY: -200,
            clientX: type === "pointermove" ? 99 : 109,
            clientY: type === "pointermove" ? 99 : 119,
          },
        });
        expect(bounds.mock.calls.length).toBe(type === "pointermove" ? 1 : 0);
        moves();
        canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 1 }));
        expect(
          toWorker.filter((message) => message.type === "tn-worker-event").slice(-2),
        ).toMatchObject([
          { event: { type, movementX: 100, movementY: -200 } },
          { event: { type: "pointerdown" } },
        ]);
        moves();
        handle.stop();
        frame();
        expect(frames.size).toBe(0);
        expect(toWorker.filter((message) => message.type === "tn-worker-event")).toHaveLength(3);
      } finally {
        handle.stop();
      }
    },
  );

  it("keeps HUD wheel events out of the game, matching InputMap's target rule", async () => {
    const { scope, worker } = link();
    const { canvas, container, view } = page();
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const platform = scope.__tnGamePlatform as IGamePlatformSource;
    const received: number[] = [];
    platform.inputTarget?.addEventListener("wheel", (event) =>
      received.push((event as WheelEvent).deltaY),
    );
    for (const [target, deltaY] of [
      [{}, 10],
      [canvas, 20],
      [view, 30],
    ] as const) {
      const event = Object.assign(new Event("wheel"), { deltaY });
      Object.defineProperty(event, "target", { value: target });
      view.dispatchEvent(event);
    }
    await tick();
    handle.stop();
    expect(received).toEqual([20, 30]);
  });

  it("clamps a hidden canvas to one pixel at init and resize", async () => {
    const { scope, worker } = link();
    const { canvas, container, offscreen, resize } = page();
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const platform = scope.__tnGamePlatform as IGamePlatformSource;
    const initial = platform.viewport.readSize(offscreen as HTMLCanvasElement);
    canvas.clientWidth = 100;
    resize();
    await tick();
    handle.stop();
    expect(initial).toEqual({ width: 1, height: 1, aspect: 1 });
    expect(platform.renderer.readSize(offscreen as HTMLCanvasElement)).toEqual([100, 1]);
    expect(platform.viewport.readSize(offscreen as HTMLCanvasElement).aspect).toBe(100);
  });

  it("reports a pointerlockerror-only refusal to the worker and detaches on stop", async () => {
    const { scope, worker } = link();
    const { canvas, container, offscreen } = page();
    Object.assign(canvas, { requestPointerLock: () => undefined });
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const changes: boolean[] = [];
    offscreen.addEventListener("pointerlockchange", (event) =>
      changes.push((event as Event & { captured: boolean }).captured),
    );
    (offscreen as unknown as HTMLCanvasElement).requestPointerLock();
    await tick();
    globalThis.document.dispatchEvent(new Event("pointerlockerror"));
    await tick();
    handle.stop();
    globalThis.document.dispatchEvent(new Event("pointerlockerror"));
    await tick();
    expect(changes).toEqual([false]);
  });

  it.each(["pointerup", "pointercancel", "stop"])(
    "captures drags outside the canvas and releases on %s",
    async (end) => {
      const { scope, worker } = link();
      const { canvas, container, offscreen } = page();
      const captured = new Set<number>();
      Object.assign(canvas, {
        setPointerCapture: (id: number) => captured.add(id),
        releasePointerCapture: (id: number) => captured.delete(id),
      });
      serveWorkerGame({ start: async () => undefined }, scope);
      const handle = startWorkerGame(
        worker as unknown as Worker,
        container as unknown as HTMLElement,
      );
      await handle.ready;
      const received = vi.fn();
      offscreen.addEventListener(end, received);
      canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 7 }));
      const wasCaptured = captured.has(7);
      if (end === "stop") handle.stop();
      else {
        // The browser retargets an outside release to the element holding pointer capture.
        (captured.has(7) ? canvas : new EventTarget()).dispatchEvent(
          Object.assign(new Event(end), { pointerId: 7 }),
        );
        await tick();
        handle.stop();
      }
      expect(wasCaptured).toBe(true);
      expect(captured.size).toBe(0);
      if (end !== "stop") expect(received).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "removes the canvas on stop and exits only its own pointer lock (%s)",
    async (ownsLock) => {
      const { scope, worker } = link();
      const { canvas, container } = page();
      const documentHost = globalThis.document;
      const exitPointerLock = vi.fn();
      Object.assign(documentHost, { pointerLockElement: ownsLock ? canvas : {}, exitPointerLock });
      serveWorkerGame({ start: async () => undefined }, scope);
      const handle = startWorkerGame(
        worker as unknown as Worker,
        container as unknown as HTMLElement,
      );
      await handle.ready;
      handle.stop();
      expect(container.children).toEqual([]);
      expect(exitPointerLock).toHaveBeenCalledTimes(ownsLock ? 1 : 0);
    },
  );

  it("resolves late bridge methods and live fields, including the runner's clock epoch", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    const remote: Record<string, unknown> = { describe: () => ({}) };
    serveWorkerGame(
      {
        start: async () => {
          scope.__THREENATIVE_PLAYTEST_BRIDGE__ = remote;
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    let epoch = 0;
    Object.defineProperty(remote, "_clockEpoch", { get: () => epoch });
    remote._setClockMode = () => {
      epoch += 1;
      return { epoch };
    };
    remote.sample = () => ({ clock: { mode: "wall-clock" } });
    const bridge = view.__THREENATIVE_PLAYTEST_BRIDGE__ as {
      _clockEpoch: number;
      _setClockMode(mode: string): Promise<unknown>;
      sample(): Promise<unknown>;
      $get(field: string): Promise<unknown>;
    };
    try {
      expect(typeof bridge._setClockMode).toBe("function");
      await expect(bridge._setClockMode("wall-clock")).resolves.toEqual({ epoch: 1 });
      expect(bridge._clockEpoch).toBe(1);
      await expect(bridge.$get("_clockEpoch")).resolves.toBe(1);
      const before = bridge._clockEpoch;
      epoch += 1;
      await bridge.sample();
      expect(before === bridge._clockEpoch).toBe(false);
    } finally {
      handle.stop();
    }
  });

  it.each(["error", "messageerror", "stop"])(
    "rejects ready and pending RPCs on %s and detaches listeners",
    async (failure) => {
      const { scope, worker, toWorker } = link();
      const { container, view } = page();
      serveWorkerGame(
        {
          start: () => {
            scope.__THREENATIVE_PLAYTEST_BRIDGE__ = { wait: () => new Promise(() => {}) };
            return new Promise(() => {});
          },
        },
        scope,
      );
      const handle = startWorkerGame(
        worker as unknown as Worker,
        container as unknown as HTMLElement,
      );
      const errors: string[] = [];
      void handle.ready.catch((error: Error) => errors.push(error.message));
      // The page's bridge proxy appears after the worker's announce round trip; poll for it, since a
      // fixed wait loses that race on a loaded host.
      await vi.waitFor(() => expect(view.__THREENATIVE_PLAYTEST_BRIDGE__).toBeDefined(), {
        timeout: 2_000,
      });
      const bridge = view.__THREENATIVE_PLAYTEST_BRIDGE__ as { wait(): Promise<unknown> };
      void bridge.wait().catch((error: Error) => errors.push(error.message));
      await tick();
      if (failure === "stop") handle.stop();
      else
        worker.dispatchEvent(Object.assign(new Event(failure), { message: "module load failed" }));
      await tick();
      const sent = toWorker.length;
      worker.dispatchEvent(new MessageEvent("message", { data: { type: "tn-worker-ready" } }));
      await tick();
      handle.stop();
      expect(errors).toEqual(
        failure === "stop"
          ? [
              "TN_WORKER_STOPPED: the worker game stopped.",
              "TN_WORKER_STOPPED: the worker game stopped.",
            ]
          : ["module load failed", "module load failed"],
      );
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(toWorker).toHaveLength(sent);
    },
  );

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

  it("locks the page's pointer when the worker game asks, and reports the lock back", async () => {
    // The shooter's mouse look: InputMap asks its canvas, an OffscreenCanvas with no pointer lock.
    const { scope, worker } = link();
    const { canvas, container, offscreen } = page();
    const requestPointerLock = vi.fn();
    Object.assign(canvas, { requestPointerLock });
    const pageDocument = globalThis.document as unknown as EventTarget & Record<string, unknown>;
    const exitPointerLock = vi.fn();
    pageDocument.exitPointerLock = exitPointerLock;
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    const target = offscreen as EventTarget & {
      requestPointerLock(): void;
      exitPointerLock(): void;
    };
    target.requestPointerLock();
    await tick();
    expect(requestPointerLock).toHaveBeenCalledTimes(1);
    const changes: unknown[] = [];
    offscreen.addEventListener("pointerlockchange", (event) =>
      changes.push((event as Event & { captured?: boolean }).captured),
    );
    pageDocument.pointerLockElement = canvas;
    pageDocument.dispatchEvent(new Event("pointerlockchange"));
    await tick();
    expect(changes).toEqual([true]);
    target.exitPointerLock();
    await tick();
    expect(exitPointerLock).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("copies the renderer's canvas attributes onto the page canvas", async () => {
    // The harness reads `data-engine` on the page's canvas for capture provenance; the Wasm
    // renderer sets it on its own canvas, which in a worker is the OffscreenCanvas.
    const { scope, worker } = link();
    const { canvas, container, offscreen } = page();
    const setAttribute = vi.fn();
    Object.assign(canvas, { setAttribute });
    serveWorkerGame({ start: async () => undefined }, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    (offscreen as unknown as Element).setAttribute("data-engine", "threenative wasm webgpu");
    await tick();
    expect(setAttribute).toHaveBeenCalledWith("data-engine", "threenative wasm webgpu");
    handle.stop();
  });

  it("mirrors the playtest bridge while start is still held for the runner to attach", async () => {
    // With a runner announced, the playtest plugin holds the boot until the runner calls the
    // bridge: a mirror sent only after start never reaches the page.
    const { scope, worker } = link();
    const { container, view } = page();
    const game = {
      start: () =>
        new Promise<void>((resolve) => {
          scope.__THREENATIVE_PLAYTEST_BRIDGE__ = {
            describe: async () => {
              resolve();
              return { protocolVersion: 1 };
            },
          };
        }),
    };
    serveWorkerGame(game, scope);
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    for (let wait = 0; wait < 20 && view.__THREENATIVE_PLAYTEST_BRIDGE__ === undefined; wait += 1)
      await tick();
    const bridge = view.__THREENATIVE_PLAYTEST_BRIDGE__ as { describe(): Promise<unknown> };
    await expect(bridge.describe()).resolves.toEqual({ protocolVersion: 1 });
    await handle.ready;
    handle.stop();
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

  it("copies the page's navigator facts into the worker before start", async () => {
    const { scope, worker } = link();
    const { container, view } = page();
    view.navigator = {
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent: "Mozilla/5.0 (Linux; Android 14)",
      userAgentData: { mobile: true, platform: "Android" },
    };
    let seen: unknown;
    serveWorkerGame(
      {
        start: async () => {
          seen = scope.__tnPageNavigator;
        },
      },
      scope,
    );
    const handle = startWorkerGame(
      worker as unknown as Worker,
      container as unknown as HTMLElement,
    );
    await handle.ready;
    expect(seen).toEqual(view.navigator);
    expect(detectPlatform({ navigator: seen })).toMatchObject({
      formFactor: "mobile",
      maxTouchPoints: 5,
    });
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
    view.AudioContext = class extends EventTarget {
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
