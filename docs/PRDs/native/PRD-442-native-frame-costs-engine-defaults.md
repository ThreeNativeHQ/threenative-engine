# PRD-442 — Engine defaults that stop a native game paying for what it cannot see

**Status:** NOT STARTED
**Priority:** P1 — Open ACs ship core matrixWorld "all", delete warmHiddenPasses, prove on Midway.
**Complexity:** 4 (MEDIUM)
**Owner:** Joao Paulo Furtado (play sign-off); agent (implementation)
**Depends on:** PRD-398 (the native UI cadence Phase 3 builds on; landing on `develop` through
the `fix/native-perf-salvage` PR)
POST-DEVICE-EVALUATION-REQUIRED: Joao plays native Midway on his Linux desktop after the release.

Complexity: core implementation files 1–5 (+1), a new core default convention (+1, rounded into
the module), and crossing the engine-package → game-repoint release boundary (+2) → 4 → MEDIUM;
risk override: none.

## Context

The owner's native Midway sessions (Linux, RTX 2080, KDE Wayland via Xwayland) on 2026-09-23 read
as "hiccups and a laggy HUD". The game's lane fixed its own share in ThreeNativeHQ/examples#9. Two
of the fixes it had to hand-roll are engine mechanisms that every game pays for. By the charter
gate (mechanism, no look, and the engine owns the loop and the startup warm-up) they belong in
`@threenative/core`.

Evidence sources:

- sandbox `midway-open-pacific/docs/PRDs/PRD-midway-native-smooth-20260923.md` (in progress in
  that repo);
- the hands-off native bench `midway-open-pacific/tools/bench-native.sh`: a private Xvfb, silent,
  clicks AIRBORNE START and summarises `TN_FRAME_BUDGET`, `TN_UI_*` and `TN_PIPELINE_EVENT`;
- a V8 tick profile of native flight (`TN_V8_FLAGS="--prof …"`, `node --prof-process`).

### 1. The per-frame world-matrix walk visits hidden subtrees

three's `scene.updateMatrixWorld()` recurses into every child whatever its `visible` flag. For
every moving root it multiplies world matrices for the whole subtree. That includes full-detail
bodies whose merged stand-in is showing, hidden LOD levels, and parked or hangared models.

- **Native flight profile:** `updateMatrixWorld` plus `multiplyMatrices` are **29% of all
  JavaScript ticks**.
- **Midway's hand-rolled visible-only pass:** 9,903 → 779 nodes per frame; the pass drops from
  3.1 ms to 0.3 ms median on web.
- **Where the copy lives:** `WorldView.updateVisibleMatrixWorld` plus a `beforeRender` hook in
  `src/scenes/Midway.ts`, after the scene's `matrixWorldAutoUpdate` is turned off.

The engine already made the same choice for its projected-size gate walk: `traverseVisible`,
engine PR #290.

### 2. The startup warm-up reaches only main-pass pipelines

`warmUpScene` (`packages/core/src/warmup.ts`) makes one `compileAsync(scene, camera)`. That creates
only the main-pass pipelines. Shadow-pass variants (ShadowMaterial) and reflection-pass variants
are first created synchronously on the main thread the first time an object renders in those
passes.

- **Midway, native, stock:** 107 pipelines were created after "ready" (1.37 s in total, the
  slowest 239 ms), and the bench measures 44 in flight. Frames of 415–562 ms coincide with them.
- **Midway's hand-rolled warm render** (`warmHiddenPasses`, commit `e28d31b`, under
  `ctx.startup.hold`) cut that to 22–23, but loading grew from about 8.5 s to about 23 s.
- **The native async pool:** `createRenderPipelineAsync` is a real async pool on native
  (`runtime-native/src/webgpu/bindings_pipelines.cpp`). three only routes through it inside
  `compileAsync`.

### 3. Native UI overlay (already implemented on this branch)

These commits sit on top of PRD-398's cadence code, which is unpublished:

- **`7e1e557ac`:** the snapshot no longer forces a full-page `queue_draw()` per poll; read and
  compare happen in one pass; `snapshotMs`/`readMs` timing is split.
- **`7b2dceb9f`:** hover. The page receives enter/leave/over/out and a `tn-hover` class, because
  an offscreen view has no cursor. OS presses log `TN_UI_POINTER_ROUTE:{"source":"os","hit":…}`.
- **`8adc71e80`:** consecutive moves coalesce to the latest, and a window mouse-leave clears
  hover.

Bench result (with the game fixes): HUD composite uploads went from 9/s to 14–16/s. The owner
still sees HUD lag. WebKit rasterises the page on the CPU (`hardware_acceleration_policy=Never`,
required offscreen) for every snapshot, one in flight at a time.

## Solution

1. **A visible-only world-matrix pass as the core default.**
   - Core turns off `matrixWorldAutoUpdate` on the scene it renders and runs its own pass before
     each render. It mirrors three's `updateMatrixWorld` exactly for visible objects.
   - It does not recurse into a hidden object; it marks the object stale when a forced update
     would have reached it.
   - It force-updates a stale subtree on the first frame the subtree is visible again.
   - A class that overrides `updateMatrixWorld` (three's `SkinnedMesh`, which refreshes
     `bindMatrixInverse`, and `Camera`, which refreshes `matrixWorldInverse`) runs its own
     method. A node that holds bones is walked even when hidden. Midway's first cut
     re-implemented only the base walk, and its skinned deck crew vanished (sandbox
     ThreeNativeHQ/examples#10).
   - Named override on the same config object (`renderer.matrixWorld: "visible" | "all"`, default
     `"visible"`). The count of visited nodes is reported in the existing frame telemetry.
   - Template `AGENTS.md` entry: a game that reads a *hidden* object's `matrixWorld` directly
     must use `getWorld*` or call `updateWorldMatrix(true, false)` first.
   - Midway deletes its copy.
2. **A warm-up that renders every pass once.** After `compileAsync`, core's warm-up performs one
   hidden render of the warm scene with the shadow map and each registered reflection
   (`Reflector`) pass active. Pipeline creation for those passes then goes through the async pool
   (native) or is done before first view (web), still behind the startup cover. Midway deletes
   `warmHiddenPasses`. If covering the passes needs something only the game knows (for example
   staging every fleet ship in view), core takes it as a call argument, not a Midway-specific
   rule.
3. **Land the UI overlay and close the HUD gap.**
   - Publish this branch against `fix/native-perf-followups` (it carries the PRD-398 commits).
   - Then take the HUD from ~15 to ≥ 30 uploads/s without changing its pixels. Measure first:
     split `snapshotMs`/`readMs` with `TN_UI_SNAPSHOT_TRACE=1`. Candidates:
     - pipelining two snapshots with request ids and latest-wins publication;
     - a cheaper capture path.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: A core unit test, red then green: a visible mesh under a hidden
  parent is not visited, and its world matrix is exact on the first frame the parent is shown
  again after its ancestor moved. Visible matrices equal three's `updateMatrixWorld` output. A
  `SkinnedMesh` whose armature sits under a hidden node still draws with fresh bones and a fresh
  `bindMatrixInverse`, and a `Camera` in the scene gets a fresh `matrixWorldInverse`: any class
  that overrides `updateMatrixWorld` runs its own. —
  Evidence: pending.
- [ ] AC-2 [local; actor: agent]: `renderer.matrixWorld: "all"` restores three's walk, and the
  frame telemetry reports visited nodes both ways. The capability manifest and template
  `AGENTS.md` carry the convention. The engine gates `pnpm typecheck && pnpm lint && pnpm test`
  pass apart from the failures already present on this base. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: Midway on the new core tarball has **no** hand-rolled matrix
  pass; `updateVisibleMatrixWorld` and its `beforeRender` hook are deleted. The native flight
  V8 profile's `updateMatrixWorld` + `multiplyMatrices` share falls from 29% to ≤ 5%, and
  `compare-frames` PASSes. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: Midway on the new core with `warmHiddenPasses` deleted: the
  native bench reports `pipelinesAfterStart` = 0 over a 150 s flight, and "ready" is no later
  than stock + 3 s (stock ≈ 8.5 s on the same host). — Evidence: pending.
- [ ] AC-5 [shared; actor: agent → engine CI]: The UI overlay commits merge through a PR against
  the PRD-398 line, with the `ui-overlay` `cargo test` (24 passing locally) and the runtime build
  green in CI. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: The native bench HUD composite uploads/s in flight are ≥ 30,
  from 14–16 today, with the HUD pixel-identical. — Evidence: pending.
- [ ] AC-7 [owner; actor: Joao]: Plays native Midway built on the released core and runtime and
  confirms no freezes and a HUD that keeps up. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Visible-only matrix pass | Core frame loop → before `renderer.render` for every game | three's `scene.updateMatrixWorld` walk (override `"all"`); Midway's `updateVisibleMatrixWorld` is deleted | AC-1–3 |
| All-pass warm-up | Core startup warm-up behind the startup cover | Main-pass-only `compileAsync`; Midway's `warmHiddenPasses` is deleted | AC-4 |
| Native UI overlay snapshot and pointer | Runtime `ui-overlay` (`offscreen.rs`, `lib.rs`), `window.cpp` | Forced redraw per poll; press-only injection | AC-5, AC-6 |

## Execution Phases

#### Phase 1: Matrix pass default
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3
**Files:** `packages/core/src/` (the frame/render step that calls `renderer.render`, plus a new
`matrix-world.ts`), `packages/core/__tests__/`, the capability manifest, template `AGENTS.md`;
sandbox Midway `src/render/world.ts`, `src/scenes/Midway.ts`.
**Verification:** E1: red-green unit test; engine gates; pack a hash-named tarball; Midway repoint
plus `compare-frames` and a native V8 profile.
**Checkpoint:** pending

#### Phase 2: A warm-up that covers every pass
**Status:** NOT STARTED
**ACs:** AC-4
**Files:** `packages/core/src/warmup.ts` (+ unit test); sandbox Midway `src/render/world.ts`,
`src/scenes/Midway.ts`.
**Verification:** E2: native bench (3 interleaved pairs) — `pipelinesAfterStart`, ready time.
**Checkpoint:** pending

#### Phase 3: UI overlay landing and HUD ≥ 30/s
**Status:** IN PROGRESS
**Progress:** the three overlay commits are implemented and locally tested (24 `cargo test`
pass); the PR is opened against the PRD-398 line.
**ACs:** AC-5, AC-6
**Files:** `packages/runtime-native/native/ui-overlay/src/offscreen.rs`, `lib.rs`,
`src/platform/window.cpp`, `ui_overlay.cpp`.
**Verification:** E3: CI on the PR; native bench `uiUploadsMedian` with `TN_UI_SNAPSHOT_TRACE=1`.
**Checkpoint:** pending

#### Phase 4: Release and play
**Status:** NOT STARTED
**ACs:** AC-7
**Verification:** E4: the owner plays a native build with `VITE_MIDWAY_FPS=1` (FPS panel on).
**Checkpoint:** pending
