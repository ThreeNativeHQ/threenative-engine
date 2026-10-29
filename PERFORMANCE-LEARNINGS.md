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
- **A traced bucket of many tiny JS calls is a rank, not a size.** On 2026-10-27 the trace gave bridge glue 3.6-4.2 ms a
  frame; counting every wrapper entry gave about 0.4-0.5 ms. Count the calls and price them on a bench before you size
  a glue lever from a trace.
- **A named `memcmp` in a Wasm profile is a variable-length compare.** clang inlines constant-size compares (the
  128-byte matrix checks), so the `memcmp` function the profiler names holds string and name compares. On the shooter
  it was uniform names in `putNodes`, not buffers. Attribute its samples to callers before you guess the data.
- **Per-step physics cost moves with host load; read substeps first.** The same shooter step cost 108-184 µs on the
  quiet laptop and 330-910 µs on the desktop at load 17-57, and the fixed-step catch-up ran 1.26-2.71 substeps a frame
  there against 1.00-1.05. A physics bucket that grows only on a loaded host is the host.
- **A thread-pool lever needs tests that hold without threads.** CI also runs the native-engine suite as
  single-thread Wasm under node (`emcmake ... -DTN_ENGINE_CORE_ONLY=ON`, target `tn-native-engine-core-tests`). There
  `JobPool(3)` has 0 workers, no walk shares out, and `std::thread` aborts. Gate the pool's checks on the build
  (`__EMSCRIPTEN_PTHREADS__`) and run that build before you push.

- **On Xvfb, the drawn fps of a web WebGPU game is the virtual display, not the engine.** The RTS kit looped at
  75 fps and drew 10-12 on Xvfb, and the same build drew 70-93 on the real display `:0` (2026-10-28). Take
  drawn fps and presentation from a real display only. On `:0` the drawn fps also follows other GPU users: with
  another job at 100 % GPU it swung from 25 to 95 between consecutive runs of one arm, so read
  `nvidia-smi` before you compare drawn fps across arms, and compare main-thread time instead.
- **Find React dev cost in the trace by component, then count why it renders.** A HUD that reads the whole
  published state re-renders at the publish rate, not the rate of what it shows. `useUiState(selector)` compares
  the result by identity, so a selector that builds a new object or array renders as often as no selector.

## 2026-10-29 Stress lab (web Wasm engine, Chrome DevTools MCP, RTX 2080)

The sandbox scene `sandbox/stress-lab` (`?stress`, real preset) holds houses, a forest, a skinned crowd, physics
bodies, fires and a virtual shadow map at the same time. Every row is in `docs/stress-loop/ledger.json` and on the
`pnpm dashboard` Stress lab tab. FPS went 1.36 -> 8.27 (six-window medians); the goal is 120.

### 2026-10-29 — Virtual-shadow casters batch in the main pass — KEEP
- Where: `packages/runtime-native/src/engine/renderer/render_database.cpp`; `b4131e881`.
- Result: main draws 2795 -> 1836 at the same FPS (1.36 -> 1.3); visual judge NEUTRAL. A caster's shadow copy stays an
  individual draw, so the per-page shadow cull still sees it.
- Insight: the draw count varied 1803-3168 between windows. A single-window draw claim is invalid; use medians.

### 2026-10-29 — Rig shadow bounds come from bones, not CPU-skinned vertices — KEEP
- Where: `SkinnedMesh::boneReachBounds` (`animation/skinning/skeleton.cpp`), used by the VSM bounds loop in
  `renderer.cpp`; `b95f4c8ef`.
- Result: 1.3 -> 4.8 FPS, GPU p95 125 ms, frame p95 223 ms. The crowd under VSM cost about 760 ms a frame because the
  bounds loop skinned every vertex on the CPU. Now each bone has a reach radius measured once per geometry revision;
  a call costs O(bones). Visual judge NEUTRAL on a close-up of a sunlit walker.
- Insight: UE 5.8.3 fits skinned bounds to bones. A bounds pass that skins vertices costs as much as skinning itself.

### 2026-10-29 — A VSM pan keeps the shadow pages the window still covers — KEEP
- Where: `shadows/virtual/atlas.cpp`, `pages.cpp`; `8401791aa`.
- Result: 4.8 -> 8.27 FPS, frame p95 223 -> 159 ms, GPU p95 125 -> 72 ms, presented p95 533 -> 283 ms. The clipmap
  re-centred at texel precision, so a camera orbit redrew every page of every level each frame. A pan now moves the
  window by whole pages from its last origin (the first placement and a cut keep the exact texel origin, so the GPU
  reference renders still match). Visual judge NEUTRAL; the orbit was frozen at 12 s after a real pan path.
- Insight: a world-grid snap broke the vsm-cut reference render (1.6% pixels). Snap relative to the previous origin
  and only on a pan.

### 2026-10-29 — Method: name web Wasm hot functions with `--profiling-funcs` — KEEP (method)
- A trace of the release Wasm shows `wasm-function[N]`. A symbol map from a relink does not match it, because
  indices move. Relink with `-DCMAKE_EXE_LINKER_FLAGS=--profiling-funcs` and install it; Chrome then names every
  function. Clear the flag and relink afterwards (a clean relink is byte-identical to the release build).
- Trap: any relink that changes the glue (`.mjs`) fails in the sandbox (`ASM_CONSTS[code] is not a function`,
  `reading 'resolveQuerySet'`) until the Vite dev server restarts. Deleting `node_modules/.vite` is not enough: the
  running server keeps the old prebundled glue in memory.
- Trap: removing one system (crowd, bodies or fires) cut `mainPass` from 112 ms to 21-38 ms each, so the costs do not
  add. Bisect with all arms, then profile; do not sum single-system deltas.

## 2026-10-28 RTS kit probe (Chrome DevTools trace, web Wasm engine, real display)

### 2026-10-28 — RTS HUD panels re-render only when a shown value changes — KEEP
- Where: `templates/rts/src/ui/Hud.tsx` (`useUiStateShown`), `Commands.tsx`, `Minimap.tsx` (game layer).
- Ceiling: in an 8.4 s CDP trace while panning, the `ui/react` bucket was 643 ms, 10.1 % of the active main
  thread (`Hud` 203 ms, `Commands` 115 ms inclusive). The game publishes every frame (camera and minimap
  fields), and each panel read the whole snapshot.
- Result: same route, same build: `ui/react` 643 → 68 ms (1.4 %), `Hud` 203 → 8 ms, `Commands` 115 → 4 ms.
  The untraced CDP `TaskDuration` A/B (10 pairs, 3 runs) was lower for NEW in 7 pairs, with mean deltas of
  −34 to −115 ms/s. The host was at load 14-21 with another job at 100 % GPU, so that timing is INCONCLUSIVE.
  The trace attribution is the evidence. RTS template playtests: 8 of 9 scenarios pass, and the kit contract
  passes. `battlefield-performance` failed on GPU p95 (about 31 ms against 16.7 ms, CPU 7-15 ms) in 2 of 2
  runs with the change. A paired A/B of that scenario failed 1 of 2 runs per arm, OLD included (GPU p95
  30.1 ms), while other jobs held the shared GPU at 25-95 %. So the red is GPU contention, not the HUD.
- Cause: a panel subscribed with no selector, so each publish re-rendered all three panels.
- Fix: each panel lists the values it draws, rounded the way it draws them. The hook keeps the previous
  snapshot while that list is unchanged. A field the panel reads but does not list goes stale on screen, so the
  list must name every field the panel reads.

### 2026-10-28 — Native engine draws `material.depthTest = false` over nearer surfaces — KEEP (correctness)
- Where: `runtime-native/src/engine/renderer/` (`renderer.h`, `render_database.cpp`, `renderer.cpp`).
- Symptom: the RTS health bars were cut by buildings and shimmered at their edges. `engine: "threejs"` drew
  them on top, so the engine was the layer.
- Cause: the engine ignored `depthTest`. A bar quad depth-tested against the model under it.
- Result: red-green `depth_test_off_draws_over_nearer`, all 95 `render_database_test` cases pass. In a
  30-frame still stack of the bar box, the max per-pixel std went 19.7 → 4.4. The visual judge (Opus) returned
  IMPROVEMENT on 5 of 5 criteria. `depthTest` is part of the draw key, and order-independent batching now
  requires it.

### 2026-10-28 — `updateRanges` proxy read per geometry upload — REJECT (below the bar)
- Where: `three-native/src/update-ranges.ts`, reached from the RTS `army.sync` uploads.
- Ceiling: about 7 crossings and a JSON parse per upload. After the trace inflation is removed, this is about
  0.03-0.07 ms per frame, under the 0.3 ms bar.
- Revisit when: a game uploads hundreds of ranged attributes per frame.

### 2026-10-28 — Post stages re-run the scene materials' render callbacks — OPEN (sized, not cut)
- Where: `three-native/src/tsl-uniforms.ts` `liveUniforms.sync`, which runs once per `renderer.render()`.
- Ceiling: bloom, auto exposure and local exposure each call `render()` per stage in `updateBefore`. That is
  about 2 ms of the 3.1 ms traced `renderFrame`. `sync` is 419 ms over 997 traced frames, about 0.42 ms per
  frame traced. It runs `onRenderUpdate` callbacks (`backlightMaterial.ts`, `heightFog.ts`, `uniformLanes`)
  for quad passes that do not draw those materials.
- Next: the once-per-frame object re-lane patch (entry below, "HANDED OVER") cuts part of it. Running
  `render` callbacks only for the materials a pass draws needs a per-material owner list. Both need a visual
  judge.

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
| Web renderer converts a number clear colour once, not per pass | `d02647f41` | laptop, 3 pairs: mean 4.96/4.11/4.02 → 4.46/4.05/3.89 ms | KEEP |
| Camera cull tests its frustum and forward ray in plain numbers (no engine Ray/Frustum/Sphere calls) | `66e637840` | laptop, 3 pairs: cull 0.78/0.76/0.76 → 0.66/0.64/0.64 ms | KEEP |
| Camera cull caches each rig part's visible chain | not kept | laptop, 2 valid pairs: cull 0.81/0.79 unchanged; the profile's 0.68 ms `visibleInWorld` was misattribution | REJECT (tie) |
| AutoBatch guard compares in C++, a whole lap a frame | not kept | guard still fills its 0.5 ms budget (0.58-0.65 ms, C++ costs ~70 ns a source in cache misses); staleness 40 → 1-3 frames, mean tie | REJECT (tie) |
| AutoBatch guard compares in C++, one lap per settle window (3 frames) | this row's commit | laptop: guard 0.60-0.62 → 0.18-0.23 ms in 6/6 runs; mean 5 of 6 valid pairs −0.27 to −0.98 ms; staleness 18-75 → 3 frames | KEEP |
| The sun's ordinary shadow map is kept while nothing it draws changed, as lamps were (render lane); its signature hashes each word through a finalizer | this commit | laptop Iris Xe, 3 pairs, load 6.5-9.2, 97-99 °C: GPU 27.2/29.2/28.5 → 25.9/26.0/28.4 ms, drawn fps 32.8/30.2/30.6 → 34.2/32.9/30.3, main pass span 1.93/2.04/1.99 → 1.93/1.87/1.81 ms; shooter shadow draws 46 → 0 per frame, direct WebGPU state calls about 250 → 30, uploads 230 → 196 KB; visual judge NEUTRAL | KEEP |
| Bridge glue per crossing: heap views by identity, word-zeroed scratch, loan lane copy, in-place single set, address on the object | this lane | crossing mean 466 → 340 ns, 4/4 laptop pairs; about 0.04-0.13 ms a frame at 311-1,000 crossings (estimate) | KEEP |
| A node the engine raycasts nothing for (Group, Bone, light, camera) keeps three's empty `raycast` | this lane | platformer crossings 873-894 → 690-707 a frame (`intersectObject` 309 → 131); spec 7 → 0 | KEEP |
| A material uniform resolves by a name hash taken when the stage is laid out, not by a string compare per field per draw (`putNodes`) | `eb4cf11c6` | 12 fields with 2 bound: name compares 12 → 2 (spec); `putNodes` held 56-59% of the frame's `memcmp` samples, so about 0.30-0.35 ms a frame (estimate: profile share x measured `memcmp`); no A/B (laptop at 98 °C) | KEEP (count) |
| The matrix walk shares out on the job pool (`JobPool`, min(threads - 1, 3) workers) when the last walk recomposed 1,024 nodes or more | `ce6386149`, `136617cac` | Wasm microbench, 9,387 nodes all moved: 0.77 → 0.22 ms on 4 threads; 95% hidden: 0.023 ms on one thread vs 0.037 on four, so the gate counts composes, not visits; shooter A/B void (load 26-87) | KEEP (micro) |
| A texture setter moves `version` only on a real change, and the environment preparer waits on no draw for a sky that is baked or baking | `3df32abef`, `c2b1e0298` | the shooter's restart restated `mapping`/`colorSpace`, moved the sky 10 → 14, dropped the kept bake and waited its 15 s budget; debug-restart on SwiftShader 0/3 → 3/3 | KEEP |
| The camera cull answers a shared geometry from the frame's observation before it reads the buffer `version` | `68ccbf696` | `version` reads 3 → 1 per shared geometry per frame (spec); 102+12 of adventure's 127 repeat reads | KEEP (count) |
| Waste counters (6 classes) on the shooter: crossings 457/frame (0.37 ms, an estimate: count x per-call cost), transform visits 9,387/frame (0.31 ms), uniform write attempts 1,360/frame, geometry classification 0.02 ms, GPU allocations 0 | this lane | see `### 2026-10-27 — Wasted work, counted by class` below | DIAGNOSTIC |
| `kMaxFramesOnGpu` 2 → 3 | not built | absorbs ~40 ms GPU stalls at +1 frame of latency; stalls come from outside the engine | REJECT |

Rapier export names lie: wasm-bindgen folds identical getters into one export, so `rawintegrationparameters_dt`,
`rawkinematiccharactercontroller_offset` and `rawcollidershapecasthit_time_of_impact` (about 320 a step each) were
`RawVector`/`RawRotation` `x`/`y`/`z` reads from `translation()`/`rotation()`. Resolve an export to its JS caller in
`rapier_wasm3d.js` before naming a class. Left after the Rapier fix and closed below the 0.3 ms bar: character pose
replay (about 66 calls, 7 µs a step) and the shooter enemies' per-step `teleport` of a hit-proxy `CharacterBody3D`
(5 zero-motion controller moves, about 35 µs a step). Ceiling: the laptop split after the fix is character
controller 76-188 µs, `world.step` 77-99 µs and JS glue about 150 µs a step, so no physics bucket reaches 0.3 ms a
frame at one step a frame.

Renderer classes counted on the shooter (render lane, 2026-10-27; a JS probe on every WebGPU call, desktop, and a
named-Wasm worker profile at load 15-21): 36 passes per frame, 24 of them post targets that core's bloom and local
exposure nodes draw one `render()` each (0.58 ms of engine CPU, 0.45 ms of JS); the sun's 4096² map redrew 46 casters
every frame although 238 of 240 frames left it unchanged (fixed above); uniforms 33 writes, 230 KB, 0.09 ms, and every
draw's slice changes with the view matrix, so a dirty-range upload saves nothing until view-dependent values leave the
per-draw block; render bundles are replayed while the scene holds still and re-recorded while the camera moves
(about 190 draws), 0.05 ms. Not taken, under 0.3 ms: one command encoder for all target renders (about 0.07 ms).
The `putNodes` field scan was taken later as the name hash in the table above. The renderer's whole C++ share is
about 1.7 ms of a 4.9 ms worker frame; the next class is the pass count of the post chain, which the look nodes own.

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

### 2026-10-27 — Bridge glue per crossing: heap views by identity, word-zeroed scratch, loans copied lane by lane — KEEP
- Where: `packages/three-native/src/browser-backend.ts` `createWasmRuntime` and the value loans, PRD-748.
- Census first (lane head, shooter worker, NVIDIA, idle, `profile:wasm-page --calls`): 311 crossings per frame. The
  reads the engines lane named on `327167c20` are gone (`DirectionalLight.intensity` 424, `.color` 212,
  `matrixAutoUpdate` 181, `parent`/`renderOrder` 90 each: none in the top 30; `isScheduled` 127 → 3.9). So what is
  left is the cost inside each crossing, not a class of crossings.
- Sizing (node CPU profile of the real Wasm ABI module, 6 crossing kinds): JS glue 67% of a crossing, Wasm 22%. The
  top JS self time was `view()`/`wordView()` reading two `.buffer`s per use, `alloc`'s `fill` per scratch slot, the
  loan's `read`/`write` lists, and a one-item list per `set`.
- Change: the heap views are made again only when `HEAPU8` is replaced (one identity test); a call's scratch (at most
  64 bytes) is zeroed with word stores; a loan copies its lanes with no list between; `set` writes its one value in
  place; an engine object's address is an own property instead of a WeakMap entry.
- Result: paired A/B on the quiet laptop (load 0.3-1.5, node 20, pinned to one CPU, 4 alternating pairs, 15 rounds of
  20,000 calls each): `updateWorldMatrix` 682-714 → 543-565 ns, `getWorldPosition` 1,585-1,650 → 1,161-1,198,
  `__tnVisibleInWorld` 322-342 → 237-246, attribute `version` 222-239 → 134-144, a material `opacity` write 766-788 →
  564-576; a lane read+write 16-17 → 5-9 ns. Crossing mean 733 → 535 ns (-27%), 4/4 pairs.
- Ceiling: at 311 (idle) to about 1,000 (play) crossings per frame this saves 0.06-0.2 ms per frame, and the glue now
  costs about 0.1-0.4 ms per frame (estimates: count x per-call cost). The DevTools traces that read 6.5 ms of glue run
  with async stack tagging, which inflates JS self time several times; read them as a rank, not a size.
- Rejected on the same bench: a special-step-free method wrapper (-5%, 35 duplicated lines, under 0.02 ms per frame)
  and a ref kept per handle slot in `keyOf` (-17% on methods that return `this`, but about 60 such crossings per
  shooter frame: 5 µs; the entry below says the same). What remains is the crossing count itself.
- Bench: `packages/three-native/tests/browser-backend-glue-bench.ts <abi module> [rounds]`; for a CPU profile with
  line numbers, bundle it with esbuild first (tsx's transform puts a file on one line). It also times a cached read
  (31 ns) beside a crossing (171-1,490 ns).
- Gap closed (glue lane, after this entry): the profiler traced 3.6-4.2 ms of glue a frame, the counts gave 0.1-0.24
  ms. The wrapper entries are now counted too (`methodCalls`, `propertyReads` on `TN_FRAME_BUDGET.counters.engine`,
  opt-in with the engine-cost knob). Laptop, one run per kit, moving: shooter 389 calls, 3,158 reads, 455 crossings;
  platformer 325, 3,619, 655. 83-90% of entries never reach Wasm. Priced all at the crossing mean they make 1.2-1.3 ms,
  3x under the trace; counted glue is about 0.37-0.49 ms (estimate). The rest of the traced figure is trace overhead,
  so no glue cut is left to make.

### 2026-10-27 — Regression net: the kit contract's engine-cost row — GUARD
- Where: `packages/playtest/src/kit-contract.ts` (`engine-cost`), `evaluators/engine-cost.ts`, bounds in
  `create-threenative/template-playtests/contract.json`, PRD-748.
- One counter surface: `TN_FRAME_BUDGET.counters.engine`, one getter per source (core `createEngineCounterReader`).
  Read it there before you add a stdout line or a census for a new cost class, and add the class's counter to it.
- Bounds: each kit's after-values from 2 NVIDIA runs, max(1.5x, value + floor), boot window skipped. A floor that
  hides a fix's red is too loose: the `childrenReads` floor went 10 → 5 when the AutoBatch poll read 11 against 12
  on minimal. Adventure needs no such tightening to catch crossings and hierarchy moves, but its picker reads
  `children` 108 times a frame, so the AutoBatch poll (+40) hides under its 1.5x there; the red shows on minimal.
- What does not separate: a once-per-run cost inside the boot window (the 5 s projection line). Guard those
  with a unit spec instead.

### 2026-10-27 — A node with no engine raycast crosses nothing for a ray (three-native back end) — KEEP
- Where: `packages/three-native/src/browser-backend.ts` `defineTraversal`, PRD-748.
- Census (platformer, GPU sweep of the engine-cost row): `call Raycaster.intersectObject` 309 a frame from
  `ScenePicker` `#hitTest`. Each Group and Bone under a pick target crossed to the engine, whose
  `Object3D::raycast` answers nothing; three's `Object3D.raycast` is empty.
- Change: the engine raycasts `Mesh`, `Line`, `Sprite` (each a `Mesh` in C++) and `LOD`, and their kinds, found
  on the catalog chain; any other node gets three's empty `raycast`. Without a catalog every node still asks.
- Proof: `bridge-reads.spec.ts` "ray tests": 7 crossings for 7 non-mesh nodes before, 0 after; the 8 raycasting
  kinds still cross once each. Platformer engine-cost row, NVIDIA, one run per arm: crossings per frame 873-894 →
  690-707 (windows 2-4), `intersectObject` 309 → 131. About 0.06 ms a frame (estimate: 185 x 0.34 µs).
- Next on the same path, not taken: `#treeFor` reads `morphTargetInfluences` (131 a frame on the platformer) and
  the position `version` per mesh per ray, about 0.05 ms a frame together.

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
### 2026-10-27 — Incremental projection change set and state buckets — REJECT (deferred at sizing)
- Where: [PRD-753](docs/PRDs/Unreal/performance/PRD-753-a-scene-change-updates-only-the-batches-it-touches.md), `projection::decide`, `structureStamp`, `contentClassOf`; counter `TN_PROJECTION_WALKS` (commit `9907ab1f2`).
- Result: the three functions take 0.06% to 0.32% of the game thread on Midway and the shooter, native and web, two runs each (gate 2%). `RenderDatabase::batch` decides 0 to 25 times per 1,000 calls, nearly all on its 60-call cadence; `hostProjectionReport` is not called, because both games set `renderer.projection: false`.
- Cause: the cited 10.8% predates or misattributes the PRD-613 hold above; once `batch` holds its decision, no scene walk is left to remove. The largest piece is `contentClassOf` from `RenderDatabase::record`, once per drawn mesh per frame (0.14% to 0.26%).
- Insight: count the walks before porting a change set. A profile share names a function, not how often its caller runs.

### 2026-10-27 — Wasted work on the shooter, counted by class — DIAGNOSTIC (2 of 6 classes have a fix in another lane)
- Where: lane "waste", worktree `.claude/worktrees/pr574-waste`; counters in
  `packages/runtime-native/src/engine/foundation/waste_counters.h` (first printed as `TN_WASTE:`, one line per 300 drawn
  frames; now running totals read in place into `TN_FRAME_BUDGET.counters.engine`, no stdout line),
  `TN_FRAME_BUDGET.counters.bridgeCrossings` (core), and two reused ones (`TN_PROJECTION.matrixWorld.visited`,
  `TN_FRAME_SPANS`); scratch patches for the two sibling-owned classes. `shareHits`/`shareMints` first counted inside
  `identity()`, which `adoptAlias` also calls, so hits exceeded calls (22,796 vs 23,580); they now count in `share()` only.
- Result (shooter, worker `index.html`, uncapped, desktop at load 31, 900 steady frames):
  contentClassOf 276/frame with 132 `contentVersionKey` recomputes and 0 `classify`; `share` 76/frame all cached
  (0.2 mints); render bundles 0.4 encodes vs 25 replays/frame; GPU buffers/textures 0/frame after warm-up;
  transform visits 9,387/frame = `sceneUpdate` 0.31 ms; crossings 457/frame ≈ 0.37 ms (estimate: count x per-call cost); TSL uniform syncs 34/frame,
  1,360 write attempts/frame of which 99.6 % are unchanged (the array `uniformLanes()` allocates is the cost).
- Cause: the three classes the brief named as leads are about 4 µs, 6 µs and (uniform) ~0.1 ms, estimates (count x per-call cost), not measurements;
  the two ≥0.3 ms buckets are a bridge cache (bridge's file) and the authored `markStatic` freeze the shooter never
  asks for (a settled-subtree freeze the engine decides is feature-sized, not a lane lever).
- Insight: **count the class before naming a fix.** "share allocates a std::string per returned handle" is true and
  worth 4 µs/frame because every call is a cache hit and most type names fit the SSO buffer. The same reading says
  where the 0.3 ms actually is.
- Artifact: `~/.cache/tmp-tn/pr574-waste/counters.md`, `patches/{tsl-uniforms-counters,render-bundle-counters}.patch`,
  `summarize.py`.


### 2026-10-27 — TSL object uniforms re-laned once per frame instead of once per render — HANDED OVER (smooth60's file)
- Where: `packages/three-native/src/tsl-uniforms.ts`, `liveUniforms.sync` (smooth60 owns the file; patch
  described in `~/.cache/tmp-tn/pr574-waste/patches/README.md`, not committed by this lane).
- Ceiling: 50 render syncs a frame, 40 write attempts per sync = 2,000 a frame, and 99.6 % of them unchanged;
  the per-attempt `uniformLanes()` array and compare is the cost, about 0.08-0.15 ms/frame.
- Result (shooter, counter on, same wasm, 900 drawn frames): write attempts **2,000 -> 800 per frame**; the
  remaining 700/frame are `onRenderUpdate` callbacks that run per render by design. CPU not measured: the
  laptop was at its 97 °C admission ceiling with three other lanes' jobs, and the desktop stood at load 25-35,
  so no qualified pair was possible for a lever under 1 % of the frame.
- Cause: the object-uniform re-lane loop exists for in-place `Color`/vector edits, which a game can only make
  between frames; the later passes of one frame compared the same lanes again.
- Insight: it also changes when an in-place edit reaches a later pass of the same frame, so it needs a visual
  judge before it ships — a counter win is not a verdict.
- Artifact: `patches/tsl-uniforms-counters.patch` (the counter), `patches/README.md` (the fix), `probe3.log` /
  `probe5.log` in the lane scratch.
- Status at the PR #574 merge: still not committed. PR #574 holds a different `tsl-uniforms.ts` change (the lane
  scratch is reused, and each sink write gets its own snapshot); the once-per-frame re-lane stays open for a follow-up
  with its visual judge.

### 2026-10-27 — Rapier step grew from 2.1 to 3.4-6.6 ms a frame in profiler round 2 — NOT A CAUSE (host load)
- Where: `packages/physics`, step counters `physicsStepUs`, `physicsAwakeBodies`, `physicsDynamicBodies`,
  `physicsBodies`, `physicsColliders` (lane/pr574-physics2 `5cf55b577`, opt-in with the engine-cost knob; not in PR #574).
- Result: shooter kit, live clock, headed WebGPU. Quiet laptop (load 0.1-2.1), 3 arms x 2 runs (idle, firing,
  walk+fire): 1.00-1.05 substeps, 108-184 µs a step, 110-223 µs a frame, 0 awake and 0 dynamic bodies, 150-162 bodies.
  A shatter arm: 45 awake shards add 0.05-0.08 ms a step. Loaded desktop (load 17-57), 4 runs: 1.26-2.71 substeps,
  330-910 µs a step, 0.42-1.91 ms a frame.
- Cause: per-frame physics is substeps x per-step cost, and both grow with host contention. Load 53-57 at 2-3
  substeps reproduces the traced 3.4 ms. Awake bodies do not track the step.
- Insight: no engine fix. The next cost on that row is the host gap (`TN_HOST_GAP`) on the loaded host.

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

### 2026-10-28 — PRD-754 recorded passes survive a camera turn — KEEP (native shadow bundles), DEFER (rows)
- Where: [PRD-754](docs/PRDs/Unreal/performance/PRD-754-a-camera-turn-re-records-no-pass.md), PR #584; `4a7e82414`, `b5021ba1d`.
- Result: state-ordered opaque rows cut recording plus shadow CPU 75-78% on a camera turn, but swapped the winner of
  exactly coplanar draws (shooter door trim): judge REGRESSION, missed by two earlier NEUTRAL judges. Depth-ordered rows
  keep the pixels but record more than direct encode (105 against 57 rows a lap). The owner kept three's order: the
  shadow bundles and uniform slots alone give 17% on Midway native and nothing on the web turn, so the web engine
  compiles them out (it was 74 KB over its 4 MiB budget).
- Insight: a draw order that the camera does not change must still keep the coplanar winner, or the "free" order costs
  pixels. Count pixels where every AFTER run differs from every BEFORE run; a judge reading a sheet misses a thin stripe.
- Revisit when: an opaque order that keeps the coplanar winner exists (depth order only among intersecting bounds).


### 2026-10-28 — Web frame gate reads frame age, not a count of unfinished frames — KEEP
- Where: `packages/runtime-native/src/engine/renderer/frame_gate.h`, `wasm/web_host.cpp` (`tnw_web_frame` field 11); `597faf225`.
- Result: RTS kit, Chrome 153, RTX 2080 shared with other jobs. Frames with no GPU submit 1.52 % -> 0.35 % (1246 vs
  1155 frames, 20 s each); engine `renderSkips` per 5 s window 11-16 -> 0-6. A 3 ms GPU frame's work-done promise
  resolved at p90 24 ms and p99 39 ms, so "two frames unfinished" declined frames the GPU had already drawn.
- Insight: on the web, completion arrives as a promise behind every earlier map; a gate on its count measures browser
  scheduling, not the GPU. Decline only when the oldest unfinished frame is 4 loop intervals old (queue cap 6).
- Revisit when: presentation gets its own completion marker (Codex diagnosis: a per-frame mapped buffer), or skips
  return; the timestamp readback still maps every frame until `trackTimestamp` reaches the native timer.

### 2026-10-28 — AstraCraft (three r140, WebGL) as the RTS reference — KEEP (diagnostic)
- Result: same Chrome, same host load: AstraCraft holds rAF 59.8 with a main thread as busy as ours, and never skips a
  frame. Our Wasm RTS: render phase p50 5.5-6.3 ms (three.js 7.4-9.1), GPU p50 2.6-2.8 ms (three.js 3.8), but update
  phase p50 2.7-3.4 ms against three.js 0.6 ms: about 1,000 ABI crossings per `army.sync`, a 112x112x4 fog texture
  widened to 401 KB of doubles per refresh, timestamp readbacks every frame. Fixes on `fix/wasm-update-crossings`.
- Insight: the existing bridge guard flags only redundant reads; writes and distinct reads passed silently
  (telemetry lane `feat/web-engine-debug-telemetry`).
