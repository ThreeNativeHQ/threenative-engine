# PRD-528 — Framework loop, Rapier sync, input and services (N15)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: the frame contract, Rapier sync, input and services; 7 open boxes.
**Complexity:** 4 — the frame contract, physics sync and platform services all move under native ownership
**Owner:** João
**Work package:** N15 — [native-engine batch](README.md)
**Depends on:** [PRD-508 (N06)](PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md), [N11 — native animation](N11-native-animation/README.md), [PRD-499 (N02)](PRD-499-n02-the-host-links-without-a-js-engine.md); starts only after [PRD-534 (CP1)](PRD-534-cp1-the-native-engine-earns-the-port.md) passes

## Context

§12 defines the engine-controlled frame: platform input, fixed-step simulation and compiled game
callbacks, events, transforms and animation, bounded streaming admission, a consistent render
snapshot, passes, present, telemetry. Today the loop is TypeScript (`packages/core/src/loop.ts`,
`packages/core/src/game.ts`, `packages/core/src/input.ts`, `packages/core/src/audio.ts`). Physics is
already native Rapier, reached from TS through `packages/physics/src/native/host.ts` and
`packages/runtime-native/src/physics/native_bindings.cpp`; §11.3 keeps it and forbids a second physics
library. Platform input and lifecycle already exist in `packages/runtime-native/src/platform/`.

## Solution

1. Proposed `packages/runtime-native/src/engine/world/loop/` runs the §12 frame. Tick ids, render ids
   and presented-frame ids are tracked separately (§6.4); multiple renders in one tick see the
   mutations between them.
2. Explicit public calls still resolve synchronously (§12): a matrix query or `mixer.update()`
   mid-tick is not deferred, and engine scheduling never evaluates an explicitly updated mixer again.
3. Rapier is stepped from the native loop at the existing fixed step, with the same interpolation and
   the same contact/collision event ordering as `loop.ts` today; body transforms write into native
   scene state with no TS round trip.
4. Errors carry a stable code, subsystem, source location, handle identity and recovery class (§12).
   Async work can be cancelled or abandoned without freeing in-use resources, and no completion
   callback runs after its world is destroyed.
5. Input, audio and the other services the TS loop exposes are bound through N03; WebView UI stays
   optional and outside the strict claim (§11.4).
6. Rollback: the legacy backend keeps `loop.ts`.

## Out of scope

- Streaming admission internals ([N13](N13-native-streaming-and-world/README.md)).
- Playtest control of the loop ([PRD-529](PRD-529-n16-native-playtest-inspection-telemetry.md)).

## Execution Phases

#### Phase 1: Frame contract
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/loop/`, `packages/runtime-native/tests/native-engine/loop_*.cpp`
- [ ] Fixed-step count and interpolation alpha match `loop.ts` for the same recorded frame times. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_loop_fixed_step` against fixtures from `pnpm exec vitest run packages/core/__tests__/loop.spec.ts`
- [ ] Two renders in one tick get distinct render ids and the second sees a mutation made between them. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_loop_render_ids`
- [ ] A cancelled async load frees nothing still in use and no callback fires after world destruction. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_loop_async_cancel`

#### Phase 2: Rapier sync
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/physics_sync.cpp`
- [ ] Body transforms after N steps match the TS-driven path for the same scene. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_rapier_sync`
- [ ] Contact and collision events arrive in the same order as the TS-driven path. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_rapier_events`

#### Phase 3: Input and services without a JS core
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/services/`
- [ ] Injected input reaches a game callback in the same tick on the desktop native-engine player. proof: `node packages/playtest/dist/runner/cli.js native-engine-input.playtest.json --target desktop`
- [ ] The same input scenario passes on the Android emulator. proof: `node packages/playtest/dist/runner/cli.js native-engine-input.playtest.json --target android`

## Decisions

- No new physics library; Rapier stays (§2.3, §11.3).
- Floating-point and GPU determinism are out of scope; deterministic scheduling and RNG are not a determinism promise (§7.3).
