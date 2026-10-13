# PRD-591 — The preview stops re-implementing engine mechanisms

**Status:** PARTIAL
**Priority:** P2 — A second prop LOD pipeline, a spawn-readiness gate and the scatter loop stay in example code where every terrain game must copy them (AC-1 to AC-4).
**Complexity:** 6 (MEDIUM); risk override: visual output changes, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-585](PRD-585-strata-proof-runs-in-ci.md) (the CI job guards the moves)
**Epic:** [Strata terrain hardening](README.md)

## Context

Example audit of `2d2124792` (2026-10-10), `examples/strata-terrain-preview/src/render/`:

- `props.ts:119, 627, 798-897` hand-writes an LOD ladder (`LOD_BANDS`, `levelFor` with
  hysteresis, `setLevels`, one `InstancedBatch` per variant, level and role). The game path
  (`game.ts:736`) already uses `createStreamedProps` on `WorldCells`; only `editorView.ts:766`
  calls `createProps`. Two prop pipelines exist, and `packages/terrain/__tests__/prop-lod.spec.ts`
  (647 lines) tests the older one.
- `loading.ts:69-193`: `createSpawnReadiness` / `spawnReadinessSnapshot`, a spawn gate every
  streamed terrain game repeats.
- `scatter.ts:299-340`: the rejection-sampling loop and spacing grid repeat for every terrain
  game. Per-biome magic numbers (`treeLimit` 3200/600/55/0, `spruceAttempts: 80000`,
  `scatter.ts:563-568`). It runs synchronously in `enter` (`game.ts:591`), not sliced.
- `terrain.ts` (1191 lines; `createGroundMaterial` about 430) does not use `loadTerrainSplat`,
  which `packages/terrain/starter/forest/world.ts:4, 121` already uses. Height bands are constants
  (`SNOW {145,195}`, `SHORE {7.5,1}`) instead of values measured from the world's height range.
- `propMaterials.ts` (1131) and `pack.ts` (838) each define wind, foliage tint and cutout; `pack.ts:144`
  and `propMaterials.ts:282-310` repeat the wind hash.

Mechanism (pooling, LOD, culling, streaming, readiness) belongs in `packages/core`; appearance
stays in game `src/render/` (root `AGENTS.md`, "Where a change goes").

## Solution

The editor view uses the streamed prop path; delete the ladder and its spec. Move spawn readiness
into `WorldCells` as `whenSpawnReady(position)`. Ship a generic `scatter(rules)` in
`@threenative/terrain` and keep rules in game source; run it in the bake, not in `enter`. Compare
the hand-written ground against `loadTerrainSplat` under the visual judge and keep the plumbing
from the engine. Derive height bands from the measured height range. One `foliageSurface()` for
both material paths.

## Acceptance Criteria

- [x] AC-1 [local]: The editor draws props through the streamed path, and `levelFor`/`setLevels` are deleted. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` plus `count-loc.ts` — Evidence: 2026-10-12, NVIDIA Turing, private Xvfb. The editor view draws through `createStreamedProps`; `levelFor`, the `propWork` ladder, `createProps` and `createPropsInSlices` are deleted from `props.ts` (10 files, 641 lines removed, 412 added, net -229). `test:terrain:editor` passes before and after (terrain edits 707 to 747 ms). The editor viewport is pixel-identical in four views (mean absolute RGB difference below 2e-6, 0% of pixels over 8; 100 placements, 200 parts, 390,800 triangles each), so no pixel reached the screen differently and no visual judge ran. 88 of 88 preview tests pass; typecheck and Biome pass; `count-loc.ts --check` passes. `check-temperate.mts:45` keeps one tree-scale assertion that already failed before this change, and its streamed section passes on its own.
- [x] AC-2 [local]: `WorldCells.whenSpawnReady` gates the preview's spawn, and the example's readiness module is deleted. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-data.spec.ts` plus `test:terrain:web` Evidence: 2026-10-12, NVIDIA Turing, private Xvfb. `spawnReadinessSnapshot` and its helpers are deleted from `render/loading.ts` (112 lines) and prop streaming's `readinessAt` and `ready` are gone (22 lines); `game.ts` gates on `WorldCells.whenSpawnReady(spawn, 60)` for nearby prop cells and on prewarm for drawing, and terrain plus its collider exist before preparation starts. Seven files, 147 added and 263 removed (net -116). A deliberately premature gate failed the new regression in `world-cells-data.spec.ts` and `strata-loading.spec.ts`, then passed; terrain and preview suites pass 445 of 445. Forest `test:terrain:web` is 41 of 44 before and after: the only failures are the known budgets `afterFirstFrameTaskMs`, `timeToReadyMs` and `maxViewGpuMs`; the spawn assertions pass (6 of 6 spawn cells, grounding, empty loading error).
- [x] AC-3 [local]: Scatter runs in the bake, and `enter` does no scatter work. proof: `test:terrain:web` asserting no long task over 50 ms during `enter` Evidence: 2026-10-12, NVIDIA Turing, private Xvfb, forest, two runs per arm. Measured phases of the old `enter` (ms, run 1 / run 2): terrain mesh 272 / 286, `scatterProps` 355 / 353, `paintCanopy` 7.5 / 7.6, fallback variants 72 / 69, setup, sky and rivers under 40; `enterMs` 764 / 782. Scatter and canopy now run in `scripts/bake.mjs` and `enter` loads a Float32 placement table per world (`src/world/<world>.placements.bin`, gitignored like the other baked world files, regenerated by `pnpm bake`, which `dev` and `build` run; sizes forest 8.1 MB, coastal 5.5 MB, tundra 1.7 MB, alpine and desert 0.4 MB; zero tracked binary growth). Placement lists, order, counts and `paintCanopy` arrays are SHA-256 identical to HEAD in all 5 worlds. After: forest `enterMs` 34.8 / 35.1 ms (forest-scoped runs). Re-measured on the full `test:terrain:web` scenario (all five worlds, six visits): coastal's `enter` was 218 ms (first visit) and 137 ms (return) because the water mesh was built inside `enter` (106 / 159 ms). `load()` now prepares the ocean and water mesh and `enter` only attaches them (`game.ts`, +8/-4). After, one full run: `enterMs` was 10 to 45 ms in every visit (largest 45 ms, so the 50 ms assertion has a thin margin under load) and the `enterMs` assertion passes; the arm's own first candidate run crashed the page while another process held 8 GB of RAM and did not reproduce on the rerun, so treat the fix as one clean full run. Failed assertions: only `afterFirstFrameTaskMs`, `timeToReadyMs`, `maxViewGpuMs`; no `diagnostics` failure and no destroyed-texture errors in that run; `component.player.visible.value.atSteps` passed (it failed in two earlier loaded runs and passed in two others, so it is load-dependent). Coastal player view before/after mean absolute difference 0.1 against a noise floor of about 2.0. Not improved: `afterFirstFrameTaskMs` went 482 / 488 to 597 / 787 ms and `timeToReadyMs` 27.1 / 26.3 to 28.4 / 27.1 s, both still failing their budgets (the host was loaded, so read these as no gain, not as proof of a regression); the largest remaining single tasks are in `buildProps` (asset load 351 to 378 ms, surfaces 131 to 136 ms) and the terrain mesh build (272 to 286 ms). `maxViewGpuMs` unchanged. Loader tests (round trip, truncated file rejected) failed first; 438 tests pass; `check-water` passes. Native not run: `stage-native-assets.mjs` now stages the tables for desktop and the desktop lane was not executed, so no native claim.
- [ ] AC-4 [local]: Ground plumbing uses `loadTerrainSplat`, and height bands come from the world's measured range. proof: `test:terrain:web` — Evidence: pending.
- [ ] AC-5 [local]: A fresh visual judge rates the before/after captures of all five kits NEUTRAL or IMPROVEMENT (same pose, headed WebGPU, two runs per arm). proof: judge verdict and images on the PR — Evidence: pending.

## Execution Phases

#### Phase 1: one prop pipeline
**Status:** NOT STARTED
- [x] Ladder deleted; editor on streamed props. proof: editor script + count-loc (see AC-1 evidence)

#### Phase 2: readiness and scatter
**Status:** PARTIAL
- [x] Spawn readiness in `WorldCells`. proof: spec + web playtest Done 2026-10-12, see AC-2 evidence.
  - Engine helper implemented; caller and native closure remain open: `WorldCells.whenSpawnReady(position, radius = 0, timeoutMs = 120_000)` in
    `packages/core/src/world-cells.ts`, built on `readinessAt` as the only authority. It snapshots
    the position, observes held waiters at the end of the existing `update` after admissions, and
    settles on readiness, asset failure, disposal and its finite deadline, clearing the timer and
    the waiter on every settlement. proof: `pnpm exec vitest run
    packages/core/__tests__/world-cells-data.spec.ts packages/core/__tests__/world-cells-admission.spec.ts
    packages/core/__tests__/world-cells-terrain.spec.ts packages/core/__tests__/world-cells.spec.ts`
    — parent run: 97/97 passed in 52.94 s. The oversized `2**31` deadline first reproduced
    Node timer overflow, then passed with the supported `(0, 2147483647]` ms bound.
    Disposal clears the timer; unsettled test polling fails closed. Earlier core typecheck/build
    (publint) passed; the parent core typecheck after the bound correction also passed (exit 0).
  - Caller migration implemented, runtime acceptance still open: the preview and five kit fixtures
    join `WorldCells.whenSpawnReady` with every stream's `prewarmed` promise. One entry deadline
    covers preparation and admission; cancellation, late settlement and pre-props failure capture
    remain guarded. The old `createSpawnReadiness` helper is deleted; loading UI and bounded failure
    receipts remain. Timeout failures update UI state immediately. Empty kit failures receive a
    nonempty kit label and cannot be overwritten by late success or another failure.
    Parent reproduced the empty-error defect in four kits, corrected Forest's VM setup, then ran
    the actual-source loading tests: 31/31 passed (1.08 s); the focused outstanding-world-load test
    also passed (other nine tests skipped). Terrain typecheck and direct preview `tsc --noEmit`
    passed. Scoped Biome and `git diff --check` passed. The web playtest, all-kit runtime captures
    and caller full native-matrix proof remain unverified; this box stays open.
    A subsequent `test:terrain:web` attempt exited 1: framework startup reached ready, but the
    headed WebGPU recipe selected SwiftShader, then reported device loss and a blank forest
    capture. Eleven assertions failed; this is not render or performance evidence. The captured
    adapter was read from that attempt's `capture.json`; the retained run log is
    `591-preview-web.out` in the coordinator cache.
    Environment diagnosis found loaded NVIDIA kernel driver 615.71.09 against NVML userspace
    615.78.08 (`nvidia-smi` exit 18). The laptop refused offload at 99°C. Hardware qualification
    was restored with process-local matching cached libraries: `nvidia-smi` reports
    RTX 2080 / 615.71.09. A fresh headed `world-terrain-inline-hash` selected case passed
    in 4.8 s on NVIDIA/Turing, with no page or GPU validation errors and a nonuniform capture
    (`packages/runtime-native/artifacts/strata591-matching-driver-web/report.json`).
    The harness exited 2 because 102 unselected cases are blocked; this proves only the selected
    case. No system driver change, assertion change or budget change was needed. Full preview
    and all-kit qualification remain open.
    The matching-driver full preview rerun reached visible forest, coastal and alpine captures,
    then hit the external 720 s deadline (exit 124 / SIGTERM) before a final assertion report.
    It does not prove runtime budgets or all-kit success. The fresh forest smoke screenshot is
    [attached to the EPIC PR](https://github.com/ThreeNativeHQ/threenative-engine/pull/483#issuecomment-6106317255),
    labelled with performance and visual comparison still pending. Documentation checks passed:
    3,057 links across 1,360 Markdown files, plus all 252 tests across the six prose-lane specs.
  - Native availability corrected: the linked checkout has no `third_party/` or `build/` of its own,
    and the primary owning checkout already ships
    `packages/runtime-native/build/tn-linux-wgpu/mystral` (also `tn-linux-jsprofile` and
    `tn-linux-contracts-physics`). That existing binary proves the gate on the desktop lane. It is
    not a new C++ build and not a whole-source or full native-matrix qualification.
  - Gate component landed in the existing `world-terrain-inline-hash` scene as
    `assertSpawnReadiness()`. It drives the real `WorldCells` over one decoded empty-run cell (no
    fetch, no GLTF, no browser global), and asserts a region outside the ring that pends, the
    admitting `update` that settles it for its snapshot, one-shot success, disposal rejection and a
    finite `25 ms` deadline, before the frame renders. proof: selected row
    `--target <web|desktop> --only-tests world-terrain-inline-hash`.
    - Parent review found the caller surface leaked: `readinessWorld` made a `MeshBasicMaterial`
      per load and `WorldCells.dispose` never released a caller surface. Fixed by returning
      `{ world, surface }`, disposing the surface in all three callers' `finally` and on a rejected
      `load`; same geometry hash and render tree.
    - Node: `packages/runtime-native`, `pnpm exec vitest run --config vitest.config.ts
      tests/terrain-inline-jobs.test.mjs` — 3/3 passed, pinned hash unchanged.
    - Web: pass, 3.0 s, hardware adapter `nvidia/turing`, no page errors, capture non-uniform;
      fresh report `packages/runtime-native/artifacts/strata591-cleanup-web/report.json`.
    - Desktop: pass with the primary binary through `THREENATIVE_RUNTIME_BINARY`, 15.5 s,
      `pixelMismatchRatio` 0, `perceptualDeltaE` 0, native exit 0, runtime SHA-256
      `b756382651baf8347434bdde63cae1b789d126f24f65d2c58ee11e16811ce23e` (unchanged); fresh report
      `packages/runtime-native/artifacts/strata591-cleanup-desktop/report.json`. The report keeps
      only the last 4000 bytes of native stdout, so a direct run of the same bundle printed
      `TN_WORLD_SPAWN_READINESS pending=resolve dispose=reject timeout=25ms` beside
      `TN_TERRAIN_INLINE_HASH hash=d138e335 ... expected=d138e335`
      (`artifacts/strata591-cleanup-desktop/direct-native.log`).
    - Still open under this box: caller runtime verification, its web playtest and the full
      native-matrix claim. The selected native row proves the engine gate component only.
- [x] Scatter off the `enter` path. proof: web playtest long-task assertion Done 2026-10-12, see AC-3 evidence (enter 764 to 35 ms).

#### Phase 3: ground and look check
**Status:** NOT STARTED
- [ ] Engine splat plumbing, measured bands. proof: web playtest
- [ ] Visual judge passes. proof: judge verdict on the PR

Parent review of the native gate found and corrected caller-material ownership: all three fixtures dispose their surfaces, including rejected loads. After the correction, parent inspected the fresh selected web/desktop reports and direct native log: both selected rows pass, no GPU validation errors, desktop image metrics are zero, and both readiness/hash markers appear. Parent reran the focused Node fingerprint spec (3/3 passed, 7.18 s), scoped Biome passed, and documentation links passed. Caller migration and full runtime/visual acceptance remain open.

2026-10-12 coastal stone contact: the remaining thin tan rim is removed by explicitly casting the front-facing stone surface in both procedural and imported coastal material paths (four added lines in `propMaterials.ts`/`pack.ts`). CPU rays through the actual transformed fallback rock confirm terrain contact and sunlight obstruction; AO-off, haze-off and MSAA-off probes leave the defect unchanged. Two exact-pose BEFORE/AFTER headed WebGPU runs report NVIDIA/Turing. Fresh read-only visual judge: **IMPROVEMENT for pair 1, pair 2 and overall**; the tan underside contour disappears with texture/top shading retained and no visible new acne or halo. The deepest contact pixels merge into shadow, and AFTER 1 is sharper globally; pair 2 independently supports the contact improvement. Imported coastal materials receive the same override but were not visually captured. Existing material/LOD/shadow specs pass 35/35; scoped Biome and diff check pass. The full terrain scenario completes with 60/63 assertions passing; the existing three runtime budgets fail (see run below), so this does not close the five-world AC-5 gate.

Judged captures, pinned on orphan `strata-hardening-screenshots` commit `0611cc9809b287eac1b0969934e5f799ed082305` (all four public URLs return HTTP 200 and byte-match the captures): [BEFORE 1](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/0611cc9809b287eac1b0969934e5f799ed082305/pr483/stone-shadow-side-before-1.png), [AFTER 1](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/0611cc9809b287eac1b0969934e5f799ed082305/pr483/stone-shadow-side-after-1.png), [BEFORE 2](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/0611cc9809b287eac1b0969934e5f799ed082305/pr483/stone-shadow-side-before-2.png), [AFTER 2](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/0611cc9809b287eac1b0969934e5f799ed082305/pr483/stone-shadow-side-after-2.png).

Full terrain rerun (2026-10-12, stone source `60e16086d`, headed NVIDIA/Turing): the official `terrain.playtest.json` completed with **60/63 assertions passing**, exit 1. Console/network/runtime-diagnostic policy passes. Open budget failures are `afterFirstFrameTaskMs` 2,273 >250 ms, `timeToReadyMs` 52,877.5 >15,000 ms, and `maxViewGpuMs` 47.92 >12 ms. Navigation/server deadlines were 120/600 seconds to permit infrastructure startup; assertion budgets were unchanged. This full failure remains acceptance work, not a green scenario claim. Existing harness artifacts: `examples/strata-terrain-preview/artifacts/playtest/web`; exact output `/tmp/pr483-final-terrain-web.log`.

Startup attribution (2026-10-12, source `4dd84d084`): shipped `playtest trace --no-wait --settle 0.001 --seconds 90 --no-input --stall-ms 250` captured 342,821 events on NVIDIA/Turing. Host display `:0` was unavailable; the diagnostic used private headed Xvfb, so frame rate is suppressed and the CLI correctly exits 1 (`TN_TRACE_VIRTUAL_DISPLAY`). This is function attribution, not acceptance or a performance win. Fifteen main-thread tasks exceed 250 ms, largest 1,608 ms. Across the sampled 90,234 ms, `updateAttribute` uses 7,525 ms self time and Three's instanced `updatePrevious` 7,346 ms; graph child traversal and bundle-safety snapshots are also material. These whole-window totals do not identify the single startup task's cause; inspect individual long-task stacks before choosing a fix. No budget, render stage or quality setting changed. Raw diagnostic: `/tmp/pr483-startup-trace.json`; summary is in the local long-running-task cache. Scene doctor separately reproduces non-finite `entities[1].bounds.height`; exact object/projection instrumentation is pending.

Ground-loader prerequisite (2026-10-12): `ITerrainSplatLayer.maps` now accepts optional package-relative diffuse, normal, ORM and height paths, preserving existing filename defaults and presence flags. This lets the preview reuse its current `_diff_1k.jpg` / `_nor_gl_1k.jpg` maps without duplicate image aliases. Explicit null/malformed paths or containers reject, and missing explicit maps propagate failure without fallback. The existing `terrain-splat-array` conformance fixture exercises all four overrides with unchanged image data. Actual-source tests reproduced the path mismatch before the change; the parent rerun passes 29/29 focused loader tests. Core TypeScript, fixture syntax and scoped Biome pass (one existing unrelated complexity warning). Browser/native fixture execution is pending. AC-4 remains open: bake/Vite/native staging must emit the real descriptor/table/raw splat, and the consumer must reuse the engine blend while preserving game-authored sampling and measured height bands. No preview material or assertion budget changed in this prerequisite.
