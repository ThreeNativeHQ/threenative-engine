# Engine performance architecture — 2026-10-28

Sliced from [the architecture investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
All seven new PRDs are **NOT STARTED, 0%**. This batch authorizes planning only; the investigation's
operation counts and historical timings are inputs, not implementation or performance acceptance.

## Coverage and order

| Source proposal | Owning PRD | Dependency | Estimated implementation |
| --- | --- | --- | --- |
| 1. Clear only actuated bodies | [PRD-762](PRD-762-only-actuated-bodies-clear-forces.md) | Independent; first for debris workloads | 1–2 engineer-days |
| 2. Changed poses and body roles | [PRD-763](PRD-763-physics-publishes-only-changed-poses.md) | Independent; coordinate shared physics files with 762 | 4–7 engineer-days |
| 3. Scene ray candidate selection | [PRD-764](PRD-764-scene-ray-queries-skip-irrelevant-objects.md) | Independent | 5–10 engineer-days |
| 4. Temporal history and precision | [Existing PRD-756, Phase 2](../Unreal/performance/PRD-756-the-temporal-resolve-feeds-one-shared-post-chain.md) | Existing lane and PR ownership retained | 4–8 engineer-days |
| 5. Bulk presentation interpolation | [PRD-765](PRD-765-presentation-interpolates-physics-poses-in-bulk.md) | PRD-763's qualified changed-pose seam | 7–15 engineer-days |
| Reflection follow-up | [PRD-766](PRD-766-reflections-skip-unread-output-processing.md) | Independent; first for reflector-heavy scenes | 1–2 engineer-days |
| Sensor follow-up | [PRD-767](PRD-767-native-sensors-reuse-membership-storage.md) | Independent; coordinate Rust physics ownership | 2–4 engineer-days |
| Uniform follow-up | [PRD-768](PRD-768-render-passes-sync-only-their-live-uniforms.md) | Independent; lowest priority pending fresh sizing | 2–4 engineer-days |

The only new hard dependency is **763 → 765**. No new temporal PRD: 756 already owns alpha/range
auditing, packed HDR history, supported precision and fallback, and its 1.5 ms Iris Xe goal.
Its measured 0.44 ms shared-downsample opportunity stays deferred. The dedicated folder groups
the requested planning batch; it creates neither a combined implementation PR nor a new renderer.

## Execution contract

Each slice changes the **engine layer**: the repeated work lives in shared package/runtime paths.
Reuse the public consumer and existing profiling, parity and playtest runners. At implementation
start, repeat capability search for that slice and inspect each hit; do not introduce a parallel
query, command, benchmark or renderer framework. Check current source and dependent PRDs before
claiming that a historical bottleneck still exists.

1. Pin control/candidate revisions, workloads and quality; take at least three matched timing
   pairs after warmup. Record actual crossings separately from wrapper entries, allocation counts,
   component CPU/GPU p50 and presented-frame p50/p95, adapter, resolution, host load and temperature.
   CPU and GPU claims stay separate. Counts alone do not prove a frame-time gain.
2. Use 1,000/10,000-body or mesh populations where specified, both idle and active. Fix camera,
   input and seeds. Preserve render work and quality; report supported-target results separately.
   An operation-count win must also reduce its targeted steady-state CPU/GPU cost beyond measured
   run noise, without more than 5% frame-p95 regression. These are proposed adoption bars, not results.
3. Each changed behavior gets red→green coverage through the named consumer, focused related
   tests, and a real playtest scenario. Planned test extensions below do not exist until implemented;
   distinguish them from existing tests. Add scenarios to the existing harness, not a new runner.
   Validate malformed buffers/IDs and disposal; use the repository's failure diagnostics for
   environmental failures. Run `pnpm prd:progress <file>` at start and after each phase.
4. For any changed presentation, including interpolation, reflection and uniform work, freeze
   acceptance as **preserve the incumbent appearance and temporal stability**. Capture the same
   pose headed with `--browser-recipe webgpu`, verify `adapter.info`, take at least two runs per
   arm, burn BEFORE/AFTER into captures, and obtain a fresh read-only visual subagent verdict.
   NEUTRAL or IMPROVEMENT passes; REGRESSION fails. Store verdicts on the owning PRD box and
   images on its PR through the repository's screenshot-branch convention. Physics publication
   also needs this judge if it changes what reaches the screen.
5. Local proofs name browser and Linux desktop explicitly. Before implementation, resolve changed
   native contracts against [the native platform workflow](../../../.github/workflows/native-platforms.yml)
   and [CI's test-native job](../../../.github/workflows/ci.yml). Any additionally required target
   must gain its own lane/AC, or a named unavailable runner under `Blocked on`; it blocks closure.
   CI is shared evidence, triggered by the implementing agent's authorized push, and must identify
   its actual run/job. No mobile, macOS or Windows result is inferred from Linux or browser proof.

Scope stays at three phases and at most eight boxes per new PRD. Each phase's outcome is verified before
its box is ticked; acceptance consumes that evidence. No mandatory human acceptance is introduced.
Use laptop offload for jobs over five minutes when capacity permits. Keep results in the owning
PRD/PR, keep the named compatibility paths until qualified, and follow the repository's one-PR-per-
implemented-PRD and archive rules. This planning commit starts no implementation lane or CI run.

## Reuse and exclusions

The incumbent systems already provide cached math/property access, bulk physics records, resting
pose reads, per-mesh BVHs, scene-only render targets, FRAME callback deduplication and unchanged
uniform-write suppression. Extend these owners. Skip a universal ABI replacement, another command
buffer, a render thread, generic caches and the rejected opaque draw reordering. PRD-753 keeps its
≥2% profiling gate; none of this batch revives its deferred projection work.

These are optimizations of existing ThreeNative contracts, not new Unreal feature ports. The
[Unreal port order](../Unreal/research/unreal-visuals-and-performance-feature-map.md) remains the
source for new ports. For the already-owned temporal work, local UE 5.8.3 source was re-read at
`Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:63–70` (packed
history and alpha guard) and `:98–101` (16-bit option). PRD-766 cites the capture subsystem it
reuses conceptually. Borrow ideas and guards only; copy no Epic code or comments.
