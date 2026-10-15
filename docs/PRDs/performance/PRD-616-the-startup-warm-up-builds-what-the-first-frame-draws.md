# PRD-616 — The startup warm-up builds what the first frame draws

**Status:** IN PROGRESS
**Priority:** P1 — AC-1 to AC-3 are open: a measured warm-up rebuilt 3 of 3 warmed node graphs and created their 3 render pipelines again in the first visible frame, a startup cost on every supported platform.
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

- [ ] AC-1 [local]: On abyss-framework with `warmUp: {}`, the pipeline census reports 0 node builds and 0 render-pipeline creations for warmed objects between warm-up settled and the end of frame 5. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/warm-up-reuse.playtest.json --url http://127.0.0.1:5180 --server-command "pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5180 --strictPort" --browser-recipe webgpu --headed` — Evidence: pending.
- [ ] AC-2 [local]: The first-frame CPU time on that run falls from the 29–30 ms baseline, and the median of three runs is recorded in the PRD. proof: the same scenario's frame-budget report — Evidence: pending.
- [ ] AC-3 [local]: A streamed chunk's first draw creates 0 render pipelines after its chunk warm-up settles. proof: `examples/abyss-framework/playtests/streaming.playtest.json` with the new census assertion — Evidence: pending.
- [ ] AC-4 [local]: The first visible frame is unchanged. A visual judge subagent rates BEFORE/AFTER frame 1 to 5 captures NEUTRAL or IMPROVEMENT. proof: two headed `--browser-recipe webgpu` runs per arm, judged per the root `AGENTS.md` rule — Evidence: pending.
- [ ] AC-5 [local]: The native desktop host passes the AC-1 scenario. proof: the AC-1 command with `--target desktop` — Evidence: pending.

## Blocked on

- The launch-time gain on a real device (Bayview on the Pixel 8, PRD-360's 96-program lane). Unblocked by the owner granting the shared Pixel; ask, do not declare it blocked.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Startup warm-up targets the world pass | `defineGame` boot → `warmUpScene` (`game.ts:1229`, `game.ts:2133`) → output pipeline path | depth-0 canvas compile kept only when no output pipeline is set | AC-1 |
| Streamed chunk warm-up targets the world pass | `WorldCells` chunk attach → `#warmChunk` (`world-cells.ts:9877`), cell proxy (`world-cells.ts:9530`) | calls the same core entry point | AC-3 |
| Census boundary at warm-up settled | playtest observations `pipelineCensus` → new assertion | extends `pipeline-summary.ts` (today it splits only at first present) | AC-1, AC-3 |

## Execution Phases

#### Phase 1: The census sees the rebuild (red)

**Status:** IN PROGRESS
**Files:** `packages/core/src/pipeline-census.ts` (warm-up-settled boundary on each event), `packages/playtest/src/runner/pipeline-summary.ts` and its scenario schema/evaluator (assertion on builds and creations after warm-up), `examples/abyss-framework/playtests/warm-up-reuse.playtest.json`.
**Implementation:** Today's census flags only `beforeFirstPresent`, and frame-1 rebuilds land before the first present. Add a warm-up-settled boundary and count node builds and pipeline creations after it, per material. The assertion fails closed when the census is absent or incomplete.

- [ ] The new scenario runs red on develop and reports 3 rebuilt graphs and 3 new pipelines. proof: the AC-1 command, plus `pnpm exec vitest run packages/playtest/__tests__/pipeline-timing.spec.ts packages/core/__tests__/pipeline-census.spec.ts` — Focused census, schema, evaluator and warm-up tests passed locally on 2026-10-14: 5 files, 141 tests; valid headed red reproduction remains pending because the shared capture lock is occupied (attempts exited 75 with `LOCK TIMEOUT`).

#### Phase 2: The warm-up compiles against the world pass (green)

**Status:** IN PROGRESS
**Files:** `packages/core/src/warmup.ts`, `packages/core/src/renderer.ts` (expose the world-pass compile entry point beside `renderFrame`), `packages/core/src/game.ts`, `packages/core/src/world-cells.ts`, `packages/core/__tests__/warmup.spec.ts`.
**Implementation:** Measure option 1 against option 2 from Solution on the AC-1 scenario and record the choice under `## Decisions`. Route all three warm-up callers through it. Keep the no-output-pipeline path unchanged.

- [ ] AC-1 and AC-2 are green. proof: the AC-1 command, three runs
- [ ] AC-3 is green. proof: the streaming scenario
- [x] A renderer without an output pipeline warms exactly as before. proof: `pnpm exec vitest run packages/core/__tests__/warmup.spec.ts` — 34 tests passed locally on 2026-10-14.

#### Phase 3: Prove the look and the native host

**Status:** NOT STARTED
**Files:** none expected; fixes go back to Phase 2 files.

- [ ] AC-4 judge verdict is recorded, with the images on the PR. proof: visual judge subagent
- [ ] AC-5 is green on the desktop host. proof: the AC-1 command with `--target desktop`

## Decisions

- API precheck (read-only, not runtime proof): stock Three r185 `PassNode.compileAsync` sets its target/MRT, but `Renderer.compileAsync` chooses a render context without a call-depth argument (default 0). `RenderPipeline.render` also temporarily sets output color space/tone mapping around the quad draw. These facts suggest the preferred compile-only path may still miss real-frame reuse; Phase 2 must measure it against the covered real-render fallback before choosing. No Three.js patch change is authorized.
- Implementation checkpoint 2026-10-14: the shared warm-up entry point now attempts the stock output-pass compile and covers the output pipeline render; startup, chunk, and cell callers use it, while no-output renderers retain the existing compile path. The real-WebGPU comparison and final choice remain pending until the capture lock clears.
