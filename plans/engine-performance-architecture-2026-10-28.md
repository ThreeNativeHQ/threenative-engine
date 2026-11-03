# Engine performance architecture: where to remove work

**Date:** 2026-10-28 · **Source revision:** `687f261e1` · **Status:** ✅ investigation complete; suggestions only.

## TLDR

**Reduce whole classes of ABI calls and repeated work, rather than rewriting the bridge.** The browser bridge already caches most reads and exposes engine math through memory views. The strongest remaining CPU opportunities are conditional on workload: unforced dynamic bodies, large sleeping physics worlds, and many scene ray queries. For GPU-bound scenes on integrated graphics, temporal-resolve cost is a larger evidenced target.

**Recommended first action:** size force-reset calls in a debris-heavy scene, then prototype an actuated-body list. It is the smallest proposal with a clear crossing-count reduction. For Iris Xe/default-look performance, continue PRD-756 Phase 2 instead of starting another renderer project.

✅ A controlled web-physics probe confirmed unnecessary reset calls on sleeping dynamics. ⚠️ No new FPS measurements or optimization A/B runs were performed. Historical timings below are distinguished from newly counted operations and proposed gains.

## How the ratings work

Stars rate **expected impact relative to implementation effort**, discounted for uncertainty and correctness risk. Five stars is the best return in the stated workload, not a promise of a universal speedup. Estimates are engineer-days including focused tests; platform qualification may add time.

| Priority | Suggestion | Effort × impact rating | Effort | Where substantial gains are plausible | Gain confidence / risk |
| --- | --- | --- | --- | --- | --- |
| 1 | Clear forces only on actuated bodies | ⭐⭐⭐⭐⭐ | 1–2 days | Thousands of unforced dynamic bodies; directly removes Rapier Wasm calls | Medium / medium |
| 2 | Publish changed physics poses, with indexed body roles | ⭐⭐⭐⭐ | 4–7 days | Large mostly fixed/sleeping worlds; work follows changes instead of residency | Medium / high |
| 3 | Give ray queries a scene-level broad phase and bulk engine query path | ⭐⭐⭐⭐ | 5–10 days | Multiple rays over large scenes; removes repeated object discovery and crossings | Medium / high |
| 4 | Qualify narrower temporal history and shader precision | ⭐⭐⭐⭐ | 4–8 days | GPU-bound integrated graphics; existing resolve costs about 4.5 ms at 1080p | Low–medium / high |
| 5 | Keep simulation poses and presentation interpolation in a bulk engine path | ⭐⭐⭐ | 7–15 days | Large interpolated dynamic populations | Medium / high |

### 1. Clear forces only on bodies that received them — ⭐⭐⭐⭐⭐

**Evidence.** [simulation.ts:1457](../packages/physics/src/simulation.ts) walks every body and calls `resetForces(true)` and `resetTorques(true)` on every dynamic body after each solve. Fixed bodies already skip these calls. Force application has centralized seams at lines 1332 and 1337. Native [lib.rs:1204](../packages/runtime-native/native/physics/src/lib.rs) clears both on every entry.

**Architecture change.** Track bodies receiving a force or force-at-point in a reusable collection. Clear only those bodies after the solve, then empty the collection. Preserve the one-fixed-step force contract on both backends. This is a small change to existing simulation ownership, not a new command framework.

**Why it can matter.** With `D` dynamics, the web path currently makes `2D` reset calls per tick. With `F` force recipients, the target is `2F`. At 10,000 dynamics and 60 ticks/second, the incumbent implies **1.2 million reset calls/second**. This is arithmetic from the source, not a measured workload or speedup. On desktop native, the calls stay inside Rust; the opportunity is skipped work rather than 1.2 million JS crossings.

**New controlled check.** With 1,000 separated dynamic boxes, zero gravity, every body explicitly asleep and no applied forces, three plugin ticks invoked **3,000 force resets and 3,000 torque resets**. All 1,000 remained asleep. The final full snapshot still returned 1,000 rows, while the resting cache made zero new backend pose reads. This directly confirms the avoidable call class and full-snapshot work; it does not measure saved milliseconds.

**Risk and boundary.** Audit every force writer, including buoyancy and backend-specific `raw` access, before changing semantics. A list populated only by the portable seam can miss forces written through the raw backend. Preserve compatibility with explicit handling of that escape hatch. Resetting with `true` is not evidence that every sleeping body wakes; the issue established here is unnecessary work.

**Proof before adoption.** Extend the existing `crossings.spec.ts` with many unforced dynamics and a small forced subset. Run actuation, buoyancy and vehicle tests plus web/native physics parity. Measure actual reset calls and simulation CPU per tick in sleeping-debris and active-debris scenes. Adopt only if the reduction survives a real playtest without persistent-force regressions.

### 2. Publish changed poses instead of replaying the entire physics world — ⭐⭐⭐⭐

**Evidence.** [plugin.ts:212](../packages/physics/src/plugin.ts) scans the complete body collection for kinematics, then again for characters at line 219. Lines 244–262 request and dispatch all transform records. Web [simulation.ts:1467](../packages/physics/src/simulation.ts) visits every valid body; native [lib.rs:1996](../packages/runtime-native/native/physics/src/lib.rs) exports every entry. The web resting-pose cache at `simulation.ts:987` already avoids repeated backend pose reads for fixed/resting bodies; it still copies their records into the output.

**Architecture change.** Maintain kinematic and character registries through registration/removal. Add an internal changed-pose stream for the plugin, backed by reusable typed arrays. Keep the complete `readVisibleTransforms()` snapshot contract for existing consumers and diagnostics. Publish initial poses, teleports, wake/sleep transitions and externally driven changes explicitly.

**Why it can matter.** Existing bulk transport already limits the number of host calls. The remaining problem is **payload and work per call**: classification, serialization, validation, lookup and application scale with total resident bodies. A changed-pose stream makes downstream publication proportional to changed visual bodies. A backend may still need a scan where its API does not expose a reliable active/dirty list; do not claim the whole step becomes O(changes) automatically.

**Risk and boundary.** A sleeping object's visual can still be edited by game code. Preserve physics-authoritative correction, interpolation resets, disposal and direct backend clients. Use collision/query state independently of visual residency: off-screen bodies must continue simulating when gameplay needs them.

**Proof before adoption.** Extend `transform-sync-cost.spec.ts`, `crossings.spec.ts`, `plugin-buffer.spec.ts` and interpolation coverage. Compare 1,000 and 10,000 resident bodies at several moving-body fractions, recording published bytes/rows, backend reads and synchronization CPU separately. Run the existing web/native parity lane and a moving/sleeping/teleport playtest.

### 3. Move object selection out of repeated JavaScript ray walks — ⭐⭐⭐⭐

**Evidence.** Each query calls `root.updateMatrixWorld()` and recursively collects objects at [picking.ts:139](../packages/core/src/picking.ts). Lines 183–211 visit children; nearest-hit queries still inspect reached objects before selecting the global nearest result. The per-geometry `MeshBVH` cache at lines 292–315 accelerates triangle tests inside a mesh, not scene-object discovery.

**Architecture change.** Retain an index over queryable object bounds, separating static and moving members. Update affected bounds and traverse candidates nearest-first. On the owned engine, keep candidate selection and intersection inside one engine operation; batch multiple rays when callers can naturally submit them together. Reuse existing engine query/geometry machinery and the current picker API. Start with shared transform freshness and candidate filtering before committing to a larger index.

**Why it can matter.** `Q` queries over `N` nodes can repeat O(Q × N) discovery and transform work. On the Wasm backend, per-object hit tests can add crossings. One scene-level engine query removes that class of crossings; making an individual `intersectObject` wrapper faster leaves the repeated traversal intact. Narrow explicit target sets already reduce the problem and should remain available.

**Risk and boundary.** Preserve move→query immediacy, targets, layers, exclusions, hidden merged-source identity, deformed meshes and all-hit ordering. A frame-wide freshness flag alone is insufficient when gameplay mutates a transform between two queries. A scene index must observe relevant mutations rather than merely refresh once per frame.

**Proof before adoption.** Run `picking.spec.ts`, `picking-exclusion-cost.spec.ts` and `picking-offset.spec.ts`. Add scaling cases with many irrelevant meshes and fixed ray sets, checking candidate visits, transform visits and real engine crossings. Pair with a camera-obstruction/hitscan playtest and a correctness oracle against the incumbent picker.

### 4. Reduce temporal-resolve bandwidth after auditing history consumers — ⭐⭐⭐⭐

**Evidence.** [PRD-756 Phase 1](../docs/PRDs/Unreal/performance/PRD-756-the-temporal-resolve-feeds-one-shared-post-chain.md) records 1080p `traaResolve` at **4.546 and 4.532 ms** on Iris Xe. Phase 2 remains open. [traa.cpp:657](../packages/runtime-native/src/engine/renderer/post/traa.cpp) binds previous history and writes display color, dynamic mask and next history as three attachments at lines 667–669.

**Architecture change.** Continue the existing Phase 2: audit history alpha/range consumers, then evaluate packed HDR history and optional shader-f16 where supported, with an honest fallback. Audit actual attachment formats and bytes transferred before selecting a replacement. Borrow algorithm/default/guard decisions from the pinned Unreal source before implementation, as the repository requires.

**Why it can matter.** This targets an already expensive GPU pass rather than a sub-millisecond CPU wrapper. The historical 4.5 ms identifies a target, not recoverable savings: shading, sampling and other dependencies remain. The PRD's 1.5 ms improvement goal is an acceptance criterion, not an achieved result.

**Risk and boundary.** HDR range, alpha consumers, ghosting, disocclusion and adapter support. This cannot silently change the default appearance. Preserve temporal stability and supported-adapter fallbacks. Color/mask history swapping already landed; proposing removal of those copies again duplicates existing work.

**Proof before adoption.** Use existing TRAA native tests/readback fixtures, adapter capability checks and at least three matched GPU timing pairs. Run moving-camera, emissive, transparency and disocclusion scenes. Require a fresh visual judge to return NEUTRAL or IMPROVEMENT before a performance win counts. Browser, native and mobile results remain separate claims.

### 5. Interpolate presentation poses without repeatedly rewriting simulation objects — ⭐⭐⭐

**Evidence.** [interpolation.ts:30](../packages/core/src/interpolation.ts) stores six JS math objects per tracked participant. Lines 68–79 copy previous/current poses around every tick. Each interpolated render snapshots participants into a new array, saves poses, writes interpolated poses, draws, restores solved poses and updates changed matrices at lines 94–125.

**Architecture change.** Extend the existing transform-record seam with previous/current presentation state and send alpha once to an engine-owned bulk interpolation operation. Keep solved simulation transforms authoritative. Build presentation matrices in the rendering path rather than round-tripping every body through JS writes. Retain the existing implementation for the legacy Three.js backend.

**Why it can matter.** For large tracked populations this removes repeated pose marshaling and JS bookkeeping. Engine-backed math already has memory-view access, so each scalar operation is **not necessarily a Wasm call**; count real crossings rather than multiplying getter counts. This is a data-ownership opportunity, not proof of a specific ABI bottleneck.

**Risk and boundary.** Render callbacks can observe interpolated object poses today. Preserve that contract or explicitly resolve it before implementation; rendering different matrices alone may change observable behavior. Preserve teleport resets, parent transforms, scene changes during draw, thrown-draw restoration and alpha=1 behavior. These semantics make this a larger project than replacing an array allocation.

**Proof before adoption.** Existing loop/physics interpolation specs plus native contracts and parity. Size 1,000/10,000 moving and sleeping participants, recording copied poses, actual crossings and CPU. Run motion playtests at different presentation rates and require a visual judge.

## Smaller, targeted follow-ups

| Suggestion | Effort × impact rating | Effort | Evidence and boundary |
| --- | --- | --- | --- |
| Skip unused reflection output processing | ⭐⭐⭐⭐ | 1–2 days | [render_database.cpp:1803](../packages/runtime-native/src/engine/renderer/render_database.cpp) creates reflection siblings and copies output settings; line 1841 consumes scene color. [renderer.cpp:5168](../packages/runtime-native/src/engine/renderer/renderer.cpp) gates output on `sceneOnly_`; ordinary [render targets already skip output](../packages/runtime-native/src/engine/renderer/render_target_pass.cpp). Reuse that mechanism after proving every reflection consumer needs only scene color. Savings apply to reflectors; verify reflection fixtures and sailing with a visual judge. |
| Retain sensor membership indices and scratch storage | ⭐⭐⭐ | 2–4 days | Native [lib.rs:1336](../packages/runtime-native/native/physics/src/lib.rs) rebuilds a collider→body HashMap and pair Vec during area refresh. Retain the index across body lifetime and reuse storage first. Consider change epochs only after preserving new/moved sensors, sleeping occupants and filter edits. Run area/collision/native-contract tests and many-trigger scaling cases. Gain unmeasured. |
| Synchronize only uniforms owned by the current pass | ⭐⭐ | 2–4 days | [tsl-uniforms.ts:223](../packages/three-native/src/tsl-uniforms.ts) scans global updating/object collections for each render. Unchanged lane writes and FRAME callbacks already deduplicate; remaining RENDER callbacks and object extraction still execute. Associate live uniforms with prepared pass/material owners, preserving render cameras and in-place edits. Historical once-per-frame extraction sizing was only 0.08–0.15 ms/frame, so keep this below the larger targets. Run uniform specs, post-chain playtests and a visual judge. |

## What the ABI scan actually says

| Boundary | Existing architecture | Remaining useful target |
| --- | --- | --- |
| Game JS → engine Wasm | Property/hierarchy/action caches, direct math memory access, reused scratch and value loans | Remove repeated query/interpolation operations where counts justify it |
| Physics JS → Rapier Wasm | Reusable records plus resting-pose caching; web simulation still makes backend calls | Actuated-body force clearing; active/changed pose publication |
| Wasm engine → browser WebGPU | C++ engine reaches browser GPU APIs through glue; retained rendering already exists | GPU-call census, pass elimination and stable resource/bundle reuse only where remaining cost is measured |
| Native V8 → C++/Rust | Same high-level API, native bindings and bulk physics seam | Native-specific call census; browser crossing costs do not establish desktop savings |

[PERFORMANCE-LEARNINGS.md:210–259](../PERFORMANCE-LEARNINGS.md) records shooter route crossings falling from roughly 3,200 to 800–1,024/frame in prior rounds. Later counted kit runs recorded 455 and 655 real crossings/frame, while 83–90% of wrapper entries stayed in JS. Counted glue cost was **estimated** at about 0.37–0.49 ms/frame. Much larger DevTools attribution was affected by tracing overhead.

**Decision:** a general replacement ABI or universal command buffer has a small demonstrated ceiling in those kits and substantial compatibility cost. Prefer a bulk operation at the owner of a measured repeated task. Batching a synchronous query must preserve when its answer becomes available; deferring reads indiscriminately changes gameplay.

## Preserve existing wins; avoid restarting rejected projects

| Proposal considered | Verdict |
| --- | --- |
| More generic property caching, local JS math, visible-only matrices, static freezing, automatic batching or animation-rate selection | ✅ Existing mechanisms. Search and extend them rather than creating parallel systems. |
| Add a native render thread, retained bundles, pipeline caching or bulk frame uniforms | ✅ Existing mechanisms. Native frame uniform upload is already bulk at `renderer.cpp:3942`; the render-thread result is documented in `PERFORMANCE-LEARNINGS.md:366`. |
| Incremental projection change sets | ⚠️ [PRD-753](../docs/PRDs/Unreal/performance/PRD-753-a-scene-change-updates-only-the-batches-it-touches.md) deferred after target functions measured only 0.06–0.32% of game-thread time. Revisit its ≥2% gate rather than the stale 10.8% premise. |
| Reorder retained opaque draws by state | ❌ PRD-754's attempted ordering changed coplanar winners and received a visual REGRESSION. Keep ordering semantics; native shadow bundle wins already landed. |
| Share every post downsample chain or remove history copies again | ⚠️ PRD-756 sized shared-chain removal at 0.44 ms, below its 1 ms gate. PRD-755's history swaps already landed without a measurable Iris Xe gain. |

## Measurement and delivery order

1. **Size the relevant workload first — 0.5–1 day.** Use existing engine-cost counters and `profile:wasm-page --calls --gpu-calls`; distinguish real crossings, wrapper entries, CPU time and GPU pass time. Measure idle and representative motion/action separately, with adapter, resolution and host load recorded. Avoid using instrumented trace duration as a timing verdict.
2. **Implement the smallest matching change.** Start with proposal 1 for debris-heavy physics, the reflection follow-up for water scenes, or PRD-756 Phase 2 for a GPU-bound Iris Xe frame. Pick one bottleneck; CPU savings do not automatically improve a GPU-bound frame.
3. **Scale the architecture only when the counters warrant it.** Proposal 2 precedes proposal 5 because changed-pose publication gives interpolation a reusable data seam. Proposal 3 is independent. Use existing playtest, parity and profiling harnesses rather than a new benchmark framework.
4. **Accept measured, equivalent behavior.** Use matched control/candidate runs with p50/p95 frame time and component CPU/GPU timings. Keep scene, quality and render work comparable. Run platform-specific proof and the required fresh visual judge for anything changing presentation. Retain a reversible override until qualified.

## Verification performed and limits

✅ Ran this focused existing regression set:

```sh
pnpm exec vitest run \
  packages/core/__tests__/picking.spec.ts \
  packages/core/__tests__/loop-interpolation.spec.ts \
  packages/physics/__tests__/interpolation.spec.ts \
  packages/three-native/__tests__/tsl-uniforms.spec.ts \
  packages/three-native/__tests__/bridge-reads.spec.ts
```

**Result: 5 files passed, 59 tests passed; 2.73 seconds.** These establish a narrow existing-behavior baseline. They do not prove the proposed improvements or performance gains.

✅ Ran the more specific physics regression set:

```sh
pnpm exec vitest run \
  packages/physics/__tests__/crossings.spec.ts \
  packages/physics/__tests__/actuation.spec.ts \
  packages/physics/__tests__/transform-sync-cost.spec.ts \
  packages/physics/__tests__/plugin-buffer.spec.ts \
  packages/physics/__tests__/area.spec.ts
```

**Result: 5 files passed, 37 tests passed; 3.15 seconds.** Rapier emitted an initialization deprecation warning; the buffer suite also emitted its expected deprecated-world-option diagnostic.

✅ Ran a standalone, in-memory probe against the real Rapier web backend through `rapier()` and `RigidBody3D`: zero gravity, non-overlapping boxes, explicit sleep, no forces, three ticks. Wrapped `RAPIER.RigidBody.prototype.resetForces/resetTorques` to count actual calls, restoring both in `finally` and disposing each plugin. Assertions checked exact calls, snapshot rows and sleeping count:

| Dynamic bodies | Ticks | Force-reset calls | Torque-reset calls | Snapshot rows | Still sleeping | Final snapshot backend pose reads |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 3 | 30 | 30 | 10 | 10 | 0 |
| 100 | 3 | 300 | 300 | 100 | 100 | 0 |
| 1,000 | 3 | 3,000 | 3,000 | 1,000 | 1,000 | 0 |

**Result: all assertions passed, exit 0.** The initial probe fixture incorrectly attempted position-only dynamic bodies; construction correctly rejected it (`position-only bodies must be fixed`). The corrected probe supplied `Object3D` instances. No source fix was needed. This is a headless operation-count experiment, not a game performance measurement.

✅ Documentation contract lane: `check-doc-links.spec.ts`, `evidence-budget.spec.ts`, `evidence-citations.spec.ts`, `sync-agent-docs.spec.ts`, `ci-structure.spec.ts` and `ci-needs.spec.ts`: **6 files passed, 273 tests passed; 16.38 seconds**. The existing `assertDocLinks` checker scoped to this report passed **16 relative links, zero missing**.

⚠️ `pnpm check:docs` exited 1 because the working tree already lacks tracked `artifacts/engine-load-test/prd-449/holdout/README.md`; its Unreal-status step therefore did not run. The deletion was present before the audit and was left intact.

✅ Three bounded read-only scouts investigated native rendering/bindings, core frame/query/interpolation paths and physics synchronization. Findings retained here were checked against source and current performance learnings. Capability search and detail inspection covered the installed matrix, projection, static, physics, animation, warmup and profiling-related mechanisms.

⚠️ No source implementation, builds, live GPU/native/device benchmarks, new visual captures or optimization visual judging were performed. Historical timings were not rerun. Shader precision, history-format feasibility, raw physics force compatibility and end-to-end gains remain unverified. Asset streaming/decode, audio, networking, terrain and every platform-specific host were not exhaustively audited. Existing local edits and deletions were left intact; this report was written separately under `plans/`.
