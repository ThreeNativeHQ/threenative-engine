# PRD-834 — Cross-language contracts are generated from one manifest

**Status:** NOT STARTED
**Priority:** P2 — the open boxes replace hand-mirrored opcodes, console markers, config keys and hook names, where a rename in one language compiles and fails silently in the other.
**Complexity:** 6 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** PRD-832 (its Phase 3 lands the generator pattern on `tnw_web_frame`)
**Batch:** [Untangle report, 2026-11-06](README.md) — R2

## Context

Report ids D3, E4, A8, C7, D7. PRD-832 covers `tnw_web_frame`. This PRD applies the same pattern to
the other contracts that cross the C++ and TS line.

| Contract | Today | Where |
| --- | --- | --- |
| Frame-op opcodes | 60 bare ints in JS mirrored by a C++ name table and two switches. Unknown ops are rejected only at replay. | `packages/runtime-native/src/runtime-scripts/frame-op-stream.js:368-905`, `packages/runtime-native/src/webgpu/bindings_frame_stream.cpp:76-77,328,1033` |
| `TN_*` console markers | Printed in C++ and TS, parsed by regex in `perf.ts`, re-declared in 2 evaluators. The window payload type is declared twice. | `packages/playtest/src/runner/perf.ts:30-58,112`, `packages/playtest/src/evaluators/engine-cost.ts:4`, `frame-cost.ts:6`, `packages/core/src/frame-budget.ts:264` |
| Config keys read by C++ | `window.cpp` finds `"bootSplash"` by string search. TS exposes both `render` and `renderer`. | `packages/runtime-native/src/platform/window.cpp:158-181`, `packages/core/src/game.ts:292-294`, `packages/core/src/game-startup.ts:148-167` |
| Engine hook name | `__tnCopyMatrixWorld` defined in C++, probed in 3 JS files | `packages/runtime-native/src/engine/abi/bindings_scene.cpp:714`, `packages/core/src/animation.ts:263-268`, `packages/core/src/interpolation.ts:24-28` |
| Embedded script names | 16 call sites pass literal names. A missing script prints one stderr line. | `packages/runtime-native/src/runtime.cpp:145-157`, `packages/runtime-native/src/audio/audio_bindings.cpp:169-784` |

## Solution

One manifest per contract, emitted by the generator that PRD-832 extends: a C++ enum or header and a
TS const. An unknown id, key or name fails closed at boot or at replay, and names the producer. Ids
stay frozen and append-only. `render` folds into `renderer`, with a named error for the old key.

## Acceptance Criteria

- [ ] AC-1 [local]: The native desktop host still runs and draws. proof: `pnpm native:verify:desktop` (300 frames, non-blank)
- [ ] AC-2 [local]: The starter perf lane still reads frame-budget windows on web. proof: playtest `perf` on the starter, `--browser-recipe webgpu`, windows > 0

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Frame-op replay | Native player frame loop → `bindings_frame_stream.cpp` | Bare ints deleted | Phase 1 |
| Marker parsing | `perf` CLI and evaluators | Duplicate constants deleted | Phase 2 |
| Native config read | Native boot → `window.cpp` | String search deleted | Phase 3 |

## Execution Phases

#### Phase 1: Frame-op opcode manifest
**Status:** NOT STARTED
**Files:** new opcode manifest; generator; `frame-op-stream.js`; `bindings_frame_stream.cpp`; the drift test in `packages/runtime-native/tests/`.

- [ ] The JS `OP` object, the C++ name table and the `case` labels come from one manifest, and inserting an op in the middle fails the drift test. proof: `node --test packages/runtime-native/tests/` drift lane plus `pnpm native:build`

#### Phase 2: Marker manifest
**Status:** NOT STARTED
**Files:** `packages/playtest/src/protocol.ts`, `perf.ts`, `evaluators/engine-cost.ts`, `evaluators/frame-cost.ts`, `packages/core/src/frame-budget.ts`, a generated C++ header.

- [ ] Marker names and the frame-budget window type are exported once from `protocol.ts`. Core, the evaluators and C++ printers import them. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/perf.spec.ts` plus `rg -n '"TN_FRAME_BUDGET"' packages --glob '!**/protocol.ts' --glob '!**/__tests__/**'` returns nothing
- [ ] `__tnCopyMatrixWorld` comes from one hook-name module, and a host missing it reports once at adapter install. proof: `pnpm --filter @threenative/core exec vitest run __tests__/` for animation and interpolation

#### Phase 3: Config keys and script names
**Status:** NOT STARTED
**Files:** `packages/core/src/config.ts`, `game.ts`, `game-startup.ts`, `packages/runtime-native/src/platform/window.cpp`, `runtime.cpp`, `audio_bindings.cpp`, `CMakeLists.txt`.

- [ ] C++ reads config keys from a generated list. `render` is folded into `renderer`, and the old key throws with the new name. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts` plus `pnpm native:verify:desktop`
- [ ] Embedded scripts are named by a generated enum, and a missing script aborts boot with its name. proof: `pnpm native:build` plus the embedded-bundle C++ test
