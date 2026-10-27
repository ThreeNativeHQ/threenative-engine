/**
 * The worker game host (PRD-752): the page keeps the DOM, the canvas and the input, while the
 * unchanged portable game runs in a dedicated worker on an OffscreenCanvas.
 *
 * A worker cannot reach `window`, `document` or `ResizeObserver`, so the page forwards what the
 * game would have read, one plain message at a time. The canvas frame and the UI bridge travel on
 * their own ports: the game's start is slow, and a HUD that mounts first must not wait for it.
 */

import type { IGamePlatformSource } from "./game.js";
import { hostDocument, hostResizeObserver, hostWindow } from "./platform.js";
import { createRemoteAudioContext, serveRemoteAudio } from "./worker-audio.js";

/** The realm `serveWorkerGame` runs in. Narrowed, because a test cannot build a real worker scope. */
export type WorkerScope = EventTarget &
  Record<string, unknown> & {
    postMessage(data: unknown): void;
  };

interface IWorkerInitMessage {
  type: "tn-worker-init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
  pageUrl: string;
  globals: Record<string, string | number | boolean>;
  ui: MessagePort;
  /** The page's AudioContext, served over its own port; absent where the page has none. */
  audio?: { port: MessagePort; sampleRate: number; currentTime: number };
}

interface IWorkerResizeMessage {
  type: "tn-worker-resize";
  width: number;
  height: number;
  dpr: number;
}

interface IWorkerEventMessage {
  type: "tn-worker-event";
  target: "window" | "canvas";
  event: Record<string, unknown>;
}

interface IWorkerRpcMessage {
  type: "tn-worker-rpc";
  id: number;
  name: string;
  method: string;
  args: unknown[];
}

type WorkerInbound =
  | IWorkerInitMessage
  | IWorkerResizeMessage
  | IWorkerEventMessage
  | IWorkerRpcMessage;

type WorkerOutbound =
  | { type: "tn-worker-ready" }
  | { type: "tn-worker-mirror"; name: string; methods: string[] }
  | { type: "tn-worker-started" }
  | { type: "tn-worker-failed"; message: string }
  | { type: "tn-worker-rpc-result"; id: number; result?: unknown; error?: string };

type PageOutbound = WorkerInbound;

interface IPendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Debug surfaces the playtest harness drives from the page; they exist inside the worker only. */
const MIRRORED_GLOBALS = ["__THREENATIVE_PLAYTEST_BRIDGE__", "__THREENATIVE__"] as const;

/** The fields an input event carries across the boundary. `type` rides along as the event's name. */
const EVENT_FIELDS = [
  "type",
  "key",
  "code",
  "repeat",
  "altKey",
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "button",
  "buttons",
  "movementX",
  "movementY",
  "pointerId",
  "pointerType",
  "isPrimary",
  "pressure",
  "deltaX",
  "deltaY",
  "deltaZ",
  "deltaMode",
  "clientX",
  "clientY",
] as const;

const WINDOW_EVENTS = ["keydown", "keyup", "mousemove", "wheel", "blur"] as const;
const CANVAS_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "click",
] as const;

/**
 * The game end of the UI bridge, live before the page's port arrives.
 *
 * A game module may connect its bridge while it evaluates (`game.ui.onIntent` at top level), and
 * the bridge picks its transport once, at connect. So the host globals exist from the moment this
 * module loads, frames each way wait in order, and `attach` joins them to the page's port.
 */
function holdUiBridge(scope: Record<string, unknown>): { attach(port: MessagePort): void } {
  const existing = scope.__tnWorkerUi as { attach(port: MessagePort): void } | undefined;
  if (existing !== undefined) return existing;
  let port: MessagePort | undefined;
  const outbound: unknown[] = [];
  const inbound: unknown[] = [];
  let receive = scope.__tnUiGameReceive as ((frame: unknown) => void) | undefined;
  Object.defineProperty(scope, "__tnUiGameReceive", {
    configurable: true,
    get: () => receive,
    set: (value: ((frame: unknown) => void) | undefined) => {
      receive = value;
      if (typeof value === "function") for (const frame of inbound.splice(0)) value(frame);
    },
  });
  scope.__tnUiPost = (frame: string) => {
    if (port === undefined) outbound.push(frame);
    else port.postMessage(frame);
  };
  scope.__tnUiOverlayAttached = () => true;
  const held = {
    attach(next: MessagePort): void {
      port = next;
      next.onmessage = (event: MessageEvent) => {
        if (typeof receive === "function") receive(event.data);
        else inbound.push(event.data);
      };
      for (const frame of outbound.splice(0)) next.postMessage(frame);
    },
  };
  scope.__tnWorkerUi = held;
  return held;
}

// In a dedicated worker, before the game module that imports this one after it evaluates.
if (hostWindow() === undefined && "WorkerGlobalScope" in globalThis) {
  holdUiBridge(globalThis as unknown as Record<string, unknown>);
}

/**
 * Runs inside the worker: wire the page's messages to the unchanged portable game.
 *
 * Call it last in the worker entry, after the game module evaluated: it posts the ready message
 * the page waits for before it sends the canvas.
 * @situation run the game loop in a web worker so a busy page cannot stall its frames
 * @example serveWorkerGame(game);
 */
export function serveWorkerGame(
  game: { start(): Promise<void> },
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): void {
  const inputTarget = new EventTarget();
  const observers = new Set<() => void>();
  const size = { dpr: 1, height: 1, width: 1 };
  let canvas: OffscreenCanvas | undefined;

  const post = (message: WorkerOutbound): void => scope.postMessage(message);
  const ui = holdUiBridge(scope);

  const initialise = async (message: IWorkerInitMessage): Promise<void> => {
    try {
      canvas = message.canvas;
      size.width = message.width;
      size.height = message.height;
      size.dpr = message.dpr;
      scope.devicePixelRatio = message.dpr;
      for (const [key, value] of Object.entries(message.globals)) scope[key] = value;

      // A worker resolves relative URLs against its own script, so the page's URL is the base.
      const pageUrl = message.pageUrl;
      const resolve = (input: RequestInfo | URL): RequestInfo | URL =>
        typeof input === "string" || input instanceof URL ? new URL(input, pageUrl) : input;
      const originalFetch = scope.fetch as typeof fetch;
      scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        originalFetch(resolve(input), init)) as typeof fetch;
      const OriginalRequest = scope.Request as typeof Request;
      scope.Request = class extends OriginalRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          super(resolve(input), init);
        }
      };

      const observe = (_target: HTMLCanvasElement, resize: () => void): (() => void) => {
        observers.add(resize);
        return () => {
          observers.delete(resize);
        };
      };
      const platform: IGamePlatformSource = {
        input: () => [],
        inputTarget,
        mountCanvas: () => undefined,
        renderer: {
          createCanvas: () => message.canvas as unknown as HTMLCanvasElement,
          hasWebGPU: () => "gpu" in navigator,
          observeResize: observe,
          readSize: () => [size.width, size.height],
        },
        unmountCanvas: () => undefined,
        viewport: {
          observeResize: observe,
          readSize: () => ({
            aspect: size.width / size.height,
            height: size.height,
            width: size.width,
          }),
        },
      };
      scope.__tnGamePlatform = platform;

      const audio = message.audio;
      if (audio !== undefined) {
        // Created on first use, so a silent game opens no page AudioContext traffic.
        let remote: AudioContext | undefined;
        scope.AudioContext = function RemoteAudioContext() {
          remote ??= createRemoteAudioContext(audio.port, audio);
          return remote;
        };
      }

      ui.attach(message.ui);

      await game.start();

      for (const name of MIRRORED_GLOBALS) {
        const value = scope[name];
        if (typeof value !== "object" || value === null) continue;
        const methods = Object.keys(value).filter(
          (key) => typeof (value as Record<string, unknown>)[key] === "function",
        );
        post({ methods, name, type: "tn-worker-mirror" });
      }
      post({ type: "tn-worker-started" });
    } catch (error) {
      post({
        message: error instanceof Error ? error.message : String(error),
        type: "tn-worker-failed",
      });
    }
  };

  const dispatchForwarded = (message: IWorkerEventMessage): void => {
    const forwarded = new Event(String(message.event.type), { cancelable: true });
    for (const [key, value] of Object.entries(message.event)) {
      Object.defineProperty(forwarded, key, { enumerable: true, value });
    }
    if (message.target === "window") inputTarget.dispatchEvent(forwarded);
    else {
      canvas?.dispatchEvent(forwarded);
      // On a page a canvas event bubbles to the window, where AudioBus waits for its gesture.
      const bubbled = new Event(forwarded.type);
      for (const [key, value] of Object.entries(message.event))
        Object.defineProperty(bubbled, key, { enumerable: true, value });
      inputTarget.dispatchEvent(bubbled);
    }
  };

  const handleRpc = async (message: IWorkerRpcMessage): Promise<void> => {
    const id = message.id;
    try {
      const receiver = scope[message.name] as
        | Record<string, (...args: unknown[]) => unknown>
        | undefined;
      const method = receiver?.[message.method];
      if (typeof method !== "function") {
        throw new Error(
          `TN_WORKER_RPC_UNKNOWN: '${message.name}.${message.method}' is not a function.`,
        );
      }
      const result = await method.apply(receiver, message.args);
      post({ id, result, type: "tn-worker-rpc-result" });
    } catch (error) {
      post({
        error: error instanceof Error ? error.message : String(error),
        id,
        type: "tn-worker-rpc-result",
      });
    }
  };

  const onMessage = (event: Event): void => {
    const message = (event as MessageEvent).data as WorkerInbound;
    switch (message.type) {
      case "tn-worker-init":
        void initialise(message);
        break;
      case "tn-worker-resize":
        size.width = message.width;
        size.height = message.height;
        size.dpr = message.dpr;
        scope.devicePixelRatio = message.dpr;
        for (const observer of [...observers]) observer();
        break;
      case "tn-worker-event":
        dispatchForwarded(message);
        break;
      case "tn-worker-rpc":
        void handleRpc(message);
        break;
    }
  };

  scope.addEventListener("message", onMessage);
  post({ type: "tn-worker-ready" });
}

/**
 * Runs on the page: own the canvas and the DOM, and feed the worker game.
 *
 * Call it before the UI mounts: the HUD's bridge host globals exist from this call on.
 * @situation host a worker-run game's canvas, input and HUD on the page
 * @example const handle = startWorkerGame(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }), root);
 */
export function startWorkerGame(
  worker: Worker,
  container: HTMLElement,
): { ready: Promise<void>; stop(): void } {
  const documentHost = hostDocument();
  const windowHost = hostWindow();
  if (documentHost === undefined || windowHost === undefined) {
    throw new Error("TN_WORKER_HOST_REQUIRED: startWorkerGame runs on a page.");
  }
  const page = windowHost as unknown as Record<string, unknown>;

  const canvas = documentHost.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  container.append(canvas);
  const offscreen = canvas.transferControlToOffscreen();
  const { port1: uiPort, port2: gamePort } = new MessageChannel();

  let stopped = false;
  let nextRpcId = 0;
  const pending = new Map<number, IPendingCall>();
  const installed = new Set<string>();
  const listeners: Array<[EventTarget, string, EventListener]> = [];

  const send = (message: PageOutbound, transfer?: Transferable[]): void => {
    if (stopped) return;
    if (transfer === undefined) worker.postMessage(message);
    else worker.postMessage(message, transfer);
  };

  const postResize = (): void => {
    send({
      dpr: windowHost.devicePixelRatio,
      height: canvas.clientHeight,
      type: "tn-worker-resize",
      width: canvas.clientWidth,
    });
  };

  const listen = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };

  const eventFields = (event: Event): Record<string, unknown> => {
    const source = event as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const field of EVENT_FIELDS) {
      if (field in event) fields[field] = source[field];
    }
    return fields;
  };

  const forward = (event: Event, target: "window" | "canvas"): void => {
    if (stopped) return;
    const fields = eventFields(event);
    // The worker draws on the canvas, so its pointer coordinates must be canvas-relative.
    if (target === "canvas" || event.type === "wheel") {
      const rect = canvas.getBoundingClientRect();
      const { clientX, clientY } = fields;
      if (typeof clientX === "number") fields.clientX = clientX - rect.left;
      if (typeof clientY === "number") fields.clientY = clientY - rect.top;
    }
    send({ event: fields, target, type: "tn-worker-event" });
  };

  for (const type of WINDOW_EVENTS) listen(windowHost, type, (event) => forward(event, "window"));
  for (const type of CANVAS_EVENTS) listen(canvas, type, (event) => forward(event, "canvas"));
  listen(canvas, "contextmenu", (event) => event.preventDefault());

  // The worker's game plays through the page's own AudioContext, resumed by a page gesture.
  const AudioContextCtor = page.AudioContext as (new () => AudioContext) | undefined;
  const audioContext = AudioContextCtor === undefined ? undefined : new AudioContextCtor();
  const audioChannel = audioContext === undefined ? undefined : new MessageChannel();
  const stopAudio =
    audioContext === undefined || audioChannel === undefined
      ? undefined
      : serveRemoteAudio(audioChannel.port1, audioContext);
  if (audioContext !== undefined) {
    const resume = (): void => void audioContext.resume?.().catch(() => undefined);
    for (const type of ["keydown", "pointerdown", "touchstart"]) listen(windowHost, type, resume);
  }

  const ResizeObserverCtor = hostResizeObserver();
  const observer =
    ResizeObserverCtor === undefined ? undefined : new ResizeObserverCtor(() => postResize());
  observer?.observe(canvas);

  const pageGlobals = (): Record<string, string | number | boolean> => {
    const globals: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(page)) {
      if (!key.startsWith("__THREENATIVE_")) continue;
      const value = page[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        globals[key] = value;
      }
    }
    return globals;
  };

  // The UI mounts before the game is ready, so its host globals exist from the first call.
  page.tnHost = { postMessage: (frame: string) => uiPort.postMessage(frame) };
  page.__tnUiOverlayAttached = () => true;
  installed.add("tnHost");
  installed.add("__tnUiOverlayAttached");
  uiPort.onmessage = (event: MessageEvent) => {
    const receive = page.__tnUiReceive;
    if (typeof receive === "function") (receive as (frame: unknown) => void)(event.data);
  };

  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const installMirror = (name: string, methods: string[]): void => {
    const host: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of methods) {
      host[method] = (...args: unknown[]) => {
        if (stopped) {
          return Promise.reject(new Error("TN_WORKER_STOPPED: the worker game stopped."));
        }
        const id = nextRpcId++;
        return new Promise<unknown>((resolve, reject) => {
          pending.set(id, { reject, resolve });
          send({ args, id, method, name, type: "tn-worker-rpc" });
        });
      };
    }
    page[name] = host;
    installed.add(name);
  };

  const sendInit = (): void => {
    const init: IWorkerInitMessage = {
      canvas: offscreen,
      dpr: windowHost.devicePixelRatio ?? 1,
      globals: pageGlobals(),
      height: canvas.clientHeight,
      pageUrl: windowHost.location.href,
      type: "tn-worker-init",
      ui: gamePort,
      width: canvas.clientWidth,
    };
    const transfer: Transferable[] = [offscreen, gamePort];
    if (audioContext !== undefined && audioChannel !== undefined) {
      init.audio = {
        currentTime: audioContext.currentTime,
        port: audioChannel.port2,
        sampleRate: audioContext.sampleRate,
      };
      transfer.push(audioChannel.port2);
    }
    send(init, transfer);
  };

  const onWorkerMessage = (event: Event): void => {
    if (stopped) return;
    const message = (event as MessageEvent).data as WorkerOutbound;
    switch (message.type) {
      case "tn-worker-ready":
        sendInit();
        break;
      case "tn-worker-mirror":
        installMirror(message.name, message.methods);
        break;
      case "tn-worker-started":
        resolveReady();
        break;
      case "tn-worker-failed":
        rejectReady(new Error(message.message));
        break;
      case "tn-worker-rpc-result": {
        const call = pending.get(message.id);
        if (call === undefined) break;
        pending.delete(message.id);
        if (message.error === undefined) call.resolve(message.result);
        else call.reject(new Error(message.error));
        break;
      }
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    listeners.length = 0;
    observer?.disconnect();
    worker.removeEventListener("message", onWorkerMessage);
    for (const call of pending.values()) {
      call.reject(new Error("TN_WORKER_STOPPED: the worker game stopped."));
    }
    pending.clear();
    uiPort.onmessage = null;
    uiPort.close();
    gamePort.close();
    stopAudio?.();
    void audioContext?.close?.().catch(() => undefined);
    for (const key of installed) delete page[key];
    installed.clear();
    worker.terminate();
  };

  worker.addEventListener("message", onWorkerMessage);
  return { ready, stop };
}
