// Browser-service compatibility for core's existing seams; time advances on native fixed ticks.
// The native marker keeps assets/physics/platform selection on the native path, even without DOM.
import { audio } from "./core-audio.mjs";
import { GAME_SPANS } from "../../../../core/src/profiling/Spans.ts";
globalThis.__THREENATIVE_NATIVE__ = { ...globalThis.__THREENATIVE_NATIVE__, platform: globalThis.tn.platform, presentMode: globalThis.tn.presentMode };
let time = 0;
let nextId = 0;
const frames = new Map();
const timers = new Map();
const listeners = new Map();
const held = new Set();

export const canvas = {
  width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, parentElement: null,
  addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  },
  removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
};
// Pointer lock on the canvas core reads input from, as the legacy host gives it (SDL relative mouse
// mode, __tnPointerCapture): core's captureMouse/releaseMouse, with the pointerlockchange they await.
const pointerLock = (on) => {
  globalThis.__tnPointerCapture(on);
  for (const callback of [...(listeners.get("pointerlockchange") ?? [])]) callback({ type: "pointerlockchange" });
};
// The legacy host installs the drawing surface as a global too; a script entry (the load test) reads it there.
globalThis.canvas = canvas;
canvas.requestPointerLock = () => pointerLock(true);
canvas.exitPointerLock = () => pointerLock(false);
// A real monotonic clock, as a page has: ticks and timers keep their fixed-step time, but
// intra-frame phases and startup milestones must read real milliseconds.
globalThis.performance = { now: typeof globalThis.__tnWallMs === "function" ? globalThis.__tnWallMs : () => time };
globalThis.console = Object.fromEntries(["log", "info", "warn", "error"].map((name) => [name, (...args) => globalThis.tn.log(...args)]));
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextId, callback);
  return nextId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.setTimeout = (callback, delay = 0) => {
  timers.set(++nextId, { callback, due: time + delay });
  return nextId;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.setInterval = (callback, delay) => {
  if (!Number.isFinite(delay) || delay <= 0) throw new Error("TN_CORE_TIMER: interval must be positive");
  timers.set(++nextId, { callback, due: time + delay, interval: delay });
  return nextId;
};
globalThis.clearInterval = globalThis.clearTimeout;

const runnerAttached = () => globalThis.TN_PLAYTEST_ENDPOINT !== undefined;
// Frame callbacks follow the presented frame, never the 60 Hz tick: one callback per drawn frame, as a page's
// requestAnimationFrame. Flushing them per catch-up tick ran core's whole frame (update, matrix walk, cull)
// up to five times per drawn frame, and each pass made the next frame later (PRD-610).
globalThis.tn.onFrame((frameMs) => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(frameMs);
});

// A person's input from the player's window (SDL through the legacy host's DOM translation), as the events
// core's listeners on the canvas read. A key also enters the held set, so the per-tick diff below does not
// raise it a second time.
globalThis.__tnDispatchInput = (event) => {
  if (event.type === "keydown") held.add(event.code);
  else if (event.type === "keyup") held.delete(event.code);
  const dom = { ...event, isTrusted: true, target: canvas, preventDefault() {}, stopPropagation() {} };
  for (const callback of [...(listeners.get(event.type) ?? [])]) callback(dom);
};

// The player has no fetch, so a run it hosts makes no request. The runner's desktop network check needs the
// `runtime.network` capability and a `network` observation from the bridge core installs: report the honest
// zero, as playtest/src/three/device.ts does for the legacy host's retained fetch failures.
{
  let installed;
  Object.defineProperty(globalThis, "__THREENATIVE_PLAYTEST_BRIDGE__", {
    configurable: true,
    get: () => installed,
    set(bridge) {
      if (typeof bridge?.describe === "function" && typeof bridge.sample === "function") {
        const describe = bridge.describe.bind(bridge);
        bridge.describe = async () => {
          const description = await describe();
          return { ...description, capabilities: [...description.capabilities, "runtime.network"] };
        };
        const sample = bridge.sample.bind(bridge);
        bridge.sample = async (request) => ({ ...await sample(request), network: { entries: [], requests: 0 } });
      }
      installed = bridge;
    },
  });
}

globalThis.tn.onUpdate((dt) => {
  time += dt * 1000;
  // Every held key by code (KeyW, ArrowUp), as keydown/keyup events with the DOM key beside the code.
  const now = new Set(globalThis.__tnHeldCodes());
  const send = (type, code) => {
    const key = /^Key[A-Z]$/.test(code) ? code[3].toLowerCase() : code;
    for (const callback of listeners.get(type) ?? []) callback({ code, key });
  };
  for (const code of now) if (!held.has(code)) { held.add(code); send("keydown", code); }
  for (const code of [...held]) if (!now.has(code)) { held.delete(code); send("keyup", code); }
  for (const [id, timer] of timers) {
    if (timer.due > time) continue;
    if (timer.interval === undefined) timers.delete(id);
    else timer.due += timer.interval;
    timer.callback();
  }
  // Under a playtest runner core freezes its loop, so ticks are the only clock: the legacy host's
  // mailbox advance calls the bridge's fixed step, and here each native tick is that advance. The
  // frame callbacks then run once per presented frame on its frame clock (tn.onFrame below), so a
  // render sample is a real frame time: tick time never satisfies minFps or p95 (owner, 2026-10-08).
  if (runnerAttached()) {
    const bridge = globalThis.__THREENATIVE_PLAYTEST_BRIDGE__;
    if (typeof bridge?.advance === "function") {
      globalThis.__tnGameSpan?.(GAME_SPANS.playtest, 0);
      try { void bridge.advance(1, { render: false }); } finally { globalThis.__tnGameSpan?.(GAME_SPANS.playtest, 1); }
    }
  }
  audio.updateAudio();
});

const readSize = () => ({ width: canvas.width, height: canvas.height, aspect: canvas.width / canvas.height });
export const platform = {
  input: () => [],
  inputTarget: canvas,
  renderer: { createCanvas: () => canvas, hasWebGPU: () => true, readSize: () => [1280, 720], observeResize: () => () => {} },
  viewport: { readSize, observeResize: () => () => {} },
  mountCanvas() {},
  unmountCanvas() {},
};

if (globalThis.__tnGameSpan !== undefined) {
  const calls = 100_000;
  for (let warm = 0; warm < 10_000; warm++) globalThis.__tnGameSpan(-3, 0);
  for (let batch = 0; batch < 3; batch++) {
    let checksum = 0;
    const emptyStart = globalThis.__tnGameSpan(-2, 0);
    for (let i = 0; i < calls; i++) checksum += i & 1;
    const emptyMs = globalThis.__tnGameSpan(-2, 0) - emptyStart;
    const start = globalThis.__tnGameSpan(-2, 0);
    for (let i = 0; i < calls; i++) { globalThis.__tnGameSpan(-3, 0); checksum += i & 1; }
    const ms = globalThis.__tnGameSpan(-2, 0) - start;
    console.log(`TN_GAME_FFI:${JSON.stringify({ calls, ms, emptyMs, netNs: (ms - emptyMs) * 1e6 / calls, checksum })}`);
  }
}
