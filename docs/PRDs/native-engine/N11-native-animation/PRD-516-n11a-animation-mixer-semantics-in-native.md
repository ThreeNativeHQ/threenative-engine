# PRD-516 — AnimationMixer semantics in native (N11a)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: mixer semantics in native; 6 open boxes.
**Complexity:** 4 — the mixer has a lot of observable state (weights, fades, warps, loops, events), and all of it is compared against the reference
**Owner:** João
**Work package:** N11 — [native-engine batch](../README.md) · [N11 umbrella](README.md)
**Depends on:** [PRD-508 (N06)](../PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md); starts only after [PRD-534 (CP1)](../PRD-534-cp1-the-native-engine-earns-the-port.md) passes

## Context

§11.2 asks for the supported `AnimationMixer`/`AnimationAction` behaviour in native code: track binding, interpolation (discrete, linear, cubic, quaternion slerp), looping (`LoopOnce`, `LoopRepeat`, `LoopPingPong`, `clampWhenFinished`), weighting, additive blending, fades, warps and `finished`/`loop` events. Evaluation starts exact and compatible. §6.4 requires `mixer.update()` to stay observably synchronous, with no second evaluation by the engine schedule. Today the framework layer over three's mixer is `packages/core/src/animation.ts` (`AnimationPlayer`), with specs in `packages/core/__tests__/animation.spec.ts`. Clip validation is in `packages/core/src/clip-audit.ts`.

## Solution

1. **Native mixer state.** Proposed `packages/runtime-native/src/engine/animation/`. Clips, tracks, actions and mixers are N04 handles. Track bindings resolve property paths against the N06 graph once per bind, and rebind when the hierarchy changes, following the reference's `PropertyBinding` rules.
2. **Exact evaluator first.** Scalar binary64 evaluation of the reference interpolants, then a write into public properties (§6.3). SIMD or packed kernels come only after conformance exists (§6.2).
3. **Synchronous contract.** `mixer.update(dt)` evaluates and applies right away. Engine-managed mixers run once per simulation tick. A mixer the game updated explicitly in that tick is skipped by the schedule (§6.4).
4. **Events.** `finished` and `loop` dispatch on the game thread in the reference order, after the pose is applied (§7.3).
5. **Port `AnimationPlayer`.** Its TS stays as binding glue over the native mixer. Unsupported track kinds fail with `TN_NATIVE_ANIMATION_TRACK_UNSUPPORTED`.
6. **Rollback.** The legacy backend keeps three's JS mixer.

## Out of scope

- Morph and non-skeletal property tracks on the GPU path: [PRD-517 (N11b)](PRD-517-n11b-morph-targets-and-property-tracks.md)
- Bone palettes and skinned batching: [PRD-518 (N11c)](PRD-518-n11c-skinning-palettes-and-pose-history.md)

## Execution Phases

#### Phase 1: Tracks and interpolation
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/animation/`, `packages/runtime-native/tests/native-engine/animation/`
- [ ] Every interpolant (discrete, linear, cubic, quaternion) reproduces the pinned reference fixtures within the documented tolerance. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_interpolants`
- [ ] Property-path binding resolves and rebinds after reparenting, as the reference does. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_binding`

#### Phase 2: Actions and the mixer
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/animation/mixer.cpp`
- [ ] Loop modes, `clampWhenFinished`, weights, additive blending, fades and warps match reference pose dumps over a 10 s timeline. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_mixer`
- [ ] `finished` and `loop` events fire in the reference order and on the reference tick. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_events`

#### Phase 3: The scheduling contract
**Status:** NOT STARTED
**Files:** `packages/core/src/animation.ts` (binding glue); proposed `packages/runtime-native/src/engine/animation/schedule.cpp`
- [ ] An explicit `mixer.update()` is observable straight away, and the engine schedule does not evaluate that mixer again in the same tick. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_explicit_update`
- [ ] The animation update count is independent of the render count: two renders in one tick evaluate once. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_tick_vs_render`

## Decisions

- Native scheduling never replaces `AnimationMixer` semantics with an unrelated scheduler (§4).
- ozz is deferred; see the [N11 umbrella](README.md).
