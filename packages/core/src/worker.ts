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
import { countDebug, debugRequested } from "./profiling/debug-telemetry.js";
import { markerLogRequested } from "./quiet-markers.js";
import { GAME_STATE_MESSAGE } from "./ui-bridge.js";
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
  /** The page's navigator facts: a WorkerNavigator has no maxTouchPoints, so a phone read as touchless. */
  navigator: Record<string, unknown>;
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
  get?: boolean;
}

type WorkerGamepad = Pick<Gamepad, "id" | "index" | "connected" | "mapping" | "timestamp"> & {
  axes: number[];
  buttons: { pressed: boolean; value: number; touched: boolean }[];
};

type WorkerInbound =
  | IWorkerInitMessage
  | IWorkerResizeMessage
  | IWorkerEventMessage
  | IWorkerRpcMessage
  | { type: "tn-worker-gamepads"; gamepads: (WorkerGamepad | null)[] };

type WorkerOutbound =
  | { type: "tn-worker-ready" }
  | { type: "tn-worker-mirror"; name: string; epoch?: number }
  | { type: "tn-worker-started" }
  | { type: "tn-worker-failed"; message: string }
  | { type: "tn-worker-pointer-lock"; lock: boolean }
  | { type: "tn-worker-attribute"; name: string; value: string }
  | {
      type: "tn-worker-rpc-result";
      id: number;
      name?: string;
      epoch?: number;
      result?: unknown;
      error?: string;
    };

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

// `serializeUiState` writes `{ type, state }` in that order, so a state frame starts with this. A
// prefix test, not a parse: the page parses each frame once already, and that thread is the one to keep free.
const STATE_FRAME_PREFIX = `{"type":${JSON.stringify(GAME_STATE_MESSAGE)},`;

function isStateFrame(frame: unknown): frame is string {
  return typeof frame === "string" && frame.startsWith(STATE_FRAME_PREFIX);
}

/** Shallow primitive payload estimate only: excludes clone headers, nested objects and transfers. */
function debugWorkerMessage(name: string, payload: unknown): void {
  let bytes = 0;
  let unmeasured = 0;
  const primitive = (value: unknown): void => {
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number") bytes += 8;
    else if (typeof value === "boolean") bytes += 1;
    else if (value !== undefined && value !== null) unmeasured++;
  };
  if (typeof payload === "object" && payload !== null) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(payload))) {
      bytes += key.length * 2;
      if ("value" in descriptor) primitive(descriptor.value);
      else unmeasured++; // Observing traffic must not invoke a payload's getter.
    }
  } else primitive(payload);
  const area = name.startsWith("workerUi") ? "ui" : "worker";
  const caller = `worker.ts:${name} (shallow primitive payload; nested/transfer bytes unavailable)`;
  countDebug(`${name}Messages`, 1, area, caller);
  countDebug(`${name}EstimatedBytes`, bytes, area, caller, "estimated-bytes");
  countDebug(`${name}UnmeasuredFields`, unmeasured, area, caller);
  countDebug(`${name}UnmeasuredMessages`, unmeasured > 0 ? 1 : 0, area, caller);
}

/** Times the synchronous postMessage call, including clone/enqueue, not delivery or receiver work. */
function debugWorkerPost(
  name: string,
  target: { postMessage(data: unknown): void },
  payload: unknown,
): void {
  const started = performance.now();
  try {
    target.postMessage(payload);
  } finally {
    const elapsed = performance.now() - started;
    debugWorkerMessage(name, payload); // Counts attempted dispatches, even a refused clone.
    countDebug(
      `${name}DispatchMs`,
      elapsed,
      name.startsWith("workerUi") ? "ui" : "worker",
      `worker.ts:${name}.postMessage (synchronous attempt)`,
      "ms",
    );
  }
}

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
  let debug = debugRequested();
  const outbound: unknown[] = [];
  const inbound: unknown[] = [];
  let snapshot: string | undefined;
  let snapshotPending = false;
  const post = (frame: unknown): void => {
    if (port === undefined) return;
    if (debug) debugWorkerPost("workerUiPost", port, frame);
    else port.postMessage(frame);
  };
  const flushSnapshot = (): void => {
    if (port === undefined || snapshotPending || snapshot === undefined) return;
    snapshotPending = true;
    post(snapshot);
    snapshot = undefined;
  };
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
    if (isStateFrame(frame)) {
      snapshot = frame;
      flushSnapshot();
    } else if (port === undefined) outbound.push(frame);
    else post(frame);
  };
  scope.__tnUiOverlayAttached = () => true;
  const held = {
    attach(next: MessagePort): void {
      port = next;
      debug = debugRequested();
      next.onmessage = (event: MessageEvent) => {
        if (debug) debugWorkerMessage("workerUiReceived", event.data);
        if (event.data?.type === "tn-worker-ui-ack") {
          snapshotPending = false;
          flushSnapshot();
          return;
        }
        if (typeof receive === "function") receive(event.data);
        else inbound.push(event.data);
      };
      for (const frame of outbound.splice(0)) post(frame);
      flushSnapshot();
    },
  };
  scope.__tnWorkerUi = held;
  return held;
}

// In a dedicated worker, before the game module that imports this one after it evaluates.
if (hostWindow() === undefined && "WorkerGlobalScope" in globalThis) {
  // quality-allow: the worker scope is no Window; the UI bridge holds it as a keyed record
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
  // quality-allow: the DOM lib this package compiles with has no DedicatedWorkerGlobalScope type
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): void {
  const inputTarget = new EventTarget();
  const observers = new Set<() => void>();
  const size = { dpr: 1, height: 1, width: 1 };
  let canvas: OffscreenCanvas | undefined;
  let gamepads: (WorkerGamepad | null)[] = [];
  let debug = debugRequested();

  const post = (message: WorkerOutbound): void => {
    if (debug) debugWorkerPost("workerPost", scope, message);
    else scope.postMessage(message);
  };
  const ui = holdUiBridge(scope);

  const initialise = async (message: IWorkerInitMessage): Promise<void> => {
    try {
      canvas = message.canvas;
      // An OffscreenCanvas cannot lock the pointer: the page locks its own canvas, inside the
      // click's activation window, and forwards each pointerlockchange with `captured`. Attributes
      // (the renderer's `data-engine`) land on the page canvas, where the harness reads them.
      Object.assign(canvas, {
        exitPointerLock: () => post({ lock: false, type: "tn-worker-pointer-lock" }),
        requestPointerLock: () => post({ lock: true, type: "tn-worker-pointer-lock" }),
        setAttribute: (name: string, value: string) =>
          post({ name, type: "tn-worker-attribute", value: String(value) }),
      });
      size.width = message.width;
      size.height = message.height;
      size.dpr = message.dpr;
      scope.devicePixelRatio = message.dpr;
      for (const [key, value] of Object.entries(message.globals)) scope[key] = value;
      // Read by platform detection (`isMobile`, `isTouchscreenAvailable`) in place of the worker's own.
      scope.__tnPageNavigator = message.navigator;

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
        input: () => gamepads,
        inputTarget,
        mountCanvas: () => undefined,
        renderer: {
          // quality-allow: three types its canvas as HTMLCanvasElement; the transferred OffscreenCanvas fills that slot
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

      // Mirrored the moment the game installs one: with a runner announced, the playtest plugin
      // holds start until the runner calls the bridge, so a mirror sent after start never arrives.
      const mirror = (name: string, value: unknown): void => {
        if (typeof value !== "object" || value === null) return;
        const epoch = (value as { _clockEpoch?: number })._clockEpoch;
        post({ epoch, name, type: "tn-worker-mirror" });
      };
      for (const name of MIRRORED_GLOBALS) {
        let value = scope[name];
        mirror(name, value);
        Object.defineProperty(scope, name, {
          configurable: true,
          get: () => value,
          set: (next: unknown) => {
            value = next;
            mirror(name, next);
          },
        });
      }

      await game.start();
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
      const receiver = scope[message.name] as Record<string, unknown> | undefined;
      const method = receiver?.[message.method];
      if (!message.get && typeof method !== "function") {
        throw new Error(
          `TN_WORKER_RPC_UNKNOWN: '${message.name}.${message.method}' is not a function.`,
        );
      }
      const result = message.get
        ? method
        : await (method as (...args: unknown[]) => unknown).apply(receiver, message.args);
      post({
        id,
        result,
        name: message.name,
        epoch: receiver?._clockEpoch as number | undefined,
        type: "tn-worker-rpc-result",
      });
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
    if (message.type === "tn-worker-init" && message.globals.__THREENATIVE_DEBUG__ === true)
      debug = true;
    if (debug) debugWorkerMessage("workerReceived", message);
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
      case "tn-worker-gamepads":
        gamepads = message.gamepads;
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
  // quality-allow: the page host is read by key for the globals it forwards
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
  const capturedPointers = new Set<number>();
  const listeners: Array<[EventTarget, string, EventListener]> = [];

  const send = (message: PageOutbound, transfer?: Transferable[]): void => {
    if (stopped) return;
    if (transfer === undefined) worker.postMessage(message);
    else worker.postMessage(message, transfer);
  };

  const postResize = (): void => {
    send({
      dpr: windowHost.devicePixelRatio,
      height: Math.max(1, canvas.clientHeight),
      type: "tn-worker-resize",
      width: Math.max(1, canvas.clientWidth),
    });
  };

  const listen = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };

  let gamepadFrame: number | undefined;
  const pollGamepads = (): void => {
    if (gamepadFrame !== undefined) windowHost.cancelAnimationFrame(gamepadFrame);
    gamepadFrame = undefined;
    if (stopped) return;
    const gamepads = Array.from(windowHost.navigator?.getGamepads?.() ?? [], (pad) =>
      pad === null
        ? null
        : {
            id: pad.id,
            index: pad.index,
            connected: pad.connected,
            mapping: pad.mapping,
            timestamp: pad.timestamp,
            axes: Array.from(pad.axes),
            buttons: Array.from(pad.buttons, ({ pressed, value, touched }) => ({
              pressed,
              value,
              touched,
            })),
          },
    );
    send({ type: "tn-worker-gamepads", gamepads });
    if (gamepads.some((pad) => pad?.connected))
      gamepadFrame = windowHost.requestAnimationFrame(pollGamepads);
  };
  listen(windowHost, "gamepadconnected", pollGamepads);
  listen(windowHost, "gamepaddisconnected", pollGamepads);

  const eventFields = (event: Event): Record<string, unknown> => {
    // quality-allow: a DOM event is copied by key into a structured-clone message
    const source = event as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const field of EVENT_FIELDS) {
      if (field in event) fields[field] = source[field];
    }
    return fields;
  };

  let motionFrame: number | undefined;
  const motion = new Map<string, IWorkerEventMessage>();
  const postEvent = (message: IWorkerEventMessage, rect?: DOMRect): void => {
    const fields = message.event;
    // The worker draws on the canvas, so its pointer coordinates must be canvas-relative.
    if (message.target === "canvas" || fields.type === "wheel") {
      const bounds = rect ?? canvas.getBoundingClientRect();
      const { clientX, clientY } = fields;
      if (typeof clientX === "number") fields.clientX = clientX - bounds.left;
      if (typeof clientY === "number") fields.clientY = clientY - bounds.top;
    }
    send(message);
  };
  const flushMotion = (): void => {
    if (motionFrame !== undefined) windowHost.cancelAnimationFrame(motionFrame);
    motionFrame = undefined;
    if (stopped) motion.clear();
    if (motion.size === 0) return;
    const rect = [...motion.values()].some((message) => message.target === "canvas")
      ? canvas.getBoundingClientRect()
      : undefined;
    for (const message of motion.values()) postEvent(message, rect);
    motion.clear();
  };
  const forward = (event: Event, target: "window" | "canvas"): void => {
    if (stopped) return;
    // Match InputMap: wheel events on DOM overlays belong to the HUD.
    if (
      event.type === "wheel" &&
      event.target != null &&
      event.target !== windowHost &&
      event.target !== canvas
    )
      return;
    const fields = eventFields(event);
    if (event.type === "pointermove" || event.type === "mousemove") {
      const key = `${target}:${event.type}:${fields.pointerId ?? ""}`;
      const previous = motion.get(key)?.event;
      fields.movementX = Number(previous?.movementX ?? 0) + Number(fields.movementX ?? 0);
      fields.movementY = Number(previous?.movementY ?? 0) + Number(fields.movementY ?? 0);
      motion.set(key, { event: fields, target, type: "tn-worker-event" });
      motionFrame ??= windowHost.requestAnimationFrame(flushMotion);
      return;
    }
    flushMotion();
    postEvent({ event: fields, target, type: "tn-worker-event" });
  };

  for (const type of WINDOW_EVENTS) listen(windowHost, type, (event) => forward(event, "window"));
  const releasePointer = (id: number): void => {
    if (!capturedPointers.delete(id)) return;
    try {
      canvas.releasePointerCapture?.(id);
    } catch {
      // The browser may already have released a cancelled pointer.
    }
  };
  for (const type of CANVAS_EVENTS)
    listen(canvas, type, (event) => {
      const id = (event as PointerEvent).pointerId;
      if (type === "pointerdown" && canvas.setPointerCapture !== undefined) {
        try {
          canvas.setPointerCapture(id);
          capturedPointers.add(id);
        } catch {
          // Synthetic events have no active browser pointer to capture.
        }
      }
      forward(event, "canvas");
      if (type === "pointerup" || type === "pointercancel") releasePointer(id);
    });
  listen(canvas, "contextmenu", (event) => event.preventDefault());
  const pageLock = documentHost as Document & { pointerLockElement?: Element | null };
  const sendLock = (captured: boolean): void =>
    send({
      event: { captured, type: "pointerlockchange" },
      target: "canvas",
      type: "tn-worker-event",
    });
  listen(pageLock, "pointerlockchange", () => sendLock(pageLock.pointerLockElement === canvas));
  listen(pageLock, "pointerlockerror", () => sendLock(false));
  const pointerLock = (lock: boolean): void => {
    if (!lock) {
      pageLock.exitPointerLock?.();
      return;
    }
    // A refused lock fires no pointerlockchange: report it, or the game believes it captured.
    const refused = (): void => sendLock(false);
    try {
      void (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch(refused);
    } catch {
      refused();
    }
  };

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

  const pageNavigator = (source: Navigator | undefined): Record<string, unknown> => {
    const agent = (source as { userAgentData?: { mobile?: unknown; platform?: unknown } })
      ?.userAgentData;
    return {
      maxTouchPoints: source?.maxTouchPoints,
      platform: source?.platform,
      userAgent: source?.userAgent,
      ...(agent === undefined
        ? {}
        : { userAgentData: { mobile: agent.mobile, platform: agent.platform } }),
    };
  };

  const pageGlobals = (): Record<string, string | number | boolean> => {
    const globals: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(page)) {
      if (!key.startsWith("__THREENATIVE_")) continue;
      const value = page[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        globals[key] = value;
      }
    }
    // The worker's own URL carries no `?tnLog`, so the page's answer travels as the global.
    if (markerLogRequested()) globals.__THREENATIVE_LOG__ = true;
    if (debugRequested()) globals.__THREENATIVE_DEBUG__ = true;
    return globals;
  };

  // The UI mounts before the game is ready, so its host globals exist from the first call.
  page.tnHost = { postMessage: (frame: string) => uiPort.postMessage(frame) };
  page.__tnUiOverlayAttached = () => true;
  installed.add("tnHost");
  installed.add("__tnUiOverlayAttached");
  uiPort.onmessage = (event: MessageEvent) => {
    const receive = page.__tnUiReceive;
    try {
      if (typeof receive === "function") (receive as (frame: unknown) => void)(event.data);
    } finally {
      if (isStateFrame(event.data)) uiPort.postMessage({ type: "tn-worker-ui-ack" });
    }
  };

  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const mirrorEpochs = new Map<string, number>();
  const installMirror = (name: string, epoch = 0): void => {
    mirrorEpochs.set(name, epoch);
    const call = (method: string, args: unknown[], get = false): Promise<unknown> => {
      if (stopped) {
        return Promise.reject(new Error("TN_WORKER_STOPPED: the worker game stopped."));
      }
      const id = nextRpcId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { reject, resolve });
        send({ args, get, id, method, name, type: "tn-worker-rpc" });
      });
    };
    page[name] = new Proxy(
      {},
      {
        get: (_target, method) => {
          // Promise resolution probes "then"; the mirror itself is not a thenable.
          if (typeof method !== "string" || method === "then") return undefined;
          // The runner reads the epoch synchronously around sample(); each RPC refreshes it.
          if (method === "_clockEpoch") return mirrorEpochs.get(name) ?? 0;
          if (method === "$get") return (field: string) => call(field, [], true);
          return (...args: unknown[]) => call(method, args);
        },
      },
    );
    installed.add(name);
  };

  const sendInit = (): void => {
    const init: IWorkerInitMessage = {
      canvas: offscreen,
      dpr: windowHost.devicePixelRatio ?? 1,
      globals: pageGlobals(),
      height: Math.max(1, canvas.clientHeight),
      navigator: pageNavigator(windowHost.navigator),
      pageUrl: windowHost.location.href,
      type: "tn-worker-init",
      ui: gamePort,
      width: Math.max(1, canvas.clientWidth),
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
    pollGamepads();
  };

  const onWorkerMessage = (event: Event): void => {
    if (stopped) return;
    const message = (event as MessageEvent).data as WorkerOutbound;
    switch (message.type) {
      case "tn-worker-ready":
        sendInit();
        break;
      case "tn-worker-pointer-lock":
        pointerLock(message.lock);
        break;
      case "tn-worker-attribute":
        canvas.setAttribute(message.name, message.value);
        break;
      case "tn-worker-mirror":
        installMirror(message.name, message.epoch);
        break;
      case "tn-worker-started":
        resolveReady();
        break;
      case "tn-worker-failed":
        stop(new Error(message.message));
        break;
      case "tn-worker-rpc-result": {
        const call = pending.get(message.id);
        if (call === undefined) break;
        pending.delete(message.id);
        if (message.name !== undefined && message.epoch !== undefined)
          mirrorEpochs.set(message.name, message.epoch);
        if (message.error === undefined) call.resolve(message.result);
        else call.reject(new Error(message.error));
        break;
      }
    }
  };

  const stop = (error = new Error("TN_WORKER_STOPPED: the worker game stopped.")): void => {
    if (stopped) return;
    stopped = true;
    rejectReady(error);
    if (gamepadFrame !== undefined) windowHost.cancelAnimationFrame(gamepadFrame);
    flushMotion();
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    listeners.length = 0;
    observer?.disconnect();
    if (pageLock.pointerLockElement === canvas) pointerLock(false);
    for (const id of capturedPointers) releasePointer(id);
    canvas.remove();
    for (const call of pending.values()) call.reject(error);
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

  listen(worker, "message", onWorkerMessage);
  const onWorkerError = (event: Event): void => {
    const message = (event as ErrorEvent).message;
    stop(new Error(message || `TN_WORKER_FAILED: worker ${event.type}.`));
  };
  listen(worker, "error", onWorkerError);
  listen(worker, "messageerror", onWorkerError);
  return { ready, stop };
}
