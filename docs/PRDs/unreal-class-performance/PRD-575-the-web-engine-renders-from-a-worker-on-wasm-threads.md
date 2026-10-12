# PRD-575 — The web engine renders from a worker on Wasm threads

**Status:** NOT STARTED
**Priority:** P2 — the engine, the game and the DOM share the page's main thread, and the game side reads DOM globals directly, so no worker mode can start (Phases 1–3 open).
**Complexity:** 8 (HIGH) — 6–10 files across core, the engine and the web host (+2), a worker host and a capability layer are new modules (+2), threads over shared memory are concurrency (+2), the Wasm build is its own release artifact (+2); risk override: none
**Owner:** João
**Cycle:** v5.
**Depends on:** v1 slice 7 (Wasm engine). Phase 3's job pool needs [PRD-574](./PRD-574-native-frames-overlap-game-and-render-work-on-threads.md) Phase 1 (the job system). Phases 1–2 need no cross-origin isolation.
**Estimate:** Phase 1 ≈ 20–30 h; Phase 2 ≈ 30–40 h; Phase 3 ≈ 16–24 h.

## Context

Layer: core (`packages/core/src/`), the web host (`packages/three-native/src/`) and the Wasm engine
(`packages/runtime-native/src/engine/wasm/web_host.cpp`, `cmake/NativeEngineCore.cmake`), cited at
`origin/feat/native-engine` `68f4b1f7b`. A game cannot move the engine to a worker.

- **No threads.** No Wasm target links `-pthread`. `tn-native-engine-web`
  (`NativeEngineCore.cmake:494`) links `ALLOW_MEMORY_GROWTH` and `MAXIMUM_MEMORY=4GB` and compiles
  with `-msimd128`. The bench server sends COOP/COEP (`scripts/engine-load-test/browser.ts:166-167`).
  `native-core-wasm-nothreads.playtest.json` already asserts `threads.built` and
  `threads.crossOriginIsolated`.
- **The game side assumes a DOM.** On develop, 23 files in `packages/core/src` read `document.` or
  `window.` (led by `frame-budget.ts`, `resolution-scaler.ts`, `ui-hit-regions.ts`, `viewport.ts`).
  A worker also loses `AudioContext` (`core/src/audio.ts`), `requestPointerLock` and
  `navigator.getGamepads` (`core/src/input.ts:141-170`), `localStorage` (`core/src/warmup.ts`) and
  DOM-canvas or video textures.
- **Device bring-up is main-thread shaped.** `web_host.cpp` creates the surface from a canvas
  selector. `browser-renderer.ts:41` resolves `"!threenative-canvas"` and falls back to
  `document.createElement("canvas")` (`:141`), which a worker does not have.
- **A worker does not cut frame time.** Game JS and the engine share one thread in the worker, so
  frame p50 stays; main-thread responsiveness improves. Only Phase 3 (jobs on Wasm threads) can cut
  frame time.

| Web limit | State |
| --- | --- |
| Wasm SIMD | on (`-msimd128`) |
| Linear memory | 4 GB cap, 32-bit addresses |
| Threads | need `SharedArrayBuffer`, so COOP/COEP; `require-corp` blocks cross-origin assets without CORP headers; static hosts such as GitHub Pages cannot set headers |
| `-pthread` with memory growth | heap views go stale at growth on every thread; some APIs refuse shared views (unverified for this engine) |
| WebGPU from pool threads | device objects belong to the creating thread; pool threads run CPU jobs only |
| Multi-draw-indirect | not in core WebGPU; not designed for |

Unreal 5.8.3 has no web platform to borrow from; its thread model is PRD-574.

## Solution

1. **A DOM-free host-capability layer (Phase 1).** Core reads audio, input, storage, canvas and
   image sources through one capability interface. On the main thread it calls the DOM directly; a
   loopback proxy path proves the same calls survive a message boundary.
2. **Worker mode behind a flag (Phase 2).** The page keeps the DOM, the React HUD and input; the
   worker runs game JS and the engine on an `OffscreenCanvas` (`transferControlToOffscreen`). The
   capability proxy carries input in and HUD state out once per frame. No COOP/COEP needed.
3. **Wasm threads (Phase 3).** A `TN_WEB_THREADS` build option (off by default) and its measured
   cost; with `crossOriginIsolated` the PRD-574 job pool runs on Wasm threads, otherwise the frame
   report says `threads: off (no COOP/COEP)`. PRD-577's async pipeline entry needs no threads.

## Execution Phases

#### Phase 1: Core reads the host through one capability layer
**Status:** NOT STARTED
**Files:** `packages/core/src/` (a host-capability module; `audio.ts`, `input.ts`, `warmup.ts`, `viewport.ts`, `frame-budget.ts`, `resolution-scaler.ts`, `ui-hit-regions.ts`), `packages/three-native/src/browser-renderer.ts`
- [ ] Core modules reach `document`, `window`, `navigator`, `localStorage` and `AudioContext` only through the capability layer. proof: a red-green spec in `packages/core/__tests__/` that scans `packages/core/src` and fails on a direct read outside the layer
- [ ] The starter template plays through the loopback proxy with no change in behaviour. proof: `pnpm test:templates` on the starter kit with the proxy path on, and unchanged with it off

#### Phase 2: Worker mode behind a flag
**Status:** NOT STARTED
**Files:** `packages/three-native/src/` (worker host), `packages/runtime-native/src/engine/wasm/web_host.cpp`, `packages/create-threenative/src/` (the flag), `packages/playtest/src/`
- [ ] With the flag on, the starter template's playtest passes in Chrome: input reaches the game and the HUD updates. proof: red-green `pnpm test:templates` on the starter kit with the flag on
- [ ] The playtest harness captures a worker-owned `OffscreenCanvas`. proof: a red-green case in `packages/playtest/__tests__/` and one headed `--browser-recipe webgpu` capture with `adapter.info` checked
- [ ] Main-thread long tasks and busy time fall in worker mode, frame p50 does not rise, and the pose passes the visual judge. proof: `pnpm profile:wasm-page -- --url <worker mode> --control <main-thread mode> --cpu-work` (main-thread busy ratio below 0.5, p50 at most 1.0, tails recorded); a fresh judge subagent on captures of both modes

#### Phase 3: Wasm threads, measured, with an honest fallback
**Status:** NOT STARTED
**Files:** `packages/runtime-native/cmake/NativeEngineCore.cmake`, `packages/runtime-native/src/engine/wasm/web_host.cpp`, the PRD-574 job pool
- [ ] A `TN_WEB_THREADS=ON` build costs at most 2% on the one-thread path. proof: `pnpm profile:wasm-page -- --url <threads build> --control <base build> --cpu-work --json`, ratio at most 1.02 with `hostLoad`; above that, the decision goes under `## Decisions` and box 3 is dropped
- [ ] Without COOP/COEP the engine runs one thread and reports `threads: off`; with them it starts the pool. proof: red-green cases in `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_backend` for both isolation states
- [ ] Frame CPU busy falls with the pool against worker mode without it. proof: `pnpm profile:wasm-page -- --url <pool> --control <worker mode> --cpu-work`, ratio below 1.0 with tails

## Decisions

- 2026-10-11 (epic rewrite): worker mode (Phase 2) ships without cross-origin isolation; only
  Phase 3 needs it. Worker mode is a responsiveness change and does not move the frame-cost KPI.

## Blocked on

- The HUD crossing (state out once per frame) changes how a game's HUD reads game state. João
  confirms that contract before Phase 2 merges; it reaches every template's `AGENTS.md`.
- Safari rows need a macOS machine. Firefox WebGPU in a worker is unverified; try it once before
  listing it here.
- The Android web timing row needs the Pixel 8 attached. Android Chrome on the emulator holds the
  functional row first.
