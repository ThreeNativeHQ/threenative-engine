# PRD-578 — The engine skips work that did not change

**Status:** PARTIAL — the `PropertyBinding` lock is gone on the engine branch; the skeleton lock, the per-view block and the hidden-rig rate are open.
**Priority:** P1 — the per-bone lock, per-draw camera writes and every-frame evaluation of hidden rigs still cost every skinned scene (Phases 1–3 open boxes).
**Complexity:** 4 (MEDIUM) — 6–10 engine files (+2), evaluation-rate state carries across frames (+2); risk override: none
**Owner:** João
**Cycle:** v2. Every phase edits engine files, so it starts after v1 slices 2b (animation) and 5 (renderer) are on develop.
**Depends on:** v1 slices 2b and 5. Timing proofs read [PRD-573](./PRD-573-the-performance-bar-is-a-scorecard-on-named-scenes.md) Phase 1 (tails and `hostLoad`).
**Estimate:** Phase 1 ≈ 3 h; Phase 2 ≈ 6 h; Phase 3 ≈ 12–16 h.

## Context

Layer: engine (`packages/runtime-native/src/engine/`, cited at `origin/feat/native-engine`
`68f4b1f7b`). Every game pays this cost and no game code can remove it.

- **Locks.** `PropertyBinding` no longer locks per apply: `animation/property_binding.cpp:259,310`
  read `node_.expired() ? nullptr : raw_` (commit `e9d4f1f4c`). The dominant site in a skinned
  scene is now `Skeleton::bone(i)` (`animation/skinning/skeleton.h:74`, `bones[i].lock().get()`),
  called per bone in `skeleton.cpp:49` and twice per bone in the palette build (`:116-119`) for
  every skinned mesh, every frame. Other lock sites (`scene/object3d.cpp:363,374,396,436`,
  `renderer/render_database.cpp:335,700`, `renderer/renderer.cpp:903,2828`) are not per bone.
  The `raw_` plus `expired()` pattern is safe only on one thread; PRD-574 forbids render-thread
  node release, which keeps it valid.
- **Camera data in every draw.** `renderer/renderer.cpp:2095-2101` writes the view matrix, the
  projection matrix and `normalMatrix(multiply(view, item.matrixWorld))` (a double 4x4 multiply)
  into each draw's uniform block. A turning camera rewrites every block.
- **Every rig evaluates every frame.** `AnimationMixer::update` (`animation/mixer.cpp:724`) is
  bit-equal to three by design. No record stores whether a pass drew it (no drawn-frame field in
  `renderer/render_database.h`). `AnimationSchedule` (`animation/schedule.h`) advances managed
  mixers, but a game that calls `mixer.update()` itself (Midway) bypasses it, so the rate rule lives
  in `update()`.
- **Compose.** `Object3D::updateMatrixWorldSelf` (`scene/object3d.cpp:552`) composes every
  auto-update object and compares 16 words. A skip would compare 10 inputs, close to the cost it
  saves, and still visit every object. See `## Decisions`.

### What Unreal does (UE 5.8.3, design reference only)

- Not-rendered rigs tick at a reduced rate (`Engine/Private/Components/SkinnedMeshComponent.cpp:283-370`,
  `BaseNonRenderedUpdateRate` 4 in `Classes/Engine/EngineTypes.h:2820`). "Recently rendered" is a
  1.0 s window (`SkinnedMeshComponent.cpp:1864`), rigs are staggered (`ShiftBucket`,
  `EngineTypes.h:2693-2723`), and a long skip forces an update (`SkinnedMeshComponent.cpp:6066-6100`).
- URO ships off, and the default `AlwaysTickPoseAndRefreshBones` keeps a hidden pose current because
  gameplay reads bones (`SkeletalMeshComponent.cpp:446,493`).
- View data lives in one view uniform buffer, not in each primitive's data (`Renderer/Private/GPUScene.cpp`).

## Solution

1. **Bones without locks.** `Skeleton` keeps raw bone pointers from bind time and checks expiry the
   way `PropertyBinding` does. A released bone stays a safe no-op.
2. **One view block per frame.** View, projection and camera constants go into one per-view uniform
   block written once per view. The normal matrix is derived in the vertex stage from the model
   matrix and the view block. Draw blocks hold per-object data only.
3. **Hidden rigs update less, with Unreal's safeguards.** Main and shadow passes stamp the frame on
   the drawn rig's root. A rig not drawn within a recently-drawn window (start: 8 frames or 0.25 s)
   evaluates one frame in four with accumulated `dt`, staggered across rigs. It evaluates at once
   on its first drawn frame, and never skips longer than the window. A rig whose bones carry a
   non-bone child or were read through the bindings in the window evaluates every frame. The
   override is `AnimationMixer.updateRate` (`"auto"` or a number); a non-auto value is reported.
   Conformance cases that assert three bit-equality set rate 1.

## Execution Phases

#### Phase 1: No lock per bone or binding
**Status:** PARTIAL
**Files:** `src/engine/animation/skinning/skeleton.{h,cpp}`, `tests/native-engine/animation/`
- [x] `PropertyBinding` applies without a lock, and a binding to a released node stays a safe no-op. proof: red-green `native_engine_animation_binding_released` and `native_engine_renderer_geometry_cache` (`e9d4f1f4c` on `feat/native-engine`; `ctest -L native-engine` 290/292, reds only the known `render_vsm`, `update_scaling`); same-window A/B lock self share base 3.9%, subject under the 0.7% floor. Reaches develop with slice 2b.
- [ ] `Skeleton::bone` returns a bind-time pointer with an expiry check, and a released bone is a safe no-op in the palette build. proof: a red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_skinned_crowd_cpu`, then `pnpm profile:wasm-page` A/B (this build against base) on a skinned page with the `__shared_weak_count::lock` self share under 0.7%

#### Phase 2: One view block per frame
**Status:** NOT STARTED
**Files:** `src/engine/renderer/renderer.{h,cpp}`, `src/engine/shader/` (view block binding), `tests/native-engine/renderer/`
- [ ] Uniform bytes written per frame fall, and a camera turn rewrites only the view block. proof: a red-green counter case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_batched_vs_unbatched` (bytes per frame, and per-draw writes 0 on a camera-only change)
- [ ] Frames match the per-draw path and pass the visual judge. proof: the same ctest within the renderer's reference tolerance, then a fresh judge subagent on headed `--browser-recipe webgpu` captures, verdict recorded here
- [ ] Frame CPU falls on R5 and Midway web with p99 no worse. proof: `pnpm bench:engines` (`native-v8`, this build against base) on R5 and `pnpm profile:wasm-page -- --url <this build> --control <base> --cpu-work`, ratios with tails and `hostLoad`

#### Phase 3: Hidden rigs update less, with safeguards
**Status:** NOT STARTED
**Files:** `src/engine/renderer/render_database.{h,cpp}`, `src/engine/animation/mixer.{h,cpp}`, `src/engine/animation/skinning/`, `packages/three-native/api/` (regenerated), `packages/runtime-native/conformance/registry.json`, the templates' `AGENTS.md`
- [ ] Main and shadow passes stamp the drawn frame on the rig root, and shadow-only draws count. proof: a red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_mixer`
- [ ] With N rigs hidden, evaluations per frame fall to about N/4, spread so no frame evaluates more than ceil(N/4) hidden rigs, and clip time and `finished` events equal rate 1 over 300 frames. proof: a red-green counter case in `ctest ... -R native_engine_skinned_crowd_cpu`
- [ ] A rig entering view evaluates on its first drawn frame, a rig with a non-bone child on a bone evaluates every frame, and a skip never exceeds the window. proof: red-green cases in `ctest ... -R native_engine_animation_mixer`
- [ ] Conformance cases opt out with rate 1, and the rate passes the visual judge with p99 no worse. proof: `pnpm parity` unchanged; headed `--browser-recipe webgpu` captures of rigs entering view judged by a fresh subagent; `pnpm bench:engines --arms native-v8 --workloads skinned-crowd` (this build against base) with tails

## Decisions

- 2026-10-11 (epic rewrite, from the review): the compose skip is deferred. It is filed again only
  if a profile shows `updateMatrixWorldSelf` self time above 2% of the frame. Projection reuse and
  SIMD world matrices (the earlier Phases 2–3) move to the v4 candidates in [ROADMAP.md](./ROADMAP.md), gated on the scorecard.
- The rate rule lives in `AnimationMixer::update`, not only in `AnimationSchedule`, because games
  call `update()` directly.

## Blocked on

- `AnimationMixer.updateRate` adds a non-three property to a three API object. João confirms the
  name before Phase 3 merges.
- An Android timing claim needs the Pixel 8 attached. The emulator holds the counter claims.
