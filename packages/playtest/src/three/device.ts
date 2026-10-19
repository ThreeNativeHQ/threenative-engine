import {
  PLAYTEST_PROTOCOL_LIMITS,
  assertJsonSafe,
  jsonByteLength,
  playtestDiagnostic,
  type IPlaytestBridgeV1,
  type IPlaytestObservationSnapshot,
  type IPlaytestDeviceRequest,
  type IPlaytestDeviceResponse,
  type JsonValue,
} from "../index.js";

/** One watchdog tick; timers are the observer that survives a stopped frame pump. */
const MAILBOX_WATCHDOG_BEAT_MS = 250;
/** Consecutive unpolled beats before the stall is named: 8 × 250ms = 2000ms. */
const MAILBOX_POLL_STALL_BEATS = 8;

const BRIDGE_METHODS = new Set<keyof IPlaytestBridgeV1>([
  "advance",
  "applySetup",
  "describe",
  "drainEvents",
  "focus",
  "ready",
  "renderOnly",
  "sample",
]);

interface INativePointer {
  buttons: number;
  id: number;
  x: number;
  y: number;
}

export interface IDeviceBridgeInstallation {
  close(): void;
}

export function connectDevicePlaytestBridge(
  bridge: IPlaytestBridgeV1,
  endpoint: string,
): IDeviceBridgeInstallation {
  const nativeInstallation = connectNativeMailbox(bridge);
  if (nativeInstallation !== undefined) return nativeInstallation;
  let closed = false;
  let reportedError = false;
  const nativePointers = new Map<number, INativePointer>();
  let scheduled: number | ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (closed) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      scheduled = globalThis.requestAnimationFrame(() => void poll());
    } else {
      scheduled = setTimeout(() => void poll(), 50);
    }
  };
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const response = await fetch(endpoint);
      if (response.status !== 204) {
        if (!response.ok) throw new Error(`Device bridge poll failed with HTTP ${response.status}.`);
        const request = parseRequest(await response.json());
        await postResponse(endpoint, await dispatch(bridge, request, nativePointers));
      }
    } catch (error) {
      if (!reportedError) {
        reportedError = true;
        console.error(`TN_PLAYTEST_DEVICE_TRANSPORT: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      schedule();
    }
  };
  schedule();
  return {
    close: () => {
      closed = true;
      if (scheduled === undefined) return;
      if (typeof globalThis.cancelAnimationFrame === "function" && typeof scheduled === "number") {
        globalThis.cancelAnimationFrame(scheduled);
      } else clearTimeout(scheduled);
    },
  };
}

function connectNativeMailbox(bridge: IPlaytestBridgeV1): IDeviceBridgeInstallation | undefined {
  const globals = globalThis as typeof globalThis & {
    TN_PLAYTEST_MAILBOX?: { request?: unknown; response?: unknown };
    __THREENATIVE_NATIVE__?: {
      playtest?: {
        network?(): NonNullable<IPlaytestObservationSnapshot["network"]>;
        receive?(path: string): string | undefined;
        respond?(path: string, payload: string, requestId?: string, method?: string, order?: number): boolean;
      };
    };
  };
  const mailbox = globals.TN_PLAYTEST_MAILBOX;
  const host = globals.__THREENATIVE_NATIVE__?.playtest;
  if (
    typeof mailbox?.request !== "string"
    || typeof mailbox.response !== "string"
    || typeof host?.receive !== "function"
    || typeof host.respond !== "function"
  ) return undefined;
  if (typeof host.network === "function") {
    const describe = bridge.describe.bind(bridge);
    bridge.describe = async () => {
      const description = await describe();
      return { ...description, capabilities: [...description.capabilities, "runtime.network"] };
    };
    const sample = bridge.sample.bind(bridge);
    bridge.sample = async (request) => ({ ...await sample(request), network: host.network!() });
  }
  let closed = false;
  let frame: number | undefined;
  const nativePointers = new Map<number, INativePointer>();
  let requestOrder = 0;
  // The poll loop rides requestAnimationFrame, so a host whose frame pump stops goes silent
  // with no error anywhere: the app runs, its loop is not pumping, and the runner waits out its
  // operation timeout. Timers are serviced independently of frames, so a timer-driven watchdog
  // can observe the stall and name it instead of leaving silence (PRD-167).
  let watchdogBeats = 0;
  let polledAtBeat = 0;
  let stallReported = false;
  const respond = (response: IPlaytestDeviceResponse, method?: string, order?: number): void => {
    const sent = method === undefined || order === undefined
      ? host.respond!(mailbox.response as string, JSON.stringify(response), response.id)
      : host.respond!(mailbox.response as string, JSON.stringify(response), response.id, method, order);
    if (!sent) {
      console.error("TN_PLAYTEST_DEVICE_TRANSPORT: native mailbox response failed");
    }
  };
  const poll = (): void => {
    if (closed) return;
    polledAtBeat = watchdogBeats;
    const raw = host.receive!(mailbox.request as string);
    if (raw !== undefined) {
      try {
        const request = parseRequest(JSON.parse(raw));
        const order = ++requestOrder;
        void dispatch(bridge, request, nativePointers).then((response) => respond(response, request.method, order));
      } catch (error) {
        respond({
          error: { message: error instanceof Error ? error.message : String(error) },
          id: "invalid",
        });
      }
    }
    frame = globalThis.requestAnimationFrame(poll);
  };
  const pollWatchdog = setInterval(() => {
    watchdogBeats += 1;
    if (closed || watchdogBeats - polledAtBeat < MAILBOX_POLL_STALL_BEATS) return;
    if (!stallReported) {
      stallReported = true;
      const stall = playtestDiagnostic(
        "TN_PLAYTEST_MAILBOX_POLL_STALLED",
        `the native mailbox poll has not run for ${MAILBOX_POLL_STALL_BEATS * MAILBOX_WATCHDOG_BEAT_MS}ms while timers still fire; the host's requestAnimationFrame frame pump stopped servicing it`,
        "Inspect the host for a stopped or crashed frame pump; the mailbox will keep polling while frames recover.",
      );
      console.error(`${stall.code}: ${stall.message}`);
    }
    if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
    frame = undefined;
    poll();
  }, MAILBOX_WATCHDOG_BEAT_MS);
  respond({ id: "ready", result: null });
  frame = globalThis.requestAnimationFrame(poll);
  return {
    close: () => {
      closed = true;
      clearInterval(pollWatchdog);
      if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
    },
  };
}

export function readPlaytestEndpoint(): string | undefined {
  const value = (globalThis as typeof globalThis & { TN_PLAYTEST_ENDPOINT?: unknown })
    .TN_PLAYTEST_ENDPOINT;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function dispatch(
  bridge: IPlaytestBridgeV1,
  request: IPlaytestDeviceRequest,
  nativePointers: Map<number, INativePointer>,
): Promise<IPlaytestDeviceResponse> {
  try {
    if (request.method.startsWith("input.")) {
      return { id: request.id, result: dispatchInput(request.method, request.argument, nativePointers) };
    }
    if (!BRIDGE_METHODS.has(request.method as keyof IPlaytestBridgeV1)) {
      throw new Error(`Bridge operation '${request.method}' is unavailable.`);
    }
    const operation = bridge[request.method as keyof IPlaytestBridgeV1] as
      | ((this: IPlaytestBridgeV1, argument: never) => unknown)
      | undefined;
    if (typeof operation !== "function") throw new Error(`Bridge operation '${request.method}' is unavailable.`);
    const result = await operation.call(bridge, request.argument as never);
    if (request.method === "advance") advanceHostClock(result);
    if (result !== undefined) assertBounded(result);
    return { id: request.id, ...(result === undefined ? {} : { result: result as JsonValue }) };
  } catch (error) {
    return { error: { message: error instanceof Error ? error.message : String(error) }, id: request.id };
  }
}

function dispatchInput(
  method: string,
  argument: JsonValue | undefined,
  nativePointers: Map<number, INativePointer>,
): JsonValue {
  const host = (globalThis as typeof globalThis & {
    __THREENATIVE_NATIVE__?: {
      playtestInput?: {
        keyboard?(type: string, key: string, code: string): unknown;
        pointer?(
          type: string,
          x: number,
          y: number,
          buttons: number,
          pointerId?: number,
          pointerType?: string,
          isPrimary?: boolean,
        ): void;
        wheel?(x: number, y: number, deltaX: number, deltaY: number): boolean;
        media?(dark: number, reducedMotion: number): boolean;
      };
    };
  }).__THREENATIVE_NATIVE__?.playtestInput;
  if (!isRecord(argument)) throw new Error(`Device ${method} requires an object argument.`);
  if (method === "input.keyDown" || method === "input.keyUp") {
    if (typeof argument.key !== "string") throw new Error(`Device ${method} requires a key.`);
    const code = argument.key;
    const key = /^Key[A-Z]$/u.test(code) ? code.slice(3).toLowerCase() : code;
    if (typeof host?.keyboard !== "function") throw new Error("Native playtest keyboard input is unavailable.");
    const consumed = host.keyboard(method === "input.keyDown" ? "keydown" : "keyup", key, code);
    // The host's UI took this key: a runner that would add an OS-level copy of it must not.
    return consumed === true ? { consumedByUi: true } : null;
  }
  if (method === "input.pointer") {
    if (typeof argument.x !== "number" || typeof argument.y !== "number" || typeof argument.buttons !== "number") {
      throw new Error("Device input.pointer requires numeric x, y, and buttons.");
    }
    if (typeof host?.pointer !== "function") throw new Error("Native playtest pointer input is unavailable.");
    const type = argument.type === "down" ? "pointerdown" : argument.type === "up" ? "pointerup" : "pointermove";
    host.pointer(type, argument.x, argument.y, argument.buttons);
    return null;
  }
  if (method === "input.wheel") {
    const { x, y, deltaX, deltaY } = argument;
    if (![x, y, deltaX, deltaY].every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Device input.wheel requires finite x, y, deltaX and deltaY.");
    }
    if (typeof host?.wheel !== "function") throw new Error("Native playtest wheel input is unavailable.");
    host.wheel(x as number, y as number, deltaX as number, deltaY as number);
    return null;
  }
  if (method === "input.media") {
    const { dark, reducedMotion } = argument;
    if (![dark, reducedMotion].every((value) => value === -1 || value === 0 || value === 1)) {
      throw new Error("Device input.media requires dark and reducedMotion as -1, 0 or 1.");
    }
    if (typeof host?.media !== "function" || !host.media(dark as number, reducedMotion as number)) {
      throw new Error("Native playtest media emulation is unavailable: the host has no native-css UI attached to take it.");
    }
    return null;
  }
  if (method === "input.pointers") {
    if (typeof host?.pointer !== "function") {
      throw new Error("Native playtest multi-pointer input is unavailable.");
    }
    const next = parseNativePointers(argument.pointers);
    const nextById = new Map(next.map((pointer) => [pointer.id, pointer]));
    const previousPrimary = nativePointers.keys().next().value;
    const nextPrimary = nextById.keys().next().value;
    for (const pointer of nativePointers.values()) {
      if (nextById.has(pointer.id)) continue;
      host.pointer(
        "pointerup",
        pointer.x,
        pointer.y,
        0,
        pointer.id,
        "touch",
        pointer.id === previousPrimary,
      );
    }
    for (const pointer of next) {
      const previous = nativePointers.get(pointer.id);
      if (previous === undefined) {
        host.pointer(
          "pointerdown",
          pointer.x,
          pointer.y,
          pointer.buttons,
          pointer.id,
          "touch",
          pointer.id === nextPrimary,
        );
      } else if (
        previous.x !== pointer.x
        || previous.y !== pointer.y
        || previous.buttons !== pointer.buttons
      ) {
        host.pointer(
          "pointermove",
          pointer.x,
          pointer.y,
          pointer.buttons,
          pointer.id,
          "touch",
          pointer.id === nextPrimary,
        );
      }
    }
    nativePointers.clear();
    for (const pointer of next) nativePointers.set(pointer.id, pointer);
    return null;
  }
  throw new Error(`Device input operation '${method}' is unavailable.`);
}

/**
 * Tell the host how many ticks a run just advanced. A host on a fixed UI clock
 * (`TN_CSS_UI_FIXED_STEP_MS`) moves its CSS animation clock by exactly that many steps, which is what
 * makes a mid-transition frame reproducible by tick count; every other host ignores it or lacks it.
 */
function advanceHostClock(result: unknown): void {
  const ticks = isRecord(result) ? result.ticks : undefined;
  if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks <= 0) return;
  (globalThis as typeof globalThis & {
    __THREENATIVE_NATIVE__?: { playtestInput?: { advanceClock?(ticks: number): boolean } };
  }).__THREENATIVE_NATIVE__?.playtestInput?.advanceClock?.(ticks);
}

function parseNativePointers(value: unknown): INativePointer[] {
  if (!Array.isArray(value)) throw new Error("Device input.pointers requires a pointer array.");
  const pointers = value.map((pointer, index) => {
    if (!isRecord(pointer)) throw new Error(`Device input.pointers[${index}] must be an object.`);
    if (
      !Number.isInteger(pointer.id)
      || (pointer.id as number) < 1
      || typeof pointer.x !== "number"
      || !Number.isFinite(pointer.x)
      || typeof pointer.y !== "number"
      || !Number.isFinite(pointer.y)
      || (pointer.buttons !== undefined
        && (!Number.isInteger(pointer.buttons) || (pointer.buttons as number) < 1))
    ) {
      throw new Error(`Device input.pointers[${index}] contains invalid pointer coordinates or buttons.`);
    }
    return {
      buttons: pointer.buttons === undefined ? 1 : pointer.buttons as number,
      id: pointer.id as number,
      x: pointer.x,
      y: pointer.y,
    };
  });
  if (new Set(pointers.map(({ id }) => id)).size !== pointers.length) {
    throw new Error("Device input.pointers requires unique pointer ids.");
  }
  return pointers;
}

function parseRequest(value: unknown): IPlaytestDeviceRequest {
  assertBounded(value);
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    throw new Error("Device request must contain string id and method fields.");
  }
  return value as unknown as IPlaytestDeviceRequest;
}

async function postResponse(endpoint: string, response: IPlaytestDeviceResponse): Promise<void> {
  const result = await fetch(endpoint, {
    body: JSON.stringify(response),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!result.ok) throw new Error(`Device bridge response failed with HTTP ${result.status}.`);
}

function assertBounded(value: unknown): void {
  assertJsonSafe(value);
  if (jsonByteLength(value) > PLAYTEST_PROTOCOL_LIMITS.maxPayloadBytes) {
    throw new Error(`Device bridge payload exceeds ${PLAYTEST_PROTOCOL_LIMITS.maxPayloadBytes} bytes.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
