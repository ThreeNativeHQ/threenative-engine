---
prd_contract: v1
---

# PRD-385 — Performance defaults: share rig preparation and reuse frame storage

**Status:** PARTIAL
**Priority:** P2 — Twelve open ACs removing repeated binding audits and steady-iteration allocations.
**Progress:** 0/3 phases implemented
**Complexity:** 6 → MEDIUM; 6–10 implementation files (+2), cache/snapshot semantics (+2), engine-to-game tarball boundary (+2); risk override: none.
**Owner:** Engine implementation agent
**Depends on:** None. Extends [PRD-189](PRD-189-core-ordinary-frame-allocates-nothing.md); do not repeat its already-present input/state/loop changes.
**Scope:** Discovery and planning completed on 2026-09-14. Execution started in the repo-owned worktree `prd385/perf-defaults`; the plan document landed on the integration branch. Implementation is not started.

## Outcome

Updating the engine makes existing games spend less time preparing identical character rigs and
create less temporary garbage during frames. Developers keep their existing `SkeletalMesh3D`,
`AnimationPlayer`, `ctx.beforeRender`, `ctx.afterPhysics`, and input calls. No migration, new
configuration, reduced quality, or skipped simulation is required.

The audit saving applies to existing callers that request `requiredClips`; other rig callers can
benefit from equivalent stride preparation. Raw Three.js scenes still benefit from the engine's
frame-storage improvements without adopting a rig helper.

The mechanism belongs to the engine because these costs occur inside its existing lifecycle and
rig preparation. The game continues to own every material, pose, timing, and control decision.
Preserve existing overrides and measurement, including `strideSync: false`; no new performance
switch is needed for an implementation optimization. Count the entire added mechanism against the
repeated work it replaces, and reject a cache whose correctness machinery outweighs its benefit.

## Discovery: ranked candidates

| Rank | Candidate | Developer gets | Decision |
| --- | --- | --- | --- |
| 1 | Share equivalent skeletal preparation | Fewer repeated clip-binding audits and 64-pose stride samples when creating copies of a rig | Implement with conservative eligibility and measured benefit |
| 2 | Reuse private frame storage; materialize reports when read | Fewer short-lived objects from existing animation, callbacks, input and diagnostics | Implement, preserving snapshots and dispatch order |
| 3 | Reuse the native sRGB presentation intermediate | Avoid one full-size texture creation per frame on surfaces using the bridge | Qualified follow-up; outside this implementation scope |
| 4 | Omit the inactive alpha-antialiasing draw wrapper | One less callback per draw where conversion cannot apply | Small follow-up; prioritize only with measured draw-heavy overhead |

### What was actually measured

Exploration used three OpenCode sessions with `--auto --model opencode-go/deepseek-v4.1-flash`,
followed by targeted reviews and orchestrator inspection. Source snapshot: engine `e0df20cce`;
sandbox `da28308`, with a pre-existing modified flak-hunt PRD. The engine also contained another
lane's staged documentation/scaffold changes; none were changed by this task. Midway installs
`threenative-core-0.3.2-projdirty-12c96c25114f.tgz`, not a workspace link. Relevant installed paths
were inspected separately; package version equality is not evidence of byte equality.

A corrected Node-only probe used the real sailor GLB, stripped texture references in memory, and
constructed 12 copies of its 65-bone rig with six clips. After four warmup pairs, twelve alternating
audit/no-audit pairs measured median constructor times of **33.96 ms with required-clip audits** and
**11.30 ms without**. This isolates a roughly **22.66 ms audit cost in that probe**, not an implemented
speedup. The no-audit arm is attribution only: removing required validation is forbidden.

All six correctly decoded sailor clips reported `inPlace: true`. Single first-update observations
ranged from **4.95 to 25.77 ms**, including JIT/cold effects; do not extrapolate them to FPS or multiply
them into a predicted game saving. The actual deck party mixes sailor, director and pilot sources
and varies scale/phase, so twelve identical sailor clones are a diagnostic workload, not its replica.

Probe input SHA-256: `2e1286abe87f1df07e81ee07d20d6dea141d98c24d21840f8889b681058d4feb`.
Temporary reproducibility script: `/tmp/midway-perf-defaults-20260914/stride-cost.mjs`.
The initial agent probe double-wrapped the GLB binary chunk and shifted accessor data eight bytes;
its 55.2/15.1 ms figures and `inPlace: false` conclusion are invalid and superseded here. A durable
implementation check must validate decoded accessor values against the original GLB and use the
existing test infrastructure; this temporary script is not a release gate.

No browser performance comparison, native performance comparison, or ten-minute sustained run was
executed during planning. All proposed gains beyond the baseline attribution above are unverified.

### Existing capabilities and rejected ideas

The complete-request and focused `engine_search_capabilities` searches, followed by
`engine_capability_detail`, established existing `SkeletalMesh3D`, `AnimationPlayer`,
`createAssetLoader`, `loadAll`, `compileAssets`, `texturePass`, `publishUiState`, `FrameBudget`, and
`VirtualShadowNode`. Some broad searches returned unrelated navigation/replay matches; these do not
establish an optimization. No returned capability supplies cross-clone preparation reuse.

1. **Texture warmup already exists.** The default warmup reaches installed Three's
   `Renderer.compileAsync` → bindings update → `textures.updateTexture`. Adding another texture
   enumeration/upload pass repeats work. Both WebGPU and WebGL expose `initTexture`.
2. **Caching, batching and throttled publication already exist.** Asset loading, projection dirty
   uploads, bounded loading, input-vector reuse, state coalescing and subscriber-aware UI publishing
   are incumbent mechanisms, not new proposals. PRD-189's status is stale relative to several source
   implementations; this PRD does not change that earlier record.
3. **Quality reductions are excluded.** Automatic geometry simplification, lower animation rate,
   frozen shadows, and blanket static matrices can alter appearance or behavior. The existing
   [Three.js shadow contract](https://threejs.org/docs/pages/LightShadow.html) requires explicit
   updates when automatic shadow updating is disabled.
4. **Do not remove measurement.** Disabling timestamp collection because a marker is disabled is
   outside the requested default. Preserve diagnostic availability and current sampling cadence.
5. **Do not share mutable public results.** Shared textures, live-mutated stride reports, or a
   reused public `renderer.surface()` object can corrupt retained caller state.

## Implementation decisions

### A. Reuse preparation only when the inputs are equivalent

`packages/core/src/animation.ts:276` audits required clips in every constructor. Its
`#measureOf` at line 335 caches only per player; in-place clips reach `footPlantSpeed`, a full-rig
64-pose sampler. `packages/core/src/skeletal-mesh.ts:18` already owns skeleton-safe cloning.
Midway's `src/render/deck-crew.ts:174` reaches both through existing calls.

Keep reuse inside that existing owned clone path. Reuse **derived numeric metadata and successful
binding results**, never mixers, actions, bones, mutable reports, or poses. Separate eligibility for
the binding audit from eligibility for stride measurement; one is not proof of the other.

Start with ordinary uniquely named bone-transform tracks on clones whose relevant source/clip
inputs are provably equivalent. Cache ownership must be weakly tied to the source. At preparation
time account for hierarchy, relevant bind/rest transforms, actual property-binding paths, clip
duration/interpolation/keyframe content, and the current transforms affecting the sampled result.
Clip identity alone and a sorted set of bone names are insufficient. Source edits and clip-array
edits must cause a miss; one clone's mutation must never poison another clone's result.

Permit normalized scale/yaw reuse only after equivalence tests establish it. Non-uniform scale,
tilted/mirrored rigs, ambiguous names, unusual material/morph/custom property tracks, or unprovable
bindings retain the existing per-instance path. Standalone `AnimationPlayer` roots receive the
existing behavior unless equivalence can be established by the same mechanism. Do not introduce a
general rig registry, new authoring format, or developer-supplied cache key.

Validate before relaxing fail-closed behavior: missing clips and zero-bound tracks still throw in
the constructor. Preserve first-read `.stride`, per-clip phase/rate, one-shot timing, and measurement
when `strideSync: false`. If eligibility checks erase the saving or an input cannot be represented
safely, retain the baseline and record that scope as unresolved rather than shipping a stale cache.

### B. Reuse internal storage without changing public snapshots

| Current site | Smallest intended replacement | Contract to preserve |
| --- | --- | --- |
| `animation.ts:396,415` creates a stride report each update | Private reusable values plus a lazily materialized report | Retained reports never change; current reads still reflect the last update and just-played clip |
| `loop.ts:28` and `game.ts:1225` spread callback sets | Empty fast path and reusable snapshot arrays, with separate storage for nested dispatch | Additions wait until next dispatch; callbacks already snapshotted still run after removal/clear; order and exceptions unchanged |
| `pointer-events.ts:168` creates an active-pointer map | Private scratch storage with safe nested-call handling | Hover, press/release edges, pointer identity and target mutation behavior unchanged |
| `game.ts:1238,1267` allocates surface/metrics records for scalar reads | Non-allocating internal scalar access at the same point in the frame | Public snapshots remain independent; projection statistics still measure the world pass before overlays |

Do not substitute the scheduler's iteration rules: its removal semantics differ from a callback
snapshot. Clear retained scratch references in `finally` and during lifecycle teardown. Reuse
existing helpers when their semantics match; do not build a general dispatch abstraction for this.

### C. Follow-ups retained outside the required scope

Native bridge evidence: `packages/runtime-native/src/webgpu/bindings_presentation.cpp:507` creates
the linear texture; line 697 releases it. `context.cpp:156` prefers a linear surface, so this path
applies only where `TN_SURFACE_FORMAT` says `bridge=true`. Existing desktop success with
`bridge=false` cannot prove a benefit. A reuse design must preserve fresh-texture zero contents,
including `autoClear=false`, expired JS handles, resize/reconfigure/device-loss cleanup and queued
GPU work. A clear/reuse pass may cost more than allocation; benchmark first. The native Linux
executable and two Android emulators were present during discovery, but no target was run.

The inactive alpha hook is at `renderer.ts:287,747,770` and
`render/alpha-antialiasing.ts:118`. The inactive branch returns before the WeakSet lookup, so the
removed work would be only a wrapper call and cached activation check. Do not infer activation
from a transient render-target sample count; [Three distinguishes surface samples from current
render-target samples](https://threejs.org/docs/pages/Renderer.html#currentSamples).

## Integration Ledger

| Capability | Existing consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Shared skeletal preparation | Existing `new SkeletalMesh3D(...)` → clip validation / first clip measurement | Equivalent repeated preparation shares derived data; unsupported inputs retain the current path | AC-1–AC-3 |
| Reused private frame storage | `defineGame` → fixed/render callbacks, pointer dispatch, `AnimationPlayer.update` | Remove named unconditional allocations; public reads and metrics remain intact | AC-4–AC-6 |
| Installed default adoption | Unedited Midway game source → content-hashed engine tarball | Dependency update only; no game-side optimization copy or opt-in | AC-7–AC-10 |

## Acceptance Criteria

- [ ] AC-1 [local; actor: implementation agent]: Repeated eligible `SkeletalMesh3D` creation and first clip use perform at most one full binding audit and one full stride sample per equivalent source/clip/input combination, including Midway's uniformly scale-varied crew clones through proven normalization; existing calls require no new option. Evidence: shared path implemented and covered by focused specs (`PropertyBinding.bind` and `AnimationMixer.setTime` counts); uniformly scaled clones reuse and rescale the stride while non-uniform scale falls back to per-instance measurement. The scale-varied Midway crew case is not yet run on the real GLBs, so this stays open.
- [x] AC-2 [local; actor: implementation agent]: Source, clone, hierarchy, track-content and transform changes cannot reuse stale preparation; missing/zero-bound required clips still fail through the constructor. Evidence: `packages/core/__tests__/animation.spec.ts` "SkeletalMesh3D shared preparation reuse" — hierarchy, clip-keyframe, undriven-bone and ambiguous-name changes miss, and missing/zero-bound required clips still throw; `pnpm exec vitest run packages/core/__tests__/animation.spec.ts` 40 passed.
- [ ] AC-3 [local; actor: implementation agent]: Real sailor/director/pilot fixtures preserve baseline pose, stride values, per-instance phase/rate, one-shot timing and `strideSync: false` reporting; paired preparation medians improve at least 20% on a declared repeated-rig workload. Evidence: on a declared repeated-rig workload (12 clones of a 40-bone source with 3 in-place clips, one warm-up pair then 6 alternating pairs, median) independent `AnimationPlayer` preparation measured **111.57 ms** against **27.14 ms** for shared `SkeletalMesh3D` — **75.7% faster**, above the 20% bar. The real sailor/director/pilot fixtures and the pose/phase/one-shot/`strideSync: false` preservation checks remain pending.
- [ ] AC-4 [local; actor: implementation agent]: Steady iterations eliminate the specific scratch-map, callback-snapshot-array, unread stride-report and scalar-query record construction sites in decision B. Caller-visible event/snapshot objects and first-seen capacity growth are explicitly excluded; this is not a claim about every allocation inside those methods. Evidence: all four sites replaced — `.stride` materializes on read (`animation.ts`), after-physics and before-render dispatches snapshot into reused arrays (`loop.ts`, `game.ts`), the pointer active set reuses a field (`pointer-events.ts`), and the per-frame draw-call and buffer-height reads use scalar accessors (`game.ts` from `renderer.ts`); constructor/allocation instrumentation is still pending, so this stays open.
- [ ] AC-5 [local; actor: implementation agent]: Retained stride/surface/metric observations stay unchanged after later updates; current values, world-before-overlay counts and diagnostic cadence match baseline. Evidence: "keeps a retained stride report unchanged after a later update" passes; surface/metric cadence evidence still pending.
- [ ] AC-6 [local; actor: implementation agent]: Existing lifecycle consumers preserve nested dispatch, add/remove/clear order, exception cleanup, pointer edges and hover behavior. Evidence: `loop.spec.ts` covers add-during-dispatch, removal-during-dispatch, clear, nested dispatch and recovery after a callback throws; `game.spec.ts` covers the before-render seam snapshot (an addition waits a frame, a removal still runs) and the existing clear-on-dispose/scene-change/restart cases; the full engine dev-instance playtest (`pnpm test:playtest`) passed all six scenarios; pointer edge/hover behavior rests on the existing pointer suite.
- [ ] AC-7 [local; actor: implementation agent]: Unedited Midway game source consumes distinct baseline/candidate hashed tarballs; browser WebGPU deck captures preserve crew appearance and launch behavior. Evidence: unedited Midway consumed candidate `threenative-core-0.3.2-prd385-02d6b80e0be4.tgz` in an isolated copy (the shared canonical checkout was left untouched); `launch.playtest.json` on WebGPU (NVIDIA turing) passed all gameplay assertions with 0 console errors and the scene reported `skinned: 12` crew clones; the baseline `projfix-b2629381e2dc` also passed. Deck appearance captures (`capture-deck.mjs`) and the fleet captures are not yet run.
- [ ] AC-8 [local; actor: implementation agent]: Matched Midway browser runs report preparation and frame distributions separately; candidate frame p95 does not regress over 5% across paired runs on the same named adapter and workload. Evidence: pending.
- [ ] AC-9 [local; actor: implementation agent]: A native desktop real-rig fixture exercises the changed default preparation and reports on the installed candidate; values/behavior match the browser contract. Evidence: the C++ host built from this branch (`pnpm native:build`, `mystral` linked) and `pnpm native:verify:desktop` passed every gate — desktop audio decode, lifecycle stability, core 300 frames at 1280x720 with a screenshot, physics actuation/query/playtest (14 assertions), the native contract lane (43/43 targets) and the desktop loading proof. The real-rig conformance fixture / `--target desktop` playtest that exercises the changed preparation itself is still pending. Native target execution is mandatory before claiming portability.
- [ ] AC-10 [local; actor: implementation agent]: Existing capability/template documentation describes the automatic behavior and fallback honestly; affected checks and required engine gates pass. Evidence: pending.

No owner sign-off or physical-device performance claim is required. Native desktop and browser are
the qualification lanes for this scope. Android/iOS performance remains unverified; emulator
availability does not establish physical-phone performance. If a required lane proves unavailable,
leave its criterion open and record the concrete attempted command; do not replace it with a mock.

## Execution Phases

### Phase 1 — Existing rig creation shares equivalent preparation

**Status:** PARTIAL
**ACs:** AC-1–AC-3
**Files:** `packages/core/src/animation.ts`, `packages/core/src/rig-preparation.ts`,
`packages/core/src/skeletal-mesh.ts`; `packages/core/__tests__/animation.spec.ts`.

The conservative reuse path is wired into the existing `SkeletalMesh3D` → `AnimationPlayer`
constructor and lazy stride measurement, with a per-source `WeakMap` cache and content signatures.
`clip-audit.ts` was left as the audit primitive rather than moving it. Still missing: the real
sailor/director/pilot GLBs and the warmed baseline/candidate timing comparison (AC-3).

- [ ] Shared preparation and conservative fallback reach existing constructor/clip consumers — E1: 8 focused animation cases pass (`pnpm exec vitest run packages/core/__tests__/animation.spec.ts`, 40 passed); real fixtures and warmed alternating timings pending.

**Checkpoint:** Partial; cache keys, mutation/fallback correctness and the fallback paths are
covered by focused specs. Real-fixture savings (AC-3) are not yet measured, so cache scope must not
expand before that lane runs.

### Phase 2 — Existing frame consumers reuse private storage

**Status:** PARTIAL
**ACs:** AC-4–AC-6
**Files:** `packages/core/src/animation.ts`, `loop.ts`, `game.ts`, `pointer-events.ts`, `renderer.ts`;
existing animation, loop, game, pointer and projection allocation specs.

Decision B's four sites are replaced: `.stride` now materializes a fresh report on read instead of
per update, the after-physics and before-render dispatches snapshot into reused depth-pooled arrays,
the pointer active set reuses a scratch map, and the per-frame draw-call and drawing-buffer-height
reads use scalar accessors instead of building records. Snapshot/dispatch semantics are covered by
new focused cases. What is still missing: constructor/allocation instrumentation that observes the
object literals themselves, and an explicit exception-cleanup case.

- [ ] Named hot paths reuse storage while their public snapshots and dispatch semantics pass — E2: focused animation/loop/game/pointer specs pass (134 total); explicit allocation instrumentation and an exception-cleanup case pending.

**Checkpoint:** Partial; snapshot lifetimes and dispatch order reviewed through the focused specs.
Allocation measurement is not yet done, so no allocation-free claim is made.

### Phase 3 — Ship the defaults through installed packages and prove their consumers

**Status:** PARTIAL
**ACs:** AC-7–AC-10
**Files:** affected engine capability descriptions and template `AGENTS.md` sources/mirrors;
Midway dependency/lock files and existing capture fixtures only where required for observation.

The draft PR was opened first (PR #251). The candidate `@threenative/core` was built and packed from
this branch, content-hashed as `threenative-core-0.3.2-prd385-02d6b80e0be4.tgz`, and installed into
an isolated Midway copy because the canonical Midway checkout is in use by another lane. The
unedited Midway `playtests/launch.playtest.json` then passed on the WebGPU lane with 0 console
errors and 12 skinned crew objects in the scene. Still missing: the baseline/candidate deck
appearance captures, the paired performance runs, native desktop proof, and the template/doc
adoption pass.

- [ ] Installed browser/native consumers, documentation and required gates satisfy acceptance — E3: `launch.playtest.json` passes on the installed candidate; deck captures, paired performance, native and docs gates pending.

**Verification:**

1. Engine focused tests: `pnpm exec vitest run packages/core/__tests__/animation.spec.ts packages/core/__tests__/loop.spec.ts packages/core/__tests__/pointer-events.spec.ts packages/core/__tests__/game.spec.ts packages/core/__tests__/projection-hot-path.spec.ts`; extend the existing suites for new cases.
2. Required engine gates: `pnpm typecheck && pnpm lint && pnpm test`, `pnpm budgets`, and `pnpm tsx scripts/count-loc.ts` for the shared-preparation kill-switch review.
3. Midway: `pnpm typecheck`; `node tools/check-asset-polish.mjs`; `bash tools/capture-lock.sh node tools/capture-fleet.mjs`; `bash tools/capture-lock.sh node tools/capture-deck.mjs`. Inspect the actual crew frames. A passing assertion cannot prove appearance.
4. Performance: use `bash tools/capture-lock.sh node tools/capture-performance.mjs` with `MIDWAY_URL` pointing at isolated baseline/candidate installs, identical camera/population/resolution and fixed clocks. Alternate at least three 60-second steady runs after warmup; measure startup/first-use separately because this capture deliberately excludes loading. Extend the existing capture only for missing preparation observations. For sustained claims, also run the ten-minute Tier 4 comparison; shorter captures do not prove sustained performance.
5. Native: `pnpm native:verify:desktop` is the host prerequisite, followed by a real-rig conformance fixture or `--target desktop` playtest exercising these changes. A generic smoke scene is insufficient. Record platform, adapter, artifact identity and actual assertion output.

Use red/green only for new behavior that needs a regression check; do not manufacture failures for
this planning document. Store results once in this PRD or the associated PR. An independent review
at the substantive checkpoints checks the changed consumer and evidence, not another full test run.
After merge, remove only the verified-owned completed worktree under the repository's cleanup rules.

**Checkpoint:** Pending. All required ACs must be verified before marking DONE and moving this
file to the established `done/` location. Native bridge and inactive-hook follow-ups above are
explicitly excluded, not unfinished work hidden behind completed acceptance.

## Planning validation

`pnpm check:docs` passed (2,126 links across 1,095 Markdown files). The repository's six prose-lane
test files passed, **164 tests**, exit 0. `pnpm prd:progress` parsed 0/3 phases and 0/10 acceptance
criteria, label `prd:0%`. OpenCode/DeepSeek PRD review returned **PASS**; its scale-varied-crew
acceptance clarification and conditional audit benefit were incorporated. No implementation gates
are claimed by creation of this document.
