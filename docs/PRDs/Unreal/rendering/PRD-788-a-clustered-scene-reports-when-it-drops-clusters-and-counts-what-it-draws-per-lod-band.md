# PRD-788 — A clustered scene reports when it drops clusters and counts what it draws per LOD band

**Status:** NOT STARTED
**Priority:** P3 — Nothing drops clusters on the shipped routes today, and no scene is known to hit a capacity. The work makes the next silent drop loud and closes the last open debug rows of the Nanite port.
**Complexity:** 4 (LOW) — 1–5 implementation files (+1), two guards gain a counter and a report (+1), a playtest evaluator already reads the warning channel (+0), native proof on the owned host (+1), no visual change (+0); risk override: none
**Owner:** unassigned
**Depends on:** None for Phase 1. Phase 2 extends the `ClusteredMesh` row of [PRD-676](../performance/PRD-676-a-playtest-capture-tells-an-agent-whether-a-frame-pays-for-pixels-clusters-shadow-levels-or-effects.md) Phase 2 and starts after that row exists. Respects [PRD-600](../../done/PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md) (view-pruned cut) and the root rule "make performance mistakes painful to write".

## Context

This PRD closes the rows of [the Nanite internals map](../research/internals/nanite.json) that no PRD owned and that need no new GPU feature: "Overflow feedback" (229 LOC) and "Debug view modes" (336 LOC). It also files the reason for every other open Nanite row that waits on WebGPU or on an Unreal default.

**Overflow feedback.** The map note says the CPU cut has no fixed GPU queues to overflow. That is true for the cut itself. It is not true for every fixed-size budget on the clustered path. Three exist today.

- **The cut list of one mesh cannot overflow.** `ClusteredMesh` sizes `#selection` to the cluster count (`packages/core/src/clustered-mesh.ts:198`). `selectClusterCut` throws when a table selects more than that (`clustered-mesh.ts:140`). This guard already fails closed. No work.
- **A batch band outgrows its index buffer in silence.** `ClusteredBatch` sizes `group.cut` once, from a probe cut at the near edge of the band plus half again (`#capacityFor`, `clustered-batch.ts:434`). When a real cut is larger, `update` allocates a new array (`clustered-batch.ts:398`) and `#meshFor` replaces the index attribute (`clustered-batch.ts:470`). The code comment says "should not happen" and says each replacement leaks one GPU buffer. The quarry once leaked 74 buffers every 120 frames and ran an 8 GB card out of memory. Nothing prints when it happens.
- **The GPU scene drops placements past a region capacity in silence.** The reference kernel skips a placement when `taken >= region.capacity` (`packages/core/src/world-gpu-scene.ts:592`). The shadow variant shares the loop (`cullAndSelectShadow`, `world-gpu-scene.ts:513`). A dropped placement is a missing tree or rock with no message. This is the exact analogue of the Unreal visible-cluster buffer overflow.

The engine already has the channel. A `TN_SCENE_WARNING` line is printed by the engine and `perfWarnings` in `packages/playtest/src/evaluators/perf-warnings.ts` fails any scenario whose console holds the marker. This PRD adds no new channel and no new evaluator.

**Debug view modes.** PRD-676 gives an agent numbers: overdraw, `drawnClusters` and triangles per projected pixel. The Unreal rows left are shader complexity colouring and LOD colouring of Nanite pixels. Two facts decide what ships.

- **Per-pixel LOD colour needs an identity per pixel.** A clustered mesh draws one indexed geometry that shares its vertices between clusters. A vertex cannot carry the level of every cluster that uses it. A tint per cluster needs a visibility buffer (PRD-279 decision 1) or an un-indexed copy of the geometry, which spends the memory this design saves. Neither ships.
- **An agent reads numbers, not colours.** Root rule: agents write the games. A histogram of the cut by LOD band answers "is this scene drawing its coarse or its fine clusters" in one line of a capture, and it works on the browser and on the native host without a render change.

So the shipped part is a count of drawn clusters per LOD band in the PRD-676 cluster row. The colour view is declined with a revisit condition.

### What Unreal does (UE 5.8.3, read 2026-11-02; clean-room summary, no code copied)

- **Three GPU buffers have a fixed size, and a pass reports their peak.** The sizes come from `r.Nanite.MaxNodes` (2 Mi nodes), `r.Nanite.MaxCandidateClusters` (16 Mi) and `r.Nanite.MaxVisibleClusters` (4 Mi). UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:38-60`.
- **The cull pass sends the peak of each buffer to the CPU every frame.** A handler reads the three peaks from a GPU message. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteFeedback.cpp:28-37`.
- **A peak above capacity logs a warning once per new high-water mark.** Each state keeps its highest peak. It warns only when the peak is above capacity and above that mark, so a steady overflow does not flood the log. The text names the cvar to raise. UE 5.8.3: `NaniteFeedback.cpp:39-57`, `:133-143`.
- **An on-screen message lasts five seconds after the latest overflow.** UE 5.8.3: `NaniteFeedback.cpp:70-85`. The whole feedback class is compiled out of shipping builds (`#if !UE_BUILD_SHIPPING`, `NaniteFeedback.cpp:25`).
- **A separate cvar reports programmable materials that use masking or pixel depth offset.** It is off by default. UE 5.8.3: `NaniteFeedback.cpp:14-19`. PRD-600 and the raster-bin row already cover the ThreeNative side of this (a masked or `positionNode` material draws by construction).
- **The debug view modes are a shader define list plus two scale cvars.** They are wireframe, shader complexity, lightmap density, primitive colour, LWC complexity and streaming deficit. UE 5.8.3: `NaniteVisualize.cpp:345-352`. The complexity scale and overhead are cvars at `NaniteVisualize.cpp:61-75`. Every mode reads a per-pixel visibility buffer. ThreeNative has none, so the pixel modes stay out.

## Solution

The change has two parts. Phase 1 closes the overflow row. Phase 2 closes the debug row.

**Phase 1 — a drop prints one line.** Each of the two silent guards gets a counter and one report.

1. **Batch band growth.** When `group.cut` must grow, `ClusteredBatch` counts the growth per batch and prints one `TN_SCENE_WARNING` line the first time, then again only when the needed size passes the last reported high-water mark. This copies the Unreal rule (warn on a new high-water mark, not every frame). The line names the batch, the band, the needed and the held index counts, and what to change. The fix to name is `distanceRatio`, since a narrower band has a smaller worst-case cut. The batch also exposes `capacityGrowths` for a test to read. The growth itself stays, because a missing draw is worse than a leaked buffer.
2. **GPU scene region capacity.** The shared `select` loop counts the placements it skips for capacity, per region, and returns them as `dropped`. `WorldGpuScene` prints one `TN_SCENE_WARNING` line per region on a new high-water mark. The line names the region key, the capacity and the demanded count, and says to raise the declared capacity of that part.
3. **Quiet when nothing drops.** The counters add one integer increment on a path that already branches. A scene that never reaches a capacity prints nothing and the quarry scenarios stay at zero warnings.

**Phase 2 — a capture counts the cut by LOD band.** The PRD-676 `ClusteredMesh` row gains `lodBands`: the drawn clusters per band. A cluster has no stored level, so the band is derived from its own error. Band 0 holds clusters whose own error is 0 (the finest level). Band `k` holds own errors in `[2^(k-1), 2^k)` times the smallest non-zero own error of the table. The bounds are computed once at load. The count reuses the `#selection` list that `#compact` already walks, so the cost is one integer add per drawn cluster. The sum of the bands equals `drawnClusters`. A `ClusteredBatch` row sums its bands over all copies, as it does for triangles today.

**Consumer flow.** The game does nothing. A playtest scenario that already runs the quarry route fails on a dropped placement through `perfWarnings`. An `assert.geometry` request with PRD-676's `views` returns `lodBands` with the cluster row.

**Look is untouched.** Both parts count and report. Nothing here decides how anything looks, so the work lives in `packages/core/src/` as mechanism, with the playtest evaluator unchanged.

**Left out on purpose:** a per-pixel colour view (see `## Decisions`), a shader-complexity colour view (it needs a per-pixel shader cost that WebGPU does not expose without timestamp queries per draw), the lightmap-density and streaming-deficit modes (no lightmaps, no page streaming), and the editor-only picking rows (out of scope by rule).

## Acceptance Criteria

- [ ] AC-1 [local]: A batch whose band cut outgrows its capacity prints one `TN_SCENE_WARNING` line naming the batch and the band, reprints only on a new high-water mark, and still draws every cluster. A region at capacity reports the placements it dropped in the same way. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-batch.spec.ts packages/core/__tests__/world-gpu-scene.spec.ts packages/playtest/__tests__/perf-warnings.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The quarry route prints 0 `TN_SCENE_WARNING` capacity lines on the browser. proof: `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-route.playtest.json --url http://127.0.0.1:5191 --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-3 [local]: The quarry route capture reports `lodBands` that sum to `drawnClusters`, with a camera near the cliff holding a larger band-0 share than a camera far from it, and the desktop host returns the same sums. proof: `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-lod-bands.playtest.json --url http://127.0.0.1:5191 --browser-recipe webgpu` and the same file with `--target desktop` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Band growth report | `updateClusteredMeshes` (`game.ts`) calls `ClusteredBatch.update` every frame | Replaces the silent growth path. The growth stays | AC-1, AC-2 |
| Region drop report | `WorldGpuScene` runs the shared `select` loop each frame | Replaces the silent `continue` at `world-gpu-scene.ts:592` | AC-1 |
| `perfWarnings` | Every playtest scenario already reads the marker | Unchanged. It is the consumer | AC-1, AC-2 |
| `lodBands` in the cluster row | PRD-676 `assert.geometry` with `views` | Extends the PRD-676 row. A request without `views` is unchanged | AC-3 |

## Execution Phases

#### Phase 1: A dropped cluster or placement prints one line
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-batch.ts`, `packages/core/src/world-gpu-scene.ts`, `packages/core/__tests__/clustered-batch.spec.ts`, `packages/core/__tests__/world-gpu-scene.spec.ts`, `packages/playtest/__tests__/perf-warnings.spec.ts`
**Implementation:** the growth counter and the high-water report in `ClusteredBatch`, the `dropped` count in the shared `select` loop, the report in `WorldGpuScene`. The GPU kernel is checked for the same guard first, and the report covers it when it has one.
**Verification:** AC-1 and AC-2 close this phase.
- [ ] A batch whose first cut is larger than its probe capacity grows once, prints one `TN_SCENE_WARNING` line with the needed and held index counts, draws the same triangles as before, and stays quiet on a second equal frame. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-batch.spec.ts`
- [ ] A region with capacity 2 and 3 visible placements returns `dropped: 1` for that region, and `WorldGpuScene` prints one line naming the region key. proof: red-green `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts`
- [ ] `perfWarnings` returns the new line from a console capture, and the quarry route prints none. proof: `pnpm exec vitest run packages/playtest/__tests__/perf-warnings.spec.ts` and `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-route.playtest.json --url http://127.0.0.1:5191 --browser-recipe webgpu`

#### Phase 2: The cluster row counts the cut by LOD band
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/geometry-capture.spec.ts`, `examples/quarry/playtests/quarry-lod-bands.playtest.json`
**Implementation:** the band bounds at load, the per-band count inside `#compact` and the batch loop, and the `lodBands` field on the PRD-676 cluster row. This phase starts when PRD-676 Phase 2 has landed its cluster row.
**Verification:** AC-3 closes this phase. No visual judge is needed, because no pixel changes.
- [ ] A hand-built table with three own-error values reports the expected band counts, the bands sum to `drawnClusters`, and a request without `views` returns the same report as before. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/geometry-capture.spec.ts`
- [ ] The quarry scenario asserts the band sum on two cameras and a larger band-0 share near the cliff than far from it. proof: `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-lod-bands.playtest.json --url http://127.0.0.1:5191 --browser-recipe webgpu`
- [ ] The desktop host returns the same band sums for the same cameras. proof: `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-lod-bands.playtest.json --target desktop`

## Decisions

- 2026-11-02 (filing): the map note "the CPU cut has no fixed GPU queues to overflow" is half right. The cut list is sized to the table and throws on inconsistency. The batch band index buffer and the GPU scene region capacity are fixed budgets that drop or leak in silence. The "Overflow feedback" row moves from `notfiled` to this PRD.
- 2026-11-02 (filing): the report uses the `TN_SCENE_WARNING` marker. `perfWarnings` matches the marker text on any line, so no evaluator change is needed. No `TN_OVERFLOW` channel is added.
- 2026-11-02 (filing): per-pixel LOD colour and shader-complexity colour are declined. They need a per-pixel cluster identity (a visibility buffer, PRD-279 decision 1) or a per-draw GPU cost. The count by band answers the same question for an agent. Revisit when the owner reopens PRD-279 decision 1.
- 2026-11-02 (filing): the "Shared and glue" rows (2159 LOC under Cull + raster, 331 under Shading, 1574 under Data format) need no work of their own. They are console variables, pass setup and shared types for the internals above, and each internal has its own row or PRD.

## Blocked on

- Persistent-thread culling (119 LOC, `deferred`): WebGPU gives no forward-progress guarantee between workgroups. Unreal keeps it off by default (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:322-328`). Revisit when WebGPU specifies a forward-progress guarantee and PRD-600's pruned CPU walk is the measured cost.
- Async raster, shader bundles and work graphs (133 LOC, `deferred`): WebGPU exposes no async compute queue, shader bundle or work graph (cvar `r.Nanite.AsyncRasterization`, `NaniteCullRaster.cpp:51-56`). Revisit when WebGPU ships one of the three and a native backend proves a gain on the heaviest route.
- "[builder] Assemblies" (364 LOC, `deferred`): `r.Nanite.AllowAssemblies` is 0 and read-only (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:124-128`). Revisit when Unreal 5.8.x or later turns it on by default.
- "Curve data and decode" (1476 LOC, `deferred`): `r.Nanite.AllowCurves` is 0 and read-only (`NaniteResources.cpp:136-141`). PRD-671 reads glTF lines directly. Revisit when Unreal turns it on by default.
- "Auto voxel from depth" (200 LOC, `deferred`): the voxel path sits behind `r.Nanite.AllowVoxels`, which is 0 and read-only (`NaniteResources.cpp:130-135`), and the auto path is experimental. Revisit when Unreal enables voxels by default and PRD-669 Phase 3 passes its cost gate.
- "[builder] Mesh cards for Lumen" (1172 LOC, `notfiled`): PRD-639 uses a UV-space surface cache, so no card placement is needed. Revisit if PRD-639 fails its calibration scene on a mesh that a UV atlas cannot cover.
- "Brick tiling and scatter" (484 LOC, `deferred`): no work here. [PRD-669](PRD-669-far-foliage-keeps-its-volume-when-its-clusters-become-voxels.md) Phase 3 owns the revisit, since it draws one instanced box per brick and needs no tile binning unless its cost gate fails.
