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
- [ ] AC-2 [local]: `WorldCells.whenSpawnReady` gates the preview's spawn, and the example's readiness module is deleted. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-data.spec.ts` plus `test:terrain:web` — Evidence: pending.
- [ ] AC-3 [local]: Scatter runs in the bake, and `enter` does no scatter work. proof: `test:terrain:web` asserting no long task over 50 ms during `enter` — Evidence: pending.
- [ ] AC-4 [local]: Ground plumbing uses `loadTerrainSplat`, and height bands come from the world's measured range. proof: `test:terrain:web` — Evidence: pending.
- [ ] AC-5 [local]: A fresh visual judge rates the before/after captures of all five kits NEUTRAL or IMPROVEMENT (same pose, headed WebGPU, two runs per arm). proof: judge verdict and images on the PR — Evidence: pending.

## Execution Phases

#### Phase 1: one prop pipeline
**Status:** NOT STARTED
- [x] Ladder deleted; editor on streamed props. proof: editor script + count-loc (see AC-1 evidence)

#### Phase 2: readiness and scatter
**Status:** PARTIAL
- [ ] Spawn readiness in `WorldCells`. proof: spec + web playtest
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
- [ ] Scatter off the `enter` path. proof: web playtest long-task assertion

#### Phase 3: ground and look check
**Status:** NOT STARTED
- [ ] Engine splat plumbing, measured bands. proof: web playtest
- [ ] Visual judge passes. proof: judge verdict on the PR

Parent review of the native gate found and corrected caller-material ownership: all three fixtures dispose their surfaces, including rejected loads. After the correction, parent inspected the fresh selected web/desktop reports and direct native log: both selected rows pass, no GPU validation errors, desktop image metrics are zero, and both readiness/hash markers appear. Parent reran the focused Node fingerprint spec (3/3 passed, 7.18 s), scoped Biome passed, and documentation links passed. Caller migration and full runtime/visual acceptance remain open.
