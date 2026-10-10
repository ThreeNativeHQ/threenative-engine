/** Core's browser-service seams over the shared native player, with no DOM renderer. */
import {
  alloc,
  free,
  playerBind,
  playerCapture,
  playerClose,
  playerCodes,
  playerOpen,
  playerRunner,
  playerStep,
  readString,
  stringBytes,
  writeString,
} from "tn-native-transport";

interface ITimer {
  callback: () => void;
  due: number;
  interval?: number;
}
interface IBridge {
  [method: string]: ((argument?: unknown) => unknown) | undefined;
}
const globals = globalThis as unknown as Record<string, unknown>;
const frames = new Map<number, (time: number) => void>();
const timers = new Map<number, ITimer>();
const listeners = new Map<string, Set<(event: unknown) => void>>();
const held = new Set<string>();
let time = 0;
let nextId = 0;
const canvas = {
  width: 1280,
  height: 720,
  clientWidth: 1280,
  clientHeight: 720,
  style: {},
  addEventListener(type: string, callback: (event: unknown) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(callback);
  },
  removeEventListener(type: string, callback: (event: unknown) => void) {
    listeners.get(type)?.delete(callback);
  },
  requestPointerLock() {
    if (playerCapture(true)) throw new Error("TN_PERRY_POINTER_CAPTURE");
    send("pointerlockchange", { type: "pointerlockchange" });
  },
  exitPointerLock() {
    if (playerCapture(false)) throw new Error("TN_PERRY_POINTER_RELEASE");
    send("pointerlockchange", { type: "pointerlockchange" });
  },
};
function send(type: string, event: unknown): void {
  for (const callback of listeners.get(type) ?? []) callback(event);
}
function flushFrames(now: number): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}
const runner = playerRunner() !== 0;
globals.__THREENATIVE_NATIVE__ = {
  platform: { runtime: "native", os: "linux", formFactor: "desktop", maxTouchPoints: 0 },
};
if (runner) globals.TN_PLAYTEST_ENDPOINT = {};
globals.performance = { now: () => time };
globals.requestAnimationFrame = (callback: (now: number) => void) => {
  frames.set(++nextId, callback);
  return nextId;
};
globals.cancelAnimationFrame = (id: number) => frames.delete(id);
globals.setTimeout = (callback: () => void, delay = 0) => {
  timers.set(++nextId, { callback, due: time + delay });
  return nextId;
};
globals.clearTimeout = (id: number) => timers.delete(id);
globals.setInterval = (callback: () => void, delay: number) => {
  if (!Number.isFinite(delay) || delay <= 0)
    throw new Error("TN_CORE_TIMER: interval must be positive");
  timers.set(++nextId, { callback, due: time + delay, interval: delay });
  return nextId;
};
globals.clearInterval = globals.clearTimeout;

// The mailbox retries a pending observation after Perry drains its promises between player steps.
const observations = new Map<string, { answer?: string }>();
function observationAnswer(value: unknown): string {
  try {
    return JSON.stringify({ result: value });
  } catch (error) {
    return JSON.stringify({ error: `TN_INSPECT_GAME_BRIDGE: ${String(error)}` });
  }
}
function observe(methodPointer: number, argumentPointer: number): number {
  const method = readString(methodPointer);
  const text = readString(argumentPointer);
  const key = `${method}:${text}`;
  let pending = observations.get(key);
  if (!pending) {
    pending = {};
    observations.set(key, pending);
    const bridge = globals.__THREENATIVE_PLAYTEST_BRIDGE__ as IBridge | undefined;
    try {
      if (bridge === undefined) pending.answer = JSON.stringify({ fallback: true });
      else {
        if (bridge === null || typeof bridge !== "object")
          throw new Error("TN_INSPECT_GAME_BRIDGE: installed bridge must be an object");
        const callback = bridge[method];
        if (typeof callback !== "function")
          throw new Error(`TN_INSPECT_GAME_BRIDGE: missing method ${method}`);
        const result = text
          ? callback.call(bridge, JSON.parse(text))
          : method === "sample"
            ? callback.call(bridge, {})
            : callback.call(bridge);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          const waiting = pending;
          (result as Promise<unknown>).then(
            (value) => {
              waiting.answer = observationAnswer(value);
            },
            (error) => {
              waiting.answer = JSON.stringify({ error: String(error) });
            },
          );
        } else pending.answer = observationAnswer(result);
      }
    } catch (error) {
      pending.answer = JSON.stringify({ error: String(error) });
    }
  }
  if (pending.answer === undefined) return 0;
  const size = stringBytes(pending.answer) + 1;
  const pointer = alloc(size);
  if (!pointer) throw new Error("TN_PERRY_OUT_OF_MEMORY");
  if (writeString(pending.answer, pointer, size)) {
    free(pointer);
    throw new Error("TN_PERRY_OBSERVATION_STRING");
  }
  observations.delete(key);
  return pointer;
}
const status = playerBind(
  (dt: number) => {
    time += dt * 1000;
    const codes = playerCodes();
    const now = new Set(codes ? codes.split("\n") : []);
    const keyEvent = (type: string, code: string) =>
      send(type, { code, key: /^Key[A-Z]$/.test(code) ? code[3]?.toLowerCase() : code });
    for (const code of now)
      if (!held.has(code)) {
        held.add(code);
        keyEvent("keydown", code);
      }
    for (const code of [...held])
      if (!now.has(code)) {
        held.delete(code);
        keyEvent("keyup", code);
      }
    for (const [id, timer] of timers) {
      if (timer.due > time) continue;
      if (timer.interval === undefined) timers.delete(id);
      else timer.due += timer.interval;
      timer.callback();
    }
    if (runner) {
      const bridge = globals.__THREENATIVE_PLAYTEST_BRIDGE__ as IBridge | undefined;
      if (typeof bridge?.advance === "function") void bridge.advance(1);
    } else flushFrames(time);
  },
  (frameMs: number) => {
    if (runner) flushFrames(frameMs);
  },
  observe,
);
if (status) throw new Error(`TN_PERRY_PLAYER_BIND:${status}`);

const readSize = () => ({
  width: canvas.width,
  height: canvas.height,
  aspect: canvas.width / canvas.height,
});
export const platform = {
  input: () => [],
  inputTarget: canvas as unknown as EventTarget,
  renderer: {
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    hasWebGPU: () => true,
    readSize: (): readonly [number, number] => [canvas.width, canvas.height],
    observeResize: () => () => {},
  },
  viewport: { readSize, observeResize: () => () => {} },
  mountCanvas() {},
  unmountCanvas() {},
};
export function openPlayer(): void {
  const result = playerOpen();
  if (result) throw new Error(`TN_PERRY_PLAYER_OPEN_FAILED:${result}`);
}
export function stepPlayer(): boolean {
  const result = playerStep();
  if (result < 0) throw new Error(`TN_PERRY_PLAYER_STEP_FAILED:${result}`);
  return result > 0;
}
export function closePlayer(): void {
  playerClose();
}
