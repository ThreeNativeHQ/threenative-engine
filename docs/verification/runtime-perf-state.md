# Runtime & core performance — the single state record

**Policy (owner, 2026-08-27):** this file is the one performance record for the native runtime and
`packages/core`. New performance findings **update this file in place**; they do not open a new
`docs/verification/prd-*-perf-*.md` file. (The one-file-per-run rule in `docs/PRDs/AGENTS.md`
keeps applying to everything that is not a runtime/core performance record.)

The 35 superseded performance reports were deleted 2026-08-27; their full text is recoverable from
git history (`git log --diff-filter=D --name-only -- docs/verification/` names the commit, then
`git show <commit>^:docs/verification/<file>`). §8 indexes what each one concluded. A claim whose
detail is not in this file exists only in git — quote it with the commit.

## The native C++ engine beats legacy on the R ladder, desktop and web — 2026-10-12

PRD-573 (PR #493). Full tables and setup: [RESULTS-2026-10-12](../benchmark/prd573/RESULTS-2026-10-12.md).

- **Desktop, real GPU** (RTX 2080, real display, both arms the same size, equal triangles): frame p50 ratio, legacy over engine, is R5 2.80x, R3 3.20x and R2 2.35x. Uncapped FPS at R5 was 80 vs 198. p99 is lower on the engine at every rung.
- **Desktop, Xvfb:** thread CPU without present at R5 is 2.10x. Xvfb present costs about 75 ms per frame in both arms, so Xvfb frame time and FPS cannot show engine gains. Read Xvfb A/Bs on thread CPU only.
- **Web** (tn-engine-web vs tn-web, main-thread wall time): 0.15x at the first port, then 1.41x after the bridge, collect and member cuts. WebGPU glue is about 1% of samples, and the remaining cost is JS around the calls.
- **What made the native win:** host projection (crossings 17,669 to 62 per R5 frame), JS math value types over TransformPage views, and render-record caching. What remains on native is the driver, parity math and JS that legacy also runs.

## Machinefall open world on develop: the CPU render phase is the frame — 2026-10-01

PRD-475 Phase 1 baseline (`docs/PRDs/unreal-like-features/PRD-475-open-world-120-fps-without-visual-loss.md`). Machinefall `?scene=map-walk` on develop `a602467db` (core 0.3.4, assets 0.3.5, world re-cooked), browser WebGPU on the RTX 2080 (nvidia/turing), private Xvfb, 3 runs started at load 3.4–3.8. Steady `TN_FRAME_BUDGET` windows; medians across runs.

| Meter | p50 | p95 |
| --- | --- | --- |
| frame | 12.3 ms | 26.3 ms |
| render phase (CPU) | 12.1 ms | 26.1 ms |
| hostGap | 0.6 ms | 61.9 ms |
| GPU (timestamp-query) | 7.4 ms | 11.3 ms |
| gpuMain / gpuShadow | 5.6 / 1.1 ms | — |
| draws main / shadow | 318 / 200 | 414 / 270 |

- The CPU render phase is the frame: render p50 is 1.6× the GPU p50, and update, overlay and ui read 0. The 120 fps budget (8.3 ms p95) is missed by 3.1× on CPU and 1.4× on GPU.
- Window fps median 45 (51, 42, 45). One window per run is the post-walk idle at 83–119 fps, which is why a whole-run average reads near 120.
- The triangle census reads 264 M main and 23 M shadow triangles for about 318 draws, against 9.8 M `mainGpuTriangles`. It is not trusted until it is checked. `gpuShadow` read 0 in one run.
- One earlier run of five counted 1 failed world load (`WorldCells` `failures`), not reproduced in four reruns. The count records no cell and no error.
- **After PRD-475 cuts 1+2** (terrain super-tiles, shadow caster table; `890578e81`), clean machine (load < 3, GPU < 10%), 4+4 interleaved runs against develop: frame p50 9.55 → 7.20 ms, frame p95 20.55 → 17.22 ms, GPU p50 6.95 → 7.12, GPU p95 10.93 → 10.20, main draws 335.5 → 246.5. The develop arm's own spread (frame p50 6.4–12.0 ms) overlaps, so the ratio is directional; the branch's distribution is tighter. Still 2.1× over the 8.3 ms p95 on CPU and 1.2× on GPU.
- **PRD-475 as merged** (2026-10-02, cut12k–n, walk/idle split of `TN_FRAME_BUDGET` windows, quiet gate, 3–4 interleaved pairs against develop `a602467db`): idle frame p50 2.6–4.8 vs 5–7 ms; walking render p50 7.0–8.4 vs 8.3–10.4; walking render p95 19–26 vs 18–25 (unchanged, the 8.3 ms target is not met); main draws 208–297 vs 297–327. A long walking frame (unminified trace, 390 of 1491 rAFs over 12 ms, mean 20 ms) spends ~7.5 ms in three's per-object refresh, ~5.5 ms in WorldCells streaming and ~3 ms in a shadow-level re-render; that tail is PRD-478's. A shared measured frame budget (streaming deferred in shadow frames) made walking p95 worse (26–35 ms) and was reverted.

## ThreeNative vs Godot 4.7.1 scoreboard, and three projection fixes — 2026-09-28

PRD-449 (`docs/PRDs/done/PRD-449-cross-engine-benchmarks-and-html-report.md`). One cube scene, native desktop, RTX 2080, 1280×720 uncapped, 40 warm-up + 120 measured frames, and 3 alternating runs per engine (`pnpm bench:scoreboard`). A row is a win only when the median gap beats the run-to-run spread. The dashboard is `pnpm bench:engines:monitor` (`artifacts/engine-load-test/prd-449/progress.html`).

| Row (TN vs Godot) | 1,024 cubes | 4,096 cubes |
| --- | --- | --- |
| Shipped defaults (TN L3 / Godot L1) | 1.26 vs 1.64 ms, TN 1.3× | 2.28 vs 4.17 ms, TN 1.8× |
| Explicit instancing (L2 / L2) | 1.10 vs 1.23 ms, TN 1.1× | 1.40 vs 2.73 ms, TN 2.0× |
| Can't batch, unique material per cube (L4 / L4) | 2.08 vs 1.73 ms, Godot 1.2× | 7.88 vs 5.95 ms, tie |

Kept fixes in `packages/core`, each paired-A/B'd on the same GPU:
- Projection reconcile skips the unchanged structure: L3 at 4,096 went 10.93 → 6.08 ms on a loaded machine (6/6 blocks).
- Batch meshes whose materials differ only in colour/uniforms: L4 draws 2,375 → 3, and 42.9 → 10.8 ms at 4,096. Projection on and off match within tolerance.
- The per-frame material drift check is 1.3× cheaper: L4 at 4,096 went 9.84 → 8.46 ms.

Real-game holdout (racing and shooter templates): no effect and no regression. Both stay below the projection's 200-renderable floor. **Settled by PRD-462 (2026-09-28):** the poll was the whole of the remaining L4 gap, and the answer was not a change signal but checking fewer materials — the default `materialChecks: "spread"` proves a bounded slice per frame (512 at 4,096 materials, an 8-frame worst-case staleness reported as `materialCheckStaleFrames`), and the exact per-member check stays available as `everyFrame`. Measured on the quiet machine: L4@4,096 `collapseMs` **8.18–10.00 → 1.79–3.35 ms** over four interleaved pairs, all four negative, paired median −6.47 ms; the frame p50 10.36–13.63 → 3.52–5.90 ms; L3 unmoved. The cost that remains is the check itself, 0.23–1.13 µs a material, paid 512 times a frame instead of 4,096. Per-draw cost when nothing can batch is about 9 µs of three.js per-object JS plus 2.3 µs of native replay; render bundles would help only static content (probe notes: `artifacts/engine-load-test/prd-449/tmp/attribution/`, untracked).

## Skinned rigs share one palette draw per pass — 2026-09-25

The render projection now folds `SkinnedMesh` rigs that share a geometry and material into one
instanced palette draw per pass (`packages/core/src/projection-skinned.ts`); games write nothing.
Bench: `pnpm exec tsx scripts/engine-load-test/skinned-crowd.ts` (tn-web, hardware NVIDIA Turing,
shadows on, 32-bone rigs, one render per animation-frame tick, 300 frames per arm, 6 paired
stock/projected runs plus an A/A pair; medians):

| Rigs | Frame p50 stock → lane | CPU p50 stock → lane | Pairs faster |
| --- | --- | --- | --- |
| 8 | 2.55 → 2.45 ms | 0.75 → 0.70 ms | noise |
| 32 | 6.30 → 6.15 ms | 2.40 → 2.15 ms | noise |
| 128 | 10.25 → 7.20 ms | 5.90 → 3.70 ms | 6/6 |
| 512 | 47.05 → 24.45 ms | 37.0 → 17.75 ms | 6/6 |

Draws at 512 rigs: 1026 → 4. Captures of the same frame are pixel-identical at 128 rigs and within
1/255 at 8 (stock A/A: exact). The machine carried load average 12–18 from other lanes during the
run. Pitfall: three refreshes a stock skeleton once per animation-frame tick, so a bench that
renders several frames per tick draws stale poses and under-prices the stock arm by about half.
Native: `examples/skinned-crowd` scenario, 130 → 4 draws on the desktop host and 4 draws on the
Android emulator (API 35, x86_64). Not measured: physical-device frame time.

## Read the distribution, not the average — 2026-09-19

The single most expensive habit in this file's history, measured five times in one session. Every
wrong conclusion below came from reading an aggregate where the answer was in the events
underneath it, and every one was cheap to disprove once the right thing was counted.

- `nodes.updateBefore` "costs 4.4 µs per draw under shadows" — a total over a call count. One
  call per frame renders the shadow map at 3,600 µs while ~393 cost 0.2 µs. **A mean is not a
  per-call cost unless the calls are alike.** `scripts/render-profile` now reports `maxMs` per
  stage so the two cannot be confused again.
- The same stage "costs 7 µs per shadow-pass draw" — arithmetic by subtraction across two arms,
  never asking which calls held the time. Bucketing by material answered it in one run.
- A host "spins without presenting", then "never enters a render loop" — both from fps averages
  and a p50 of 0 ms. The event stream showed the overlay attaching, the game loading and
  `TN_SURFACE_FRAME` advancing: it presents 118 frames in 26 seconds, a few percent of the
  iterations its counter counts.
- A freeze measured at "no difference" — per-frame samples against a clock Chrome coarsens to
  100 µs, wider than the whole 9 µs effect. Batching 100 updates per sample made it visible.

The rule that survives all four: **when a number is suspicious, look at the spread, the maximum
and the call counts before believing the mean** — and when a change claims to delete work, count
the work rather than timing it.

## What the render phase is made of, measured on a scene that renders — 2026-09-19

**Subject:** `examples/engine-load-test` (deterministic seeded lattice, one shared material) and a
purpose-built 1,561-object caster field, Chrome WebGPU, 1280x720, 480 measured frames per rung,
RTX 2080. Instruments: `scripts/render-profile/renderer-stage-hooks.ts` (function wrapping) and a
CDP V8 sampling profile (stack sampling). Wrapping inflates absolute time, so proportions and
unit costs are the finding and milliseconds are not comparable to an unprofiled run.

**Why not the reference game.** `sandbox/midway-open-pacific` could not render on this machine in
either lane: another tenant held 6.2 GiB of the 8 GiB card, Dawn lost the device on native and
Chromium reported `VK_ERROR_OUT_OF_DEVICE_MEMORY` on `CreateTexture` in the browser. Rather than
report nothing, the attribution was measured on scenes that fit. Every number below is synthetic.

**The render phase splits 87 / 14 / 1.** At 4,096 objects and 2,469 draws, `renderer.renderScene`
is 25.20 ms/frame: the per-draw loop 21.98 ms (87%), the scene-graph walk 3.57 ms (14%), the
render-list sort 0.31 ms (1.2%). No single stage inside the per-draw loop is a majority — it is
the sum of six, ranked by cost per draw: bindings 2.64 µs, render-object lookup 1.08 µs, node
updates 1.03 µs, the draw itself 0.71 µs, pipelines 0.55 µs, geometries 0.35 µs. **The practical
consequence is that no single fix recovers the render phase.**

**Two unit costs, for pricing future work.**

| | 1,024 obj / 629 draws | 4,096 obj / 2,469 draws |
|---|---|---|
| per draw (`renderObjects` ÷ draws) | 7.74 µs | 8.90 µs |
| per object (`projectObject` ÷ objects) | 0.92 µs | 0.87 µs |

Traversal is linear; per-draw cost grows with draw count. Applied to a 1,561-mesh, 573-draw game,
these bound a perfect static freeze at ~1.4 ms and a perfect draw-call merge at ~5.1 ms.

**Two independent instruments name the same subsystem.** The sampling profile, which shares no
mechanism with the wrappers, ranks by non-idle self time: `writeBuffer` 10.0%, three's WebGPU
`get` 8.6%, `updateForRender` 3.9%, `getForRender` 2.9%, `updateNode` 2.6%, `setBindGroup` 2.6%,
`needsRenderUpdate` 2.3%, `updateGroup` 2.1%, `updateBinding` 1.5% — **48% of non-idle time in
binding, uniform and node-update work.** `(garbage collector)` is 454 ms, 6.7% of non-idle: real
but not dominant.

**The shadow finding, which is the most actionable thing here.** The identical 1,561-object scene
with `shadowMap.enabled` flipped, nothing else changed:

| | off | on | |
|---|---|---|---|
| draw calls | 1,535 | 3,074 | ×2.00 |
| `renderer.renderScene` | 16.09 ms | 43.16 ms | **×2.68** |
| `renderer.projectObject` | 1.71 ms | 3.03 ms | +1.31 ms |
| `nodes.updateBefore` | 0.33 ms | **13.49 ms** | **×40** |

Doubling the draws nearly triples the render phase. Every per-draw stage holds its per-call cost
(bindings ×1.0, lookup ×1.0, draw ×0.9, pipelines ×1.0, geometries ×1.0) except
`nodes.updateBefore`, which is 13.16 ms of the 27.08 ms a shadow pass adds; the second traversal
is +1.31 ms and is the cheap part. **That stage is resolved below, and it is not a per-call
regression** — an earlier revision of this paragraph reported it as 0.216 µs → 4.391 µs per
call, ×20.3, which was a whole render pass divided by a draw count.

**The ×20 resolved: it is the shadow-map render, billed to one draw.** Two experiments were
needed and the first one's conclusion was wrong, which is recorded here because the wrong step is
instructive.

*First*, `light.shadow.autoUpdate = false` after frame 2 — the shadow map stops being
re-rendered, everything else identical:

| | `nodes.updateBefore` | calls/frame | per call | `renderScene` |
|---|---|---|---|---|
| shadow re-rendered | 11.20 ms | 3,073 | 3.646 µs | 34.74 ms |
| shadow frozen after frame 2 | 0.39 ms | 1,534 | 0.253 µs | 14.37 ms |

From that I concluded the excess was spread across the shadow pass's own draws at ~7 µs each. It
was arithmetic by subtraction — charge the survivors at the frozen rate, divide the remainder by
the calls that disappeared — and it never checked **which** calls held the time.

*Second*, bucketing every call by the material it draws with and the number of `updateBefore`
nodes the render object carries, with per-call maxima:

| bucket | calls/frame | mean per call | max | calls over 100 µs |
|---|---|---|---|---|
| `MeshStandardMaterial`, 1 updateBefore node (main pass) | 394 | 5.695 µs | **3,600 µs** | **1.43** |
| `NodeMaterial`, 0 updateBefore nodes (shadow pass) | 396 | 0.205 µs | 100 µs | 0.31 |

**About one call per frame carries the entire stage.** The shadow pass's own draws are the cheap
ones — they use a shadow material with no `updateBefore` nodes at all. The lit material carries a
single RENDER-typed node whose `updateBefore` renders the shadow map, and three's `NodeFrame`
guard runs it once per render id, on whichever lit draw comes first.

**The consequence is bigger than the number.** `nodes.updateBefore` is not a per-draw stage in a
shadowed scene: most of its total is one whole render pass executed inside a method that a
wrapping profiler attributes per draw. Any attribution built on wrapping that method — including
this record's own table — will show a per-draw cost that is really a pass. The 28x and 7 µs
figures from the first experiment are withdrawn; the per-draw cost of node updates in a shadowed
frame is about 0.2 µs, the same as without shadows, and the mass is a shadow-map render.

**A cross-validation that could have failed.** 0.87 µs/object × 1,561 predicts a 1.36 ms second
traversal; the measured delta is 1.31 ms — 4% error, on a different scene at a different object
count from the one the unit cost came from.

**Native, with the collapse switched off: the browser's shape holds.** The same 1,561-mesh
lattice through `defineGame` on the packaged host (`sh scripts/xvfb.sh --headless`, 900 frames,
480 measured), as a 2x2 over the engine's projection and shadows. The switch is
`render: { projection }` — `renderer:` takes a renderer instance, and passing the flag there
silently does nothing, which cost one round of identical "arms" before it was caught.

| arm | `renderScene` | draws/frame | µs/draw |
|---|---|---|---|
| projection off, no shadows | **9.98 ms** | 1,535 | 4.17 |
| projection off, shadows | **30.40 ms** | 3,074 | 8.35 |
| projection on, no shadows | **2.31 ms** | 3 | — |
| projection on, shadows | 2.56 ms | 4 | — |

Three things transfer from this:

1. **Per-object traversal agrees across runtimes.** 1.472 ms over 1,566 visited objects is
   **0.94 µs/object** on native, against 0.87-0.92 µs measured in the browser on a different
   scene at different object counts.
2. **The shadow result reproduces.** Draws exactly double, and `renderScene` goes up **3.05x**
   (9.98 -> 30.40 ms) where the browser saw 2.68x. A shadow pass costing far more than the draws
   it adds is not a browser artifact.
3. **Native is about twice as cheap per draw** — 4.17 µs against the browser's 7.74-8.90 µs on
   comparable scenes — which is the clearest single argument in this record for the native host.

**The engine's collapse, measured against a real control this time.** With projection on, 1,561
authored meshes become one instanced batch and 3 draws
(`"sourceRenderables":1562,"instancedBatches":1,"projectedObjects":1561`), and `renderScene` falls
from 9.98 ms to **2.31 ms — 4.3x less CPU**, with no game-side work. For PRD-397 this is the
number that matters: the runtime already performs the collapse a build-time merge proposes,
wherever geometry and material repeat. A merge can only win where this declines, which is the
reference game's shape of 426 meshes over 232 materials — the residue the census measured at
220 -> 192 buckets.

**The 960-call anomaly explained, and it is the most useful result here.** Five per-subsystem
stages recorded 960 calls in one native arm against 739,680 in another. That was not an instrument
fault and not the shadow pass: **the native probe never moved anything, and the browser probe
rotated every cube every frame.** Isolating exactly that, same scene, same host, projection off,
no shadows:

| | `bindings.updateForRender` calls/frame | that stage | `renderScene` |
|---|---|---|---|
| nothing moves | **2** | 0.03 ms | **10.10 ms** |
| all 1,561 objects rotate | **1,534** | 3.94 ms | **17.45 ms** |

**Moving 1,561 objects costs +7.35 ms of render phase**, and three skips the per-object binding
update entirely when nothing changes. A static object is already cheap, automatically, with no
API and no authoring — which is why the earlier arms disagreed by three orders of magnitude on
call count, and why the ratios computed across them were discarded.

This is the number PRD-396 should have been written against. Its `markStatic` freeze removes
matrix composition and is worth 0.009 ms on a scene this size; the binding work that dominates a
moving scene is already skipped for anything the game does not touch. **The engine rewards
staticness by roughly 7 ms on this scene before any freeze API exists.**

It also cautions every other row here: the browser attribution animated its scene and the native
2x2 did not, so per-subsystem comparisons between them are not like-for-like. The stage-level
totals (`renderScene`, `projectObject`, draw counts) are, and those are what the cross-runtime
claims above rest on.

**The bound on batching.** The same 4,096 objects rendered through the framework's collapse pass
take 3 draws and **0.24 ms instead of 25.20 ms, 106× less CPU.** That is what perfect batching of
a one-material scene achieves, and it is an upper bound: a game with 232 materials over 426 meshes
does not collapse that far.

**Host-boundary price, native.** One empty V8→host call costs **74.07 / 75.33 ns** measured by
`packages/runtime-native/scripts/bench-host-boundary.js`. At 4,131 WebGPU commands per frame that
is 0.31 ms — filling 10.9 ms would need 145,917 crossings per frame, 255 per draw, against the 7.2
per draw actually made. **The boundary is not where render time goes**, which prices WASM-hot-loop
proposals down rather than up.

## A real-time native gameplay lane, and what the render term is made of — 2026-09-19

**Subject:** `sandbox/midway-open-pacific`, airborne cruise, packaged desktop binary (host
`build/tn-linux/mystral` `1059b36b`, CMake Release; game bundled against the sandbox tarballs),
RTX 2080 driver 615.71.09, 1280x720, MSAA 4x, `resolutionScale` 1, present mode fifo at 60 Hz.
Campaign record, raw logs and the tools are in
`artifacts/native-performance-loop/native-desktop-midway-20260919/` (untracked).

**A `.playtest.json` cannot measure native frame pacing, and this is why.** A step's
`waitTicks`/`holdTicks` (and `waitFrames`, which a fixed-step bridge converts to ticks —
`steps.ts:302`) call `GameLoop.advance()`, and `advance()` runs the fixed-step callbacks in a tight
loop **with no render and no present** (`packages/core/src/loop.ts:296`). Measured: a 5010-tick
flight scenario presented ~60 frames in total, and its six `TN_FRAME_BUDGET` windows were the
loading screen (windows 2-6: `presents: 0`, `render p50 0`). The scenario is a correctness harness,
not a workload.

**The lane this record now has:** `tools/realtime-drive.mjs` attaches the same mailbox bridge (so the
boot hold releases), drives a fixed input choreography, and then leaves the host alone for a
wall-clock window while it runs its own loop; `tools/measure.mjs` reads the host's own markers with
the existing `threenative-playtest perf` parser and reduces the last 8 windows whose every counted
loop frame reached the display. Both arms must run on `TN_PLAYTEST_HOST_DISPLAY=1`, because a
private Xvfb's frame rate is wrong rather than missing.

**Baseline, three runs, 8 fully presented windows (2400 presented frames) each, zero hitches:**

| metric | median | spread over three runs |
| --- | ---: | --- |
| frame p50 | 15.00 ms | 14.80-15.20 |
| frame p95 | 18.34 ms | 18.33-19.47 |
| render p50 (JS) | 12.30 ms | 11.84-12.55 |
| gpuMs | 1.8 ms | 1.4-2.3 |
| presentedFps | 57.9 | 57.6-58.3 |

Noise margin, predeclared and applied to every later candidate: the larger of 3% of the baseline and
twice the largest deviation from the median — **±2.25 ms p95, ±0.45 ms p50, ±0.93 ms render p50**.
Launch on the same runs: `ready` at 9033 ms (median; 8192-9618), with `audio` 1.2 s →
`scene-load-total` 3.8 s → `enter` 5.1 s. This supersedes the 2026-09-17 probe's 21.4-22.9 ms p50
airborne reading, which was a different camera instant under the old load stall.

**What the 12.3 ms render term is made of.** A `TN_ANDROID_JS_PROFILE=ON` host of the same revision
(names JS functions and attributes a native frame to its JS caller; it also prints a per-frame
marker), 90,923 samples over frames 900-2000 of the same cruise. Attribution only — the build's own
absolute milliseconds are inflated and are never quoted as a timing claim:

| self % | entry |
| ---: | --- |
| 9.22 | `_projectObject` (three RenderList) |
| 9.07 | `updateMatrixWorld` |
| 8.45 | `native <- buffer.mapAsync` (via `install-async-pipelines.js:80`) |
| 6.54 | `_update` (three node update) |
| 5.92 | `update` (`AnimationAction`) |
| 4.74 | `multiplyMatrices` |
| 4.13 | `_renderObjectDirect` |
| 3.89 | `get` (binding cache) |
| 3.71 + 1.56 | `RenderCameraCull.#visit` (engine) |
| 2.89 | `traverse` |

Per frame, from the same host: render-thread CPU 21.9 ms of which **JS frame 19.8 ms** and all
bridge crossings 3.3 ms (`mapAsync` 3.39 ms, `getCurrentTexture` 0.52 ms); 4131 WebGPU commands
(`setVertexBuffer` 1144, `writeBuffer` 949, `setBindGroup` 664, `drawIndexed` 538,
`setIndexBuffer` 524, `setPipeline` 253) in 5 submits, writing 1091 KB into 643 distinct buffers.
So the frame is **JS-owned, not bridge-owned**: the crossings are 15% of it, and three's render list,
its matrix walk and its node update are over half.

**One hypothesis refused before it cost a build:** the per-frame GPU-timestamp resolve
(`renderer.resolveGpuFrame()`, `game.ts:1456`) shows up as 8.45% self time in `mapAsync` and looked
like the single biggest engine-owned item. It is not added work — `handleGpuBufferMapAsync` begins
with `flushRecordedFrameOps` (`bindings_resources.cpp:1140`), replaying the frame-op stream the frame
boundary would replay anyway, so the profile attributes relocated replay to the map. The promise,
readback buffer and extra submit are what would actually be saved.

**exp-01 — the double scene walk does not exist on this workload, and the change built for it was
reverted.** Three does walk the whole graph at the top of every `render()` (`Renderer.js`:
`if ( scene.matrixWorldAutoUpdate === true ) scene.updateMatrixWorld();`), and a mirrored pass is a
second `render()` of the same scene — so the duplicate is real *where auto-update is left on*.
**midway does not leave it on.** It sets `scene.matrixWorldAutoUpdate = false` at startup and walks
the scene itself once per presented frame from the engine's `beforeRender` seam, with its own comment
saying why: *"Shadow and reflection passes (which draw through their own cameras) reuse the
transforms prepared here."* A probe on the live host counted, over 1200 frames, **3180 nested
renders, 1746 calls to the scene's own `updateMatrixWorld` — every one at render depth 0 with
`matrixWorldAutoUpdate === false` — and zero suppressions.** There was no second walk to remove.

The guard this campaign committed for it (`e0c31a8a3`) is **reverted** here, its test deleted and
`renderer.spec.ts`'s identity assertion restored. Two lessons worth the ink:

- **A timing pair is the wrong instrument for a claim about removed work.** Three wall-clock series
  for this change came back `invalid` on a shared box; what settled it was *counting* the walks a
  probe saw (two runs, unambiguous). Where a change claims to delete work, count the work first.
- **The engine already has this lever, twice over.** `renderProjection.ts` walks its source once and
  leaves `matrixWorldAutoUpdate` false for the passes that follow, and midway does the same by hand.
  A change that adds a third mechanism for a case two existing mechanisms already cover is exactly
  what the charter's kill switch is for.

For a game that leaves auto-update on, the duplicate walk is real and **unmeasured here** — it is
recorded as a lead, not taken.

**A false positive worth recording, because the obvious fix causes it.** Pairing the arms by their
recorded load average looks objective and is not: the tool matched *both* candidate runs against the
one slow incumbent and printed `keep — frame p50 improved 2.140 ms against a 0.450 ms margin`, out of
environment noise. `tools/pair-decision.mjs` now pairs by execution adjacency, never reuses a run in
two pairs, and refuses a verdict when the incumbent arm's own spread exceeds the effect being
claimed. On a shared machine the honest output of a paired experiment is often `invalid`, and a tool
that cannot say so is worse than no tool.

**The launch, attributed the same way.** Frames 1-700 of a launch under the same profile host,
78,301 samples. Load timeline: `audio` 1252 ms → `aircraft` 1967 → `ships` 2364 → `fleet` 2846 →
`hulls` 3365 → `environment` 3437 → `deck-crew` 3459 → `scene-load-total` 4107 → `enter` 5638 →
`ready` 9882. So 4.1 s of scene loading and 4.2 s between `enter` and `ready`. The bridge counters
name two costs inside it: **146 `decodeAudioData` calls, ~542 ms of them inside a single frame**
(still synchronous on the loading thread — the same finding as the 2026-09-17 probe), and
**27,647 `fillRect` calls with 27,647 `__nativeSetFillStyle` calls, ~60 ms of crossings, again inside
about one frame**. Those crossings are the game's own texture generation — the bundle writes
`ctx.fillStyle = rgba(...)` then `ctx.fillRect(...)` once per iteration over 25,000 iterations and
over a 512x512 step-3 grid. It is recorded here as a lead, not a fix: the same texture written into
an `ImageData` and uploaded once is one crossing instead of 27,647, which is the game's call and
changes no pixel; the audio decode is an engine seam that is still synchronous by construction.

**exp-03 — the audio decode leaves the frame thread.** `decodeAudioData` decoded inline and handed
back a promise settled by the hand-rolled thenable, because a *settled* promise was the only shape
that object could fake. A real `Promise` has no such problem, so the decode can leave the thread:
`AsyncAudioDecoder` (one worker, bounded queue, results delivered on the draining thread — the shape
`AsyncImageDecoder` already had), resolvers in `src/runtime-scripts/install-async-audio-decode.js`,
and `processAudioEvents()` draining once per `pollEvents()`.

Measured with the campaign's own instrument on the same profile lane, frames 1-700 of a launch:

| | sync decode (before) | queued decode (after) |
| --- | ---: | ---: |
| `decodeAudioData` bridge time, 146 calls, inside one frame | **541.99 ms** | **4.66 ms** |

**Behaviour, which is what caught this:** `native-playtests/audio-sweep.playtest.json` (6631 frames)
and `speech-once.playtest.json` (2892 frames) both pass, with 146 clips decoded off-thread and zero
load failures; the whole `@threenative/runtime-native` suite passes (1370 tests, 23 skipped); the
decode contract test is red when the binding decodes inline again (`expected 5 decodes outstanding,
saw 0`) and green with the queue. **One existing contract had to change with it**:
`threenative-audio-decode-promise-test` asserted that `decodeAudioData`'s legacy `successCallback`
had already fired when the call returned — true only because decoding was synchronous, and not what a
browser does. It now asserts the browser contract in both directions: the callback has *not* fired
before the decode lands, and it does fire when it lands. That pair is the red-green for the contract,
and the proof's pump drains the way `pollEvents()` does. **The launch *seconds* did not clear this
box's noise**: three alternating pairs against the unchanged control read +3200, +622 and −509 ms on
`ready`, while the `audio` load step itself moved only +134, +59 and −49 ms. So the block is gone — a
loading screen that froze for half a second per burst does not — and the launch-total claim stays
unresolved here.

**exp-05 — the asset-read burst does not own a frame either.** `processPendingFileCallbacks()`
emptied the whole queue in one phase: a real launch measured a single `fileCallbacks` phase of **625,
824 and 1043 ms** across three runs — every completed read's callback in one frame, each copying its
bytes into a fresh ArrayBuffer before the game could continue. The reads are issued in parallel, so
they arrive together; the work is the same either way, and what was missing was a frame between
batches. It is now bounded the way the engine already bounds its scheduler drain (4 ms, 256
callbacks, `processMicrotasks()` between them so a callback that enqueues the next read advances).

Three paired runs against the unchanged build: worst `fileCallbacks` phase **0, 0, 0 ms** — below the
host's own 250 ms reporting threshold — against 625/1043/824 ms; `ready` moved −728, −1766 and
−310 ms (median −728 ms, secondary and load-dependent), with **zero unresolved assets, zero decode
failures and zero cue warnings in all six runs**. Gates: `launch` (2011 frames), `briefing` (631) and
`audio-sweep` (6631) native playtests pass; the whole `@threenative/runtime-native` suite passes
(1372 tests); the shape test fails on the unbounded drain with *"the drain must carry a time budget"*
and passes on the bounded one.

**The 1.7-2.6 s `timerCallbacks` launch phase is one callback, not a burst — bounded, measured,
reverted.** The same shape as the file drain looked like it applied to the *largest* single phase in
a launch: `executeTimerCallbacks()` emptied its queue unbounded, and three launches reported one
`timerCallbacks` phase of 1744, 2139 and 2608 ms. A probe that counted callbacks inside the phase
answered it in one run: **`{"callbacks":1,"ms":2663}`** — a single callback, which no drain budget can
bound, because a callback is not preemptible. Three paired runs against the unchanged build read
2062, 1813 and 2248 ms with the bound in place: **no change**, so the bound was reverted. The
callback is **not** a defect either, and that is worth writing down because it is the third time this
campaign's instrument changed the conclusion: instrumented per callback, on a machine at load 10-14,
**no timer callback exceeded 50 ms across two full runs** — while every 1.7-2.6 s reading was taken at
load 17-29. The phase is ordinary timer work whose *wall* time is inflated by contention, which is
exactly the confound this record's honest-gap note describes. Nothing was wrong with the drain, and
the lead closes here.

**The remaining launch lead is a one-off first-upload callback, not a decode queue.** The engine
already names slow decode callbacks itself (`TN_SLOW_DECODE_CALLBACK`, 100 ms floor), and across eight
launches that marker fired **exactly once each**: 1347-1835 ms, `waiting: 0`, for a 512x512 and a
2048x2048 image alike. Size-independence rules out the RGBA copy; the callback is
`engine->call(callback, {bitmap, null})`, so the cost is whatever the JS continuation does with the
first texture — three's upload path. `AsyncImageDecoder::drain()` is *already* bounded and its
leftovers wait for a later poll, so the drain is not the lever; the cost inside that one continuation
is. A split probe answered the ownership question in two runs: the callback's **native** half — building
the V8 ArrayBuffer from 16.8 MB of RGBA — is **2.96 and 4.26 ms**, and the JS continuation is **1391.7
and 1418.4 ms**; a third run on a 512x512 image reads 0.16 ms native against 1567.2 ms of JS, so the
engine's half tracks the bytes while the JS half does not. Accumulating the engine's own texture-upload
bindings (`copyExternalImageToTexture`, `queue.writeTexture`) over the same window gives **0 ms**: the time is JavaScript outside the engine's
upload path, so the lever is in the game's or three's continuation, not in the host. That closes the
launch lead for this campaign: the engine's share of the worst single frame in a launch is 5 ms of
1.8 s.

```
TN_DECODE_CALLBACK_SPLIT:{"nativeMs":4.26,"jsMs":1818.44,"uploadMs":0,"w":2048,"h":2048,"bytes":16777216}
```

**A second game walks the kept changes.** The scaffolded production platformer — the repository's
own template, packed from the workspace at `50c26f9ba` and built against the changed host — launches
and passes `playtests/collect.playtest.json` on desktop (83 frames, no diagnostics). Its
`playtests/performance.playtest.json` reads 15.6 fps under the runner's private Xvfb and fails its
30 fps floor, then passes that floor on the real display (`TN_PLAYTEST_HOST_DISPLAY=1`) and fails only
its 33 ms p95 product budget at 107 ms — on a box at 1-minute load ~20, with no pre-change control
arm built (that needs a full CMake reconfigure, and the question it would answer is the template's
own budget, not this campaign's changes). The Xvfb figure is the repo's own documented artifact
(13.3 fps there against 57.7 on the real display, one build), which is why the second run named the
display.

**Harness observation, not a change:** `pnpm profile:production -- --target desktop` reports
`BLOCKED` with `TN_PROD_PLAYTEST_FAILED` and *"Desktop application did not expose a playtest bridge"*
for that same scaffolded platformer, while the same project built and driven directly by the playtest
runner passes. The harness's desktop invocation is the part that fails on this checkout; nothing in
the two kept changes is implicated.

**The second workload is vsync-bound, and its 72% profile entry is the wait.** The scaffolded
platformer profiled the same way as midway (profile host, frames after the choreography) reads frame
p50 15.48 ms with **render p50 14.27 ms** — the same CPU-bound shape — but one entry owns
**71.97%** of all JS samples: `native <- _getDefaultRenderPassDescriptor @ game.js:103420`, a native
frame whose nearest named JS caller is three's canvas-target lookup inside
`WebGPUBackend._getDefaultRenderPassDescriptor`. That lookup is a plain getter, so the sample is deeper
than the name suggests.

Running the same game with `--no-vsync` settles it: the entry falls to **6.74%**, `render` p50 falls
14.27 -> **5.58 ms**, and the 8.7 ms moves to `hostGap` (6.07 ms). The platformer was waiting for the
next swapchain image inside the pass descriptor path, not working: it has **5.6 ms of work in a
16.7 ms budget**, and with the wait removed the largest remaining term is the per-frame GPU-timestamp
resolve (`native <- buffer.mapAsync`, 29.49%) — the relocated frame-op replay this record already
refused as a lever.

Two conclusions, both worth keeping: midway is the right primary workload, because it is the one that
is *CPU-bound*; and a profile share is not a cost until the wait has been taken out of it.

**The same trap, twice more, and the pairing rule that caught it.** The scaffolded platformer's
profile is led by a *different* entry in every configuration: at 60 Hz the swapchain wait above, and
uncapped `native <- buffer.mapAsync` (the per-frame GPU timestamp readback) at **30.91% and 31.75%**
of all samples across two control runs. Removing the readback outright changed no frame: control frame
p50 5.58/5.35 ms against 4.56/6.60 ms without it, with the arm's own spread (2.04 ms) wider than any
difference between arms and the render phase moving the *other* way (2.79-2.88 against 3.74-5.24) —
the shape of relocated work rather than work removed. The readback's CPU sits on the main thread
inside the host poll and submit path, which is exactly where a paced loop already spends its wait.

The first, unpaired reading of that same A/B showed a 2.67 ms win. It was load noise, and it is the
reason the campaign alternates its arms instead of running them one after another: on this box a
single arm's spread exceeds every steady-frame effect measured so far, so an unpaired pair can
manufacture any answer. Cadence was tested too — sampling every fourth frame holds 75 GPU samples in
a 300-frame window at a 1-frame age against the scaler's limit of 8 — and it bought no frame time, so
it was reverted rather than shipped as measurement density traded for nothing.

**Every engine-owned entry in the steady frame is now accounted for, and none is reducible without
changing behaviour.** On the primary workload the engine's own share is small and spread, and each
piece was read rather than assumed:

- **The camera cull** (3.7-5.3%, about 0.5-0.7 ms) is property- and `WeakMap`-bound, not
  trigonometry: it already owns its scratch vector, scratch matrix, visitor and hidden list, and the
  per-object arithmetic a rewrite would replace (one `sqrt`, one divide, one `applyMatrix4` for a
  point, one `getMaxScaleOnAxis`) prices at roughly 15 microseconds across 1,529 objects. A
  "faster" version would be a cosmetic diff.
- **The per-frame GPU timestamp readback** (0.40 ms on this workload, 30.91% and 31.75% of the
  second workload's samples) was priced against a paired control and removed outright; the frame did
  not move, because its CPU sits in the host poll and submit path, where a paced loop already spends
  its wait.
- **The frame-op recorder** (about 0.5 ms, 4,131 commands a frame) is already fast-pathed: typed
  upload paths per view width, resource ids cached on the object, a manual `DataView` encoder. What
  remains is the byte copy the deferred design requires - a megabyte a frame on this workload, and
  the safety property that lets the game reuse its own buffers before replay.

That is the whole of the engine's named steady-frame cost, and the campaign's bar is 0.5 ms.

**The kept launch change reproduced on a later day, and the reproduction is the point.** The
campaign's queued row was a quiet-machine re-run of the file-drain pair, and it ran on 2026-09-20
under loads the script prints per run (9.4 to 16.1, so no row is left queued): every control run
reported the worst `fileCallbacks` phase the change was accepted for (783.5, 647.5 and 638.1 ms) and
every candidate run reported nothing at all, below the host's 250 ms threshold - three of three, on a
metric that does not move with machine load. Launch `ready` moved the *other* way this time (median
8,438 ms control against 9,307 ms candidate), with the candidate runs carrying the higher loads,
which is the load dependence the original record already attached to that number and the reason its
decision was never placed there. A reproduction that only repeated the accepted numbers would have
proved less than one that also shows which metric is allowed to disagree.

The reproduction wrote into the same `raw/exp-05-<arm>-<slot>` paths as the original pairs and
replaced those logs; the original values survive in the experiment's own fields, and `raw/exp-05/`
and `raw/exp-05-gates/` are untouched.

**Batching a scene is bounded by its material count, not by its object count.** The engine's own
guidance says to reach for `mergeParts` when many different shapes never move relative to each
other, and the arithmetic behind that looked strong: a game whose frame is JavaScript with the GPU
idle, 1,561 meshes, and ~2 microseconds of three.js work per object per pass implies about 5 ms of a
16 ms render that fewer objects would delete.

Measured on that game, a per-material merge (material, `castShadow`, `receiveShadow` and the layer
mask all part of the bucket key, animated and game-toggled subtrees skipped) replaced **246 parts
with 61 meshes: 1,561 -> 1,376**, and moved nothing - 46.5 fps against 48-51 for the same build
without it, inside that run's own spread. The reason is in the buckets: of 459 meshes it could even
consider, **274 buckets held 213 singletons**, because an imported model carries a material per
part. A merge can only collapse parts that share a material, so a scene authored that way has
almost nothing to collapse; the rest of the population sat inside subtrees the game toggles per
object and correctly refused to merge.

So the lever is real but its size is a content property, and the number to read before promising
anything is the bucket census, not the object count. A scene that wants it needs shared materials -
an atlas, one material per hull - or repeated shapes for `InstancedBatch`. Where neither is true,
"fewer objects" is not available, and the remaining lever is moving the walk itself.

**What a C++ traversal would actually recover, priced against the profile rather than the slogan.**
The per-object block on the measured scene is 32.4% of a 16.1 ms JS frame (5.22 ms). Split by what
each entry is, not by which file it lives in: traversal — the walk plus the frustum and projection
tests that build the render list — is 3.71 ms of it (project 1.48, matrix walk 2.22), and per-draw
bookkeeping keyed on JavaScript object identity is 1.51 ms, inside three.js's own
`_renderObjectDirect`: `_objects.get`, `_nodes.needsRefresh`, `_geometries.updateForRender`,
`_bindings.updateForRender`, `_pipelines.updateForRender`. The shadow lane is a second full walk of
the same machinery, so these numbers are paid per pass.

Moving traversal to C++ behind the existing frame-op stream, staying inside the charter (three.js
stays the renderer), recovers **1.1-1.9 ms of a 20.2 ms frame — 49.5 to about 52-55 fps** — because
the other 60% of the block is either the matrix walk three consumes on the same frame or bookkeeping
whose key is a JS object. It cannot reach the 3.7-4.6 ms that "move traversal to C++" suggests. It
would also have to publish about 187 KB per frame of compiled traversal output (against 17% of
today's packet; 104 KB of that is command overhead), which is a real cost the transport already
measured once in PR #275.

The comparison that matters: where a scene shares materials or repeats shapes, batching with the
capabilities the engine already ships recovers as much or more (2.0-2.9 ms) for no engine work at
all; where it does not — as measured above — batching recovers nothing and the walk is what is left.

**A trap worth naming, because it produced a confident wrong number.** The first arm of this
experiment embedded a *stale* `generated/runtime_scripts.h`: the game build copies a host binary
(`THREENATIVE_RUNTIME_BINARY`), and that host had been linked before the install script's shape fix,
so the script was present as text but never ran. `__tnAudioDecodePending` was missing, every one of
the 146 audio loads failed, **no decode happened at all**, and the launch looked ~1.2 s faster in
six of six pairs because the work had been deleted rather than moved. The audio playtests failed
(0 cues played) and that is the only reason it was caught. Before measuring an arm, confirm the
*executed* artifact carries the change — `strings <game binary> | grep <new marker>` — not just the
source tree.

**Honest gap: this box is shared, and both obvious metrics fail on it.** A paired series taken at
1-minute load 10-32 read the *incumbent* binary 13% slower than the baseline above, which compares
the neighbours rather than the code; that series is retained as `raw/exp-01-confounded/`. A
second attempt at a robust lane measured the host process's own CPU time at each
`TN_FRAME_BUDGET` window boundary (CPU excludes the waiting a preempted thread does) and closed
itself the same day: at load 33 the *unchanged* binary read **68.7 ms frame p50 and 85.3 ms of
process CPU per frame**, against 15.0 ms and ~15 ms on a quiet run. Roughly 5x inflation in the
work itself, not only in the waiting — cache and memory pressure at 11 resident CPU hogs. So no
metric this record can take is comparable while the machine is loaded, and `tools/run-pairs.sh` now
refuses to start a pair above 1-minute load 4 and abandons one above 8. Any number in this file
taken during such a window is not comparable and is marked as such where it appears.

## Midway native probe — desktop steady state, the load stall, and a desktop perf-series gap — 2026-09-17

**Subject:** the tarball sandbox game `sandbox/midway-open-pacific`, packaged desktop binary built
2026-09-17 15:54 from `develop@dae7c94`; engine checkout `develop@feee5699c`. Machine: RTX 2080
(Vulkan/Dawn), 59.96 Hz display. Every number below is the package's own instrument
(`TN_FRAME_BUDGET`, `TN_HOST_GAP`, `TN_FRAME_HITCH`, `TN_STARTUP_WARMUP`, the startup timeline),
plus `/proc/<tid>/stat` CPU sampling and gdb main-thread backtrace sampling of the packaged binary.
The probe was asked to judge whether the native target is smooth, not to land a fix; nothing here
has been changed.

**Airborne steady state, real display, 1280×720, `resolutionScale 1` (auto), `sampleCount 4`,**
both arms the same scenario, the same pixels and the same adapter (browser `adapter.info` =
`nvidia/turing`):

| arm | windows | fps | frame p50/p95 | render p50/p95 | update p50 | hostGap p50 | gpuMs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| native desktop | 2–5 | 38.7–41.3 | 21.4–22.9 / 27.8–29.6 | 17.1–18.3 / 20.8–23.0 | 2.2–2.7 | 2.1–2.9 | 2.1–2.7 |
| browser, private Xvfb, same game | 3 | 36.9 | 13.9 / 21.0 | 13.9 / 20.9 | 0.0 | 12.4 | 1.45 |

The airborne native frame is **CPU-bound with the GPU ~89 % idle**: `render` owns 17–18 ms of a
22 ms frame against a 2.2 ms GPU frame. Native is ~40 fps here, not the 60 the game's
`display.maxFps` asks for. The two arms are not the same camera instant — the browser lane is
stepped by the playtest bridge and reports `update 0.0` — so the *ratio* is not a parity verdict;
the comparable claim is that native pays ~+3.3 ms of `render` at matched pixels, and that on both
runtimes the frame is CPU work, not GPU work. PRD-329's matched-pixel pair remains open on desktop.

Not a defect, but a comparability trap: on the briefing screen the native build renders the world
behind the UI (frame p50 15.9 ms, render p50 12.7 ms, gpuMs ~2.2) while the web build draws nothing
(frame p50 0.2 ms). `src/ui/native.css` makes `html, body, #tn-ui` transparent precisely so the
world shows through the briefing, so the native frame is the visible one — an idle-screen comparison
across the two targets measures two different pictures.

**Load: 30–41 s to ready, all of it on one thread.** Startup timeline, same scenario:
`loadStartedMs 598 → enteredMs 30607 → compileSettledMs 34062 → readyMs 34062` natively, and
`790 → 5300 → 6575 → 6575` in the browser. The native main thread is at 98–99 % CPU for the whole
load (`/proc` sampling at 0.5 s over 92 s) — it is not waiting on I/O. `TN_FRAME_HITCH` records
25.6 s and 2.4 s gaps after the first presented frame at 3.6 s; `TN_STARTUP_WARMUP` then spends
4.3 s on 1 680 candidates → 57 pipelines. 37 gdb backtraces of the main thread during the load
classify as: **38 % inside `stbi_load_from_memory` / `VP8Decode`, every one reached through
`handleWebGpuDecodeImageData`**; 8 % inside `stb_vorbis` via `mystral::audio::decodeAudioFile`;
~14 % V8 GC/parse/allocation; 3 % canvas context creation; 38 % unresolvable V8 JIT frames.

Both decoders are synchronous on the calling thread and are engine-owned: `__decodeImageData`
(`webgpu/bindings.cpp:1086-1145`) calls `stbi_load_from_memory`/`WebPDecodeRGBA` inline, and
`decodeAudioData` (`audio/audio_context.cpp:525` via `audio/audio_bindings.cpp:477-498`) calls
`decodeAudioFile` inline. The run decodes 326 images totalling ~338 Mpx (222 bundle reads,
172.9 MB, of which 25 GLB = 144.9 MB) and 146 Ogg clips (146 clips measured 5.2–6.3 ms each).
Measured on this host: 2048×384 PNG 8.6 ms (89 Mpx/s), 2048×2048 WebP 38 ms, i.e. ≥ 3.4 s of image
decode plus ~0.9 s of audio decode serialized on the main thread. `assets.ts:894` routes the native
target through `createImageBitmap` into that inline decode; the same call in Chrome is off-thread
and parallel, which is the shape of the 5–7× load gap. The remaining load time is not attributed:
the game's own `rear-station.ts:398 normalFromHeight` is a per-pixel JS loop and is 8.5 % of the
browser load (measured by CDP profile: `_copyImageToTexture` 15.2 %,
`normalFromHeight` + its closures 8.5 %, GLTFLoader/`fromBufferAttribute`/`convertBufferAttribute`
~5 %, idle 9.1 %), and identical JS microbenchmarks run at parity on both engines (native 3.03 /
2.66 / 6.72 ms vs Chrome 3.42 / 2.62 / 4.83 ms), so the native load is not a V8 handicap.
`webgpu/bindings.cpp:1509-1553 copyExternalImageToTexture` also does a full-image `std::vector`
staging copy with a per-pixel premultiply/swap before `wgpuQueueWriteTexture`; it was not isolated.

**Two engine defects found while probing, neither yet fixed.** `createOffscreenCanvas2D(w,h)
.getContext('2d')` returns **null** — `handleOwnedHtmlCanvasElementGetContext`
(`webgpu/bindings.cpp:1022-1026`) is a stub returning `newNull()`, while the comment above its
installation says it "returns the pre-created context". And a native-only WebGPU validation error
fires at startup: a 1×1 `Depth24Plus` dummy bound at fragment binding 9 where the layout expects a
multisampled depth texture; it is 4 of the desktop run's console errors, so the game's native
playtest currently fails its `diagnostics` assertion on desktop.

**Harness gap: the desktop lane reports an empty `performanceSeries`.** A scenario carrying
`assert.performance { minFps: 1 }` ran against `--target desktop`, advertised `runtime.performance`
in its capability handshake, and failed the assertion with `sampleCount: 0, valid: false` and
"observed unavailable"; the same assertion passes on the browser lane. The desktop run's own
diagnostic points at "the `TN_FRAME_BUDGET` marker for this run", and that marker is not in the run's
`observations.console` either (2 373 entries, 79 of them `TN_PIPELINE_EVENT`). Until a desktop run
carries a live frame series, no native frame time is gateable and PRD-222 Tier 2's parity assertion
cannot run on desktop.

**Next bounded experiment, in order of what it closes:** (1) fix or wire the desktop
`performanceSeries` so a native run can be bounded at all — the `assert.performance` path exists on
web and desktop-alike in `packages/playtest`; (2) attribute the 38 % JIT share with a built host
(`-DTN_ANDROID_JS_PROFILE=ON`, bridge/per-call attribution) rather than guessing; (3) only then
pre-register the decode/packaging lever, since `method rule 6`'s `calls/frame × ns/call` predicts
zero for a steady-state frame — its number is load time, not fps.

## Compiled frame plan transport (v3) — native compiled frame plans — 2026-09-17

**The default-off v3 transport costs the JS recorder 35–41% less per frame and carries 94.8–99.5% fewer
bytes on draw-heavy frames. On the desktop lane it is now neutral (1.3% faster by median, inside the
±1.5% run-to-run spread) after a frame that cannot be patched stopped being copied.**

Method: `node packages/runtime-native/scripts/measure-frame-plan-transport.mjs --frames=120`
(branch `perf/compiled-frame-plans-20260917`), Node 20.19.6, AMD 5900X. A CPU-only microbenchmark of
the transport against a device and queue that record nothing: no GPU, no renderer, no game, and no
frame-rate claim. The scene is one render pass with `--draws` repeated setPipeline / setBindGroup /
setVertexBuffer / setIndexBuffer / drawIndexed groups and `--uploads` uniform buffers rewritten whole
every frame; medians over 120 frames after a 5-frame warmup. `v2` is the stream every shipped frame
sends today, `v3` the capture-then-patch plan.

| scene | v2 total ms | v3 total ms | CPU | v2 packet | v3 packet | bytes |
| --- | --- | --- | --- | --- | --- | --- |
| 2000 draws, 64 × 256 B uploads (default) | 0.976 | 0.580 | −41% | 338,120 | 17,432 | −94.8% |
| 20000 draws, 64 × 256 B uploads | 10.199 | 6.491 | −36% | 3,218,120 | 17,432 | −99.5% |
| 200 draws, 32 × 64 KiB uploads, all new | 0.649 | 0.702 | +8.2% | 2,130,120 | 2,130,128 | 0% |

`total` is encode plus drain JavaScript per frame. Four mechanisms carry it:

1. **Per-frame wire ids.** Encoder, render pass, compute pass and command buffer ids restart every
   frame in plan mode, so a record that did not move is the same bytes as last frame's — before
   this, one pass id moved and invalidated every record inside the pass. A stale holder from an
   earlier frame is refused by name (`stale render pass from an earlier frame`) instead of naming
   whatever object inherited its id. Resource ids stay monotonic, assigned once at creation.
2. **A value check at the call site.** Each reusable record compares the values that decide its
   bytes — pass, pipeline, bind group, counts, offsets — against the ones the retained plan was
   recorded from, in one allocation-free call. Equal means the plan already holds the record, so
   nothing is encoded and nothing is sent: 10,004 of 10,069 records in the default scene are reused
   on a steady frame.
3. **A capture the arena already holds.** A frame that cannot be patched — a layout change, a
   dropped plan, a host that reports a plan it no longer holds — is handed over as the arena with a
   header written in front of it, and the buffer the old plan used becomes the next arena. Before
   that, every such frame was assembled into a fresh buffer first, one full copy per frame.
4. **A guard that bounds the loss.** When the changed bytes *are* the payload there is nothing to
   elide, so a frame that rewrote most of itself above a 64 KiB floor is sent whole rather than
   diffed, applied and carried. That is what holds the third row at +8.2% instead of the +260% the
   same scene cost before the guard existed; such a frame is 2 MB of fresh upload per frame, which
   the GPU spends anyway.

The default path pays for the plan check it does not use: `frame-op-stream.js` at `main` measures
0.79–0.82 ms and with the plan call sites present 0.89–0.94 ms on the same scene, +8% of the
recorder's own frame (≈7.5 ns per record for the `planMode` branch), which is under 1% of a 16 ms
frame. Plan mode is off unless `TN_FRAME_PLANS=1` sets `host.compiledFramePlans`.

### Desktop lane, flag on and off — 2026-09-17

**Neutral: 1.3% faster by median over six interleaved pairs, inside the ±1.5% spread of the runs
themselves. The earlier +2.6% loss was the per-frame capture copy that mechanism 3 removed.**

Method: `SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy sh scripts/xvfb.sh
packages/runtime-native/build/tn-linux/mystral run examples/native-smoke/dist/native-smoke.js
--frames 300`, six pairs of runs alternating the arms so drift lands on both, `TN_FRAME_PLANS=1` in
the "on" arm, RTX 2080 (Vulkan), Xvfb, no emulator running. The native host with the packaging
default scene, not a game.

| arm | runs (ms) | median | per frame |
| --- | --- | --- | --- |
| plan off | 10116, 10318, 10175, 10184, 9860, 9855 | 10,146 | 33.8 ms |
| plan on | 10065, 10283, 9967, 10170, 9906, 9919 | 10,016 | 33.4 ms |

`TN_HOST_GAP` explains why no frame-level result is available on this lane: `present` is 29.4 ms of
the 33 ms period (89%), so the frame is the display, not the recorder. Three metered pairs of the
same run put the transport's own phases side by side:

| arm | periodP50 | frameDrain | frameReplay | present |
| --- | --- | --- | --- | --- |
| plan off | 33.06 / 32.90 / 32.66 | 0.002 | 0.079 / 0.087 / 0.079 | 29.6 / 29.5 / 29.3 |
| plan on | 33.33 / 33.38 / 33.49 | 0.081 / 0.081 / 0.084 | 0.204 / 0.207 / 0.185 | 29.6 / 29.7 / 29.9 |

The same scene at 320×180 is pinned to the presentation cap instead: period p50 16.67 ms with a
JavaScript budget of 1.7–1.9 ms per frame (period mean minus the sum of the host segments), of which
the recorder is ~0.3 ms — about 17% of the JS and 2% of the frame, which is why the arms stay inside
the spread here too. Uncapping that lane needs `maxFps` embedded in the bundle: `mystral compile`
bundles the entry alone, and both the compiled and the loose run against a hand-written
`.threenative/config.json` still booted with `Presentation cap: 60 fps`, so the lane could not be
uncapped here.

The plan arm's drain costs 0.08 ms (building the patch and folding it back into the plan) and its
replay costs 0.08–0.12 ms more than the v2 replay, which is a 2.5× on that phase and larger than the
patch application can explain: it is the one number here worth chasing if activation is ever
pursued, and it is not chased in this increment. Against the ~0.35 ms the recorder stops spending
per frame, the lane lands inside its own ±1.5% spread either way. Screenshots from the
two arms are not comparable — the scene animates, and every run differs from every other, arms
included — so visual equivalence rests on the contract's pixel readback and the byte-equality tests
below, not on these images.

Proven separately from this measurement: `frame op stream replay contract passed` runs the same
recorder through the real C++ decoder, asserts one capture then patched frames, reads a patched
upload back off the GPU as `[3,4,5,6]`, and rejects thirteen malformed v3 packets without entering a
backend call. It also renders the same two frames on both transports with only the clear colour
moving and compares the pixels read back from each arm (with a negative control that the comparison
moves when the colour does); drives a `mapAsync` that splits a frame and asserts the prefix ran
before the map resolved, the tail replayed at the next boundary, and the plan recaptured after; and
destroys the device to prove a recreated one replays a capture naming its own resources.
`tests/frame-plan-transport.test.mjs` proves a patched plan is byte-identical to the frame it
replaces, that a frame in which nothing moved carries a 24-byte packet with no entries, and that a
reused record still reads the resource ids that keep its objects alive.

## PRD-217 desktop WebView overlay on/off — 2026-09-12

**Uncapped throughput on a software-composited Xvfb lane: the overlay costs ~12–15% frame time here.
This is not the presented frame-rate regression and not a real-display claim; the criterion's
number is the vsync-capped real-display result below.**

PRD-217 acceptance criterion 4 is recorded against the historical real-display measurement (overlay
attached 59.99 fps / 16.44 ms vs none 59.95 fps / 16.43 ms, 0.07% apart, both vsync-capped —
`prd-217-criteria-1-and-7-2026-08-24.md`), which bounds the overlay's *presented* cost on a 60 Hz
display. The Xvfb lane below is the separate throughput question the skill warns not to label as
presented FPS: with vsync removed, how much work does the overlay add?

Platform: Linux, X11 on `Xvfb :3` + the `xcompmin` software compositor, NVIDIA RTX 2080 (Vulkan),
branch runtime `build/tn-linux/mystral`. Both arms are the packaged default starter, windowed
1280×720, `display.maxFps: 240`, `--no-vsync`; the only difference is the overlay. Method: the
runtime's `TN_FRAME_BUDGET` steady windows (300 frames each, startup window discarded), read with
`threenative-playtest perf`.

| arm | steady windows | fps (marker) | frame p50 / p95 ms | host-gap present p50 ms |
| --- | --- | --- | --- | --- |
| overlay off (`ui.renderer: native`) | 7, 8, 9 | 21.45 / 21.77 / 21.96 | 8.6/11.7 · 8.8/11.4 · 8.3/11.3 | 34.7 |
| overlay on (`ui.renderer: web`) | 5, 6, 7 | 19.75 / 18.58 / 19.04 | 9.2/14.7 · 10.1/15.6 · 9.7/14.4 | 40.1 |

Median-of-windows frame p50: 8.6 ms off vs 9.7 ms on → +12.8%; marker fps 21.8 → 19.1 → −12.4%;
present host gap 34.7 → 40.1 ms → +15.5%. The software compositor blends the overlay's ARGB window
on the CPU, so this likely overstates a GPU-composited desktop. A GPU-composited real-display
rerun of the uncapped arm, and a compositor-cost reduction if it holds there, are the follow-ups;
the criterion's own vsync-capped number stands as recorded in the archived PRD.

## PRD-368 bounded cache API prototype — 2026-09-09

**API feasibility only; implementation paused for the owner's follow-up handoff.** A four-file
patch to pinned wgpu-native `v25.0.2.2` exposes the existing Rust cache implementation through C,
including feature request/mapping, strict import, owned byte export and render/compute descriptor
attachment. No production dependency, host lifecycle, game or Android APK received this patch.
The [updated PRD](../PRDs/assets/PRD-368-compiled-pipelines-survive-a-relaunch.md) owns remaining work.

Retained reproduction inputs: [upstream patch](startup-measure-reduce-2026-09-09/pipeline-cache-spike/wgpu-native-v25.0.2.2-cache.patch),
[C++ probe](startup-measure-reduce-2026-09-09/pipeline-cache-spike/cache_probe.cpp),
[commands](startup-measure-reduce-2026-09-09/pipeline-cache-spike/commands.txt), and
[identity/limitations receipt](startup-measure-reduce-2026-09-09/pipeline-cache-spike/receipt.json).
The [unpatched link fails](startup-measure-reduce-2026-09-09/pipeline-cache-spike/red.log) on missing
cache symbols; the [patched release build passes](startup-measure-reduce-2026-09-09/pipeline-cache-spike/build-clang18.log)
using the installed NDK libclang after system libclang 22 produced invalid opaque bindings.

Three separate Linux/Vulkan processes on NVIDIA RTX 2080, driver 610.57.04, produced the
[raw round-trip result](startup-measure-reduce-2026-09-09/pipeline-cache-spike/roundtrip.log):
empty attached cache grew from 100 to 13,573 bytes; strict reload accepted those bytes; attachment
bypass left an empty cache at 100 bytes. All three readbacks are byte-identical. Pipeline creation
was 7.033701 ms empty, 0.610847 ms loaded, and 0.319588 ms disabled. **The disabled control is faster;
this does not establish a performance benefit.** The synthetic triangle establishes an executable
API route, not actual Bayview reuse, a per-pipeline hit, safe app-private persistence or phone timing.

Independent source review identified two required integration controls: the host's async descriptor
copy strips `nextInChain`, and upstream cache compatibility checks do not checksum payload bytes.
Preserve the cache extension/handle through worker completion and verify a bounded envelope digest
before unsafe import. Strict load rejection must lead to an explicit empty-cache miss; a nonnull
handle alone cannot establish reuse. Corruption, concurrency, device loss and real host proof remain
unexecuted. The PRD now specifies these next actions; no acceptance box was marked complete.

## PRD-367 actual-device census repair — 2026-09-09

**In progress; no startup improvement or PRD acceptance is claimed.** The owner selected reliable
measurement, then appearance-preserving Bayview graph reduction, with a bounded native cache patch
considered only if the measured result still warrants its maintenance. The proof subject is the
original `/home/joao/projects/threenative/sandbox/prd360-bayview-live`; the Wildwood result below
does not substitute for its acceptance. The engine checkout starts at `488c05696` (current upstream
integrated with the local canonical PRDs). Game source/assets were hashed before intervention in
[the source manifest](startup-measure-reduce-2026-09-09/bayview-source-before.json). These are
untracked game files, not an asserted clean game commit. Only package pins and the separate Android
application ID changed before the captures below.

### Native reporting follow-up after PR 165

The unchanged candidate APK now completes the actual Android movement scenario; the earlier
missing-bridge failure did not reproduce, and its cause remains unproven. Its paired capture
reconciles 104 creations, 86 programs, zero pending/failed/dropped events and 102 renderer lookups.
Native events do not observe lookups; pairing now preserves the renderer's observed lookup count
while retaining native authority over creation counts, timing and the capture boundary.

The shared device runner previously discarded `waitForStartupReady()`'s outcome. It now forwards
that existing startup observation to `buildReport()`, matching the browser runner. A real Pixel
scenario with `maxReadyMs:8000` now fails on **17,909.374276 ms observed**, with movement and runtime
diagnostics passing. This is readiness, not first-playable time, and AC charging disqualifies the
run as performance acceptance. The [receipt and exact invocation](startup-measure-reduce-2026-09-09/reporting-followup/readiness-receipt.json)
and [scenario](startup-measure-reduce-2026-09-09/reporting-followup/readiness.playtest.json) retain that scope.

Observed red: [lookup count](startup-measure-reduce-2026-09-09/reporting-followup/lookups-red.log)
expected 7, received 0; [device startup tests](startup-measure-reduce-2026-09-09/reporting-followup/native-startup-red.log)
failed 2 cases because the timeline was absent. Restored behavior:
[65 focused tests pass](startup-measure-reduce-2026-09-09/reporting-followup/reporting-green.log),
and [playtest typecheck exits 0](startup-measure-reduce-2026-09-09/reporting-followup/reporting-typecheck.log).
Independent review found and then cleared a fixture typing error; it confirmed native authority,
browser/device parity and missing-observation behavior. Follow-up `pnpm typecheck`, `pnpm lint`,
`pnpm test` (4,774 root tests passed, 8 skipped), `pnpm build`, `pnpm budgets` and
`pnpm test:playtest` all exited 0; [bounded gate output](startup-measure-reduce-2026-09-09/reporting-followup/gates.txt)
retains the results and full-log hashes. This slice changes the report layer; its Android scenario
uses the unchanged installed candidate APK.

### Equivalent shaders retained process-wide buffer names

**Engine layer:** Three's WGSL builder overwrote its program-local uniform name with a global
allocation ID. Independently allocated buffers therefore produced different shader source even
when their types, lengths and uses matched. The owned Three patch now preserves the base builder's
unique program-local name; explicitly authored names, buffer objects, visibility and binding order
remain intact. Both `src/` and the shipped `three/webgpu` bundle carry the fix. Core's existing
postinstall consumes the patch; the scaffold copy distributes the same bytes.

The [red](startup-measure-reduce-2026-09-09/stable-buffer-names/red.log) compares actual WGSL
declarations from independently allocated equal-capacity projected batches: only `NodeBuffer_<id>`
differs. The [focused green](startup-measure-reduce-2026-09-09/stable-buffer-names/green.log) passes
23 tests. Independent [browser review](startup-measure-reduce-2026-09-09/stable-buffer-names/review-verdict.json)
observed two shader modules across repeated capacity-16/capacity-48 batches, separate moving/stationary
buffer contents, correct previous-frame motion and an error-free forced WebGL fallback.
Raw [WebGPU](startup-measure-reduce-2026-09-09/stable-buffer-names/review-webgpu.json) and
[fallback](startup-measure-reduce-2026-09-09/stable-buffer-names/review-fallback.json) reports retain those observations.

A preceding storage-buffer experiment was rejected: it did not reduce whole-town program counts,
retained buffers across repeated batch replacement and failed the fallback draw. Its
[rejection](startup-measure-reduce-2026-09-09/stable-buffer-names/rejected-storage-verdict.json) is
retained; no storage-buffer change remains in the accepted source.

| Actual whole-town target | Original programs | Tint uniforms | Tint plus stable buffer names |
| --- | ---: | ---: | ---: |
| Browser, NVIDIA/Turing | 79 | 71 | 52 |
| Native desktop | 84 | 76 | 56 |
| Pixel 8 | 92 | 86 | 63 |

The browser and desktop meet one-third program reduction; Pixel's 31.5% does not. Receipts:
[browser](startup-measure-reduce-2026-09-09/stable-buffer-names/browser-receipt.json),
[desktop](startup-measure-reduce-2026-09-09/stable-buffer-names/desktop-receipt.json),
[Pixel original](startup-measure-reduce-2026-09-09/stable-buffer-names/android-original-receipt.json),
[Pixel candidate](startup-measure-reduce-2026-09-09/stable-buffer-names/android-receipt.json).
The candidate's [paired native capture](startup-measure-reduce-2026-09-09/stable-buffer-names/android-paired.json)
reconciles 84 creations, 63 programs and zero failures/pending/dropped events. All movement and
runtime assertions passed. Pixel readiness remained 16,500.797697 ms, failing the 8,000 ms gate.
Full inputs: [browser census](startup-measure-reduce-2026-09-09/stable-buffer-names/browser-census.json),
[desktop census](startup-measure-reduce-2026-09-09/stable-buffer-names/desktop-census.json),
[Pixel census](startup-measure-reduce-2026-09-09/stable-buffer-names/android-census.json) and
[native events](startup-measure-reduce-2026-09-09/stable-buffer-names/android-native.log).
These phone runs were AC-charging, and their screenshots carried Android's known debug APK
alignment notice; they do not prove qualified timing, first-playable time or unobstructed appearance.
The notice was subsequently acknowledged on the test app for fresh visual checks.

[Package identity](startup-measure-reduce-2026-09-09/stable-buffer-names/cohort.json) and
[APK identity](startup-measure-reduce-2026-09-09/stable-buffer-names/apk.sha256) freeze the candidate.
The runtime implementation slice is the root/core patch copies, lockfile and regression test.
The separate distribution slice is the template patch copy and scaffold hash fixture. Independent
[scaffold proof](startup-measure-reduce-2026-09-09/stable-buffer-names/scaffold-proof.json) generated
all ten projects: replacing only the copied patch with its prior version recovered every old tree
hash. The initial full test run passed 4,774 tests and failed only the expected old scaffold hash
assertion; after refreshing that fixture, the final full test, build, browser playtest, scaffolded
template, and native desktop display gates passed against the merged census fixes. The retention
index and documentation checks are rerun as part of this shipping commit.

### Observed defects and bounded repairs

This is the engine observation layer: games cannot portably observe their WebGPU backend and
native compiler threads. Native shader hashing used a truncated FNV-1a offset, so the same UTF-8
source disagreed across JS/native. Native pipeline handles were also replaced by local JS ordinal
identities, preventing a reliable join. The collector now preserves the native handle and the hash
uses the correct offset. The actual compiled C++ negative control reported:

```text
pipeline source hash mismatch: expected cbf29ce484222325, observed 14650fb0739d0383
```

The rebuilt `threenative-webgpu-comprehensive-test` passed the empty, ASCII and UTF-8 golden vectors
and its native WebGPU contract. Core identity tests passed `6/6`. The paired parser joins the
renderer census and native log from one process by native handle, then validates kind, status, mode
and stage hashes/byte lengths. It retains native clocks and service time, adds observed renderer
provenance, and keeps unmatched native utility work explicitly unknown. A depth-only pipeline does
not require a fragment shader. Parser regressions passed `19/19`; dropping a required joined event
or changing a stage hash fails. Raw [hash red](startup-measure-reduce-2026-09-09/hash-red.log),
[identity red](startup-measure-reduce-2026-09-09/identity-red.log),
[identity green](startup-measure-reduce-2026-09-09/identity-green.log),
[join red](startup-measure-reduce-2026-09-09/join-red.log),
[utility red](startup-measure-reduce-2026-09-09/join-utility-red.log) and
[parser green](startup-measure-reduce-2026-09-09/join-utility-green.log) are retained.

### Real-game checks before device-coverage repair

The game used [content-hashed package tarballs](startup-measure-reduce-2026-09-09/packages.json).
The Android candidate `com.threenative.bayview.startup` was installed alongside the original app;
the installed APK matched local SHA-256
`868f162686a02b017aae8ebaed6bdd28cf86da70a123b285325ef273a871916c`.
Its [identity record](startup-measure-reduce-2026-09-09/android-identity.json) explicitly records
charging. All three scenarios passed movement and runtime checks, but completeness is narrower
than the original renderer report claimed:

| Target | Renderer creations / programs | Native device events | Remaining observation gap |
| --- | --- | --- | --- |
| Browser, NVIDIA Turing WebGPU | 97 / 78 | unavailable in this collector revision | Direct device utility creations bypass the backend wrapper |
| Desktop, V8/Dawn | 92 / 83 | 94 | Two mipmap creations omitted; process killed before completion marker |
| Pixel 8 over Wi-Fi ADB | 108 / 91 | 110 | Two direct creations omitted; force-stop bypasses completion marker |

Retained inputs: [browser census](startup-measure-reduce-2026-09-09/browser-baseline/census.json),
[desktop census](startup-measure-reduce-2026-09-09/desktop-baseline-audio/census.json),
[desktop native events](startup-measure-reduce-2026-09-09/desktop-baseline-audio/native.log),
[Android census](startup-measure-reduce-2026-09-09/android-functional/census.json) and
[Android native events](startup-measure-reduce-2026-09-09/android-functional/native.log).
The paired parser correctly returns incomplete for both native logs. Browser's `complete: true`
describes the old backend-only observation and is not accepted as whole-device completeness.
The phone was USB powered, so these events support identity/debugging only, not qualified launch
timing. The first desktop attempt failed because this machine has no ALSA device; the rerun used
`SDL_AUDIODRIVER=dummy` and passed. Browser used `--browser-recipe webgpu --headed` and the runner's
private display; the reported adapter was NVIDIA, not SwiftShader.

Opus medium implementation arms are repairing direct-device coverage and live native checkpoint
validation; Codex owns review and coordinated real-game verification. Acceptance remains open for
complete captures, observer overhead, doctor integration, qualified Pixel timing, full repository
gates, and human timing/appearance review. No material graph has changed in Bayview at this point.

### Live native checkpoint reaches the actual town

The rebuilt native host passed the existing desktop movement scenario with the earlier installed
core package cohort. This independently tests the C++ checkpoint before installing the new device
collector. It emitted two changed-count checkpoints; the last reported
`present:2, requested:94, emitted:94, outstanding:0`. Pairing the 92 renderer events with the 94
native events returned `complete:true`, 84 source programs, zero failures/pending/dropped events,
and `boundary.kind:checkpoint`; the two native utility creations remain explicitly unknown.
The real run [receipt](startup-measure-reduce-2026-09-09/desktop-checkpoint/receipt.json),
[census](startup-measure-reduce-2026-09-09/desktop-checkpoint/census.json),
[native events](startup-measure-reduce-2026-09-09/desktop-checkpoint/native.log) and
[summary](startup-measure-reduce-2026-09-09/desktop-checkpoint/summary.json) retain this scope.

```sh
SDL_AUDIODRIVER=dummy node packages/playtest/dist/runner/cli.js \
  docs/verification/findings-2026-09-07-bayview-fix/manifest.playtest.json \
  --target desktop \
  --executable /home/joao/projects/threenative/sandbox/prd360-bayview-live/dist-native/fps-framework \
  --timeout 60000 --artifacts artifacts/startup-measure-reduce/desktop-checkpoint
```

Actual result: exit `0`, report `pass:true`. The source parser consumed the paired object after
capture; this result does not yet prove `doctor --capture paired.json`. Independent review
reproduced three parser defects: escaped markers inside a paired JSON file fail parsing; an event
placed after the checkpoint that already claims it can incorrectly pass; and an outstanding count
of one is displayed beside `counts.pending:0`. The core partial-hook negative control also reported
complete after observing one of two device creations. These review cases were repaired before
the integrated build below. Independent review then passed all 49 focused collector/parser tests
and parsed the actual paired checkpoint from file bytes with 94 creations, zero outstanding and
`complete:true`.

### Measured Bayview tint-uniform comparison — 2026-09-09

One integrated observer build was frozen for every capture below: `pnpm build` exit `0`, then
content-hashed tarballs installed into the live game — core
`4fbdbc5977a63e01d9810ec4815a2ee5fbfa908a777f690105042257e89b42e9`, playtest
`4ee2fe099cee0d7a383696a5806d980c468257e8d004a4b5690f0d67ec29b94e`; the repacked runtime-native
tarball was byte-identical to the installed one, so its pin did not move. The native host stayed
at `18ec7a3d12b5b51732c60de16e8a773a1614f4e274dd82cfdde0d1654778e588`.

The only game change is [one hunk in `src/render/townMaterials.ts`](startup-measure-reduce-2026-09-09/material-tint-uniform/townMaterials.diff):
the `paving`/`concreteTrim`/`painted` family carried its `tint` and `tintAlt` hexes as `color()`
literals, and now carries them as per-material `uniform(color())`. Nothing else moved — no new
abstraction, flag or material name, and the game's own `tsc --noEmit` passed on both sources.
Original source is `51f9ef9e8ae45efc433d9494e2deb977d4d5bb37b7b9639ea518da355bc38413`, candidate
`38c14f4c6ba34793764a1414696e20831b778e26a6a67a7fe68db2cddeab1a6f`.

| Target | Programs, original | Programs, candidate | Creations, original | Creations, candidate |
| --- | --- | --- | --- | --- |
| Browser, NVIDIA Turing WebGPU | 79 | 71 | 99 | 91 |
| Desktop, V8/Dawn, RTX 2080 | 84 | 76 | 94 | 86 |

Fourteen runs are recorded in [the comparison record](startup-measure-reduce-2026-09-09/material-tint-uniform/program-comparison.json)
and every one of them reported the counts above for its arm: four browser runs of the original,
three of the candidate, three desktop runs of the original, four of the candidate. Every census was
complete and non-empty with zero failures, pending and dropped events, and each reported the two
direct device utility creations the repaired collector now sees. Raw censuses are retained for
[browser original](startup-measure-reduce-2026-09-09/material-tint-uniform/baseline-browser-census.json),
[browser candidate](startup-measure-reduce-2026-09-09/material-tint-uniform/candidate-browser-census.json),
[desktop original](startup-measure-reduce-2026-09-09/material-tint-uniform/baseline-desktop-census.json) and
[desktop candidate](startup-measure-reduce-2026-09-09/material-tint-uniform/candidate-desktop-census.json).
The actual built `doctor --capture paired.json --text` consumed the desktop pairs and exited `0` on
both, reporting a live checkpoint at present 2 with 0 outstanding:
[original](startup-measure-reduce-2026-09-09/material-tint-uniform/baseline-desktop-doctor.txt),
[candidate](startup-measure-reduce-2026-09-09/material-tint-uniform/candidate-desktop-doctor.txt).

**The whole reduction is the eight programs the change targets.** Grouping browser programs by
observed provenance, only one bucket moves: the unnamed `MeshStandardNodeMaterial` bucket falls
from 29 to 21 unique programs. The glTF `MeshStandardMaterial` bucket (32), the basic, output,
background and PMREM buckets are unchanged. That is −10.1% of browser programs and −9.5% of desktop
programs. **The PRD's one-third target is not met** and no launch-time speedup is claimed here.

The negative control restored the exact original file, not an invented perturbation, and reran the
same browser program gate: it returned to 79 programs and 99 creations, matching the baseline
exactly, and the candidate then returned to 71/91. The two arms are not the same source measured
twice.

Appearance was checked at a fixed checkpoint — no input, spawn camera, 1280×720 — because the town
animates and two runs of one source are not bit-identical.
[The metrics](startup-measure-reduce-2026-09-09/material-tint-uniform/appearance-checkpoints.json)
give the same-source noise band as mean channel delta 1.31–1.34 over 5.1–5.4% of pixels; the three
cross pairs read 1.84, 2.40 and 2.91 over 5.5–6.4%. Mean frame luminance spans 94.26–94.63 across
all four frames against a 94.26–94.36 same-source spread. So the candidate is **not** proven
pixel-identical, and it is also not shifted in mean luminance by more than 0.4%. The
[original](startup-measure-reduce-2026-09-09/material-tint-uniform/appearance-original.png),
[candidate](startup-measure-reduce-2026-09-09/material-tint-uniform/appearance-candidate.png) and
[difference](startup-measure-reduce-2026-09-09/material-tint-uniform/appearance-diff.png) frames are
retained. **Human appearance review has not happened and is required before acceptance.**

Timing is not qualified. Native compile service time summed over all events was 1179.0, 1124.9 and
1019.6 ms for the original and 3434.4, 858.2, 967.0 and 848.2 ms for the candidate. The 3434.4 ms
outlier was the first run of a freshly built binary; driver-cache state was not independently
controlled, so its cause is unproven. Browser `startup.timeline.readyMs` spans 7769–9505 ms across
runs of the *same* original source and 7529–10643 ms for the candidate. These overlapping ranges
do not establish a launch improvement. Sum of native compile service, launch wall,
`firstPresent` and `readyMs` remain distinct meters, and no shipped package has a first-playable
meter, so the 8-second playable and >5% GPU targets stay open and unmeasured here.

The bounded observation control set `renderer.pipelineCensus: false` on the same integrated
packages and the same candidate material source, then restored `src/game.ts` to its original
`9571aced02a4e26da102161d162da7b34cd1838237865df0242c6932e0412a7c`. The run still passed and
reported warm-up `status: unavailable` with no census, and the actual built doctor
[failed closed at exit 2](startup-measure-reduce-2026-09-09/material-tint-uniform/census-off-doctor.txt)
with `TN_PIPELINE_CAPTURE_MALFORMED` on both that run's report and a version-1 envelope carrying no
census. JS observer overhead could not be separated from `readyMs` noise. This control does not
disable native C++ hashing or logging, so native observer overhead remains unmeasured; no flag was
invented for it.

The Android arm is blocked and produced no census. The candidate APK
`com.threenative.bayview.startup` built and installed (`Success`) on the Wi-Fi device at 60%
battery, discharging, 32.4 °C, but the run failed with
`TN_PLAYTEST_BRIDGE_MISSING: Scenario requires semantic capabilities but
'__THREENATIVE_PLAYTEST_BRIDGE__' is not installed.` — the Android mailbox transport seam, not the
material change, and the same scenario passes on desktop. The original app was not touched.

### Final local verification

The [gate receipts](startup-measure-reduce-2026-09-09/gates/results.json) retain exact commands,
exit codes, full-log hashes and bounded output. Final `pnpm typecheck`, `pnpm lint`, `pnpm build`,
`pnpm test` and `pnpm test:playtest` all exited `0`. The workspace suite reported 411 files passed,
2 skipped; 4772 tests passed, 8 skipped. Native package tests separately reported 105 files passed,
861 tests passed and 57 skipped, followed by successful physics parity tests. The desktop gate
passed under `SDL_AUDIODRIVER=dummy sh scripts/xvfb.sh pnpm native:verify:desktop`, including the
300-frame capture, gameplay/physics, native contracts and loading-screen checks.

The quality gate first rejected a double cast in the collector's new promise check. A checked
`PromiseLike` type guard removed that cast while preserving the observation behavior;
[the red](startup-measure-reduce-2026-09-09/gates/quality-red.txt) and
[18-test green](startup-measure-reduce-2026-09-09/gates/final-quality-green.txt) are retained.
The comparison above uses its recorded package cohort, before this final typing cleanup.

Failed setup attempts are not counted as passing gates: three QuickJS executables were initially
unbuilt and were then built using the shipped preset; an extra gate recorder prevented one suite
from acquiring its lease; the native CLI contract initially lacked a display and passed with the
repository wrapper. One workspace run overlapped the desktop gate's package rebuild and failed to
resolve the playtest peer dependency. Its isolated test passed, then the full suite passed when
run after the desktop gate. PRD-367 and PRD-369 remain partial: qualified Android launch timing,
native observer overhead, first-playable/GPU criteria and human appearance acceptance remain open.

## PRD-370 warm-up accounting — 2026-09-09

The engine warm-up now reports renderable candidates, compile attempts and the renderer-owned
pipeline census separately. The old material/object heuristic no longer decides which objects are
visited or labels candidates as pipelines. Startup status carries the census result into the
playtest bridge, scene doctor and every generated loading screen; incomplete or unavailable
coverage is warned about, doctor fails it, and a known incomplete loading bar stops below 100%.
The compatibility field `pipelines` remains, documented as the candidate count.

### Red/green evidence

Before the implementation, the shared-material negative control reported two compiles instead of
four, and the report had no `candidates`, `attempted` or `observed` fields. After the implementation:

```text
pnpm exec vitest run packages/core/__tests__/warmup.spec.ts
Test Files  1 passed (1)
Tests  20 passed (20)

pnpm exec vitest run packages/core/__tests__/warmup.spec.ts packages/core/__tests__/warmup-default.spec.ts packages/core/__tests__/pipeline-census.spec.ts
Test Files  3 passed (3)
Tests  28 passed (28)

pnpm exec vitest run packages/playtest/__tests__/scene-overview.spec.ts packages/playtest/__tests__/doctor.spec.ts
Test Files  2 passed (2)
Tests  32 passed (32)

pnpm exec vitest run packages/create-threenative/__tests__/loading-screen.spec.ts
Test Files  1 passed (1)
Tests  22 passed (22)
```

The census delta regression proves two shared-material candidates remain two attempts while the
backend observation reports its independent creation, failure, pending, program and pipeline
counts. The abandoned-compile regression proves a complete-looking census cannot override failed
warm-up work. The scene overview regression proves incomplete coverage remains a warning and the
loading regression proves startup progress does not render as complete while coverage is unknown.

### Gates and limits

`pnpm typecheck` passed for 28 of 29 workspace projects. `pnpm lint` passed with the repository's
existing warning diagnostics and no errors. The V8/Dawn native host built 403/403 CMake steps, the
V8 contract aggregate built 83/83 targets, and the QuickJS timestamp, RG11B10 and host targets
built successfully. The timestamp contract passed 2/2 and the isolated WebTransport fixture suite
passed 36/36 under `scripts/xvfb.sh`. A concurrent full native Vitest run exposed the existing
shared `.test-tmp` cleanup race between WebTransport and GPU fetch tests; the WebTransport file
passed when run alone, so no unrelated native test code changed.

The native capture blocker was then reproduced and fixed. Before the fix, the rebuilt host emitted
101 created events but the strict parser returned `complete: false` with
`native marker capture is missing its completion marker`: screenshot mode called `_exit()` before
an explicit capture finalizer could join the compile pool and emit `TN_PIPELINE_COMPLETE`. The
finalizer now drains late worker completions while preserving the platform-safe immediate exit.
The native adapter shim also omitted `GPUAdapter.info`, which made the in-process warm-up census
report `status: incomplete` despite zero failures and zero pending work.

The fix was verified from an isolated current-core Bayview bundle with the supported host command:

```text
timeout 180s sh scripts/xvfb.sh packages/runtime-native/build/tn-linux/mystral run game.js --headless --screenshot /tmp/prd370-bayview-warmup-native-final.png --frames 300
exit=0
adapter: native:vulkan/nvidia/NVIDIA GeForce RTX 2080/turing/NVIDIA: 610.57.04 610.57.4.0
TN_WARMUP: candidates=835 attempted=1 created=56 failed=0 pending=0 uniquePrograms=51 uniquePipelines=56 status=complete elapsedMs=8943
TN_PIPELINE_CAPTURE: native Vulkan/NVIDIA GeForce RTX 2080
TN_PIPELINE_FIRST_PRESENT: boundaryMs=88.447030
TN_PIPELINE_COMPLETE: eventCount=101
strict pipeline summary: complete=true, creations=101, uniquePrograms=79, uniquePipelines=101, failures=0, pending=0, dropped=0
PNG: 1280x720, 1694010 bytes
```

The current-core browser run also completed on the NVIDIA Turing WebGPU adapter: candidates `835`,
attempted `1`, observed `56` creations, `51` unique programs, `56` unique pipelines, zero failures,
zero pending events, and `status: complete`; its timeline entered at `5303.9 ms`, compile settled at
`9251.9 ms`, and ready at `10202.2 ms`. These captures prove the real browser/native accounting
path and backend identity. Late first-use work after the warm-up boundary, the full PRD-360
reconciliation, and the independent Phase 2 review remain open, so PRD-370 stays PARTIAL.

## PRD-369 partial material graph reuse — 2026-09-09

The Wildwood game lane at `ThreeNativeHQ/examples`, commit `f8e992c`, now routes imported foliage
sections through `wildwood/src/render/sharedMaterials.ts`. The factory keeps each section's map,
colour gain, alpha cutoff, normal map and authored wind values on its material. One wind vertex graph
is shared by moving sections; its scalar uniforms update from the material while the shadow pass
retains the last valid value when its generated material has no game fields. The old assignment was
restored as the negative control by replacing `wildwood/src/render/foliage.ts` with its HEAD source.

Both arms used the complete Wildwood `playtests/survives.playtest.json` scenario with cache disabled,
the same NVIDIA Turing WebGPU adapter and the temporary PRD-367 census packages. The original arm
created 272 render pipelines and 244 unique programs; the candidate created 266 pipelines and 239
unique programs. Each arm had zero failures and one pending census event, so the census was incomplete
and the counts are a bounded comparison rather than a settled whole-game total. The candidate reduced
six creations and five unique programs in this paired run.

The candidate passed the real scenario with valley counts of 2,341 trees, 7,600 ferns, 36,300 grass
instances and 72,200 terrain triangles, movement of 6.88 m, and zero console or runtime diagnostics.
The focused material test passed, `pnpm typecheck` passed, `pnpm test:render` passed 19/19, the audio
gate passed 191/191 checks, and the Vite build passed. The candidate screenshot retained the baseline
daytime appearance within the recorded capture variation; no authored material feature was removed.

This is a partial PRD-369 result. The ≤64-program target, qualified Pixel 8 first-playable median,
native desktop comparison, steady-state frame-time budget and complete census settlement remain
unverified. The candidate PR is [examples#3](https://github.com/ThreeNativeHQ/examples/pull/3),
merged at `b2183b316076f3f918df200d92945acb3b3118a0`.

## Repair-20 — cross-platform engine-load identity — 2026-09-07

This repair belongs to the `examples/engine-load-test` identity layer, not to a public engine
package: it canonicalizes the served/workload graph hashes used by the example's performance
arms. The required capability search was run before editing. The three returned entries
(`readRenderChainObservation`, `readRenderChainReport`, and `reconcileMirroredClips`) were then
inspected and none covered graph identity, URL canonicalization, or JavaScript label parsing; no
public capability was used.

The repair now recognizes bracketed IPv6 loopback (`[::1]`) alongside the other local Vite hosts,
so graph URLs and embedded module references remain stable across loopback hostnames and dev
ports. URL ordering uses exact UTF-16 code-unit ordering instead of locale-dependent comparison,
so canonically distinct Unicode paths (`café` and `cafe\u0301`) hash deterministically regardless of
entry order. Braced JavaScript identifier escapes accept leading-zero forms such as
`\u{000006c}oop` while retaining the existing invalid-code-point checks.

The existing identity contracts remain in force: equal-byte duplicate observations are still
serialized deterministically; conflicting duplicates and missing URLs still fail closed; workload
configuration remains part of workload identity; external origins, data URLs, query/fragment
suffixes, and recognized/unrecognized checkout paths retain their prior distinctions.

### Red/green evidence

Focused regression command before the source repair:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'canonically distinct Unicode URLs|loopback origins|escaped break and continue labels'
FAIL — 3 failed, 84 skipped (87 collected)
```

The same command after the repair passed all three new cases (`3 passed, 84 skipped`). The full
identity file then passed `87/87` tests. The source and regression test are the only code changes.

### Gates

- `pnpm typecheck` passed (root plus 28 of 29 workspace projects).
- `pnpm lint` passed: 1,967 files checked, 619 existing warnings, 0 errors.
- `git diff --check` passed.
- `pnpm test` ran 392 files / 4,372 tests: 389 files and 4,364 tests passed, 2 files and 7 tests
  skipped, and one unrelated playtest test failed. The failure is
  `packages/playtest/__tests__/e2e-runner.spec.ts` — the browser closed during a GPU
  `ReadPixels` stall, so the page-navigation guard reported `TN_PLAYTEST_PAGE_NAVIGATED` before
  the expected transport diagnostics. The focused rerun reproduced that same failure; no
  playtest code was changed.
- `pnpm budgets` passed all checks through evidence accounting, then failed only because the
  pre-existing `docs/benchmark/SCREENSHOT-RETENTION.md` retention index is stale. That file is
  intentionally not edited in this repair.

This entry records repair evidence, not a completed Astra audit. A manager must run a fresh
independent Astra audit before claiming the overall audit complete.

### Astra follow-up — identity collector and selected-lane fail-closed repairs — 2026-09-07

The independent medium review found three defects in the delivered repair. The browser collector
was using regexes that treated imports inside strings and comments as dependencies and missed
comment-separated imports. Workload identity traversed into engine and renderer modules, so an
engine-only change could invalidate a comparison before metrics were considered. Finally, a
selected advisory lane with no published artifact could be summarized as `UNVERIFIED` with exit 0.

The follow-up reuses the identity scanner for executable module-specifier extraction, hashes only
the benchmark-owned `game.ts` and `workload.ts` sources for workload identity, and marks every
selected matrix row `BLOCKED` until it publishes evidence. The deleted build-exit regression was
also restored; it guards against a completed build retaining an audio worker pool.

Red/green evidence:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'extracts executable|keeps engine implementation|wires the browser collector'
Tests 3 failed | 87 skipped (90)  # before the follow-up
Tests 3 passed | 87 skipped (90)  # after the follow-up

pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/performance-regression.spec.ts
Test Files 3 passed (3)
Tests 183 passed (183)

pnpm exec vitest run packages/create-threenative/__tests__/build.spec.ts -t 'audio worker pool'
Tests 1 passed | 14 skipped (15)
```

The review's read-only probe reproduced the selected-lane failure as `UNVERIFIED`, exit 0 before
the follow-up; selected missing rows now enter `BLOCKED` evidence and the summary's required-lane
set. No platform or hardware performance result is claimed.

### Astra second follow-up — executable scanner and workload context repairs — 2026-09-07

The fresh independent review found two additional identity defects. The lexical scanner could treat
the regex after an optional `catch {}` or an ASI-separated `debugger` statement as division, then
strip executable template contents that looked like a terminal source map. It also derived the
checkout-root normalization context only after filtering engine modules out of the workload graph,
so absolute engine import references made identical worktrees hash differently.

The scanner now treats `catch` and `debugger` as statement boundaries. Workload hashing accepts the
complete served graph as canonicalization context while serializing only the benchmark workload
entries, so engine bytes stay out of workload identity without losing checkout-root normalization.

Red/green evidence:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'keeps executable|keeps filtered'
Tests 2 failed | 90 skipped (92)  # before the second follow-up
Tests 2 passed | 90 skipped (92)  # after the second follow-up

pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/performance-regression.spec.ts packages/create-threenative/__tests__/build.spec.ts
Test Files 4 passed (4)
Tests 200 passed (200)
```

The independent review also probed the corrected two-worktree hash path and found equal workload
hashes. Its remaining source-reference and escaped-specifier observations are coverage risks, not
reproduced false passes; no platform or hardware performance result is claimed.

### Astra final follow-up — ASI block boundary repair — 2026-09-07

The review's next probe found the same scanner failure after a valid expression statement followed
by an ASI-separated block (`value = 1` followed by `{}`). The scanner had cleared the line-break
fact before classifying the opening brace as an object, so the following regex was treated as
division and executable template contents could again disappear from identity.

Brace classification now receives the line-terminator boundary observed by the token scanner and
chooses a block when JavaScript can begin a declaration at that boundary.

Red/green evidence:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'keeps executable template contents'
Tests 1 failed | 91 skipped (92)  # before the final follow-up
Tests 1 passed | 91 skipped (92)  # after the final follow-up
```

The corrected probe produced different hashes for different executable template values. No
platform or hardware performance result is claimed.

### Astra final follow-up — module-specifier extraction closure — 2026-09-07

The next read-only probe found three lexical identity gaps: static dynamic imports written with
template literals were omitted; JavaScript escapes in quoted specifiers were retained raw, so
equivalent imports hashed differently; and computed dynamic imports could be treated as absent or
partially extracted.

Module extraction now recognizes static template imports, decodes JavaScript string and template
escapes before URL canonicalization, and fails closed for non-literal or concatenated dynamic
imports. The same decoded value is used for both reported references and graph bytes, so equivalent
spellings share an identity.

Red/green evidence:

```text
Astra probe before the follow-up:
static template import -> []
escaped equivalent imports -> different hashes
computed dynamic import -> no extraction error

pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'extracts executable|extracts static template|keeps executable template contents'
Tests 3 passed | 90 skipped (93)
```

The corrected probe now reports static template and decoded escaped references, equivalent escaped
and unescaped module graphs hash equally, and computed imports fail closed. No platform or hardware
performance result is claimed.

### Astra follow-up — Vite transport and escaped-literal closure — 2026-09-07

The independent review of the module-specifier repair found two blockers. Vite's optimized
dependency URLs carry a checkout-specific `?v=<hash>` transport token; retaining it made otherwise
identical workload graphs differ between worktrees. The decoder also inserted a decoded quote
directly into source, so one valid import containing an escaped quote could canonicalize to the
source of two imports.

Observed Vite dependency tokens are now removed only from `/node_modules/.vite/deps/` references
whose exact `?v=<hex>` token is present in the observed graph. Other query parameters remain part of
identity. Canonical module references are re-escaped for their original string or template literal,
including quotes, backslashes, line breaks, backticks, and `${...}` sequences. Object methods named
`import` remain ordinary syntax rather than being rejected as computed imports.

Red/green evidence:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'extracts static template|canonicalizes observed Vite'
Tests 2 failed | 92 skipped (94)  # before the Astra follow-up
Tests 2 passed | 92 skipped (94)  # after the Astra follow-up

pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts
Tests 94 passed (94)
```

The corrected two-root graph probe gives equal artifact and workload hashes for differing observed
Vite cache tokens, while a meaningful extra query remains different. The escaped-quote collision
now remains different. No platform or hardware performance result is claimed.

A final read-only scanner probe found that the object-method exemption was too broad and allowed a
computed import used as an object property value. The exemption now applies only at an actual method
name position; computed imports in property values fail closed while `const obj = { import(x) {} }`
remains valid.

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'extracts static template'
Tests 1 failed | 93 skipped (94)  # before the narrow exemption
Tests 1 passed | 93 skipped (94)  # after the narrow exemption
```

---

## PRD-360 warm-up host turns and relaunch hint — 2026-09-07

The native pipeline pool settles its JavaScript promises from `pollEvents()`. The old warm-up path
awaited `compileAsync()` directly inside a callback, so a pending compile could hold the pump until
the warm-up timeout even while the worker pool was active. `packages/core/src/warmup.ts` now gives
the host one configured yield plus a macrotask while the promise is pending, preserving the existing
compile and timeout bounds.

The same module now has an opt-in `cache: { key }` hint. A complete warm-up records only a schema,
game-owned key, pipeline count and compute-node count in `localStorage`; a matching launch reports
`cache: "hit"` and skips the redundant compile walk. This is not serialized WebGPU pipeline data:
the native headers expose no portable pipeline-cache object, so the driver remains responsible for
its own persistent cache. A changed key or count invalidates the marker. The focused red/green and
game integration evidence is in [the PRD-360 verification record](prd-360-warmup-cache-2026-09-07/README.md).

The physical candidate result that motivated the follow-up was **16,020.007 ms** to first frame,
with **8,404.781 ms** across 93 pipeline calls and **2.146719 m** of movement. That is roughly
twice PRD-360's 8-second target, so the 8-second median and the 250 ms pump-silence limit both
remain open and the PRD stays PARTIAL. No physical cache-hit timing was run because the recorded
Pixel 8 was unreachable.

---

## PRD-360 corrected explicit warm-up boundary — 2026-09-08

The one bounded object-granularity validation was repeated after fixing a first-use race in
`packages/core/src/game.ts:860`, `:1138`, `:1171` and `:1262`. A held native frame could arrive
after an explicit warm-up began but before it settled; the render path now keeps first-use compute
and world presentation behind that same boundary. The regression is at
`packages/core/__tests__/game.spec.ts:545`.

The unchanged Bayview source temporarily selected the existing object granularity. The qualified
Pixel 8 run used APK SHA-256
`2a64ede5cf0699580e8e62506b054f0c8e046c7084fb4244f42ea5c6b1394496`, with 81% battery,
discharging status, thermal status `NONE`, and battery temperature 33.5 °C to 33.9 °C. The
existing movement scenario passed at **2.146682 m** with zero diagnostics. The full raw receipt is
[`android-object-corrected-receipt.json.gz`](prd-360-warmup-cache-2026-09-07/android-object-corrected-receipt.json.gz).

| marker | observed |
| --- | ---: |
| `TN_WARMUP` compiled / slices / elapsed | 494 / 21 / 11,659 ms |
| `TN_COLD_START.first_frame` | 19,629.400 ms |
| `TN_PUMP_SILENCE.maxGapMs` / trailing gap | 2,339.194 / 5,551.419 ms |
| movement `TN_PUMP_ENDPOINT.maxGapMs` | 5,560.916 ms |

There was one `TN_WARMUP` marker and no `TN_STARTUP_WARMUP` marker, so the duplicate fallback pass
was removed. The run still misses the 8,000 ms launch and 250 ms pump criteria. It is a corrected
validation receipt, not a three-launch cold-install median; the object option was removed from the
sandbox after measurement and remains opt-in.

---

## Android: the GPU meter reports on a Pixel 8 — 2026-09-01

**First GPU reading taken from a phone by the instrument rather than by ablation arithmetic.**
Pixel 8 (`shiba`), adapter **Mali-G715**, Android first proof (`examples/native-smoke`), 300
frames, 1080x2400 at `resolutionScale 1`, `sampleCount 4`, over Wi-Fi adb.

| window | fps | gpuMs | render p50 | residual share |
| --- | ---: | ---: | ---: | ---: |
| 1 | 41.29 | **0.19** | 2.72 ms | 0.602 |
| 2 | 41.89 | **0.19** | 2.95 ms | — |

The device granted `timestamp-query`, and now says so on the path a game takes:

```
TN_WEBGPU_FEATURES:{"timestamp-query":true,"texture-compression-bc":false,
  "texture-compression-etc2":true,"texture-compression-astc":true,
  "indirect-first-instance":false,"rg11b10ufloat-renderable":false}
```

**Read 0.19 ms as "the meter works", not as a game's GPU cost.** The first proof is a near-empty
scene whose frame is 60 % `residual`; attributing a real game's GPU time on the phone is PRD-308,
which this unblocks. **The phone was on the charger** (level 65 → 72 %, battery 30.1 °C, thermal
status 0), so no fps figure here is comparable to the unplugged 59.99–60.02 fps template baseline
above, and none is claimed to be.

Full record, including the feature-array bound that could silently have dropped
`core-features-and-limits` on a device advertising all three compression formats:
[`gpu-meter-on-android-2026-09-01`](gpu-meter-on-android-2026-09-01.md).

---

## Browser WebGPU: a TSL post chain, and the scaler's fps signal — 2026-08-30

Lane: browser/WebGPU, `sandbox/lumen-hall` (gothic cathedral, five-stage TSL chain: SSGI +
denoise, godrays, SSR, bloom, AgX). Machine: Linux `7.1.4-1-cachyos`, NVIDIA RTX 2080 (Turing),
Chromium via Playwright with the repo's `webgpu` recipe plus `--disable-gpu-vsync
--disable-frame-rate-limit`, private Xvfb 1920x1080x24, viewport 1600x900. Adapter named in every
run: `nvidia` / `turing`.

**Fixture rule this round paid for.** The scene was measured against a `pnpm dev` server that three
other agents were editing at the same time; vite HMR reloaded the page mid-capture and the reload's
pipeline rebuild landed inside the window as a 174-texture, 117-pipeline burst. Every number below
comes instead from a static `vite build` of a source snapshot, served by a private
`python3 -m http.server`, with `renderer.resolutionScale` pinned to 1 in the snapshot's config so
the adaptive scaler cannot move the surface between arms. **A dev server that another agent can
edit is not an A/B fixture.**

### Per-stage attribution, by GPU time

`gpuMs` (three's `timestamp-query`, reported in every `TN_FRAME_BUDGET` window) is the honest
meter here and `render.p50` is not: the CPU render phase is ~5.5 ms while the GPU frame is
~14.7 ms, so the GPU is the limiter by 3x and the CPU only discovers it when `queue.submit` blocks.
Window 1 discarded; median and range over the remaining steady windows of two 40 s runs each.

| config | gpuMs median | gpuMs range | fps median | `queue.submit`/frame |
| --- | --- | --- | --- | --- |
| all stages | 14.7 | 13.4–17.5 | 56.8 | 48 |
| minus ssgi+denoise | 5.5 | 2.3–12.7 | 126.3 | 46 |
| minus ssr | 10.6 | 9.2–16.7 | 77.0 | 34 |
| minus godrays | 14.7 | 13.8–16.7 | 57.1 | 46 |
| minus bloom | 10.1 | 9.1–23.1 | 72.4 | 24 |
| minus denoise only | 12.8 | 12.0–14.3 | 60.3 | 48 |
| all stages off | 2.2 | 2.1–12.0 | 333.3 | 6 |

`minus denoise only` splits the largest stage: the two full-resolution denoise passes over the AO
and GI terms are ~1.9 ms and the SSGI gather itself is ~7.3 ms, at `medium` (2 slices x 8 steps).

Scene, shadow map and overlay together cost **2.2 ms** of GPU. The post chain costs **12.5 ms** —
SSGI+denoise ~9.2, bloom ~4.6, SSR ~4.1, godrays **~0.0** (the individual costs oversum because
removing SSGI also removes the denoise passes the later stages sample). Draw calls peak at 561 and
are not a factor. Two other agents were capturing on the same GPU throughout, which is what the
ranges are for; `submit`-per-frame and `writeBuffer`-per-frame were bit-identical across reps and
are the structural numbers to quote.

### The p99 tail is GPU back-pressure, not recompiles or reallocation

Per-frame instrumentation of `GPUDevice`/`GPUQueue` (injected before app boot) shows **zero**
pipeline, shader, texture, buffer or bind-group creation per frame at steady state. The tail is
48 `queue.submit` and 142 `queue.writeBuffer` calls a frame against a 14.7 ms GPU frame: the CPU
runs ahead, then one frame in ~71 blocks for 650–870 ms **inside `queue.submit`** (measured
`submitMs` 1300–1670 ms on those frames against 1.19 ms on ordinary ones) while the queue drains.
The stall period tracks `writeBuffer` volume — ~10,200 calls between stalls in both the all-stages
arm (71 frames x 142) and the all-off arm (147 frames x 70) — not frame count or submit count.
Separately, the first two windows carry 700–2800 ms stalls that *are* pipeline builds.

### The adaptive scaler over-corrected on a startup window — fixed

The second 300-frame window is where three finishes building pipelines for the chain. Four of its
300 frames took ~1.94 s each: **under the 2 s `hitchMs`**, so each stayed in the window and went
into the mean. The window reported **22.6 fps** beside a **presented p50 of 9.8 ms** (102 fps).
`ResolutionScaler` reads `fps`, which is `1000 / presented.mean`, computed a 2.6x deficit, took its
maximum four-rung jump, and the game then held 145 fps at **832x468** for the next forty seconds —
and climbs back at four windows a rung. The down-step is also the wrong medicine for this cause:
the resize reallocates every render target, which rebuilds pipelines.

Fix: `RESOLUTION_SCALER.stallP99Multiple = 10`. A window whose presented p99 is ten or more times
its p50 is measuring a stall, not a frame rate; the controller defers on it in both directions
rather than stepping or counting it clean. The regimes are far apart — a vsync-capped panel
dropping frames sits near 2, a simply-slow game near 1, this window at 200. Reported `fps` is
unchanged; only what the controller acts on changed.
Red/green: `packages/core/__tests__/resolution-scaler-outlier.spec.ts`. Deleting the
`if (this.#stalled(window))` guard from `observe()` fails two of its five cases (`expected 0.72 to
be undefined`, `expected 0.44 to be 0.61`); the other three, which prove a genuinely slow game and
a vsync-capped panel still step down, pass either way and are the mutation's control.

### Tried and not worth it: freezing the shadow map

The sun and the building are both static, so `sun.shadow.autoUpdate = false` should remove a
4096x4096 depth pass per frame. Three 30 s reps each of the baseline and the frozen variant yielded
only one and two steady windows respectively under concurrent GPU load — `gpuMs` 14.62 against
15.29–18.26, which is noise, not a win. It is not worth re-measuring: the entire scene, shadow and
overlay pass is 2.2 ms of a 14.7 ms GPU frame, so no shadow-map change can win more than 15% of the
frame even in principle, and the post chain holds the other 85%.

### Open, not fixed

- **`display.maxFps` caps nothing on web.** It is read only by `ResolutionScaler`
  (`packages/core/src/game.ts:800`); the loop renders every rAF. Native has a present cap
  (`capHz`), web has none, so a game declaring 60 runs at whatever the compositor allows and the
  GPU never idles. Design question, not filed.
- **`trackTimestamp` overruns three's query pool.** `renderer.resolveGpuFrame()` is called once per
  300-frame window (`game.ts:817`) while `trackTimestamp: true` (`renderer.ts:374`) writes two
  queries per pass every frame. With 48 passes the 2048-query pool fills in ~21 frames, three warns
  `Maximum number of queries exceeded`, and the reported `gpuMs` is one early frame of the window
  rather than a window statistic. The number is usable — it matched the ablation — but it is not
  what the field's doc comment says it is.

---

## PRD-230 pre-move desktop baseline — 2026-08-29

This is the comparison baseline for splitting `src/webgpu/bindings.cpp`, captured before the first
rename at clean source SHA `df797b7cac5e0a211f5d32c6cd522ecfc101d36e`. The external Bayview
sandbox used by earlier runtime work was not present on this machine, so this round uses the
in-repository `examples/native-smoke` bundle and shipping desktop host as its reproducible A/B
fixture. Later PRD-230 measurements must use this same fixture and command. This is desktop/Xvfb
evidence; fps is present-throttled and is not a verdict.

Machine state: Linux `7.1.4-1-cachyos`, AMD Ryzen 9 5900X (12 cores / 24 threads), NVIDIA GeForce
RTX 2080 TU104, Xvfb 1600×900×24 on `DISPLAY=:97`, SDL X11, Dawn FIFO present with vsync enabled.
The game surface reported 1280×720, resolution scale 1 pinned, and 4× samples.

```sh
DISPLAY=:97 SDL_VIDEODRIVER=x11 node packages/playtest/dist/runner/cli.js perf \
  --executable packages/runtime-native/build/tn-linux/mystral \
  --host-arg run --host-arg examples/native-smoke/dist/native-smoke.js \
  --require-windows 2 --timeout 900 --text
```

The harness captured three 300-frame windows and discarded window 1 as startup. Both steady
windows passed. Window 2/3 `render.p50` was **1.3 / 1.2 ms** (`render.p95` 1.8 / 1.7 ms), and
`hostGap.p50` was 30.4 / 29.9 ms. The last window reported GPU time 0.72 ms. The last host-gap
window is the fixed share baseline used by PRD-230's two-point guard:

| required sub-phase | p50 ms | share of the six required sub-phases |
| --- | ---: | ---: |
| `frameDrain` (`drain`) | 0.002 | 0.007% |
| `frameReplay` (`replay`) | 0.234 | 0.787% |
| `present` | 28.498 | 95.866% |
| `gpuDrain` | 0.000 | 0.000% |
| `devicePoll` (`poll`) | 0.992 | 3.337% |
| `endFrameOther` (`other`) | 0.001 | 0.003% |

The pre-split incremental compile measurement touched only `bindings.cpp` and rebuilt the shipping
`mystral` target. zsh reported **17.09 s** for compile plus archive/link:

```sh
touch packages/runtime-native/src/webgpu/bindings.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel
```

### PRD-230 Phase 1 — handler identifiers only

After all 87 numbered handler identifiers were renamed, the same command on the same machine
produced steady `render.p50` **1.3 / 1.2 ms**, unchanged from baseline. The last host-gap window
measured `frameDrain` 0.002 ms (0.007%), `frameReplay` 0.226 ms (0.761%), `present` 28.504 ms
(95.918%), `gpuDrain` 0.000 ms (0.000%), `devicePoll` 0.985 ms (3.315%), and `endFrameOther`
0.000 ms (0.000%). The largest share shift was **0.052 percentage points** (`present`), below the
two-point rejection threshold. The run captured three windows, discarded startup, and passed.

### PRD-230 Phase 2 — cohesive `BindingsState`

After the flat state became `ResourceRegistries`, `PresentationState`, `FrameProfiling`,
`ScreenshotCapture`, and `Canvas2DComposite`, the same command and machine produced steady
`render.p50` **1.2 / 1.2 ms**, no rise from the baseline's final steady window. The last host-gap
window measured `frameDrain` 0.002 ms (0.007%), `frameReplay` 0.226 ms (0.759%), `present` 28.571
ms (95.944%), `gpuDrain` 0.000 ms (0.000%), `devicePoll` 0.979 ms (3.288%), and `endFrameOther`
0.001 ms (0.003%). The largest share shift from the pre-move baseline was **0.078 percentage
points** (`present`), below the two-point rejection threshold. The run captured three windows,
discarded startup, and passed.

### PRD-230 Phase 3.1 — Canvas2D compositor translation unit

After `compositeCanvas2DToWebGPU` moved byte-for-byte into its own translation unit, the first
sample produced steady `render.p50` **1.5 / 1.5 ms**, outside the two-percent comparison guard, and
was rejected. That sample's last required host-gap values were `frameDrain` 0.003 ms,
`frameReplay` 0.306 ms, `present` 34.988 ms, `gpuDrain` 0.000 ms, `devicePoll` 1.035 ms and
`endFrameOther` 0.001 ms.

After the full parity workload completed and the machine returned idle, an immediate repeat with
the identical command produced steady `render.p50` **1.0 / 1.0 ms**, below the baseline. Its last
required host-gap window measured `frameDrain` 0.001 ms (0.004%), `frameReplay` 0.144 ms (0.561%),
`present` 24.629 ms (95.881%), `gpuDrain` 0.000 ms (0.000%), `devicePoll` 0.913 ms (3.554%) and
`endFrameOther` 0.000 ms (0.000%). The largest share shift from the pre-move baseline was **0.217
percentage points** (`devicePoll`), below the two-point rejection threshold. The accepted run
captured three windows, discarded startup, and passed.

Touching only `bindings_canvas2d_composite.cpp` and rebuilding serially measured **22.32 s** for
compile plus archive/link. That is slower than the 17.09 s monolith baseline, so this first surface
split has not yet demonstrated the PRD's incremental-compile payoff. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_canvas2d_composite.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.2 — screenshot translation unit

After screenshot accessors and `captureFrameScreenshot` moved into their own translation unit, the
same command and machine produced steady `render.p50` **1.0 / 1.0 ms**, below the baseline. The last
required host-gap window measured `frameDrain` 0.001 ms (0.004%), `frameReplay` 0.133 ms (0.523%),
`present` 24.400 ms (95.957%), `gpuDrain` 0.000 ms (0.000%), `devicePoll` 0.894 ms (3.516%) and
`endFrameOther` 0.000 ms (0.000%). The largest share shift from the pre-move baseline was **0.264
percentage points** (`frameReplay`), below the two-point rejection threshold. The run captured
three windows, discarded startup, and passed.

Touching only `bindings_screenshot.cpp` and rebuilding serially measured **5.04 s** for compile
plus archive/link, down 70.5% from the 17.09 s monolith baseline. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_screenshot.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.3 — presentation translation unit

After surface acquire, resize, sRGB bridge, presentation pacing and present reporting moved into
their own translation unit, the same command and machine produced steady `render.p50` **1.0 / 1.0
ms**, below the baseline. The last required host-gap window measured `frameDrain` 0.001 ms
(0.004%), `frameReplay` 0.121 ms (0.491%), `present` 23.619 ms (95.888%), `gpuDrain` 0.000 ms
(0.000%), `devicePoll` 0.891 ms (3.616%) and `endFrameOther` 0.000 ms (0.000%). The largest share
shift from the pre-move baseline was **0.296 percentage points** (`frameReplay`), below the
two-point rejection threshold. The run captured three windows, discarded startup, and passed.

Touching only `bindings_presentation.cpp` and rebuilding serially measured **6.05 s** for compile
plus archive/link, down 64.6% from the 17.09 s monolith baseline. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_presentation.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.4 — resource translation unit

After buffer, texture, texture-view and sampler bindings moved into their own translation unit,
the same command and machine produced steady `render.p50` **1.0 / 1.0 ms**, below the baseline.
The last required host-gap window measured `frameDrain` 0.001 ms (0.004%), `frameReplay` 0.132 ms
(0.522%), `present` 24.275 ms (95.949%), `gpuDrain` 0.000 ms (0.000%), `devicePoll` 0.892 ms
(3.526%) and `endFrameOther` 0.000 ms (0.000%). The largest share shift from the pre-move baseline
was **0.265 percentage points** (`frameReplay`), below the two-point rejection threshold. The run
captured three windows, discarded startup, and passed.

Touching only `bindings_resources.cpp` and rebuilding serially measured **5.83 s** for compile plus
archive/link, down 65.9% from the 17.09 s monolith baseline. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_resources.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.5 — pipeline translation unit

After shader modules, pipeline layouts, bind groups and compute/render pipelines moved into their
own translation unit, the same command and machine produced steady `render.p50` **1.0 / 1.0 ms**,
below the baseline. The last required host-gap window measured `frameDrain` 0.001 ms (0.004%),
`frameReplay` 0.132 ms (0.520%), `present` 24.348 ms (95.953%), `gpuDrain` 0.000 ms (0.000%),
`devicePoll` 0.893 ms (3.519%) and `endFrameOther` 0.000 ms (0.000%). The largest share shift from
the pre-move baseline was **0.267 percentage points** (`frameReplay`), below the two-point rejection
threshold. The run captured three windows, discarded startup, and passed.

Touching only `bindings_pipelines.cpp` and rebuilding serially measured **8.13 s** for compile plus
archive/link, down 52.4% from the 17.09 s monolith baseline. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_pipelines.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.6 — command translation unit

After render-bundle, query-set, command-encoder, render-pass and compute-pass bindings moved into
their own translation unit, the same command and machine produced steady `render.p50`
**0.7 / 0.9 ms**, below the baseline. The last required host-gap window measured `frameDrain`
0.002 ms (0.007%), `frameReplay` 0.216 ms (0.810%), `present` 25.855 ms (96.951%), `gpuDrain`
0.000 ms (0.000%), `devicePoll` 0.595 ms (2.231%) and `endFrameOther` 0.000 ms (0.000%). The
largest share shift from the pre-move baseline was **1.106 percentage points** (`devicePoll`),
below the two-point rejection threshold. The run captured three windows, discarded startup, and
passed.

Touching only `bindings_commands.cpp` and rebuilding serially measured **19.29 s** for compile plus
archive/link, 12.9% slower than the 17.09 s monolith baseline. This 1,681-line surface does not
show a compile-time payoff; the measurement is retained as the Phase 4 comparison input. The exact
command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_commands.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.7 — frame-stream translation unit

After packed frame-operation replay moved into its own translation unit, the first sample produced
steady `render.p50` **1.3 / 1.3 ms** and was rejected: an unrelated Playwright SwiftShader process
was consuming about 850% CPU and machine load was 28.81. After that workload exited, the same
command produced steady `render.p50` **1.2 / 1.2 ms**, no rise from the baseline's final steady
window. The accepted last required host-gap window measured `frameDrain` 0.002 ms (0.006%),
`frameReplay` 0.330 ms (1.012%), `present` 31.550 ms (96.741%), `gpuDrain` 0.000 ms (0.000%),
`devicePoll` 0.730 ms (2.238%) and `endFrameOther` 0.001 ms (0.003%). The largest share shift from
the pre-move baseline was **1.099 percentage points** (`devicePoll`), below the two-point rejection
threshold. The accepted run captured three windows, discarded startup, and passed.

Touching only `bindings_frame_stream.cpp` and rebuilding serially measured **8.04 s** for compile
plus archive/link, down 53.0% from the 17.09 s monolith baseline. The exact command was:

```sh
touch packages/runtime-native/src/webgpu/bindings_frame_stream.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

### PRD-230 Phase 3.8 and Phase 4 — retained bindings surface and final comparison

The retained `bindings.cpp` is 2,937 lines after all seven actual moves, down 4,933 lines (62.7%)
from the measured 7,870-line start. Touching only it and rebuilding serially measured **9.50 s**
for compile plus archive/link, down 44.4% from the 17.09 s baseline:

```sh
touch packages/runtime-native/src/webgpu/bindings.cpp
TIMEFMT='elapsed_seconds=%E'; time cmake --build \
  packages/runtime-native/build/tn-linux --target mystral --parallel 1
```

| final edit surface | compile plus archive/link | change from 17.09 s |
| --- | ---: | ---: |
| Canvas2D compositor | 22.32 s | +30.6% |
| screenshot | 5.04 s | -70.5% |
| presentation | 6.05 s | -64.6% |
| resources | 5.83 s | -65.9% |
| pipelines | 8.13 s | -52.4% |
| commands | 19.29 s | +12.9% |
| frame stream | 8.04 s | -53.0% |
| retained bindings | 9.50 s | -44.4% |

Final steady `render.p50` was **1.2 / 1.2 ms** versus **1.3 / 1.2 ms** before the refactor. The
largest required host-gap share shift was **1.099 percentage points**, below the two-point guard.
This remains desktop/Xvfb evidence; no physical Pixel 8 was connected, so **no device result is
claimed**.

### Post-merge reconciliation — 2026-08-29

After merging current `main` at `7f84b1a4`, the identical native-smoke meter on the rebuilt
shipping host produced steady `render.p50` **1.0 / 1.2 ms**. The final host-gap window measured
`frameDrain` 0.003 ms, `frameReplay` 0.345 ms, `present` 32.003 ms, `gpuDrain` 0.000 ms,
`devicePoll` 0.696 ms and `endFrameOther` 0.001 ms. The largest required share shift from the
pre-move baseline was **1.231 percentage points** (`devicePoll`), below the two-point guard. This
is desktop/Xvfb evidence; the physical-device result remains a separate row.

### PRD-230 physical Pixel 8 lane — 2026-08-29

The post-split V8 APK ran the 500-mesh native-smoke subject on a physical Pixel 8 (`shiba`) over
Wi-Fi ADB while unplugged. The accepted APK had application id `com.threenative.game` and SHA-256
`3a743288c670c0598d754554da0969f20d124ca44959a4122ddcfd3ffcc35271`. Before measurement, the
300-frame first proof passed with clean logs and a nonblank 1080x2400 screenshot (SHA-256
`3bafc84d930a5886a7fd04c8a20496490819960fb910582ea018773962293fc3`).

After clearing logcat and discarding the startup window, `playtest perf --logcat` accepted seven
300-frame windows: **59.77–59.99 fps**, frame p50 **6.0–6.6 ms**, render p50 **4.8–5.3 ms**, render
p95 **6.8–7.4 ms**, and zero hitches. Every window used scale 1, 1080x2400, and 4x samples. Device
doctor reported thermal status `NONE` before and after, skin 36.7 -> 38.5 °C, battery 97 -> 96%,
and discharging throughout.

```sh
node packages/runtime-native/scripts/verify-android-first-proof.mjs \
  --device 192.168.1.192:5555 --skip-build --settle-ms 0 \
  --apk packages/runtime-native/android/app/build/outputs/apk/debug/app-debug.apk
adb -s 192.168.1.192:5555 logcat -c
node packages/playtest/dist/runner/cli.js perf \
  --logcat 192.168.1.192:5555 --require-windows 4 --timeout 120 --text
```

The first Android compile exposed a refactor regression: `bindings_frame_stream.cpp` and
`bindings_resources.cpp` used `wgpuDevicePoll` without the wgpu-native extension declaration.
Commit `4ac7b273` added a red translation-unit contract and the conditional extension includes;
Android and desktop then rebuilt and all 30 enabled CTests passed. The dependency downloader still
rejects the pinned V8 artifact for 16 KB Android page compatibility. This Pixel reports a 4 KB page
size, so the binary is valid for this run; the separate 16 KB compatibility blocker remains open.

---

## 0. Native CPU attribution experiment — 2026-08-29

**Decision: STOP the bounded native transform experiment for now.** The clean browser data does
not make transform propagation large enough to justify a native kernel, and no native/bridge
synchronization cost was measured. Re-open only with a bounded hardware/native comparison that
measures packing, crossing, result application and synchronization end to end.

This is a browser software-rendering diagnostic. Chromium classified the adapter as
`architecture=swiftshader`, `vendor=google`, so these complete-render timings establish harness
behavior and relative scaling only. They are not a shipping GPU, Android, native, or frame-rate
claim. The collector records this as
`timing-only-browser-software-diagnostic`, rejects software rendering unless `--allow-software` is
explicit, and CPU-only rows zero the renderer counters rather than pretending that no render was
measured.

### Contract and clean inputs

The implementation preserves the Three.js public API and renderer behavior. It adds only a shared
deterministic workload contract, a collector option for CPU preparation versus complete rendering,
and the standalone example that exercises the contract. No native scene mirror, native kernel,
`SceneCollapse`, instancing, or per-property bridge was introduced.

The complete-render runs started from clean source SHA
`4e03ed73f4f14cdf379624294f220a6ee8ea4d52`; the CPU-only runs started from clean source SHA
`4ca8d2107254e0050fb56060de24f211698194ba`. Every raw report records `source.dirty=false`, the
branch, host CPU, Node version, OS, adapter metadata, evidence class, workload, and the complete
effective collector configuration in `arguments` (including both warm-up controls, matrix
selections, repeat/sample counts, rendering, adapter policy, browser, output and evidence settings)
alongside raw samples; the original invocation is retained separately as `argv`. The seeded unit
test also compares repeated IDs, parents, transforms and dirty sets byte for byte; alternating
visibility is deterministic and shares the same workload generator as the browser example.

### Repair round 1 — deep hierarchy population — 2026-08-29

The historical reports named below retain their raw data, but every run with
`scenario.hierarchy=deep` is **invalidated**. The example applied each generated transform as a
local transform and then parented the mesh, so transforms accumulated through the generated
parent chain. Flat rows are unaffected. Repair commit
`e214300dc474ad71bf66a5e5160ca9f201996d2a` uses `parent.attach(mesh)`, which preserves the
generated world-space placement while retaining the declared parent topology.

`assertWorkloadVisibilityPopulation()` is a fail-closed harness guard: before a profile run it
compares the frustum population with the workload's declared visibility population. Against the
unrepaired code the guard failed with `deep/all-visible expected 500, observed 177`; after the
repair, flat and deep 500-object rows both observed 500. The same guard also verifies the explicit
far-away populations for `mostly-culled` and `alternating`.

The clean repair rerun used headless Chromium on `DISPLAY=:0`. Chromium reported
`architecture=swiftshader`, so its evidence class remains
`timing-only-browser-software-diagnostic`; unrelated host CPU activity was present during the
collection. These are population and CPU-preparation diagnostics only, not hardware, native,
shipping-GPU, or frame-rate results. No native kernel, bridge crossing, or synchronization cost
was measured.

The full complete-render rerun was not accepted: the 180-frame 500-object attempt and the 180-frame
4,000-object attempt both stopped with Chromium's `Instance dropped in popErrorScope`. The clean
12-sample smoke probes at 500 and 4,000 objects are retained below as smoke artifacts only; they
do not establish steady-state complete-render performance. The CPU-only replacement completed all
requested deep rows with raw samples and per-run summaries:

`artifacts/native-cpu-profile/exp001-20260829-repair/cpu-only-deep/profile-1787989405731.json`

It records `source.dirty=false`, the repair SHA above, 36 runs, 6,480 raw samples, and the
`timing-only-browser-software-diagnostic` evidence class. The table pools the three repeats to 540
samples per row; values are milliseconds, shown as p50/p95. `frame` is the measured callback, not
a presented-frame time.

| objects | deep visibility | visible population | matrix propagation | bounds/cull | mutation | preparation frame |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 500 | all-visible | 500/500 | 0.000/0.100 | 0.018/0.025 | 0.000/0.000 | 0.020/0.122 |
| 500 | mostly-culled | 50/50 | 0.000/0.100 | 0.010/0.020 | 0.000/0.000 | 0.015/0.118 |
| 500 | alternating | 250/250 | 0.000/0.100 | 0.013/0.022 | 0.000/0.000 | 0.015/0.120 |
| 1,000 | all-visible | 1,000/1,000 | 0.100/0.200 | 0.045/0.065 | 0.000/0.000 | 0.135/0.240 |
| 1,000 | mostly-culled | 100/100 | 0.100/0.200 | 0.025/0.045 | 0.000/0.000 | 0.120/0.220 |
| 1,000 | alternating | 500/500 | 0.100/0.200 | 0.030/0.055 | 0.000/0.000 | 0.125/0.225 |
| 2,000 | all-visible | 2,000/2,000 | 0.100/0.200 | 0.100/0.150 | 0.000/0.000 | 0.210/0.370 |
| 2,000 | mostly-culled | 200/200 | 0.100/0.200 | 0.070/0.110 | 0.000/0.000 | 0.170/0.300 |
| 2,000 | alternating | 1,000/1,000 | 0.100/0.300 | 0.080/0.130 | 0.000/0.000 | 0.190/0.380 |
| 4,000 | all-visible | 4,000/4,000 | 0.200/0.400 | 0.200/0.280 | 0.000/0.000 | 0.480/0.720 |
| 4,000 | mostly-culled | 400/400 | 0.300/0.400 | 0.160/0.240 | 0.000/0.000 | 0.400/0.680 |
| 4,000 | alternating | 2,000/2,000 | 0.300/0.400 | 0.140/0.220 | 0.000/0.000 | 0.420/0.620 |

Complete-render smoke artifacts, both clean at the repair SHA and software-only, are
`artifacts/native-cpu-profile/exp001-20260829-repair/complete-deep-500-probe/profile-1787989248437.json`
and
`artifacts/native-cpu-profile/exp001-20260829-repair/complete-deep-4000-probe/profile-1787989442170.json`.
The failed 180-frame output directories are
`artifacts/native-cpu-profile/exp001-20260829-repair/complete-deep-500/` and
`artifacts/native-cpu-profile/exp001-20260829-repair/complete-deep-4000/`; no complete-render
report was written, so those rows are unverified and not claimed.

The red-green unit-test observations were:

- Before implementation, alternating visibility, bundled render modes and the ordinary matrix
  failed the focused suite; 24 existing tests passed.
- After the contract-preserving implementation, the focused suite passed 27/27.
- Before the rendering split, `--rendering` failed as an unknown argument; after it, the focused
  suite passed 28/28.

### Matrix and artifacts

The historical complete-render matrix used flat/deep hierarchy, dirty ratios 0/10/100%,
all-visible and mostly-culled visibility, independent render mode, one pass, 120 warm-up frames,
180 measured frames and three repeats. Its deep rows are invalidated by the repair note above;
only its flat control rows remain usable as historical software diagnostics. Each 500/1k/2k report
contains 36 runs and 6,480 raw samples, with per-run summaries for every measured field:

| object count | raw report |
| ---: | --- |
| 500 | `artifacts/native-cpu-profile/exp001-20260828/objects-500/profile-1787985927586.json` |
| 1,000 | `artifacts/native-cpu-profile/exp001-20260828/objects-1000/profile-1787985997644.json` |
| 2,000 | `artifacts/native-cpu-profile/exp001-20260828/objects-2000/profile-1787986103714.json` |

The historical CPU-only matrix used the same dimensions and additionally included 4k objects. Its
deep rows are invalidated by the repair note above; only its flat control rows remain usable. It
contains 144 runs and 25,920 raw samples, including complete raw arrays and summaries for all four
object counts:

`artifacts/native-cpu-profile/exp001-20260828/cpu-only-clean/profile-1787986653357.json`

The representative rows below pool the three repeats (540 samples per row). Values are
milliseconds; each pair is p50/p95. `frame` is the measured frame callback, not a presented-frame
time.

#### CPU preparation only

| objects | topology / visibility / dirty | matrix propagation | bounds/cull | mutation | preparation frame |
| ---: | --- | ---: | ---: | ---: | ---: |
| 500 | flat / all / 0% | 0.000/0.100 | 0.017/0.025 | 0.000/0.000 | 0.020/0.123 |
| 1,000 | flat / all / 0% | 0.000/0.100 | 0.035/0.055 | 0.000/0.000 | 0.050/0.155 |
| 2,000 | flat / all / 0% | 0.100/0.300 | 0.100/0.180 | 0.000/0.000 | 0.200/0.510 |
| 4,000 | flat / all / 0% | 0.200/0.300 | 0.200/0.320 | 0.000/0.000 | 0.380/0.640 |
| 4,000 | flat / all / 10% | 0.200/0.400 | 0.200/0.300 | 0.100/0.200 | 0.480/0.860 |

The repaired CPU-only table above replaces the invalidated deep-row evidence. The browser still
initializes WebGPU for the same scene, but no renderer call is included in these measured frames;
this is not a no-GPU or native-runtime measurement.

#### Complete `WebGPURenderer.render()` — software fallback only

| objects | visibility | render p50/p95 | draw calls | frame p50/p95 |
| ---: | --- | ---: | ---: | ---: |
| 500 | all-visible | 0.900/2.900 | 501 | 1.025/3.040 |
| 500 | mostly-culled | 0.200/0.400 | 51 | 0.317/0.528 |
| 1,000 | all-visible | 1.500/3.200 | 1,001 | 1.660/3.560 |
| 1,000 | mostly-culled | 0.400/0.700 | 101 | 0.540/0.950 |
| 2,000 | all-visible | 6.100/12.100 | 2,001 | 6.740/13.270 |
| 2,000 | mostly-culled | 0.600/1.200 | 201 | 0.900/1.770 |

The historical complete-render table remains a flat-control record only. The repaired deep rows
have no accepted complete-render performance result: Chromium dropped the 180-frame complete lane,
including the 4k attempt, with `Instance dropped in popErrorScope`. The repaired CPU-only artifact
is the authoritative deep 4k preparation evidence for this round.

### Decision, synchronization and unknowns

The statistics contract computes
`synchronizedCandidateMedian = candidateMedian + synchronizationMs` and only marks a result
actionable when the synchronized gain is at least 10% and greater than baseline run-to-run noise.
The unit tests cover both conditions. This run measured no native kernel, packing, bridge crossing,
result application, or synchronization sample, so it proposes **no native-kernel threshold** and
does not infer one from browser CPU-only timings.

The next three targets are ranked as follows:

1. **Hardware complete-render attribution — high benefit, medium complexity, low compatibility
   risk.** Re-run the same 500/1k/2k/4k matrix on a named browser hardware adapter and correlate
   renderer stages before changing engine code.
2. **Native/bridge synchronization probe — high decision value, medium complexity, medium
   compatibility risk.** Measure packing, crossing and result application around a bounded transform
   candidate; reject it if the added cost erases the synchronized 10% gain.
3. **Transform or culling kernel — low current benefit, high compatibility risk.** The measured
   preparation rows do not justify a native scene mirror or public Three.js patch; only revisit
   after target 2 and a hardware/native crossover are proven.

Still unknown: Android QuickJS transform and culling cost, native bridge overhead, upload/submit/
present attribution, hardware-GPU behavior, GC/heap effects, material and geometry topology, and
mutation churn. The experiment therefore recommends **STOP** for a bounded transform experiment,
while preserving the harness for a later hardware/native run.

---

## 1. Native Android fps — every green in this section is a **120 Hz arm**

> **Baseline decided 2026-08-28 (PRD-228): acceptance runs on a 60 Hz panel at `maxFps: 60`, and
> accepts at presented p95 ≤ 14 ms.** Every result in §1.3.3 and §1.3.4 below was measured with the
> Pixel 8's Smooth Display on and the panel at physical 120 Hz. They remain true and they remain
> useful — as **high-refresh arms**. They are no longer the acceptance, and no gate may cite them.
>
> The same day, at `resolutionScale` 0.32 on a **60 Hz** panel (Smooth Display off,
> `peak_refresh_rate 60.0`, Battery Saver *off*), SurfaceFlinger measured **49.932 fps** over 2,943
> frames — 2,255 × 16 ms + 678 × 33 ms, **zero 8 ms intervals**. Render p95 was 15.5–17.8 ms in both
> configurations: the same frame, charged 33.3 ms on a 60 Hz panel and 25 ms on a 120 Hz one.
> **Under the decided baseline Bayview does not yet pass.** `device-preflight.mjs` now reads and can
> gate on the active panel mode (`requireRefreshHz`), so no later arm can repeat this ambiguity.

### 1.0 The 120 Hz arm (previously stated as acceptance)

**Goal (owner): 60 fps+ on a physical Pixel 8; 30 fps is a milestone, never a pass.** On 2026-08-28
Bayview reached the active 60 Hz display budget on the physical Pixel 8 while keeping the UI at the
full 2400×1080 presentation size. The game-owned 3D surface renders at scale 0.36 (864×389) and is
composited behind that full-resolution UI. The earlier claim that Chrome ran the scene at 59.99 fps
remains falsified; it is unrelated to this native measurement. A supported `display.maxFps: 120`
path now selects the Pixel's physical 120 Hz mode and uses mailbox presentation. The accepted run
held **63.45–72.52 fps across 11 steady windows / 3,300 frames**, with zero hitches and thermal
status 0 before and after. SurfaceFlinger independently measured 70.358 fps over 3,634 surface
frames at physical 120 Hz, with zero dropped frames. **On the 120 Hz arm the owner's 60+ fps goal is
met; on the decided 60 Hz baseline it is not — see the note opening §1.**

| Where it stands (2026-08-28, **120 Hz arm**) | value |
| --- | ---: |
| Pixel 8, Mali-G715/Vulkan, unplugged, active 120 Hz | **63.45–72.52 fps** |
| 11 steady 300-frame windows | **3,300 frames**, zero hitches, every window above 60 fps |
| Steady frame cadence | presented p50 13.41–15.32 ms; frame p95 at most 13.22 ms |
| SurfaceFlinger cross-check | **70.358 fps**, 3,634 frames, zero dropped frames |
| Presentation contract | UI 2400×1080; 3D 864×389, scaled by the compositor |
| Settled browser render budget | 232 draws; 665,531 triangles; diagnostics empty |
| High-refresh path | `display.maxFps: 120`; physical 120 Hz; mailbox (`vsync=false`) |

### 1.1 The model that fits every measurement

```text
Bayview submits about 818 draws: about 496 in the main pass + about 322 in the shadow pass.
1080p native adds expensive fragment work: the diagnostic estimates a ~63 ms GPU frame.
Chrome draws only 864×303 but is still ~30 fps: draw/pass count is load-bearing, not just pixels.
60 fps needs CPU ≤ 16.7 ms AND GPU ≤ 16.7 ms; 100 fps needs both ≤ 10 ms.
```

Native and Chrome therefore tell the same story at different pixel costs. The full-resolution native
surface makes the fragment-heavy town materials worse, but it is not the origin of the 20–30 fps
class. Bayview is already outside budget at one tenth of the native pixel count.

### 1.2 The fork already taken: Road B — GPU work

The diagnostic post-present drain (`TN_WEBGPU_GPU_DRAIN_PROFILE=ON`, blocking
`wgpuDevicePoll`, default-OFF and never shipped) measured the 1080p GPU frame on the
physical Pixel 8: **gpuDrain ≈ 49 ms in both FIFO and mailbox; GPU-frame estimate ≈ 63–64 ms in
both**. The pre-registered fork selects **Road B: the GPU owns the full-resolution frame**. A
present-seam fix cannot recover 46+ ms. Road A (Dawn on Android / wgpu-native present patch) is
*untried on device*, not refuted — it is parked behind Road B.

The pre-registered decal experiment was run and **falsified**. Hiding all 224 decal slots while
retaining allocation and placement changed gpuDrain 50.468 → 49.867 ms, only −0.601 ms and below
the 2 ms decision threshold. Source was restored.

The pass experiments then found two material costs:

| Diagnostic arm, 1080p native | period p50 | frameReplay p50 | gpuDrain p50 | verdict |
| --- | ---: | ---: | ---: | --- |
| Normal textured town + 2048² sun shadow | 110.898 ms | 12.711 ms | 50.468 ms | control |
| Sun shadow disabled only | 86.750 ms | 6.766 ms | 46.022 ms | material, but insufficient |
| Shadow disabled + flat-material bypass | 68.201 ms | 6.405 ms | 28.314 ms | town shader costs ~17.708 ms of GPU drain at 1080p |

The flat-material arm was diagnostic only. It did not become a proposed fix, and the original
textures, materials and shadows were restored immediately after measurement.

### 1.3 Owner and implementation history

**Layer verdict: the primary 20–30 fps defect is game-owned Bayview render construction.** The
secondary viewport-density and high-refresh-selection defects are engine-owned, but neither can
turn an 818-draw Chrome frame into a 100 fps frame.

Evidence gathered from the live Chrome game:

- Core calls one world render per game frame. Three.js adds exactly one shadow render because
  Bayview enables a dynamic 2048² directional shadow. There is no duplicate engine world render.
- A settled frame reports 804–818 draws and about 1.03–1.11 million submitted triangles. Disabling
  only the sun shadow reduces this to 496 draws and about 570,000 triangles; a warmed development
  sample reached 43.19 fps, still below 60.
- The authored scene has 830 meshes; 492 are effectively visible. The `town` root alone owns 363
  visible meshes and 215 of the scene's 287 shadow casters.
- Those 363 town meshes use 50 materials but **363 distinct geometry identities**. Runtime grouping
  found 295 meshes compatible with only 16 canonical topology/material/shadow-flag groups.
- Core's projection correctly reported `notWorthwhile`: it would draw 835 of 835 candidates and
  created zero batches. Identical material is insufficient on WebGPU because `BatchedMesh` still
  issues multidraw sub-draws; safe instancing needs shared geometry identity.

**2026-08-27 next fix (now landed):** change Bayview's generated render source to reuse canonical
primitive geometries and express dimensions through mesh transforms. Start with the 201
`BoxGeometry` objects, then the 84 cylinders and 22 planes. Preserve each authored mesh, material,
surface tag, transform, raycast and physics object; do not merge away gameplay identity. Once
geometry identity is shared, the existing core projection can instance compatible `(geometry,
material, castShadow, receiveShadow, layers)` groups in its private render mirror. The measured
grouping predicts the town's 363 render candidates can fall to about 84, which should remove roughly
279 main-pass candidates and many of the same shadow-pass candidates. This is a prediction, not a
measured fps result.

### 1.3.1 Geometry identity sharing — landed 2026-08-27 (late), web red-green + first device arms

Landed in `sandbox/fps-framework` (`1be75de`): every plain box/plane/straight-cylinder solid in
`town.ts` now shares one canonical unit geometry and expresses dimensions through `mesh.scale`
(pixel-identical for axis-aligned primitives); frustum cylinders (bollards, pier posts) cache by
shape like `roundedBox` already did. Materials, transforms, surface tags, colliders, raycast and
physics identity untouched; triangles hold at ~1.03M. The projection now reports `projecting:true`,
**11 instanced batches, 227 projected objects, 619 draw candidates (was 835)**, exact lane:
`renderOrder 336` (mostly the decal pool's hidden slots), `tooFewToBatch 140` (van/boat merged
parts, misc singletons), `transparent 75`, `skinned 40` (soldiers), `instanced 12` (palms).

Red-green, same scenario (`playtests/draw-budget.playtest.json`), same session, adapter turing,
headed (the runner's private Xvfb lane still lands on SwiftShader — adapter check in
`artifacts/playtest/capture.json`; capture lane must run `--headed` on `:0` here):

| Arm | settled drawCalls (render entity, in-frame capture) | triangles | verdict |
| --- | ---: | ---: | --- |
| geometry fix stashed (red) | 780 | 1,033,449 | FAIL `lte 550` |
| shared unit geometry (green) | 492 | 1,038,265 | PASS, exit 0 |

The scenario's `render` entity now captures `renderer.info` inside the frame callback — a
between-frames read sees zeros because `renderer.info` resets at each render, which silently
produced 0/0 in the first attempt. `performance.maxDrawCalls` (max over the whole bridge series)
is **unusable as a gate for this game**: the series includes the startup authored-scene phase
(~1345 draws for ~100 frames until startup readiness settles), so its max never goes below ~1370
in any arm. The steady entity gate replaced it.

Desktop native (Xvfb, 900 frames, post-fix): **render.p50 5.37 ms** (bug-hunt record: 10.83 after
`caa78a11`, 12.35 before) — the draw collapse halves desktop render cost. frameReplay p50 1.3 ms.
Desktop fps is not a verdict (present throttles); the render.p50 is.

Device, first arms of the session — **thermally confounded later in the session (battery 29.4 →
33.6 °C, status 0 → 1, phone charging at 50 % throughout; no clean cool-device A/B yet)**:

| Arm | pre-fix | post-fix | read |
| --- | ---: | ---: | --- |
| 1080p FIFO | 20.0–20.9 (doc) | 20.71 steady, JS frame p50 24.0 | flat — GPU/period-bound (period 48.1, present 16.3) |
| 720p mailbox | 34.39 (SF 34.2, doc) | 31.4–33.0 (SF cross-check 33.644) | inside session drift; phase split: render 14.9, hostGap 9.4 (replay 5.9, present 4.8), residual 4.4 |

Phase reading of the post-fix 720p mailbox frame: render p50 14.9 ms ≈ 492 draws × ~30 µs/draw of
three.js WebGPU submission; replay ~5.9 ms also scales with draw count. Reaching 60 fps needs the
JS frame + host ≈ 16.7 ms — the draw count must fall below ~300 or per-draw cost must fall, and
the 1080p arm additionally needs the fragment cost down (2048² shadow is a GPU constant across
viewport sizes).

### 1.3.2 Draw collapse completed + the GPU attribution (2026-08-28, ~01:00–02:00)

Second and third game commits (`d9dc879` and the material commit): ten targets share unit
primitives (60 → ~7 draws); every parked pool settles after the 2 s prewarm window — breakable
shards (27), muzzle-flash cards (7), and engine tracer streaks (28, `TracerPool3D.settle` landed
in core with a unit test, tarball `…tracer-settle-c73594118297`); `game.ts` now brackets the
projection reconcile inside the frame-budget render phase (its cost used to hide in `residual`);
town materials sample triplanar top-2 dominant-axis (`triTop2` in `townMaterials.ts`) and take the
1.618× breakup crossfade on the colour map only. Web settled draws: **780 → 492 → 403 → 315**,
triangles flat ~1.037M, pixel-diff of the spawn view against the 492-draw frame: **0 of 921,600
pixels differ by more than 8** — the material change is look-neutral.

Device, 720p mailbox (`wm size 720x1600` + `present_uncapped=1`), as the phone cooled through the
session: 34.6 → 37.1 → **47.2 → 53.1 → 50.9 fps steady** (presented 18.7, frame p50 9.3, render
8.8). The earlier 34–37 readings were thermally depressed (battery 33–34 °C after back-to-back
runs; the 29–31 °C windows read 47–53). **Best measured: 53 fps; 60 not reached.** The remaining
gap is the GPU frame (~18–19 ms at 720p against a 16.7 budget; the CPU chain is done at 9.3).

GPU attribution — the drain build (`-PthreenativeGpuDrainProfile=true`), 720p, ablations via
localStorage gates the host reads from `files/mystral/storage/<cwd-stem>.json` (push with
`run-as com.threenative.bayview cp /data/local/tmp/<f> files/mystral/storage/default.json`):

| Arm | gpuDrain p50 ms |
| --- | ---: |
| full scene, full materials, shadow on | 27.57 |
| shadow OFF | 27.89 (≈0 — the shadow is not a GPU cost) |
| shadow off + flat town materials | 24.22 (materials ≈ 3.3) |
| + town hidden | 13.55 (flat town pass ≈ 11.5) |
| + sky and soldiers hidden | 6.66 (soldiers + sky ≈ 6.9) |
| + `scene.environment` null | **0.35 — the IBL ablation is ~6.3 ms on a nearly-empty scene; this is an upper bound, not the bakeable frame cost** |
| full scene, IBL null | 22.24 (IBL ≈ 5.3 across the covered scene) |

Conclusion: the 720p GPU frame is spread per-pixel — the IBL ablation is ~5–6, the flat town pass ~9–11
(geometry/dispatch/PBR core, not the texture fetches: `triTop2` cut fetches 24 → 10 and moved
gpuDrain not at all), material graphs ~2.5, soldiers/sky ~7 — over a true floor of 0.35. The
1080p arm stays GPU-bound (present 14.4 of a 49 ms period; 20.2 fps, unchanged by the CPU wins).

Falsified this session (do not re-derive): 1024² shadow map (33.0 vs 34.6 — flat at 720p
mailbox); PCFSoft/shadow cost (~0); town texture fetches as the GPU cost (top-2 flat); the
hemisphere-fill IBL replacement (−5.3 ms GPU but visibly darker in shaded faces at two tuning
attempts — `TN_NO_IBL` gate ships off by default; the A/B screenshots are
`/tmp/draw-budget-tritop.png` (IBL) vs `/tmp/draw-budget-hemisphere*.png`).

### Environment attribution — PRD-307, 2026-09-01

The `scene.environment` ablation above removes both one-time PMREM work and per-fragment
environment sampling, so its ≈6.3 ms difference is an upper bound on what a build-time bake could
recover. A same-session five-arm control measured a set-once environment at 2.18 ms and no
environment at 2.55 ms; the −0.37 ms inversion is a lower-bound/noise observation, not a complete
resolution floor, and an independent positive resolution observation is required. Forcing PMREM every
frame measured 3.79 ms, or **+1.61 ms** over the static arm. Bayview assigns `scene.environment`
once and has no `ProbeVolume`, `CubeCamera`, or `needsPMREMUpdate` path, so the +1.61 ms control is
not its workload. The static bakeable benefit is unresolvable and below the standing 2 ms bar.

Full attribution record: [`environment-cost-attribution-2026-09-01`](environment-cost-attribution-2026-09-01.md).

The designed path to 60 (each measured, none yet a pass): the GPU needs −2 ms of the ~18.7
presented — candidates in order: a cheap single-fetch IBL approximation (TSL `pmremTexture` at a
fixed mip via `material.envNode`, keeping the look the hemisphere cannot), the flat town pass's
9–11 ms (three's PBR core + dispatch for ~315 draws — the GPU-side twin of the closed CPU
per-draw question, **not** covered by that evidence), and CPU is already inside budget. The named
next instrument (§1.5) remains GPU timestamps to split the town pass into dispatch vs fragment.

Red-green handoff (completed by §1.3.3):

1. Add a Bayview playtest that currently fails with a steady `maxDrawCalls` threshold and still
   asserts the town triangle floor/nonblank frame.
2. Share canonical geometry in `sandbox/fps-framework/src/render/`; do not change textures or
   materials.
3. Require `TN_RENDER_PROJECTION` to report `projecting:true`, a nonzero batch count and a materially
   lower renderer draw count before measuring fps.
4. Re-run web rAF + SurfaceFlinger and native `TN_FRAME_BUDGET` + SurfaceFlinger on a cool device;
   only then choose the next lever between the 2048² game shadow and native pixel density.

### 1.3.3 Bayview reaches the native 60 Hz budget without shrinking the UI (2026-08-28)

**Layer verdict:** the fix belongs to Bayview's generated render source, not an engine package. The
resolution is a decision about how this game looks, and the project rule puts appearance decisions
in generated `src/render/` or game source. Web, desktop and non-Android paths remain at scale 1.

Two sandbox commits close the central frame-budget gap:

- `f83103f` uses a fixed roughness-0.8 PMREM IBL node, keeps dominant town/truck/awning shadows,
  removes shadows from small moving targets and effects, and holds the settled browser scene to 232
  draws and 665,531 triangles.
- `95d8729` changes only Android native's 3D resolution scale from 0.44 to 0.36. The physical
  overlay/UI surface remains 2400×1080; SurfaceFlinger reports the game surface transform at about
  2.777×, consistent with an 864×389 3D buffer scaled to the display.

Red-green on the same physical Pixel 8:

| Arm | steady result | verdict |
| --- | ---: | --- |
| scale 0.44 | 56.31–58.28 fps | red |
| scale 0.40 | 58.51–59.31 fps | insufficient |
| scale 0.36 | last four windows 59.81–59.99 fps | 60 Hz frame budget reached |

Acceptance used the intended Mali-G715 Vulkan adapter, normal real-time ticks, an unplugged device,
and the active 60 Hz display mode. Before the run the battery was 73%, device temperature 32.8 °C,
and Android thermal status 0 (`NONE`). The measured workload stayed in `playing` with five live
enemies, AI, physics, audio, HUD, PBR materials and retained dominant shadows. A controlled clone
reset the steady-state accumulator after startup and collected 2,009 frames over about 33.5 s:

| Metric | Result |
| --- | ---: |
| presented frame time | p50 16.66 ms; p95 22.87 ms; p99 32.40 ms |
| p50-derived nominal rate | 60.02 fps |
| worst / spikes | 74.72 ms / 13 frames above the spike threshold |
| largest section peaks | outside-game 73.45 ms; enemies 62.42 ms; game frame 62.80 ms |
| section p99 | outside-game 30.86 ms; enemies 3.05 ms; game frame 3.58 ms |

This proves the nominal 60 Hz budget on the current display mode; it does **not** prove throughput
above 60 fps. The remaining defect is tail smoothness: central frame pacing is at budget, while 13
of 2,009 frames spiked and the worst frame reached 74.72 ms.

The temporary reset/logger used for the exact 2,009-frame aggregate was removed before the final
APK. The clean rebuild has SHA-256
`3d072453ee23932d5153678cc0d5e7900a44c0c890d7a8cc57586635812f8b95`; a clean open reported
Mali-G715/Vulkan, `TN_RENDER_SCALE` 0.36 (**the live tree has since moved to
`renderer.android.resolutionScale: 0.32`; this figure describes the accepted build, not HEAD**),
`TN_NATIVE_SMOKE_READY:webgpu`, and
`TN_NATIVE_SMOKE_FIRST_FRAME`. The physical Android input smoke then fired the weapon: its artifact
contains the muzzle flash and the HUD changed from 30 to 29 rounds.

Verification status: sandbox typecheck and Android build pass; all 23 behavior scenarios pass; the
settled draw-budget scenario passes at 232 draws with empty diagnostics. The aggregate `pnpm test`
still exits nonzero in its final scale audit because two pre-existing content checks fail (`door`
missing and a 1.000 m muzzle-flash quad above the 0.3 m limit). This Android-only branch cannot
affect that web content audit. The sandbox has no lint script.

### 1.3.4 Supported 120 Hz + mailbox — sustained >60 acceptance green (2026-08-28)

**Layer verdict:** the missing high-refresh contract was engine-owned. A game cannot portably tell
Android which display mode to prefer, so the public config, native packagers, runtime pacing and
Android surface lifecycle now carry one value:

```ts
export default {
  display: { maxFps: 120 },
} satisfies IThreeNativeConfig;
```

`display.maxFps` defaults to 60, accepts whole numbers from 0 through 1000, and uses 0 for uncapped.
The runtime applies it before the first frame. Android packages it as `TN_MAX_FPS`, passes the same
value to the native pacing cap, calls `Surface.setFrameRate()` on API 30+, and reapplies the request
on resume and whenever Android creates or replaces the surface. Every generated template states
the conservative 60 fps default; a game opts into 120 without changing its UI or render source.
Desktop and iOS carry the same software ceiling through their packaged config.

The first mode-selection report was wrong: it read the app's 120 Hz override rather than the
physical active SurfaceFlinger mode. A valid cool run exposed Android's
`PRIORITY_LOW_POWER_MODE_RENDER_RATE max=60` vote because Battery Saver was on. The app voted 120,
but the physical display stayed at 60 Hz; SurfaceFlinger measured 58.082 fps over 6,192 frames.
After Battery Saver was disabled, SurfaceFlinger genuinely reported active mode 1 at 120 Hz.

That exposed a second engine defect. FIFO presentation quantizes an 11–12 ms frame that misses one
8.33 ms interval to the 60 Hz divisor. With the physical display at 120 Hz, Bayview's first FIFO
steady window was still only 57.8 fps. The runtime keeps FIFO **below** the full-refresh target and
uses its already-supported mailbox/immediate path at 60, above 60 and uncapped — the code is
`config.vsync = config.maxFps != 0 && config.maxFps < 60`
(`packages/runtime-native/src/platform/android_main.cpp:221`), so **`maxFps: 60` selects mailbox,
not FIFO**. An earlier revision of this paragraph said FIFO covered "1–60" and was wrong at the
boundary. The software ceiling remains active in either mode.

Red-green proof in the engine tree:

| Gate | Result |
| --- | ---: |
| config validation/default and all generated templates | **311/311 passed** |
| focused Android presentation/packaging/lifecycle tests | **26/26 passed** |
| Android/iOS/desktop packaging and runtime contracts | **577 passed, 1 unrelated preflight failure** |
| Android arm64 host + Java activity build | **passed** |
| desktop runtime and CLI compile | **passed** |
| core typecheck | **passed** |
| root typecheck | max-fps path clean; blocked by 3 pre-existing tracer-test nullability errors |

The final Bayview APK has SHA-256
`a519e4043de40c532c29e53a9d0175952959160d36dd41d1de041d669084e0c4`. Its manifest contains
`TN_MAX_FPS=120`; the approved 2400×1080 overlay HTML, JavaScript and CSS hashes match the staged UI
bundle byte for byte. On the physical Pixel 8 the host reported `maxFps=120`, `vsync=false`, mailbox
presentation and an applied `TN_DISPLAY_FRAME_RATE_REQUEST`. SurfaceFlinger independently reported
physical active mode 1 at 120 Hz and a 120 Hz vote for the Bayview surface.

The first mailbox run started unplugged over Wi-Fi ADB at 51% battery, 38.3 °C battery temperature,
37.0 °C skin and thermal status 0. After discarding startup, its first 600 steady frames measured
66.84 and 63.01 fps with zero hitches. The device then crossed to thermal status 1 (39.5 °C skin):
later windows fell to 57.84, 54.47 and 53.25 fps. SurfaceFlinger measured 56.957 fps over the whole
2,542-frame surface lifetime and recorded 224 true 8 ms present intervals, confirming that mailbox
removed the 60 Hz divisor even though the warmed run did not sustain the target.

The accepted rerun started at 60% battery, discharging over Wi-Fi ADB, with battery temperature
33.4 °C, skin 33.7 °C and thermal status 0. Battery Saver re-enabled when the charger was removed;
the run explicitly disabled it and verified `low_power=0` before a cold launch. The formal command

```sh
threenative-playtest perf --logcat 192.168.1.192:5555 \
  --require-windows 4 --min-fps 60 --text
```

exited 0 / `PASS`. After discarding window 1, all 11 steady windows passed: **63.45–72.52 fps over
3,300 frames**, zero hitches, presented p50 13.41–15.32 ms, frame p95 at most 13.22 ms and render
p95 at most 11.15 ms. The post-run device remained at thermal status 0, 34.0 °C battery temperature,
38.7 °C skin, 60% and discharging.

SurfaceFlinger independently held physical 120 Hz and measured **70.358 fps over 3,634 frames**,
with zero dropped, late-acquire or bad-desired-present frames. Its histogram recorded 1,007 8 ms
and 2,511 16 ms present intervals. This closes the owner's sustained 60+ fps goal without changing
the approved UI or the game-owned 0.36 3D scale.

The first CLI read falsely exited 1 because Android mirrors each console marker through both
`MystralStdio` and `MystralJS`: it parsed windows as `[1,1,2,2,…]` and discarded only one startup
copy. A red-green parser regression now counts byte-equivalent frame-budget payloads once while
leaving differing observations visible. Its focused suite passes 16/16, the rebuilt CLI passes
`publint`, and the same unchanged logcat source produces the exit-0 result above.

### 1.3.5 The pixel ladder — PRD-228 Phase 0's falsification gate, PASSED (2026-08-28)

**Verdict: Change A stands as a performance contract.** Five rungs, monotonic in pixel count, and
a slope an order of magnitude above the 2 ms/Mpx floor the PRD pre-registered as its falsifier.

**This is a 120 Hz arm, and it is a slope arm, not an acceptance.** It has to be. On the decided
60 Hz baseline every rung at or under 16.7 ms reads exactly 16.7 ms — SurfaceFlinger's own
`present2present` histogram for the earlier 60 Hz 0.32 arm is 16 ms and 33 ms bins with nothing
between them. A panel cannot resolve a frame cost below its own vsync period, so the PRD's
"uncapped ladder" was run at 120 Hz with `debug.threenative.present_uncapped 1` and
`display.maxFps: 240`. Acceptance still runs at 60 Hz and no gate cites this table.

Same commit, same session, same scene; one APK per rung, sha256 recorded; cold launch per method
rule 4 with `pidof` proved empty; one discarded launch per arm plus two discarded whole runs at
session start per rule 1; the first two windows of every kept run dropped; `device-preflight.mjs`
run before each arm with `requireRefreshHz: 120`, `requireDischarging: true`, thermal NONE.

| arm | scale | drawing buffer | Mpx | presented p50 | presented p95 | render p50 | our fps | SurfaceFlinger fps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `b100` | 1.00 | 2400×1080 | 2.592 | 39.14 | 42.92 | 17.43 | 25.43 | **26.54** |
| `b072` | 0.72 | 1728×778 | 1.344 | 28.48 | 34.49 | 14.38 | 35.15 | **37.01** |
| `b055` | 0.55 | 1320×594 | 0.784 | 21.00 | 28.72 | 11.11 | 46.62 | **47.35** |
| `b044` | 0.44 | 1056×475 | 0.502 | 18.16 | 25.85 | 10.08 | 53.50 | **54.28** |
| `b032` | 0.32 | 768×346 | 0.266 | 16.73 | 24.32 | 9.28 | 57.62 | **61.84** |

```text
presented p50 = 9.94 ms/Mpx x pixels + 13.79 ms     R2 0.992, n=5, monotonic
presented p95 = 8.14 ms/Mpx x pixels + 22.32 ms     R2 0.991
render    p50 = 3.60 ms/Mpx x pixels +  8.50 ms     R2 0.970
```

SurfaceFlinger cross-check on the endpoints, game `(BLAST)` layer, `present2present`:
`b100` = 33 ms×830 + 42 ms×826 (four and five vsyncs); `b032` = 16 ms×2810 + 8 ms×443. Both agree
with our own fps to within 0.5–4.2 fps and neither shows the clamped single-bin signature.

> **WITHDRAWN 2026-08-28, same day, pending a probe: the `(scale × samples)` result below.** The
> fixed-frame-cost analysis (`docs/verification/prd-228-fixed-frame-cost-2026-08-28.md` §5) found
> that `TN_GPU_TEXTURES` is **byte-identical** between each `antialias: true` arm and its
> `antialias: false` twin — same 310 MB / 73 textures / 19 buckets at 0.32, same 318 MB / 73 at
> 0.55 — with no multisampled attachment appearing anywhere. Either the `antialias` request never
> reached a sample count on the native path, or the census cannot see the attachment. **If the
> flag was inert, "MSAA is free below 0.5 Mpx" measures nothing**, and the `+7.47 ms at 0.55` that
> looked like a cliff is better explained by the same analysis's finding of late-session drift in
> that exact arm (`c055aa` vs `b055`: +35.6 % with `frameReplay` up 4.98 → 7.38 ms, a segment MSAA
> cannot touch). The arms were built before `surface.sampleCount` shipped, so those logs cannot
> answer it. **One arm with the current core settles it**, because every window now reports the
> sample count it actually drew at. Change C's default is not decided until then.

**Two results the PRD did not predict, and they matter more than the confirmation:**

1. **The pre-registered 5.51 ms/Mpx was low by 1.8×.** It came from two cap-clipped points inside
   a 0.09 Mpx span. Over a 2.33 Mpx span the slope is **9.94 ms/Mpx**, so Change A's predicted
   saving for an untuned game is **2.256 Mpx × 9.94 = 22.4 ms/frame**, not the 12.4 ms filed.
2. **The intercept is 13.79 ms of a 16.67 ms budget.** At zero pixels this scene would still cost
   13.8 ms. Resolution scaling therefore buys Bayview about **2.9 ms of pixel budget at 60 fps and
   0.2 ms against the decided 14 ms bar** — roughly 0.02 Mpx. Bayview cannot reach the accepted
   baseline by scaling alone, whatever the scaler does, and the remaining work is in that fixed
   term rather than in the fill rate. This is a measurement, not an inference from it.

**Machine notes, so the next session does not re-derive them.** Battery Saver auto-armed at
`low_power_trigger_level 75` the moment the charger came off at 56 % and had to be pinned off; the
phone idles at 34–37 °C screen-on and never returned to the 31.5 °C the device lane usually asks
for, so arms were gated on thermal status NONE with the temperature recorded at both ends instead,
and rung order was scrambled (1.00, 0.72, 0.44, 0.32, 0.55) so thermal drift could not correlate
with pixel count. Six arms cost 8 % of battery.

**Method rule 9 is now wrong and needs replacing.** Its live-window test is `update.mean ≥ 3 ms`.
PRD-227 cut the update phase to **0.46 ms** in steady state, so that threshold rejects every live
window and accepts nothing. The classifier used here is: not one of the two windows after launch,
`substeps.mean ≥ 1`, and `update.mean > 0.05` — with the whole `update.mean` series recorded per
arm so the classification is auditable rather than asserted.

Artifacts: `<bayview>/artifacts/prd228/<arm>/` — `apk.sha256`, `config.txt`, `preflight-before.json`,
`battery-before.txt`, `battery-after.txt`, `logcat-kept.txt`, `sf-kept.txt`, and the discarded run
beside each. Harness: `tools/prd228-arm.sh`, `tools/prd228-ladder.sh`, `tools/prd228-read.mjs`.

### 1.3.6 The adaptive scaler on the device — it works, and it reaches the floor (2026-08-28)

**First device run of `resolutionScale: "auto"`.** Bayview, `display.maxFps: 60`, 60 Hz panel,
FIFO, engine core built from this tree and installed as a tarball with the installed bytes
verified (`threenative-core-0.3.0-auto-scale-3242a17bf93a.tgz`; `dist/index.js` contains
`scaleSource`). APK sha256 `b898ed4c…`. **Caveat on the record: the phone was on AC** —
`preflight-before.json` says `"charging":true,"chargingSource":"AC"` — so this is a functional
verification of the loop, **not an acceptance arm**. Thermal NONE at start, LIGHT at the end.

The scaler walked every pre-registered rung by itself, one step per window plus its cooldown:

| window | scale | drawing buffer | fps | presented p50 | presented p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.00 | 2400×1080 | 28.99 | 33.55 | 38.46 |
| 4 | 0.72 | 1728×778 | 35.65 | 27.00 | 35.25 |
| 8 | 0.52 | 1248×562 | 43.35 | 22.07 | 30.62 |
| 10 | 0.44 | 1056×475 | 48.95 | 19.84 | 26.27 |
| 14 | 0.32 | 768×346 | 48.59 | 19.77 | 27.36 |
| 18 | 0.23 | 552×248 | **55.37** | 17.04 | 23.40 |

SurfaceFlinger, game `(BLAST)` layer, whole run including the descent: **41.123 fps** — lower than
the last window because it averages every rung walked through, which is the point of the next
paragraph. Every window carried `surface: {resolutionScale, scaleSource:"auto", sampleCount,
drawingBufferWidth, drawingBufferHeight}`; the reporting defect that let the record say 0.36 while
the tree said 0.32 is closed end to end on a physical device.

**Two results, both actionable:**

1. **It reached the floor and did not reach 60.** Exactly what §1.3.5's 13.79 ms intercept
   predicts: 83 % of Bayview's frame does not scale with pixels, so no resolution reaches the
   target. The window now reports `atFloor` and `perf --text` prints "AT FLOOR, budget not met",
   because a window reporting 0.23 and nothing else reads as a budget met at a low resolution.
   **Bayview's remaining work is in the fixed term, not the fill rate.**
2. **The descent cost about three minutes.** Falling one rung per window plus one cooldown window,
   at 300 frames per window and ~30 fps at the top of the ladder, is ~20 s per rung and ten rungs
   from the ceiling. A game that starts at DPR-1 physical therefore spends minutes visibly at
   29 fps before settling. That is the pre-registered controller behaving exactly as specified and
   it is still a bad first impression. **Open, not fixed here:** a first-window multi-rung jump —
   the slope in §1.3.5 predicts the landing rung from one window's presented p50 in closed form —
   would reach the settling point in one step instead of ten. It is a change to PRD-228's Phase 2
   table, so it is filed rather than tuned in.

### 1.3.7 A scaffolded template holds 60 fps at full resolution, and the bug that found (2026-08-28)

**PRD-228 Phase 4's headline criterion, met once — with two caveats stated below.** A platformer
template scaffolded by `pnpm sandbox` into `sandbox/prd228-accept`: never hand-tuned,
`display.maxFps: 60`, `renderer.resolutionScale: "auto"`, and **no resolution constant anywhere in
its source** (`grep -rn resolutionScale src/` is empty). Engine installed from tarballs like a
user's machine, installed bytes verified. APK sha256 `fd71c9c0…`.

| | |
| --- | ---: |
| Settled scale | **1.00 — full 2400×1080** |
| Windows held at that scale | **59 consecutive** (7–65), ~17,700 frames, ~5 minutes |
| fps | **59.99–60.02** |
| `frame` p95 (the game's own work) | **6.51–8.70 ms** of a 16.67 ms budget |
| `presented` p95 (the panel's cadence) | 17.23–18.87 ms |
| SurfaceFlinger, game `(BLAST)` layer | **61.734 fps**, 19,372 of 19,562 frames at 16 ms, **0 dropped, 0 janky** |
| `atFloor` | false throughout |

The scaler dipped to 0.85 on the cold-start window (51.52 fps while loading), then climbed back to
1.00 at window 7 and never moved again.

**Caveats, on the record:** the phone was on **AC** — `preflight-before.json` says
`"charging":true` — and the criterion asks for three captures; this is one. Thermal was LIGHT at
the start of the long run and LIGHT at the end.

#### The defect this arm found, which is the reason it was worth running

The **first** run of this template walked to the floor. Same game, same 60 fps, and the scaler
took it from 2400×1080 to **552×248** across 20 windows and then reported `atFloor: true` —
claiming the budget was not met while it was being met at 59.99 fps.

The cause: **under FIFO the presented interval is the panel's period, not the game's cost.** The
controller's pre-registered down-trigger was `presented p95 > 14 ms`; a game locked at 60 fps on a
60 Hz panel reports presented p95 around 17.5 ms, so that condition is true forever. The template
had `frame p95` of 7.99 ms out of 16.67 at full resolution — enormous headroom — and the
controller destroyed its image quality anyway. **This affected every shipped configuration**,
since `maxFps: 60` on a 60 Hz panel is the decided baseline.

Fixed in `6898e5ee`: the trigger is **fps against the configured target**, which is correct capped
and uncapped because it comes from the mean presented interval and dropped frames pull it down on
their own. `presented p95` survives only as the up-step's tail guard, where a capped panel's own
p95 floor near 1.05× budget sits inside the 1.15× bar.

**The same error was in PRD-228's acceptance bar** — "accept at presented p95 ≤ 14 ms" is
unreachable on the panel that same decision pins. Amended there to `frame p95 ≤ 14 ms` plus fps at
target plus SurfaceFlinger confirming no dropped frames. **The general lesson, worth carrying:**
on a vsync-capped target, `presented` measures the panel and `frame` measures the game. Any bar or
trigger written against `presented` is measuring the display.

### 1.3.8 Acceptance, three captures — and `renderer.antialias` proven inert (2026-08-28)

**PRD-228 Phase 4's headline criterion, met.** Same scaffolded platformer as §1.3.7, this time
**unplugged, discharging, thermal NONE before each capture**, 60 Hz panel, cold launch each time.

| capture | settled scale | windows held | fps | `frame` p95 | SurfaceFlinger |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **1.00 — 2400×1080** | 33 of 39 | 59.59–60.02 | 6.53–8.49 ms | 61.817 fps |
| 2 | **1.00 — 2400×1080** | 33 of 39 | 59.59–60.02 | 6.39–8.39 ms | 61.088 fps |
| 3 | **1.00 — 2400×1080** | 33 of 39 | 59.52–60.06 | 6.98–8.37 ms | 61.504 fps |

`atFloor` false throughout. Capture 3's `present2present`: 11,681 frames at 16 ms, 124 at 33 ms,
one 650 ms startup frame. Against the amended bar — `frame p95 ≤ 14 ms`, fps at target,
SurfaceFlinger confirming no dropped frames — all three pass, and the worst `frame` p95 across
every capture is 8.49 ms, a little over half the bar.

The scaler dips one rung on the cold-start window and climbs back to 1.00 by window 7 in all three.
**A game nobody tuned reaches its target at full native resolution and stays there.**

#### `renderer.antialias` does not reach the GPU — proven, and it invalidates the sampling table

The `(scale × samples)` ladder was withdrawn on suspicion the same day; this settles it. One more
arm, same template, same device, `renderer.antialias: true` in `threenative.config.ts`:

```
surface: {"resolutionScale":1,"scaleSource":"auto","sampleCount":1,
          "drawingBufferWidth":2400,"drawingBufferHeight":1080,"atFloor":false}
TN_GPU_TEXTURES: 2400x1080 rgba16float x2, 2400x1080 depth24plus x3, ... — no multisampled attachment
```

**RESOLVED the same day — root cause found and fixed (`d476ec36`); the paragraph below is kept as
the trail that led there.** three's WebGPU backend sets
`this.compatibilityMode = !device.features.has("core-features-and-limits")` and then
`if (this.compatibilityMode) renderer._samples = 0`. Our bindings had no entry for that feature
name, so three concluded it was driving a reduced-capability **compatibility** device and disabled
MSAA outright — along with switching its depth-texture, MRT-blending and shader texture-type paths,
for every native game since the bindings were written. Compatibility mode is a feature *level* a
caller opts into and this runtime never requests one, so the feature is now requested on the Dawn
branches and answered truthfully at both query sites. Measured on the same probe before and after:
`compatibilityMode true → false`, `hasCoreFeatures false → true`, `sampleCount 1 → 4`.
**The `(scale × samples)` ladder stays withdrawn** — it was run against the inert flag and must be
re-measured now that sampling actually reaches the GPU.

**`sampleCount: 1` with sampling requested**, and a texture census identical in shape to the
`antialias: false` runs. Traced as far as the evidence goes: the value is in the built bundle
(`renderer: { preferWebGPU: true, resolutionScale: "auto", antialias: true }`),
`resolveRendererAntialias` is in the bundle and returns the config value, `createRenderer` passes
`{ antialias: options.antialias ?? true }` into `WebGPURenderer`, and three's bundled constructor
reads `this._samples = samples || antialias === true ? 4 : 0` with `get samples()` returning
`_samples` directly. Every link reads correct and the delivered frame is single-sampled. **The
break is below the config seam and is not yet located.**

Consequences, both binding:

1. **Every `(scale × samples)` number is withdrawn.** "MSAA is free below 0.5 Mpx" compared an
   inert flag against itself. The `+7.47 ms at 0.55` that looked like a tile-memory cliff is
   better explained by the late-session drift the fixed-cost analysis found in that same arm
   (`frameReplay` 4.98 → 7.38 ms, which MSAA cannot touch). **Change C has no measured default.**
2. **`renderer.antialias` is a documented, shipped, accepted option that does nothing on native.**
   It is in every template's `AGENTS.md` as part of the pixel budget. That is worse than an absent
   feature: a game turns it on, sees no cost, and concludes sampling is free.

### 1.3.9 The sampling table, re-measured against a flag that works (2026-08-28)

The `(scale × samples)` ladder was withdrawn twice today — first on suspicion, then on proof that
`renderer.antialias` never reached the GPU. With the compatibility-mode fix in (`d476ec36`,
`b674c4cb`) and `surface.sampleCount` reading **4** on device, it was run again. Bayview, physical
Pixel 8, 120 Hz, uncapped present, `maxFps: 240`, pinned scales, cold launch per arm.

| scale | samples | presented p50 | presented p95 | render p50 | fps | live windows |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.32 | 1× | 18.24 | 24.42 | 10.37 | 53.40 | 8 |
| 0.32 | **4×** | 21.45 | 27.12 | 12.50 | 46.76 | 29 |
| 0.44 | 1× | 19.48 | 27.85 | 9.71 | 49.33 | 4 |
| 0.44 | **4×** | 24.30 | 27.21 | 14.05 | 41.63 | 25 |
| 0.55 | 4× | 30.91 | 45.90 | 16.67 | 32.77 | 4 |

```
scale 0.32: 4x MSAA costs +3.21 ms presented p50, -6.64 fps
scale 0.44: 4x MSAA costs +4.82 ms presented p50, -7.70 fps
```

**The withdrawn table said the opposite.** "MSAA is free below 0.5 Mpx" was the reading of an inert
flag compared against itself. Measured against a flag that works, **4× MSAA costs more than a full
resolution rung**: +3.21 ms at 0.27 Mpx is more than the 0.32 → 0.27 step buys back, and the cost
grows with pixels rather than sitting in tile memory for free. Mali-G715 resolving MSAA in tile
memory does not make it free on this scene.

**Change C's rule, from measurement: spend resolution before samples, and leave `antialias`
opt-in.** The scaler moves resolution only, which is now the measured-correct behaviour rather
than a placeholder. A game that wants sampling can afford it by pinning a lower scale, and the
per-window `sampleCount` beside the scale is what lets it see the trade it made.

**Two arms are thin and named as such.** `0.44/1×` and `0.55/4×` hold four live windows each; the
80-second arms did not fill three windows once MSAA slowed the frame, which is why the two 4× arms
were re-run at 220 seconds (29 and 25 live windows) and why the reader refused the short ones
rather than reporting them. `0.55/1×` was refused outright and there is **no valid 0.55 pair** —
the +7.47 ms once recorded at that rung stays withdrawn and is not replaced.

### 1.3.10 PRD-238 projection culling (2026-08-28)

This is an engine-owned projection measurement. The probe builds a source `Scene` with 2,048
same-geometry anchors and 4,096 unique-geometry members sharing one material, then calls
`new SceneRenderProjection(source).reconcile()`. It does not construct an
`IProjectionProjectPlan` or call `ProjectionMirror.apply`; the material batch is admitted by the
normal planner. The 4,096 unique members are 75% beyond the camera's far plane. It is separate
from the load game's hand-authored L2 `InstancedMesh`, which is deliberately not a projection batch.
The browser was desktop Chrome with the NVIDIA/Turing adapter, 1280×720, vsync off. The exact run
was:

```sh
TMPDIR=/dev/shm pnpm bench:engines --arm tn-web --frames 900 --warmup 225 --repeats 3 --ladder 256 --modes L2 --skip-baseline
```

The measured window was frames 226–899 (674 samples per arm); no whole-run average was used.

| culling arm | scene sub-draws | render.p50 per repeat (ms) | median render.p50 | render.p95 per repeat (ms) |
| --- | ---: | ---: | ---: | ---: |
| OFF | 4,097 | 1.60 / 1.60 / 1.60 | **1.60** | 2.40 / 2.40 / 2.50 |
| ON | 1,025 | 1.30 / 1.10 / 1.00 | **1.10** | 2.10 / 1.70 / 3.40 |

The raw `renderer.info.render.drawCalls` values were 4,098 → 1,026 because Three's default
framebuffer path adds one full-screen presentation draw. The harness removes that one presentation
draw from this table, so ON removed **3,072 scene sub-draws (75%)** and moved median desktop
`render.p50` **−0.50 ms** (1.60 → 1.10 ms). The live setting is
`PER_OBJECT_FRUSTUM_CULLED = true`; it is not a game-facing option.

Phase 3 was entered because the batched result won. The instanced probe used the same 900-frame,
three-pair window, moved its source scene each frame, and reported `mesh.count` plus renderer
triangles at the midpoint:

| members | submitted instances OFF → ON | triangles OFF → ON | median render.p50 OFF → ON (ms) |
| ---: | ---: | ---: | ---: |
| 128 | 192 → 192 | 2,305 → 2,305 | 0.90 → 0.90 |
| 256 | 384 → 384 | 4,609 → 4,609 | 0.90 → 0.90 |
| 512 | 768 → 768 | 9,217 → 9,217 | 1.00 → 0.90 |
| 1,024 | 1,536 → **256** | 18,433 → **3,073** | 0.70 → 0.80 |
| 4,096 | 6,144 → **1,024** | 73,729 → **12,289** | 0.30 → 0.60 |

Those numbers are a historical exploratory compaction arm, not an enabled default. The final repair
removed the losing compaction path entirely: the 1,024-member case regressed from 0.70 to 0.80 ms
and the 4,096-member case regressed from 0.30 to 0.60 ms (OFF → ON), so no floor is claimed and no
new winning measurement is being implied. The production instanced lane keeps `mesh.count` at the
active member count, has no compaction switch or scratch census, and retains the no-allocation
reconcile guard. No Phase 4 spatial index was added.

Core tests cover the dense-prefix/reconcile path, the forced-visible material split, the failed
render assertion, and the steady-state constructor guard. A static regression check rejects a
direct fabricated-plan or `ProjectionMirror.apply` shortcut in the load harness.

### 1.3.11 PRD-238 consumer conformance (2026-08-29)

The real browser fixture uses `SceneRenderProjection` as the consumer, renders its `root`, and
checks source/projected raycasts plus `projection.inspect()` reconciliation. An initial unheaded
run reached SwiftShader and exited 1 with Three's `OperationError: Instance dropped in
popErrorScope`; the final headed recipe reached NVIDIA/Turing and passed on the actual WebGPU
renderer. This is a browser/WebGPU result, not a native claim.

Projected WebGPU run (exit 0):

```sh
node packages/playtest/dist/runner/cli.js examples/engine-load-test/playtests/projection-conformance.playtest.json --url http://127.0.0.1:5203/projection-conformance.html --server-command "pnpm --filter threenative-engine-load-test exec vite --host 127.0.0.1 --port 5203" --browser-recipe webgpu --headed --artifacts artifacts/prd-238-repair-playtest-webgpu-headed-final
```

Source WebGPU control (exit 0):

```sh
node packages/playtest/dist/runner/cli.js examples/engine-load-test/playtests/projection-conformance.playtest.json --url "http://127.0.0.1:5204/projection-conformance.html?mode=source" --server-command "pnpm --filter threenative-engine-load-test exec vite --host 127.0.0.1 --port 5204" --browser-recipe webgpu --headed --artifacts artifacts/prd-238-repair-playtest-webgpu-source-final
```

Both reports observed `sourceRaycastHit=true`, `projectedRaycastHit=true`,
`sourceRaycastDistance=7.5`, `projectedRaycastDistance=7.5`, `reconciled=true`, and state
`raycast-match-reconciled`; both screenshots were nonblank at ratio `1`, with zero console,
network, and runtime errors. The captured files are
`artifacts/prd-238-repair-playtest-webgpu-headed-final/after.png` and
`artifacts/prd-238-repair-playtest-webgpu-source-final/after.png`. A byte comparison found
`921,600` pixels, `0` differing pixels, and maximum channel delta `0`; the projected screenshot
was inspected and showed the cyan world geometry plus the conformance readout. Native execution is
**UNVERIFIED**: no native device or desktop lane was available in this repair round.

The final repair reran both browser commands after the render-marker, allocation-guard, and
compaction removals. Both exited 0 on NVIDIA/Turing and reported `renderSucceeded=true`, the two
raycast distances `7.5`, `reconciled=true`, state `raycast-match-reconciled`, nonblank ratio `1`,
and zero console, network, and runtime errors. The projected and source `after.png` captures were
byte-identical: SHA-256
`79a7ca015073d50096e10f0a385215fe627030beaf6e741a3bc5d1336e322a75`; `cmp` exited 0. Native
execution remains **UNVERIFIED**.

### 1.3.12 PRD-258 Phase 0 stopped at an unavailable real consumer (2026-08-30)

PRD-258 requires the existing five-soldier Bayview subject and forbids substituting a synthetic
rig. An isolated detached consumer at sandbox commit `e265288930c07c9762ff8002cdfd62984ea0a3d8`
was installed from local tarballs built from engine `68b32a65`. Its diagnostic source prepared five
same-camera arms (`control`, `hidden`, `frozen`, `flat`, `shadow-off`), reported actor/skeleton/
skinned-mesh counts, and added frame-section p50/p95 observations. The consumer typecheck and web
build both passed.

The runtime measurement did not begin. The committed `threenative.config.ts` requests
`raw-assets.manifest.json`, while the committed `public/` tree contains `assets.manifest.json` and no
file at the requested path. Vite therefore returned `<!doctype ...` for the JSON request. Browser
diagnostics observed HTTP 200, `Unexpected token '<'`, body state `LOADING 9 / 28`, zero canvases,
and `globalThis.__THREENATIVE_PLAYTEST_BRIDGE__ === undefined`. The playtest failed closed with
`TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING`; the prescribed doctor independently failed with
`TN_PLAYTEST_BRIDGE_MISSING`.

Package provisioning first exposed absent ignored tarballs and then stale cache filenames; exact
local builds fixed that setup, and the consumer install, typecheck and web build became green. Three
launch/verification rounds still stopped before measurement: the runner first rejected an invalid
`eq` assertion key, the corrected scenario failed capture provenance, and the prescribed doctor
confirmed the missing bridge. The doubtful assumption was that committed Bayview `e2652889` was a
self-contained current-engine consumer, so the run stopped rather than adding a fourth workaround.
No frame, render, animation, draw, material or shadow timing is claimed;
browser, desktop, Android and iOS are all **UNVERIFIED**. PRD-258 is blocked, not declined, and no
product API or package source was added. The isolated consumer remains at
`/home/joao/projects/threenative/sandbox-runs/prd258-fps-20260830` for a repaired rerun.

### 1.3.13 PRD-253 browser load-all is bound; native checkpoint is blocked (2026-08-30)

A detached Niagara Bistro consumer pinned `zeux/niagara_bistro` at `2bdb6a4` and loaded the
authored graph through ordinary Three.js. On headed 1280×720 WebGPU with a named NVIDIA/Turing
adapter, the green run measured 1,266,447,212 delivered bytes, 2,339,481,722 decoded resident CPU
bytes, 3,087,422,245 estimated GPU bytes, 4,371,768 visible triangles and 745 steady draws. Its
settled timestamps reported frame p50 14.0 ms, p95 34.4 ms and hitch max 822.2 ms. The existing
Abyss control on the same adapter passed at 183,855 triangles, 22 draws and render p95 2.7 ms.

The screenshot was inspected and the semantic channel was mutation-tested: forcing only
`visibleTriangles` to zero made `resource.state.visibleTriangles` fail while the direct renderer
series continued to observe 4,371,768 triangles. Kill A is therefore false; there is a real
residency/triangle/hitch problem.

Native desktop is **UNVERIFIED**. `pnpm native:build` produced a V8+Dawn host, but the consumer's
root-relative `/bistro/bistro.gltf` URL resolved against filesystem root and emitted
`TN_NATIVE_START_FAILED` before the playtest bridge. Three repair attempts stopped under the
repository rule. The required incumbent `scripts/asset-cost-census.ts` is also absent at the
baseline despite the PRD instructing Phase 0 to extend it. PRD-253 is blocked with no product code;
the full source pins, methods, caveats and unblock list are in
`docs/verification/prd-253-residency-census-2026-08-30.md`.

### 1.4 Secondary engine defects, after draw collapse

- **Native CSS-pixel parity:** native still exposes physical window dimensions with DPR 1
  (`runtime.cpp:2980`, `:2612`). Since PRD-228 the engine owns the cost portably —
  `renderer.resolutionScale` with an `"auto"` loop, reported in every frame-budget window — so a
  game no longer pays it by hand in generated source. The ratio itself is still a lie and the
  engine-level CSS-pixel contract is still open; it is PRD-228 Phase 1's remaining item.
- **High-refresh selection (closed):** the supported `display.maxFps` contract, Android frame-rate
  request and high-refresh mailbox policy are implemented. With Battery Saver off, the Pixel 8
  selects physical 120 Hz and Bayview sustains 63.45–72.52 fps. The evidence is in
  `docs/bugs/android-high-refresh-not-selected-2026-08-27.md`.

### 1.4.1 The allocation-free frame contract was never actually measured (2026-08-29)

`packages/core/__tests__/frame-budget-steady-alloc.spec.ts` asserted that 1.2M steady frames
produce zero GC events. **That assertion could not fail.** V8 delivers GC entries to a
`PerformanceObserver` through the event loop, never at the moment of collection, and the test ran a
fully synchronous window then called `observer.disconnect()` before yielding — so `events` was `[]`
whatever the frame did. Proven three ways, all on 2026-08-29:

| Probe | Result |
| --- | --- |
| Push 1.2M **escaping** closures through the tween's per-tick path | test stayed **green** |
| 3M escaping objects, observer read synchronously (`takeRecords()`) | 0 events, green |
| Same 3M objects, one `setTimeout(…, 0)` before reading | **42 events** |
| Original 1.2M-frame window with the yield restored | **22–130 events** — the frame is *not* allocation-free |

**One source found and fixed.** `FrameBudget.endFrame` built a fresh `IFramePhaseSample` every
frame and `FixedStepLoop.stepFrame` discarded it whenever `collectMetrics` was false — the shipping
default. The old docstring claimed V8 scalar-replaced it; it cannot, because the object escapes
across the method boundary and `endFrame` is far too large to inline. `endFrame(nowMs, wantSample)`
now skips building it, the loop passes `this.#collectMetrics`, and every window meter is pushed
either way. Observed red: revert the loop's second argument and the loop-level guard reports 240
built samples across 240 frames. Measured effect on the 1.2M-frame window: 80 → 63 GC events.

**The remainder is open and is not the tween's.** Per-process measurement (1.2M frames each,
`control` = arithmetic-only spin of the same length):

| Arm | GC events |
| --- | --- |
| control spin | 10 |
| stepFrame, no budget | 67 |
| stepFrame, budget, no tween | 123 |
| stepFrame, budget, curved tween | 114 |

**The instrument does not survive repair, so do not rebuild a bar on it.** Two windows in one
process report ~135 for whichever runs **first** and ~70 for whichever runs **second**, regardless
of which configuration each holds — the count reads warm-up order, not allocation. A bar tight
enough to catch a regression flakes on ordering; a bar loose enough to be stable asserts nothing.
The spec file now pins the per-frame properties deterministically instead (curve evaluated exactly
once per tick; no phase sample built when the loop discards it) and states this in full.

This invalidates the green in `prd-189-core-frame-allocations-2026-08-22.md` for any claim that
rested on GC-event counting. The claim that the fixed-step frame allocates nothing per frame is
**not established**, and finding the remaining ~57 events' worth is unowned.

### 1.4.2 Matched pixels: native vs Chrome — 2026-09-05 (blocked at preflight)

**Status: UNVERIFIED.** This is the first PRD-329 Phase 0 attempt. The Pixel 8 was reachable, but
the required device gate refused the run before either runtime launched: charging was `AC` instead
of discharging and thermal status was `LIGHT` instead of `NONE`. No frame timing, drawing-buffer
pair, SurfaceFlinger sample, slope, intercept or ownership verdict is recorded here. The older
2400×1080-native versus ~864×303-Chrome comparison remains withdrawn.

The pre-registered pair is one phone, one source commit, `renderer.resolutionScale` 1.0 and 0.55,
`renderer.antialias: true`, `display.maxFps: 120`, and the same UI renderer. The four required rows
are retained as empty observations so a later run cannot quietly turn a one-sided result into a
parity claim:

| Row | Scale | Antialias | Matched drawing buffer | Presented p50 / gpuMs | SurfaceFlinger | State |
|---|---:|:---:|---:|---:|---:|---|
| Chrome rung A | 1.0 | true | not captured | — | — | blocked before launch |
| Native rung A | 1.0 | true | not captured | — | — | blocked before launch |
| Chrome rung B | 0.55 | true | not captured | — | — | blocked before launch |
| Native rung B | 0.55 | true | not captured | — | — | blocked before launch |

The rule remains, quoted exactly: **native slope ≥ 1.3× Chrome's, or native intercept ≥ Chrome's + 3 ms at matched pixels, means a runtime-owned GPU term exists. Anything less closes the question as content-owned.** It was not evaluated because there are no two rungs. The deliberate reader-control swap and the deliberately mismatched DPR/physical pixel pair were not run for the same reason.

The exact preflight command and observed result were:

```sh
node --input-type=module -e 'import {assertDeviceReady} from "./packages/runtime-native/scripts/device-preflight.mjs"; try { await assertDeviceReady("192.168.1.192:5555",{minBatteryPercent:0,requireDischarging:true,maxThermalStatus:"NONE",allowOverride:false,requireRefreshHz:120},{}); console.log("ready"); } catch (error) { console.error(error.code ?? error); console.error(JSON.stringify(error.details ?? null)); process.exitCode=1; }'
```

```text
TN_DEVICE_PREFLIGHT_CONDITION_FAILED
{"serial":"192.168.1.192:5555","failures":[{"condition":"charging","threshold":"discharging","observed":"AC"},{"condition":"thermal","threshold":"<= NONE","observed":"LIGHT"}]}
```

The runtime-side contract work is separate from this blocked measurement. `TN_SURFACE_FORMAT` is
now emitted at startup, resize and republish configure paths and the desktop analyzer parses it;
removing it fails with `missing TN_SURFACE_FORMAT marker`. The diagnostic
`debug.threenative.linear_surface` / `THREENATIVE_LINEAR_SURFACE` switch remains default-off, and
`MYSTRAL_WEBGPU_BACKEND=auto` remains the Android product default. The declared Dawn negative
control was observed on 2026-09-05:

```text
node packages/runtime-native/scripts/download-deps.mjs --android --backend dawn
Platform: linux-x86_64
Error: TN_DAWN_ANDROID_ARCHIVE_MISSING: /home/joao/projects/threenative/threenative-engine/.worktrees/critical-prd329-20260905/packages/runtime-native/third_party/dawn-android/Dawn-d14ae3d97ad74100e9f382efef5e9c0872ddbeb2-android-arm64-v8a-Release.tar.gz; build Dawn d14ae3d97ad74100e9f382efef5e9c0872ddbeb2 for arm64-v8a and place the archive beside its extracted include/ and lib/ directories
```

The surface marker, sRGB bridge and Android backend contracts pass their focused tests, but the
desktop native binary and the phone pair were not built in this attempt. Therefore no suspect has
a measured `>=` or `< 2 ms` delta, and no product default changed.

### 1.4.3 A per-aircraft step was 18x its own cost, in the object shape rather than the math (2026-09-19)

Found by profiling the game, not by reading the engine. `midway-open-pacific`'s own fixed-step
budget (68 airborne, p95 ≤ 4 ms) failed at **4.293 ms**. A V8 CPU profile of that run put **34% of
all sampled CPU inside `flightForces`**, with line-level ticks concentrated on the return literal's
property stores — `{ ...coeff, airspeed, alpha, … }`. A spread cannot use the boilerplate V8 gives a
fixed literal; it goes through `CopyDataProperties`, property by property, twice per aircraft per
step. After that literal was written out field by field, the next profile's hottest single line in
the entire fixed step was `FlightModel.stepDeck`'s `{ ...this.environment, modifiers }`.

Engine harness, `scripts/check-flight-cost.ts` (32 aircraft, 600 timed ticks, three runs a side),
`--max-mean-ms 0.35` — now reachable by name as **`pnpm check:flight-cost`**, whose red control is
reintroducing the spread, which makes it exit 1:

| | mean step | p95 | exit | `finalStateSha256` |
| --- | --- | --- | --- | --- |
| as shipped | 0.805–0.824 ms | 1.95–2.15 ms | 1 | `bde0e51b5700123a…` |
| forces literal written out | 0.089–0.094 ms | 0.14–0.18 ms | 0 | `bde0e51b5700123a…` |
| + one step environment per model | 0.044–0.048 ms | 0.05–0.06 ms | 0 | `bde0e51b5700123a…` |

The identical `finalStateSha256` at every step is the point: the physics did not move, so only the
cost did. On the game's own gate the same two changes take the cap population from mean 2.154 ms /
p95 4.293 ms (FAIL) to mean 0.669–0.698 ms / p95 1.07–1.22 ms (PASS, three runs), and the marginal
cost at the top of the range from 30.9 to 8.7 µs per aircraft per step. Commits `b04b9d3a1`,
`302780021`. Three cheaper explanations were measured and rejected first: `Math.hypot` in the same
path is 1.09x here (not the 6.4x `ripple-field` saw), and an inlined coefficient writer with scratch
vectors is 1.07x.

**The remaining per-frame allocation is not in the loop.** §1.4.1 left "the remaining ~57 events'
worth" unowned. Driving `FixedStepLoop.stepFrame` with `collectMetrics: false`, a no-op update and
no-op render for 200,000 frames under `node --heap-prof --heap-prof-interval=2048` attributes about
**4 B/frame** of sampled allocation, and the engine-attributed sites are single samples
(`stepFrame` 11.1 KB, `FrameBudget.endFrame` 10.8 KB, `#recordFrameTiming` 7.4 KB) rather than
per-frame churn. The instrument is coarse at this scale, so read that as "no per-frame allocation
site found in the loop", not as a proof of zero. What is left to attribute is the budget's
per-*window* report path and the game's own step, and neither was chased here.

**The projected-size gate is not the frame's hidden cost.** In the same browser profile the largest
engine-owned self time was `RenderCameraCull`'s `#visit` (578 ms of a 20 s sample), and the gate does
walk the whole scene every frame while its two siblings (`updateClusteredMeshes`, `updateModelLods`)
iterate a tracked set. Measured in isolation instead — 19,446 objects with 4,276 renderables, the
game's own census, `RenderCameraCull.apply` at `minimumPixels: 2` — it costs **0.42 ms per frame
median**, of which the traverse itself is 0.27 ms. The profile figure was stall attribution: a
handful of samples carried the ~350 ms wall-frame stalls the same capture reports, which is the
reason a self-time leaderboard read from a GPU-bound profile is not CPU time. A live Chrome trace of
the same game (`threenative-playtest trace`, 20 s, 135,784 events) agrees with the bench rather than
with the profile: `#visit` is **2.3 % of sampled CPU**, behind three's own `_projectObject` (5.4 %)
and `updateMatrixWorld` (3.8 %), with the main thread 49 % idle. Replacing the walk
with a maintained registry would save at most 0.27 ms/frame and add an index to keep correct across
three scene seams, so it was not done.

### 1.4.4 `perf` printed a frame rate from a display it cannot vouch for (2026-09-19)

`threenative-playtest perf --executable` spawned the desktop host in whatever `DISPLAY` it inherited
and printed that run's `fps` column — including a private Xvfb, where the same package's `trace`
already refuses to print one, for a reason it measured: without vsync the present wait lands inside
the update phase, and the number is wrong rather than missing (13.3 fps there against 57.7 on the
real display, one build).

Measured on midway's desktop build under the capture-lock Xvfb, one binary, one command:

| window | fps | frame p50/p95 |
| --- | ---: | --- |
| 2 | 1123.60 | 0.0/0.0 |
| 3 | 20000.00 | 0.0/0.0 |

and `--min-fps 55` **passed, exit 0**. A bound satisfied by 20,000 fps is a green with nothing
behind it, which is the failure mode this package's own doctrine — "a check that cannot run must
fail, never skip" — exists to prevent.

`perf --executable` now decides its display the way every other lane does, and when the operator did
not ask for the host display it prints no frame rate, names the reason and both escapes, and refuses
a `--min-fps` bound with `TN_PERF_VIRTUAL_DISPLAY` (exit 1). `--allow-virtual-display` accepts the
run explicitly, the same flag `trace` takes. `--max-frame-p95` is untouched: the callback's own
duration was measured, the rate it was presented at was not. `--file` and `--logcat` sources carry
no display knowledge and keep their meaning, so the device lanes' `--logcat … --min-fps 60` flows and
the phase baselines quoted in `packages/runtime-native/AGENTS.md` are unaffected. Commit `5ea4b9c76`;
seven tests in `packages/playtest/__tests__/perf.spec.ts`; rule recorded in
`packages/playtest/AGENTS.md`.

### 1.4.5 One marker name, two payloads, and a reader that printed `NaN` (2026-09-19)

The native host emits `TN_FRAME_HITCH` once per 300-frame window
(`{window,maxMs,maxAtFrame,p99Ms,p50Ms,…}`, `runtime-native/include/mystral/cold_start.h`). Core's own
frame budget emits the **same marker** for a different event on every platform — one line the moment
a present gap exceeds `hitchMs` (`{gapMs,uptimeMs,wallClock}`, `packages/core/src/frame-budget.ts`).
`perf` parsed every line as a window.

Measured on midway's native launch log (`artifacts/playtest/01-native-playtests-launch.playtest.json/console.json`,
read with `perf --file`), which carried three gap lines of 2.1–3.0 s:

```text
hitch windows (post-launch, 3): worst NaN ms
  late sync compile: unreported — this host predates the pipelineCompile fields (TN_FRAME_HITCH without them)
```

A maximum it never received, an explanation false for those lines, and the three-second stall — the
thing worth knowing — discarded. The browser log from the same session lost `present gaps (1): worst
3683.200 ms at uptime 7301 ms`, which is the launch stall PRD-394 exists for.

Both series are read as what they measured now, and a line carrying neither shape throws
`TN_PERF_MARKER_MALFORMED` naming the missing field instead of rendering `NaN`. Commit `c798bd21f`;
four tests in `packages/playtest/__tests__/perf.spec.ts`; package suite 95 files / 1191 tests green.
The marker collision itself is left in place deliberately: the game `tools/capture-battle-profile.mjs`
and every recorded log read the gap payload under this name, so the reader discriminates rather than
the emitter being renamed.

The same command now joins the host's own stall report, `TN_SLOW_PHASE` (one line after any phase
over 250 ms, `atMs` stamped at the phase's end), so a gap says what it was. On that log:

```text
present gaps (3): worst 3000.140 ms at uptime 10178 ms
  gap 3000.140 ms at uptime 10178 ms: imageDecodeDrain 2965.129 ms, animationFrames 473.653 ms
  gap 2102.540 ms at uptime 13363 ms: animationFrames 2040.518 ms
  gap 2588.250 ms at uptime 18740 ms: animationFrames 2474.115 ms
```

A phase that merely contains another overlapping phase is not named — the host's `pollEvents` watcher
brackets a whole iteration, and attributing a stall to it would be the empty answer this join exists
to remove. Commit `bc4cf759d`; three tests use that log's own numbers and nesting.

### 1.4.6 The loop's cadence is not the display's (2026-09-19)

`TN_FRAME_BUDGET`'s `fps` is derived from the intervals the game's own frame loop reports. On the web
that is `requestAnimationFrame`, one per vblank, so it is the number a player would read. On native
the presentation cap lets the loop iterate many times per present — `paceToPresentationCap` paces the
*present*, deliberately not the loop, because "pacing an unpresented loop would add sleep to the
twelve seconds a player already waits" — so a window read `fps 2631.58` on a host that presented 133
frames in 1740. The reader first refused to print either number (`a85959e71`); the measurement now
exists.

The host exposes the counter it already keeps — `__tnPresentedCount`, beside `__tnPresentationCap` —
and core reads it once per frame, so a window carries `presents` and `presentedFps` beside the loop's
`fps`. Verified on a rebuilt host and a rebuilt desktop artifact, `perf --file <native launch log>`:

| window | fps (loop) | presents | presentedFps |
| --- | ---: | ---: | ---: |
| 1 (launch) | 51.28 | 115 | 13.42 |
| 2-5 (spinning) | 1449–25000 | 0 | absent |

The first cut of this got two things wrong, both caught by that log:

- **Zero is a reading, absent is no seam.** 300 loop frames at 20,000 fps is 20 ms, which can contain
  no present at all; the first cut reported those windows as absent, hiding four of five.
- **A window with no presents carries no rate.** `presentedFps` is absent rather than 0, the reader
  prints `0.00` and names those windows in words, and a `--min-fps` bound over windows that all lack
  a rate fails closed as `TN_PERF_BOUNDS_NOT_ASSESSABLE` rather than passing on a loop number.

Commit `8db1fd632`. The prerequisite recorded below while scoping this — a window must say which
cadence it counted — is what `presents`/`presentedFps` being present-or-absent implements: no reader
infers a basis from a log any more. Suites: core 126 files, playtest 95 files, 2649 tests green.

### 1.5 Untried, named

**Removed from this list 2026-08-28:** the panel-mode blind spot (now read and gateable by
`device-preflight.mjs`, `requireRefreshHz`); `renderer.resolutionScale` as a portable contract
(landed `696e86e3`), its `"auto"` loop and its per-window reporting (PRD-228, §1.3.5); and the
question of whether this scene is fill-bound at all, which §1.3.5 settled at 9.94 ms/Mpx.

Dawn on Android; any GPU-side timestamp timing (the drain is wall-clock algebra, not correlated
spans); matched native/Chrome logical-pixel capture after draw collapse; cross-engine QuickJS/JSC
lanes; a cheap-scene >100 presents/s ceiling arm; attribution and removal of the earlier 60 Hz
run's 13 steady-state tail spikes.

---

## 2. The ledger — do not rebuild any of this

### 2.1 The lever graveyard (measured flat or worse)

| # | Lever | Measured |
| --- | --- | --- |
| 1 | F12 batched pass op stream (−1,900 crossings/frame) | +5 % (18.61 → 19.60); per-crossing tax ~1 µs |
| 2 | F14 / PRD-224 per-class binding tables | 0.02–0.3 ms/frame; `createCommandEncoder` 30,746 → 928 ns, Chrome parity — a large per-call win is not a frame win |
| 3 | Lever A render-pass wrapper pooling | flat, removed (targeted 0.647 ms of a 22 ms frame) |
| 4 | Lever C projection/upload tuning | −0.31 ms, inside spread |
| 5 | F10 frame latency 3 (FIFO) and 1/3 (mailbox) | flat both modes |
| 6 | A1 Dawn ↔ wgpu-native backend swap (desktop) | flat (11.85 vs 11.51 ms render.p50) |
| 7 | A2 backend removed entirely (desktop) | backend presence = 1.95 ms of 11.21 (17 %) |
| 8 | 720×1600 under FIFO | flat 19.89 |
| 9 | GC / V8 heap tuning | GC is 0.2 % of wall clock; heap never configured, costs nothing steady |
| 10 | FIFO → mailbox at 1080p | flat 19.77 |
| 11 | Composited web UI off (`ui.renderer: "native"`) | flat 20.67 |
| 12 | PRD-227 P2 fixed-shape wrappers (+ borrowed values, specialized ids, bounded uploads) | **worse than baseline** (megamorphic shares 15.58/13.03/11.84 % vs 10.42 % baseline, gate 3 %) |
| 13 | Change 1 packed frame stream, alone | work −40 % (bridge 9.31 → 0.81 ms desktop), fps flat (20.39 → 20.02) |
| 14 | Swapchain `desiredMaximumFrameLatency` infrastructure | kept, never an fps lever |
| 15 | Optimising three.js renderer internals inside the host | refused on the ownership rule |
| 16 | Cutting Bayview draw counts in `packages/` | reverted; game code is experiment-only |
| 17 | PRD-307 set-once environment prefilter | **refuted for steady-state**: `dirty/1 − static` = **+1.61 ms**, while `static − none` = **−0.37 ms**, a lower-bound/noise observation; an independent positive resolution observation is required. Bayview has no per-frame dirty path |

Also closed by evidence: the node-system megamorphic IC population is a **load-time compile
burst**, not per-frame churn (0 `Node.build()` calls/frame steady state); the `clock_gettime`
hotspot was the profiling instrument (two `steady_clock::now()` per replayed op ≈ 0.7 ms);
`FrameBudget.endFrame` allocates nothing on the heap (V8 scalar replacement, spec-pinned); the
~20 fps figure is real (SurfaceFlinger agrees within 2 %; `dumpsys gfxinfo` is a 5× flattering
WRONG meter for this app — it reads the Skia view hierarchy, not the game's SurfaceView).

**The backend question is closed by two independent routes** (A1 swap, A2 removal): no further
work on backend choice, wgpu-native upstream, or command-recording cost is justified by this
evidence. The megamorphic-IC owner is **three.js's node-material graph** (IC-log: `Node.js` /
`NodeBuilder.js` sites dominate; no native wrapper site appears) — not the bridge.

### 2.2 Landed real wins (kept; none moved device fps alone)

- **Change 1 packed stream** (PRD-227 P1): desktop `bridgeNs` 9.31 → 0.81 ms; work 23.19 → 14.32 ms.
  On device the same work left the JS meter into `frameReplay` (~8 ms).
- **Upload staging** (PRD-222): desktop +12 % write-heavy rung; device pair +21 % (18.95 vs
  15.70 fps, matched-warm — development-grade; Tier-1 rerun on a cool phone still owed).
- **Physics collision events** from Rapier's own transitions: 107.7 → 6.4 µs step at 128 bodies
  (was O(n²) pair polling); conformance row `native-physics-collision-events`.
- **Bug-hunt fixes** (2026-08-27): picking exclusion parent-walk skip (raycast A/B 12–16 → 5–9 ms
  @1,000 meshes); two dead per-frame sweeps in the projection; scan-internal classification pinned
  to `exactLaneReason`; canvas 2D dirty-tracking (upload gated on `hasDirtyPixels()`); bridge
  micro-fixes `caa78a11` (desktop render.p50 12.35 → 10.83).
- `platform::presentUncapped()` (`b3dc53d2`) — the Android present-mode channel; made two
  refutations possible.

### 2.3 What has ever moved the device number

| Change | fps |
| --- | --- |
| Upload staging ON vs OFF (matched-warm pair) | 18.95 vs 15.70 |
| **Mailbox + 720p** | **34.39 vs ~20** — zero code change |

### 2.4 Non-findings proven (do not "fix" these)

`FrameBudget.endFrame` sample object (scalar-replaced); `input.tick`, `scheduler.tick`, state
store, `Registry.sweep`, `TracerPool3D.update`, `GPUParticles3D.process`, viewport/canvas-layer,
loop `stepFrame`, physics plugin bulk writes, idle pumps, staging uploads — all measured clean.
Physics hot-path allocations (PRD-170) landed as hygiene, below instrument noise; string
contact-pair keys stay (BigInt alternative allocates more — do not re-derive). Core ordinary-frame
allocation-free contract (PRD-189) and template allocation probe (PRD-193) are standing tests,
kept green; their records were evidence, not open work.

---

## 3. Method rules — paid for in wasted sessions, binding

1. **Every A/B a same-session pair.** Discard the first TWO whole runs of a session, not just
   window 1 (run 1 measured 26.05 vs 11.4–12.0 ms after, same binary).
2. **Desktop is never an fps verdict.** Xvfb/`:0` throttles presents (present reads ~33 ms there);
   judge desktop by `render.p50` / `work = threadCpu − present`. Warmed, within-arm spread is
   0.6 ms. The device owns fps.
3. **Cross-check every fps claim** against `dumpsys SurfaceFlinger --timestats`; never `gfxinfo`.
4. **Cold launches verified:** `am force-stop` → `pidof` empty → `am start -W`. An `am start`
   race once nearly measured a stale process.
5. **Verify the binary carries the change** (`strings` the packaged `.so` for your marker) before
   trusting a number. Never trust a binary you did not watch being linked; sha256 and revision-name
   every artifact.
6. **Pre-register any lever**: `predicted ms/frame = calls/frame × (our ns/call − Chrome ns/call)`
   from `TN_BRIDGE_BY_NAME` on the actual scene; refuse anything predicting < 2 ms. This rule
   retroactively refuses half the graveyard.
7. **An ablation arm removes a complete recording path or none of it** — half-ablations return
   plausible wrong numbers instead of crashing.
8. **A GC-observer window that never yields measures nothing.** V8 queues GC entries to the event
   loop; a synchronous window that disconnects before yielding always reads `[]`, and the green is
   vacuous. Yield once (`await setTimeout(…, 0)`) before reading, and prove the observer is live in
   the same file. Even repaired, the count is dominated by warm-up order — first window ~135, second
   ~70, same configurations — so it cannot carry a pass/fail bar. See §1.4.1.
9. **No cross-session absolutes.** The 22.2 ms desktop baseline does not reproduce (machine state
   ~2.3×, bundle drift). Device pixel counts vs desktop differ 2.8×; never state a desktop
   millisecond as a device one. Profiled builds inflate absolutes — use ratios.
10. **Live windows only** on device, or an end-screen idle reads as a 174 fps "win". Classify
    windows before comparing. **The old test — `update.mean ≥ 3 ms` — is dead:** PRD-227 cut the
    update phase to 0.46 ms in steady state, so it now rejects every live window (§1.3.5). Use: not
    one of the two windows after launch, `substeps.mean ≥ 1`, `update.mean > 0.05`, and record the
    `update.mean` series so the classification can be checked rather than taken on trust.
11. Red-green with named mutations; never claim a gate you did not run; paste output. Device
    preflight (thermal/battery) per `packages/runtime-native/AGENTS.md`. Commit path-limited as
    you go — another lane may hold this tree.

---

## 4. Instruments

| Meter | Where | What it gives |
| --- | --- | --- |
| `TN_FRAME_BUDGET:{json}` | JS-side (web + native), 300-frame windows | fps, presented/frame/substeps p50–p99, phases `hostGap/update/render/overlay/residual`, hitches. Emitted `packages/core/src/frame-budget.ts`; on by default (`frameBudget: false` silences the marker, not the measurement). |
| `TN_HOST_GAP:{json}` | native host loop only (`packages/runtime-native/src/runtime.cpp`) | Between-callback truth: period p50 + segments `events, io, audio, timers, microtasks, preFrame, frameDrain, frameReplay, present, gpuDrain, devicePoll, endFrameOther, handles, screenshot` (each p50/mean). `gpuDrain` is diagnostic-build-only. Σ segments ≈ hostGap must hold (±0.6 ms). |
| `TN_ANDROID_JS_NATIVE` | profiled host (`-DTN_ANDROID_JS_PROFILE=ON`) | `bridgeNs`, `bridgeOverheadNs`, `bindingNs`, `commandNs`, `bridgeCalls`, `bridgeArgs`, `threadCpuNs` per frame. |
| `TN_FRAME_HITCH` / `TN_COLD_START` / `stall_budget.h` | host | hitches; launch-phase attribution (PRD-218). |
| `gpubench.js` probe | desktop + Chrome | per-call ns: `writeBuffer` ~1.1–1.2 µs native vs 431 ns Chrome; `buffer.size` 5 ns (faster than Chrome's 21 — proves the cost is call-path-only). Versioned: `docs/verification/artifacts/prd-224-gpubench-2026-08-28.js`. |
| simpleperf + `TN_ANDROID_JS_PROFILE` | device | CPU attribution; symbolize against unstripped `libv8android.so` (embedded builtins = the unsymbolized 1.6 MB; JIT code = the `unknown` DSO). |
| SurfaceFlinger `--timestats` / `--latency` | device | independent fps + present-interval histogram on the game's `(BLAST)` layer. |
| `device-preflight.mjs` / `doctor --device` | device | thermal/battery gate (shared battery floor 50 %, hot-start 40 °C). |

### 2026-08-30 — stale host-gap lane adjudication

`codex/hostgap-instrumentation` is not a missing feature. Its seven commits predate and are
superseded by the broader host meter on `main` (`73e0baec`, extended by `6502502c`). The stale
lane's `TN_HOST_GAP_V2` owns nine coarse phases through TypeScript lifecycle hooks. The shipping
`TN_HOST_GAP` meter owns fourteen host-side phases, including the frame drain/replay, present,
device-poll and diagnostic GPU-drain boundaries, while current `FrameBudget` also reports surface
state and GPU milliseconds. Replaying the stale branch would replace newer evidence and regress
that reporting, so no stale code or old verification record was landed.

The current code was rebuilt and executed from the isolated
`feature-mining-prd254-hostgap-audit-20260830` worktree. Focused tests passed **33/33** (15 frame
budget, 2 GPU-drain wiring, 16 playtest perf parser). The Linux V8+Dawn host then rendered 300
frames at 1280×720 with a visibly nonblank screenshot and emitted adjacent real-runtime markers:
`presented.p50` 28.27 ms, `render.p50` 0.86 ms, `hostGap.p50` 25.19 ms, and host period p50
28.265 ms. `threenative-playtest perf --file ... --require-windows 1 --text` passed and attributed
the host-gap p50 chiefly to `present` (24.901 ms), with `frameReplay` 0.085 ms. The named negative
control changed the shipping `gpuDrain` phase label to `gpuDrainRemoved`: the focused test turned
red at `/kGpuDrain[\\s\\S]*"gpuDrain"/`, then returned **2/2 green** after restoration.

`SDL_AUDIODRIVER=dummy pnpm native:verify:desktop` passed audio, stability, the 300-frame core
gate, physics, and every later native contract except the pre-existing
`threenative-bindings-creation-test` (`proof: creation-refusal`); that unrelated failure also
appeared in the preceding PRD-254 V8 control run. The detached tarball sandbox protocol does not
apply: this is internal instrumentation with no public capability or game-authored behavior to
install. The real native host plus the playtest perf consumer are the observable proof boundary.

### 2026-08-30 — stale frame-budget lane adjudication

`worktree-agent-a15fb02a370974a26` is not missing work. Its four-commit tree and main's squash
`31cba321` differ only in a later two-line correction to `native-runtime-census-2026-08-16.md`;
the frame budget, public capability, generated instructions, scenario, and fail-closed playtest
performance gate are identical. Replaying the stale history would add no behavior. PRD-214 stays
PARTIAL because its optimization phases 1–2 remain open, not because this Phase 0 instrument is
absent.

The isolated repo audit passed **81/81** focused assertions: 72 core frame-budget/game/playtest
tests and 9 playtest performance-gate tests. The template suite passed 29 unrelated contracts, then
its minimal-scaffold typecheck passed after the fresh worktree's physics package was built; no
product assertion failed. Three attempts to run the in-repo scenario through a managed package
script stopped before assertions because Vite did not receive the runner's host/port flags. That
path was stopped after the third setup failure rather than treated as evidence.

The detached packed-tarball sandbox at
`/home/joao/projects/threenative/sandbox-runs/prd254-frame-budget-20260830/prd254-frame-budget`
contained zero readable framework-source lines. Its typecheck passed, then a real NVIDIA Turing
WebGPU run observed 180 frames, clean diagnostics, a nonblank 1280×720 capture, and populated
`hostGap/update/render/overlay/residual` phase samples; the latest budget windows reported
`render.p95` 2.8 and 6.6 ms. The game-owned scenario required `render` p95 ≤33 ms, frame p95
≤66 ms, and fps ≥15 and passed. Its named mutation changed only the `render` ceiling to 0 ms;
the same run failed `TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED` with observed 3.7 ms, then returned
green after restoration. The generated `pnpm test` then passed all four sandbox scenarios together.
The sandbox README maps the feature to PRD-214 and this proof. Mobile was not re-executed in this
audit; PRD-214 retains its original physical-Pixel evidence and its open optimization phases.

### 2026-08-30 — stale GPU-memory guidance lane adjudication

`worktree-agent-a868a44e113b83123` is not missing work. Its PRD-213 Pixel 8 attribution, generated
memory recipe, template pointer and instruction-budget allowance are already on main at
`b378e67f`. Every lane path is byte-identical at that commit except
`instruction-budgets-2026-08-23.md`, where main also preserves the concurrently integrated PRD-209
and PRD-214 measurements. Replaying the stale commit would erase those measurements and add no
product behavior. PRD-213 remains PARTIAL for its queued Phase 2 physical-device before/after, not
for this already-shipped Phase 1/3 guidance.

The isolated contract baseline passed the bounded-reference scaffold assertion and generated
instruction audit. A named mutation changed `agent-docs/mobile-memory-budget.md` to the nonexistent
`agent-docs/mobile-memory-budget-removed.md` in the performance fragment; the instruction contract
turned red with `MIRROR_DRIFT`, then returned green after exact restoration. The fresh-worktree
minimal-scaffold typecheck was stopped after three dependency-build attempts still failed; the
doubtful assumption was that only missing workspace build outputs caused that unrelated fixture
failure.

The detached packed-tarball sandbox at
`/home/joao/projects/threenative/sandbox-runs/prd254-gpu-memory-20260830/prd254-gpu-memory`
contained zero readable framework-source lines. Its generated `AGENTS.md` names the measured
`~500MiB` Pixel 8 driver floor and `48MiB` dual-use equirect cost, resolves the shipped
`agent-docs/mobile-memory-budget.md` recipe, and mirrors the pointer in `CLAUDE.md`. The project
typechecked, then all three generated headed WebGPU scenarios passed on a named NVIDIA Turing
adapter with clean diagnostics. The inspected 1280x720 atmosphere capture visibly contained the
HUD, player, platform and lighting. This audit made no new Android measurement or physical-device
claim; it accepts the recorded Pixel 8 evidence already on main.

**Desktop reading recipe** (render.p50, never fps):

```sh
cd <bayview>/.threenative/build
SDL_VIDEODRIVER=x11 sh <engine>/scripts/xvfb.sh \
  <engine>/packages/runtime-native/build/tn-linux/mystral run game.js --frames 900
# parse TN_FRAME_BUDGET + TN_HOST_GAP lines; window 1 discarded
```

**Device reading recipe** (fps with cross-check):

```sh
adb shell am force-stop com.threenative.bayview && adb logcat -c
adb shell am start -W -n com.threenative.bayview/com.threenative.runtime.MystralActivity
adb logcat -d | grep -o 'TN_FRAME_BUDGET.*' | tail -1
adb logcat -d | grep -o 'TN_HOST_GAP.*'  | tail -1
adb shell dumpsys SurfaceFlinger --timestats -dump   # cross-check
```

Building a device APK: `THREENATIVE_RUNTIME_SOURCE=<engine>/packages/runtime-native` +
`THREENATIVE_GRADLE_ARGS` (engine `package-android.mjs`) — see
`packages/runtime-native/AGENTS.md`. Controls: `debug.threenative.present_uncapped=1` (mailbox),
`-PthreenativeFrameLatency`, `-PthreenativeGpuDrainProfile=true` (diagnostic drain).

---

## 5. Closed questions, one line each

| Question | Verdict |
| --- | --- |
| Is the meter lying? | No — SurfaceFlinger agrees within 2 %; audited 2026-08-27. (`gfxinfo` is the wrong meter.) |
| Backend (wgpu-native vs Dawn)? | Closed — flat swap on desktop; removal = 17 % of frame. A1 on **device** is untried but parked. |
| Binding-table install tax? | Real per call, fixed for two classes, ≈0.3 ms of a frame. Phase 3 bounded before writing. |
| Wrapper shapes / megamorphic ICs? | Falsified as our defect — owner is three.js node-material graph; P2 made it worse. |
| Crossing count? | ~1 µs/crossing; F12's −1,900 bought +5 %. Per-value cost is the real seam term. |
| GC / V8 heap? | 0.2 % of wall clock steady. Not a lever. |
| Fill rate / resolution? | Material at 1080p: GPU-frame-time ≈63 ms and native draws 9.9× Chrome's landscape pixels. Not sufficient: Chrome is still ~30 fps at 864×303. |
| Present mode / swapchain depth? | Not the limiter (mailbox arm flat at 1080p; latency flat everywhere). |
| Composited web UI overlay? | Measured free twice. Not the owner. |
| Host-loop segments (events/audio/timers/microtasks/handles/screenshot)? | All < 1 ms on device steady state. Dead. |
| Is native slower than Chrome because of Android? | No matched parity claim remains. Chrome is ~30 fps at 864×303; native is ~20 fps at 2400×1080. The shared draw workload is primary and native's physical-pixel viewport compounds it. |
| Is native fast enough in principle? | Yes — fox platformer, 2026-08-11: ~106 fps median uncapped vs Godot 53.7–59.5 (unfair comparison, different games — see §6). |

---

## 5a. The async pipeline entry, per backend — PRD-327 Phase 0, 2026-09-03

The mechanism question PRD-327 refused to assume: does `wgpuDeviceCreateRenderPipelineAsync`
actually leave the calling thread? Measured by `tests/async_pipeline_thread_test.cpp`
(`threenative-async-pipeline-thread-test`), which times a synchronous compile of a deliberately
heavy shader against the async entry's own call, on a differently-salted shader so the second arm
cannot be timing a cache hit, and destroys the descriptor the instant the call returns.

| backend | `syncMs` | async entry usable | main thread inside the call | callback at | verdict |
| --- | ---: | --- | ---: | ---: | --- |
| Dawn (desktop) | 73.4 ms | **yes** | **0.33 ms** (0.45 %) | 244 ms | leaves the thread; snapshots the descriptor |
| wgpu-native (Android, iOS) | 4.2 ms | **no** | — | — | **`unimplemented!()`; aborts the process** |

An earlier Dawn run on a colder shader cache read `syncMs 363.79`, `callMs 0.115` — 0.03 %. Both
runs clear the pre-registered `Tcall < 0.25 × Tsync` bar by more than two orders of magnitude.

**wgpu-native v25.0.2.2 does not implement it at all.** It does not return an error; it panics
non-unwinding and takes the process with it:

```
thread '<unnamed>' panicked at src/unimplemented.rs:81:5:
not implemented
  19: wgpuDeviceCreateRenderPipelineAsync
thread caused non-unwinding panic. aborting.
```

which is why the probe runs in a forked child — otherwise the contract test cannot report the very
thing it exists to find out, and "this backend cannot" would be a fact hardcoded from the day
someone first tried it rather than a measurement taken on every run.

### The mechanism decision

**Branch (b) — a host compile thread pool calling the synchronous entry — for both backends.**

Branch (a) is available on Dawn and measured excellent there, and it is still the wrong choice:
the platform with the defect is Android, whose backend has no async entry to call, so the pool has
to exist regardless. Shipping (a) on desktop as well would mean two mechanisms, two completion
paths and two sets of lifetime rules for one feature, on the platform whose launch is already
524 ms. Dawn's async entry is recorded here as measured-and-available so a later change has the
number without re-running the probe.

`syncMs` differs 17× between the backends on the same shader because Tint and naga are different
compilers and wgpu-native defers more work to first use. That makes the ratio the comparable
quantity, never the absolute — do not quote 4.2 ms as "wgpu compiles faster".

### Phase 1: the binding, measured through the path a game takes

`threenative-async-pipeline-thread-test` also drives `device.createRenderPipelineAsync` itself —
the entry `renderer.compileAsync()` reaches — and asserts the same pre-registered bar on it. The
async arm runs before the synchronous one so it cannot be timing a warmed driver.

| arm | main thread in the call | synchronous compile of the same shader | ratio |
| --- | ---: | ---: | ---: |
| **before** (the sync wrap restored) | 96.55 ms | 84.55 ms | **1.14** |
| after, run 1 | 0.299 ms | 69.05 ms | 0.0043 |
| after, run 2 | 0.278 ms | 118.06 ms | 0.0024 |
| after, run 3 | 0.292 ms | 68.07 ms | 0.0043 |

The red is the previous implementation, restored deliberately: the old
`install-async-pipelines.js` wrap plus the native handlers not installed. It fails with the bound
named —

```
TN_ASYNC_PIPELINE_BINDINGS:{"callMs":96.546875,"syncMs":84.546142578125,"ratio":1.1419}
Error: createRenderPipelineAsync blocked the main loop: 96.5 ms of a 84.5 ms compile
```

— which is the whole finding in one line: the asynchronous entry cost *more* main-thread time than
the synchronous one, because it was the synchronous one with a promise around it.

**230–400× less main-thread time per pipeline compile**, against a bar of 4×. On the desktop
launch this is not yet visible in the total, because `native-smoke` compiles three pipelines and
its launch is 524 ms; it is the Bayview-class launch, with 105 compiles and 8,038 ms of them, that
this exists for — and that number is not claimed here, because the phone lane did not run.

The wait in that test was a fixed 600-frame pump first, and it passed only once a debug `fprintf`
slowed it down: 600 `pollEvents()` calls take about 60 ms and the compile takes 120–360 ms. It is
wall-clock bounded now. Recorded because a green that depends on machine speed is the failure this
repository's method rules exist to prevent, and it very nearly shipped.

### Phase 2: not adopted, and the reason is the result

Phase 2 prescribed flipping `warmUp` on by default for native. **It was not adopted**, because
executing it showed the framework already warms up by default in a better place: `startupCompile`
calls the same `warmUpScene` from inside the loading layer's bounded readiness gate — opaque layer
on screen, loop turning — whenever `warmUp` is unset and the layer is opaque. The `warmUp` option
only moves that work earlier, to before `start()` releases the loop and while nothing presents.

What was broken was the mechanism, and Phase 1 fixed it: the default path compiled nothing only
because `compileAsync` could not resolve. It started working without its default moving.

Flipping it anyway cost two regressions, both caught by CI and neither by a local run — recorded
because they are the evidence the prescription was wrong:

1. the loading screen stopped covering startup, on macOS and Windows —
   `verify-desktop-loading.mjs`, `loadingVisible: false, startupReady: true` at every startup
   sample. A launch that shows the player nothing where a loading screen belongs is the opposite of
   what this PRD is for;
2. and after the first repair, the scene compiled twice — once before the loop, once inside the
   gate — which pushed `verify-desktop-physics.mjs` past its 180-frame budget on macOS:
   `desktop physics proof missed the completed parity marker`.

Green with the default back where it was: `913920 startup loading pixels, 0 settled`; physics
14 assertions; `packages/core` 977 tests.

**PRD-218's criteria 1 and 2 are NOT ticked.** They are device criteria — three cold launches on
the physical Pixel 8, tap-to-playable ≤ 8 s median, first-present `pipelineCompile ≤ 500 ms` — and
the phone did not run: it is attached over Wi-Fi ADB (`192.168.1.192:5555`) and thermally clean
(status 0 NONE, 28 °C) but sat at 36–38 % battery, under the 50 %-and-discharging bar
`device-preflight.mjs` enforces. The mechanism is proven on desktop and the default is flipped;
the launch claim is unmade until that lane runs.

### A side effect worth keeping

No contract test could be linked in a wgpu build directory at all before this: wgpu-native and SWC
are both Rust staticlibs and each carries its own `rust_eh_personality`, so every target linking
`mystral-runtime` there died at

```
libswc.a(std-...rcgu.o): in function `rust_eh_personality':
multiple definition of `rust_eh_personality'; libwgpu_native.a(std-...rcgu.o): first defined here
```

The `mystral` executable had already named that exact pairing and opted out of the error; the
runtime had not, and gated its own opt-out on V8, which a wgpu preset does not use. The gate now
names the pairing instead of the engine, and `threenative-timestamp-query-test` links there too.
This is what made wgpu-native — the backend Android ships — the one backend no contract test could
be run against.

### Phase 3, desktop Dawn arm — second cold launch, 2026-09-03

Three sequential fresh-process launches of `native-smoke` on `build/tn-linux/mystral` (Dawn,
`xvfb.sh`, `--frames 300` each), same machine, same bundle, same session:

| launch | gapMs | `pipelineCompile` | calls |
| ---: | ---: | ---: | ---: |
| 1 | 140.3 | 14.349 | 3 |
| 2 | 117.7 | 11.059 | 3 |
| 3 | 123.5 | 11.339 | 3 |

Second ÷ first = **77 %** — above the pre-registered 25 % bar, but this arm decides nothing: three
tiny pipelines (14 ms of compile) sit at the noise floor, and the machine's driver shader cache
was already warm from earlier sessions, so launch 1 here is not a true first-ever compile. The
pre-registered rule is written for the phone, where 105 pipelines and 8,038 ms make the ratio
meaningful. **The cache decision waits for the phone arm**; the desktop record is supporting
evidence only, and no pipeline-cache work is filed off this table.

### Phase 2's device acceptance ran and failed — the warm-up does not survive the Android path, 2026-09-03

The phone lane ran six instrumented launches (battery 62 % → 37 %, discharging, thermal status 3,
battery 31.8–42.6 °C across the session, APK `b8a5c698…` then rebuilds, `com.threenative.bayview`
verified by `aapt` and by `strings` the packaged `.so` for `pipelineCompileMs`). Three facts, each
pinned by a named instrument:

**1. The pre-PRD stall reproduces unchanged without warm-up.** New runtime (Phase 1+4), game
config untouched, cold launch: `TN_STALL_SEGMENTS gapMs 12412, pipelineCompile 8300 ms / 103 sync
calls, attributedShare 0.724`, first frame `TN_COLD_START first_frame atMs 14776`. The Phase 1
mechanism changes nothing for a game that never calls `compileAsync` — expected, but now measured.

**2. `warmUp: true` regresses the launch to ~35 s.** With the opt-in, the whole-scene
`compileAsync` walks 835 renderables **synchronously on the main thread for ~33 s** (a
three-side debug probe: `walk-begin` at 16:13:40.305, first per-item log at 16:14:13 — no pump,
no timer, no pipeline enqueue in between; a 2 s `setInterval` probe delivered nothing until
29,994 ms). The per-item `await yieldToMain()` then fell back to `requestAnimationFrame`, **not**
the installed `scheduler.yield` — a host-side yield counter read 1 against 892 items — and rAF
cannot resolve while the launch loop is held. `TN_WARMUP` reported `{"compiled":0,"abandoned":1,
"timedOut":true}` on every arm (15.3 s and 30 s budgets), the first frame still paid the 8.2 s
sync compile, and the game's launch went 14.4 s → ~35 s. The opt-in was reverted in the game
(sandbox commit) and the engine instrumentation removed.

**3. The async bindings themselves work — after the loop releases.** The instrumented pool logged
`enqueued → pool job finished → draining` for every completion, all post-release. The native half
of Phase 1 is sound; what fails is the path a game takes to reach it: three's `compileAsync` is
asynchronous in name on this backend — its prologue walk does the node and pipeline work
synchronously, and its yield falls back to a frame that does not exist pre-start.

**Phase 3's pre-registered 25 % rule — executed, cache rejected.** Every launch's
`pipelineCompile` sat at 8.2–8.3 s across the session: launches 2..6 never dropped below 25 % of
the first. The driver cache is doing nothing for these pipelines, so per the rule filed in the
PRD, the persisted-cache work is filed — but the cache is now the *smaller* problem: the
synchronous walk must leave the main thread first, or a cache would only speed up a stall that
still runs on the main loop. Both belong to the follow-up PRD.

**PRD-327's criterion 3 is not met** (14.4 s against ≤ 8 s median) **and the PRD does not close.**
What the device session bought: the launch defect is no longer "warm-up compiles nothing" — it is
"three's whole-scene compile walk is synchronous on the main thread and its yield path is
frame-coupled", which no amount of warm-up default flips can hide.

### Phase 4 — a late synchronous compile is a named hitch, 2026-09-03

`TN_FRAME_HITCH` now carries `pipelineCompileMs` / `pipelineCompileCalls` per 300-frame window.
The launch budget keeps a per-frame `pipelineCompile` accumulator after the first present
(`stall_budget.h`), the hitch reporter drains it on every present (`bindings_presentation.cpp`),
and `threenative-playtest perf` parses `TN_FRAME_HITCH` — which no code read before this, only
hands — and names the late compile when one happened. A missing field and a measured zero print
differently ("unreported — this host predates the fields" vs "none — every window reported
pipelineCompileCalls 0").

Red-green (`threenative-stall-budget-hitch-test`, new): against the unmodified headers the test
does not compile — `PostPresentCompile` does not name a type, `record()` takes no payload. Against
the mutation "post-present routing disabled" (the pre-PRD behaviour), the payload reads
`pipelineCompileMs:0.000` despite forced compiles, 4 assertions red; restored, green. Live
end-to-end, desktop Dawn, one 360-frame launch (`--frames 300` closes only 299 samples — the
first record primes the clock, so the window needs 301 presents; recorded because it silently
produced no line the first time):

```
TN_FRAME_HITCH:{"window":300,"maxMs":43.310,"maxAtFrame":232,"p99Ms":40.284,"p50Ms":30.787,"pipelineCompileMs":0.000,"pipelineCompileCalls":0}
hitch windows (post-launch, 1): worst 43.310 ms
  late sync compile: none — every window reported pipelineCompileCalls 0
```

`maxMs 43.3` is Xvfb present throttling (method rule 2), not a verdict. The nonzero path is
proven by the shape test; no in-repo fixture produces a late material swap, so a device arm with
one is still owed to this PRD's negative control as written.

---

## 5b. Launch under V8 — PRD-328, 2026-09-03

Until this date the launch instrument could not run on the engine that ships. The compile and
execute markers existed only in `quickjs_engine.cpp`, which has not been the shipped engine on any
platform since 2026-08-16, and the desktop CLI emitted no launch markers at all. Every quotable
JavaScript parse-and-compile number was therefore the QuickJS one from 2026-08-11 (230 ms, 8.0 %).

**Phase 0 red, desktop**, `build/tn-linux/mystral` at `6cbb2c7d`, native-smoke, 300 frames — the
entire launch, one line:

```
TN_COLD_START:{"segment":"first_frame","atMs":86.243}
```

and the new marker contract run against that same pre-change binary:

```
desktop core gate failed:
TN_COLD_START_MARKER_MISSING:process
TN_COLD_START_MARKER_MISSING:runtime_created
TN_COLD_START_MARKER_MISSING:game_eval_begin
TN_COLD_START_MARKER_MISSING:compile_begin
TN_COLD_START_MARKER_MISSING:compile_complete
TN_COLD_START_MARKER_MISSING:execute_begin
TN_COLD_START_MARKER_MISSING:execute_complete
```

**Phase 2 green, desktop.** V8 13.1, Dawn, `CMAKE_BUILD_TYPE=Release` (-O2) read from the binary's
own CMake cache, five launches, `examples/native-smoke`:

```
node packages/runtime-native/scripts/measure-cold-start.mjs --desktop --launches 5
```

| segment | median | share |
| --- | ---: | ---: |
| host bring-up (`process` → `runtime_created`) | 328 ms | 62.5 % |
| pre-eval setup | 0 ms | 0.0 % |
| eval entry (read + transpile) | 12 ms | 2.4 % |
| **JavaScript parse and compile** | **51 ms** | **9.7 %** |
| post-compile setup | 0 ms | 0.0 % |
| bundle top-level execution | 45 ms | 8.6 % |
| first rendered frame | 88 ms | 16.8 % |
| **total** | **524 ms** (p95 600, range 503–600) | |

`residualMs` in `TN_STALL_SEGMENTS` fell from 65.5 ms to 64.7 ms on the same scene because the JS
span now sits *before* the stall budget's window rather than inside its unattributed remainder;
the 96 ms of compile-plus-execute that used to be invisible is now named.

**Phase 0 red, phone — taken.** A cold launch of the installed `com.threenative.bayview` (the
pre-change V8 APK) on the physical Pixel 8 emits six markers and none of the four the reader needs:

```
process, asset_begin, asset_complete, runtime_created, game_eval_begin, ui_overlay_attached
```

Fed to the real reader's own `parseMarkers` + `breakdown`, that is:

```
TN_COLD_START_MARKER_MISSING:compile_begin
```

which is the failure the PRD predicted, on hardware. This red needs no thermal or battery
condition — a marker is either emitted or it is not — so it stands despite the device being on
charge, and it closes the phone half of Phase 0.

### The phone, measured — 2026-09-03

An APK built from this branch (`com.threenative.game`, `examples/native-smoke`, V8, wgpu-native),
installed on the physical Pixel 8 (`shiba`, `192.168.1.192:5555`). The instrument now runs there:
all ten markers present, the four eval segments among them.

First launch, genuinely cold (page cache cold), total **2,365.5 ms**:

| segment | ms | share |
| --- | ---: | ---: |
| host bring-up | 2.8 | 0.1 % |
| bundle read from APK | 47.6 | 2.0 % |
| runtime creation | 1,635.4 | **69.1 %** |
| eval entry | 9.8 | 0.4 % |
| JavaScript parse and compile | 108.7 | 4.6 % |
| bundle top-level execution | 208.7 | 8.8 % |
| first rendered frame | 352.0 | 14.9 % |

Five further process-cold launches (page cache warm), which is what a relaunch costs:

| launch | total | compile | execute | first frame |
| --- | ---: | ---: | ---: | ---: |
| 1 | 519 | 52.0 | 180.2 | 206 |
| 2 | 508 | 57.8 | 192.6 | 190 |
| 3 | 520 | 61.4 | 182.9 | 202 |
| 4 | 493 | 51.3 | 159.3 | 217 |
| 5 | 529 | 54.1 | 200.4 | 190 |
| **median** | **519** | **54.1** | **182.9** | **202** |

**Runtime creation is the launch**, not JavaScript: 1,635 ms of a 2,365 ms cold launch, against
109 ms of compile. That is the largest single term anyone has attributed on this device, and it is
new information — it was inside the unlabelled span before this PRD.

**Conditions, stated rather than implied:** the device was on AC (`status: 2`) at 81 % with the
screen held awake, so this is a launch-time measurement taken outside the discharging preflight
`device-preflight.mjs` enforces for frame-rate work. Launch time is far less charger-sensitive than
sustained fps, but the run is labelled `provisional` for that reason and no fps claim is made from
it. Thermal was clean throughout (status 0, ~31 °C).

**Two traps this lane hit, both worth keeping.** The first launch attempt failed with

```
ERROR_SURFACE_LOST_KHR → No surface formats available → Failed to create Mystral runtime!
```

because the phone was *dozing*: `adb shell am start` on a sleeping Pixel gets a SurfaceView that is
immediately lost, and the failure names the surface rather than the screen. `adb shell input
keyevent KEYCODE_WAKEUP` then `svc power stayon true` is the fix. Second, the previously installed
`com.threenative.bayview` never reaches a first frame at all and holds on its loading screen with
the GPU rail at 1.00 mW — consistent with PRD-310's note that its engine symlinks broke on
2026-08-31, and the reason the acceptance game for PRD-327's launch criterion could not be used.

**Bayview's launch: still UNVERIFIED.** The *green* half needs an APK built from this branch, and
the launch it would be measured against needs a discharging phone at ≥ 50 % battery. Neither was
available: the phone sat at 36–40 % for most of the session, and the installed Bayview build never
reaches a first frame at all — it holds on the loading screen with the GPU rail at 1.00 mW, which
is consistent with PRD-310's 2026-08-31 note that Bayview's engine symlinks were broken. No phone
launch number is claimed here. The desktop half is what this section reports.

**Engine versions** are pinned by `packages/runtime-native/tests/js-engine-version-skew.test.mjs`;
the desktop archive is V8 13.1 and the Android prebuilt is V8 11.0, so the two are not the same
compiler and the desktop share above may not be read as the phone's.

### The code-cache decision — PRD-328 Phase 3

The pre-registered rule, quoted verbatim from the PRD before any number existed:

> If `compile + execute` on the phone is **≥ 300 ms median** or **≥ 10 % of launch**, file
> `PRD-33X — the bundle is not parsed as source twice` […] Otherwise write the graveyard row.

The rule names the phone, and **the phone lane ran**. Applying it to the medians above, unchanged:

| limb of the rule | measured | trips? |
| --- | --- | --- |
| `compile + execute` ≥ **300 ms** median | 54.1 + 182.9 = **237.0 ms** | no |
| `compile + execute` ≥ **10 %** of launch | 237.0 / 519 = **45.7 %** | **yes** |

and on the genuinely cold first launch, 108.7 + 208.7 = **317.4 ms**, which trips the first limb
too. Either reading gives the same answer.

**Verdict: FILE the code cache.** The rule is an OR and one limb trips on every launch measured, so
`PRD-335 — the bundle is not parsed as source twice` is filed with the mechanism the rule
pre-registered: `ScriptCompiler::CreateCodeCache` after the first compile, written to the app's
storage root; `kConsumeCodeCache` on later launches; the cache rejected on a V8 version, flags-hash
or bundle-hash mismatch; failing closed to source.

**And the honest caveat, which the rule does not capture.** A code cache saves *parse and compile*,
which is 54 ms of a 519 ms launch — 10.4 %. It does not save top-level execution, which is 183 ms
and the larger half of the term the rule adds together. The far bigger number is **runtime
creation at 1,635 ms, 69.1 % of a cold launch**, which no code cache touches. PRD-335 is filed
because a pre-registered rule may not be moved after the numbers arrive; it is filed *ranked below*
the runtime-creation question, and it says so.

Two things still bound how far these numbers carry:

1. **The bundle is not Bayview.** `native-smoke` is a smoke scene; Bayview's bundle is roughly 4 MB
   and parse time scales with bytes. Its launch is the 14 s one, and it could not be measured here.
2. **The engines differ.** Desktop is V8 13.1, Android is V8 11.0.

---

## 6. Older results still worth quoting

- **Engine load test (PRD-117, 2026-08-15), scorer-equivalence-gated:** ThreeNative wins
  instanced rendering on web/desktop/mobile, 3.2–3.9× vs Godot 4.7.1 at scale (web 16,384 cubes:
  4.60 vs 17.95 ms p50), 4× on the knee. Loses unbatched per-object on web — that path is plain
  three.js, and a standalone plain-three page shows three's WebGPU backend already beating its own
  WebGL backend there: the cost is JS issuing thousands of draws, not a renderer defect.
- **ThreeNative vs plain three.js (SceneCollapse):** 11.6× on the 2026-08-15 workload — by
  removing draws, not by drawing faster. `defineGame` constructs collapse unconditionally.
- **Fox platformer on Pixel 8 (2026-08-11):** 60 fps sustained while played (253 windows, zero
  below 60; median 106 uncapped) after folding camera-parented HUD draws. Beats Chrome and Godot
  on *its* scene; must not be quoted as an engine comparison.
- **Launch stall (PRD-218, 2026-08-24):** the 12–14 s post-asset-load stall is first-frame
  pipeline compilation, now self-reporting via `stall_budget.h`; heat session attributed to
  sustained render + compile, with two runs thermal-confound-flagged.
- **Mobile perf probe (2026-08-24):** loading screen 15–20 s to playable on device, dominated by
  that one stall; wrong-package control incident is why every arm now verifies package id.

<a id="prd-117-browser-comparison-2026-08-14"></a>
### PRD-117 browser comparison — 2026-08-14

Product-to-product: each arm is what its engine actually ships to a browser surface. The arms use
different rendering backends by construction — ThreeNative WebGPU and Godot 4.7.1 WebGL2 — so no
line below is a graphics-API claim.

The knee is the largest object count at or below 20 ms p95. The run used 1280×720, 60 Hz, vsync
off, three repeats per rung, and 480 samples per repeat after 120 discarded warm-up frames.

| mode | knee — ThreeNative | knee — Godot 4.7.1 |
|---|---:|---:|
| L1 | 1,024 | 4,096 |
| L2 | 16,384 | 4,096 |

| mode | N | ThreeNative p95 ms | Godot p95 ms | ratio |
|---|---:|---:|---:|---:|
| L1 | 256 | 2.60 | 1.84 | 1.41× |
| L1 | 1,024 | 9.30 | 5.94 | 1.57× |
| L1 | 4,096 | 34.10 | 19.29 | 1.77× |
| L1 | 16,384 | 116.40 | 63.69 | 1.83× |
| L2 | 256 | 2.30 | 1.03 | 2.22× |
| L2 | 1,024 | 2.70 | 2.72 | 0.99× |
| L2 | 4,096 | 2.00 | 7.14 | 0.28× |
| L2 | 16,384 | 8.10 | 27.36 | 0.30× |

#### Arm `tn-web`

- engine: ThreeNative workspace
- build: release Vite dev build, `three/webgpu` render path; the `defineGame` loop was not measured
- driver: `three/webgpu` `WebGPURenderer`
- adapter: `nvidia / turing`
- device: desktop Chromium on Linux, 1280×720 @ 60 Hz, vsync off

| mode | N | p50 ms | p95 ms | draws | triangles | visible | repeats × samples |
|---|---:|---:|---:|---:|---:|---:|---:|
| L1 | 256 | 1.50 | 2.60 | 164 | 1,947 | 163 | 3 × 480 |
| L1 | 1,024 | 5.20 | 9.30 | 629 | 7,527 | 628 | 3 × 480 |
| L1 | 4,096 | 21.90 | 34.10 | 2,469 | 29,607 | 2,468 | 3 × 480 |
| L1 | 16,384 | 96.40 | 116.40 | 9,809 | 117,687 | 9,808 | 3 × 480 |
| L2 | 256 | 1.20 | 2.30 | 3 | 3,075 | 256 | 3 × 480 |
| L2 | 1,024 | 1.30 | 2.70 | 3 | 12,291 | 1,024 | 3 × 480 |
| L2 | 4,096 | 1.20 | 2.00 | 3 | 49,155 | 4,096 | 3 × 480 |
| L2 | 16,384 | 5.20 | 8.10 | 3 | 196,611 | 16,384 | 3 × 480 |

Knees at ≤20 ms p95: L1 1,024 and L2 16,384.

#### Arm `godot-web`

- engine: Godot 4.7.1-stable (official)
- build: release Godot export; rendering method read from the engine at runtime
- driver: `gl_compatibility / opengl3`
- adapter: WebKit WebGL / OpenGL ES 3.0 (WebGL 2.0, OpenGL ES 3.0 Chromium)
- device: Web GenericDevice, 1280×720 @ 60 Hz, vsync off

| mode | N | p50 ms | p95 ms | draws | triangles | visible | repeats × samples |
|---|---:|---:|---:|---:|---:|---:|---:|
| L1 | 256 | 1.29 | 1.84 | 171 | 2,042 | 171 | 3 × 480 |
| L1 | 1,024 | 3.66 | 5.94 | 658 | 7,886 | 658 | 3 × 480 |
| L1 | 4,096 | 13.37 | 19.29 | 2,582 | 30,974 | 2,582 | 3 × 480 |
| L1 | 16,384 | 54.20 | 63.69 | 10,246 | 122,942 | 10,246 | 3 × 480 |
| L2 | 256 | 0.70 | 1.03 | 2 | 3,074 | 2 | 3 × 480 |
| L2 | 1,024 | 1.70 | 2.72 | 2 | 12,290 | 2 | 3 × 480 |
| L2 | 4,096 | 5.08 | 7.14 | 2 | 49,154 | 2 | 3 × 480 |
| L2 | 16,384 | 19.49 | 27.36 | 2 | 196,610 | 2 | 3 × 480 |

Knees at ≤20 ms p95: L1 4,096 and L2 4,096.

<a id="prd-117-browser-detail-2026-08-14"></a>
### PRD-117 browser detail — 2026-08-14

This is the detailed execution record for the browser half of PRD-117. Two of four arms ran on one
machine on this date; both Android arms did not. Raw run reports were under the engine-load-test
artifact directory. The product-to-product comparison above is intentionally not a graphics-API
comparison: ThreeNative uses WebGPU and Godot's 4.7.1 web export uses WebGL2.

#### Result and scope

The knee definition and experimental controls are the ones recorded above: largest object count at
or below 20 ms p95, 1280×720, three repeats, 480 samples per repeat, 120 warm-up frames. The L1/L2
p50/p95 table, arm metadata, counts, and ratios are consolidated in the browser-comparison record.
L3 is the L1 source file unchanged with `SceneCollapse` enabled, not a third authoring mode; Godot
has no equivalent and its same-source answer is L1. L3 holds 16,384 where Godot L1 holds 4,096.

An extended L2-only ladder found the ThreeNative knee beyond the original ladder:

| N | ThreeNative L2 p95 | Godot L2 p95 | ratio |
|---:|---:|---:|---:|
| 16,384 | 7.00 ms | 22.12 ms | 0.32× |
| 65,536 | 25.50 ms | 73.86 ms | 0.35× |
| 262,144 | 129.30 ms | 332.48 ms | 0.39× |

The publishable browser statement is: on this desktop browser, a per-cube node sustains about 1,000
cubes on ThreeNative and 4,000 on Godot at 50 fps; batching sustains about 16,000 on ThreeNative
and 4,000 on Godot. The ratio remains stable across the 16× ladder in both modes.

#### Findings and controls

- At 16,384, ThreeNative issued fewer draws than Godot (9,809 vs 10,246) but cost 1.8× the frame
  time, about 11.9 µs vs 6.2 µs per visible draw. This is vanilla `three/webgpu` bookkeeping and
  V8, not a `packages/` defect; the per-draw attribution is an inference, not a profile. L2 shows
  the GPU and batched path are healthy, while `SceneCollapse` is an unmeasured opportunity.
- The measured arm drives `three/webgpu` directly and excludes `defineGame`, the framework loop,
  scene system, and plugins. Every ThreeNative number is therefore a floor for a game.
- `WEBGPU_BROWSER_ARGS` begins with `--ozone-platform=x11`; with that flag the adapter is
  `google / swiftshader` (software) in bundled and system Chromium, while without it the adapter is
  `nvidia / turing`. Earlier evidence made under those flags may describe SwiftShader, not the GPU;
  whether screenshot gates using those flags are affected was left unanswered.
- Three.js resets `renderer.info` on its own rAF. The first benchmark read zero draws and zero
  triangles, which would have disabled the draw-call half of the equivalence gate while reporting
  pass. Setting `info.autoReset = false` and reading before yielding fixed it.
- The first equivalence gate kept only the last repeat, hiding a divergent `positionHash`. Grouping
  all repeats and requiring one hash within and across arms fixed the hole; the hand-edited refusal
  proof and regression test remain part of the record.
- Repeating the tn-web ladder about 15 minutes later produced the same knees but this variance:

  | rung | run 1 p95 | run 2 p95 | drift |
  |---|---:|---:|---:|
  | L1 @ 1,024 | 6.40 ms | 9.30 ms | +45% |
  | L1 @ 4,096 | 26.20 ms | 34.10 ms | +30% |
  | L1 @ 16,384 | 107.20 ms | 116.40 ms | +9% |
  | L2 @ 16,384 | 5.80 ms | 8.10 ms | +40% |

  The knee is stable (L1 1,024, L2 16,384), individual values should be treated as ±30%. Neither
  run was otherwise idle; the second run is the published artifact.
- The original PRD contradicted its 60 Hz/vsync requirement and its instruction to disable vsync.
  Both arms therefore used `--disable-gpu-vsync --disable-frame-rate-limit` for Chromium and
  `VSYNC_DISABLED` for Godot; `display.vsync` was added and the gate rejects disagreement.
- Godot's desktop Forward+ Vulkan arm on an RTX 2080 auto-batches an L1 rung (2 draws for 2,340
  visible at 4,096), while its web arm reports 2,582 draws for 2,582 visible. The fair comparison
  is Godot L1 against ThreeNative L3, not ThreeNative L1.
- L3 and L2 had identical draw and triangle counts at every rung:

  | N | L1 p95 | L3 p95 | L2 p95 | L3 draws | L3 triangles |
  |---:|---:|---:|---:|---:|---:|
  | 256 | 2.20 ms | 2.00 ms | 2.20 ms | 3 | 3,075 |
  | 1,024 | 6.70 ms | 2.20 ms | 1.80 ms | 3 | 12,291 |
  | 4,096 | 24.40 ms | 2.00 ms | 1.70 ms | 3 | 49,155 |
  | 16,384 | 95.90 ms | 8.50 ms | 5.60 ms | 3 | 196,611 |

  L3 was 12× faster than L1 at 4,096 and 11× at 16,384, crossed 20 ms at 65,536 (29.5 ms), and
  held 10.0 ms at 16,384 on the extended run. It cost 8.5 ms versus L2's 5.6 ms because of
  per-frame transform refresh. The pass is a capability, not a default: the load test constructs
  it, while a `defineGame` game does not yet receive it.
- `visibleObjects` is engine-specific; the gate compares draws and triangles instead.

#### Why the comparison is fair

The same integer LCG is written in `examples/engine-load-test/src/workload.ts` and
`benchmark/godot-load-test/load_test.gd`; each arm hashes the first eight positions after
millimetre quantisation:

| rung | ThreeNative | Godot |
|---|---|---|
| N = 256 | `94e73aef` | `94e73aef` |
| N = 1,024 | `78812d31` | `78812d31` |
| N = 4,096 | `e9a32f01` | `e9a32f01` |
| N = 16,384 | `3acfd9c3` | `3acfd9c3` |

The camera is a pure function of frame index, so frame 317 frames the same cubes on the slow and
fast arm. Runtime backend/build reporting was:

| arm | driver | adapter | build |
|---|---|---|---|
| `tn-web` | `three/webgpu WebGPURenderer` | `nvidia / turing` | release |
| `godot-web` | `gl_compatibility / opengl3` | WebKit WebGL / OpenGL ES 3.0 (WebGL 2.0, OpenGL ES 3.0 Chromium) | release |

Both exports ran release; PRD-066 measured the release-export trap as 5.5× on the same phone and
source. Chromium masks the Godot WebGL renderer string, so its software status is evidence rather
than proof.

The N=0 floor was 1.50/2.50 ms for tn-web L1/L2 and 0.91/0.71 ms for Godot L1/L2. Every 4× ladder
step raised p95 in both modes and arms, showing the ladder reached the renderer rather than only
measuring the driver loop. Four intentionally edited reports refused with exit 1:

```text
TN_BENCH_NOT_EQUIVALENT: L2@256 positionHash (repeats disagree within an arm): tn-web=94e73aef,deadbeef godot-web=94e73aef
TN_BENCH_NOT_EQUIVALENT: - display.refreshHz: tn-web=120 godot-web=60
TN_BENCH_NOT_EQUIVALENT: - build.type: tn-web=debug godot-web=release
TN_BENCH_NOT_EQUIVALENT: L1@4096 drawCalls (left arm auto-batched L1): tn-web=1 godot-web=2582
```

The unedited pair exited 0 and published; fourteen scorer tests cover empty series, missing driver,
and repeat-divergence cases.

#### Unmeasured and reproduction status

Android was unmeasured: the ThreeNative arm needed the Android runtime built and the Godot arm
needed a release APK export plus on-device transport. The attached Pixel 8 and installed NDK did
not change that. iOS was not attempted because there was no Apple hardware. Desktop native was
conditional and not run. The `defineGame` loop and `SceneCollapse` default were excluded from the
browser claim. The historical gate record marked typecheck, lint, and budgets green for its then
benchmark setup; this statement is retained as historical evidence, not a current gate result.

```sh
pnpm bench:engines --arm tn-web        # writes artifacts/engine-load-test/tn-web.json
pnpm bench:engines --arm godot-web     # exports release, serves cross-origin-isolated, drives
pnpm bench:engines:report              # equivalence gate, then the knee table
```

This is an opt-in benchmark path; nothing in the default repo gate runs Godot. Both arms need a
display, system Chromium with hardware WebGPU, and `BENCH_BROWSER_BIN` may select the binary.
`--out <name>` prevents diagnostic runs from overwriting the published ladder; a floor-control run
silently clobbered the first tn-web ladder before that flag existed. Godot needs `godot` on `PATH`
with 4.7.1 export templates. Artifacts are `tn-web-ladder.json`, `godot-web-ladder.json`,
`*-floor.json`, `*-l2ext.json`, and full stdout logs in `artifacts/*.log`.

<a id="prd-117-android-quickjs-era-record-2026-08-14"></a>
### PRD-117 Android / QuickJS-era record — 2026-08-14

This historical Android record covers a Pixel 8 (`37251FDJH0037Z`, shiba), Android 17, Mali-G715.
ThreeNative used its C++ runtime with QuickJS; Godot 4.7.1 used an Android export on OpenGL ES 3.2.
Both signed APKs were release builds installed from this repository. Battery was 21–22% on USB
power, below the PRD's ≥50% requirement, so every figure is provisional; same-session comparison
is meaningful but absolute device evidence is not publishable, and the Android criterion remains
unsatisfied.

#### Superseded V8 result and desktop rerun

The QuickJS result was superseded on 2026-08-15 by V8:

| Pixel 8, 16,384 cubes | frame p50 | measured JS/frame |
|---|---:|---:|
| ThreeNative QuickJS | 119.19 ms | 115.64 ms |
| **ThreeNative V8** | **8.20 ms** | **5.25 ms** |
| Godot 4.7.1 | 39.27 ms | — |

That is a 22× reduction in script time. The V8 rung series was 8.34 / 8.35 / 8.37 / 8.20 ms across
the 4× load range. At 120 Hz, 8.33 ms is the frame interval, so the honest result is ≤8.33 ms
work inside one 120 Hz frame, not a free-running measurement. The arms used different refresh rates;
the scorer would reject that pairing, but at a 60 Hz counterfactual ThreeNative would be 16.67 ms
against Godot's 39.27 ms.

The same-display desktop rerun corrected an invalid earlier comparison (Godot had used the real
display while ThreeNative used xvfb):

| N / mode | ThreeNative | Godot | ratio |
|---|---:|---:|---:|
| 4,096 batched | 23.79 ms | 32.24 ms | 0.74× |
| 4,096 naive+collapse vs naive | 31.23 ms | 29.72 ms | 1.05× |
| 16,384 naive+collapse vs naive | 35.86 ms | 49.03 ms | 0.73× |
| 16,384 batched | 31.98 ms | 39.60 ms | 0.81× |

Both were dominated by a ~25 ms virtual-display floor, which understates engine differences; the
ThreeNative JS time at 16,384 was 6.30 ms.

#### QuickJS result, defects, and measured optimisations

At 16,384, Godot was 39.27 ms and ThreeNative was 119.19 ms; ThreeNative was 3× slower. At 4,096
the gap was ~1.35× (22.49 ms versus a Godot frame pinned at a ≤16.67 ms vsync floor). The ThreeNative
frame split was 57.99 ms framework collapse refresh, 57.65 ms benchmark animation, and ~3.5 ms
renderer/GPU; Godot's equivalent was roughly 2.4 µs per object versus ~7 µs in QuickJS. The direct
attribution measurements were 101.62 ms `step` of a 106.32 ms frame, ~0.3 µs per instance on web,
~6 µs on the phone, and ~2.4 µs for Godot. The idle 16,384-cube scene rendered in 8.25 ms at three
draws, proving the GPU was idle. Android selected QuickJS in `CMakeLists.txt`; desktop selected V8
and iOS JSC. Micro-optimisation could not close the language gap.

The two defects both produced a frozen scene at full speed. Sampling `object.matrix` before render
left 4,095 of 4,096 moving cubes baked static; flat siblings also shared one parent owner. The
default `minMeshes: 200` meant examples never exercised the pass. The diagnostic evidence was
`report.movingParts = 1` for 4,096 animated cubes and a misleading 0.08 ms `collapse.frame()`;
assert moving parts, not only refresh time. The fixes sample authored transforms and choose the
nearest actually moving owner. The two regression tests are intentionally red when either defect
fix is removed, and all 22 existing collapse tests passed before and after the fixes.

Two measured optimisations were retained and remain on by default in this historical record. For
uniform scales the shader's normal transform is the transform upper 3×3, so aliasing the normal
buffer saved 28% (72.19 → 52.29 ms). Together the two real optimisations removed 22% of the
framework's share and moved the 4,096 gap from 1.7× to 1.35×. After baking,
detached leaves already held their world matrix, so reading that local matrix reduced refresh
15.38 → 9.79 ms and frame 28.68 → 23.07 ms; the post-bake flag was required. Loop partitioning
added 9.79 → 9.42 ms, 3.8%, at the edge of noise.

The proposed gap-closing approaches remain historical:

| approach | expected | cost |
|---|---|---|
| V8 or JSC on Android | ~20× loop gap; the fix | large |
| bulk transform ABI | removes the framework's ~50% share, not the game's | medium |
| further JavaScript micro-optimisation | tens of percent at best; nearly exhausted | small |

Android packaging downloaded a prebuilt runtime, so an engine swap required NDK cross-compilation.
A prebuilt Android arm64 V8 was v11.1000.4 while the desktop backend used V8 13.1; Android JSC
would require porting the iOS-only Objective-C++ implementation to the JSC C API, not flipping a
flag. These version and API constraints made the swap a large change. `packages/runtime-native/AGENTS.md`
records the architecture decision “Android QuickJS+wgpu-native”; reopening it is a charter-level
decision, not a tweak.

#### Instrument fixes and standing

- Android logcat truncated lines at ~1 KB; `TNJSON` chunks are rejoined.
- Godot ignored `VSYNC_DISABLED`, producing a flat ~19 ms result over a 16× ladder; the scorer
  refuses that display-pinned shape and the arm reports `TIME_PROCESS`.
- Desktop and Android bundles are per-target; an `--out` name protects published ladders after a
  diagnostic floor run overwrote the published ladder.
- A 16,384-mesh desktop run timed out when the settle loop rendered the un-collapsed scene every
  frame. It now stops drawing while baking but still yields; removing the yield caused a synchronous
  spin. The native FIFO/vsync desktop path remains runnable but needs an unthrottled present mode
  before its numbers are comparable.

| platform | ThreeNative | Godot | verdict |
|---|---|---|---|
| Web | knee 16,384 (L2/L3) | knee 4,096 | ThreeNative 4× |
| Desktop native | display-pinned, not comparable — 35.35 ms @4,096 vs 38.81 ms @16,384, only +10% for 4× objects | 5.67 ms @4,096 | unmeasurable as run |
| Mobile @4,096 | 22.49 ms | ≤16.67 ms, vsync-floored | Godot ~1.35× |
| Mobile @16,384 | 119.19 ms | 39.27 ms | Godot 3× |
| iOS | no Apple hardware | — | out of reach |

Earlier figures comparing a frozen scene were withdrawn, including the “31× faster on mobile” claim;
correcting the defects made ThreeNative's numbers worse. The repaired web ladder used a moving-parts
guard and passed at every rung. On the same mode, count, three draws, and 196,611 triangles:

| arm | frame p95 | JS engine |
|---|---:|---|
| Web (Chromium) | 11.45 ms | V8 |
| Android (own runtime) | 119.19 ms | QuickJS |

The final result is 10.4× on identical source.

---

## PRD-358 cross-platform performance regression CI — repair round 1 (2026-09-05)

Policy revision `prd-358-v1` is implemented and committed in the lane branch. No performance
baseline was promoted: the manifest remains `calibrationStatus: unverified`, every physical lane
is unprovisioned, and the hosted browser lane has no accepted baseline. The comparison exit
contract is PASS=0, regression FAIL=1, and invalid or missing required evidence BLOCKED=2. Raw
artifacts are configured for 14 days on success and 30 days on failure.

### Executed evidence

The following commands were run in this worktree:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm native:build` | PASS; pinned Linux CMake 4.4.3/Ninja 1.13.2 build completed 403/403 and produced `mystral` and `mystral-tools` |
| `cmake --build packages/runtime-native/build/tn-linux --target threenative-crash-handler-policy-test threenative-timestamp-query-test threenative-rg11b10-renderable-test --parallel` | PASS; the three on-demand V8 contract targets built |
| `cmake --preset tn-linux -B build/tn-linux-quickjs -DCMAKE_MAKE_PROGRAM=/home/joao/projects/threenative/threenative-engine/.worktrees/prd-358-cross-platform-performance-regression-ci/packages/runtime-native/.runtime/tools-venv/bin/ninja -DMYSTRAL_USE_QUICKJS=ON -DMYSTRAL_USE_V8=OFF` | PASS; documented QuickJS matrix directory configured |
| `cmake --build build/tn-linux-quickjs --target threenative-timestamp-query-test threenative-rg11b10-renderable-test --parallel` | PASS; the two QuickJS contract targets built 403/403 |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 390 files passed, 2 skipped; 4,290 tests passed, 7 skipped |
| `pnpm test:playtest` | PASS; framework movement/camera, Abyss axis/zoom, navigation, and streaming scenarios passed with the WebGPU recipe |
| `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/performance-regression.spec.ts scripts/__tests__/temp-dir-guard.spec.ts` | PASS; 4 files, 109 tests |
| `pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs` | PASS; 1 file, 23 tests |
| `pnpm lint` | PASS; the repository-wide run reports 609 warnings and no errors, including complexity warnings in existing examples and the new helpers |
| `pnpm budgets` | BLOCKED by the pre-existing stale retention index: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; no benchmark evidence changed in this lane, so the record was not edited |
| `git diff --check` | PASS |

The required-baseline negative control also ran:

```text
pnpm --silent bench:engines --check-report /tmp/tn-required-report.json --required-baseline
TN_BENCH_BASELINE_MISSING: tn-web has no accepted baseline for requested lane browser-webgpu
CLI_EXIT=2
```

The reviewer controls were red before their guards were restored (5 failed, 49 passed): missing
or stale baseline provenance, distinct native binary identities, seven attempts, repeated initial
order, and omitted manifest metrics. The restored run passed all five controls (54/54). The
additional per-launch regression-window and maximum-invalid-pair controls were also run red then
green; the final focused run above is 109/109.

### Platform evidence disposition

These rows are deliberately explicit. A local Linux build and emulator/simulator contract check
are not a physical-device pair and do not substitute for one. No row below claims a timed
cross-platform comparison ran.

| Row | Provisioning | Status | Evidence disposition |
|---|---|---|---|
| `browser-webgpu` | hosted software | UNVERIFIED | No accepted calibrated baseline; the required-baseline control correctly returned BLOCKED/exit 2. |
| `native-linux` | unprovisioned physical GPU | UNVERIFIED | The Linux native binary built locally, but no dedicated leased GPU pair was provisioned. If promoted to required, missing hardware evidence is BLOCKED/exit 2. |
| `native-windows` | unprovisioned physical GPU | UNVERIFIED | No Windows runner or accepted independent baseline was available in this Linux worktree. |
| `native-macos` | unprovisioned physical GPU | UNVERIFIED | No macOS runner or accepted independent baseline was available in this Linux worktree. |
| `native-android` | unprovisioned physical device | UNVERIFIED | No physical Android device pair was run; emulator evidence cannot satisfy this row. |
| `native-ios` | unprovisioned physical device | UNVERIFIED | No Apple hardware or `xcrun` environment was available; no simulator was counted as physical iOS. |
| `android-emulator` | simulator/emulator | UNVERIFIED | Advisory collector hook only; no physical-device claim. |
| `ios-simulator` | simulator | UNVERIFIED | Advisory collector hook only; no physical-device claim. |

Calibration and cost promotion remain separate from baseline regeneration: the manifest records
10 calibration pairs across at least 3 sessions, 20 accuracy runs, and 20 CI-cost runs as required
evidence, with `maintainer-review` for required-check promotion and
`separate-reviewed-change` for baseline regeneration. Those samples were not claimed as
executed by this Linux lane.

### PRD-358 integration ledger evidence

The planned call sites are now live non-test callers:

| Ledger row | Actual caller |
|---|---|
| Required baseline validation | [`scripts/engine-load-test/cli.ts:192`](../../scripts/engine-load-test/cli.ts#L192) calls `requiredBaseline`; [`scripts/engine-load-test/report.ts:1016`](../../scripts/engine-load-test/report.ts#L1016) compares source and artifact identity. |
| Lane policy and paired comparison | [`scripts/engine-load-test/cli.ts:235`](../../scripts/engine-load-test/cli.ts#L235) invokes the comparison CLI; [`scripts/performance-regression/run.ts:612`](../../scripts/performance-regression/run.ts#L612) evaluates paired evidence. |
| Reusable workload collection | [`scripts/engine-load-test/cli.ts:280`](../../scripts/engine-load-test/cli.ts#L280) invokes [`packages/runtime-native/scripts/profile-production.mjs:174`](../../packages/runtime-native/scripts/profile-production.mjs#L174). |
| Hosted probes and hardware workflow | [`.github/workflows/ci.yml:808`](../../.github/workflows/ci.yml#L808) runs the bounded contract; [`.github/workflows/native-platforms.yml:298`](../../.github/workflows/native-platforms.yml#L298) and [`:483`](../../.github/workflows/native-platforms.yml#L483) invoke native collectors. |
| Evidence summary and baseline approval | [`.github/workflows/ci.yml:1034`](../../.github/workflows/ci.yml#L1034) and [`.github/workflows/performance-regression.yml:165`](../../.github/workflows/performance-regression.yml#L165) invoke the summary; [`.github/workflows/performance-regression.yml:184`](../../.github/workflows/performance-regression.yml#L184) keeps promotion policy separate. |

## PRD-358 cross-platform performance regression CI — repair round 2 (2026-09-05)

Repair round 2 is committed after the five blocking defects were reproduced and repaired. Required
baseline validation now requires candidate provenance without requiring it to equal the accepted
baseline; native paired arms retain independent binary hashes; comparison accepts exactly three
alternating valid pairs and at most one invalid replacement; selected-lane manifest metrics cannot
be omitted; and physical collector inputs are propagated or fail closed. No baseline was promoted.

### Repair-round evidence

The focused red run was captured before the repair guards were restored:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/ci-structure.spec.ts
Test Files 2 failed (2)
Tests 5 failed, 91 passed (96)
```

Those failures covered fresh candidate provenance, platform workflow mapping, physical collector
arguments and missing-input handling, and startup evidence conversion. The final focused run is:

```text
pnpm exec vitest run scripts/__tests__/performance-regression.spec.ts scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/ci-structure.spec.ts
Test Files 3 passed (3)
Tests 115 passed (115)
EXIT_CODE=0
```

The relevant runtime-native production-profile tests are also green:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs
Test Files 1 passed (1)
Tests 23 passed (23)
EXIT_CODE=0
```

The required repository gates were run after the repair:

| Command | Exact result |
|---|---|
| `pnpm typecheck` | PASS; workspace root and all 28 participating packages completed; exit 0 |
| `pnpm lint` | PASS; `Checked 1962 files`; `Found 609 warnings`; no errors; exit 0 |
| `pnpm test` | PASS; 391 files passed, 1 skipped; 4,300 tests passed, 4 skipped; exit 0 |
| `pnpm budgets` | BLOCKED; `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; exit 1. This is the unchanged repository blocker and was not edited. |
| `pnpm test:playtest` | PASS; framework movement/camera, axis/zoom, navigation, and streaming scenarios passed with the WebGPU recipe; exit 0 |
| `git diff --check` | PASS; exit 0 |
| `yq eval '.' .github/workflows/performance-regression.yml >/dev/null` | PASS; YAML parsed |
| `yq eval '.' .github/workflows/native-platforms.yml >/dev/null` | PASS; YAML parsed |

The physical Android and iOS rows were not executed from this Linux checkout. The workflow keeps
their configured self-hosted labels visible, but the manifest remains `provisioning:
unprovisioned`, with no selected device or physical-evidence file. The runner returns explicit
`UNVERIFIED` for advisory rows or `BLOCKED`/exit 2 when required; it never invokes a physical
collector without both inputs. The existing iOS simulator row is explicitly simulator
`UNVERIFIED`, not physical iOS. Windows/macOS hosted collector steps are configured against their
job-built binaries but were not executed locally and remain unverified evidence.

| Row | Local/declared state | Result claimed by this record |
|---|---|---|
| `browser-webgpu` | Hosted software hook; no accepted calibrated baseline | UNVERIFIED |
| `native-linux` | Linux binary build exists; no dedicated leased GPU pair | UNVERIFIED |
| `native-windows` / `native-macos` | Separate pinned runner rows; no local runner execution | UNVERIFIED |
| `native-android` | Self-hosted physical label declared; device/evidence unavailable | UNVERIFIED; required mode is BLOCKED/2 |
| `native-ios` | Self-hosted physical label declared; signed phone/evidence unavailable | UNVERIFIED; required mode is BLOCKED/2 |
| `android-emulator` | Advisory emulator collector only | UNVERIFIED |
| `ios-simulator` | Real simulator `.app` collector hook with simulator provenance | UNVERIFIED |

### Repair-round integration ledger updates

These are live non-test callers in the repaired tree:

| Ledger row | Actual caller and contract |
|---|---|
| Required baseline validation | [`scripts/engine-load-test/cli.ts:192`](../../scripts/engine-load-test/cli.ts#L192) calls required validation; [`scripts/engine-load-test/report.ts:1018`](../../scripts/engine-load-test/report.ts#L1018) requires candidate provenance and `:1029` compares stable execution identity. |
| Lane policy and paired comparison | [`scripts/engine-load-test/cli.ts:235`](../../scripts/engine-load-test/cli.ts#L235) invokes the comparator; [`scripts/performance-regression/run.ts:711`](../../scripts/performance-regression/run.ts#L711) evaluates the six collected arms with manifest metrics. |
| Reusable workload collection | [`scripts/engine-load-test/cli.ts:280`](../../scripts/engine-load-test/cli.ts#L280) forwards the bounded collection contract to [`packages/runtime-native/scripts/profile-production.mjs`](../../packages/runtime-native/scripts/profile-production.mjs); the collector writes the shared evidence contract. |
| Hosted probes and hardware workflow | [`.github/workflows/ci.yml:831`](../../.github/workflows/ci.yml#L831), [`.github/workflows/native-platforms.yml:646`](../../.github/workflows/native-platforms.yml#L646), and [`.github/workflows/native-platforms.yml:949`](../../.github/workflows/native-platforms.yml#L949) invoke real bounded collectors; [`.github/workflows/performance-regression.yml:61`](../../.github/workflows/performance-regression.yml#L61) maps each result key to its runner. |
| Evidence summary and baseline approval | [`.github/workflows/ci.yml:847`](../../.github/workflows/ci.yml#L847), [`.github/workflows/ci.yml:1043`](../../.github/workflows/ci.yml#L1043), and [`.github/workflows/performance-regression.yml:275`](../../.github/workflows/performance-regression.yml#L275) use the shared summary; [`.github/workflows/performance-regression.yml:283`](../../.github/workflows/performance-regression.yml#L283) checks calibration/cost policy while [`:395`](../../.github/workflows/performance-regression.yml#L395) keeps baseline regeneration separate. |

Calibration remains unverified and promotion remains maintainer-owned. The 20-run accuracy and
20-run CI-cost requirements remain encoded in the manifest; this repair made no baseline or
required-check promotion.

---

### PRD-358 final-audit repair — 2026-09-05

This repair does not accept a baseline, promote a required check, or claim physical Android/iOS
execution. The source PRD remains unchanged. Hardware calibration and the 20-run accuracy/cost
promotion evidence remain UNVERIFIED.

The scheduled matrix now uses runner-aware dispatch and explicit Bash, with hosted reporting for
unprovisioned physical resources. Desktop collection rebuilds the instrumented game bundle while
reusing the supplied native host. Mobile prebuilt collection requires a matching, hash-verified
production workload receipt and packaged app identity; existing conformance applications without
that receipt are BLOCKED, not interchangeable production workloads. Regression collection has
five startup launches and one steady observation per arm, three alternating pairs, and a shared
15-minute collection deadline. Pooled steady windows are rejected.

Promoted conversion rejects missing/unknown/synthetic hardware identity; each baseline observation
must match its approved lane identity. Candidate build provenance may differ. Browser production
and the moving L2/L3 ladder now have separate manifest workloads and comparison consumers. Both
remain unprovisioned until actual hardware identity and accepted baselines exist. Required
SKIPPED/UNVERIFIED coverage cannot yield PASS, and hosted aggregation reads collector artifacts,
not a synthetic job-success row.

Observed red/green commands and output (local logs are temporary, not checked-in frame archives):

| Command | Observed result |
|---|---|
| `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts` before fixes | `Test Files 1 failed (1)`; `Tests 4 failed / 59 passed (63)`; exit 1. Identity, approved-baseline, required coverage, and workflow assertions rejected the old implementation. |
| `pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs` before fixes | `Test Files 1 failed (1)`; `Tests 4 failed / 22 passed (26)`; exit 1. Bounded launch and prebuilt workload tests rejected the old contract. |
| Same native command, additional negative controls | Pooled valid windows: received `PASS`, expected `BLOCKED` before guard. Source `minFps` test: `1 failed / 27 passed (28)` before mapping the existing playtest FPS bound. |
| `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/performance-regression.spec.ts scripts/__tests__/engine-load-test.spec.ts scripts/__tests__/ci-needs.spec.ts` after fixes | `Test Files 4 passed (4)`; `Tests 134 passed (134)`; exit 0. |
| Native command above after fixes | `Test Files 1 passed (1)`; `Tests 28 passed (28)`; exit 0. |
| `pnpm test` (final complete run) | Exit 0; root `Test Files 391 passed / 1 skipped (392)`, `Tests 4306 passed / 4 skipped (4310)`; native `100 passed` files, `722 passed / 34 skipped` tests, plus `29 passed` physics-parity tests. |
| `pnpm typecheck` (serial retry after the build completed) | Exit 0; all workspace checks completed, ending `examples/abyss-framework typecheck: Done`. |
| `pnpm lint` | Exit 0; `Checked 1962 files`; `Found 611 warnings.` No fixes applied by the gate. |
| `pnpm test:playtest` | Exit 0; framework movement, camera, axis, zoom, navigation and streaming scenarios passed. This is not physical-device performance evidence. |
| `pnpm budgets` | Exit 1: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit).` Unrelated index left unchanged. |
| `yq eval '.' .github/workflows/ci.yml`, same command for `native-platforms.yml` and `performance-regression.yml` | Each exit 0. YAML parsing only; no hosted execution or actionlint claim. |
| `git diff --check` | Exit 0, no output. |

The executed bounded desktop probe was:

```sh
node packages/runtime-native/scripts/profile-production.mjs --profile production \
  --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 \
  --prebuilt-artifact "$PWD/packages/runtime-native/build/tn-linux/mystral" \
  --out artifacts/prd358-final-audit-desktop
```

Final observed output: `"status": "BLOCKED"`, `"exitCode": 2`; one steady window with
`durationSeconds: 0` and `sampleCount: 0`. Codes: `TN_PROD_RENDER_SAMPLES_INCOMPLETE`,
`TN_PROD_STARTUP_SAMPLES_INCOMPLETE`, `TN_PROD_PLAYTEST_FAILED`, `TN_PROD_MARKER_MISSING`,
`TN_PROD_PERFORMANCE_BUDGET`, `TN_PROD_STARTUP_BUDGET`. Evidence is retained locally at
`artifacts/prd358-final-audit-desktop/production-evidence.json`, including hashes and dirty-source
identity. It is not a throughput, readiness or startup pass. Earlier executions exposed a malformed
generated mailbox declaration (fixed and VM-tested) and unsupported existing `minFps` bounds
(fixed and tested). An intervening build reported missing playtest peer exports while another
gate rebuilt distributions; the serial retry got past that build. A concurrent typecheck similarly
reported TS7016 missing playtest declarations during `pnpm test`'s rebuild; this is recorded as a
setup collision, not dismissed as a passing check.

Current non-test integration callers supersede the historical line references above:

| Ledger contract | Live caller |
|---|---|
| Approved baseline binding and paired comparison | `scripts/performance-regression/run.ts:811` validates the collected baseline before adding the pair and evaluating the manifest metrics. |
| Reusable prebuilt workload | `packages/runtime-native/scripts/profile-production.mjs:470` invokes the instrumented desktop build or mobile receipt verification. |
| Hosted native collector | `.github/workflows/ci.yml:363`, `.github/workflows/native-platforms.yml:677`, and `.github/workflows/native-platforms.yml:980` invoke bounded collectors. |
| Real artifact coverage | `.github/workflows/ci.yml:1065` and `.github/workflows/native-platforms.yml:116` invoke artifact-backed coverage aggregation. |
| Scheduled hardware dispatch and summary | `.github/workflows/performance-regression.yml:61` selects the runner; `:292` aggregates every expected execution key, including separate Windows/macOS and browser-ladder rows. |

Physical Android/iOS, Windows/macOS, simulator/emulator execution, calibrated browser/Linux
throughput, and GitHub-hosted workflow execution remain UNVERIFIED from this checkout. YAML
parsing and structure tests do not claim those platforms ran. Missing promoted evidence remains
BLOCKED/2; regression FAIL remains 1 and a fully evidenced PASS remains 0.

### PRD-358 desktop mailbox repair — 2026-09-05

The collector now passes the exact `project/.runtime-mailbox` root from
`runDesktopBridgeScenario()` through `createDesktopDriver()` and `spawnNative()` into
`TN_PLAYTEST_MAILBOX_ROOT`. It overrides a stale inherited root and leaves the screenshot request
path unchanged. This is a collector plumbing repair, not a game, baseline, or threshold change.
The debugging-strategies skill guided the isolated child-environment reproduction.

Observed red: with the implementation still at `e00e8614`, running
`pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'desktop child receives'`
exited 1: `Test Files 1 failed (1)`; `Tests 1 failed / 28 skipped (29)`.
The assertion expected `/fixture/scaffold/.runtime-mailbox` but received
`/wrong/inherited/root`. After the repair, the full production-profile command without `-t`
exited 0: `Test Files 1 passed (1)`; `Tests 29 passed (29)`. The test executes the actual driver
and spawn functions with an observed child-environment stub; it also verifies the screenshot
request/rename paths and the live mailbox argument wiring.

`pnpm native:build` exited 0, including dependency checks, native physics/UI preparation,
`tn-linux` CMake configure and native executable linking. The executed probe was:

```sh
node packages/runtime-native/scripts/profile-production.mjs --profile production \
  --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 \
  --prebuilt-artifact "$PWD/packages/runtime-native/build/tn-linux/mystral" \
  --out artifacts/prd358-mailbox-desktop
```

It retained `artifacts/prd358-mailbox-desktop/production-evidence.json` and a startup playtest
report at `artifacts/prd358-mailbox-desktop/artifacts/c85491d9bc7d657b71f9577cbd77eb35a56134bca445a4272cb94768456d6fec`.
The probe still exited 2 (`BLOCKED`): the startup report now reports
`TN_PLAYTEST_CAPABILITY_MISSING` for `browser.network`, not `TN_PLAYTEST_BRIDGE_MISSING`.
The existing connection path in `packages/playtest/src/runner/bridgeClient.ts:207` only reaches
this capability validation after successful mailbox connection, `describe`, protocol validation,
and `ready`. Thus the retained failure demonstrates the repaired handshake; it does not establish
complete workload readiness or performance. The steady launch did not retain a successful report;
the aggregate has one zero-duration/zero-sample window. No assertion was removed or weakened to
accept this evidence. Missing render/startup samples, markers and budget evidence remain BLOCKED.

Reports remain local only. Physical Android/iOS execution, performance calibration, hardware
promotion and baseline regeneration are not claimed by this repair. The source PRD is untouched.

| Executed gate | Exact result |
|---|---|
| `pnpm typecheck` | Exit 0; workspace checks completed, ending `examples/abyss-framework typecheck: Done`. |
| `pnpm test` | Exit 0; root `Test Files 391 passed / 1 skipped (392)`, `Tests 4306 passed / 4 skipped (4310)`; native `100 passed` files, `723 passed / 34 skipped (757)` tests, plus `29 passed` physics-parity tests. |
| `pnpm test:playtest` | Exit 0; the repository's real example playtest command completed with its private Xvfb display. This is browser correctness evidence, not physical performance proof. |
| `pnpm lint` | Exit 0; `Checked 1962 files`; `Found 611 warnings.` No fixes applied. |
| `pnpm budgets` | Exit 1: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit).` Unrelated retention index unchanged. |
| `git diff --check` | Exit 0; no output. |

### PRD-358 native diagnostics policy repair — 2026-09-05

The generated native startup and steady scenarios explicitly set `noNetworkErrors: false`
with `networkErrorsOptOutReason: "Native mailbox transports have no browser network observer;
console and runtime diagnostics remain required."` The browser scenarios are unchanged and
still require `browser.network`. Native `noConsoleErrors`, `noRuntimeDiagnostics` and
`runtimeReady` remain true; runner capability validation and workload budgets are unchanged.
The debugging-strategies skill guided the browser/native policy split test.

Observed red against `2327df9a`:
`pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'native scenarios explicitly'`
exited 1 (`1 failed / 29 skipped (30)`), with native `noNetworkErrors` received `undefined`,
expected `false`. After the fix, the full production-profile command without `-t` passed 30 tests.
The test loads both native scenarios through the real playtest schema for desktop/Android/iOS,
checks the non-empty opt-out reason, preserves console/runtime checks, and verifies that only
browser scenarios require the network capability. These are scenario tests, not mobile execution.

The first live rerun exited 2 but revealed that the existing collector catch discarded both
runner exceptions and their console output. The collector now retains them as failed JSON
reports with status 2, never as successful samples. The focused `-t 'desktop runner exceptions'`
test first exited 1 with the helper absent; the final full production-profile run exited 0:
`Test Files 1 passed (1)`; `Tests 31 passed (31)`. No runner or native runtime code was changed.

A retention retry correctly hit `TN_PROD_REDACTION` because child console output contained
absolute workstation paths. The collector now uses the existing `sanitizeManifest` guard for
each retained entry and replaces unsafe entries with explicit redaction notices, without relaxing
the guard. Its privacy assertion was observed red (`1 failed / 30 skipped (31)`, unsafe path
still present) and then green in the full 31-test production-profile run.

The final live command was:

```sh
node packages/runtime-native/scripts/profile-production.mjs --profile production \
  --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 \
  --prebuilt-artifact "$PWD/packages/runtime-native/build/tn-linux/mystral" \
  --out artifacts/prd358-native-diagnostics-safe
```

The native binary was reused from the successful `pnpm native:build` in the preceding mailbox
repair; this change does not alter C++. The collector rebuilt its instrumented platformer bundle.
Earlier executions of the same command used output directories
`artifacts/prd358-native-diagnostics-desktop` (discarded exceptions) and
`artifacts/prd358-native-diagnostics-retained` (privacy rejection). All three exited 2.

Final retained manifest: `artifacts/prd358-native-diagnostics-safe/production-evidence.json`.
Both real launches passed the bridge/capability setup and reached screenshot capture. Both report
`TN_PROD_NATIVE_SCREENSHOT_UNAVAILABLE`, with console evidence
`[Mystral] Desktop playtest mailbox configured` and `[info] TN_NATIVE_SMOKE_READY:webgpu`.
Neither reports the old `browser.network` or missing-bridge failure. Local JSON evidence:

| Launch | Path relative to `artifacts/prd358-native-diagnostics-safe/` |
|---|---|
| Steady | `artifacts/e4fb3a06d61a7681e315dd614c0c0458ad09134391373fcb0705fb1cf9f9933a` |
| Startup | `artifacts/e953d4cb0d3c8be6bb46153f477e9a0df5d048c5c5f2b49be40d2ce672b40c72` |

Final verdict remains `BLOCKED`, exit 2, not valid performance evidence. One failed steady window
records duration 0 seconds and sample count 0. No screenshot requirement, runtime assertion,
timing threshold, baseline or promotion policy was weakened. Physical Android/iOS execution is
UNVERIFIED; scenario-generation tests do not claim those devices ran. Reports stay local only.

| Executed gate | Exact result |
|---|---|
| `pnpm typecheck` | Exit 0; all workspace checks completed, ending `examples/abyss-framework typecheck: Done`. |
| `pnpm test` | Exit 0; root `391 passed / 1 skipped` files and `4306 passed / 4 skipped (4310)` tests; native `100 passed` files and `725 passed / 34 skipped (759)` tests, plus `29 passed` physics-parity tests. The later privacy normalization was additionally verified by the full 31-test production-profile rerun. |
| `pnpm test:playtest` | Exit 0; repository example playtests passed, ending with `streaming-sliced-attach-and-parallel-load` reporting `pass: true`. Browser correctness only, not native screenshot or physical performance proof. |
| `pnpm lint` | Exit 0; `Checked 1962 files`; `Found 611 warnings.` No fixes applied. |
| `pnpm budgets` | Exit 1: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit).` Unrelated index unchanged. |
| `git diff --check` | Exit 0; no output. |

### PRD-358 actionlint repair — 2026-09-05

The performance summary step no longer calls `cancelled()` from step-level `env`, where GitHub
Actions does not allow that function. It now derives `TN_PERF_CANCELLED` from the permitted
`needs.hardware-pairs.result == 'cancelled'` value. The aggregation script still appends a
required `BLOCKED` row for a cancelled matrix and the summary job remains `if: always()`; no
collector, matrix row, artifact upload, or fail-closed status rule changed.

Observed red before the repair:

```text
go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/performance-regression.yml .github/workflows/ci.yml .github/workflows/native-platforms.yml
.github/workflows/performance-regression.yml:224:34: calling function "cancelled" is not allowed here. "cancelled" is only available in "jobs.<job_id>.if", "jobs.<job_id>.steps.if".
exit status 1
```

The focused structure test was also red before the repair:

```text
pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts -t 'permitted cancellation source'
Test Files 1 failed (1)
Tests 1 failed | 65 skipped (66)
exit 1
```

After the minimal expression change, the focused test passed:

```text
pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts -t 'permitted cancellation source'
Test Files 1 passed (1)
Tests 1 passed | 65 skipped (66)
exit 0
```

The complete relevant test pair passed:

```text
pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/performance-regression.spec.ts
Test Files 2 passed (2)
Tests 83 passed (83)
exit 0
```

Final workflow validation passed with no output and exit 0:

```text
go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/performance-regression.yml .github/workflows/ci.yml .github/workflows/native-platforms.yml
```

`git diff --check` also passed with no output and exit 0. Existing hardware rows remain
UNVERIFIED/unprovisioned, and no baseline was promoted. The unrelated `pnpm budgets` blocker
recorded above remains the stale `docs/benchmark/SCREENSHOT-RETENTION.md` index; it was not
edited.

### PRD-358 hosted native UI renderer follow-up — 2026-09-05

`installNativeProfileEntry` now passes the selected target into the temporary project config
writer. Desktop profiling changes the temporary project's `ui.renderer` from `web` to `native`
before the native build; mobile targets preserve `web`, and web collection does not use this
native entry installer. This fixes the harness configuration rather than changing workflow status
handling or accepting missing evidence.

The focused regression was red before the change:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'desktop profiling switches'
Test Files 1 failed (1)
Tests 1 failed | 31 skipped (32)
exit 1
```

The same focused test passed after the change:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'desktop profiling switches'
Test Files 1 passed (1)
Tests 1 passed | 31 skipped (32)
exit 0
```

The complete native production-profile suite passed:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs
Test Files 1 passed (1)
Tests 32 passed (32)
exit 0
```

The existing performance-regression and CI structure suites passed:

```text
pnpm exec vitest run scripts/__tests__/performance-regression.spec.ts scripts/__tests__/ci-structure.spec.ts
Test Files 2 passed (2)
Tests 83 passed (83)
exit 0
```

Repository lint passed with its existing warnings:

```text
pnpm lint
Checked 1962 files in 789ms. No fixes applied.
Found 611 warnings.
exit 0
```

The exact bounded Linux command was attempted against the existing executable
`packages/runtime-native/build/tn-linux/mystral` and a fresh output directory:

```text
timeout 45s node packages/runtime-native/scripts/profile-production.mjs --profile production --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 --prebuilt-artifact "$PWD/packages/runtime-native/build/tn-linux/mystral" --out artifacts/prd358-hosted-linux-ui-native-followup
exit 2
```

Retained local manifest `artifacts/prd358-hosted-linux-ui-native-followup/production-evidence.json`
reports the following exact result:

```json
{"status":"BLOCKED","exitCode":2,"codes":["TN_PROD_RENDER_SAMPLES_INCOMPLETE","TN_PROD_STARTUP_SAMPLES_INCOMPLETE","TN_PROD_PLAYTEST_FAILED","TN_PROD_MARKER_MISSING","TN_PROD_PERFORMANCE_BUDGET","TN_PROD_STARTUP_BUDGET"],"runWindows":[{"durationSeconds":0,"sampleCount":0}]}
```

Both retained launches reached the desktop mailbox and runtime-ready markers and emitted frame
sample lines. The steady report `production-playtest-desktop-1` carries diagnostic
`TN_PROD_NATIVE_SCREENSHOT_UNAVAILABLE`; the startup report `production-startup-desktop-1` carries
`Unexpected device response id 'invalid'.` The host therefore remains unable to render the
required screenshot/evidence and the collector correctly remains `BLOCKED`, not `PASS`. The two
raw reports remain local-only under the output directory. No native C++ changed, so the previously
built Linux executable was reused; no physical Android/iOS execution or baseline promotion is
claimed.

`git diff --check` passed with no output and exit 0 after the documentation update.

### PRD-358 hosted screenshot transport follow-up — 2026-09-05

The production desktop driver now uses the existing native post-present mailbox protocol. It writes
the requested output path as raw UTF-8 to `tn-playtest-screenshot-request.txt.tmp`, atomically
renames it to `tn-playtest-screenshot-request.txt`, and removes the `.txt` request during mailbox
cleanup. The generated native entry no longer injects the obsolete JSON request path or calls
`__THREENATIVE_NATIVE__.playtest.receive`/`captureScreenshot`. The native C++ host was not changed.

Focused transport tests were red before the harness change:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'post-present|generated native mailbox'
Test Files 1 failed (1)
Tests 3 failed | 29 skipped (32)
exit 1
```

After the transport change they passed:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'post-present|generated native mailbox'
Test Files 1 passed (1)
Tests 3 passed | 29 skipped (32)
exit 0
```

The focused report-retention test was initially red because `safeReport` did not yet exist:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'native report retention'
TypeError: safeReport is not a function
Test Files 1 failed (1)
Tests 1 failed | 32 skipped (33)
exit 1
```

The combined focused tests passed after the retention guard was added:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t 'native report retention|post-present|generated native mailbox'
Test Files 1 passed (1)
Tests 4 passed | 29 skipped (33)
exit 0
```

The full native production-profile suite passed:

```text
pnpm --dir packages/runtime-native exec vitest run --config vitest.config.ts tests/production-profile.test.mjs
Test Files 1 passed (1)
Tests 33 passed (33)
exit 0
```

The existing performance-regression and CI structure suites passed:

```text
pnpm exec vitest run scripts/__tests__/performance-regression.spec.ts scripts/__tests__/ci-structure.spec.ts
Test Files 2 passed (2)
Tests 83 passed (83)
exit 0
```

Repository lint passed with its unchanged warnings:

```text
pnpm lint
Checked 1962 files in 836ms. No fixes applied.
Found 611 warnings.
exit 0
```

The first post-present bounded Linux run reached native screenshot handling but could not retain
its manifest because the native host's `/home/.../localStorage` console line was exposed in a raw
report. It exited 2 with this exact structured error:

```json
{"codes":["TN_PROD_REDACTION"],"message":"Absolute workstation path or authorization material at $.rawArtifacts[1].content rejected before retention.","status":"BLOCKED","exitCode":2}
```

The report-retention fix redacts only unsafe host-detail strings and preserves safe console and
diagnostic observations. The exact bounded Linux command was then rerun with the existing
prebuilt executable and a fresh output directory:

```text
timeout 45s node packages/runtime-native/scripts/profile-production.mjs --profile production --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 --prebuilt-artifact "$PWD/packages/runtime-native/build/tn-linux/mystral" --out artifacts/prd358-hosted-linux-screenshot-post-present-3
exit 1
```

Retained local manifest:
`artifacts/prd358-hosted-linux-screenshot-post-present-3/production-evidence.json`.
Its exact summary is:

```json
{"status":"FAIL","exitCode":1,"codes":["TN_PROD_PERFORMANCE_BUDGET"],"runWindows":[{"durationSeconds":2.81466845703125,"sampleCount":375}],"sampleCount":375,"p95FrameMs":21.38525390625,"p99FrameMs":47.129638671875,"meanFps":133.23061160657207,"oneSecondFps":[164,99],"artifactCount":4}
```

The manifest retains four artifacts: steady screenshot/report and startup screenshot/report. Both
reports have `pass: true`, no diagnostics, bridge-ready and `TN_NATIVE_SMOKE_READY:webgpu` console
markers, and frame samples (75 steady sample lines, 78 startup sample lines). The host therefore
gets past the old screenshot transport failure; this run is a real performance `FAIL` because its
p99/one-second result breaches the declared budget, not a screenshot or missing-evidence `PASS`.
Raw evidence remains local only. No physical Android/iOS execution or baseline promotion is
claimed.

`git diff --check` passed with no output and exit 0 after this update.

### PRD-358 prebuilt artifact path repair — 2026-09-06

The production collector changes its working directory to the generated scaffold before it
launches a supplied native host. Relative `--prebuilt-artifact` values therefore resolved against
the temporary project and produced `ENOENT` on hosted macOS and Windows jobs. `normalizeOptions`
now resolves that input at the CLI boundary, while the existing receipt and binary hash checks stay
in place.

The focused regression was red before the repair:

```text
pnpm exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t "accepted profile controls"
Test Files 1 failed (1)
Tests 1 failed | 32 skipped (33)
Expected: "/home/.../build/tn-macos/mystral"
Received: "build/tn-macos/mystral"
exit 1
```

The same focused command passed after the repair:

```text
pnpm exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t "accepted profile controls"
Test Files 1 passed (1)
Tests 1 passed | 32 skipped (33)
exit 0
```

The complete production-profile suite then passed with 33 tests. The full root test retry passed
with 390 files passed and 2 skipped, and 4,304 tests passed and 7 skipped. The lane remains clean
at `91cfbc34`; the hosted CI run for that commit still timed out the Linux collector at its
declared 45-second bound and retained its collector status artifact. The native-platform run was
still completing its Windows and iOS jobs when this record was written; its completed macOS job
was from the pre-repair execution window. No physical performance baseline or platform claim is
promoted by this repair.

The same command with a relative prebuilt path was also executed locally with `DISPLAY` unset;
the collector completed through the post-present mailbox and retained startup and steady reports:

```text
timeout 60s node packages/runtime-native/scripts/profile-production.mjs --profile production --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 --prebuilt-artifact packages/runtime-native/build/tn-linux/mystral --out artifacts/prd358-relative-path-repair
{"status":"FAIL","exitCode":1,"codes":["TN_PROD_PERFORMANCE_BUDGET"],"runWindows":[{"durationSeconds":7.403327880859375,"sampleCount":315}],"startupMs":3735,"p95FrameMs":81.957763671875,"p99FrameMs":152.314697265625,"meanFps":42.5484329573466,"artifactCount":4}
```

The result is an honest production budget failure with complete reports, rather than a path or
missing-evidence failure. This workstation result is diagnostic only; it does not promote a
baseline or certify a hosted or physical lane.

### PRD-358 native cleanup repair — 2026-09-06

The hosted macOS collector reached the corrected absolute artifact path, but a runner failure
after the child exited caused cleanup to call `process.kill` on a gone process group. The resulting
`ESRCH` escaped before `desktopFailureRun` could retain the failed report. Cleanup now treats only
that already-exited condition as complete and still propagates other signals.

The hosted macOS run `34003845012` exposed the failure:

```text
{"codes":["TN_PROD_EVIDENCE_INVALID"],"message":"kill ESRCH","status":"BLOCKED","exitCode":2}
```

The focused regression was red before the repair:

```text
pnpm exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t "desktop cleanup tolerates"
Test Files 1 failed (1)
Tests 1 failed | 33 skipped (34)
exit 1
```

It passed after the repair:

```text
pnpm exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t "desktop cleanup tolerates"
Test Files 1 passed (1)
Tests 1 passed | 33 skipped (34)
exit 0
```

The complete production-profile suite passed with 34 tests. The same hosted run retained a
Windows production manifest with `TN_PROD_RENDER_SAMPLES_INCOMPLETE`,
`TN_PROD_STARTUP_SAMPLES_INCOMPLETE`, `TN_PROD_PLAYTEST_FAILED`, and zero samples; iOS remained
an advisory simulator row without a retained production manifest. The native coverage summary
reported Windows, macOS and iOS simulator as `BLOCKED`, with the physical rows `UNVERIFIED` and
the optional parity/emulator rows `SKIPPED`. These are evidence dispositions, not platform
performance claims.

### PRD-358 hosted software evaluation repair — 2026-09-06

GitHub-hosted native collectors run without a calibrated physical GPU. They now pass
`--hosted-software`, which records `execution.performanceEvaluation: "advisory"`. Lifecycle,
playtest, startup collection and evidence integrity remain blocking checks; frame, draw-call,
triangle, memory and startup budget observations remain in the manifest and move to
`advisoryCodes` when they cannot be treated as a physical performance claim. The default path
and physical targets remain strict, and the hosted mode cannot be selected for a physical target
or a fixture control.

The focused tests passed:

```text
pnpm exec vitest run --config vitest.config.ts tests/production-profile.test.mjs -t "hosted software|accepted profile controls|production evidence uses nearest-rank"
Test Files 1 passed (1)
Tests 3 passed | 32 skipped (35)
exit 0

pnpm exec vitest run --config vitest.config.ts scripts/__tests__/ci-structure.spec.ts -t "bounded native desktop and simulator collectors"
Test Files 1 passed (1)
Tests 1 passed | 65 skipped (66)
exit 0
```

The built Linux host completed the same bounded collector locally with `DISPLAY` unset:

```text
timeout 90s node packages/runtime-native/scripts/profile-production.mjs --profile production --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 --hosted-software --prebuilt-artifact packages/runtime-native/build/tn-linux/mystral --out artifacts/prd358-hosted-software-repro-1788661250
status PASS
exitCode 0
codes []
advisoryCodes ["TN_PROD_PERFORMANCE_BUDGET"]
performanceEvaluation "advisory"
meanFps 27.894704622219916
p95FrameMs 117.862060546875
p99FrameMs 210.113525390625
startupMs 4602
runWindows [{"durationSeconds":9.858501953125,"sampleCount":275}]
```

This proves the hosted smoke contract and complete artifact retention. It does not promote a
baseline or certify physical desktop, Android or iOS performance.

### PRD-358 hosted software render-tier repair — 2026-09-06

The hosted Windows collector reached the game, but Microsoft Basic software D3D12 could not
compile the platformer's high-quality SSGI/SSR chain. FXC returned `E_FAIL`, the native host
reported invalid command buffers, and the collector retained neither a screenshot nor the
startup/steady markers. The profile now writes an executable `__THREENATIVE_PROFILE__` marker
before importing the game. The platformer generated source uses the existing `low` quality preset
only when that marker says `hostedSoftware: true` and no explicit tier override is present;
ordinary desktop runs remain `high`, and `TN_QUALITY_TIER` reports the source.

The regression test was red before the marker existed:

```text
packages/runtime-native/tests/production-profile.test.mjs
  generated native profile exposes hosted software only to the profile entry
  ENOENT: src/profile-native-profile.ts
```

It passed after the repair. The focused production-profile suite passed 42/42, the platformer
template and quality checks passed 26/26, and the scaffold hash check passed 1/1 after updating
the expected platformer tree hash.

The local production collector then completed the hosted profile with a built native host:

```text
timeout 150s node packages/runtime-native/scripts/profile-production.mjs --profile production --target desktop --duration 1 --cold-starts 1 --repetitions 1 --warmup 1 --hosted-software --prebuilt-artifact packages/runtime-native/build/tn-linux/mystral --out artifacts/prd358-hosted-software-profile-marker
status PASS
exitCode 0
codes []
advisoryCodes ["TN_PROD_PERFORMANCE_BUDGET"]
markers run-start, first-workload-frame, clean-end
startupMs 3487
p95FrameMs 66.39
p99FrameMs 94.29
meanFps 50.14
sampleCount 250
TN_QUALITY_TIER low mobile=false source=hosted-software
```

The run retained one screenshot and complete startup/steady evidence with the local NVIDIA RTX
2080 adapter. This proves profile propagation, the low smoke path, screenshot/mailbox transport,
and fail-closed evidence collection; the advisory timing budget is not a physical performance
baseline. Hosted run `34061495196` confirmed the tier change on Microsoft Basic D3D12
(`TN_QUALITY_TIER low`) but still failed its 1920×1080 screenshot request: buffer mapping timed
out and the host exited with `SIGSEGV`, leaving only `run-start`. The second red test showed that
the hosted desktop profile's unrequested 1920×1080 default was the remaining input; it now selects
the proven 1280×720 smoke surface, while an explicit `--render-size 1920x1080` remains honored.
The next hosted Windows rerun is required before this repair can be called cross-platform CI
evidence.

### PRD-358 hosted screenshot callback lifetime repair — 2026-09-06

The hosted Windows 1280x720 rerun reached the screenshot request but timed out while mapping the
readback buffer, then exited with `SIGSEGV`. The native screenshot path passed stack-local
`BufferMapData` to an asynchronous Dawn callback; when the timeout returned, a late callback could
write through that expired pointer. The fix gives each callback a heap-owned `shared_ptr` holder,
uses Dawn's `AllowSpontaneous` callback mode, waits against a five-second wall-clock deadline,
and unmaps the buffer on timeout. This follows the already-shipped async `GPUBuffer.mapAsync`
ownership pattern in `bindings_resources.cpp`.

Red/green evidence:

```text
before fix: production-profile.test.mjs 42 passed, 1 failed
after fix:  production-profile.test.mjs 43 passed
```

The rebuilt Linux Dawn host and focused native gate both passed:

```text
cmake --build packages/runtime-native/build/tn-linux --target mystral -j2       PASS
ctest --test-dir packages/runtime-native/build/tn-linux -R screenshot-capture-gate \
  --output-on-failure                                                        PASS (1/1)
```

The local hosted-software collector then completed at the same 1280x720 smoke size:

```text
pnpm --filter @threenative/runtime-native profile:production -- --target desktop \
  --render-size 1280x720 --cold-starts 1 --warmup 1 --repetitions 1 --hosted-software \
  --prebuilt-artifact build/tn-linux/mystral --out /tmp/prd358-local-screenshot-fix-2
status PASS; exitCode 0; markers run-start, first-workload-frame, clean-end
startupMs 3528; sampleCount 275; codes []
```

This proves the callback lifetime fix on the local Dawn host and retains startup, steady-frame,
and screenshot evidence. Hosted run
[`34064759191`](https://github.com/ThreeNativeHQ/threenative/actions/runs/34064759191) then
passed the Windows and macOS desktop jobs, the iOS simulator/no-Xcode consumer job, the
scaffolded Linux starter job, and the final native collector-evidence coverage job. The retained
`native-desktop-Windows` artifact records:

```text
collector-status: PASS; collectorExitCode: 0; provenance: hosted-software
production markers: run-start, first-workload-frame, clean-end
native report: pass true; rendered frames 300; screenshot 1280x720
production evidence: status PASS; exitCode 0; startupMs 289; sampleCount 270
```

The hosted production evidence carries the expected advisory
`TN_PROD_PERFORMANCE_BUDGET` code because hosted software rendering is not a physical
performance baseline; lifecycle, screenshot, and artifact-retention checks passed. This closes
the cross-platform CI evidence gap for the callback-lifetime repair without claiming physical
Windows performance.

### PRD-358 audit repair — source-pair and workload identity — 2026-09-06

This repair addresses two independent audit defects. The source-pair failure artifact now writes
`sourceSha` and `candidateSourceSha` as explicit nullable keys, so missing-baseline,
missing-candidate, and self-comparison failures always retain both identities while remaining
`BLOCKED`. The browser load test now traverses the actual served import/export, dynamic-import, and
static-URL module graph. `artifactHash` hashes that graph without `sourceSha`; `workloadHash` hashes
the served `game.ts`/`workload.ts` graph and the selected frames, ladder, modes, repeats, warmup,
workload, and render configuration. `sourceSha` remains a separate identity field, and the
1,800-frame workload and 15-minute deadline are unchanged. The source PRD, baseline promotion, and
physical-lane claims were not changed.

The focused tests were written and run red before the implementation. The mutation was the old
workflow writer's `|| undefined` fields and the old single-module/parameter-only identity wiring:

```text
pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/engine-load-test.spec.ts -t 'preserves both source identities|keep artifact identity independent'
Test Files 2 failed (2)
Tests 2 failed | 111 skipped (113)
exit 1
```

The failures were the omitted `sourceSha` key for a missing baseline and the absent
`hashServedModuleGraph(artifactModules)` wiring. After the repair, the same focused command passed:

```text
Test Files 2 passed (2)
Tests 2 passed | 111 skipped (113)
exit 0
```

The real browser probe also ran twice with identical settings and different source labels. Both
runs exited 0 on the local NVIDIA WebGPU adapter; the retained report comparison was:

```json
{"artifactHashEqual":true,"workloadHashEqual":true,"sourceShaA":"runtime-probe-source","sourceShaB":"relabeled-source","artifactHash":"0a0f092e55b20b341a598ffeee7522b896d4adb6d696e9fed4e378d67629cdad","workloadHash":"4a8170522548f2eb94356d096f59e2b6e66878508984b5d246b979f6442aa13a"}
```

Implementation and focused proof: [`performance-regression.yml:155`](../../.github/workflows/performance-regression.yml#L155), [`main.ts:381`](../../examples/engine-load-test/src/main.ts#L381), [`identity.ts:43`](../../examples/engine-load-test/src/identity.ts#L43), [`ci-structure.spec.ts:120`](../../scripts/__tests__/ci-structure.spec.ts#L120), and [`engine-load-test.spec.ts:121`](../../scripts/__tests__/engine-load-test.spec.ts#L121).

Repository gates after the repair:

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS; root plus 28 participating workspace projects; exit 0 |
| `pnpm lint` | PASS; `Checked 1967 files`; `Found 614 warnings`; no errors; exit 0 |
| `pnpm test` | PASS; 391 files passed, 1 skipped; 4,321 tests passed, 4 skipped; exit 0 |
| `pnpm budgets` | BLOCKED by the unchanged stale generated retention index: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; exit 1. No unrelated generated file was changed. |
| `git diff --check` | PASS; exit 0 |

The full test suite's known negative-control logs remained expected and did not alter the result.
No baseline was promoted, and no hosted or physical platform performance result is claimed.

### PRD-358 audit repair — served module graph identity across worktrees — 2026-09-06

The browser probe's served Vite module URLs include absolute `/@fs` paths. The previous graph
serializer hashed those paths and the transformed source bytes verbatim, so identical baseline and
candidate source trees in different checkout roots received different `artifactHash` and
`workloadHash` values. That could block a valid paired comparison before performance was even
considered. The repair canonicalizes served URLs and absolute transformed import references to
repository-relative paths before hashing; source bytes that are not root references remain
byte-sensitive, and workload configuration remains JSON-sensitive. No source PRD, baseline or
platform claim changed.

The focused regression was red before the implementation:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'stable across absolute worktree roots'
Test Files 1 failed (1)
Tests 1 failed | 40 skipped (41)
Expected: 0a14c172f765faad56c1a6d039656ad2989616dc498f783255b0a69dc538a05a
Received: ef710c080ce78364f7e0c534a02e6358b1e74709dbff24e731887ecf33113e2b
exit 1
```

After the repair, the focused identity tests passed:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'graph identity stable across absolute worktree roots|artifact identity independent of source labels'
Test Files 1 passed (1)
Tests 2 passed | 39 skipped (41)
exit 0
```

The complete `engine-load-test.spec.ts` file passed `41/41`. Repository gates after the repair:

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS; root plus 28 participating workspace projects; exit 0 |
| `pnpm lint` | PASS; `Checked 1967 files`; `Found 614 warnings`; no errors; exit 0 |
| `pnpm test` | PASS; `390` files passed, `2` skipped; `4,319` tests passed, `7` skipped; exit 0 |
| `pnpm budgets` | BLOCKED by the unchanged stale generated retention index: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; exit 1 |
| `git diff --check` | PASS; exit 0 |

Implementation and proof: [`identity.ts`](../../examples/engine-load-test/src/identity.ts),
[`engine-load-test.spec.ts`](../../scripts/__tests__/engine-load-test.spec.ts). No baseline was
promoted, and no hosted or physical platform performance result is claimed.

### PRD-358 audit repair — source-map and module-reference identity hardening — 2026-09-06

The previous canonicalizer had three independent failure modes: a regex could overflow on the
roughly 11 MB inline source map Vite adds to an unoptimized dependency; last-marker slicing could
collapse `packages/core` and `packages/physics` to the same `src/...` identity; and broad URL
rewriting could erase external origins or module query semantics. The repair strips only terminal
inline source-map metadata, scans executable quoted references linearly, removes only an explicitly
recognized checkout prefix, and preserves external/data URLs, complete package paths, and query or
hash suffixes. Executable bytes and workload configuration remain identity-sensitive.

The three new regression tests were red before the implementation:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'graph identity stable across absolute worktree roots|strip large inline source maps|preserve complete package paths|preserve ordinary external URLs'
Test Files 1 failed (1)
Tests 3 failed | 1 passed | 40 skipped (44)
exit 1
```

After the repair, the same focused command passed:

```text
Test Files 1 passed (1)
Tests 4 passed | 40 skipped (44)
exit 0
```

The complete `engine-load-test.spec.ts` file passed `44/44`. A real Vite middleware response was
also exercised: the served dependency was `9,893,196` bytes, included an inline source map, and
hashed successfully to
`581fc81edb6d01e2c264a06d4140f5f4df76e8feb89587eb1540e6ce2688d7bd`; no stack overflow occurred.

Repository gates after the repair:

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS; root plus 28 participating workspace projects; exit 0 |
| `pnpm lint` | PASS; `Checked 1967 files`; `Found 614 warnings`; no errors; exit 0 |
| `pnpm test` | PASS; `390` files passed, `2` skipped; `4,322` tests passed, `7` skipped; exit 0 |
| `pnpm budgets` | BLOCKED by the unchanged stale generated retention index: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; exit 1 |
| `git diff --check` | PASS; exit 0 |

Implementation and proof: [`identity.ts`](../../examples/engine-load-test/src/identity.ts) and
[`engine-load-test.spec.ts`](../../scripts/__tests__/engine-load-test.spec.ts). No baseline was
promoted, and no hosted or physical platform performance result is claimed.

### PRD-358 follow-up — Vite checkout-root and terminal source-map hardening — 2026-09-06

The follow-up repairs generic Vite module identity without relying on a marker that can occur in
an unrelated path. It recognizes complete Vite layout suffixes, requires one candidate checkout
root to agree across the graph, rejects `node_modules` candidate prefixes, and limits absolute
`/@fs` inference to local Vite hosts. Source-map removal now scans quoted strings, templates, and
comments linearly and removes only a terminal inline line or block map with trailing whitespace;
literal text, nested template expressions, external URLs, query/hash suffixes, and complete
package paths remain intact.

The focused regression command was red before the implementation:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'strip only terminal inline source-map comments outside literals|preserve complete package paths'
Test Files 1 failed (1)
Tests 2 failed | 43 skipped (45)
exit 1
```

After the implementation, the same focused command passed:

```text
pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts -t 'strip only terminal inline source-map comments outside literals|preserve complete package paths'
Test Files 1 passed (1)
Tests 2 passed | 43 skipped (45)
exit 0
```

The complete `engine-load-test.spec.ts` file passed `45/45`. A real Vite middleware response was
also exercised with `pnpm --filter threenative-engine-load-test dev --host 127.0.0.1 --port 5199
--strictPort`: `/src/main.ts` returned status `200`, `55,362` bytes, contained an inline source
map, and hashed to
`5042b5e381c037bc6cc098888d2247839a12ff1173134890408188f5682365ea`.

Repository gates after the follow-up:

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS; root plus 28 participating workspace projects; exit 0 |
| `pnpm lint` | PASS; `Checked 1967 files`; `Found 616 warnings`; no errors; exit 0 |
| `pnpm test` | PASS; `391` files passed, `1` skipped; `4,326` tests passed, `4` skipped; exit 0 |
| `pnpm budgets` | BLOCKED by the unchanged stale generated retention index: `retention index is stale at docs/benchmark/SCREENSHOT-RETENTION.md; regenerate it (do not hand-edit)`; exit 1 |
| `git diff --check` | PASS; exit 0 |

Implementation and proof: [`identity.ts`](../../examples/engine-load-test/src/identity.ts) and
[`engine-load-test.spec.ts`](../../scripts/__tests__/engine-load-test.spec.ts). No baseline was
promoted, and no hosted or physical platform performance result is claimed.

### PRD-358 follow-up — nested computed-import fail-closed scan and generated evidence — 2026-09-07

The object-method exemption in the lexical scanner previously treated `import(path)` inside an
object property's array, call, or parenthesized expression as a method name because it searched
for any enclosing object. Those valid JavaScript forms could therefore disappear from graph
identity. The scanner now limits the exemption to the current object-member delimiter, recognizes
generator methods (`*import` and `async *import`), and starts template-expression scans in
expression context so an object literal there is not mistaken for a block. Nested computed
imports, including operands after `*` and `**`, fail closed with
`TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE`.

Red/green evidence:

```text
before fix: Test Files 1 failed (1); Tests 1 failed | 93 skipped (94); exit 1
after fix:  Test Files 1 passed (1); Tests 1 passed | 93 skipped (94); exit 0
```

The generated retention index and native coverage digest were regenerated after the verification
record changed. Current repository gates are:

| Command | Result |
|---|---|
| `pnpm budgets` | PASS; generated retention index fresh, native coverage digest current; exit 0 |
| `git diff --check` | PASS; exit 0 |

Implementation and proof: [`identity.ts`](../../examples/engine-load-test/src/identity.ts) and
[`engine-load-test.spec.ts`](../../scripts/__tests__/engine-load-test.spec.ts). No baseline was
promoted, and no hosted or physical platform performance result is claimed.

## 7. Harness status

`assert.performance` (playtest scenarios) bounds `maxFrameMsP95`, `minFps`, `maxPhaseMsP95`,
`maxDrawCalls`, `maxTriangles` from the bridge's `performanceSeries` — fail-closed on missing
samples. The `perf` subcommand of the playtest CLI (landed 2026-08-27) parses both markers from
a captured log, a spawned desktop host, or device logcat, reports p50/p95 per window and per
host-gap segment, discards window 1, and fails closed on missing evidence — the recipes in §4
remain the protocol for what it does not cover (SurfaceFlinger cross-check, device builds).

## 8. Deleted-record index (evidence lives in git history)

| Deleted record | What it carried that this file does not |
| --- | --- |
| `prd-222-2026-08-25.md` | Phase 0's Chrome 59.99 vs native 19.15 claim, now falsified by rAF + SurfaceFlinger; thermal-validity table |
| `prd-222-2026-08-26.md` | F8 crossing attribution; writeBuffer handler anatomy; paired arm logs |
| `prd-222-fix-plan.md` | The F13 lever list and the `threadCpuNs` desktop meter recipe |
| `prd-222-loop-log.md` | F1–F16 full text, iteration-cycle costs, device-arm tables, protocol traps |
| `prd-222-reassessment-2026-08-26.md` | The per-call pricing search that found the binding-table mechanism (its root-cause claim is refuted; mechanism stands) |
| `round-222-prd-222-2026-08-25.md` | Round ledger entry (round ledgers otherwise remain per-run files) |
| `perf-bug-hunt-2026-08-27.md` | Fix table with red-green commits (`17bfd794…b5021ce5`); gate-status ledger |
| `PATH-TO-60FPS-2026-08-27.md` | The 22.3 ms seam model (superseded as load-bearing; kept as the Change 1/2 rationale) |
| `HANDOVER-native-60fps-2026-08-27.md` | Rebuild commands (desktop + device), A3/A4 arm designs, open-caveat list |
| `HANDOVER-hostgap-2026-08-27.md`, `HANDOVER-60fps-road-2026-08-27.md` | The instrument tasks (both done) and the gpuDrain task 1 spec |
| `prd-224-frame-pricing-and-device-arm-2026-08-27.md` | Phase 1a same-binary A/B pricing tables; device 20.44 fps arm |
| `prd-224-binding-tables-once-per-class-2026-08-27.md`, `prd-224-phase1-pricing-2026-08-28.md` | The conversion record and its NO-MOVE frame pricing (baseline-drift forensic) |
| `prd-226-a1-backend-swap-2026-08-27.md` | A1 interleave protocol; warm-up discovery (F15) |
| `prd-226-a2-null-backend-2026-08-27.md`, `prd-226-budget-a0-a2-a5-2026-08-27.md` | A2 arm detail; A0/A2/A5 tables + validity checks + disclosure ledger |
| `prd-226-device-meter-audited-2026-08-27.md` | SurfaceFlinger `--latency` audit transcript (its 120 Hz inference is corrected in §1) |
| `prd-227-cadence-lock-2026-08-27.md` | The five-arm invariance tables; addenda refuting present cadence and overlay |
| `prd-227-hostgap-decomposition-2026-08-27.md` | TN_HOST_GAP design + cross-check tables; device arm matrix |
| `prd-227-gpu-frame-time-2026-08-27.md` | gpuDrain red-green control tables; the Road B fork arithmetic |
| `prd-227-p1-2026-08-27.md` | P1 acceptance: sha256s, eligibility windows, mutation names |
| `prd-227-p2-2026-08-27.md` | P2 falsification: symbol-share tables, IC-log site list, artifacts sha256s |
| `native-performance-benchmarks-2026-08-11.md` | The three-engine Pixel 8 afternoon table + its unfairness caveats |
| `native-gameplay-frame-rate-2026-08-11.md` | HUD-draw fold (93 → 11) closure; half-resolution probe incident |
| `native-cpu-profile-fox-scale-2026-08-11.md`, `native-cpu-webgpu-presentation-hardening-2026-08-11.md` | profile:native-cpu baseline + presentation fail-close hardening |
| `three-webgpu-per-object-cost-2026-08-15.md` (+ `.html` repro) | L1/L2/L3 rung tables behind §6 |
| `engine-load-test-summary-2026-08-15.md` | Full gate-PASS tables behind §6; the historical browser detail is consolidated above at [PRD-117 browser detail](#prd-117-browser-detail-2026-08-14) |
| `fps-framework-mobile-perf-2026-08-24.md` | Launch timeline tables; loading-stall discovery |
| `prd-218-launch-stall-and-heat-2026-08-24.md` | Stall-segment attribution; thermal confound ledger |
| `prd-189-core-frame-allocations-2026-08-22.md` | Negative-control table for the allocation-free contract |
| `prd-170-physics-allocations-2026-08-22.md` | Physics hygiene changes + BigInt key derivation |
| `prd-193-template-frame-allocations-2026-08-23.md` | Template probe design (`PathFollow3D` identity contract) |


## Performance regression strategy discovery (2026-09-05)

Planning evidence for [PRD-358](../PRDs/performance/PRD-358-cross-platform-performance-regression-ci.md).
Source: `d4635c2a96a8ffb2a2cfd6d3c0ab2b1d63fbaa3e`; dirty checkout already contained an unrelated
`docs/PRDs/quickwins-2026-09-04/README.md` deletion. No engine, game or CI implementation changed.

Discovery found the CI `benchmark` job's Playwright selection is
`examples/abyss-framework/tests/viewport.playtest.ts` (resize/visibility, no timing regression).
The separate engine-load CLI has Android physical/emulator baselines with 25% tolerance, while
`checkPerformance` returns undefined for an absent baseline. Production-profile and playtest
collectors already own the measurement/evidence mechanisms; PRD-358 proposes their CI integration.

Executed commands and selected verbatim output:

```text
node packages/playtest/dist/runner/cli.js doctor --text
✓ node: node 20.19.6
✓ display: DISPLAY=:0
✓ adb: adb is on PATH, so --target android can run
! xcrun: xcrun is not on PATH, so --target ios cannot run here

node packages/playtest/dist/runner/cli.js doctor --device <connected-wifi-device> --text
✓ device.thermal: battery 32.8 °C, thermal status 0 (NONE), skin 33.4 °C
✓ device.battery: battery 80%
✓ device.charging: discharging (dumpsys battery status 3)

pnpm exec vitest run packages/playtest/__tests__/performance.spec.ts packages/playtest/__tests__/perf.spec.ts scripts/__tests__/ci-structure.spec.ts
Test Files  3 passed (3)
     Tests  82 passed (82)
  Duration  1.04s

pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts
Test Files  1 passed (1)
     Tests  35 passed (35)
  Duration  1.20s
```

Both test commands exited 0. Existing tests include regressed draw-count and missing-observation
controls. These are harness/unit results, not real-device frame-rate measurements.

```text
pnpm profile:production -- --target fixture --control missing-marker --out artifacts/performance-strategy-discovery/missing-marker
"codes": ["TN_PROD_MARKER_MISSING"]
"status": "BLOCKED"
"exitCode": 2

node packages/runtime-native/scripts/profile-production.mjs --target fixture --control slow-path --out artifacts/performance-strategy-discovery/slow-path
"codes": ["TN_PROD_PERFORMANCE_BUDGET"]
"status": "FAIL"
"exitCode": 1
```

Observed process exits matched those values. Raw manifests are local at the named output paths
(`production-evidence.json`); fixture-negative-control provenance is explicit. These observed reds
prove missing-marker and synthetic-slowdown verdict paths; they do not prove live hardware
slowdown injection or all-platform sensitivity. Phase 3/5 require those additional controls.

Read-only GitHub probe: `gh run view 33981507785 --json jobs` plus `gh run list --workflow ci.yml`.
Successful run created `2026-09-05T17:36:53Z`, updated `2026-09-05T17:49:43Z`: 770 seconds.
Selected job start/end UTC: benchmark 17:42:31–17:43:20 (49s); test-native
17:39:47–17:45:17 (330s); build 17:41:03–17:41:38 (35s). The 250s before build started includes
scheduling/startup effects; it is not separately measured queue time. One run cannot establish p95.

UNVERIFIED: physical FPS, new baselines/noise limits, actual regression CI enforcement, native
Linux/Windows/macOS runs, physical Android workload, iOS simulator/physical workload, startup and
soak measurements. No GPU workload was launched during this discovery. Full typecheck/lint/test
were not run for this planning-only change; the four focused test files above were executed.


## Starter measured-load calibration — 2026-09-05

PRD-362's scaffolded starter used a build-only stress fixture: resolution scale 1, a 2560×1440
buffer, 30-frame reports, and existing high/medium Kuwahara radius 9 at full resolution. The
configured budget remained 60 FPS. A fixture hook restored both presets after observing low.
Measurements came from the real FrameBudget callback; no synthetic GPU times were supplied.

On headed NVIDIA/Turing WebGPU, the policy stepped high→medium→low but did not recover within
120 seconds. Two windows contained fresh GPU overload; other observations had GPU age six or
more renderer frames and correctly named the presented fallback. Low GPU cost fell, but this
was not sufficient to establish fresh recovery. The uncapped performance-browser flags instead
produced GPU ages in the hundreds and no eligible fresh-overload window. Headless Chromium
selected Google/SwiftShader and failed the hardware check before measuring. Three attempts
failed; no policy threshold was relaxed and no desktop FPS verdict is inferred.

The first two harnesses used fixed-step input, which suppressed subsequent live updates. The
harness was then corrected to real key holds and stronger startup, visibility, freshness and
recovery assertions; only its syntax check has run. The supported browser runner has no cadence
cap: `webgpu` selects hardware flags, performance mode removes pacing, and web `display.maxFps`
sets the scaler's budget rather than capping RAF. The assumption that this Xvfb/browser recipe
can provide suitable fresh timing for the recovery proof remains unresolved.

Native resource tests separately used synthetic windows and are not performance measurements.
Physical-phone 120-second browser/native floors, actual-load recovery and pinned-load behavior
remain UNVERIFIED. Exact local logs, build hashes, mutation results and commands are linked from
the [batch ledger](batch-2026-09-05-execution.md). No phone default is claimed from these desktop
observations.

## Native controlled-load rerun timing notes — 2026-09-05

The native reruns behind the [committed evidence](prd-362-native-load-2026-09-05/README.md) ran a
1920x1080 buffer under a private Xvfb, paid the Kuwahara radius-9 fixture load on the high and
medium presets only, and read GPU cost on every eligible window at age one frame. Their absolute
costs are unstable between runs at a fixed tier and buffer — the three passing normal runs at the
same configuration span several-fold — and one earlier normal rerun under a different Xvfb screen
setting oscillated instead of recovering. Both the differing setting and the differing timings are
observed; no causal link is claimed and the cause of the variation is unidentified. Frame rate on
this lane is dominated by Xvfb present behaviour and carries no meaning; the controller's only
input is GPU cost. None of this is a hardware performance claim, and no production threshold was
changed for it.

## Bayview startup after dependency repairs — 2026-09-07

The [working-build handoff](../PRDs/performance/PRD-360-FOLLOWUP-startup-performance.md)
records one physical Pixel 8 run: first frame 16,020.007 ms, pipeline compilation
8,404.781 ms across 93 calls, and frame-stall residual 4,917.275 ms. The retained
`artifacts/findings-fix/green-host-uninterrupted.log` also reports pump `maxGapMs:15708.693`.
These are single-run diagnostics, not a qualified three-run first-playable or correlated
pump acceptance result. APK and log identities are in the [repair proof](findings-2026-09-07-bayview-fix/proof.json).
PRD-360 remains PARTIAL; the next task is baseline attribution before a bounded optimization.

## PRD-360 Phase 1 retry checkpoint — 2026-09-08

This lane re-established the measurement provenance and ran the available fail-closed checks. It
did not reach a physical launch, so it claims no scheduler repair, launch timing, pump budget, or
acceptance result. The source PRD remains the authority for the required three-run phone protocol.

### Subject and artifact provenance

- Engine checkout: `76321e46d93f8ece59528315e83b17a644b7a77b`.
- Candidate Bayview checkout: `/home/joao/projects/threenative/sandbox/prd360-bayview-live`,
  `ef71572c59fdaf730e1c037fcba4129ef49876f6`. Its source, asset and package tree is untracked,
  so it is not a clean A/B subject and no performance number is attributed to it.
- Retained APKs `artifacts/experiment-3.apk` and `dist-native/fps-framework.apk` are byte-identical:
  SHA-256 `5f6ac0106868013437b97b00854e50ec69b8162187006cc2693378449b1855df`.
- Retained game bundle `.threenative/build/game.js`: SHA-256
  `b11c5753e1b7a4570dfb7e4bf176b52ebb59b89b73cbac9ea36332d69e33c7c0`.
- The bundle and APK are retained provenance only. The APK is not asserted to carry the current
  observer or to represent a cold-install candidate.

The engine dependency bootstrap `pnpm install --frozen-lockfile` completed in 4.6 seconds. The
repository build `pnpm build`, the playtest build
`pnpm --filter @threenative/playtest build`, and `node packages/playtest/dist/runner/cli.js doctor
--text` completed successfully. The doctor reported the expected missing `xcrun` warning; Node,
Playwright, Chromium, display and adb checks passed. Rebuilt package identities were recorded as:

```text
core       320ba88af5327d386ff42ea8e93e7b7c0b50234e30a2c13a72623d7617d240f5
assets     e66be010846febca72999eccc7ebed5c8bebcdb75fc9b305354cdc3c68d296ab
ui         788184bef642849a30baab1abe3a8443f390306a673bd9ec6455eed16a068d89
playtest   7c8d12185a12656384b934131561d128920e241c5a1140a5816e8e1a2904c233
create     565bdc999e2377aec098e8fd80ea0e1be42564b39730f55b72e8b40cabc378f1
```

### Checks that ran without a device

- The focused evaluator suites passed `18/18` tests.
- The staged validator at
  `artifacts/batch-2026-09-05/startup-repack-preparation/first-playable/` passed `32/32` cases,
  including movement, visible-world, pump-correlation, arm-identity, clock, runner, Android-target
  and preflight negative controls. This validates the evaluator; it is not game evidence.
- `node packages/runtime-native/scripts/measure-cold-start.mjs --desktop --launches 1` failed
  closed with `TN_COLD_START_LAUNCHES_INVALID`, as required for an invalid one-launch request.
- The Android measurement using the recorded serial `192.168.1.192:5555` failed closed with
  `TN_DEVICE_PREFLIGHT_NO_DEVICE`. `adb devices -l` was empty and the device was unreachable; no
  install, launch, first frame, movement or pump observation occurred.

The first native-runtime test attempt was setup-blocked by the unbuilt host and produced unrelated
build-dependent failures. After the opt-in V8 host, all V8 contract targets, and the QuickJS
cross-engine targets were built, the same package lane passed:

```text
Test Files  105 passed (105)
Tests  851 passed | 57 skipped (908)
packages/physics/__tests__/parity.spec.ts: 29 passed
Rust physics parity: 14 unit tests + 2 parity tests passed
publint: All good!
```

The repository gates then passed `pnpm typecheck`, `pnpm lint` (653 existing warning diagnostics,
no errors), `pnpm build`, `pnpm budgets`, and `pnpm test` (`406 passed, 2 skipped` files;
`4,658 passed, 8 skipped` tests). The Android retry still fails closed with
`TN_DEVICE_PREFLIGHT_NO_DEVICE`; no physical launch occurred. Phase 1 therefore remains open.
The next actionable step is to choose or rebuild a clean observer-carrying Bayview subject, then
rerun the prescribed three cold phone launches when a qualified device is reachable. See the
[PRD-360 protocol](../PRDs/performance/PRD-360-android-launch-is-playable-within-eight-seconds.md)
and the [tracked evaluator source](prd-360-startup-2026-09-05/validate-evaluator.mjs.txt).

## Performance loop — PRD-400

Phase 1 judge contract, recorded before any optimization candidate. No baseline, noise band, or
candidate verdict exists yet; AC-1 remains open. Measurements start only after the judge is frozen
and the machine is uncontended.

| id | contract item | pinned value or status |
| --- | --- | --- |
| L0-01 | Target | Native desktop frame p50 at 1280×720, sampleCount 4 on Midway, plus the attacked lane term; FPS is derived. Browser is a separate non-regression arm. |
| L0-02 | Judge | `pnpm bench:engines --arm tn-desktop --ladder 10000 --modes L1,L3 --repeats 3 --source-sha <sha>` for matrix attribution. Midway native gameplay is checked by its authored `native-playtests/launch.playtest.json` (flight status, airborne, altitude and IAS), then steady-state frame time is measured on a normal paced hardware window by the `measure-steady-state-fps` skill; web gameplay uses `playtests/flight.playtest.json` before its separate real-adapter window. `profile:production` remains the startup/transport diagnostic and scaffolded platformer holdout. The first native flight transport preflight stayed in `briefing` despite `PASS`; its accelerated playtest frame times are not an FPS baseline. Exact flags and scenario hashes remain to be frozen after live preflight. |
| L0-03 | Frozen evaluator paths | `scripts/engine-load-test/`, `examples/engine-load-test/src/{workload,game,main,native}.ts`, `examples/engine-load-test/vite.config.ts`, `packages/runtime-native/scripts/{profile-production,production-evidence}.mjs`, `packages/runtime-native/src/runtime.cpp` (host-gap meter), `packages/playtest/src/runner/{perf,config}.ts`, `packages/core/src/projection-marker.ts`, the selected playtest scenarios, their assertions, and performance budgets. A judge change re-baselines the lane. |
| L0-04 | Candidate surface | Lane 1: `packages/core/src/{renderProjection,projection-plan,projection-apply}.ts`; lane 2: `patches/three@0.185.1.patch`; lane 3: `packages/runtime-native/src/runtime-scripts/frame-op-stream.js` and `packages/runtime-native/src/webgpu/{bindings_frame_stream,bindings_commands}.cpp`. |
| L0-05 | Holdouts | Scaffolded platformer (`profile:production` default) and `sandbox/shadow-run` with `playtests/survives.playtest.json`, chosen before the first candidate. Neither is a tuning workload. |
| L0-06 | Baseline and noise | Midway source is frozen from sandbox commit `c277aee206fcbdd3d3a02a2404e47013f649d546` at ignored `sandbox/.afk/prd400-midway-source`; its config SHA-256 is `cf71be805566be3855428644596de180a6acfddeaadf088679e7156aaab1bd95`, native scenario `e1c534319d3c7729d9d9d2991a8b869b635900eea05e7a26b10cb10a2ef06793`, and web scenario `17c54ce65e369df0c78d1f281fcf17d2bf40e6697b7c726040b803c7106412ce`. Pending: engine baseline commit, native host hash, installed tarball hashes, machine state, and three A/A runs per metric. No performance claim until recorded. |
| L0-07 | Matrix discovery, not A/A | Engine `6c40029b3`, native host SHA-256 `f1bbab3ea986b083f8b9c125dff15e338cd289aae5ee629e65141085c682f4c0`, 10,000 objects, 1280×720, `L1,L3`, 3 repeats each. Mutation 0: L1 p50 by repeat 118.19/75.13/81.81 ms; L3 42.63/39.45/45.46 ms (`artifacts/engine-load-test/prd400-l0-u0.json`, SHA-256 `e29bf3cfcbe6dcf5d8bae3df22dc967e33a09d672656aca49cdf7692ddf624dd`). Mutation 0.01: L1 69.77/68.57/72.49 ms; L3 39.26/37.02/39.22 ms (`prd400-l0-u01.json`, SHA-256 `083f9263d31ab45d5e89f75b0c21101974ca4243e768c645095ab30cbd9bd8dc`). Identical position hash `992067d3`; L1 6,008 draws, L3 3 draws. The second arm ran later and was faster, so these values are discovery only; interleaved A/A and paced Midway baseline remain pending. |
| L0-08 | Midway native gameplay preflight, not FPS | Engine source `cfde451c71e6398eafe11bb2048172bca1bd4d3f` clean; ignored game snapshot `sandbox/.afk/prd400-midway-source`, unchanged `src`/`public` workload SHA-256 `a764771af3a8b96b2b5780cd4badb67050ae10656b7ba8df99cb0cb2dadf3ae8`; core tarball SHA-256 `934e6b39a94b18fe7d38fd5e380a64e0274477e4364e57dd1419a979673a102f`; Three patch SHA-256 `6bb97e8e730a8cf10433456a382a2701996c86bf4cc3a07e8f3e80e7c9b0c799`; native host SHA-256 `f1bbab3ea986b083f8b9c125dff15e338cd289aae5ee629e65141085c682f4c0`. `profile:production --target desktop --project ... --scenario native-playtests/launch.playtest.json --render-size 1280x720 --repetitions 1 --warmup 5 --duration 30` returned `PASS`, six assertions, no GPU errors, 785 accelerated samples (`artifacts/prd400/preflight-desktop-native-launch`). Snapshots reached `playing`, `airborne: true`, altitude 22 → 55, IAS 19 → 55; screenshot shows the plane above water. The accelerated frame values are not presented FPS. A normal paced hardware window and A/A repeats are pending. |
| L0-09 | Resolution-cut sensitivity, no GPU | Commit `accd8ca41` carries the authored native `resolutionScale` from the packaged config into the existing comparison identity. The pure comparator control returns `BLOCKED` for `auto` → `0.5` despite improved frame time, and `PASS` for `auto` → `auto` or matching numeric settings; focused production-profile 58/58 and comparator 18/18 pass. The packaged Midway config still reads `auto`. This proves the comparison rule, not a live candidate run; `slow-native` and full Phase 1 sensitivity remain open. |
| L0-10 | Matrix 100% mutation discovery, not A/A | Engine source `e029d37d4`, 10,000 objects, 1280×720, `L1,L3`, 3 repeats each and 480 scored frames per repeat. The CLI completed the workload but `--out` was given a path where it expected a name, so it failed to write its result; the host's saved `TN_BENCH_REPORT` was validated through `parseRunReport` and recovered as ignored `artifacts/engine-load-test/prd400-l0-u1.json` (SHA-256 `7a984cebc6a72c2bf2ac5dfdd79e729a942a40ca41ff91b972ad0fb98f73baae`). The default mutation rate was 1, whereas the planned A/A cell is 0 or 0.01. The producer collected `collapseMs` but omitted it from the report; that omission is fixed after this run. This record makes no noise or FPS claim. |
| L0-11 | Matrix 1% mutation A/A discovery under Xvfb | Engine `e697ca6adc7bead0d3eed40f710b0f1b75f3733e`, native host SHA-256 `f1bbab3ea986b083f8b9c125dff15e338cd289aae5ee629e65141085c682f4c0`; 10,000 objects, 1280×720, `L1,L3`, three identical process runs, three repeats and 480 scored frames per rung in each. All `positionHash` values are `992067d3`, L1 draws 6,008, L3 draws 3. Run-median frame p50: L1 65.564/63.306/64.901 ms (largest median difference 2.258 ms), L3 36.238/36.608/36.426 ms (0.370 ms). Frame p95: L1 70.473/69.462/71.124 ms (1.662 ms), L3 39.345/41.718/39.671 ms (2.373 ms). L3 projection `collapseMs` p50: 4.837/5.225/5.337 ms (0.500 ms). Reports `artifacts/engine-load-test/prd400-aa-u01-0{1,2,3}.json`, SHA-256 `af35929c28a7eba519d2b4a84d8a30c7aa0932f79c2232e94d6af8fbdb778064`, `23348cb89347715f4d598f932b5ea322991c52e447ec59de77408236e73353a1`, `4446f2fd1f963111aed3d0eaf63509cb074e8437b3249aa12752ce6d0dfb0a92`. These are virtual-display frame intervals, not presented FPS or a valid frame p50 baseline; the required render and host attribution is not in the report. |
| L0-12 | Matrix attribution probe | Direct native run of the same 1% mutation bundle under the repository Xvfb wrapper, ignored log `artifacts/engine-load-test/prd400-matrix-attribution.log` (SHA-256 `1f4dbf35e7ffad92dc7fc1f57632b481f923c86187dfd8292805dac60e22e497`). The full report marker arrived. `TN_HOST_GAP` appeared in five L1 and seven L3 windows; representative L1 period/replay/present p50 were 60.817/3.950/28.457 ms, and stable L3 windows reported period around 35.795–37.834 ms, replay 0.221–0.231 ms, present 28.916–29.338 ms. The first and last L3 windows crossed setup or external GPU activity and are excluded. There were zero `TN_FRAME_BUDGET` and zero `TN_PROJECTION` markers; `perf --file --require-windows 2` correctly returned `TN_PERF_WINDOWS_MISSING`. Segment medians cannot be added as a frame. Three.js CPU and recorder JS remain unnamed, so five-term 95% attribution is open. |
| L0-13 | Live slow-native sensitivity remains blocked | The scaffolded desktop-pair control with local native host, `--warmup 0.1`, `--duration 45`, and full source SHA produced `artifacts/prd400/control-slow-native-bounded/production-evidence.json` (SHA-256 `699af5db5e2f437ec08e5eade333896fe10972d7c04ea44606c9aff1aae8de12`). Native metrics include mean FPS 22.954 and p50 50.631 ms, and the budget rule fires, but status is `BLOCKED` with `TN_PROD_COMPARISON_METRICS_INCOMPLETE`: web has frame percentiles but no mean FPS, and its 120 samples span only 3.1955 seconds. The accelerated scaffold run did not produce the requested 45-second observation. This is not a sensitivity pass; the judge's sampling contract needs diagnosis before another control. |
| L0-14 | Paced slow-native control exposes native bridge limit | At clean commit `56ffe28b6714f80b9f5efcd8c7297cb424ce3b77`, the same control with a real-time synthetic workload produced `artifacts/prd400/control-slow-native-paced-fullsha/production-evidence.json` (SHA-256 `1bbb8d98e705409d8fd264e2cc45859bea9cf61699a9037d1f7d8aeaadae1279`). Web now has complete metrics over 48.548 seconds and 510 samples (mean 10.505 FPS), so the duplicate-presentation and accelerated-duration symptoms cleared. Desktop playtest returned `Device bridge payload exceeds 1000000 bytes`, leaving native metrics empty and status `BLOCKED` with `TN_PROD_PLAYTEST_FAILED` and incomplete comparison. This is not a sensitivity verdict; diagnose the bridge payload before another run. |
| L0-15 | Live slow-native control rejects with complete comparison | At clean commit `b619fe2371cdcaf9230460e42177de97fee260bc`, after making diagnostics-series snapshots opt-in without raising the 1 MB bridge limit, `profile:production --target desktop-pair --control slow-native --repetitions 1 --warmup 0.1 --duration 45` produced `artifacts/prd400/control-slow-native-bridge-guard/production-evidence.json` (SHA-256 `847cf09bb1e87a4ac0c74c724fecf854c9cd12fcf1758ebd50568b23584aa9c5`). Status `FAIL` (exit 1) carries only `TN_PROD_PERFORMANCE_BUDGET`; all three markers are present, both comparison arms have mean FPS and p50/p95/p99, and source is clean. Web window: 49.052 seconds, 540 samples; native p95/p99 46.923/70.025 ms exceed the declared 33 ms budgets. The packaged setting is still `resolutionScale: auto`. This is a live judge sensitivity control on a virtual display, not Midway presented-FPS evidence or a candidate win. |

| L0-16 | Opt-in host-gap frame detail, diagnostic only | Engine `2d8008a7e`, native host SHA-256 `528d5088b978c1b9c78be7267b13469d9f54f84101e8fd59c44a7477dd6c1d72`, 10,000-object L3 bundle SHA-256 `2732c5e94826ecc7e77a86c6ae1843009476e8496d99ab937e8bd3633876f7fc`, 1% mutation, 1280×720, Xvfb, no vsync. Ignored log `artifacts/engine-load-test/prd400-host-gap-detail.log` SHA-256 `78c8578c5f8c78f75833f292267f118a7a6f725ca1da3996b66477a4b2b4de2a` contains a complete bench report (`positionHash 992067d3`, L3 draws 3, 360 scored frames, frame p50 36.033 ms, projection p50 4.838 ms) and one parsed `TN_HOST_GAP` detail window of 300 frames. Each detailed sample has `frame`, `periodMs` and all 16 host segment times. For 299 adjacent frame IDs, the period ending at frame N joins post-rAF segments from N−1 with pre-rAF segments from N: mean period 35.601 ms, named host phases 28.907 ms (81.2%), residual 6.695 ms, zero negative residuals. The benchmark report finished, then the host stayed alive until the 70-second timeout; no process remained. This is virtual-display attribution discovery, not FPS. Three.js CPU, recorder JS, projection/host frame alignment and paced Midway remain unmeasured, so the 95% box stays open. |
| L0-17 | Midway numeric-resolution live setup, no A/B verdict | Engine `31f681d3c`, unchanged frozen Midway source and authored native scenario, Xvfb, 1280×720, one native desktop run per setting with the local host SHA-256 `528d5088b978c1b9c78be7267b13469d9f54f84101e8fd59c44a7477dd6c1d72`. `THREENATIVE_RUNTIME_BINARY` selected that host because the packaged v0.3.3 release lock URL returned 404. The frozen `auto` run produced `sandbox/.afk/prd400-midway-auto-corrected.json/production-evidence.json` SHA-256 `a39f3178d500024eda6bf92f317c9286fbe7bbf1a4f55a7daa4db6d3f376019f`; an isolated copy with only `resolutionScale: 0.5` produced `sandbox/.afk/prd400-midway-cut05-corrected.json/production-evidence.json` SHA-256 `994b1a933ba8027d339c4d3ebfec4584c30e929caa20425318d2b51fb037fa11`. Each profile exited 0, status `PASS`, clean source, all three required markers and authored native gameplay assertions; the identities record `resolutionScaleSetting` as `auto` and `0.5`. Both budgets are empty and each profile judges only itself. The A/B comparator requires observed hardware identity absent from these virtual-display records, so neither an A/B rejection nor presented FPS is claimed. The resolution-cut sensitivity box remains open. |
| L0-18 | Frame-clock join, diagnostic only | The opt-in `TN_HOST_GAP_DETAIL=1` sample now emits `rafTimestampMs` and wall `rafCallbacksMs`; the native matrix rung records the same rAF timestamp beside each scored `frameMs`, `stepMs` and `collapseMs`. Linked host SHA-256 `aae7d53524a1471f320320cd043c97616b7fd5d79ad424ac9ab8dc05f1fb5c49`, 10,000-object L3 bundle SHA-256 `4aacfcb0e523e269a89fa2aebcd66992f8ba703659888a72e8616b82e21451bb`, 1% mutation, 1280×720, Xvfb, no vsync. Ignored log `artifacts/engine-load-test/prd400-raf-join.log` SHA-256 `47922972dc7488670c76a2944a9be08ece1b3f6a3167970bd1e89d9ad2afa769` has a complete report (`positionHash 992067d3`, three draws, 360 scored frames) and 300 detailed host samples. Of those, 180 scored timestamps match exactly at millisecond precision. On 299 adjacent host frames, mean period 35.499 ms = previous frame's named post-rAF phases plus current pre-rAF phases 28.833 ms + previous frame's rAF callback dispatch 6.656 ms + residual 0.011 ms: 99.97% clock closure, zero negative residuals. On the 180 scored matches, host and benchmark frame intervals both average 36.204 ms; projection reconcile averages 4.856 ms within 5.045 ms game step and 6.582 ms callback dispatch. The benchmark report finished before the host's 90-second timeout; no process remained. Shared CPU activity and the virtual display invalidate FPS/noise claims. Callback dispatch combines Three.js, recorder and game work, so this is clock closure, not five-term attribution; that Phase 1 box stays open and the changed judge paths require a new baseline. |
| L0-19 | V8 JavaScript self-time sample, diagnostic only | A separate V8 host built with `TN_ANDROID_JS_PROFILE=ON` and `TN_JS_CPU_PROFILE=1` (SHA-256 `5615071ea60fa6c05f8d06e9404be881a12807a46d48cd9860bbc97586593fea`) ran the same 10,000-object L3 native bundle under Xvfb through its complete benchmark report, then exited after 490 screenshot-mode frames. The ignored compressed log `artifacts/engine-load-test/prd400-v8-jsprofile-490.log.gz` is SHA-256 `f74583e0b2f27db8093611339ac634b5a3963962efdb6b7cb4342b66ccb8efc1`. V8 reported 22,017 sampled self-time hits: named projection functions in the top 60 rows had 7,893 (35.85% of all hits), `updateMatrixWorld` had 3,442 (15.63%, callers not preserved in the flattened output), named `frame-op-stream.js` functions had 638 (2.90%, a lower bound), and `(native)`/`(idle)` rows had 7,792 (35.39%). The top 60 rows cover 99.01% of all hits. Profiling perturbs the frame, includes idle/native samples and does not preserve the caller of `updateMatrixWorld`; these percentages are not frame milliseconds or a five-term split. Recorder encode/reuse/upload work has no shared timing boundary with drain, so `frameDrainMs` is not total recorder JS. This points at projection as the first term to investigate once a paced baseline and uncontended measurement lane exist; no candidate or FPS verdict follows. |

| L0-20 | Real-display matrix A/A, partial baseline | After rebasing onto `develop` commit `44dbfdab4`, engine HEAD `9d03e58c782256f52d21d8f7ded1c32c04a1e6f4`, core rebuilt and its changed culling spec passed 17/17. Both active 1920×1080 outputs were 60 Hz; headed Chromium's empty-page control was 16.7 ms p50 / 16.8 ms p95 over 239 intervals with `nvidia / turing` WebGPU. The native 10,000-object L3 cell remained display-paced at 16.67 ms even with vsync off; a 40,000-object L3 cell exceeded that floor. Three real-display process runs used `TN_BENCH_DISPLAY=:0`, 1280×720, shared geometry/material, 1% mutation, 3 repeats each, 120 warmup and 480 scored frames per repeat, vsync off. Host SHA-256 `aae7d53524a1471f320320cd043c97616b7fd5d79ad424ac9ab8dc05f1fb5c49`; bundle SHA-256 `4c456a8729cac6ce7d9d31370c444de1b3bffececc4e497e4a09f7b93e39aded`; all position hashes `c5241193`, three draws. Run-median frame p50 was 26.975 / 26.650 / 28.258 ms (A/A band 1.608 ms), p95 32.369 / 32.115 / 32.977 ms (band 0.862 ms), and projection p50 22.589 / 22.310 / 23.800 ms (band 1.490 ms). Ignored reports `artifacts/engine-load-test/prd400-real-l3-40k-aa-0{1,2,3}.json` have SHA-256 `654d819f405854e8a537a9a208d3806533145eacb6faca4f6a2137f81b245874`, `e14f8d05451ed07445822e86284f4624578044ad5d1365bb01114289009eb035`, `da89b2989476aebce148c919af8b6822fc161de4c83996e8b1b402e5a95cee28`. This is uncapped matrix frame throughput on a real display, not presented Midway FPS. Midway and holdout A/A, five-term attribution, and the AC-1 iteration remain open. |
| L0-21 | Midway UI startup correction, no FPS | The frozen Midway game displayed its 3D deck but no HUD on the real Xwayland/NVIDIA desktop even though `TN_UI_OVERLAY` reported attachment; WebKit logged failed GBM buffers. With `WEBKIT_DISABLE_DMABUF_RENDERER=1`, the authored briefing UI and `TAKE THE DECK` button became visible. The rebuilt Linux overlay now applies that value by default unless explicitly set in the environment. Native desktop web-UI startup now exits 1 if the overlay cannot attach or its `tn:ready` intent is absent after 15 seconds; `--bypass-ui-loading` is an explicit scene diagnostic. The host rebuilt; the focused UI packaging spec passed 9/9 and the C++ platform test passed 1/1. Under Xvfb without a compositor, packed Midway logged `TN_UI_LOAD_FAILED` and exited 1; bypass ran until an 8-second external timeout without that error. Under Xvfb with xcompmgr, a deliberately no-ready page attached then exited 1 at the deadline; the real Midway UI attached and remained running past a 23-second external timeout without a load failure. These are startup checks, not presented FPS. All DRM connectors then reported disconnected during the live flight-input probe, so the paced Midway baseline remains open. |

Candidate rows (`L1-*`, `L2-*`, `L3-*`) begin after `L0-06` is measured. Rejected and inconclusive
candidates stay in this section with their measured values and commit ids.

## Performance loop — PRD-754

Recorded passes survive a camera turn. Judge: recording plus shadow encode CPU per frame (`TN_PLAYER_METRICS`,
`TN_RENDER_PREPARE_SPLIT`; web: the Wasm meter in a turn probe), paired knob off/on from one build, host load recorded.

| id | hypothesis | files | target: baseline → candidate (band) | other metrics | verdict | commit |
| --- | --- | --- | --- | --- | --- | --- |
| L1-01 | state-first opaque rows, persistent uniform slots, indirect counts; shadow/normal/velocity bundles | renderer.cpp/.h | Midway native 0.110/0.137/0.131 → 0.035/0.041/0.037 ms (load 4-13) | order rebuilds ~601 → 0; judge in L1-05 | keep | bcf00660c |
| L1-02 | transparent draws keep slot rows in a kept sequence | renderer.cpp | native shooter 0.153 → 0.151 ms (2 pairs) | main records 18k → 8k | reject (bookkeeping = savings) | b29914d5b, 11351dc0d |
| L1-03 | a destroy evicts rows only when it was bindable | gpu_resources.cpp | native shooter recorded rows 2 → 0 (test) | web unchanged | keep | f1c4403b8 |
| L1-04 | transparent draws record their own tail bundle; rows reuse last positions | renderer.cpp/.h | native shooter 0.142/0.143 → 0.115/0.116 ms (load 3-6) | Midway ratio unchanged (68%) | keep | 7f78a57f4 |
| L1-05 | Phase 3 at 7f78a57f4 | — | Midway 0.180 → 0.066 ms mean (63%); shooter web turn 0.516 → 0.211 ms (59%); gate 80% | judge NEUTRAL; frame p50 not shown | gate deferred | 7f78a57f4 |

