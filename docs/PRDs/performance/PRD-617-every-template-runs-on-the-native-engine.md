# PRD-617 — Every template runs on the native engine

**Status:** IN PROGRESS
**Priority:** P0 — the owner blocks the v1 release until AC-1 to AC-7 pass (Decisions, 2026-10-15); 11 of 13 templates, the starter among them, still pin `engine: "legacy"`.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** PRD-573 (PR #493 carries this work: native default, the `legacy` pins, the pin ratchet test, the CI engine artifact builds)

Recovery snapshots integrated into PR #493; publish-state tests: 46 passed. Runtime matrix and visual proof remain pending; no acceptance criteria are newly verified.

2026-10-16 GPU timer correction (engine layer; Complexity: 1 → LOW; risk override: none).
Tempest's reported 39.7 ms excluded offscreen work from the 44.3 ms per-pass sum, including a
1152×648 cloud pass of about 4.3 ms. Bounded plan: share timestamp collection with secondary,
render-target and probe renderers; instrument every scene, shadow, post, TRAA, mip and compute
pass; resolve and sum complete timestamp pairs once at the owning frame boundary. Keep timing
opt-in, asynchronous, source-tagged and fail-closed. Integration is unchanged: web frame selector 7
and the V8 player still consume Renderer::lastGpuMs().
The new native_engine_gpu_timer_covers_offscreen case reproduced RED on the original timer:
immediate and deferred targets both failed the resolved-pair assertion. GREEN: the same case now
resolves four render-pass pairs (offscreen scene/output and main scene/output), checks nonzero
offscreen attribution and the total, and separately checks a compute encoder plus main frame
resolves three pairs. All three focused GPU timer CTests pass headlessly on NVIDIA RTX 2080/Vulkan.
The explicit native tests/render-driver/V8-player targets and Wasm preset build successfully.
The requested native-engine suite completed: 407/409 passed. Its TRAA source-order assertion
searched for the old raw pass-begin spelling; updated to the timed wrapper, it now passes alongside
all three timer cases (4/4 focused). The remaining registry snapshot failure is pre-existing:
HEAD bindings expose Scene.fogNode's getter while HEAD's native-registry.json omits it; that is the
only generated-dump difference. The unrelated snapshot is unchanged. No release or visual
acceptance box is ticked by this instrumentation fix.

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
- [x] AC-1 [local]: The starter bundles clean on the V8 engine bundler and its `legacy` pin is deleted. proof: the pin ratchet test from PR #493 — Evidence: 2026-10-16: `config.spec.ts` passes 112/112; `LEGACY_PINNED_TEMPLATES` lists only action-rpg, rain, runner, sailing and snow, and the starter's `threenative.config.ts` sets no `engine`. Its V8 engine bundle built and ran in the six desktop render-chain runs recorded under AC-2.
- [x] AC-2 [local]: The starter's template playtests pass on the native engine on desktop (`--target desktop`) and on the web Wasm engine. proof: `pnpm test:templates` (starter kit) and the starter scenario with `--target desktop` — Evidence: desktop half, 2026-10-16 at f34bd6ade (the owned player was built from f34bd6ade plus then-uncommitted additive binding edits, the `Matrix4.setPosition(x,y,z)` overload and TSL `setGroup` on textures, `notEqual` and swizzle `assign`, all of which landed in ad3d21181; the starter calls none of them): the render-chain scenario passed 6/6 runs (3 owned V8 player, 3 legacy host, 6/6 assertions each, RTX 2080, 1280x720). Web half, 2026-10-16 at ad3d21181: the four starter template playtests pass on the web Wasm engine, headed with `--browser-recipe webgpu` (movement 7/7, play 8/8, production-readiness 5/5, survives 6/6; adapter.info vendor nvidia, architecture turing, discrete). `test:templates` skips the starter by design, so each scenario ran through the playtest CLI against a `build:web` preview.
- [x] AC-3 [local]: A fresh judge subagent rates starter native against starter legacy NEUTRAL or IMPROVEMENT on desktop and web, with at least two runs per arm. proof: judge verdict on BEFORE/AFTER captures, `--browser-recipe webgpu`, `adapter.info` check — Evidence: desktop half only, 2026-10-16: a fresh Sonnet judge rated owned against legacy NEUTRAL on both run pairs at tick 789. Web half, 2026-10-16 at ad3d21181: a fresh Sonnet judge rated the Wasm engine against stock three NEUTRAL on both pairs (tick 789, 1280x720, RTX 2080 WebGPU; each arm's two runs match). The visible engine differences are a stronger specular on the blue cube, crisper normal-map tile lines, and a horizon haze band (rows 118-150) 7% lighter: lightness 0.605 vs 0.562, near-gray in both. The upper sky measures identical. Images and verdict: `starter-web-2026-10-16/` on the `prd617-screenshots` branch.ed — Evidence: pending.
- [x] AC-4 [local]: Starter main-thread CPU per frame on native is at or below legacy on desktop, at the same pose and frame count. proof: playtest `perf --executable` paired runs, host load recorded — Evidence: 2026-10-16 at f34bd6ade (the owned player was built from f34bd6ade plus then-uncommitted additive binding edits, the `Matrix4.setPosition(x,y,z)` overload and TSL `setGroup` on textures, `notEqual` and swizzle `assign`, all of which landed in ad3d21181; the starter calls none of them), RTX 2080, Xvfb 1280x720, 1800-frame soak per run, order L,O,O,L then a load-gated L,O. The owned player runs its game loop off the process leader thread, so the game-thread figure is the busiest thread name, with same-named threads summed; for owned this adds its idle leader (about 2 ms), so the figure is conservative. Later runs read the per-thread `cpu.summary.busiestThread`. Busiest thread name ms/frame, runs in order L,O,O,L,L,O: 52.4 / 37.1 / 36.0 / 45.9 / 53.3 / 38.4. Process ms/frame: 54.4 / 38.0 / 36.7 / 48.4 / 54.9 / 39.5. load1 6.84 / 7.45 / 6.33 / 8.71 / 20.81 / 3.75; the fifth run (legacy) is flagged invalid-absolute by load, and owned is lower in every run including it. Two earlier runs at load1 18 and 58 were discarded. Both arms pay the Xvfb present path, so absolute values are not display-representative.

#### Phase 2: The other ten templates run on the native engine
**Status:** NOT STARTED
**Files:** the bindings that Phase 1 did not cover, the V8 runtime binding sources, and the ten template configs.
**Implementation:** Bind the three runtime members first (platformer, tower-defense, racing, rts), then each remaining refused import from the ratchet lists. Delete each pin when its template runs.
**Verification:**
- [ ] AC-5 [local]: Platformer, tower-defense, racing, rts, snow, rain, shooter, action-rpg, runner and sailing run on the V8 player and their `legacy` pins are deleted. proof: the pin ratchet test — Evidence: partial, 2026-11-02 at 0f260c498. The pins of action-rpg, runner and sailing are deleted and `LEGACY_PINNED_TEMPLATES` is `["snow"]`; `config.spec.ts` passes 114/114. Those three bundle clean on the native bundler, publish a desktop artifact and boot headless on the V8 player with `TN_PLAYER_V8_GAME_CHECK: engine=native gameRuntime=v8 startup=passed`. Open: the snow pin (PRD-620), and no V8-player run for platformer, tower-defense, racing, rts, rain and shooter.
- [ ] AC-6 [local]: The playtests of those ten templates pass on the native engine. proof: `pnpm test:templates` for the six kits — Evidence: partial, 2026-11-02 web Wasm half at 0f260c498 on NVIDIA RTX 2080 (nvidia/turing, headed private Xvfb): action-rpg 10/10 scenarios, sailing 8/8 after the `Renderer::planAux` fix, runner 4/5 (`production-performance` draws 47,924 triangles against the 45,000 bound; the legacy arm draws 34,967 and the excess is in the shadow pass — 18,544 triangles in 4 draws against 3,600 in 1 — root cause open, threshold unchanged). platformer 17/18 and tower-defense 11/12; their `production-performance` failures also happen on the legacy engine (platformer legacy: at most 193,822 triangles against native 190,005, p95 21.2 ms against native 19.54 ms) or are GPU-bound at 17.53 ms against 16.7 (tower-defense, legacy arm not measured). Desktop targets and racing, rts, rain and shooter are not run. Earlier evidence, 2026-10-16, 2026-10-16, web Wasm engine with pins removed in a laptop lane (Intel gen-12lp): the silent boot hang was the runner dropping the page's throw; it now names it. Fixing the three-API gaps each throw named lets sailing pass 8/8. Runner passes 2/3 (production-performance p95 93 ms > 33 ms) and shooter 31/34 (performance p95 242 ms; debug-ads optic y and input-control trivial assertion undiagnosed). Rain boots, then fails at the first lightning bolt with `TN_WASM_DEVICE_ERROR` dynamic-offset mismatch, a stale bind-group handle in the C++ renderer. `TN_discrete_lod` is skipped on the Wasm engine with `TN_DISCRETE_LOD_UNAVAILABLE`, so ships lose auto LOD there until the engine glTF loader reads the extension. Desktop native and NVIDIA web are not run for these four. Update 2026-10-16, web Wasm engine on the desktop RTX 2080 (nvidia/turing, private Xvfb, headed): `TN_discrete_lod` now runs on the engine glTF loader (the skip is deleted; a broken chain rejects the load). Rain's four visual defects (red or black conifers, red glow, weak haze, no rain streaks) were engine bugs: a Fn body lowered at every use, a bloom bind group on a stale post view, `screenSize` absent from the vertex block, and no `depthNode`. Each has a RED/GREEN engine test. A fresh judge rates two runs per arm NEUTRAL against develop on all four, with one systematic minor difference: the ridge tree layout and scale. Rain on Wasm passes 14/16 scenarios; `lightning` (`thunderVoices`) fails on both engines, and `performance` loses the device (`TN_WASM_DEVICE_LOST`) under `--disable-frame-rate-limit`. Paired x3, rain GPU time is 113.6 ms on Wasm against 43.5 ms on legacy, CPU equal; reflections explain about 14 ms. Snow misses frame P95 <= 33 ms on both engines (Wasm 80.8 ms, legacy 54.5 ms). Action-rpg on Wasm passes 7/8; performance exceeds the triangle budget (193,406 > 185,000) by the mannequin's 13,744 triangles. The rain and action-rpg pins that were there then are gone: both run on the native engine, and their sweeps are recorded below. Only snow stays pinned (`LEGACY_PINNED_TEMPLATES` in `packages/create-threenative/__tests__/config.spec.ts`), because the native engine does not bind the imports its `threenative.config.ts` names. 2026-11-03 (lane goal-617-runner): the runner's remaining 47,924 triangles are one engine bug — a `SkinnedMesh` was never culled out of a shadow pass — and it is fixed in `packages/runtime-native` (`RenderDatabase::boundingSphereOf` answers a rig's sphere from `boneReachBounds`; CTest `skinned_shadow_caster_frustum_culling` RED then GREEN). With the fix the runner's native arm draws 34,180 triangles at the steady pose against legacy's 34,967, and the gate's remaining 47,924 is the first ~1.1 s, where the rails, the rig and one obstacle chunk are all inside the template's static sun box — a pose the legacy arm also draws (18,544 in 4 shadow draws) but no longer samples. Runner keeps its pin until the template's sun follows the runner: see the 2026-11-03 block below. Update 2026-11-03 (lane goal-617-v8, `3395f2752`, NVIDIA RTX 2080 nvidia/turing, private Xvfb, headed WebGPU, load average 8-18 from other lanes): the web half of the four remaining kits ran through `TN_TEMPLATE_ONLY=<kit> pnpm test:templates` against the Wasm engine built from this tree (`pnpm wasm:build`): racing 11/11, rts 9/9, shooter 38/38 (the earlier page crash did not recur), rain 15/16. The one miss, `rain-production-performance` (`performance.maxFrameMsP95` 21.24 ms against 16.7; GPU 21.24, CPU 0.81, 15 GPU samples, 1024 frames), is not a native regression: the same scenario on the same kit with `engine: "threejs"` fails the same bound in paired runs (legacy 20.01 and 19.62 ms against native 24.69 and 20.21 ms), and the private display's own interval p95 is 17.4-17.58 ms, already above the bound. Kit contract rows: racing, rts and shooter ok on every declared row, rain 5 ok and 4 opt-outs (one earlier `no-hitch` `TN_PLAYTEST_PERF_FEW_GPU_SAMPLES` did not recur on the quieter rerun). Rain's `native-playtests/lightning` now passes on the desktop V8 player: the template publishes the host's reduced-motion answer and the scenario asserts the branch the host reported, so `audio.thunder` is observed once (gap 2411 ms) instead of zero. Still open for this box, and outside this round's four kits: platformer 17/18 and tower-defense 11/12 (performance bounds; platformer's proven on the legacy engine, tower-defense has no legacy arm) and runner 4/5 (47,924 triangles against the 45,000 bound, the shadow pass's batched world and LOD-pair casters named as the mechanism and not proven non-native). AC-6 stays open on those three.
- [ ] AC-7 [local]: A fresh judge subagent rates each of the ten templates NEUTRAL or IMPROVEMENT against its legacy capture. proof: one judge verdict per template — Evidence: captures ready, verdict pending. 2026-11-02: two same-pose runs per arm (legacy `engine: "threejs"` against the native Wasm back end) for action-rpg, runner and sailing, NVIDIA RTX 2080 (nvidia/turing), 1280x720, in `~/.cache/tmp-tn/prd-goal-1102/captures/617/<template>/{legacy,native}/run{1,2}/after.png`.
; 2026-11-02 SSGI lowering (lane 617-ssgi): the owned engine dropped three's occlusion term. three's SSGINode answers `pow(clamp(1 - occludedShare), aoIntensity)` (three r187 `SSGINode.js:637-638`, read by the caller through `getAONode()`), and core multiplies the lit frame by it, but the owned engine answered a constant 1, so the term never reached the frame. The engine now answers its gather's own blocked share in three's form (`packages/three-native/src/addons/screen-space.ts`), and core denoises that occlusion on both engines. RED on the previous engine, GREEN now: `packages/three-native/__tests__/screen-space.spec.ts` runs the shipped node over upstream three's node system and finds the gather pass in the answer's dependency tree (both gather paths); a diagnostic build with the occlusion forced to 0.4 renders the tower-defense lawn at 61% of its brightness, so the composite consumes the channel again. The remaining gap is the algorithm, not a missing term: with the contact occlusion off in both arms, the legacy gather darkens the tower-defense lawn by 10.1/255 (144.4 without it against 134.3 with it) and the path by 11.0/255, while the owned gather moves the same regions by +0.6 and +0.8/255 (`ssgiRadius` 12: 1.3/255; screen-probe path: 2.4/255; `ssgiIntensity` 50: 0.5/255, so it adds almost no light). three occludes from a screen-space horizon over a screen-derived reach (`useScreenSpaceSampling` defaults true) and samples lit screen pixels at any distance; the owned gather traces 8 depth-crossing rays out to 4 m. Reproducing it means porting three's horizon occlusion into the owned node; PRD-723's upstream SSGI row (its AO half 12.07% against the 6% tolerance) is the open comparison. The starter pair is not SSGI at all: its frame is identical with the gather on and off on both engines, and its default native arm is 7/255 darker in the lower right because the owned GTAO runs where three's refuses (`TN_AO_REACH_UNSUPPORTED`). Captures, two runs per arm with `?gtao=off` in both arms plus one default pair per template: `~/.cache/tmp-tn/prd-goal-1102/captures/617-ssgi/{ao-off,default}/<template>/{legacy,native}/run<N>/after.png`, sheets `captures/617-ssgi/sheets/<template>-<tag>.png`. No verdict is claimed; the coordinator runs the judge.
Update 2026-11-02, fix round: the same pair for nine templates — action-rpg, runner, sailing, platformer,
tower-defense, racing, rts, rain and shooter (snow is out of AC-5 scope). Sailing's pair was recaptured
after the deferred-settle fix and now reaches an equal pose on both arms (HUD `ELAPSED` 3.5 s, `BUOYS 0/4`,
`WIND 97%`, `NEAREST MARK 21 m`); the native sky still carries the radial banding the legacy frame does
not. The coordinator runs the judge. No verdict is claimed.

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

2026-10-17 Snow frame-P95 tail, cause and engine fix (PRD-621 AC-1): the tail was not the heightfield write. In a probe build, every 8 to 9 frames one `writeBuffer` call blocked the main thread for 140 to 180 ms. That frame uploaded 20 to 28 MB. The renderer syncs a store only on frames it encodes, so the update ranges of several game frames pile up. Snow adds overlapping ranges to position, normal and state on every redraw. `GeometryCache::sync` uploaded each range on its own, so the same rows crossed to the GPU 10 to 20 times. A game-level experiment that merged the pending ranges removed the tail, which located the cause. The fix is in the engine: `GeometryCache::sync` now uploads the byte union of the pending ranges (overlapping and touching ranges merge, empty ranges are skipped). The observable `updateRanges` list still matches three.js. Test: `native_engine_renderer_geometry_cache` (case `geometry` in `renderer_caches_test.cpp`) failed before the change on both new CHECKs (range upload count and queued bytes) and passes after it. 59/59 renderer, geometry and update CTests pass. Web Wasm engine, Snow `performance` scenario, 1920x1080, 4x MSAA, hardware NVIDIA/Turing, same source and config in both arms: baseline frame P95 174.6 to 179.5 ms in four runs, candidate 17.9 to 18.1 ms in four interleaved runs, with the A/A pair at 179.3 and 182.1 ms. All four candidate runs pass the original `maxFrameMsP95` 33 ms and `minFps` 30 bounds. Frame P50 is unchanged (17.0 versus 16.4 to 16.9). The legacy engine measured 55.1 ms on one run of the same scenario. The desktop V8 player on a private Xvfb is bound by the display present, near 90 to 110 ms hostGap in both arms. Its meter frame P95 is 8.4 to 10.9 ms in every run, baseline and candidate alike, and the A/A noise is larger than the baseline-to-candidate difference. No desktop gain is claimed and a real-display desktop reading is still owed. A fresh read-only judge compared two before and after captures and returned NEUTRAL for both pairs and overall (the Downloads copies are in `snow-p95/`).

2026-11-02 pin inventory and three pins removed (lane goal-617). The ratchet list on develop named four
pinned templates, not ten: action-rpg, runner, sailing and snow. The other six templates that AC-5
lists (platformer, tower-defense, racing, rts, rain, shooter) carry no pin, and no recorded run proved
them. `pnpm test:templates` runs only in the weekly scheduled workflow, and every scheduled run since
2026-09-29 skipped `Weekly full template workload rotation`, so the newest template evidence on develop
was the 2026-10-16 matrix recorded above. The pin comments named `three/tsl deltaTime` and `vertexIndex`
as the refusals. Both are exported by the player facade (`core-tsl.mjs`), and neither template uses
them any more, so the pins were stale. action-rpg, runner and sailing bundle clean through
`bundle-native-engine.mjs --engine native --game-runtime v8` at 0f260c498 (1,635,575 / 1,614,471 /
1,536,506 bytes). Their `engine: "threejs"` pins are deleted and `LEGACY_PINNED_TEMPLATES` is
`["snow"]`; `packages/create-threenative/__tests__/config.spec.ts` passes 114/114, the package
typecheck passes and Biome reports no error. The snow pin stays for PRD-620.

2026-11-02 capsize sailing: engine fix in `Renderer::planAux` (PRD-617 Phase 2, engine layer). Sailing
refused the frame on the web Wasm engine with `TN_WASM_COMPILE: TN_POST_NORMAL_UNSUPPORTED: a material
normalNode is not written to the normal target`, then `TN_WASM_RENDERER_LOST`, on every scenario that
ran the ocean. The ocean authors a `normalNode`, and the ambient-occlusion stage reads the normal
target. three's MRT slot names `normalView`, the view-space geometry normal, so a material's
`normalNode` changes lighting only; the legacy engine writes the geometry normal there. The renderer
now writes the same value and no longer refuses the frame. Test:
`native_engine_renderer_aux_targets_normal_node` in `renderer_test.cpp`, which draws a standard plane
whose material authors a tilted `normalNode` and reads the normal target back. RED on the pre-fix
renderer: the case aborts with `terminate called after throwing ... TN_POST_NORMAL_UNSUPPORTED`. GREEN
after the fix, together with `native_engine_renderer_aux_targets_one_pass` and
`native_engine_renderer_aux_targets_alpha_tested`. The template then passes all 8 of its web scenarios
on the Wasm engine (RTX 2080, nvidia/turing, headed private Xvfb), including `sailing-hull-floats`,
`capsize-is-a-loss` and `production-performance`; before the fix those three failed with 2 browser
console errors each. AC-5 desktop half for the three templates: `pnpm build:desktop` publishes the
artifact and the player boots headless with
`TN_PLAYER_V8_GAME_CHECK: engine=native gameRuntime=v8 startup=passed` (action-rpg shadowMap=on:2,
runner off:1, sailing on:2).

2026-11-02 runner triangle budget, attributed and left open. Runner passes 4 of its 5 web scenarios on
the Wasm engine. `production-performance` fails `performance.maxTriangles`: 47,924 drawn against a
45,000 bound. The legacy arm of the same scenario at the same pose draws 34,967 triangles, so the 2,924
excess is not a budget regression alone. The difference sits in the shadow pass: the native frame
records shadow 18,544 triangles in 4 draws, the legacy frame 3,600 in 1. Main-pass triangles are
comparable (29,380 in 22 draws against 31,330 in 19). The threshold is unchanged and the root cause is
not found; the next step is to name which casters the native shadow pass keeps that three culls.

2026-11-02 runner pinned back to the legacy engine (fix round 2, lane goal-617, NVIDIA RTX 2080
nvidia/turing, headed private Xvfb, the same Wasm engine as above). Two of the brief's three leads are
disproved, and the third is a game-side fact, so the template leaves the native lane until the caster
culling is its own change:
- **No LOD pair.** The two `SkinnedMesh` draws named `Mannequin_1` and `Mannequin_2` are the two
  primitives of the one glTF mesh in `mannequin.glb` (5,732 + 8,012 = 13,744 triangles, the same count
  the action-rpg evidence names for the whole figure). Native's automatic discrete LOD is index-only on a
  single mesh (`packages/core/src/model-lod.ts`), so there is no per-camera LOD level for the shadow pass
  to follow. The shadow planner's own dump at the pose reads `Mannequin_1` 5,732 and `Mannequin_2` 8,012
  at z = -80.2, alongside `Mesh 'autobatch'` 10,800 at the origin
  (`TN_SHADOW_CASTER_DUMP`, desktop V8 player).
- **The auto-batch already splits by `castShadow`.** `RenderDatabase::addBatchMesh`'s group predicate and
  its hash both carry `shadowCaster`, so a member outside every shadow frustum joins a non-casting group;
  and the rails are casters in the game (`packages/create-threenative/templates/runner/src/render/shapes.ts`
  sets `castShadow` in `solid()`), so "legacy has no shadow for them" is not a valid premise.
- **The shadow pass is equal at boot.** The legacy arm's own `TN_FRAME_BUDGET` window in
  `/tmp/lane617/logs/runner-legacy-perf.log` records 4 shadow draws and 18,544 triangles — the native
  figures exactly — while the scenario's frame records 1 draw and 3,600. The difference is therefore
  caster culling at that pose, not a pass the native engine adds.
- **Attempt, reverted.** Skinned meshes were measured for the shadow test from their bones
  (`SkinnedMesh::boneReachBounds`, the helper the virtual-shadow bounds already use) and culled out of a
  shadow pass their box misses; `render_database_test.cpp`'s `skinned_shadow_cull` was RED then GREEN. The
  runner's numbers did not move (still 47,924 in the same run, the new Wasm engine confirmed by the built
  wasm's byte size), so that rig is either unmeasurable to that helper or its 4 shadow draws are not the
  rigs at all; with the lane's time gone the change was reverted unverified rather than shipped.
- **Pin.** `templates/runner/threenative.config.ts` sets `engine: "threejs"` again and `runner` is back in
  `LEGACY_PINNED_TEMPLATES` (`packages/create-threenative/__tests__/config.spec.ts`, 114 tests pass).
  `pnpm test` on the pinned project passes 5 of 5 scenarios (`/tmp/lane617-r2/logs/runner-test-pinned.log`,
  maxTriangles 34,967, shadow 3,600 in 1 draw), and the frames are in `captures/617/runner-r2/pinned/`.
  Next step, its own lane: name the 4 casters with a per-caster diagnostic on the current engine and a
  visual judge.

2026-11-03 the rig's shadow cull (lane goal-617-runner, NVIDIA RTX 2080 nvidia/turing, headed private
Xvfb, web Wasm engine; the page loads `assets/tn-native-engine-web-threads-*.wasm`, and both Wasm presets
carry this build). One engine bug explains the 47,924 excess; it is root-caused and fixed. The pin still
stays, for a second reason the numbers make explicit.
- **Both arms over the whole window, not one sample.** `passes.main` and `passes.shadow` from every
  `TN_FRAME_BUDGET` window of the template's own `production-performance` scenario, with a per-object
  `assert.geometry` capture on the same runs (`/tmp/617-runner/logs/`). Legacy (`engine: "threejs"`):
  shadow `1 draw / 3,600 triangles` on all 1,024 retained frames, which the capture attributes to the one
  `Mesh autobatch` — the twelve rails at 300 triangles each, merged (`TN_AUTO_BATCH`
  `{"event":"merged","meshes":25,"draws":3}`) — and main `19 draws / 31,330`. Native, before the fix:
  shadow `3 draws / 17,344` at the steady pose. Native, after the fix: shadow `3,600 in 1 draw` at that
  pose, main `26 draws / 30,580`, total `34,180` against legacy's `34,967`.
- **The casters, by A/B.** The mannequin's two `SkinnedMesh` primitives are 5,732 + 8,012 = 13,744
  triangles, and the game's `Group player` draws exactly that in main on both arms. Setting the
  mannequin's `castShadow = false` in the game drops the native shadow pass from `3 draws / 17,344` to no
  shadow draws at all (with only the rig animating, the sun's map is then kept); clearing the rails'
  `castShadow` in `src/render/shapes.ts` drops it to `2 draws / 13,744`, the rig alone. So the two
  casters separate cleanly: rig `2 draws / 13,744`, rails `1 draw / 3,600`. No discrete LOD is involved:
  no `TN_*LOD` marker appears in either run and `InstancedBatch` attaches a chain only when the game names
  one, so both engines draw full detail and there is no per-camera level for a shadow camera to pick.
- **Layer and cause.** Engine, `packages/runtime-native`: `RenderDatabase::boundingSphereOf` answered "no
  bounds" for a `SkinnedMesh`, and `inShadowFrustum` reads no bounds as "always casts", so a rig was a
  caster for every light at every distance. three reads `SkinnedMesh.boundingSphere`, computed from the
  posed vertices (r187 `src/objects/SkinnedMesh.js:138` `computeBoundingSphere`, read by
  `src/math/Frustum.js:146` `intersectsObject`), so three culls a rig the shadow camera's box misses
  (r187 `src/renderers/common/StandardDrawingPipeline.js:146` `isCulled`, under the camera the nested
  render at `src/nodes/lighting/ShadowNode.js:654` sets up). The game's own `castShadow` calls are correct
  on both arms, so this is not a game-side fix.
- **Fix.** `boundingSphereOf` answers a rig's world sphere from `SkinnedMesh::boneReachBounds`, the
  bone-reach helper the virtual-shadow bounds already use (UE 5.8.3 fits skinned bounds to bones, not to
  skinned vertices): O(bones) per frame, and a superset of three's posed sphere, so it never culls more
  than three does. A detached bind (`bindMatrixInverse` not the mesh's world matrix) keeps the old "always
  casts" answer, because its reach cannot be placed in the object's space.
  `skinned_shadow_caster_frustum_culling` (`tests/native-engine/render_database_test.cpp`) is RED on the
  old code (`2 casters of 2 items`, CHECK failed) and GREEN with it (`1 casters of 1 items`, PASS); the
  neighbouring cases pass too (`shadow_caster_frustum_culling`, `skinned_crowd`,
  `bone_reach_bounds_hold_posed_vertices`, `virtual_shadow_pages_instance_skinned_casters`,
  `virtual_shadow_rigs_batch_in_main_pass`, `frustum_culling`, `frustum_record_retention`,
  `shadow_camera_layers`, `multi_camera_layers`, `masked_shadow`, `sun_cache`, `lamp_cache`,
  `point_shadow_cube_faces`, `skinned_decline_cadence`, `skinned_projecting_cadence`,
  `skinned_normalized_weights`).
- **Why the 2026-11-02 attempt measured no movement.** The browser fetches the threads engine
  (`/assets/tn-native-engine-web-threads-D7jGLo6B.wasm` in this run's `acquisition.requestUrls`), not the
  single-thread file, and `pnpm wasm:build` writes both. A fix proven by the single-thread wasm's byte
  size proves nothing about the engine the page runs.
- **The bound still fails, and it is no longer the rig.** With the fix, `performance.maxTriangles` still
  reads 47,924: 32 of 950 retained frames carry `main 22 / 29,380 + shadow 4 / 18,544`, the first ~1.1 s
  of the run, while the runner is still inside the sun's 56 m box. There the rails (3,600), the rig
  (13,744) and one obstacle chunk (1,200) are all legitimately casters, and the legacy arm draws the same
  `18,544 in 4 draws` in its own `TN_FRAME_BUDGET` window 1. The legacy gate cannot see those frames: it
  renders about 8.5x more frames in the same run (8,149 against 950) and the performance series keeps the
  last 1,024 samples (`MAX_RENDER_PERFORMANCE_SAMPLES`, `packages/core/src/loop.ts`), which on the legacy
  arm are post-compile frames only. So the remaining failure is the template's own sun: `setupLighting`
  puts the shadow camera at `SUN_DIRECTION * 30` aimed at the origin with ±28 m half-extents and never
  moves it, so past ~28 m the box holds only the merged rail batch — the legacy capture at 40 m
  (`captures/617/runner/legacy/run1/after.png`, HUD `DISTANCE 40 M`) shows the mannequin and the obstacles
  casting nothing, and the native engine keeping them was the excess. Next step, its own lane and a
  look-plus-performance change in `templates/runner/src/render/lighting.ts`: follow the runner with the
  sun's shadow camera and size the box to what the chase camera sees (as `Daylight`'s `VirtualShadowNode`
  does), then re-measure both arms.
- **Pin.** `templates/runner/threenative.config.ts` still sets `engine: "threejs"` and `runner` keeps its
  `LEGACY_PINNED_TEMPLATES` entry, and the scaffold hash does not move, because the template's own
  `pnpm test` is 4 of 5 on the fixed native engine (`runner-no-near-miss-on-empty-road`, `streams`,
  `runner-stride` and `survives` pass; `production-performance` fails `maxTriangles 47,924 > 45,000` as
  above).

2026-11-02 AC-7 captures (judge pending, coordinator runs it). Same-pose frames per arm, two runs each,
headed WebGPU on NVIDIA RTX 2080 (nvidia/turing), 1280x720, fixed-step anchor `startTick` 240 plus 30
ticked frames, one scenario per template in
`~/.cache/tmp-tn/prd-goal-1102/captures/617/<template>-pose.playtest.json`. Arms: `engine: "threejs"`
(legacy) and the default native engine on the web Wasm back end. Images:
`~/.cache/tmp-tn/prd-goal-1102/captures/617/<template>/{legacy,native}/run{1,2}/after.png` for
action-rpg, runner and sailing. Intended effect: none on appearance; the native back end must reproduce
the legacy frame, and the sailing fix must restore the frame instead of refusing it.

2026-11-02 racing halo root cause and engine fix (lane goal/617-look-b). The judge's soft dark halo on the
road under and behind the car was the contact-occlusion stage, and nothing else: with the stage off in a
throwaway copy of the racing template, the native frame and the legacy frame differ by RMSE 0.011 (the
randomized foam and the cat pose), and the amplified AO-on/AO-off difference is the same picture as the
amplified legacy/native difference, down to the road-edge and checkline lines. `TN_RENDER_CHAIN` named the
divergence: the native arm **applied** `ambientOcclusion`, the legacy arm **dropped** it with
`build:TN_AO_REACH_UNSUPPORTED` (PRD-635). Racing declares `finalGatherMethod: "none"`, so the frame carries
no baked world cache and the native stage composed as a whole-frame multiply, which darkens the sun as well;
Unreal's SSAO darkens indirect light only (UE 5.8.3: Engine/Shaders/Private/PostProcessAmbientOcclusion.usf).
The reach form therefore cannot run on a frame with no indirect share. Fix in the engine
(`packages/core/src/look/ao-admission.ts`, read by the AO stage's build): the screen-reach occlusion refuses
such a frame with `TN_AO_INDIRECT_UNSUPPORTED`, so both arms drop the stage and the reason is printed. An
authored `gtaoRadius`, `gtaoIndirectOnly: false`, or a declared GI tier still admits it. Red-green:
`pnpm exec vitest run packages/core/__tests__/world-environment-defaults.spec.ts` passes 21/21; with the
refusal disabled the new case fails on the message it gets instead. Recaptured racing, two runs per arm,
NVIDIA RTX 2080 (nvidia/turing), headed private WebGPU, same pose: RMSE against the legacy arm 0.03297
before and 0.000745 after, and the sampled road pixels under and behind the car are identical
(`srgb(115,106,102)` at 620,600; `srgb(169,107,102)` at 600,470). Images and the labelled sheet:
`~/.cache/tmp-tn/prd-goal-1102/captures/look-b/racing/{legacy,native}/run{1,2}/after.png` and
`~/.cache/tmp-tn/prd-goal-1102/captures/look-b/sheets/racing.png`. AC-7 stays open: the coordinator runs the
judge.

2026-11-02 platformer residuals, cause named and not fixed (lane goal/617-look-b). The three reported
symptoms are one cause: the native arm runs both screen-space stages the legacy arm cannot. (a) The coin and
rope shadows are washed out, (b) the waterfall sheet is pale and (c) the frame is +2.3/+3.3/+6.6 of 255
(cooler) because the native SSGI gather falls back to the baked world cache where a screen ray misses
(`world-environment.ts`, the Lumen tiering in the SSGI stage), while the legacy arm's gather has no cache and
its material adds no cache light; the cache also lifts the pixels inside every shadow. Proof: with
`ssgiEnabled: false, ssrEnabled: false` in both arms, the waterfall sheet matches (native `srgb(67,145,177)`
against legacy `srgb(64,146,179)` at 440,415, against `srgb(76,143,172)`/`srgb(43,126,161)` with SSGI on),
and the same-class lift on brown surfaces falls from +23 to +3 in blue. Fog is not involved: a capture with
`scene.fog` and `scene.fogNode` removed in both arms keeps the difference (RMSE 0.0294). The cloud
"shaded undersides" are the contact occlusion darkening unlit geometry, which the legacy arm drops: exempting
unlit pixels in the AO composite removes the creases but raises the whole-frame difference on that template
(RMSE 0.0345 to 0.0512), because the same lift it was cancelling is the SSGI cache fallback, so that
exemption is reverted rather than shipped alone. Images:
`~/.cache/tmp-tn/prd-goal-1102/captures/look-b/platformer/{legacy,native}/run{1,2}/after.png`,
`~/.cache/tmp-tn/prd-goal-1102/captures/look-b/sheets/platformer.png`. Open: decide whether the AC-7 criterion
for these templates is legacy parity (then the native gather's cache fallback needs to be gated off, or the
legacy arm needs the cache) or the more correct native frame.

2026-11-02 platformer and tower-defense on the web Wasm engine (lane goal-617, RTX 2080
nvidia/turing, headed private Xvfb, each template's own `pnpm test`). platformer: 17 of 18 scenarios
pass; `production-performance` fails on two performance assertions, `performance.maxTriangles` 190,005
against 190,000 and `performance.maxFrameMsP95` 19.54 ms against 16.7. The legacy arm of the same
scenario and pose draws at most 193,822 triangles and measures p95 21.2 ms (CPU-bound, GPU p95 10.05),
so both failures also happen on the legacy engine and neither is a native regression; the numbers are
left unchanged. tower-defense: 11 of 12 scenarios pass; `production-performance` fails
`performance.maxFrameMsP95` 17.53 ms against 16.7 with GPU p95 17.53 and CPU p95 0.15, a GPU-bound run
on a virtual display. Its legacy arm was not measured. racing, rts, rain and shooter were queued on the
same sweep and had not reported when this lane stopped; the sweep keeps its logs in
`/tmp/lane617/logs/web-<template>.log`.

2026-11-02 AC-7 capture comparison notes (judge still pending). All twelve capture runs report
`pass=True`, `clock=fixed-step` and `frames=30` after the `startTick` 240 anchor. action-rpg and runner
reach equal poses between arms (same HUD state; action-rpg's native pair is byte-identical). Sailing does
not: with the same anchor and frame count, HUD `ELAPSED` reads 4.5 s on the native arm and 3.5 s on the
legacy arm, so the ship and buoys sit elsewhere, and the native sky carries a radial banding pattern
the legacy sky does not. The sailing pair is indicative only: the pose mismatch limits a judge's
conclusion, and the sky banding needs its own investigation. No verdict is claimed.

2026-11-02 fix round, sailing's normal target (engine layer, `packages/runtime-native`). The previous
commit a2750b7db was wrong about three 0.187: `src/nodes/accessors/Normal.js:95-119` makes the
fragment-stage `normalView` the value of `builder.context.setupNormal()`, and
`src/materials/nodes/NodeMaterial.js:952` returns `vec3(this.normalNode)` when the material authors
one. So three's MRT normal target holds the AUTHORED normal, and the native engine now writes the same
value: `StandardPrograms::normal` (`standard.h`, set at `standard.cpp` beside the albedo and emissive
exports) is the lit fragment's own normal, and `Renderer::normalTarget` writes it for a draw whose
material authors a `normalNode`, through that draw's own lit fragment (`Renderer::auxFragment`) instead
of the shared geometry-normal pass. `native_engine_renderer_aux_targets_normal_node` asserts the
read-back equals the authored tilt, `normalize(0, 0.5, 1)` = `(0, 0.4472, 0.8944)` with the alpha that
packs metalness 7 and roughness 0.5, on both masks (normal alone, and all four targets). RED on
a2750b7db's renderer: `got 0 0 1 14.5, want 0 0.447214 0.894427 14.5`. GREEN after the fix, together
with `aux_targets_one_pass`, `aux_targets_alpha_tested`, `denoise_face_normal`, `emissive_target`,
`emissive_validation`, `raw_target_scene_only`, `output_ramp` and the four lit references (renderer-test,
headless Vulkan, RTX 2080). The Wasm engine was rebuilt with `pnpm wasm:build` and reinstalled into the
template projects; sailing's web playtests then pass 8 of 8 scenarios (`capsize-is-a-loss`, both
`sailing-hull-floats` scenarios, `sails-fill-with-wind`, `round-four-course-buoys`, `survives`,
`sailing-touch-controls` and `production-performance`), with no `TN_POST_NORMAL_UNSUPPORTED`,
`TN_WASM_COMPILE` or `TN_WASM_RENDERER_LOST` line in the run.

2026-11-02 the weekly template rotation, cause and fix (`.github/workflows/performance-regression.yml`).
The earlier note in this lane said the job is `skipped` on every scheduled run since 2026-09-29; that
reading was wrong. Two crons fire, `47 4 * * *` daily and `17 4 * * 0` weekly, so GitHub opens two runs
every Sunday. `gh run view` on the later run of each Sunday (41302075352, 40180485848, 39113895367, …)
shows `Weekly full template workload rotation: skipped`, which is the daily cron behaving as its `if:`
says. The earlier run of each Sunday (41301318744, 40179597056, 39113158066, 38133444402, 37195900318,
36311245712, 35501956905, …) reaches the condition and the job there is `failure`, never `success`,
since the job landed on 2026-09-06 (86e0b8a). It dies in about 20 seconds on
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/packages/create-threenative/node_modules/@threenative/assets/dist/index.js' imported from …/packages/create-threenative/src/config.ts`:
the job ran `pnpm install` and then `pnpm test:templates`, and nothing in it ever built the workspace.
`@threenative/assets` reaches the verifier through the workspace symlink into `packages/assets/dist`,
exactly the failure `golden-path`'s platformer leg had on run 33697267947. So no scheduled run has
re-measured a template since 2026-09-06, and this PRD's template evidence went stale. The fix keeps the
`if:` (it matches) and gives the job what it needs: the `workspace-dist` action builds the bundles
(`pack-archives: false`, `save-bundles: false`; the develop push lane stays their only saver), the
`native-engine-wasm` action supplies `packages/runtime-native/build/web`, which
`packageLocalFramework` asserts before it packs, `TN_PLAYTEST_ALLOW_SOFTWARE=1` accepts the hosted
runner's software adapter as `golden-path` already does, and the timeout goes from 30 to 120 minutes for
eight template legs. Guarded by a new spec in `scripts/__tests__/ci-structure.spec.ts`: it parses the
`on.schedule` crons and the job's `if:`, and requires the condition to name the weekly cron and no other,
the two build actions to precede `pnpm test:templates`, and the software acceptance. Next scheduled run
is the proof; this lane cannot dispatch one, so the green weekly run is unverified here.

2026-11-02 the sailing capture pose mismatch, cause and fix (harness layer, `packages/core`). The two
arms reached the same scenario anchor (`startTick` 240) and the same frame count, but the sailing
HUD read `ELAPSED` 4.5 s on the native arm and 3.5 s on the legacy arm — exactly the 60 fixed steps of
`FROZEN_SETTLE_STEPS`. The game's clock is the number of `update` calls (`Sailing.ts`:
`elapsed += deltaTime`), while the run's clock is `FixedStepLoop.tick()`, and the settling pass a
freeze owes the world was spent by the first live frame after the hold was released
(`#primeFrame`). `describe()` releases that hold before it awaits `startSceneEntered()`, so whether
that first live frame lands on the loading scene or on the sailing scene is a race with boot: where it
lands, those 60 fixed steps advanced `tick()` without ever reaching the sailing scene's own clock. The
legacy arm lost them, the native arm did not, and the same anchor therefore described different game
state. Fix: `FixedStepLoop.settleNow()` spends the settling pass on demand, `Game` exposes it as the
optional `settleClock` runtime seam, and the playtest plugin freezes with zero steps and settles once,
after `startSceneEntered()` resolves, so the pass lands on the world scene on every engine. A runtime
without `settleClock` keeps the frame's own settle. Red-green:
`packages/core/__tests__/playtest-settle.spec.ts` installs the production plugin against a fake runtime
whose world scene enters only after the hold is released, and requires the freeze to name zero steps,
no frame before scene entry to move the clock, one settle at tick 0 after entry (60 steps, 60 ticks),
and no second settle on a repeated `describe()`. RED with the frame-based settle restored:
`expected [ undefined ] to deeply equal [ +0 ]`. GREEN after. `packages/core/__tests__/loop.spec.ts`
adds the loop half: a zero freeze settles nothing on frames, `settleNow()` spends exactly 60 once,
rejects a negative or fractional count, and no later frame settles again. `loop.spec.ts`,
`playtest-settle.spec.ts` and `game.spec.ts` pass 124/124; `packages/core` typecheck passes and Biome
reports no error on the changed files.

2026-11-02 the rest of the AC-6 web sweep (lane goal-617, RTX 2080 nvidia/turing, headed private Xvfb,
each template's own `pnpm test` on the native Wasm engine). racing 11 of 11 scenarios pass, rts 9 of 9,
rain 15 of 16, shooter 34 of 37. rain's one failure is `rain-production-performance`
`performance.maxFrameMsP95` 20.39 ms against 16.7 (GPU 20.39, CPU 0.83) — a GPU-bound run on a virtual
display. shooter's three failures are one page crash and its fallout:
`debug-fire` ("the page went away without navigating"), then `enemy-body-is-a-body` and
`walkway-reachable` ("the bridge is not installed" / "the page navigated during the bridge handshake"),
all three inside the same browser session. The 34 passing scenarios include every weapon, movement,
enemy and `performance` scenario. So of the ten AC-5 templates the native engine now passes the whole
web suite for action-rpg, sailing, racing and rts, and misses only performance bounds for platformer,
tower-defense, rain and runner; snow is pinned (PRD-620) and shooter has the page crash above. The
thresholds are unchanged.

2026-11-02 the sailing capture pose is equal between arms (fix round, item 2). With the deferred settle
in place, both arms reach `startTick` 240 plus 30 ticked frames with HUD `ELAPSED` 3.5 s, `BUOYS 0/4`,
`WIND 97%` and `NEAREST MARK 21 m` — the same game state at the same anchor, which the previous pair
did not have (4.5 s native against 3.5 s legacy). The remaining honest caveat: the settling pass's 60
fixed steps now reach neither arm's sailing clock (both read 3.5 s rather than the 4.5 s the native arm
used to read), so the pass still lands before the sailing scene installs its own clock on both engines.
That is at least deterministic — the same anchor now describes the same state on every engine — but the
harness question "should those 60 steps reach the world clock" is still open and needs its own lane.
The native arm's sky still shows the radial banding/streak pattern the legacy arm does not; it is an
appearance difference outside this lane's change and it is recorded for the judge.

2026-11-02 the runner shadow pass, what it actually draws (fix round, item 4). A temporary caster dump
in `Renderer::planShadow` (not committed) printed every draw of the sun's one shadow pass for the
runner's own game on the desktop V8 player: `Mesh 'autobatch'` 10,800 triangles, `SkinnedMesh
'Mannequin_1'` 5,732, `SkinnedMesh 'Mannequin_2'` 8,012, `InstancedMesh 'obstacles'` 3,600 (4
instances); one shadow pass, four draws. The legacy arm's whole shadow pass is one draw of 3,600
triangles, which is the `obstacles` instanced mesh. So the difference is not the shadow camera and not
the frustum test: it is which objects the native engine admits as casters. The static world reaches the
shadow pass as one auto-batched mesh, and `addBatchMesh` splits a batch by its members' `shadowCaster`
flag, so that batch is all casters by construction; the two mannequins are the LOD pair of the same
character mesh, and both are drawn into the shadow map where the main pass shows one figure. Neither
mechanism is a threshold question and neither is fixed here: the batch's merged geometry cannot drop a
member that does not cast without a per-member caster index, and the shadow pass does not consult the
main pass's LOD selection. `maxTriangles` is unchanged, as the brief requires, and this stays an open
engine question with the two mechanisms named.

2026-11-03 AC-5 and AC-6 desktop half (lane goal-617-v8, NVIDIA RTX 2080 / nvidia turing, private
Xvfb). Player `tn-native-engine-player-v8` built from this tree
(`cmake --preset tn-linux -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON
-DTN_ENGINE_PLAYER_UI_OVERLAY=ON -DTN_ENABLE_NATIVE_PHYSICS=ON -DTN_ENABLE_UI_OVERLAY=ON`, `-j4`).
Each template was scaffolded from this worktree's tarballs into a scratch directory outside the repo
(`pnpm install --ignore-scripts`) and built with `pnpm build:desktop`.
AC-5 boot (`./tn-native-engine-player-v8 ./game.js --check-game`, headless):
platformer `shadowMap=on:2`, tower-defense `off:1`, racing `on:2`, rts `on:2`, shooter `on:2`,
action-rpg `on:2` — all `engine=native gameRuntime=v8 startup=passed`. rain cannot answer the
headless check: it boots the scene and then its own first boot render asks for a render target, which
the check refuses by name (`TN_NATIVE_RENDER_TARGET: the player has no renderer before its first
frame`, `v8_main.cpp:767`). Its windowed desktop boot is the proof instead: `native-playtests/boot`
passes 4/4 (elapsed changes, renderChain tier high with `stormPost`, no diagnostics) on the same
adapter. Pins: `LEGACY_PINNED_TEMPLATES` is `["runner", "snow"]`, and runner was unpinned in the
scratch copy only for this sweep; snow's pin stays (PRD-620), so AC-5 stays open.
AC-6 desktop playtests (`--target desktop --executable dist-native/<name>/<name>`, counted ticks):
racing `native-playtests/survives` pass; sailing `native-playtests/float` and `survives` pass;
snow `native-playtests/snow-physics` and `survives` pass on its pinned legacy host, so they are not
native-engine evidence; rain `boot` pass, `lightning` fails. Ten templates without a
`native-playtests/` directory were run twice: their shipped `playtests/survives` is refused by the
harness on desktop (`TN_PLAYTEST_UNSUPPORTED_ON_TARGET`: desktop evaluates no `visual` metrics), and
a scratch `native-playtests/survives` copy with the same steps and bounds minus the `visual` block
and the `visibility` block (desktop has no `runtimeDiagnostics` observation; both are named refusals,
not game failures) passes for platformer, tower-defense, shooter, action-rpg and runner, and rts's
shipped scenario needs neither and passes as-is. rain `lightning` fails at its first labelled step:
the scenario assumes the web view reports `prefers-reduced-motion: reduce` ("the storm boots with
flashes suppressed"), and the desktop target has no such media query, so `state.safe` boots false,
`strikes` 1 and `status` "steady"; the `audio.thunder` cue is also unobserved (0 plays) on the
private display, which has no audio device. The same scenario's `thunderVoices` assertion already
fails on the legacy host and on Wasm (2026-10-16 note above). No bound was changed.
Two engine bugs found and fixed (engine layer, `packages/runtime-native`, with CTest red-green):
rain refused the V8 player with `TN_TSL Loop: expected 2 arguments`. three's `Loop(...params,
callback)` takes one parameter per dimension and nests them, and `condition: "<="` runs up to and
including the end; three's own GLSL transpiler emits that shape for rain's bloom and ripple kernels.
The browser back end already nests it (`browser-tsl.ts`), the V8 facade demanded exactly two
arguments and refused every condition but `<`, and the shared lowering refused a negative `start`.
The facade now lowers one loop per parameter (opening every body, running the game's callback once
with the whole index set, closing innermost first), answers `toVar` outside a function body with the
expression itself as `browser-tsl.ts` does (rain's `exp(...).toVar()` in a fragment node), and the
lowering counts `<=` as `end - start + 1` and accepts a signed start. `native_engine_abi_tsl_loop_nested`
covers it: RED on the pre-fix lowering (`tn_tsl_call(ctx, "Loop", … 6 args)` not `TN_OK`), GREEN now,
with `native_engine_abi_tsl_statements` still passing; `native_engine_player_imports` adds the facade
half (a nested `<=` loop and a `toVar` outside `Fn` through the player bundle).
Update 2026-11-03, final judge on the merged tree (all fixes of this PR: settle, normal target, GTAO fade, AO refusal without a world cache, SSGI occlusion, render-mirror fog node): ten templates, two same-pose runs per arm, default look, NVIDIA RTX 2080 (nvidia/turing), 48 runs with no warning overlay, captures and RMSE table in `~/.cache/tmp-tn/prd-goal-1102/captures/617-final/INDEX.md`. Two fresh Opus judges: NEUTRAL for snow, rain, shooter (the overhead wire is cleaner on native), action-rpg, runner, sailing (no sky banding, same pose), racing (no halo), rts, tower-defense (lit surfaces now match; the dark background differs because three's SSGI darkens it and the owned gather does not, the accepted SSGI difference) and tower-defense with AO, SSGI and SSR off in both arms. REGRESSION for platformer, with and without those stages: the waterfall sheet is paler and more transparent on native (body median 108,166,185 against 67,149,181 with the stages off). Open: platformer. Minor, not visible: runner and sailing render about 1/255 darker over the whole frame on native.

2026-11-03 (lane goal-617-v8, round 2) AC-6 web half for racing, rts, rain and shooter, and the
reason rain's `native-playtests/lightning` failed on the desktop player. The Wasm engines were built
from this tree (`pnpm wasm:build` under the shared build lock, both presets, exit 0) and the sweep ran
as `TN_TEMPLATE_ONLY=racing,rts,rain,shooter pnpm test:templates` on the private Xvfb, headed, WebGPU,
with vendor nvidia / architecture turing reported for every scenario (no SwiftShader). racing 11/11
scenarios, rts 9/9, shooter 38/38, rain 14/16 then 15/16 after the triviality fix below. Kit contract
rows in the same sweep: racing, rts and shooter ok on every declared row; rain ok on the five declared
rows on the quieter rerun (an earlier `no-hitch` failed with `TN_PLAYTEST_PERF_FEW_GPU_SAMPLES`, a
measurement shortfall under load average 17, not a game failure).
`rain-production-performance` is the one remaining web miss and it is not a native regression.
Its assertion is `performance.maxFrameMsP95` 21.24 ms against 16.7 (GPU 21.24, CPU 0.81, 15 GPU
samples over 1024 frames). In paired runs of that scenario, alternately native and `engine: "threejs"`
on the same kit, the legacy arm fails the same bound: legacy 20.01 and 19.62 ms against native 24.69
and 20.21 ms (the legacy arm also misses `performance.maxDrawCalls` 18 against 16). The runner's own
report says the private display paces frames on its own timer, and that interval p95 is 17.4-17.58 ms,
above the 16.7 ms bound before any game work is paid. The bound is unchanged.
Rain's desktop `lightning` failure was the scenario's assumption, not an engine fault, and it is fixed
in the template. The UI realm reads `window.matchMedia("(prefers-reduced-motion: reduce)")`; on desktop
that query is answered by the overlay's WebKit page, on a private display with no such setting it
answers no-preference, so the storm booted flashing while the scenario expected flashes suppressed, and
every later step inverted: KeyX turned photosafety mode on instead of off, the KeyL meant to be
suppressed struck, the sound enable edge (by design) cleared the strike queued at boot, and
`audio.thunder` recorded no play. The layer is the template because nothing in the player answers the
setting wrongly: `uiOverlaySetEnvironment` (`packages/runtime-native/src/platform/ui_overlay.cpp:1137`)
is the native-css document's environment and its own comment records that SDL exposes no reduced-motion
source, so the desktop host has no OS setting to report and the web view's answer is the truth. Rain now
publishes that answer (`setReducedMotion` -> `GameState.reducedMotion`, read once in the UI realm) and
the desktop scenario reads the branch the host took: it asserts `reducedMotion` false with the reason
held in `allowTrivial`, boots unsafe, presses sound then photosensitivity mode on, strikes while
suppressed (`strikes` 0, `flash` 0, `status` steady, `pendingThunder` 0), turns it off, strikes for real
(`strikes` 1, `status` flashing, `pendingThunder` 1), then waits out the air (`thunderVoices` 0 -> 1,
`pendingThunderAt` -1) and the cue: `audio.thunder` observed 1 play with a 2411 ms gap, on a display with
no audio device. The audio half was never a silent-device problem: `AudioBus.play` counts the cue
(`noteCue`, `packages/core/src/audio.ts:500`) before any device work, and the desktop log shows the
AudioContext created and `source.start()` called on this display. No scenario in `template-playtests/`
or `native-playtests/` carries an audio opt-out, and none is needed. RED before the template change:
`intentPatch` refused `setReducedMotion` ("is not a rain intent") and the UI effect sent nothing, so
`rain-weather` and `rain-quality-initialization` failed 2/20; GREEN 20/20 after. The web
`playtests/reduced-motion` scenario asserts the same published field, which first failed
`TN_PLAYTEST_ASSERTION_TRIVIAL` because the emulated preference is already true before the scenario
runs; `allowTrivial` now carries that reason, and the scenario passes.
