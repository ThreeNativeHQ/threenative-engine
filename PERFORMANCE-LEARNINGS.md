# Performance learnings

This file is the central record of performance levers tried in this repository, and of the method lessons they
taught. Read it before you choose a lever. Add one entry for each closed lever (keep, reject or inconclusive)
before you start the next one, and an insight from a failure only when it is valuable. Update an existing entry
instead of adding a near-duplicate, and merge or trim entries when the file grows redundant. Keep the conclusion of
every rejected lever so that nobody retries it without a new reason. The `performance-optimization-loop` skill follows this file. Older per-PRD records are in each
PRD's "Tried and rejected" or "Decisions" section, for example
[PRD-610](docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md).

## Method lessons

- **Low native IPC was thread placement, not V8 or engine code.** On Xvfb the GPU worker busy-waits inside the NVIDIA present (`__vdso_clock_gettime`, 55% of the player's process cycles) and shares cores with the game thread. The same Midway binary read 32M to 50M cycles per frame at 20.5M instructions as host load changed. An external watcher that gave the game thread its own core moved main-thread CPU 7.22 / 9.41 / 9.77 → 6.11 / 6.64 / 7.74 ms (IPC 0.66 / 0.57 / 0.70 → 0.82 / 0.83 / 0.93) with identical instructions (2026-10-15, campaign `artifacts/native-performance-loop/prd610-placement-20261015`). Before you judge a lever by CPU ms, check where the game thread and the present worker run; a lever smaller than the placement noise cannot be resolved by more pairs.

- **Profile the owning worker before optimizing the main thread.** The PRD-610 exact-window native process recording attributes dominant worker samples to Vulkan presentation/NVIDIA-driver ancestry, including clock reads; main-thread sampling would miss this owner. Retain recorder scope, sample losses and resolved ancestry. CPU samples inside present do not establish whether GPU backlog, driver polling or a virtual display causes the cost; render-pass GPU timestamps also exclude queue waiting and final swapchain presentation. Use a separate discriminator before choosing a fix.

- **Measure full-loop completion separately from render-body cost:** [PRD-610 AC-19](docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md) records the unqualified first diagnostic and its missing body-cost attribution. Midway publishes state every six updates, so recorded state-transition timestamps are publication witnesses, not exact simulation-event times. Native-only HUD/player coordinates are not cross-arm equality witnesses; use existing shared state and scene-camera observations while retaining exact-state limitations.

- **Include cache storage in the measured candidate.** The experimental Object3D compose cache compares bitwise TRS/pivot inputs and still verifies published matrix bytes, preserving escaped raw writes. It adds 240 bytes/node (440 → 680), allocated without an environment switch. Baseline edge cases pass before implementation; the candidate passes 80 focused native checks plus startup. This establishes readiness only: unchanged-transform work may shrink, but larger nodes and input comparisons can offset it. Timing, parity and a fresh visual judge are still required before promotion (PRD-610 AC-20).

- **LTO can expose generated-header ODR bugs.** The runtime and math script headers generated different external-inline `runtime_scripts::find` definitions. With global GCC IPO, both audio startup fixtures failed despite identical, complete generated inputs. Giving each generated lookup internal linkage (`static inline`) makes both fixtures pass on IPO and rebuilt non-IPO arms. SDL's existing tray `objcopy` rewrite also requires `SDL3-static` to remain non-LTO. Each corrected arm passes 37 CPU checks plus 27 V8/player checks and warning-free audio startup; this is correctness readiness, not a measured speed win.

- **Count redundant setters before guarding them.** `TN_MATERIAL_DIAGNOSTICS=1` now adds cumulative opacity-write buckets and record/graph rebuild counts plus thread CPU to existing `TN_PLAYER_RENDER_HOLD` boundaries. Default off; setter/version semantics remain unchanged. Four focused ctests pass after missing-member compiler RED. Difference the host-tick markers around the exact 1,000-tick window; cache-miss-body CPU is an upper bound within those bodies, not complete rebuild cost or opacity-only attribution. The first diagnostic acquisition rejected the invalidation guard budget (see the native opacity entry below).

- **Size a lever before you code it.** Measure its ceiling with a counter or a phase timer inside the measured pose
  windows (`TN_PLAYER_CROSSINGS=1`, `TN_RENDER_PREPARE_SPLIT=1`, a temporary env counter). Then project calls per
  frame times cost per call. On 2026-10-14, two levers chosen from profile shares were flat in A/B.
- **A profile window must exclude loading.** A 100 s call-graph capture of the Midway player included load-time
  garbage collections, so it gave the V8 GC prologue 4.9% of samples. Inside the pose windows there was one GC per
  34 frames. `TN_PLAYTEST_CPU_PROFILE_DIR` now records only the existing ACK-controlled 1,000-frame pose windows;
  sampled windows and runs are excluded from benchmark qualification.
- **Bound symbol decoding too.** On the native monolith, full inline expansion left `addr2line` at 99% CPU.
  `perf report --no-inline` decoded all three recordings in under one second each. Set `DEBUGINFOD_URLS=` for
  local-only decoding; use `TN_V8_FLAGS=--perf-basic-prof` before launch when JIT names are needed, and preserve
  that player's `/tmp/perf-<pid>.map`. Unresolved anonymous samples are not proven JavaScript.
- **Instructions per frame are the low-noise metric on a loaded host.** Milliseconds and cycles moved by 13 to 17%
  when only the host load changed (load 18 to 11) on 2026-10-14. Alternate off and on runs, and judge with at least
  two pairs.
- **Retired instructions undercount memory-bound work.** Record cycles or thread CPU time beside them. When the two
  disagree, the change moved memory traffic, not computation.
- **Serialize timed runs with one lock.** An "idle for 40 s" `pgrep` check starved queued runs for 50 minutes,
  because `pgrep -f` matches shells whose command text only contains the script name.
- **A capture timeout is not a game result.** The shared capture queue races for admission and is not FIFO; its default 120 s wait can expire behind a healthy four-minute playtest. Doctor passed after `visible-resume-base-1` exited 75 with zero windows. Existing `CAPTURE_LOCK_TIMEOUT_MS=900000` permits a bounded 15-minute wait; preserve failed attempts and do not retry again on the same queue-timeout cause.
- **Ratio levers live in the engine.** A fix in code that both arms run (for example `@threenative/core`) lowers the
  absolute cost but does not move the native or web Wasm ratio against three.js.

## Levers

### 2026-10-21 — GI bake rays go through one flat world-space triangle BVH — KEEP
- Where: Unreal-look harness (game layer), `scripts/unreal-look/scaffold/render/bakeRays.ts` and `giCache.ts`, commit `c02b5ce7b` on `lane/perf`.
- Result: exterior L9 bake in the browser 248.8 / 231.6 s → 17.9 / 11.8 s on the same page; trace phase 221 s → 14 s. Node, 13,182 triangles: `ScenePicker` with the old `weightsAt` 33.3 s, stock `Raycaster` 24.5 s, `bakeRays` 12.4 s, `bakeRays` with the allocation-free `weightsAt` about 5 s. Spec `unreal-look-bake-rays.spec.ts` pins hits against the stock raycaster.
- Cause: the bake cast its rays through the game's `ctx.raycast`, which tests meshes one by one per ray. The bake was 87 to 92% of L9 startup (PRD-636), so the trace phase dominated.
- Insight: after the BVH the probe-weight lookup (`weightsAt`) was the next cost: removing its per-call allocations cut the Node bake from 12.4 s to about 5 s.

### 2026-10-21 — The flat bake rays expand instanced meshes instead of falling back to `ctx.raycast` — KEEP
- Where: `scaffold/render/bakeRays.ts` (`instanceFrame`, `MAX_TRIANGLES`), spec `unreal-look-bake-rays.spec.ts` (red against the previous file, green now).
- Result: cornell L7 in the browser, same page: bake 125.3 s in one 116 s task (trace 98.8 s, stock rays) → 16.2 s (trace 13.7 s) and a preview 13 s after load on a software adapter. The preview and the final cache now come in slices; before, the page stayed blank for the whole bake.
- Cause: the asset cook merges equal meshes into `EXT_mesh_gpu_instancing` (cornell: `instance 1 batch(es) / 2 instance(s)`), the engine loads an `InstancedMesh`, and `bakeRays` refused every instanced mesh. A refusal also switches the progressive bake off, because slicing needs the flat rays. The refusal was silent; `TN_GI_STOCK_RAYS` now names the reason.
- Insight: a fallback that is 8 times slower and turns off the other lever must say so on the console. The scene that exposed it was a 96-triangle box, not a heavy one.

### 2026-10-21 — The GI bake runs in slices after the first frame (progressive) — KEEP
- Where: `giCache.ts` (`progressive` option, `pass: "pending" | "preview" | "final"`), `Reference.ts.in`, commits `5c36185a0`, `bf0595eb5`.
- Result: sunlit-room L6, Playwright Chromium on NVIDIA, host load about 3.5: first frame 9.1 s against 16.0 s one-shot, longest task after the first frame 77 ms against 12.4 s, converged field at 31 s against 13.4 s. The settled frames match the one-shot frames with a pixel diff of exactly 0. Visual judge NEUTRAL.
- Cause: the one-shot bake was one synchronous job inside the scene `enter`, so the page showed nothing for the whole bake.
- Insight: a convergence time that is longer than the one-shot time is the price of a responsive page. Report both numbers and the first-frame time together.

### 2026-10-21 — Bake slices are paced by `setTimeout`, not by `requestAnimationFrame` — KEEP
- Where: `giCache.ts` (`defer`, a slice of `budgetMs` and an idle gap of equal length), commit `df03ca89b`.
- Result: the owner's Brave 153 on `:0` showed rAF at about 1.1 per second although the main thread was idle and the GPU was at 13%. With one slice per frame the preview took 89 s. With the clock pacing the preview lands 4 s after load and the bake converges in 36 to 50 s (cornell L7 and sunlit-room L6).
- Cause: the compositor throttles an off-screen or occluded window, so presented frames are not a clock. Xvfb runs at about 10 fps and hid the fault.
- Insight: pace background work by the clock and check it in the browser the owner uses, not only in the harness browser.

### 2026-10-21 — Bake slices run on the next host task, not after an idle gap — KEEP
- Where: `giCache.ts` (`hostDefer`, `progressive.gapMs`, `previewRays` 32), commit `68f8b893f`. URL knobs on the Reference page: `giGapMs` (0 by default, 8 gives the old pacing) and `giPreviewRays`.
- Result: sunlit-room L6, Xvfb, NVIDIA RTX 2080, host load 22 to 28: world visible at 6.2 s and converged at 6.3 s, against 12.1 s and 19.2 s with the old 8 ms gap and 16 preview rays. The longest slice was 50 ms.
- Cause: the equal idle gap halved the duty cycle of the bake. A message posted on a `MessageChannel` runs on the next host task, and Chrome draws a pending frame and handles input before it, so the page stays responsive without the gap.
- Insight: pace background work by what the host leaves free. A fixed duty cycle wastes half of it.

### 2026-10-21 — The bake reads each material's `side` once per mesh, not once per triangle — KEEP
- Where: `scaffold/render/bakeRays.ts` (`sideOfTriangle`), commit `43cda1d2e`. Spec `unreal-look-bake-rays.spec.ts`, case "makes no call into the scene's materials while it casts rays" (3317 reads before, 0 now).
- Result: the cache is bit-identical in Node (values hash 1524492911 at 0 bounces, 410990920 at 5). In the browser, a Chrome CPU profile of the one-shot bake of the sunlit room (L6, Xvfb, owned Wasm engine) put 8.6 s of the 10.6 s of `raycast` into `material.side` reads. After the change the bake took about 2 s.
- Cause: on the owned engine every field read of a material, a vector or an object is a call into the engine. The ray test read `material.side` for each candidate triangle.
- Insight: a Node profile of the same code showed none of this, because a property read in Node costs nothing. Profile a browser page on the owned engine before you choose a lever, and count the calls into the engine as well as the instructions.

### 2026-10-21 — The bake's inner loops use scalars: 0.6 times the instructions — KEEP
- Where: `bakeRays.ts` (`raycast`), `giCache.ts` (`trace`, `gather`, `readField`, `weightsAt`), commit `383164719`.
- Result: user-space instructions of one Node bake of the sunlit room (1,026,116 rays, 3 runs): L6 32.5 G → 18.9 G, L9 (5 bounces) 53.6 G → 32.7 G. The ray test alone: 2.9 → 1.1 µs per ray. The cache is bit-identical: the values hash, the sky hash and the ray, solid and shadow-ray counts match.
- Cause: array literals, destructuring and per-call temporaries in the hot loops, and a sky radiance that was read again for every probe.
- Insight: compare a Node bake by instruction count (`perf stat`), not by seconds. On a loaded host the wall time of one build moved by 30% between runs.

### 2026-10-21 — The trace casts its rays from plain numbers and reads each mesh once — KEEP
- Where: `bakeRays.ts` (`cast`, `IFlatHit`), `giCache.ts` (`IHitRecord`, `trace`), commit `574c21756`. Spec `unreal-look-gi-trace.spec.ts` (0 casts on the old trace, more than 10,000 now).
- Result: sunlit room L9 in the browser (Xvfb, RTX 2080), the tree before the commit against the tree with it, run back to back: trace phase 8748 → 4345 ms and 5819 → 2884 ms (0.50× in both pairs), whole bake 11,970 → 8721 ms and 8421 → 4363 ms. The host load was 45 to 83, so the whole-bake ratio (0.73×, 0.52×) is noisy and the trace ratio is the steady figure. The cache is bit-identical in Node: values hash 1524492911 at 0 bounces and 410990920 at 5.
- Cause: the trace made about twenty calls into the engine per ray: it set the direction vector, read the origin back, wrote the point, the normal and the UV into three vectors, read them again, then read the hit object's id and matrix several times.
- Insight: after the `side` snapshot the remaining cost was the calls, not the arithmetic. Return numbers from a hot query and give the caller one record per mesh.

### 2026-10-22 — The provisional bake takes the full bake's bounces — KEEP
- Where: `giCache.ts` (`progressive.previewBounces`, default the full bake's), `Reference.ts.in` (`giPreviewBounces`), spec `unreal-look-gi-progressive.spec.ts`, case "takes the full bake's bounces for the provisional bake" (red with two bounces: 0.2074 against a bound of 0.1556).
- Result: Node, sunlit room, 5 bounces, 32 rays, mean over texels of |preview - full| / full: 0.207 with two bounces (16% too dark), 0.157 with three, 0.124 with five. The global L1 error (0.077 with two, 0.070 with five) hid this: the lit floor carries the sum, the dim walls carry little. The judge read the two-bounce frame at 15 s as blotchy (REGRESSION).
- Cause: the entry below chose two bounces on the global L1 error. The metric was dominated by bright texels, and the eye reads the dim ones.
- Insight: judge a first estimate with an error that counts every texel alike. More rays (64 at three bounces: 0.130) and more smoothing passes (12 passes: 0.138) gain less than the missing bounces.

### 2026-10-21 — The provisional bake takes two bounces — REPLACED by the entry above
- Where: `giCache.ts` (`progressive.previewBounces`, default 2), `Reference.ts.in` (`giPreviewBounces`), spec `unreal-look-gi-progressive.spec.ts`, case "takes two bounces for the provisional bake" (red with one bounce: 0.1508 against a bound of 0.1056).
- Result: Node, sunlit room, 5 bounces, 32 rays, relative L1 error against the full cache: 0.151 with one bounce, 0.077 with two, 0.070 with three or five. The second bounce costs about 150 ms in the browser (the gather of all five bounces is 752 ms).
- Cause: one bounce leaves out the warm light a lit floor throws on the walls. The first L9 frame showed dark blue patches on the walls for the seconds before the full bake landed.
- Insight: after the second bounce the error that stays is the noise of the 32 rays, and more bounces do not remove it.

### 2026-10-21 — A larger bake slice does not shorten the convergence — REJECT
- Where: `giCache.ts` (`progressive.budgetMs`, URL knob `giBudgetMs`), sunlit room L9, Xvfb, RTX 2080, host load 25 to 35, arms run back to back (`b8`, `b16`, `b24`, `b32` against the one-shot arm), three rounds in rotating order.
- Result: the bake's share of the main thread rose with the slice (38%, 55%, 56%, 64% from the frame interval) and the frame rate over the first 60 frames fell (about 47, 34, 23 and 20 fps). The time to the converged cache moved by less than the run-to-run noise: converged over the one-shot arm's ready time was 1.20 and 1.52 (8 ms), 0.81, 1.46 and 1.68 (16 ms), 1.07 and 1.53 (24 ms), 1.37, 1.42 and 1.19 (32 ms). Two arms of round 3 ran at load 94 to 108 and do not count.
- Cause: the frames the page draws while it bakes take about 9 to 13 ms of main-thread time each at L9. A longer slice leaves fewer frames, not a faster bake, and a loaded host moves the time by more than the slice does.
- Insight: the progressive path cannot converge in the one-shot arm's time at 60 fps. Its gain is the world on screen 1.5 to 4 s before the one-shot arm, and no task over about 50 ms. Keep the slice at 8 ms.

### 2026-10-21 — Cloud noise textures: hoisted lattice weights, no `Math.min` — KEEP
- Where: `scaffold/render/clouds.ts` (`lattice1d`, `valueNoise`, `worleyInverted`), commit `248a1b991`.
- Result: Node, 4 seeds, loaded host: 1483 / 1280 / 1350 / 1298 ms → 672 / 566 / 594 / 562 ms (2.3×). Output is bit-identical: the spec `unreal-look-cloud-textures.spec.ts` pins the sha256 of the seed-631 textures and passed before and after.
- Cause: the per-texel wrap and weight work ran once per axis per neighbour.

### 2026-10-21 — Native standard program refused the `envMap` slot — FIX (engine)
- Where: `packages/runtime-native/src/engine/renderer/render_database.cpp`, commit `a47d9acf3`, native test `env_map_slot_is_read` (red before, green after).
- Result: L8 and L9 pages no longer lose the renderer (`TN_NATIVE_MATERIAL_UNSPECIFIED envMap is not read`, then `TN_WASM_RENDERER_LOST`).
- Cause: the refusal loop skipped `map` and `normalMap` only, but the reflection capture sets `envMap` on metal materials.

### 2026-10-15 — Game thread pinned to the CPPC top-ranked core — REJECT
- Where: PRD-610 AC-20, commit `6878c53ff` (superseded by `61c7c1d06` and `c4be636dc`, same `ThreadPlacement` in `player/run.cpp`).
- Result: `q-place-auto-1` 10.65 / 11.07 / 15.56 ms against `q-place-off-1` 8.67 / 9.26 / 10.98 ms (IPC 0.46); load 12 to 16.
- Cause: preferred-core scheduling packs every busy task onto the top-ranked cores first; a foreign Chrome renderer ran on CPU 3 at 82%, and a pinned thread cannot leave. Pick the last-ranked core, or give the game thread a whole L3 domain so it can move.
- Artifact: `~/.cache/tmp-tn/screens/q-place-{auto,off}-1/`; campaign experiment E1.

### 2026-10-15 — Game thread pinned to the CPPC last-ranked core pair — INCONCLUSIVE
- Where: PRD-610 AC-20, commit `61c7c1d06`; placement is always on and needs no setting (commit `72b606bb2`).
- Ceiling: the external-pinning diagnostic moved main-thread CPU 7.22 / 9.41 / 9.77 → 6.11 / 6.64 / 7.74 ms at identical instructions.
- Result: series 1, 3 pairs: median -21 / -33 / -32%, 8 of 9 pose-pairs faster, but one baseline at load 10.7 set margins of 130 / 105 / 35%. Series 2 (load-gated): 2 valid pairs, both faster at every pose (-24 / -5 / -11% and -38 / -34 / -11%), instructions identical, all pass; the third candidate run ended at load 32.7 and then 11.7, and baseline spread set margins of 14 / 29 / 33%.
- Cause: the direction is consistent, but other lanes on this shared host move the baseline by 10-30%, more than the gain at two poses.
- Insight: a placement lever needs a quiet host (other lanes paused) or the real-display lane to qualify; more pairs on a loaded host do not converge.
- Artifact: `~/.cache/tmp-tn/screens/q-place-off-*`, `q-last-auto-*`, `q-e2s2-*`; campaign `artifacts/native-performance-loop/prd610-placement-20261015/`; dashboard cycle `native-main-core-placement`.

### 2026-10-15 — Game thread on a whole L3 domain (CCD split) — REJECT
- Where: PRD-610 AC-20, commit `c4be636dc` (`ThreadPlacement`, auto takes the last-ranked core's `cache/index3` domain).
- Result: `q-l3-off-1/2` 7.81-7.92 / 8.39-8.46 / 10.01-10.08 ms (baseline within 1%); `q-l3-auto-1r` 9.58 / 8.01 / 8.39 ms: takeoff +23%, cockpit -5%, rear gunner -16%. Two more candidate runs ended above load 8 and were excluded.
- Cause: a 12-CPU domain lets the scheduler put the game thread on a CPU that other lanes' work also uses, so the gain depends on what else runs on that CCD. A pinned core pair (E2) is the shape to test.
- Artifact: `~/.cache/tmp-tn/screens/q-l3-*`; campaign experiment E3.

### 2026-10-15 — `__GL_YIELD=USLEEP` to stop the NVIDIA present spin — REJECT
- Where: PRD-610 AC-20, environment variable only.
- Result: `q-yield-rt0-1` 8.37 / 8.95 / 11.98 ms, IPC 0.58 to 0.61, process-tree CPU not lower; one run, second cancelled.
- Cause: the variable does not change the Vulkan present wait on this driver (615.78.08). Move the spinning thread away from the game thread instead.

### 2026-10-15 — Vector3.x V8 Fast API wrapper — REJECT readiness
- Where: PRD-610 AC-20; exact retained V8 13.1.201.22. CFunction requires kThrow while the public scalar setter is constructible; preserve that observable contract.
- Result: constructible JS-wrapper compatibility checks pass, but the required optimized numeric window remains fast0/slow1 after a distinct constant-arity/captured-intrinsic retry. An optimized invalid-handle check reaches CFunction and preserves its exception, which is insufficient proof of normal dispatch. No timed acquisition or runtime improvement claimed.
- Insight: API eligibility and one reachable fast error path do not establish a useful property-assignment fast path. Stop at failed dispatch proof; do not change constructor/validation semantics or keep widening the wrapper. Visible JS function source was an explicitly accepted reflection difference.
- Artifact: exact failed patch `/tmp/prd610-fast-wrapper-constant-trial.patch`, logs `/tmp/prd610-fast-wrapper-*`. Adapter prototype restored; retained constructor characterization and restored focused check PASS 1/1. No integration, CPU/FPS/parity claim; AC-20 remains open.

### 2026-10-15 — Object3D compose cache — REJECT / NO-GO
- Where: PRD-610 AC-20, trial `1766f64ac`; preserve source/results on local `perf/prd610-compose-trial` before cache-only restoration.
- Result: one exploratory pair; instructions −0.13/−0.36/−0.51%, insufficient for +240 bytes/node (440 → 680, +54.5%). CPU is INCONCLUSIVE because all baseline window loads exceed the predeclared ≤12 guard; raw CPU changes are not attributed savings. Full table is in PRD-610. Both PASS 3/3 on RTX 2080, exact 1,000-count windows, identical corresponding tick ranges; dashboard 184.
- Insight: an empty capture queue admission gate never passed (20 observations/19 minutes, no acquisitions). Revised CPU-only quiet admission then joined the existing serializer; both arms passed admission, but baseline load rose inside measurement. Preflight quiet does not guarantee quiet measured windows. Preserve guards and report instructions separately; no second pair or promotion.
- Artifact: `~/.cache/tmp-tn/screens/compose-load-{base,on}-1/`, original PNGs unchanged; matching frozen hashes and nine nonbinary files. No existing compose cycle entry exists, so no duplicate cycle is invented. No CPU causality, qualified parity or visual-judge claim.

### 2026-10-15 — Standard GCC IPO — INCONCLUSIVE
- Where: PRD-610 AC-20; corrected generator/source commit `18839e526`; optional standard CMake IPO, strict FP retained, default dependencies unchanged, SDL non-LTO for objcopy.
- Result: one exploratory pair, instructions −3.85/−3.43/−2.55%; CPU +40.65/+26.22/−8.45%. Both PASS 3/3 on RTX 2080 with exact 1,000-frame/update/render windows; attachment produces a one-tick offset between arms. Full CPU/instruction/cycle/IPC/load table is in PRD-610. Dashboard 182 runs.
- Cause: CPU acceptance fails in two poses; higher candidate host load and changed IPC leave attribution unresolved. Instruction reduction does not establish a qualified CPU improvement. No second pair or integration; IPO remains optional and off by default.
- Insight: KEEP the generator internal-linkage correctness fix independently of IPO timing. Preserve the original failed IPO artifact and startup logs; do not conflate its ODR failure with the corrected trial's performance verdict.
- Artifact: `~/.cache/tmp-tn/screens/ipo-fixed-{base,on}-1/`; `build/tn-engine-ui-ipo/trial-fixed-identity.json`; cycle `native-gcc-ipo` closes INCONCLUSIVE at the final wrapper terminal time.

### 2026-10-15 — Guard redundant opacity writes to avoid native cache invalidation — REJECT (budget)
- Where: PRD-610 AC-20; diagnostic `d8384443f`, `TN_MATERIAL_DIAGNOSTICS=1 TN_RENDER_THREAD=0`. No guard implemented; setters and versions unchanged.
- Result: `perf-opacity-window-1` exits 0, PASS 3/3 assertions on RTX 2080. Each of three HOLD pairs brackets exactly 1,000 host ticks, matching 1,000 frames/updates/renders. Takeoff / cockpit / rear gunner: 94,804 / 100,000 / 100,000 same-value opacity writes, but only 10 / 58 / 12 record misses; record cache-miss-body CPU is 0.0000426 / 0.0001719 / 0.0000579 ms/frame. Graph misses and measured graph CPU are zero; thread timing supported.
- Decision: redundant writes do not establish expensive invalidation. The observed cache-miss bodies are too cheap to budget a useful guard gain. Timers are separate, exclude later materialization, and do not attribute work to opacity; no complete-rebuild-cost or parity claim.
- Artifact: `~/.cache/tmp-tn/screens/perf-opacity-window-1/{run.log,host-load.txt,diagnostic-identity.json}`; dashboard row is diagnostic and excluded, cycle `native-opacity-invalidation` closed reject. Frozen baseline/game/assets preserved; AC-20 remains open.

### 2026-10-15 — Isolated pointer-compressed V8 13.1.201.22 build — REJECT
- Where: PRD-610 AC-20; isolated `player-v8pc`, compression/shared-cage/31-bit-Smi macros, sandbox off, no ThinLTO/PGO. This rejects this build; compiler and configuration differences prevent attributing the result to compression alone.
- Result: baseline → candidate, takeoff / cockpit / rear gunner: CPU 8.897 → 12.210 / 8.194 → 10.747 / 12.242 → 12.875 ms/frame; instructions 20.449 → 20.871 / 22.762 → 23.144 / 29.996 → 30.299 M/frame; IPC 0.577 → 0.420 / 0.704 → 0.529 / 0.607 → 0.575. CPU worsens 37.23 / 31.16 / 5.17%; instructions rise 2.07 / 1.68 / 1.01%.
- Decision: stop after the first pair because every pose worsens CPU and instructions; no second pair needed to reject this candidate. Both runs exit 0, pass 3/3 assertions on RTX 2080, and supply three exact 1,000-frame/update/render windows each. Adapter checks passed 27/27. This is exploratory, with no qualified parity or acceptance claim.
- Artifact: `~/.cache/tmp-tn/screens/v8pc-resume-{base,on}-1/`; auto-published excluded dashboard rows; cycle `native-v8-pointer-compression`. Matching headers/archive and build logs remain under `packages/runtime-native/build/{v8pc-deps,tn-engine-ui-v8pc}`. Default baseline and archive preserved; the optional CMake dependency seam leaves defaults unchanged. Dashboard publication took priority; the cycle ledger records 27.56 minutes (05:38:24–06:05:58 UTC), within the 30-minute target.

### 2026-10-15 — Web binding arena and fixed-arity wrappers — REJECT
- Where: PRD-612 AC-3, candidate `3d08db039` in `perf/prd610-promote`; frozen web game copies.
- Ceiling: the 23–26% engine-JS-glue owner includes all wrappers; this candidate only removes overflow allocation/bookkeeping and generic counter dispatch. Baseline already had a 64 KB arena.
- Result: one exact-window exploratory pair passes four assertions on NVIDIA. Takeoff / cockpit / rear-gunner instructions fall only 0.019 / 0.075 / 0.761%; CPU changes −7.12 / −7.42 / +11.02% with 27-minute separation and load drift. No all-pose CPU win or qualified parity. Network-failed and interrupted attempts are excluded.
- Insight: removing small machinery inside a large owner does not remove that owner. Size the specific crossing class or operation before implementing its replacement; no equivalent retry without a larger measured ceiling.
- Artifact: `~/.cache/tmp-tn/screens/glue-resume-{base-1,on-clean-1}/`; dashboard cycle `web-glue-arena-resume`. Candidate remains unpromoted.

### 2026-10-15 — Exact-window native stack sampling — KEEP (diagnostic)
- Where: PRD-610 AC-15/AC-20, branch `perf/prd610-resume`; existing Linux CPU-window collector and dashboard qualification.
- Ceiling: diagnostic only; removes loading and pose-boundary ambiguity, not game CPU work.
- Result: `perf-rt-exact-off-1` passes runtime assertions and three exact 1,000-update/render windows. Samples: 1,769 / 2,106 / 2,847; zero lost, decoded callchains. `RenderDatabase::project` has 6.10% / 5.41% / 6.06% self cycles. Unresolved shares are 7.11% / 7.96% / 9.25%; no JIT map was enabled. Real sampled run is excluded from CPU qualification, including with a non-`perf-` tag. Focused red/green: eight feature failures, then 179 passing tests; typecheck, build, publint and independent review pass.
- Cause: the recorder has its own FIFO/ACK lifecycle and samples the owned main TID only around the same fixed-step advance as the counters.
- Follow-up: `perf-rt-jit-off-1` enables `TN_V8_FLAGS=--perf-basic-prof`, preserves the owned player map, and passes three assertions plus exact 1,000-frame windows. A self-cycle symbol-prefix split gives engine/host C++ 61.02 / 64.19 / 67.23%, V8 runtime 19.57 / 15.99 / 13.78%, V8 JIT 10.43 / 10.02 / 8.91%, unresolved 1.13 / 1.80 / 1.32% (takeoff / cockpit / rear gunner). The monolith mixes V8 and engine symbols, so these are heuristic owner groups, not independent libraries. Most cycles remain outside V8; compression alone cannot be budgeted as fixing the whole IPC gap.
- Artifact: `~/.cache/tmp-tn/screens/perf-rt-exact-off-1/profiles/`, dashboard cycle `native-exact-window-profile`, and saved source patch in the original handover scratchpad (`exact-window-profile.patch`). No speed winner promoted.

### 2026-10-15 — PRD-613 Stage 1 encode thread, resumed screen — INCONCLUSIVE
- Where: PRD-613, branch `perf/prd610-resume`, candidate `a57423817`; `TN_RENDER_THREAD` remains default off.
- Ceiling: Stage 0 sized encode migration at about 0.2 / 0.6 / 1.0 ms main-thread CPU per frame.
- Result: fresh alternating `rt-resume-off-1` / `rt-resume-on-1`, three exact 1,000-update/render windows, runtime assertions PASS. Takeoff / cockpit / rear gunner CPU: 7.743 / 8.277 / 12.049 ms off versus 9.557 / 11.929 / 14.158 ms on; instructions: 20.482 / 22.748 / 29.980 M off versus 20.060 / 21.095 / 27.036 M on. Host load varied; no qualified CPU win, parity or visual verdict.
- Cause: encode moved off main, but the CPU/instruction disagreement is not yet attributed. Diagnose it before another equivalent timing attempt.
- Insight: relocating work can lower main-thread instructions without lowering its CPU time; instruction-only selection cannot qualify a thread migration against the CPU target.
- Artifact: candidate `a57423817`; raw `~/.cache/tmp-tn/screens/rt-resume-{off,on}-1/` and dashboard cycle `prd613-s1-render-thread-resume`. Current binary/game identities are in the screen host-load records; package provenance remains stale.

### 2026-10-14 — V8 GC prologue `promote()` skips the full wrapper walk while the ownership epoch is unmoved — REJECT
- Where: PRD-610, branch `perf/prd610-promote` (reverted).
- Ceiling: profile share 4.9% of samples. It was wrong (see method lessons).
- Result: second off/on pair flat (takeoff 8.58 / 8.70 ms, cockpit 10.44 / 10.44 ms, rear gunner 11.55 / 10.73 ms);
  instructions unchanged. Counter run: 249 GC prologues in 8,400 frames, 26,447 wrappers.
- Cause: GCs are rare in the pose windows, so the walk costs about 0.04 ms per frame.
- Artifact: patch kept outside the repository by the session; the change is a 20-line edit in
  `packages/runtime-native/src/adapters/v8/adapter.cpp`.

### 2026-10-14 — Crossing path reuses decoded numeric and handle arguments — REJECT
- Where: PRD-610, branch `perf/prd610-crossing` (not committed).
- Ceiling: 613 calls per frame × 60 to 120 ns = 0.04 to 0.07 ms per frame.
- Result: A/B flat on two pairs; adapter ctests 75 of 75 passed on and off.
- Cause: the per-call decode is a small part of a crossing. Remove whole classes of crossings instead.
- Measured on the way: 1,725 crossings per frame on Midway; top names per frame `visible` 315, `count` 152,
  `getY` 120, `getX` 120, `time` 109, `setEffectiveWeight` 104, `material` 98, `getZ` 87, `opacity` 83,
  `getWorldPosition` 58; 34,331 live wrappers.

### 2026-10-14 — `publishUiState` serializes a changed HUD frame once instead of three times — KEEP
- Where: `@threenative/core` (`ui-state.ts`, `ui-bridge.ts`), branch `perf/prd610-promote`, commit b642e5dfb.
- Ceiling: `JSON.stringify` was about 7% of the native main thread in the call-graph profile (the same profile
  that overstated GC, so treat this share as an upper bound).
- Result: red-green spy test 3 calls to 1; 101 UI core specs pass; public surface unchanged. Not timed on Midway.
- Cause: the publisher stringified the store to diff it, again for `lastFrame`, and the bridge stringified the
  message a third time.

### 2026-10-14 — PRD-613 Stage 0: render phase split — KEEP (diagnostic)
- Where: [PRD-613](docs/PRDs/native-engine/PRD-613-native-render-thread.md), commit 4abe3d020.
- Result (loaded host, shares only): the ocean reflection pass is about half the render wall at cockpit and rear
  gunner (0.85 / 2.67 / 4.32 ms); its encode costs about 2 ms for 8 items at cockpit, a per-pass fixed cost.
- Cause: one reflection pass per frame re-runs prepare and encode for its own camera.

### 2026-10-14 — Web Wasm owner profile — KEEP (diagnostic)
- Where: [PRD-612](docs/PRDs/native-engine/PRD-612-web-wasm-engine-beats-threejs-on-midway.md).
- Result: on the browser main thread, Wasm engine code 44 to 48%, engine JS glue 23 to 26%, game JS 12 to 15%,
  V8 `(program)` 8%, WebGPU natives 7 to 8%. Animation, the matrix walk and `RenderDatabase::project` are the same
  top owners as on native.

### 2026-10-15 — Visible setter preserves material cache — INCONCLUSIVE
- Where: PRD-612, candidate `8c5f5ff4d`; result `0b4b321ba`.
- Result: instructions decrease in both pairs at all poses; CPU fails every-candidate-below-every-baseline. Four PASS reports with exact windows; dashboard 179 runs.
- Insight: capture serialization does not establish low CPU load. Higher load and lower IPC confound pair 2 CPU attribution; no causal explanation or qualified win. No third retry or integration.
- Artifact: `screens/visible-queue-{base,on}-{1,2}/`; recovery cycle terminal 2026-10-15T06:49:37.800Z.
