# PRD-753 — A scene change updates only the batches it touches

**Status:** DEFERRED — 2026-10-27, Phase 1 sizing: `decide`, `structureStamp` and `contentClassOf` together take 0.06% to 0.32% of the game thread on Midway and the shooter, native and web (gate: 2%). Revisit when a game shows them at 2% or more of its game thread; `TN_PROJECTION_WALKS=1` names the caller and the trigger.
**Priority:** P1 — on Midway (page thread, 2026-10-27) the projection decision and the geometry content classes take 10.8% of the game thread's self time, the largest single engine bucket that a job pool does not remove. The same C++ runs on desktop and in the web Wasm engine, so one fix serves both.
**Complexity:** 7 (HIGH) — engine scene graph, projection plan and render database (+3), a new change-set data structure with counts per batch key (+2), correctness against a full rescan for every add, remove, reparent and material swap (+2); risk override: none
**Owner:** João
**Parent:** [PRD-573](../../performance/PRD-573-unreal-class-performance-in-release-cycles.md) (Unreal-class performance). Lane of PR #574 (`pr563-followup`).
**Depends on:** none. Related: [PRD-752](../../performance/PRD-752-web-games-run-in-a-worker-so-the-page-cannot-stall-them.md) phase 4 (the job pool and the parallel matrix walk; lane `lane/pr574-threads` owns them), PRD-754 (stable recorded passes).

**Update rule:** this PRD has no PR of its own. Its commits land on `lane/perf-change-set` and merge into PR #574. Tick each box, with its result, in the commit that proves it.

## Problem

Two callers run `projection::decide` (`packages/runtime-native/src/engine/renderer/projection/plan.h:441`), and it walks the whole scene:

- `hostProjectionReport` (`packages/runtime-native/src/engine/abi/bindings_scene.cpp:239-259`), the host projection seam that core calls.
- `RenderDatabase::batch` (`packages/runtime-native/src/engine/renderer/render_database.cpp:988-1015`), the renderer's own batch decision.

Each caller skips the walk while `Object3D::hierarchyVersion()` holds. But that counter is process-wide: any add, remove, attach or destructor moves it, including scratch objects, bullets, particles and pooled actors. When it moves, the caller walks the whole scene again with `projection::structureStamp` (`plan.h:407`) and, when the stamp differs, with `decide`. Both callers also rescan every 60 frames with no change at all. So a game that spawns one object per frame pays one or two full-scene walks per frame, in proportion to scene size, not to the change.

Measured (PRD-752 lead, 2026-10-27, `--profiling-funcs` engine build, Chrome trace, RTX 2080, 1920x1080, Midway on the deck, page thread, 0% idle): engine Wasm 56.5% of self time; projection `decide` plus `contentClassOf` 10.8%; matrix walk about 9%; animation 3.2%; `RenderDatabase::project` 2.1%.

## What Unreal does (UE 5.8.3)

Unreal applies a scene change as a typed entry, and it keeps the batch grouping as counts that each entry updates. It does not rescan the scene to find what changed.

- A component that moves sets a flag and queues itself for one end-of-frame update. It does not touch the renderer at once. `UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/ActorComponent.cpp:2713` (`MarkRenderTransformDirty`), `Engine/Source/Runtime/Engine/Private/LevelTick.cpp:1120` (`SendAllEndOfFrameUpdatesInternal` visits only the queued components).
- The renderer receives a change set of typed commands (add, remove, transform update) and applies only those. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/ScenePrimitiveUpdates.h:61` (`FUpdateTransformCommand`), `Engine/Source/Runtime/Renderer/Private/RendererScene.cpp:5534` (`FScene::Update`) and `:5636` (the updated-transform range).
- A primitive builds its cached draw commands once, when it is added. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PrimitiveSceneInfo.cpp:583` (`CacheMeshDrawCommands`).
- Each cached command goes into a state bucket, found by the hash of the command. Commands with the same bucket merge into one instanced draw. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MeshPassProcessor.cpp:2095` (`FindOrAddIdByHash`), `Engine/Source/Runtime/Renderer/Public/MeshPassProcessor.h:1807-1809` (same `StateBucketId`, one instanced draw), `Engine/Source/Runtime/Renderer/Private/ScenePrivate.h:1651` (one bucket map per pass).
- A removal decrements the count of its bucket. It does not regroup the scene. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PrimitiveSceneInfo.cpp:791-810` (`RemoveCachedMeshDrawCommands`).

The ThreeNative equivalent of a state bucket is the batch key in `decide`: `{contentClassOf(geometry), material, batchFlags(mesh)}` (`plan.h:522`). The port keeps one member count and one verdict per key, and updates them from scene events. Borrow the design only. Do not copy Unreal code (licence rule: [`../README.md`](../README.md)).

## Goal

A settled scene and a scene that adds or removes one object per frame both pay for the change, not for the scene. The decision stays bit-equal to a full `decide`, and a debug verifier proves it.

### Phase 1: Size it

**Status:** DONE — the ceiling is below the gate; the PRD is Deferred.

- [x] A counter reports, per 1,000 frames, the full walks of `structureStamp` and `decide` by caller, the nodes each walk visits, and the trigger (hierarchy move, cadence, `minMeshes`). proof: a native run of Midway and the shooter with the counter env var, and the web Wasm build through `profile:wasm-page`, numbers recorded here. Result (commit `9907ab1f2`, and the commit that ticks this box for the call count and the window size): `TN_PROJECTION_WALKS=1` prints one line per 1,000 calls of each caller (`=<n>` sets the window), with stamp and decide walks, their nodes, and the trigger (`hierarchy`, `cadence`, `minMeshes`, `structure`, `scene`, `rig`); `plan_test` checks the node counts (red with the decide count removed: 0 against 1,001). `hostProjectionReport` makes 0 calls on both games, because both set `renderer.projection: false`; every walk comes from `RenderDatabase::batch`, which runs several times per frame (15,000 calls in 150 s at under 31 fps). Per 1,000 `batch` calls: Midway web 17 and 8 decides (16 and 8 cadence, 1 structure; 44,479 and 24,656 nodes, about 2,600 to 3,100 per decide), 4 and 0 stamps (22,758 nodes; 1 hierarchy, 3 cadence). Shooter web, 15 windows: 0 to 4 decides of 9,386 nodes, 0 to 2 stamps, cadence or structure only. Shooter native, 6 windows over 2 runs: 0 to 14 decides of 9,386 nodes, 0 stamps, cadence only. Midway native renders 1.4 to 9.9 fps on the loaded host, so it never filled 1,000 calls; with `TN_PROJECTION_WALKS=200` its first 200 calls held 20 cadence decides of 968 nodes and 0 stamps. Deviation: `profile:wasm-page` does not read the page console, so the web counts come from a Playwright console probe on the same `--profiling-funcs` build that the profiles below used
- [x] The ceiling is recorded on Midway and the shooter: the share of game-thread self time in `decide`, `structureStamp` and `contentClassOf`, native and web. If both are below 2% of the frame, the PRD stops and moves to Deferred with that number (owner rule, 2026-10-21: defer, do not decline). proof: `--profiling-funcs` profile, two runs per arm. Result, `decide` / `structureStamp` / `contentClassOf`, as a share of the game thread's busy samples, run A then run B. Web (`profile:wasm-page --cpu-work --save-profile`, inclusive time): Midway on the deck 0.23% (0.09 / 0.00 / 0.14) and 0.27% (0.03 / 0.00 / 0.24); shooter `/main.html` 0.30% (0.02 / 0.02 / 0.26) and 0.32% (0.02 / 0.08 / 0.22). Native (`perf record` on the desktop engine player, engine-thread self time, second half of each flight): Midway 0.27% (0.05 / under the sample floor / 0.22) and 0.23% (0.03 / – / 0.20), 0.62% and 0.58% even with `record`, `batchMeshes` and `uniformHash` added as an upper bound; shooter 0.06% (0.02 / – / 0.04) and 0.10% (0.01 / – / 0.09). All eight are below 2%, so the PRD is Deferred. Machine: RTX 2080 desktop (adapter `nvidia turing`), private Xvfb through the GPU slot, host load 55 to 92 on 24 threads from other lanes (the laptop refused at 98 °C), so the numbers are shares only, not frame times. `RenderDatabase::project` (1.7% to 2.0% on Midway web) is the draw-list walk, not this lever

### Phase 2: Change set

**Status:** DEFERRED — not started: Phase 1 measured the ceiling below the gate.

- [ ] The engine records typed scene changes (added, removed, reparented, and a geometry, material, `visible`, `renderOrder`, layers or skinning-state change on a mesh) in a change list per scene root. The projection state keeps a member count and a verdict per batch key and applies only that list. Work per single add is constant in scene size. proof: a new ctest that adds one mesh to scenes of 1,000 and 4,000 meshes and asserts equal nodes visited
- [ ] `TN_PROJECTION_VERIFY=1` runs the full `decide` next to the incremental state and fails on any difference. A fuzz ctest with 10,000 random add, remove, reparent, swap and hide operations passes with the verifier on. proof: the fuzz ctest, `ctest -L native-engine`
- [ ] Both callers read the incremental state. The 60-frame cadence rescan is removed, and the decision is recorded under `## Decisions`. proof: `vitest run packages/core/__tests__/host-projection.spec.ts`, the Phase 1 counter shows zero full walks on a settled scene

### Phase 3: Prove it on games

**Status:** DEFERRED — not started: Phase 1 measured the ceiling below the gate.

- [ ] Midway native and web: the Phase 1 share falls below 1% of the frame, with frame p50 and p95 no worse. Paired A/B from one code state with a knob (`TN_PROJECTION_CHANGE_SET=0` against `1`), three runs per arm, host load recorded. proof: `scripts/midway-bench/flight.sh` and `profile:wasm-page` pairs
- [ ] The shooter and starter template scenarios pass, and a fresh visual judge returns NEUTRAL or IMPROVEMENT on BEFORE/AFTER frames (`--browser-recipe webgpu`, `adapter.info` checked, two runs per arm). proof: `pnpm test:templates` on both kits; the verdict in this box and images on PR #574

## Done when

Every box is ticked, `PERFORMANCE-LEARNINGS.md` has the lever entry (keep or reject), the feature map row for "Mesh draw commands and pass processors" names this PRD, and the file moves to `docs/PRDs/done/` in the commit that finishes it.

## Decisions

- 2026-10-27 (lane `lane/perf-change-set`): **deferred at Phase 1.** The 10.8% in the Problem did not reproduce at `6ddf30cab` plus the counter: the eight profiles above put the three functions at 0.06% to 0.32% of the game thread. On both games the decision declines or holds, so `RenderDatabase::batch` walks the scene only on its 60-call cadence and on rare structure moves, and `hostProjectionReport` is not called. This is consistent with the PRD-613 lever in `PERFORMANCE-LEARNINGS.md` (2026-10-27): a projecting decision was judged again every frame, about 11% of main-thread samples, and `batch` now holds it. The largest remaining piece is `contentClassOf` from `RenderDatabase::record`, once per drawn mesh per frame (0.14% to 0.26%), not a scene walk. The Unreal change-set and state-bucket port stays the design for a revisit. Revisit when a game with `renderer.projection` on, or with per-frame adds and removes under a projecting decision, shows `decide`, `structureStamp` and `contentClassOf` at 2% or more of its game thread.

## Blocked on

(none)
