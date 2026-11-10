# PRD-840 — Platform difference is a value, not a scattered `#ifdef`

**Status:** NOT STARTED
**Priority:** P1 — open Phase 1 removes 3 `__EMSCRIPTEN__` forks that make web and native draw different pictures, so a renderer fix proven on desktop never runs on web.
**Complexity:** 7 (HIGH); risk override: changes the draw order and batching on web and native, so the owner's visual-judge rule and web/native parity apply
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — N3

## Context

Report ids H3, H2, H6, H4. There are 27 `__EMSCRIPTEN__` sites in 9 engine files.

| Problem | Where |
| --- | --- |
| Opaque draws sort by depth on web and by state on native | `packages/runtime-native/src/engine/renderer/renderer.cpp:3142` |
| `batchSlot` returns the last group every web frame. The batched draw key differs per platform. | `packages/runtime-native/src/engine/renderer/render_database.cpp:1434,1535` |
| Features compiled out on web: `stablePasses_`, `setStablePasses`, `setStableRows`, slot map | `renderer.h:854,865,1457`, `render_database.h:230` |
| `renderer.cpp` is 7 102 lines, and `renderPrepared` alone is 2 743 (`:3291-6033`). `renderer.h` exposes about 1 200 public lines. | `renderer/renderer.cpp`, `renderer/renderer.h:365` |
| Renderer link list written twice for two exclusive builds | `cmake/NativeEngineCore.cmake:173`, `cmake/NativeEngine.cmake:55` |
| 31 env flags read ad hoc, some once and some per frame. 7 of them pick which arm renders. | `renderer.cpp:319-326`, `render_database.cpp:1223,1921`, `projection/plan.h:102-109` |

## Solution

`struct RenderFeatures { bool stablePasses, stateSortFirst, batchSlotReuse, recordCauseHashes; }` is
set once at construction from the host. The fields stay `constexpr`-foldable where a build pins them.
`#ifdef` remains only for code that cannot compile on a platform: threads, POSIX clock, error scopes.
One `engine/foundation/flags.h` declares each `TN_*` flag as read-once or per-frame. One CMake
function owns the renderer link line. Then `renderer.cpp` splits by concern (material, program,
shadow, output) behind `renderer_internal.h`, and a per-frame struct carries the locals that
`renderPrepared` shares.

## Acceptance Criteria

- [ ] AC-1 [local]: Web and native conformance stay green. proof: `pnpm parity`
- [ ] AC-2 [local]: The visual judge returns NEUTRAL or better on the starter, web and native, same pose. proof: judge verdict on this box
- [ ] AC-3 [local]: The starter frame time does not regress on web or native. proof: `pnpm bench:engines` paired A/B

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Render features | `web_host.cpp` and `player/run.cpp` construct the renderer | Render-semantics `#ifdef` deleted | Phase 1 |

## Execution Phases

#### Phase 1: `RenderFeatures` and flags
**Status:** NOT STARTED
**Files:** `renderer/renderer.h`, `renderer.cpp`, `render_database.{h,cpp}`, `wasm/web_host.cpp`, `player/run.cpp`, new `foundation/flags.h`.

- [ ] No `__EMSCRIPTEN__` decides sort order, batching or pass stability, and each choice reads `features()`. proof: `rg -n '__EMSCRIPTEN__' packages/runtime-native/src/engine/renderer` lists only compile-only sites, plus `pnpm native:build` (desktop and Wasm)
- [ ] Every `TN_*` engine flag is read through `flags.h`, and a spec enumerates them. proof: `pnpm exec vitest run scripts/__tests__/ablation-flags-never-ship.spec.ts` extended

#### Phase 2: One CMake link line
**Status:** NOT STARTED
**Files:** `cmake/NativeEngineCore.cmake`, `cmake/NativeEngine.cmake`.

- [ ] One `tn_engine_renderer_target` function, and a configure check compares both builds' `LINK_LIBRARIES`. proof: `pnpm native:build` plus the Wasm configure

#### Phase 3: Split `renderer.cpp`
**Status:** NOT STARTED
**Files:** `renderer/renderer.cpp` → `renderer_material.cpp`, `renderer_program.cpp`, `renderer_shadow.cpp`, `renderer_output.cpp`, new `renderer_internal.h`; `renderer.h`.

- [ ] No renderer TU is over 3 000 lines, and `renderer.h` keeps only host-facing calls and value types. proof: `wc -l packages/runtime-native/src/engine/renderer/*.cpp` plus `pnpm native:verify:desktop`
