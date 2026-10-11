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
  playerSpan,
  playerStep,
  playerUiAttached,
  playerUiPost,
  playerUiTake,
  readString,
  stringBytes,
  writeString,
} from "tn-native-transport";
import { assetPath } from "./perry-asset-path.js";
import { createPerryAudioHost } from "./perry-audio.js";
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
const audioHost = createPerryAudioHost();
globals.AudioContext = audioHost.AudioContext;
globals.webkitAudioContext = audioHost.AudioContext;
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
const span = playerSpan(-1, 0) === 1 ? playerSpan : undefined;
globals.__tnGameSpan = span;
if (span !== undefined) {
  const calls = 100_000;
  for (let warm = 0; warm < 10_000; warm++) playerSpan(-3, 0);
  for (let batch = 0; batch < 3; batch++) {
    let checksum = 0;
    const emptyStart = playerSpan(-2, 0);
    for (let i = 0; i < calls; i++) checksum += i & 1;
    const emptyMs = playerSpan(-2, 0) - emptyStart;
    const start = playerSpan(-2, 0);
    for (let i = 0; i < calls; i++) {
      playerSpan(-3, 0);
      checksum += i & 1;
    }
    const ms = playerSpan(-2, 0) - start;
    console.log(
      `TN_GAME_FFI:${JSON.stringify({ calls, ms, emptyMs, netNs: ((ms - emptyMs) * 1e6) / calls, checksum })}`,
    );
  }
}

globals.__THREENATIVE_NATIVE__ = {
  physics: createPerryPhysicsHost(),
  platform: { runtime: "native", os: "linux", formFactor: "desktop", maxTouchPoints: 0 },
};
if (runner) globals.TN_PLAYTEST_ENDPOINT = {};
globals.__tnUiOverlayAttached = playerUiAttached;
globals.__tnUiPost = playerUiPost;
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
function runDueTimers(): void {
  for (const [id, timer] of timers) {
    if (timer.due > time) continue;
    if (timer.interval === undefined) timers.delete(id);
    else timer.due += timer.interval;
    timer.callback();
  }
}
// The first simulation tick ends the hold: until then a runner has not started the clock.
let ticked = false;
let lastFrameMs: number | undefined;
const status = playerBind(
  (dt: number) => {
    ticked = true;
    audioHost.update();
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
    runDueTimers();
    if (runner) {
      const bridge = globals.__THREENATIVE_PLAYTEST_BRIDGE__ as IBridge | undefined;
      if (typeof bridge?.advance === "function") {
        span?.(25, 0);
        try {
          void bridge.advance(1);
        } finally {
          span?.(25, 1);
        }
      }
    } else flushFrames(time);
  },
  (frameMs: number) => {
    // Decodes settle on the host's frames, not on simulation ticks: a game held by a runner
    // (no ticks yet) still finishes loading its audio before its first describe().
    audioHost.update();
    span?.(28, 0);
    for (let message = playerUiTake(); message !== undefined; message = playerUiTake()) {
      const receive = globals.__tnUiGameReceive;
      if (typeof receive !== "function") {
        console.log('TN_UI_BRIDGE:{"dropped":"no __tnUiGameReceive"}');
        continue;
      }
      try {
        receive(message);
      } catch (error) {
        console.error(`TN_UI_RECEIVE_FAILED: ${String(error)}`);
      }
    }
    span?.(28, 1);
    if (!runner) return;
    // A game held by a runner has no ticks, yet its loading timers (setTimeout 0 between warm-up
    // slices) must fire: until the first tick they follow the host's frame clock, as the V8
    // host's page timers follow real time.
    if (!ticked) {
      if (lastFrameMs !== undefined) time += frameMs - lastFrameMs;
      lastFrameMs = frameMs;
      runDueTimers();
    }
    flushFrames(frameMs);
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
  audioHost.close();
  playerClose();
}
