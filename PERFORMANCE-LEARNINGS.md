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
- **On the web Wasm engine, count crossings by class first.** Each bridge get costs ~0.8 µs and a `children` read
  re-wraps every child, so code that is free in plain three.js is slow here. Removing a whole class of crossings
  pays (2026-10-27 bridge cache below); making each crossing cheaper does not (2026-10-14, 2026-10-15 rejects).
  `TN_BRIDGE_WARNING` names the property and the caller.
- **The frame meter must count drawn frames.** Until 2026-10-27 `presented` and `fps` counted rAF ticks; the web
  engine declines a draw while two frames are on the GPU, so 2-63 lost frames per 5 s read as 60 fps.
  `drawnFps`/`drawn` now sit beside them. Read them, and record `nvidia-smi pmon` beside each reading: the skips
  followed another process's GPU load, not engine cost.
- **A 60 Hz panel caps what you can see.** Measure frame cost uncapped (`--disable-gpu-vsync
  --disable-frame-rate-limit`, headed, real GPU) when the target is above the panel rate. On a desktop at load 25-40,
  paired A/B moved to the laptop's Iris Xe; the NVIDIA reading is still owed for those levers.

## 2026-10-27 shooter campaign (PR #574, worker mode, web Wasm engine)

Baseline from the owner's trace: worker rAF interval p50 22.3 / p95 33.6 ms, 81% of frames over 17.5 ms, GPU 3-4 ms.
All levers are engine-layer, each with a spec that fails before the fix. Paired A/B from one code state.

| Lever | Commit | Result | Verdict |
| --- | --- | --- | --- |
| AutoBatch counts graph events, not `scene.children` per frame (was 41% of the worker) | `90856171d` | interval p50 22.2 → 16.67 ms, p95 29.9 → 16.9 ms | KEEP |
| Batch `decide` skips hidden subtrees (8,300 hidden sources) | `73ffa779a` | 25 ms spike every 60 frames removed, p99 37 → 20-24 ms | KEEP |
| 5 s projection line stops walking the scene | `9e38c0edf` | that frame 13-16 → under 3 ms | KEEP |
| Native matrix walk: a hidden node defers its own compose | `60846cdbb` | scene update mean 2.40 → 0.43 ms | KEEP |
| Kit backlight reads its controls once per render (12 kits) | `b430a9756` | 0.93 → 0.48 ms; the bridge cache now covers this class | KEEP |
| Camera cull keeps its rig map while the hierarchy holds still | `4fb0c6f26` | cull 2.47-2.69 → 1.85-1.92 ms (laptop, uncapped) | KEEP |
| Bridge cache: `children`/`parent` and JS-only properties read from JS; meter; lint | `b088dc46f` | crossings 3,190 → 1,810, p50 9.95 → 8.9 ms, p95 19.55 → 13.45 ms | KEEP |
| Rapier: a fixed or sleeping body's pose is read once, not every step; forces cleared only on dynamic bodies (same change as bughunt 05, `f683c14ca`) | `8501273d2` | Rapier calls 2,260 → 240 a step (the 144 walls were 95%); `readVisibleTransforms` 93 → 8 µs (node); worker physics update 455/459/448 → 366/389/362 µs a step (laptop Iris Xe, uncapped, load 2, 3 pairs); frame p50 and drawn fps inside noise (GPU-bound at 30-35 fps) | KEEP |
| `kMaxFramesOnGpu` 2 → 3 | not built | absorbs ~40 ms GPU stalls at +1 frame of latency; stalls come from outside the engine | REJECT |

Rapier export names lie: wasm-bindgen folds identical getters into one export, so `rawintegrationparameters_dt`,
`rawkinematiccharactercontroller_offset` and `rawcollidershapecasthit_time_of_impact` (about 320 a step each) were
`RawVector`/`RawRotation` `x`/`y`/`z` reads from `translation()`/`rotation()`. Resolve an export to its JS caller in
`rapier_wasm3d.js` before naming a class. Left after the Rapier fix and closed below the 0.3 ms bar: character pose
replay (about 66 calls, 7 µs a step) and the shooter enemies' per-step `teleport` of a hit-proxy `CharacterBody3D`
(5 zero-motion controller moves, about 35 µs a step). Ceiling: the laptop split after the fix is character
controller 76-188 µs, `world.step` 77-99 µs and JS glue about 150 µs a step, so no physics bucket reaches 0.3 ms a
frame at one step a frame.

Not causes, ruled out by counts: readback staging buffers (steady while skips swing), pipeline or shader creation
(zero after the first frames), heap growth (floor 76.9 MB across 13 major GCs). Wasm threads were off (no `-pthread`,
no COOP/COEP); that lane is open.

## Levers

### 2026-10-27 — Recorded passes survive a camera turn (cached draw rows, indirect counts) — KNOB OFF, owner decision
- Where: `packages/runtime-native/src/engine/renderer/renderer.cpp`, PRD-754 (PRD-573 v3.2), branch
  `lane/perf-stable-passes`, head `7f78a57f4`. Knob: `TN_STABLE_PASSES=0` (native), `?tnStablePasses=0` (web).
- Port: UE 5.8.3 cached mesh draw commands. Opaque draws keep a row each (state-first order, a persistent uniform slot
  per draw), out-of-view rows stay with 0 instances through `drawIndexedIndirect`, and the shadow, normal and velocity
  passes replay bundles keyed like the main pass.
- Ceiling: recording plus shadow encode, 0.33 ms a frame on Midway native and 0.85-1.16 ms on the shooter web turn.
- Result (3 pairs, knob off then on): Midway native 0.164/0.165/0.212 → 0.044/0.061/0.094 ms (63%), order rebuilds
  about 630 → 0; shooter web turn 0.721/0.387/0.440 → 0.243/0.163/0.228 ms (59%), order rebuilds 80-100 → 0.
  `--gpu-calls` 184 → 46 WebGPU calls a frame. Judge NEUTRAL. The PRD gate asks an 80% fall, so it is Deferred.
- 2026-10-28, head `a9caf82d3`: a draw seen for the first time records alone in a delta bundle per pass, after the
  sorted rows, and an unchanged per-draw key skips the row checks. Midway 0.137 → 0.031 ms (77%), shooter web turn
  0.317 → 0.144 ms (55%), frame p50/p95 no worse, judge NEUTRAL again. Midway's remainder is mostly cost both arms
  pay (shadow pass setup 0.017 ms, transparent re-sorts); the web remainder is a pass that still records about 119
  draws on a third of the turn frames.
- 2026-10-28, head `c58d8f16f`: that pass was the velocity pass's transparent responsive marks (a batch's material
  pointer moves every frame); they now record their own tail (web 78%, Midway 75%). A slot asked for after the frame's
  appended blocks overwrote a transparent draw's block for one frame under TRAA; fixed. Then a third judge read
  REGRESSION: the state order swaps exactly coplanar draws (the shooter's door trim), and the first two judges missed
  it. Depth-ordered rows keep the pixels but record 105 rows a camera lap against 57 direct. The knob is off by default.
- Insight: "order is free under the depth test" is false at exactly equal depth. Before porting UE's state order,
  diff BEFORE/AFTER per pixel against all BEFORE runs (pixels where every AFTER differs from every BEFORE), not by eye.
- Rejected inside the lever: keeping transparent draws as rows. Their depth order moves every turn, and the row
  bookkeeping cost what the recording saved (native shooter 0.151 against 0.153 ms). They now record their own
  bundle keyed as direct encode keys them (native shooter 0.115 against 0.142 ms).
- Insight: a retained-row cache pays only where rows hold still. Count the share of draws whose order the camera can
  move (transparent, depth-sorted) before porting a cache: for those, recording again is the cheaper path.
- Left: the shooter's render database alternates its transparent batches between batched and unbatched frames, which
  re-records the tail and adds first-seen rows (PRD-753). Frame p50/p95 needs quiet-host pairs.

### 2026-10-27 — Web engine bridge: keep what game code reads again (three-native back end) — KEEP
- Where: `packages/three-native/src/browser-backend.ts`, PRD-748; commits `b088dc46f` (round 1) and the round-3 commit beside this entry.
- Ceiling: the shooter census read 2,054 crossings per idle frame, at about 0.8 µs each; the top classes were
  JS-written or mixer-written properties read again (light intensity 454, colour 227, `matrixAutoUpdate` 205,
  `parent`/`renderOrder` 102), `AnimationAction.isScheduled` 171, `Layers.test` 51 and geometry bounds 70.
- Round 1 (property mirror, `children`/`parent`/walk kept until `Object3D::hierarchyVersion` moves, JS `Layers.test`):
  idle census 2,022 → 661 crossings per frame; shooter route, 3 pairs, load 10-18: 3,249/3,092/3,241 → 1,557/2,228/1,641
  crossings per frame, worker update+render mean 11.03/9.71/10.37 → 9.16/7.79/8.85 ms.
- Round 3 (an action's schedule kept until its own play/stop or a mixer-wide call; transform-only Object3D methods keep
  the mirror; a mirrored setter drops only its own property and skips a write of the value held; a present geometry
  bound kept): route crossings 3,168/3,448/3,645 → 797/846/1,024 per frame (shooter), 1,443/1,673/1,839 → 997/1,134/1,030
  (adventure). Frame time in that batch is inconclusive: load 15-26, pairs split 1:2 and 1:2.
- Ceiling reached: a quiet shooter frame now makes about 190 crossings, all engine writes (opacity, intensity, lookAt,
  the post chain's quad material and render-target size), world-matrix queries the engine owns (`getWorldPosition`,
  `updateWorldMatrix`), the mixer's per-step calls, and core's camera cull math on engine Ray/Frustum objects
  (`intersectsSphere` 70, attribute `version` 35, render-camera-cull.ts). The two last levers measured (schedule table,
  clipAction exemption) took 825 and 340 crossings; the next candidates are each under 40 per frame.
- Knob: `__THREENATIVE_BRIDGE_CACHE__ = false` turns the whole cache off for a paired A/B in one code state.

### 2026-10-27 — A scratch object's death leaves the hierarchy counter alone (native engine) — KEEP
- Where: `runtime-native/src/engine/scene/object3d.cpp` `Object3D::~Object3D`, PRD-748.
- Cause: the destructor moved `hierarchyVersion` on every destruction, and `InstancedMesh::raycast` builds a stack
  `Mesh` per call. Each ray at an InstancedMesh dropped every cache keyed on the counter: the bridge's `children`
  cache, render_database's shadow lights and batch decision, projected_cull's node list. Adventure's camera arm casts
  at its `lens` instanced meshes each tick: one counted-tick census frame made 136,264 crossings (27,540 each of
  `children`, `updateMatrixWorld`, `intersectObject`).
- Result: only a linked object's death (a parent or children) moves the counter. `native_engine_scene_unlinked_destruction`
  red on the old destructor (2 CHECKs), green after; ctest -L native-engine 215/215. Adventure engine-cost probe,
  SwiftShader, one drawn frame per tick, moving windows: redundant reads 112 -> 6 per frame, crossings 746/938 ->
  503/665 per frame. Web Wasm 4,146,125 bytes.
- Insight: a global "anything changed" counter is only as good as its rarest bump. Next: core's ScenePicker still
  crosses twice per target object per ray (`updateMatrixWorld`, `intersectObject`, 108 each a frame on adventure); one
  engine call for the target set would remove that class.

### 2026-10-27 — Interned engine refs per slot index (`keyOf`) — REJECT
- Where: `createWasmRuntime` `keyOf`, three-native; candidate not committed.
- Result: real Wasm microbench, a `parent` read with the cache off, 4/4 alternating pairs faster: 946/918/1,293/987 →
  883/737/1,042/778 ns (load 25-33).
- Cause: after the bridge cache, a quiet shooter frame makes only tens of handle-returning crossings, so the ceiling is
  a few microseconds a frame. A per-call speedup inside a crossing does not remove the crossing (see the 2026-10-14 decode
  reuse entry). Revisit only with a measured class of handle reads that the cache cannot keep.

### 2026-10-27 — Batching holds a projecting decision; render thread on by default — KEEP
- Where: [PRD-613](docs/PRDs/done/PRD-613-native-render-thread.md), `RenderDatabase::batch`, `player/run.cpp`.
- Result (Midway desktop, matched CPU, 3 alternating pairs): main-thread CPU per frame falls 3.4 to 7.5 ms per
  pose; instructions per frame 40-48 M to 29-34 M; parity PASS; visual judge NEUTRAL.
- Cause: a projecting projection decision was judged again every frame (scene walk, content classes, group maps)
  only to read the rigs' verdicts, about 11% of main-thread samples. The render thread alone moves about 0.6 ms of
  encode, inside run-to-run noise in CPU ms; the instruction count shows it in every run.

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
- Where: [PRD-613](docs/PRDs/done/PRD-613-native-render-thread.md), commit 4abe3d020.
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
