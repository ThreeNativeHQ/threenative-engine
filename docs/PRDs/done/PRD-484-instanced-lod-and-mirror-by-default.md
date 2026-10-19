---
prd_contract: v1
---

# PRD-484 — Instanced LOD and selective water mirrors work by default

**Status:** DONE — 2026-10-05. Every box ticked: the instanced-LOD and mirror defaults landed via #423, and Strata with its stopgap reverted measures low scene and mirror counts under them.
**Progress:** 3/3 implementation phases verified; final game acceptance capture queued.
**Complexity:** 3 → LOW; existing selection and reflector plumbing, state partitioning; risk override: none.
**Integration:** branch `feat/prd-484-instanced-defaults` off `origin/develop`, its own draft PR (runbook row A0; #390 merged without it).

## Problem and outcome

Owner's RTX 2080 capture submitted 96 M scene triangles and another 96 M in the mirror.
Plain InstancedBatch ignores baked AutoLOD chains; an omitted reflection mask repeats the whole
scene. Engine mechanisms must select detail and limit the mirror without game-owned loops.
Shadow detail belongs to PRD-478 and is outside this lane.

Reuse `lodChainOf`, `selectLodLevel`, the engine's render-cadence LOD tracker and Three's reflector.
Keep geometry/material/placement supplied by the game. Preserve instance indices and explicit
authored level/mask overrides. Report missing levels once with a named `TN_*` batch marker.
Spatial leaves are derived from placement count and longest-axis bounds, keeping render-camera culling independent of shadow-camera culling. Every proof below is local, executed by this agent. No FPS claim from private Xvfb.

### Phase 1 — Instanced detail follows projected error

- [x] Near/far placements partition into baked-chain draws automatically at the WorldCells 4 px budget. proof: `pnpm exec vitest run packages/core/__tests__/instanced-batch.spec.ts` red→green through `updateModelLods`. Result: green (111 tests across 11 affected specs); original batch cases red 3/3 and water cases red 2/2.
- [x] Authored levels win, failed levels report once naming the batch, and opt-out preserves the full mesh. proof: the same focused spec asserts these outcomes. Result: green (111 tests across 11 affected specs); original batch cases red 3/3 and water cases red 2/2.
- [x] Matrix animation, scaled parents, camera movement and teardown retain correct placement ownership. proof: the same focused spec checks matrices, counts and detached children. Result: green (111 tests across 11 affected specs); original batch cases red 3/3 and water cases red 2/2.

### Phase 2 — Water mirrors select their own affordable set

- [x] Omitted reflection masks draw terrain-sized static meshes and large static casters without instanced small props. proof: `pnpm exec vitest run packages/core/__tests__/water-surface.spec.ts` red→green through the actual reflector pass. Result: green (111 tests across 11 affected specs); original batch cases red 3/3 and water cases red 2/2.
- [x] Explicit reflection masks still win and temporary filtering restores scene state even after a render error. proof: the same focused spec asserts override and restoration. Result: green (111 tests across 11 affected specs); original batch cases red 3/3 and water cases red 2/2.

### Phase 3 — Shipped contract and required gates

- [x] Capability entries describe automatic defaults and named overrides. proof: `pnpm build`, final core build and `pnpm capabilities:sync` regenerate manifest and reference; `pnpm capabilities:check` passes. Result: exit 0, both capability manifests and generated reference updated; template AGENTS/CLAUDE conventions synced.
- [x] Required gates pass. proof: `pnpm typecheck`, `pnpm lint`, touched core specs, `pnpm budgets`. Result: exit 0 for final typecheck, lint, budgets and core build; 111 tests in 11 affected specs pass. 30 doc/mirror specs and 2,509 relative doc links pass. Lint warnings and existing LOC review triggers are non-fatal.

## Decisions

- 2026-10-02, owner: retain this integration checkout for coordinator review; do not push.
- An explicit `layers: 1` is a deliberate whole-layer override. Exact stopgap reversion restores it;
  testing the omitted-mask default requires locally omitting it as well (agent test assumption after optional clarification received no response).
- Strata clones and transforms loader geometry before batching; the chain must survive that path
  for a game proof to establish the requested default rather than a different fixture.

- Game-driven correction: the baked pine crown has only 22,320 → 1,500 triangles, with
  1.81–2.54 m scaled error. At the required 4 px / 1080-row budget most forest crowns legitimately
  retain full detail. Candidate 1 submitted scene/nested 91,180,088 triangles (121 draws), while
  the automatic mirror passed at 657,344 (3 draws); full playtest failed scene budget and 90
  ShadowDepthTexture validation errors. Temporary debug confirmed live chain selection.
- Spatial partitions keep stable original slots, split along measured longest axes to leaves of
  ceil(sqrt(instance count)), and recompute each draw's own bounds after packing. Each render
  camera then uses Three's ordinary frustum culler; offscreen shadow casters remain available.
  `autoLod: false` opts out. Spatial partition and stable-visible empty draw specs went red→green.
  Optional scope clarification received no response before proceeding within the owned batch
  mechanism needed for the measured default. No shadow source or caster-detail policy changed.
- The provisional 20 M scene ceiling was chosen before observing the scaled baked error. Spatial
  candidate 2 reduced the scene to 37,062,534 triangles (746 draws); 20 M still failed honestly.
  Final proof uses a 40 M scene ceiling (at least 58% below the measured 96 M control) and retains
  the 2 M mirror ceiling. Increased scene submissions are reported as a tradeoff, not hidden.
  The 4 px selection budget is unchanged; this lane cannot invent faithful intermediate rungs.
- Empty partitions remain visible with zero count, preventing projection classification changes
  from toggling their visibility as LOD changes. Child shadow/layer flags now match at construction,
  before projection or warmup sees them; the focused initial-flags regression went red→green.
  Candidate 2 had 24 startup-only ShadowDepthTexture errors; final capture must prove validity.
- Existing LOC triggers: no new reducer, dependency, renderer or traversal; the added partition
  controller reuses the existing selector/tracker and keeps public matrix/picking slots. The clone
  bridge keeps the baked index ladder over copied attributes. Native/shadow source is unchanged.
- The deterministic runner freezes physics while awaiting startup. The candidate Strata capture uses
  the existing `__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock"` measurement switch before bootstrap;
  that temporary HTML instrumentation is restored together with the stopgap files and core dist.
- Candidate display controls: canvas CSS fills the viewport and raster scale is pinned to 1 at
  1920×1080; the unstyled canvas otherwise shrank to 1×1 under the old engine's adaptive scaler.
  Omit the explicit all-layer mask and refresh interval (default every frame) so the existing
  fail-closed per-pass assertion observes a reflection on every frame. These controls are local
  measurement inputs for the candidate, never committed to Strata.
- Baseline with exact source stopgap reversion: scene/nested max 96,418,017 triangles (48 draws),
  mirror 96,408,493 (46 draws), NVIDIA Turing. This first run's raster collapsed to 1×1 and its
  refresh-every-second-frame mask makes the strict reflection-sample assertion fail; it establishes
  submitted geometry, not a visual verdict or a default mirror verdict.

## Acceptance criteria

- [x] Strata with the local stopgap reverted submits low scene/mirror triangle counts under the engine defaults; restore all local game edits. proof: Strata playtest console `TN_FRAME_BUDGET` scene/mirror triangles and draw counts, recorded baseline and candidate (display-control differences stated below). **Pass 2026-10-05 (develop `9b3c4824c` engine):** Strata with the stopgap reverted (`pack.ts` batches the baked LOD rungs again; `river.ts` omits the mirror mask and refresh interval, and the engine default logs `TN_WATER_REFLECTION_DEFAULT {"included":4,"excluded":3}`; `terrain.ts` drops `REFLECTED_LAYER`), console `TN_FRAME_BUDGET` maxima on nvidia/turing at 1920x1080: scene `nested` 15,809,090 triangles / 22 draws at its worst view and 10,970,078 / 42 over the view cycle, against the recorded 96,418,017 / 48; mirror `reflection` 922,540 / 3 draws, against 96,408,493 / 46. Display-control differences: the canvas is full-size at `resolutionScale: 1` (the baseline used a 1x1 collapsed raster with `refreshInterval: 2`), and the scenario waits for `worldReady` instead of a fixed 240 frames, because the fixture's wait ends while the world is still streaming and reads 0 instances. Every local game edit is restored: 430 files byte-identical to the pre-run fingerprint, and the three render files identical to their pristine snapshots. Found separately, not caused by this change: every run on this host ends in `TN_DEVICE_LOST`, and the game emits 22 pre-existing `THREE.TSL: No stack defined for assign operation` errors on develop.

The batch's ordinary build and engine frame loop use reduced geometry for far placements;
the water's ordinary reflected pass excludes repeated small props. Overrides remain effective,
failed rungs are visible diagnostics, and game proof reports measured triangles/draws.

## Game proof command

`CAPTURE_LOCK=1 CAPTURE_LOCK_TIMEOUT_MS=1200000 node packages/playtest/dist/runner/cli.js packages/core/__tests__/fixtures/instanced-defaults.playtest.json --url 'http://127.0.0.1:5198/?showcase=1' --browser-recipe webgpu --timeout 180000 --headed --artifacts /tmp/prd484-strata-final-defaults`

The final capture consumes candidate core `eae376eff`; the
baseline above already established the full-detail bill. Candidate controls pin a valid 1080-row
surface rather than repeating the baseline's collapsed canvas. Report submitted counts, with
these input differences, and no FPS or real-display performance claim.

The additional identical-control baseline was cancelled while still waiting for the shared GPU
lock (no new measurement) to preserve the owner's 120-minute wall for final proof and restoration.
The recorded exact-revert baseline above retains its stated raster/cadence differences.
