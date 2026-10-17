# PRD-616 — The startup warm-up builds what the first frame draws

**Status:** COMPLETE
**Priority:** P1 — all five acceptance criteria verified.
**Complexity:** 2 (LOW) — 6–10 implementation files (`warmup.ts`, `renderer.ts`, `game.ts`, `world-cells.ts`, `pipeline-census.ts`, the playtest census evaluator) (+2); risk override: none
**Owner:** Codex — draft PR [#509](https://github.com/ThreeNativeHQ/threenative-engine/pull/509)
**Depends on:** None. [PRD-611](../Unreal/vfx/PRD-611-a-gpu-effect-that-starts-hidden-draws-its-first-frame-with-its-pipeline-built.md) depends on this PRD: its warm render of a hidden emitter has the same call-depth miss.

## Context

`warmUpScene` (`packages/core/src/warmup.ts:823`) compiles the scene with three's `compileAsync`. The chunk and cell warm-ups in `packages/core/src/world-cells.ts:9530` and `:9877` use the same call. All three run at renderer call depth 0 and target the canvas.

A game that sets an output node draws its world through `renderFrame` (`packages/core/src/renderer.ts:632`): `outputPipeline.render()` renders the authored world `PassNode` at call depth 1, into the pass's own render target.

Three r185 keys node builds by render context: `RenderObject.getMaterialCacheKey()` adds `this.context.id` (`three/src/renderers/common/RenderObject.js:855`), and there is one render context per call depth. The pipeline cache key also carries the output color space of the target. So nothing the warm-up builds is reused by the real frame.

The extra warm render (`renderWarmPasses`, `warmup.ts:717`) does not cover this. It calls `raw.render` at depth 0, and it is skipped when the scene has no shadow caster and no reflector (`warmup.ts:742`).

**Measured 2026-10-14** (abyss-framework with `warmUp: {}`, its TSL scene pass and bloom; headed Chromium, NVIDIA Turing; two identical runs; instrumentation wraps three's `_createNodeBuilder`, `_createNodeBuilderState` and `_pipelines.getForRender`):

| | Run 1 | Run 2 |
|---|---:|---:|
| Node graphs built in warm-up | 3 | 3 |
| Warmed graphs built again in frame 1 (context 0 → 2, depth 1) | 3 of 3 | 3 of 3 |
| New post-processing graphs in frame 1 | 8 | 8 |
| Node builds in frames 6–120 | 0 | 0 |
| Vertex / fragment programs / pipelines after warm-up → after frame 120 | 3/3/6 → 7/11/17 | 3/3/6 → 7/11/17 |
| First frame / median frames 60–120 (CPU ms) | 29.9 / 1.1 | 29.2 / 1.1 |

The repeated graphs produced identical WGSL, so shader programs were reused. All 3 pipeline cache keys differed, including the output color space, so the GPU pipeline compiles were repeated too. Instrumentation (uncommitted): `.claude/worktrees/measure-35014/examples/abyss-framework/src/main.tsx`.

Upstream [mrdoob/three.js#35014](https://github.com/mrdoob/three.js/pull/35014) (open, r187) removes `context.id` from the node-build key. It fixes the node-build half only: the pipelines still differ by render target. It also changes four files the three patch already edits. This PRD fixes the cause in the engine and leaves `packages/core/patches/three@0.185.1.patch` unchanged.

Layer: engine. The warm-up and `renderFrame` are core mechanism. No game can reach the output pass call depth from its own code.

## Solution

When an output pipeline is set, the warm-up compiles against the real world pass: the same render target (color space, MRT, samples) and the same call depth as `renderFrame`. Without an output pipeline, the current path stays as it is.

Phase 1 picks the mechanism by measurement, on stock three APIs only:

1. **Preferred:** a `compileAsync` issued while the world pass's render target and call depth are current, so pipeline creation stays asynchronous.
2. **Fallback:** one covered `renderFrame` through the output pipeline, behind the startup cover. It is synchronous, but it moves the cost behind the cover.

`renderWarmPasses` stops skipping the covered render for a scene with an output pipeline. The chunk and cell warm-ups in `world-cells.ts` call the same core entry point.

Risk: a covered render through the real pipeline can advance temporal history (TRAA, motion vectors). The first visible frame must not change (AC-4).

## Acceptance Criteria

- [x] AC-1 [local]: On Abyss with `warmUp: {}`, warmed objects build zero nodes and render pipelines through the first five actual visible world draws. proof: verified final core `acc3affd3`: default headed NVIDIA `artifacts/prd616/ac1-visible-final` passes both complete zero ceilings and diagnostics, with positive warm census 12 nodes/12 render pipelines. The independent first-visible matrix records five actual world draws per run; source-tagged receipts are `first-visible/matrix.json`.
- [x] AC-2 [local]: First-world render CPU improves. proof: verified final core `acc3affd3`: 3.0, 3.2, 3.8 ms; median **3.2 ms**. Same-harness frozen baseline is 21.3/22.3 ms (the original brief measured 29–30 ms). This is `runtimeDiagnosticsSeries.phases.render` for the first post-warm-settlement GameLoop world callback, before sustained READY; first visible post-READY CPU is recorded separately. Auxiliary paint waits assert unchanged held frame/tick/pose/seed/controller/CPU/DOM state. Metadata: `artifacts/prd616/first-visible/matrix.json`.
- [x] AC-3 [local]: A streamed chunk creates zero nodes/render pipelines on its first draw after warm-up. proof: verified final core `acc3affd3`: two headed NVIDIA runs `world-scope-after-{1,2}` and desktop `world-scope-native-visible-final` pass complete scoped zero ceilings and diagnostics for `chunk:0:2:0`. The stock authored output pass is installed before real WorldCells attachment; warm rendering preserves the complete target scene offscreen. Positive warm counts and actual `firstDraw: 0/0` are in consumed `result.json` receipts. The final scenario waits for three resident cells, nine terrain tiles and zero live load/prewarm/admission queues before assessment.
- [x] AC-4 [local]: The first visible frame is unchanged. proof: a fresh read-only visual judge inspected all 24 canonical frames and ten supporting pixel-preserving UI zoom pairs from two headed NVIDIA `--browser-recipe webgpu` runs per arm. Final amended verdict: **NEUTRAL (PASS)** for every startup frame pair, both fully resident scoped pairs and overall; the unsupported animation rationale was withdrawn. All 24 images are [posted on PR #509](https://github.com/ThreeNativeHQ/threenative-engine/pull/509#issuecomment-6194394348). Immutable proof commit: `a8be7166d7e9525f161ad4e0cd736e7f392a8ad9` on `prd616-screenshots`.
- [x] AC-5 [local]: The desktop host passes the actual Abyss AC-1 scenario. proof: verified final core `acc3affd3`: `artifacts/prd616/native-ac5-visible-final`, rebuilt `warm-up-native.js`, complete zero ceilings and diagnostics passed, with 12 positive warm nodes/12 render pipelines. Use absolute scenario/executable/bundle/artifact paths and `--project <absolute examples/abyss-framework/dist>` for the staged manifest.

## Unverified external follow-up

- Physical Pixel 8 / Bayview launch-time gain belongs to PRD-360's 96-program lane and remains unmeasured; shared-device access was not granted in this run. This is outside the five written PRD-616 acceptance criteria, all of which are complete. No acceptance criterion was waived and no physical-mobile gain is claimed.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Startup warm-up targets the world pass | `defineGame` boot → `warmUpScene` (`game.ts:1229`, `game.ts:2133`) → output pipeline path | depth-0 canvas compile kept only when no output pipeline is set | AC-1 |
| Streamed chunk warm-up targets the world pass | `WorldCells` chunk attach → `#warmChunk` (`world-cells.ts:9877`), cell proxy (`world-cells.ts:9530`) | calls the same core entry point | AC-3 |
| Census boundary at warm-up settled | playtest observations `pipelineCensus` → new assertion | extends `pipeline-summary.ts` (today it splits only at first present) | AC-1, AC-3 |

## Execution Phases

#### Phase 1: The census sees the rebuild (red)

**Status:** COMPLETE
**Files:** `packages/core/src/pipeline-census.ts` (warm-up-settled boundary on each event), `packages/playtest/src/runner/pipeline-summary.ts` and its scenario schema/evaluator (assertion on builds and creations after warm-up), `examples/abyss-framework/playtests/warm-up-reuse.playtest.json`.
**Implementation:** Today's census flags only `beforeFirstPresent`, and frame-1 rebuilds land before the first present. Add a warm-up-settled boundary and count node builds and pipeline creations after it, per material. The assertion fails closed when the census is absent or incomplete.

- [x] The new scenario runs red on develop and reports 3 rebuilt graphs and 3 new pipelines. proof: the AC-1 command, plus `pnpm exec vitest run packages/playtest/__tests__/pipeline-timing.spec.ts packages/core/__tests__/pipeline-census.spec.ts` — Verified 2026-10-15 against frozen develop `1d056cec3` with the diagnostic patch retained in `artifacts/prd616/baseline-source.patch`: headed NVIDIA Turing scenario exited 1 with both complete census assertions observing exactly 3 against 0; diagnostics passed. Two first-visible capture runs independently distinguish these 3 warmed world graphs/pipelines from 8 new post graphs. Parent reran the focused census/timing suites on the repaired source: 81/81 passed. Raw command results: `baseline-scenario-red-3.log` and `phase1-current-focused.log`; capture artifacts: `artifacts/prd616/baseline-scenario-red` and `artifacts/prd616/first-visible/before-{run1,run2}`. First-world CPU measurement remains a Phase 2 task.

#### Phase 2: The warm-up compiles against the world pass (green)

**Status:** COMPLETE
**Files:** `packages/core/src/warmup.ts`, `packages/core/src/renderer.ts` (expose the world-pass compile entry point beside `renderFrame`), `packages/core/src/game.ts`, `packages/core/src/world-cells.ts`, `packages/core/__tests__/warmup.spec.ts`, `examples/abyss-framework/playtests/world-warm-up-reuse.playtest.json`.
**Implementation:** Measure option 1 against option 2 from Solution on the AC-1 scenario and record the choice under `## Decisions`. Route all three warm-up callers through it. Keep the no-output-pipeline path unchanged.

- [x] AC-1 and AC-2 are green. proof: final headed startup passes complete zero ceilings and positive warm 12/12; canonical matrix AFTER 3.0/3.2/3.8 ms, median 3.2 ms. See acceptance receipts above.
- [x] AC-3 is green. proof: dedicated `world-warm-up-reuse.playtest.json`, scope `chunk:0:2:0`, browser `?world&warmup` and portable `world-warm-up-native.js`. The fixture installs the authored output pass before attaching real WorldCells. Synthetic streaming and broad world-flythrough fixtures are restored to frozen develop; the old scope `chunk:0:2:1` was absent. No ceiling or diagnostic assertion is relaxed. Correct headed NVIDIA control and native control both expose the same-frame failure before the fix; final two headed NVIDIA browser and desktop runs pass zero ceilings and diagnostics.
- [x] A renderer without an output pipeline warms exactly as before. proof: `pnpm exec vitest run packages/core/__tests__/warmup.spec.ts` — 35 tests passed locally on 2026-10-14, including the scoped output-world-pass regression.

#### Phase 3: Prove the look and the native host

**Status:** COMPLETE
**Files:** none expected; fixes go back to Phase 2 files.

- [x] AC-4 judge verdict is recorded, with the images on the PR. proof: amended independent NEUTRAL (PASS) for all 24 canonical frames; [PR image comment](https://github.com/ThreeNativeHQ/threenative-engine/pull/509#issuecomment-6194394348), immutable proof commit `a8be7166d7e9525f161ad4e0cd736e7f392a8ad9`.
- [x] AC-5 is green on the desktop host. proof: actual Abyss `native-ac5-visible-final` passes complete zero ceilings, diagnostics and positive warm 12/12 on final core `acc3affd3`.

## Decisions

- Measured the preferred stock `PassNode.compileAsync` path on headed NVIDIA WebGPU: its completion marker ran, but complete census still observed 3 warmed node rebuilds / 3 render-pipeline creations. The real output-render fallback produced 0/0, so startup and scoped callers share that path. No Three patch change.
- Scoped warm-up renders the complete real target scene offscreen with the requested chunk attached. Stock `RendererUtils` and explicit pass state restore renderer, camera, target and authored state on success/throw. Removing visibility masking preserves dynamic terrain; the installed `PassNode` / `NodeFrame` regression requires temporary public `NodeUpdateType.RENDER`, restored afterwards, for same-frame reuse.
- Census attributes node builds independently of pipeline creation, binds scoped observations to the first completed main draw, and fails closed on absent/incomplete observations. Failed, skipped, over-deadline or GPU-drain-timeout warm work cannot publish false completion or cache success.
- Final canonical capture uses standard headed WebGPU, verified NVIDIA adapter, actual first five post-READY world renders and unchanged held-world pose/seed/tick/CPU/DOM during auxiliary paint waits. CPU is the first post-warm-settlement GameLoop render phase before READY, reported separately from visible-frame timing. Final `first-visible/matrix.json`: BEFORE 21.3/22.3 ms; AFTER 3.0/3.2/3.8 ms, median 3.2 ms. Independent paired-frame and pixel-preserving UI-zoom review confirms static UI and nine-tile terrain remain complete; no UI/CSS change was needed.
- Scope remains the five written acceptance criteria: browser startup CPU/reuse, streamed reuse, visual parity and actual Abyss desktop reuse. Physical-mobile launch-time measurement remains an explicit external PRD-360 follow-up. The user subsequently authorized repair, push and the guarded merge queue; the earlier draft-only restriction is superseded.

## Verification notes

- Final executable source `acc3affd3`: root `pnpm test` exited 0, **776 files passed / 3 skipped; 10,605 tests passed / 20 skipped**. Root `pnpm typecheck && pnpm lint`, `pnpm check:docs`, `pnpm budgets` and `git diff --check` exited 0. Existing lint/LOC warnings are nonfatal. Raw receipts: `full-unit-canonical-final.log`, `canonical-type-lint-local.log`, `canonical-docs-budgets.log`; focused renderer/constraints/world-capture/quality coverage passed 65/65.
- Final browser startup (`ac1-visible-final`) and actual Abyss desktop (`native-ac5-visible-final`) pass complete zero ceilings and diagnostics with positive 12-node/12-pipeline warm census. Strict scoped browser runs (`world-canonical-after-{1,2}.log`) and desktop (`world-native-ring-final.log`) pass `chunk:0:2:0` first-draw 0/0, with all three cells / nine tiles resident and live queues clear. Rebuilt native bundles use the same final core; native claims cover desktop only.
- Reproduction scripts, exact diagnostic baseline/scenario patches, canonical matrix, consumed runtime receipts and images are [published at the immutable proof commit](https://github.com/ThreeNativeHQ/threenative-engine/tree/a8be7166d7e9525f161ad4e0cd736e7f392a8ad9/prd616). Earlier matrix files and partial-residency captures are not final evidence. Independent amended verdict is recorded in the PR image comment.
- Laptop capacity refused two final offload attempts at 98/97°C (exit 75); these were capacity refusals, not failed tests. Final typecheck/lint ran locally and passed. Remote CI and physical Android/iOS remain unverified; no remote-CI success is inferred from pre-push drift checks.

### Phase 4: Repair independent review findings

**Status:** COMPLETE
**Scope:** shared renderer refresh lifetime and repeated-label playtest census aggregation; existing bloom world fixture, focused regressions and browser/desktop proof. No new API, dependency or Three patch.

- [x] Nested output nodes render the world once per outer scoped/main draw, including same-frame and throwing paths. proof: four real installed PassNode/NodeFrame variants failed before the repair and pass after a one-shot public updateBefore guard; renderer restores authored method ownership/update mode in finally. Focused renderer/warmup/constraints/timing suites pass 131/131. Bloom world fixture passes two headed NVIDIA browser runs and desktop with complete 0/0 scoped ceilings, three cells/nine terrain tiles and no diagnostics. Fresh independent visual judge: pair 1 NEUTRAL, pair 2 NEUTRAL, overall NEUTRAL (PASS). [Immutable repair proof](https://github.com/ThreeNativeHQ/threenative-engine/tree/d68a9b20e85ba0161f115cab536409f7b6c0e762/prd616); Opus 5.5/high independently confirms FIXED, no concrete repair regression.
- [x] Every repeated scope admission contributes to the ceiling, and any missing first draw fails closed. proof: three repeated-label regressions failed before repair; timing/cache/evaluator suites now pass 64/64 and playtest typecheck passes. Each metric retains its maximum across admissions; observed requires every firstDraw. Opus 5.5/high independently confirms FIXED. Missing draws remain unobservable even if another admission passes.
- [x] Repair verification is complete. proof: root typecheck/lint/docs/budgets pass; package-test phase passes after rebuilding six native test prerequisites removed during cleanup. Root unit run: 775 files passed / 3 skipped, 10,565 tests passed / 20 skipped, but one worker exited unexpectedly in assets/compile.spec.ts; isolated recovery passes that complete file, 73/73. Every configured test file is covered across these runs; **a clean final full-wrapper exit is not claimed**. Both focused regression sets, browser/desktop bloom scenarios, independent visual judge and Opus 5.5/high repair review pass. The pre-push drift hook passes after package builds finish. Delivery: push this repair and re-enable the guarded merge queue under the user's explicit instruction; remote CI remains authoritative and unverified here.

Repair gate notes: the first full attempt stopped on missing native test executables removed during authorized cleanup; four V8/two QuickJS targets were rebuilt and the native/package checks then passed. A concurrent drift-hook attempt raced the assets package rebuild and could not resolve its entry; its sequential retry passed. Laptop full-wrapper execution could not read HEAD in its empty Git lane, and the later unit attempt was refused at 100°C; local execution supplied the checks above. No product assertion failed in the broad unit run. The unexplained worker exit is disclosed, rather than treated as a clean whole-suite pass.

### Phase 5: Repair the browser CI replay failure

**Scope:** existing replay proof hook and Playwright project only. Complexity: 1 → LOW; risk override: none. Await the initial startup before restarting for recording, and run the replay browser headed under CI's existing Xvfb wrapper. Preserve every golden movement assertion and all 1,800 ticks.

- [x] The failed golden replay test passes locally. proof: CI run `38776074371` failed all three attempts allocating the 90,000-particle storage buffer. Local headless reproduction exposed SwiftShader's `SharedImageBackingFactory` failure during the newly enabled output warm render, destroying the device; a headed control also exposed stop during pending startup. With both repairs, both unchanged browser replay tests pass under `sh scripts/xvfb.sh` (2/2, 1.9 minutes), and headed NVIDIA records/replays all 1,800 ticks identically. Root typecheck/lint and docs pass; documentation/CI contracts pass 238/238. Existing lint warnings remain nonfatal. No assertion, particle count or warm-up coverage is reduced.
- [x] Fresh Opus inspection covers the canonical real Abyss startup frames. proof: fresh read-only Opus/high inspected all 20 canonical startup PNGs from immutable proof `a8be7166d7e9525f161ad4e0cd736e7f392a8ad9`: all ten paired frames and overall **NEUTRAL (PASS)** for appearance preservation, including glow, UI, particles, lighting, camera and framing. It independently inspected both repair terrain pairs from `d68a9b20e85ba0161f115cab536409f7b6c0e762`, also NEUTRAL. The intense terrain glow is authored normal-material terrain plus fixture bloom, not a BEFORE/AFTER change; saturated probe pixels alone cannot establish real Abyss parity. Real Abyss glows are authored additive plankton, bright lamp/pearls and bloom. Startup images prove the attract screen, not later combat or input responsiveness.

#### Phase 6: Build-exit regression lock for the audio worker pool

**Status:** COMPLETE
**Scope:** `packages/create-threenative/__tests__/build.spec.ts` only. Keeps the unchanged 60s exit assertion and locks the audio worker pool reference with a persistent output assertion.

- [x] The audio-only build-exit regression is locked. proof: minimal audio-only fixture accepted (only `pickup.wav` retained); unchanged 60s exit assertion remains, followed by a persistent assertion for `cost pass audio: ran on 1 input`; original build took 28.56s locally and timed out at 60s remotely; focused build-exit test passed in 1.94s (case 853ms); the previous negative control disabling `pool?.dispose()` in the ignored assets dist timed out and dist byte restoration was verified; its output log alone could not distinguish contention from a leak. Browser remote 4/4 passed in run 38812720656; remaining remote CI is pending.

Delivery pending: the repaired candidate must pass remote CI and merge through the required squash merge queue. Required `ci-required` remains authoritative; no bypass.
