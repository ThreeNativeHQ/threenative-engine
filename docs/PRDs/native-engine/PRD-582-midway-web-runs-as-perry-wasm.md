# PRD-582 — Midway on the web runs as Perry Wasm over the Wasm engine

**Status:** NOT STARTED
**Priority:** P2 — the owner's web arm ("loading web on WASM + perry (no js)", 2026-10-10); every box is open and Phase 1 is compiler work in the Perry fork.
**Complexity:** 5 (HIGH) — the Perry Wasm emitter, its value runtime, the facade transport and the web engine all change; risk override: none
**Owner:** João
**Depends on:** [PRD-581](./PRD-581-midway-runs-js-free-through-perry.md) (the facade, staging and host the native arm builds; this PRD reuses them with a Wasm transport)
**Estimate:** Phase 1 ≈ 2–4 weeks (Perry fork); Phase 2 ≈ 1–2 weeks; Phase 3 ≈ 1 week.

## Context

Layer: Perry fork (`ThreeNativeHQ/perry`), `packages/three-native/`, `packages/runtime-native/`,
`tools/native-typescript/`. Midway's own source does not change.

The goal: the browser loads `tn-native-engine-web.wasm` and Midway's game code compiled by Perry
`--target wasm`. The only JS is the browser glue that no Wasm can avoid (WebGPU, DOM events, fetch,
image decode, audio), and the engine owns it. No game, core or three facade module runs as JS.
`--target web` emits JS, so it does not meet the goal.

Survey on 2026-10-10 (Perry 0.5.1520, the PRD-581 staging with `--target wasm`). Perry exits 0
and reports 249 native modules and 0 JS modules, but:

1. The artifact does not validate: two functions have block-result/drop errors (Binaryen and the
   browser both refuse it). Perry reports success anyway.
2. Every async function body (Midway's asset loaders, core's `loadAll`/`addInSlices`, the facade's
   `bindWebEngine`, the start driver's loop) is emitted as JS in the generated runtime: 34
   `rt:__async_*` imports.
3. The value runtime (strings, objects, arrays, closures, JSON, cold dispatch) lives in JS
   (`stringTable`, `handleStore`, `mem_call`).
4. The 23 `js_tnp_*` transport hooks have no web binding, and Perry passes NaN-boxed `i64` where
   the native manifest declares `i32`/`f64`/`string`. A missing FFI hook defaults to a no-op
   instead of failing.
5. The game owns one memory and imports none, so engine pointers do not cross. The PRD-533
   `wasm-perry` bench arm (`scripts/engine-load-test/perry-build.ts`) proves multi-memory access
   to the engine heap for a fixed numeric workload only; it is not a general linker.
6. `perry-host.ts` is the desktop host (filesystem fetch, SDL stepping), and the web engine does
   not export the Perry physics and audio hooks.

## Execution Phases

### Phase 1 — Perry emits valid Wasm with no game JS (Perry fork)

- [ ] Midway's graph emits Wasm that validates, and a build that does not validate fails. proof: `perry compile <staged midway> --target wasm` then `wasm-opt --all-features` validation exits 0
- [ ] Async bodies and the reachable value runtime run in Wasm; the emitted JS holds only browser primitive glue, and a missing FFI hook fails at load by name. proof: `pnpm exec vitest run tools/native-typescript/__tests__/wasm-no-game-js.spec.ts`

### Phase 2 — The compiled facade reaches the web engine

- [ ] The transport crosses the two memories: numeric ABI, UTF-8, nested callbacks, growth, typed windows and bulk copies, each failing by name. proof: `pnpm exec vitest run packages/three-native/__tests__/perry-wasm-transport.spec.ts`
- [ ] A web host opens the engine, runs the compiled start and frame loop, and delivers input, URL assets and image decode through engine-owned glue. proof: `pnpm exec vitest run packages/three-native/__tests__/perry-wasm-host.spec.ts`
- [ ] Physics and audio work on web with Wasm game logic. proof: `pnpm exec vitest run packages/three-native/__tests__/perry-wasm-services.spec.ts`

### Phase 3 — Midway loads and plays from a Wasm-only page

- [ ] Target-aware packaging serves the engine Wasm and the game Wasm, compiles the HUD entry, and refuses any served game, core or three JS. proof: `pnpm exec vitest run tools/native-typescript/__tests__/midway-wasm-web-package.spec.ts`
- [ ] Midway briefing, launch, flight and audio scenarios pass on that page. proof: `node packages/playtest/dist/runner/cli.js <midway>/playtests/<scenario>.playtest.json --url <page> --browser-recipe webgpu` for each of the four
- [ ] Enter, ready and first frame on that page against the three.js page, 3 same-window runs. proof: `pnpm tsx scripts/engine-load-test/web.ts` with the Perry Wasm arm

## Blocked on

- The Perry fork push and pin (`compiler.lock.json` names upstream `PerryTS/perry`): João decides when ThreeNative builds from `ThreeNativeHQ/perry`.

## Decisions

- 2026-10-10, João: the goal has two arms, "loading web on WASM + perry (no js) and native full native no JS". The native arm is PRD-581; this PRD is the web arm. It is a separate PRD because PRD-581 already has three phases.
