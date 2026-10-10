/** Core's browser-service seams over the shared native player, with no DOM renderer. */
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error -- only the strict native facade exports this transport hook.
import { __tnLoadAsset } from "three";
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
import { createPerryPhysicsHost } from "./perry-physics.js";
import { nativeImageBitmaps } from "./texture-sources.js";

interface ITimer {
  callback: () => void;
  due: number;
  interval?: number;
}
interface IBridge {
  [method: string]: ((argument?: unknown) => unknown) | undefined;
}
const globals = globalThis as unknown as Record<string, unknown>;
// Perry's own timer, kept before the game clock replaces it: a step loop that awaits only
// microtasks never lets Perry's event loop settle fetch or any other host I/O.
const hostTimeout = globalThis.setTimeout;
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
  physics: createPerryPhysicsHost(),
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

// Perry's fetch takes only absolute network URLs; a web game fetches its own files relative to
// the page. Those resolve against the game's `public/` directory (TN_ASSET_ROOT overrides it), and
// a missing file answers 404, as a static server would. A URL with a scheme keeps Perry's fetch.
const hostFetch = globalThis.fetch;
const assetRoot = (process.env.TN_ASSET_ROOT ?? "public").replace(/\/+$/, "");
export function assetPath(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  const path = decodeURIComponent(url.replace(/[?#].*$/, "")).replace(/^(\.?\/)+/, "");
  if (path.split("/").includes(".."))
    throw new Error(`TN_PERRY_ASSET_PATH: ${url} leaves the root`);
  return `${assetRoot}/${path}`;
}
globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const file = assetPath(url);
  if (file === undefined) return hostFetch(input, init);
  if (!existsSync(file)) return new Response(null, { status: 404, statusText: "Not Found" });
  return new Response(readFileSync(file), { status: 200 });
};

globals.createImageBitmap = async (source: unknown, ...rest: unknown[]) => {
  if (rest.length > 1)
    throw new Error("TN_NATIVE_IMAGE_BITMAP_CROP: a source rectangle is unsupported");
  const options = (rest[0] ?? {}) as ImageBitmapOptions;
  if (options.premultiplyAlpha === "premultiply")
    throw new Error("TN_NATIVE_IMAGE_BITMAP_OPTION: premultiplyAlpha premultiply is unsupported");
  for (const option of ["resizeWidth", "resizeHeight", "resizeQuality"] as const)
    if (options[option] !== undefined)
      throw new Error(`TN_NATIVE_IMAGE_BITMAP_OPTION: ${option} is unsupported`);
  const input = source as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  const bytes = typeof input?.arrayBuffer === "function" ? await input.arrayBuffer() : source;
  // Perry's Blob/Response.arrayBuffer() answer a Buffer: a Uint8Array that isView rejects.
  const encoded =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : undefined;
  if (encoded === undefined)
    throw new TypeError("TN_NATIVE_IMAGE_BITMAP_SOURCE: expected encoded image bytes or a Blob");
  const texture = (__tnLoadAsset as (kind: number, bytes: Uint8Array) => object[])(2, encoded)[0];
  if (!texture) throw new Error("TN_NATIVE_IMAGE_DECODE: no texture");
  const image = (texture as { image: { width: number; height: number } }).image;
  const state = {
    texture: texture as object | undefined,
    flipped: options.imageOrientation === "flipY",
  };
  const bitmap = {
    width: image.width,
    height: image.height,
    close() {
      state.texture = undefined;
    },
  };
  nativeImageBitmaps.set(bitmap, state);
  return bitmap;
};

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
/** One turn of Perry's event loop between player steps, so pending host I/O settles. */
export function nextHostTurn(): Promise<void> {
  return new Promise((resolve) => hostTimeout(() => resolve(), 0));
}
export function closePlayer(): void {
  playerClose();
}
