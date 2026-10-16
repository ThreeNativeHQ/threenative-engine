# PRD-617 — Every template runs on the native engine

**Status:** IN PROGRESS
**Priority:** P0 — the owner blocks the v1 release until AC-1 to AC-7 pass (Decisions, 2026-10-15); 11 of 13 templates, the starter among them, still pin `engine: "legacy"`.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** PRD-573 (PR #493 carries this work: native default, the `legacy` pins, the pin ratchet test, the CI engine artifact builds)

Recovery snapshots integrated into PR #493; publish-state tests: 46 passed. Runtime matrix and visual proof remain pending; no acceptance criteria are newly verified.

2026-10-15 reviewer input defect: the V8 player's playtest mailbox treated DOM `buttons` as
`button + 1`, misidentifying right/middle presses and every release. The pending fix tracks the
previous mouse mask and maps its changed bit to DOM `button`, preserving chord transitions and
touch contacts. `player-ui-input.mjs` now asserts actual canvas callbacks for right/middle
presses/releases, chords, unchanged/ambiguous masks and two touch contacts. Script syntax and
diff checks pass; Biome excludes this fixture. Runtime red reproduced against the existing
UI-enabled player SHA256 `43c490665a420539274469b9c050ae5ca1a51d4499f5c054fcbe362aa8a63d1f`:
right press reported button 1 instead of 2, middle press 3 instead of 1, releases 0 instead of
the released button (`/tmp/pr493-pointer-red.log`, exit 1). The shipped capture lock was held
and released. The same mailbox callback regression passed on rebuilt player SHA256
`ab5cbcc17223906fcacd70b4e9dd5b20e5331c2e0f31ab22ec7cf982ae881bdd`
(`/tmp/pr493-pointer-compute-green.log`); separate CTest results were real-input UI and compute
passed, compute-ops failed on duplicate sprite storage declarations. The UI-overlay presentation
test failed once at blue share 0 despite receiving its click intent, then passed unchanged on a
diagnostic rerun; its asynchronous presentation race remains under investigation.
No AC is ticked by this note.

2026-10-15 current-consumer replay: starter and snow web/desktop builds and installed/package artifact comparisons passed (player `5e40a3d5363c`, Wasm `490bfaa43d73`). Starter web movement passed; play failed frame-time P95 at 38.4 ms against 33 ms with no console errors. Production-readiness reached scene teardown and failed because native storage attributes lack `dispose()`. Snow web footsteps reached particle culling and failed because the Camera facade omitted its live projection conventions. These are engine issues; no game workaround or performance threshold change was made. Camera bindings now pass native ABI culling tests and rebuilds; a guarded Snow desktop survives replay passes all three assertions on rebuilt player `df34fb682d6d` with its unchanged game bundle. Fresh consumer-package/web replay, lifecycle repair and remaining qualification are pending. No acceptance box is newly verified.

2026-10-15 BufferAttribute synchronization: Snow's measured renderError (0.1227) came from native setters updating the engine while needsUpdate uploaded an older JS array. The facade now copies each setter's changed raw range back into the same JS array; retained game edits survive, copyAt synchronizes its source item, and bulk transforms synchronize their affected attributes. The private view API reuses the existing ABI, preserves scalar types, validates finite integer ranges, and retains exact-length validation for full writes. Repeated setters copy changed elements rather than the whole buffer (linear-cost regression). Verification: 203 unit tests, package typecheck, Biome and 31 document checks pass. Real ABI range/geometry checks pass in build/wasm; browser_gc passes. At that revision the complete browser_backend smoke failed at "Fn returns cached graph built once at definition", reproduced with unchanged HEAD source and smoke test; it was not a green smoke gate. The 2026-10-16 test correction below resolves that stale predicate. Visual judgment and paired CPU measurements remain unverified. No acceptance box is ticked.


2026-10-16 fresh consumer replay at `99e88c2bc`: both consumers were reinstalled from freshly packed local packages, rebuilt for web and desktop, and checked against producer/installed/packaged Wasm and player bytes. Snow web footsteps passes 9/9 assertions: renderError and colliderError are zero, six footsteps and 2.201 m movement observed. Starter web production-readiness passes 5/5, including collection, restart and entity teardown/respawn. Both ran headed hardware WebGPU on NVIDIA/Turing at 1280×720 with zero console, network or runtime diagnostics. The continued hardware replay passes all four desktop scenarios (starter react-hud/render-chain; Snow snow-physics/survives) and starter web movement/survives. Snow web production-performance fails: frame P95 94.2 ms against 33 ms and 18.62 FPS against 30. The capture used a private virtual display; these timings are diagnostic, not release performance qualification. The matrix stopped at that failure. A separate remainder run passes Snow web snow-physics/survives/touch-controls/weather and starter web play, giving 13/14 scenario passes overall. All five remainder cases used hardware NVIDIA/Turing; Snow ran at 1280×720 and starter play at 1920×1080. Snow performance, physical-display performance qualification, legacy visual comparison and paired CPU remain pending. Artifacts: /tmp/pr493-99e-matrix/ and /tmp/pr493-99e-browser-remainder/. No acceptance box is newly verified.

2026-10-16 Wasm smoke correction: the existing Fn contract builds a fresh graph per invocation. The smoke test now checks distinct valid graphs and invokes both previously uncalled scope-order/throw callbacks. The original scope order and error checks remain intact. The real Wasm browser_backend and browser_gc tests pass 2/2 in `build/wasm`; package typecheck, Biome, documentation links and 267 document/CI contract tests pass. This changes tests only, with no production runtime change.

Native coverage qualification (Linux): the official command now passes using separate instrumented legacy and owned-engine trees, with coverage-inspection CTests still executed for correctness. Results: 47 legacy targets, 323 profiled owned-engine tests and 23 reference checks; 80.60% total line coverage and 82.22% for src/engine/. The generated docs/verification/native-coverage-2026-08-28.md records source digest d53fe78e3ba8611050b7ecc1ae42f7a41fcd796ef3c4ef3df0e307f8656da7e6; all seven freshness tests pass, alongside 47 coverage-lane unit tests. Scope remains physics/UI OFF and engine player OFF; V8 player and other platforms are not coverage-qualified by this run. No acceptance box is newly verified.

Snow CPU candidate plan: Complexity: 1 → LOW; risk override: none. The captured browser profile attributes about 54% of main-thread self-time to native attribute dispatch, boxing and read-back under Heightfield.refreshGeometry. Hypothesis: bulk writes to validated plain Float32 position/normal attributes can remove at least 10 ms of the observed 37–51 ms render phase while retaining identical heights, normals, dirty windows and bounds; custom/interleaved/normalized attributes retain their setter path. Mutable files: packages/core/src/world.ts and its existing world-heightfield.spec.ts tests. Frozen judge: existing Snow game source/assets/scenarios, 1920×1080, 4× MSAA, hardware WebGPU, fixed quality and frame windows; baseline runtime artifacts remain installed in the original consumer. Before a keep, run three baseline A/A measurements, five interleaved baseline/candidate pairs, shared-path desktop/browser behavior checks and two captures per arm judged independently for no visible regression. Private-display comparisons use render/CPU timing only, never release FPS. The candidate passes 19 Heightfield tests, including numerical dirty-window/bounds checks and interleaved, normalized and custom-setter fallback, plus core typecheck; Biome reports no errors and two complexity warnings. Three unprofiled hardware-WebGPU baseline A/A runs measured steady render P50 53.4/47.1/45.4 ms (300 samples each), establishing an 8.0 ms noise band. The original consumer artifacts stayed byte-identical. Candidate packaging, five paired A/B runs, shared-path gameplay and visual judgment remain pending; no performance win or acceptance box is claimed.

2026-10-16 native deterministic screenshot final (no acceptance box ticked). Defect: after a native
`advance(render:true)` disables automatic RAF (`#driven = true`), a desktop screenshot request finds no
present, so `captureFrameScreenshot` never runs and the host times out. Implemented:
`FixedStepLoop.renderCurrentFrame()` calls `stepFrame(now, "render-only")` — an explicit mode that runs
the frame hooks and render, skips the frozen startup settle entirely, and leaves `#primePending` for the
next ordinary frame. It is exposed through an optional `IGamePluginRuntime.renderCurrent`, the bridge's
`renderOnly` operation and `runtime.renderOnly`; the native host endpoint forwards `renderOnly`;
`captureDeviceScreenshot` passes it to the desktop driver only for a counted desktop run, and the driver
invokes it once the host has consumed the request file so the copy flag exists. The host's 120-iteration
capture wait is now a bounded monotonic ~2 s budget; the 5 s map budget and image validation stay. Browser
behavior is unchanged (the browser capture never uses the operation).
Verification: all three new tests reproduced RED before the fix (core `renderCurrentFrame is not a
function`; `runtime.renderOnly` absent; driver render callback never fired) and pass after it —
`packages/core/__tests__/loop.spec.ts`, `packages/playtest/__tests__/three-bridge.spec.ts`,
`packages/playtest/__tests__/desktop-playtest.spec.ts` (including the end-to-end runner chain). Native:
the legacy player fixed the old timeout 3/3; the owned engine first returned an unknown `renderOnly`, so
the missing native-endpoint route was added, moving the native cases RED 2/4 → GREEN 4/4, and
`protocol_methods.inc` plus its generator were refreshed and the test registered. Zero-time RED: on a
freshly frozen loop with a pending startup settle the first attempt spent two ticks; the explicit
`render-only` mode keeps the pending prime for the next ordinary frame, and the focused regression
(`freezeClock(2)`, start, render-only then an ordinary frame) reproduced RED (`afterPhysics 2, tick 2,
updates 2`) and passes GREEN, with 73 loop/bridge tests passing. The false
`clearFrameScreenshotReady()` "drop late captures" line and comment were removed from the timeout branch.
Focused checks: laptop core/playtest units 5243 passed, 7 skipped (GitMCP excluded from the empty Git
lane); local 61 plugin/GitMCP passed; global `pnpm typecheck` passed and lint passed with warnings. The
full `pnpm test` stopped on native: 140 native specs, 11 failed, 1608 passed, 64 skipped (eight missing
test bins for V8+QuickJS, two stale SBOM receipts, one gradle-wrapper dependency-name parser); the
preexisting baseline is UNPROVEN. No full CI qualification is claimed.
Packaging: producer/core/playtest pack and installed artifacts are identical. All 15 frozen archives from
the capture-fixed cohort are byte-identical on the new routed cohort; only the owned C++ player changed,
via the existing builder override `d6953a29`; legacy `7e157d58` and Wasm `df3e` rebuilt unchanged; foreign
deps, game, assets and original scenarios are unchanged.
Visuals: the original native React HUD passed 3/3 on owned and legacy, with no screenshot advance
workaround. An additional visual scenario (only `setup.startTick` 128) ran four times (two per arm), 3/3
each, same end tick 328, on NVIDIA RTX2080/Turing at 1280×720 — 6 runs total, 18/18. Original startup
counts varied (261/270), so the explicit common pose anchor is for the visual capture only, not a new
default. A fresh read-only judge `/root/native_capture_routed_visual_judge` returned NEUTRAL for both
pairs and overall: geometry, materials, lights, shadows, sky and HUD preserved; static pose only, so
motion and flicker are not assessed. Figures: `/tmp/pr493-capture-routed-visual/compare1.png`,
`compare2.png`; proof: `/tmp/pr493-capture-routed-native-proof`; posting on PR #493 remains for the
parent lane.
Browser: the original owned browser render-chain replayed twice headed on hardware (6/6 each) on the new
core/playtest pack with the high guard; logs `/tmp/pr493-capture-fixed-browser-proof/{1,2}/report.stdout.log`.
The scenario's `capture.target` metadata says desktop, but the actual `page.screenshot`/browserArgs prove
it is the browser; do not mislabel it native.
Still open without acceptance ticks: the native high-quality render-chain and paired CPU; Snow's 33 ms P95
failure; the template matrix, coverage, CI and PGO.

## Context

On 2026-10-15 the owner made the native C++ engine the default (`engine: "native"`) for v1. On the
release branch the V8 engine bundler refuses 7 of 13 templates with `TN_NATIVE_ENGINE_UNBOUND`
imports, and the V8 player fails 4 more at runtime. Only minimal and puzzle run on the native engine.
Measured by the PRD-573 release lane on 2026-10-15.

Refused by the bundler (post and TSL imports):

| Template | Refused imports | Examples |
| --- | --- | --- |
| starter | 18 | `film`, `lut3D`, `traa`, `luminance`, `renderOutput`, `rtt`, `struct`, `wgslFn`, `DepthTexture`, `LUTCubeLoader` |
| snow | 6 | |
| rain | 4 | |
| shooter | 2 | |
| action-rpg, runner, sailing | 1 each | |

On the web Wasm engine the starter fails all three playtests with `TN_NATIVE_UNCATALOGUED_NODEPROXY`
(`FilmNode`, `Lut3DNode`, `TRAANode`).

Bundle clean, but fail on the V8 player (missing runtime bindings):

| Template | Runtime failure |
| --- | --- |
| platformer, tower-defense | `MeshStandardMaterial.flatShading` unbound |
| racing | `Mesh.computeBoundingSphere` unbound |
| rts | `TN_V8_FRAME_FAILED` on `updateRanges.push`, every frame | PRD-573 Phase v1.8 ("slice 8", not started) and its v1.5 known red
(native lowering of the LUT, grain and TAA stages) name the same gap.

The exact per-template list is the input of the pin ratchet test that PR #493 adds: it asserts that
each pinned template is still refused (bundler codes, or the recorded runtime failure for the four
runtime-pinned templates), and it fails with "remove the legacy pin from <template>" when one runs. Read that test for the full lists; do not re-measure.

Files inspected:

- `packages/runtime-native/scripts/bundle-native-engine.mjs` — `unboundDiagnostic()` (about line 76)
  refuses `three/addons/tsl/display/*` because "the native renderer currently consumes cooked post
  graphs", and refuses `three/tsl` names that the native graph does not bind.
- `packages/runtime-native/src/engine/player/core-addons.mjs` — binds `ao`, `denoise`, `smaa` and
  `bloom` as live native effects through `definePostEffects` from
  `packages/three-native/src/addons/post-effects.ts`, shared with the Wasm back end. Other display
  nodes refuse by name (`unsupportedExport`).
- `packages/runtime-native/src/engine/renderer/renderer.h` — the renderer already owns a native
  `TraaPass` (`setTraa`, about line 331) between the scene and output passes.

## Solution

Extend the existing live-effect path. Do not add a second post system.

1. For each refused display node (`film`, `lut3D`, `traa`, and the others in the ratchet lists),
   add a binding to `definePostEffects` backed by a native pass. `traa` maps to the existing
   `TraaPass`. `film` and `lut3D` need native passes; `LUTCubeLoader` needs a loader binding that
   delivers the 3D LUT texture to that pass. The same binding serves the V8 player and the Wasm back
   end, as for `bloom`.
2. Bind the refused `three/tsl` names (`luminance`, `renderOutput`, `rtt`, `struct`, `wgslFn` and the
   others in the lists) in the native graph, and `DepthTexture` in the V8 renderer bindings. A name
   that cannot be lowered keeps its named refusal; it is not stubbed.
3. Bind the missing runtime members (`MeshStandardMaterial.flatShading`, `Mesh.computeBoundingSphere`,
   `BufferAttribute.updateRanges`) in the V8 bindings. These are smaller than the post nodes and unblock
   four templates.
4. When a template runs, delete its `engine: "legacy"` pin in the same commit. The ratchet test
   enforces this.

Appearance is owned by the template (`src/render/`): the bindings carry every parameter from the game
and decide nothing about the look. Each un-pinned template needs a visual judge (AGENTS.md owner
rule), because the native passes must reproduce the legacy look.

Risk: `film` grain and TAA are temporal. Capture the judge poses after the history settles, with the
same frame count on both arms.

## Acceptance Criteria

AC-1 to AC-4 sit under Phase 1 and AC-5 to AC-7 under Phase 2, each with its proof.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Display post nodes on the native engine | Template `src/render/` import → `bundle-native-engine.mjs` → `core-addons.mjs` → `definePostEffects` → native pass | `unsupportedExport` refusal for each bound node is deleted | AC-1, AC-2, AC-5, AC-6 |
| TSL names on the native graph | Template TSL code → native graph binding | Named refusal in `unboundDiagnostic()` stays only for names that remain unbound | AC-1, AC-5 |
| Runtime members on the V8 player | Template code → V8 bindings (`flatShading`, `computeBoundingSphere`, `updateRanges`) | Runtime failure deleted | AC-5, AC-6 |
| Native default for every template | `threenative.config.ts` without `engine` | The eleven `engine: "legacy"` pins are deleted | AC-1, AC-5 (ratchet test) |

## Decisions

- 2026-10-15 (João): "We're not in a rush, sort this shit out. No need to go legacy." The native engine
  stays the default. A legacy default for v1 is rejected; do not propose it again. The `engine: "legacy"`
  pins are temporary debt, removed only after native proof on web and desktop; native-in-name with
  legacy-pinned templates is not the finished state. The v1 release stays blocked until every template
  passes the web and desktop matrix (startup, visible rendering, zero frame or runtime errors). This work
  runs on PR #493 (the epic), not after it.

## Execution Phases

#### Phase 1: The starter runs on the native engine
**Status:** NOT STARTED
**Files:** `packages/three-native/src/addons/post-effects.ts`, `packages/runtime-native/src/engine/player/core-addons.mjs`, the native pass sources under `packages/runtime-native/src/engine/renderer/`, the native TSL and V8 binding sources, `templates/starter/threenative.config.ts`.
**Implementation:** Bind the starter's 18 refused imports as in the Solution, starting with `traa` (the pass exists). Delete the starter pin when the ratchet test reports it clean.
**Verification:**
- [ ] AC-1 [local]: The starter bundles clean on the V8 engine bundler and its `legacy` pin is deleted. proof: the pin ratchet test from PR #493 — Evidence: pending.
- [ ] AC-2 [local]: The starter's template playtests pass on the native engine on desktop (`--target desktop`) and on the web Wasm engine. proof: `pnpm test:templates` (starter kit) and the starter scenario with `--target desktop` — Evidence: desktop half only, 2026-10-16 at f34bd6ade: the render-chain scenario passed 6/6 runs (3 owned V8 player, 3 legacy host, 6/6 assertions each, RTX 2080, 1280x720). Open: the web Wasm half (`test:templates` excludes the starter by design, so it needs its own scenario run).
- [ ] AC-3 [local]: A fresh judge subagent rates starter native against starter legacy NEUTRAL or IMPROVEMENT on desktop and web, with at least two runs per arm. proof: judge verdict on BEFORE/AFTER captures, `--browser-recipe webgpu`, `adapter.info` check — Evidence: desktop half only, 2026-10-16: a fresh Sonnet judge rated owned against legacy NEUTRAL on both run pairs at tick 789. Open: the web half.ed — Evidence: pending.
- [x] AC-4 [local]: Starter main-thread CPU per frame on native is at or below legacy on desktop, at the same pose and frame count. proof: playtest `perf --executable` paired runs, host load recorded — Evidence: 2026-10-16 at f34bd6ade, RTX 2080, Xvfb 1280x720, 1800-frame soak per run, order L,O,O,L then a load-gated L,O. The owned player runs its game loop off the process leader thread, so the game-thread figure is the busiest thread name, with same-named threads summed; for owned this adds its idle leader (about 2 ms), so the figure is conservative. Later runs read the per-thread `cpu.summary.busiestThread`. Busiest thread name ms/frame, runs in order L,O,O,L,L,O: 52.4 / 37.1 / 36.0 / 45.9 / 53.3 / 38.4. Process ms/frame: 54.4 / 38.0 / 36.7 / 48.4 / 54.9 / 39.5. load1 6.84 / 7.45 / 6.33 / 8.71 / 20.81 / 3.75; the fifth run (legacy) is flagged invalid-absolute by load, and owned is lower in every run including it. Two earlier runs at load1 18 and 58 were discarded. Both arms pay the Xvfb present path, so absolute values are not display-representative.

#### Phase 2: The other ten templates run on the native engine
**Status:** NOT STARTED
**Files:** the bindings that Phase 1 did not cover, the V8 runtime binding sources, and the ten template configs.
**Implementation:** Bind the three runtime members first (platformer, tower-defense, racing, rts), then each remaining refused import from the ratchet lists. Delete each pin when its template runs.
**Verification:**
- [ ] AC-5 [local]: Platformer, tower-defense, racing, rts, snow, rain, shooter, action-rpg, runner and sailing run on the V8 player and their `legacy` pins are deleted. proof: the pin ratchet test — Evidence: pending.
- [ ] AC-6 [local]: The playtests of those ten templates pass on the native engine. proof: `pnpm test:templates` for the six kits — Evidence: pending.
- [ ] AC-7 [local]: A fresh judge subagent rates each of the ten templates NEUTRAL or IMPROVEMENT against its legacy capture. proof: one judge verdict per template — Evidence: pending.

2026-10-16 Snow Heightfield candidate validation (`13b7733b5`): four desktop runs (two baseline, two candidate) passed all eight unchanged nonvisual footsteps assertions. The original full-frame 1280×720 `minNonblankPixelRatio: 0.01` guard was evaluated separately with the runner's exported `regionMetrics`; all four passed at 1.0. Desktop CLI still rejects `visual` assertions, so this is eight CLI assertions plus a separate identical pixel check, not nine CLI assertions. Four original browser footsteps runs also passed. Fresh read-only visual judge `/root/heightfield_visual_judge` inspected both pairs on both platforms and returned NEUTRAL for every pair and overall: no visible terrain, footprint, lighting, material or ground-contact regression. Native pair 2 differs by one simulation tick and slight settling/contact state; the judge found that this limits exact pose equivalence but does not prevent appearance assessment. Raw captures and BEFORE/AFTER comparison figures: `/tmp/pr493-heightfield-native-proof/`; posting figures on the PR remains pending. Five paired render measurements against the measured 8.0 ms A/A noise band are running; no performance acceptance is claimed yet.

2026-10-16 portable-test triage: the five affected files rerun on the desktop passed 253 tests and failed two. The remaining failures are stale expectations: the legacy-pin ratchet still lists 12 templates although recovered configs pin five, and the dev-watcher check assumes single-line formatting. Correcting those tests does not qualify any recovered pin removal. Racing, RTS, shooter and tower-defense still need fresh native/web matrix proof; starter's broader CPU/legacy comparison and Snow's performance qualification remain open. The laptop's Git-metadata and absent-Wasm fixture failures did not reproduce on the desktop.

2026-10-16 paired Snow render result: five valid interleaved pairs exceeded the 8.0 ms A/A noise band. Baseline/candidate render P50 (ms): 34.4/3.1, 34.9/3.2, 36.9/3.3, 35.1/3.4, and replacement 36.5/3.5; gains 31.3–33.6 ms (5/5). Original pair 3 was excluded because a three-second pre-push check overlapped it, and replaced without competing tests/builds. Each run retained hardware WebGPU, 1920×1080, four samples, 300 steady frames and unchanged source/scenario/artifact hashes; no nonperformance assertion failed. Candidate still fails the original maxFrameMsP95 threshold in every measured run (replacement 57.5 ms versus baseline 49 ms), so neither the complete Snow performance gate nor a tail-latency win is claimed. Private Xvfb supports the render-phase comparison only; release FPS and end-to-end qualification remain unproven. Logs: `/tmp/pr493-heightfield-paired/` and `/tmp/pr493-heightfield-replacement/`.

2026-10-16 stale-test repair verified: `pnpm exec vitest run packages/create-threenative/__tests__/config.spec.ts packages/create-threenative/__tests__/template-vite-plugins.spec.ts` passed 119/119 tests. Biome formatted the reduced legacy-pin list and checked both files with zero errors (one complexity warning). No template pin or runtime behavior changed.

2026-10-16 next bounded Snow experiment: the candidate CPU profile places 34.7% of sampled CPU time in native-render `writeBuffer` (baseline 0.6%), while Heightfield refresh self-time is 1.4%. Current bulk writes still mark full position/normal attributes dirty. Test the existing Three.js update-range mechanism for a windowed refresh, retaining prior pending ranges and recording a full range for an unbounded refresh so later windows cannot discard it. Engine layer: `packages/core/src/world.ts`; frozen Snow appearance and all original assertions remain required. Measure tail latency against the current bulk-write baseline with fresh A/A noise, five paired runs, unchanged 1920×1080/4×MSAA quality, native/browser proof and fresh visual judgment. Do not claim the writeBuffer profile proves GPU time or a causal tail fix before the experiment.

2026-10-16 recorded gate failures refreshed: current owned V8-player CTests `native_engine_player_compute` and `native_engine_player_compute_ops` both passed (2/2, 1.63 seconds total) under the explicit capture lease; the old compute-ops failure does not reproduce. The original Abyss streaming browser scenario reproduced one failing assertion, `hostRanDuringAttach`, with clean diagnostics. Cause was in the example probe: an unrelated queued timer can run after `scheduler.yield`'s prioritized continuation. The count-owed probe now uses the existing `yieldFrame` timer seam and sets its flag inside that host callback; an omitted yield hook still leaves it false. All original scenario assertions are unchanged. Fresh hardware WebGPU rerun passed 11/11, including a nontrivial false→true host-turn observation; focused Abyss TypeScript check passed. This repairs probe measurement, not engine scheduling. Logs: `/tmp/pr493-streaming-fresh.log`, `/tmp/pr493-streaming-fixed.log`, `/tmp/pr493-native-compute-fresh.log`.

2026-10-16 remaining-template web-build matrix: the laptop built all 11 remaining public templates with the frozen 15-package cohort (minimal, puzzle, platformer, rain, shooter, tower-defense, racing, action-rpg, runner, sailing, RTS), 11/11 successful. Legacy overrides applied only to generated rain/action-rpg/runner/sailing copies. This proves fresh scaffolding and native-config browser bundling, not runtime behavior or desktop execution. Source snapshot `244e4d1d2`, cohort content hash `20dd9e0e63f113316edcdbee5bc79c6dd2d3184abbb9f82e9273c531463dd8fd`; job `pr493-244-template-web`, logs fetched to `/tmp/pr493-template-matrix-244/`.

2026-10-16 Heightfield upload-range experiment: the two new range-contract tests reproduced empty update ranges before the fix; all 21 Heightfield tests passed afterward, core typecheck passed, and Biome reported zero errors/two complexity warnings. The candidate appends the touched scalar span only for the existing plain-Float32 fast path and retains prior/full pending coverage. No gameplay, appearance, quality or fallback-layout change is intended. Package rebuild, fresh native/browser proof, visual judgment and tail-latency measurements remain pending; this candidate is not yet accepted.

2026-10-16 fresh range-candidate proof: two baseline/two candidate native footsteps runs each passed eight logical assertions plus the separately evaluated unchanged full-frame pixel guard; two baseline/two candidate browser runs each passed the original nine assertions. Frozen consumer source/assets/scenarios/config, Wasm/player and before/after manifests matched. Fresh read-only judge `/root/heightfield_ranges_visual_judge` returned NEUTRAL for each of four comparison pairs and overall, with no visible terrain, footprint, material, lighting, contact or HUD regression. Native baseline run 2 differs only at the leftmost image column; the judge found no scene-assessment limitation. Figures and raw captures: `/tmp/pr493-range-native-proof/`; PR posting is pending. The three-A/A/five-pair tail-latency experiment is running; no tail win is claimed yet.

2026-10-16 desktop bundle matrix stopped on its first failure: minimal, puzzle and platformer built (3/11); rain failed with `TN_NATIVE_ENGINE_UNBOUND: three/webgpu:PassNode` because the V8 renderer lacks required render-target/fullscreen/node-lifecycle bindings. The eight later builds remain pending, not skipped as completed. Logs: `/tmp/pr493-template-matrix-244/desktop-logs/`, status: `desktop-status.json`. Repository legacy pins remain unchanged.

2026-10-16 legacy browser comparisons: Snow passed all 36 assertions across two runs per engine. Starter passed 21/24 assertions; three `renderChain.tier` guards expected high but observed medium (one legacy and both owned runs). Fresh visual judge `/root/legacy_browser_visual_judge` returned NEUTRAL for all four comparison pairs, but starter pair 2 used unequal tiers, so equal-quality starter qualification remains open. Diagnostics attribute the downgrade to stale GPU timing falling back to presented P95 with a 51.5 ms host-gap P95 despite 3.1 ms render P95 and a 15.48 ms GPU observation; the adaptive fallback needs investigation, not a weaker guard. Captures: `/tmp/pr493-legacy-visual-browser/`.

2026-10-16 range experiment REJECTED: three bulk-baseline A/A runs measured render-P95 noise 2.3 ms and median noise 0.4 ms. All five paired range candidates regressed render P95 by 19.0/20.7/21.5/38.9/19.6 ms (0/5 wins), with median render P50 +0.7 ms outside noise. All 13 runs retained hardware/1920×1080/4×MSAA/300 steady samples, frozen hashes, unchanged original thresholds and clean nonperformance assertions. The original 33 ms frame-P95 gate passed 0/13. Despite passing gameplay and NEUTRAL visual judgment, the range implementation and its two added tests are reverted; the earlier measured bulk-write implementation remains. Temporary experiment packages/captures are preserved for diagnosis, but producer core/playtest dist must be rebuilt from the reverted source before a new cohort is packed. Results: `/tmp/pr493-range-perf/summary.json`.

2026-10-16 starter fallback repair plan: keep fresh GPU decisions unchanged. When the latest GPU resolve is stale but the completed window contains a valid GPU series, use the maximum of that window's GPU median and own-frame P95; those measurements exclude unrelated host gaps. Report the fallback honestly as measured work. With no usable GPU-window series, preserve the existing presented fallback. Regressions must distinguish a cheap host-stalled window from real lagged GPU and real own-CPU overload; do not force a tier or weaken the high-tier guard. Scope is generated starter rendering source plus its existing quality tests, followed by fresh unchanged legacy/owned render-chain captures.

2026-10-16 starter adaptive-fallback implementation: three new regressions reproduced the old behavior, then all 46 template-quality tests passed. A usable completed-window GPU series now selects the maximum of own-frame P95 and GPU median when the latest resolve is unavailable/stale; logs name `meter=work`. Fresh-GPU and no-series presented policies remain unchanged. Tests retain high for the captured cheap-but-host-stalled window and still downgrade for real GPU or own-CPU overload. The existing starter `game.ts` already forwards the entire completed window through `observeQualityWindow`, including its GPU series; no additional caller wiring is needed. The create-threenative typecheck passed. Fresh generated consumers, gameplay and equal-quality legacy/native visuals remain pending. Minimal's fresh frozen-cohort browser scenarios passed 4/4 (22/22 assertions), without artifact drift; its desktop runtime remains unverified.

2026-10-16 desktop failure diagnostics: the new regression reproduced a screenshot error hidden by a simultaneous cleanup failure. The shared device runner now retains both AggregateError entries and includes the primary message; desktop and failure-evidence tests pass 64/64. This improves diagnosis only: legacy screenshot capture and paired CPU remain unverified. Fresh starter owned-browser replay still fails the unchanged high-tier guard. Unlike the legacy capture, owned windows contain no GPU timing series; investigation identifies missing owned Wasm timestamp bindings. No acceptance box is newly verified.

2026-10-16 owned-browser GPU timing repair: the Wasm device now negotiates timestamp-query when supported, enables the existing renderer timer, and exports completed duration, sample count, original submitted frame ID and timer availability. The facade feeds the existing core sampler; delayed callbacks retain their source frame instead of their arrival frame. Two red-green regressions cover missing bindings and delayed/equal-duration samples; all 10 focused tests and three-native typecheck pass. The Wasm build passes after correcting a local parameter-name collision. Fresh producer/tarball/installed/bundled Wasm bytes match. Original Starter render-chain browser scenarios pass 6/6 twice on hardware NVIDIA/Turing at 1280×720, retaining high tier with zero diagnostics. Completed GPU windows contain approximately 100 samples, 13.33/13.39 ms latest timings and four-frame age. Artifacts: /tmp/pr493-starter-gpu-timing-proof/. Equal-quality legacy visual judgement and paired CPU remain pending; no acceptance box is newly verified.

2026-10-16 equal-quality Starter browser comparison: both refreshed legacy runs pass all 12 original assertions at high tier, matching both owned runs at high tier (24/24 across the four runs). All captures are headed hardware NVIDIA/Turing, 1280×720, same scenario and pose. Fresh read-only judge /root/starter_equal_quality_visual_judge returns NEUTRAL for both pairs and overall: appearance-preservation passes, with only slight platform-edge raster differences and no visible material, lighting, shadow, fog, exposure, postprocessing or HUD regression. Static images do not establish temporal AA/flicker behavior. Figures: /tmp/pr493-starter-equal-quality-visual/compare1.png and compare2.png; raw images retained in /tmp/pr493-legacy-quality-proof-headed/ and /tmp/pr493-starter-gpu-timing-proof/. The earlier lock-timeout run and software-adapter invocation are excluded; the latter omitted --headed and failed diagnostics. Native legacy screenshot capture and paired CPU remain open; no acceptance box is newly verified.

2026-10-16 Snow fresh timing replay: source/assets/scenarios match the original and kept bulk baseline, and producer/tarball/installed/bundled Wasm all match df3a6e53e27e4c88a9a5cab0366017b6eee2456fbfb5c1c35081854daa644236. The original production-performance scenario passes 5/6 assertions over 759 samples: 57.8 FPS against 30, 122 draw calls against 160, 889642 triangles against 1000000, zero diagnostics. Frame P95 remains failed at 55.1 ms against 33 ms. Hardware NVIDIA/Turing, headed private Xvfb: diagnostic capture, not release FPS qualification. Artifacts: /tmp/pr493-snow-timing-proof/run1/. Timing attribution remains pending; no acceptance box is newly verified.

2026-10-16 Snow tail attribution: resolved GPU P95 is 5.34 ms, while own-render P95 is 49.6 ms. Performance-series interval measurements lag phase costs by one row: joining each interval to the previous row explains 106/114 intervals over 33 ms, correlation 0.922 and residual P95 10.8 ms. Example: seq577 renders for 49.6 ms, then seq578 reports a 55.1 ms interval. This supports renderer CPU/wait attribution, not a compositor-only explanation. The original scenario viewport is 1920×1080; it was not changed. Sparse GPU samples do not exclude all GPU spikes. Fresh CPU profiling is pending before another source change.

2026-10-16 fresh Snow CPU profile: /tmp/pr493-snow-timing-cpu-profile/snow.cpuprofile contains 13390 valid samples across 14.23 s on hardware NVIDIA/Turing at the original 1920×1080. Browser-native writeBuffer accounts for 4863 ms (34.2% of wall samples), versus idle 26.3%, Wasm aggregate 10.05%, GC 0.72% and onSubmittedWorkDone 1.3%. Upload cost persists in all thirds (1.11/1.97/1.78 s), including steady gameplay. Leading ancestry is native writeBuffer through the Wasm render path; the separately named heightfield/Wasm function is 1.7%. This supports inspecting buffer uploads before another terrain-update change. The instrumented run is diagnostic, not a speed verdict; unnamed Wasm/browser-native internals limit resolution. No acceptance box is newly verified.

2026-10-16 upload probe and coalescing candidate REJECTED: temporary diagnostic Snow copy measures 398–438 MB and 2466–3024 queue writes per three-second steady window (133–146 MB/s); large writes carry nearly all bytes. No full-Wasm-heap copy was observed. The 401×401 position/normal buffers and two-channel Snow state are dynamic; the two-channel buffer is not evidence of redundant static UV uploads. Existing BufferStore ranges append independently and GeometryCache uploads each separately. A candidate coalesces overlapping/nested/adjacent existing ranges before upload, retaining disjoint gaps and the single-range fast path. The focused native regression reproduced five writes/136 bytes instead of two/120, then passed with exact full readback after the fix (red then green, native_engine_renderer_geometry_cache 1/1, 0.26 s). Wasm build passes. Baseline Snow footsteps captures pass 9/9 twice on NVIDIA/Turing at 1280×720, and a fresh visual judge returns NEUTRAL for both pairs. The frozen 13-run paired cohort (render-P95 AA noise 2.5 ms) records only 2/5 tail wins beyond noise at 5.3/1.1/0.5/2.9/1.0 ms against the required 5/5, and the original 33 ms frame-P95 gate passes 0/13; speed failed. The coalescing source and its regression test are reverted to HEAD; experiment artifacts remain outside the repo; no speed claim is made. Broad acceptance boxes remain open. Results: `/tmp/pr493-coalesce-perf/summary.json`.

2026-10-16 Starter antialias on the legacy native host, without a three.js patch. Cause: three.js
`SMAANode` constructs `Image` for its two embedded PNG lookup tables, and the native host had no
`Image`, so the legacy quality path dropped antialias (`build: Image is not defined`). A first repair
patched three.js; it was rejected under the three-patch-last-resort rule and reverted. The fix is a
host `Image` shim (`image-bitmap-polyfill.js`, recorded in `shim-manifest.json`) that loads `src`
through `fetch` and `createImageBitmap`, plus standard `data:` URL decoding in `fetch-polyfill.js`.
- Unit: `image-bitmap-polyfill`, `runtime-next-contract`, `fetch-shim` 74 pass, 1 skip;
  `check-native-shims` passes. `mystral-runtime` now exports the Linux link policy, so both QuickJS
  test targets link.
- Native, stock three.js consumer cohort (core tgz `8706ddca…`, legacy host `07d53635…`, owned player
  `d6953a29…`), original render-chain scenario plus two same-pose repeats per arm: 6/6 runs pass,
  6/6 assertions each, tier high, antialias applied and not dropped, zero diagnostics, NVIDIA RTX 2080
  1280×720. Legacy logs both SMAA textures (66×33, 160×560).
Not claimed: browser rebuild, visual judge, paired CPU (AC-3, AC-4 stay open).
