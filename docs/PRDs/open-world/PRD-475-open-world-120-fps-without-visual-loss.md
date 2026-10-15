# PRD-475 — Machinefall's open world at 120 fps with no visual loss

**Status:** PARTIAL — merged at prd:25% on João's 2026-10-02 call; the walking p95 boxes (AC-1, AC-2, Phase 2 targets, Phase 3 guard) continue in PRD-478
**Priority:** P1 — Open: map-walk CPU and GPU p95 targets with halved shadow CPU share, no visual loss.
**Complexity:** 5 (MEDIUM) — 6–10 engine files (+2), engine and Machinefall release separately (+2), GPU-pass state (+1 risk); risk override: none
**Owner:** João
**Depends on:** PRD-473 (merged at 75% in #375 as `a602467db`)

## Context

Machinefall's streamed world (`?scene=map-walk`) is the open-world proof. #375 restored its look: forest shadows on road and floor, and the full forest after a camera jump. Impostors went back to opt-in because their card dropped the forest's shadow. That look, at develop `a602467db`, is the reference this PRD must not lose. The owner said "it should be FAST + look AAA": no frame-time win may cost the look.

Where it stands, per PRD-473:

- **GPU:** p50 9–15 ms after the GPU scene went default-on.
- **CPU:** window p95 13.2 ms.
- **What limits the frame:** the GPU and present wait. The main thread is mostly idle; the main pass draws 16–27 M triangles; the wide shadow level spends 11–19 ms of per-draw JS.
- **Timing was not claimed:** under the box's load (~30), two identical walks read render p50 21.4 vs 9.0 ms.
- **Bundles:** measured no gain and are opt-in, because a bundle bakes `visible` and lost gate-hidden trees.

Develop's recent cuts the game has not picked up yet:

- PRD-458 world streaming (`4f9638c2e`).
- PRD-473's terminal coarse LOD. `LOD_GENERATOR_VERSION` 2 needs a re-cook.
- PRD-462's spread material checks: frame p50 10.4–13.6 → 3.5–5.9 ms on the colour lane.
- The one-palette skinned draw (`0107bc7d0`).

Machinefall still pins pre-develop tarballs:

- main: `pr375-binding-054d0f866554`.
- `feat/prd-458-engine-pin`: `pr375-stabilize-2a776d82d056`.

No develop-tip tarball exists.

Instruments, all shipped:

- `TN_FRAME_BUDGET` (`packages/core/src/frame-budget.ts`) splits the frame into phases (`update|render|overlay|ui|residual|hostGap`).
- The same marker gives per-pass GPU times (`gpuMain|gpuShadow|gpuOther|gpuCompute`) as timestamp-query p50/p95, plus draws and triangles per pass.
- `playtest perf` (`packages/playtest/src/runner/perf.ts`) prints them.
- Under the private Xvfb, fps is suppressed: the present wait lands in update, with a ~50 ms swap floor. CPU is therefore read from the phase partition and GPU from timestamps, never from fps.

## Solution

1. **Sync, then measure on develop.** Pack core and assets from develop with `pnpm --filter <pkg> pack`, and pin Machinefall's `apps/client` to them, including `pnpm.overrides`. Re-cook the world with `pnpm world:post`. Then record the baseline: the frame phases and the per-pass GPU split on the Turing WebGPU adapter. Capture the same-pose reference images at the same time.
2. **Cut what the baseline ranks first, in the engine.** Every fix lives in `packages/core/src/` behind the convention that the engine decides; Machinefall gets no performance option. Candidates, each kept only if it moves its own meter and passes the visual A/B:
   - Shadows: redraw a clip level only when its casters or the light moved, instead of every frame. Draw the wide levels from the GPU scene's cull.
   - Main pass: triangle cost per screen pixel: LOD gates, and an impostor that casts the forest's shadow. That is the condition under which impostors may come back.
   - CPU: per-draw JS on the shadow and main passes. Bundles return only if they keep gate-hidden trees hidden.
3. **Hold it.** The map-walk scenario asserts the budget, so a regression reds the game's own test.

Quiet-machine rule: compare timings only with load average below 4. Interleave arms (A, B, A, B) over at least 3 runs each. When load stays high, record the run as unverified, never as a result.

Risks:

- A cut that reads as "faster" can be a cut that draws less. Every Phase 2 box therefore carries the same-pose A/B, and draws and triangles are compared alongside milliseconds.
- Caching shadow levels can leave stale shadows on moving casters. The A/B includes a pose taken while walking.

## Acceptance Criteria

- [ ] AC-1 [local]: Machinefall `?scene=map-walk` CPU frame p95 ≤ 8.3 ms. CPU means the summed phases excluding the present wait, over 3 interleaved runs on the RTX 2080 WebGPU adapter, with 0 console errors and no game-side performance option. proof: `TN_FRAME_BUDGET` windows via `node packages/playtest/dist/runner/cli.js perf` on the map-walk run — Evidence: pending.
- [ ] AC-2 [local]: the same walk's GPU p95 ≤ 8.3 ms, from timestamp-query `gpu` p95 (`gpuMain + gpuShadow + gpuOther + gpuCompute`). proof: the same `TN_FRAME_BUDGET` windows — Evidence: pending.
- [x] AC-3 [local]: no visual loss against develop `a602467db`. Fresh blind raters score the after-captures no lower than the reference on all 4 map-walk and all 4 map-views poses, including the road and forest-floor shadows. proof: `pnpm visuals:ab --before <ref> --after <candidate> --raters 3` — Evidence: engine `d1e6e1796` (core cut12f, machinefall `910d49f`), 3 blind raters through `pnpm visuals:ab`, before = develop walk captures plus settle-gated views (`artifacts/prd-475/ab4-before`), after = `artifacts/prd-475/cut12g/after`: 7 poses equal (v1-v4 4/4, walk-01 4/4, walk-02 3/3, walk-03 4/4), walk-04 a win 3 → 4, no loss; duplicate-pair spread 0 (`artifacts/prd-475/ab5/score.json`). Model raters, not the human session VISUAL-BASELINE.md describes.
- [x] AC-4 [local]: no tree or shadow pops in on approach. A fine capture series along the map-walk highway leg shows no element appearing or swapping LOD within 40 m of the camera. proof: map-walk capture series plus a fresh judge subagent — Evidence: 42 captures 2.3 m apart along the highway (`artifacts/prd-475/cut12f/pop`) against the same series on develop (`pop/base`); a fresh judge found 0 candidate-only pops within 40 m, popping the SAME as develop, and the road forest shadows match frame for frame. Road-band luminance over frames 10-20 is 25.933 % vs develop 25.940 %.

## Blocked on

- Presented 120 fps on a real 120 Hz+ display. Xvfb's swap floor cannot show it. Unblocked by João running `?scene=map-walk` on the desktop monitor and reading the fps overlay.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Develop engine in the game | Machinefall `apps/client/package.json` `file:` tarball pins and `pnpm.overrides` | Replaces the `pr375-*` pins | Phase 1 box 1 |
| World frame cost | `?scene=map-walk` → `WorldCells.update` (`packages/core/src/world-cells.ts`) → GPU scene and `VirtualShadowNode` (`packages/core/src/render/virtual-shadow.ts`) | Changed in place; the CPU path stays as the fallback for backends without indirect draws | AC-1, AC-2 |
| Budget regression guard | Machinefall `apps/client/playtests/scenes/map-walk.playtest.json` `assert.performance` | Tightens the current `maxFrameMsP95: 250` | Phase 3 box 1 |

## Decisions

- 2026-10-01 (João): a follow-up PRD targets 120 fps with no visual compromise ("FAST + look AAA"). Impostors stay opt-in until they cast the forest's shadow.
- 2026-10-01 (João, via this PRD): PRD-473's AC-5 (map-walk at 120 fps) moves here. PRD-473 keeps its mechanisms: GPU cull, bundles, impostors, HLOD and fallback.
- 2026-10-01: the visual reference is develop `a602467db`, the look restored in #375, and not the older `pr375-binding` build.
- 2026-10-01: a merged super-tile was drawn a whole `blockOrigin` from the tiles it replaced — its geometry is written relative to the block origin and the mesh was left at (0, 0, 0), so every block away from the origin showed as floating slabs over a hole where the ground is; unit tests only ever merged an island at the origin, where the two agree.
- 2026-10-02 (João): stop tuning and "stabilize and merge what you can". This PRD merges with its shipped cuts: idle frame p50 2.6–4.8 ms vs develop 5–7, walking render p50 7.0–8.4 vs 8.3–10.4, and AC-3 holding. Walking p95 stays at 19–26 ms (develop 18–25) and moves to PRD-478 (frame architecture: per-draw refresh only on changed inputs, streaming in a worker, GPU-driven shadow casters). The boxes stay open here rather than being ticked on unmet targets.
- 2026-10-02: the bridge-pose van shading is a capture race, not a shipped regression. The van band reads 30.89 / 31.05 / 31.47 across repeated captures of the same build, and develop `a602467db` itself read 31.0472 in `artifacts/prd-475/bisect-van2`. Our builds land on 31.47 more often (cut12i 3/3, cut12k 2/3, cut12m 1/3); the cause is open in PRD-478 alongside the shadow-level cadence.

- 2026-10-14 (João, "1"): PRD-473 closes at 5/5 with a re-scope. Its AC-2 timing half, AC-3 visual match and wider AC-4 coverage move here as Phase 4. Impostors stay opt-in; the highway_air finding is in PRD-473's AC-3 evidence log.

## Execution Phases

#### Phase 1: Sync Machinefall with develop and record the baseline
**Files:** Machinefall `apps/client/package.json`, `pnpm-lock.yaml`, and the re-cooked `public/world/*`; `docs/verification/runtime-perf-state.md` (perf findings update in place).

- [x] Machinefall runs develop's engine: the core and assets tarballs packed from develop `a602467db` or later are pinned, the world is re-cooked, and map-walk passes. proof: `pnpm test:scenes` (map-walk) in Machinefall, 0 console errors. — machinefall `feat/prd-475-develop-engine` `2ba8f21`. Core 0.3.4 and assets 0.3.5 tarballs from `a602467db`; installed dist tree hash equals the engine build. map-walk ran 5 times on nvidia/turing with 0 console errors; 4 green, 1 red on `state.failures` 1, the unlogged cell failure in Phase 2. map-views is green with 4 distinct poses.
- [x] The baseline is recorded in `docs/verification/runtime-perf-state.md`. It covers the CPU phases p50/p95 and the `gpuMain/gpuShadow/gpuOther/gpuCompute` p50/p95, with draws and triangles per pass, over 3 quiet-machine map-walk runs. The same-pose reference captures (4 walk, 4 views) are saved as the AC-3 `--before` directory. proof: `node packages/playtest/dist/runner/cli.js perf` on the runs. — 3 runs at load 3.4–3.8: frame p50 12.3 / p95 26.3 ms, CPU render 12.1 / 26.1 ms, GPU 7.4 / 11.3 ms (main 5.6, shadow 1.1), draws main 318 and shadow 200. References are in `artifacts/prd-475/reference/` (gitignored): 4 walk and 4 views.

**Status:** DONE. The CPU render phase leads: render p50 is 1.6× GPU p50, and update/overlay/ui read 0. Phase 2 therefore starts with CPU attribution.

**Verification:** the scenario run plus the perf report. The ranking of costs decides the order of Phase 2.

#### Phase 2: Cut the frame where the baseline says, in the engine
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/src/world-cells.ts`, `packages/core/src/world-gpu-scene.ts`, plus their specs. These are expected, not fixed: the baseline names the real ones.

Budget split, to be confirmed against the baseline: shadows 2.5 ms GPU, main 5 ms GPU, CPU render phase 4 ms.

- [ ] Shadow passes: map-walk `gpuShadow` p95 ≤ 2.5 ms. The shadow pass's share of CPU render time halves against the baseline, with a red-green spec on the mechanism and AC-3's A/B at the four walk poses. proof: `pnpm exec vitest run packages/core/__tests__/<shadow spec>` plus `playtest perf`.
- [ ] Main pass: map-walk `gpuMain` p95 ≤ 5 ms, with a red-green spec on the mechanism and the same A/B. proof: the mechanism's spec plus `playtest perf`.
- [x] A failed world load names itself: `WorldCells` prints the asset or cell and the error behind a `TN_WORLD_CELL_FAILURE` marker instead of only counting it (`world-cells.ts` `#startAssetLoad`, `#startChunkLoad`, `#attachChunks`). proof: a red-green spec in `packages/core/__tests__/` with a rejecting loader. — `packages/core/__tests__/world-cells.spec.ts::WorldCells > names a refused world load in a TN_WORLD_CELL_FAILURE marker`, red without the marker, green with it; core 2184/2184.
- [ ] CPU render phase p95 ≤ 4 ms on map-walk, with a red-green spec on the mechanism and the same A/B. proof: the mechanism's spec plus `playtest perf`.

**Verification:** each cut is measured A/B against the build before it, interleaved and on a quiet machine. A cut that fails its meter, or the visual A/B, is reverted and recorded under Decisions.

Cut 1 (terrain super-tiles, PRD-473 plan): landed in ec9a739ad, b9442ec5a, bc998f510, 8349962ce, 0421ed329; Machinefall A/B pending.
Cut 1 fix: Machinefall correctness pair (same build, merge off/on) found the ring shrinking 289 → 248 because block bytes were charged to tile admission; blocks are now reported (`blockBytes`), not charged — 68a3691d2. Terrain draws 289 → 33–42, main draws p50 289–343 → 158–258.
Cut 1 fix 2: a block kept drawing the ground of a tile that had left it — a second copy at the level the tile left, for as many frames as the one-per-frame rebuild queue took to reach it — and counted that tile twice, so the `tiles` stat drifted off 289; a departure now dissolves its block for the frames before the rebuild brings it back — f8a990abe; per-frame walk invariant `world-terrain-merge-walk.spec.ts` (red at frame 18, green after; draws stay under the unmerged ring's 81).
Cut 2 (memoised shadow-caster table): landed in d47a24dfc; Machinefall A/B pending.
Cut 1 fix 3: a merged block's mesh sat at the world origin while its vertices were block-local, so every block but (0,0) drew displaced ("floating slabs", white ground) — `890578e81`, two specs comparing every block vertex through `matrixWorld` with its tiles'.
Cuts 1+2 in Machinefall (`machinefall@8107d51`, core `prd475-cut12c`), clean machine (load < 3, GPU < 10%), 4+4 interleaved against develop: frame p50 9.55 → 7.20 ms, frame p95 20.55 → 17.22 ms, render p95 20.45 → 17.10 ms, GPU p50 6.95 → 7.12 ms, GPU p95 10.93 → 10.20 ms, main draws 335.5 → 246.5; 8/8 map-walk pass, 0 console errors. Fresh blind same-pose judge, 8 poses against `artifacts/prd-475/reference/`: SAME overall (6 same, 1 better, views-v2 noted for vehicle variants and slightly thinner left forest).
Cut 3 (per-frame resource version bumps): measured, not fixed — there are none to stop. A throwaway probe in the game's bundled `three` counted `Textures.updateTexture` past its version guard at **0 calls** and `_copyCompressedBufferToTexture` at **0** over a 8400-frame map-walk (`machinefall@8107d51`), so nothing is re-uploaded per draw; `Source.needsUpdate` and `BufferAttribute.needsUpdate` (which `StorageBufferAttribute` inherits, so the GPU scene's `source`/`keys`/`locals`/`args` are counted) peak at 0.5 and 0.6 per 1000 frames, all from real writes: `mergeParts` cloning a geometry during a streamed chunk merge, and GLTFLoader/KTX2Loader loading a newly resident asset. `NodeMaterialObserver.needsRefresh` ran 0.33 times per 1000 frames, so the per-draw node-state refresh already takes its settled fast path. The `attrib2` profile agrees: `_copyCompressedBufferToTexture` is 156.6 ms of 27.6 s total, **0.57%** inclusive, not the 26% / 2.95 ms per frame the stack summary suggested — its samples are ancestors of a per-draw path that is already short-circuiting, and the 34.1% `getNodeBuilderState` figure is the per-draw `needsRefresh` check itself. No engine change, no commit, no Machinefall A/B.
Cut 4 (per-level shadow caster culling): measured, not built — three already culls per level, so a batch-bounds cut would be a second cull of the same volumes. R1: a caster batch is **per `(asset,level,part) × world-grid square`** (`#casterFor`, `world-cells.ts:5537`, key `${key}@${cluster}`), not per cell and not key-wide; the wide half (`#wideFor`, `:5553`, key `@*`) is deliberately ring-wide and is only drawn by a level whose window covers the ring. Each carries **its own** world bounds — `#rebound` unions the per-block AABBs read from the written instance bytes (`:1148`, `#boxOf` `:1167`), published as `mesh.boundingSphere` — and `frustumCulled = true` (`:1079`, restored `:1737`). R2: three decides, in `_projectObject` (`Renderer.js:3132`), `frustum.intersectsObject(object)` against the level's own `shadow.camera` — the very ortho window the cut proposes to test by hand; a level's camera is `±extent` X/Y with the depth `#deriveDepth` brackets conservatively toward the light (`virtual-shadow.ts:1509`). R3: measured with a throwaway probe through that exact path — 17 cluster batches on a line at 24 m spacing, level 0 (48 m window) kept **1**, level 1 (192 m) kept **5**, and a tall caster beyond the box *toward the light* was still kept (`near=1`, `far=41.4`, intersects `true`), so the existing depth derivation already refuses the false negative the cut's own rule warns about. Two brief premises were wrong and are corrected here: `frustumCulled = false` at `world-cells.ts:5952`/`:5956` is `#dressGpu`, reached only for `role === "main"` (`#adoptGpu` `:5843`), and main meshes keep `castShadow = false` on layer 0 (`#dressMesh` `:5744`) — so **no caster batch is GPU-dressed** and the main camera's dispatch (`world-gpu-scene.ts:4132`, ortho early-return above it) never sets a caster's count. The 257 draws a level submits are batches three's own per-level test already kept. No engine change, no commit, no Machinefall A/B.
Visual fixes found on the way (all red-green): GPU-scene activation dropped placements sliced before the renderer arrived (`d91709b44`, Sol); cached shadow levels never re-rendered when casters left, joined or stopped casting, which was pre-existing on develop (`0c9b264ff`, `07f617495`); cut 2's probe loop kept two callback `return`s, so the first skipped coarse caster ended the probe and the 96 m/320 m levels lost the forest's road shadows (`d1e6e1796`, Sol). Machinefall's map-views drains on streaming settle, not on the in-flight count (`machinefall@13976d8`): develop also lost the v2 forest when the screenshot landed mid-load.
Cut 5 (chunk shadow consolidation, 7376879e1, f015f6cbe, b3d746a24): retained opaque instanced casters go from 5 layer-0 draws to 0 plus 2 side proxies with identical per-level triangle inputs, unchanged main draws and eviction cleanup; AutoLOD remains excluded. In Machinefall (core cut12h) putting merged proxies on the wide half too (7376879e1) drew merged slabs into coarse levels, and the bridge deck self-shadowed as wide acne stripes (map-views v3, walk-04); an ablation build of 7376879e1 alone reproduces it, develop does not. b3d746a24 keeps merged proxies cluster-only as on develop; retained proxies keep both halves (they stand in for layer-0 casters every level drew). cut12i (machinefall `c5baf56`): blind 3-rater judge 8/8 poses equal to develop (`artifacts/prd-475/ab7`), pop series SAME (0 pops each, road band 25.929 % vs 25.940 %), coarse-level layer-0 casters 148 → 65 at 320 m in cut12h. Timing A/B pending.
Cut 6 (repeated chunk parts instanced, 78280560c, reverted bf1e22e5b): in its unit fixture, 18 → 4 main and layer-0 candidates with identical inputs; in Machinefall (core cut12j) main draws went 225 → 171, but the bridge-deck acne returned. Cut 6 takes meshes that carry extra vertex channels (tangents, colours) out of the material merge so it can instance them, and the deck then cast through a retained proxy into coarse wide levels. Without that skip, 9 of its 10 specs lose their candidates. Kept out until merge-skipped parts cast like merged ones.
Timing (clean-ab3, develop vs cut12i, 4+4 interleaved, quiet gate): idle at the final pose frame p50 2.3 vs 5.5-6 ms, but walking CPU render p95 per window 40-70 vs 17-34 ms in all 4 pairs; cut12f vs cut12i (2 pairs) puts it on cut 5: 23-24 vs 34-37 ms.
Cut 5 index fix (e6ce09623): retained proxies keep one index geometry per level camera and rewrite it only when that level's selection changes (red: 12 index-version bumps per 3-level sequence, green 0). cut12k (machinefall `eabf0a7`) vs develop, 4 pairs: walking render p95 19-26 vs 18-24 ms, walking p50 7.0-8.4 vs 8.3-10.4, idle frame p50 2.6-4.8 vs 5-7, main draws 208-297 vs 297-327; blind 3-rater judge 8/8 equal (`artifacts/prd-475/ab8`); pop road band 25.940 % = develop. Gates: core 2219 passed, typecheck 0, lint 0 errors.
Walking tail attribution (unminified trace, cut12k): 390 of 1491 rAFs over 12 ms (p95 21.6 ms). Inside them: three's per-draw loop ~50 %, WorldCells update ~28 % (terrain follow 11 %, admit 9.7 %), VirtualShadow level renders ~15 %, node builds ~9 %. Level 0 (24 m) re-renders while moving and submits 270-690 draws (cluster 206-283 + layer0 93-309): the walking plateau. Next lever: GPU-driven shadow casters / level-0 cost.
Shadow invalidation on caster change: both sides were broken — a level held its map across a caster leaving or joining the world and across `castShadow`/`visible` flipping, which is the ghost shadow the map-views camera jump leaves behind, because cut 2's `childadded`/`childremoved` listener only marked the caster table stale and nothing asked the affected level to redraw; `#onTreeChanged` now also measures the changed child and `invalidateRegion`s the levels covering it, and a per-frame `#pollCasters` reads `visible`/`castShadow` off the memoised table (one flag pair per caster, no walk) for the changes that fire no event.

GPU source continuity fix (2026-10-02, source/unit lane; complexity 3, LOW): a queued build could consume CPU placement slices before GPU activation, then publish without those slices' source records. `WorldCells.update` now restarts pending builds through `#seedGpuSources` before dressing the keys, returning unpublished CPU claims and retaining outgoing batches. Red: `world-gpu-scene.spec.ts` "seeds source records for a build sliced before the renderer arrived" received 164 placements against the CPU's 262. Green: four activation timings (1, 3, 5, 8 CPU units), with shadows and one fresh mesh per update, match the CPU's source matrices before and after eviction/readmission and its main-pass instance total; a multi-part partial-eviction test also keeps every placement drawable. Self-review: one activation reset, unchanged CPU fallback, existing admission queue and synchronous buffer growth reused. Gates: `pnpm exec vitest run packages/core` 2208 passed, 2 skipped; `pnpm typecheck` exit 0 after building missing local package artifacts; `pnpm lint` 0 errors, 992 warnings, exit 0; `pnpm quality` 181 findings, exit 0. The separate browser matrix owns visual proof; Phase 2's performance and visual boxes stay open.

Cut 2 coarse-probe fix (2026-10-02, source/unit lane): converting the caster traversal callback to a loop left two `return`s behind, so an alpha caster or a mesh without bounds ended the whole probe before later casters, layer selection and depth collection. Both now `continue`. `virtual-shadow-caster-draws.spec.ts` adds nested streamed casters, cluster/wide choices, moving cameras and caster transforms, and a missing-bounds case: all 3 red with `expected 0 to be 1`, all green after the two-line fix. A temporary comparison against `d47a24dfc^` matched all 12 coarse-level probe/depth/layer/candidate-draw observations after the fix; the specs also keep the selected trunk inside the 96/320 m shadow frustums. Gates: core 2211 passed, 2 skipped; typecheck exit 0; lint 0 errors, 992 warnings, exit 0; quality 181 findings, exit 0. Self-review: callback skips now skip one mesh; no API or scheduling change. Machinefall shadow recovery and performance remain unverified in this lane; the browser owner must run the same-pose A/B, so Phase 2 and AC-3 stay open.

Active-blend scan fix: `world-tiles-cost.spec.ts` red: expected `Map.values` not called, got 1. The active-tile Set removes a 25-tile walk from every blend-count read and makes transition advancement visit active tiles only; settled rendered positions stay identical. `pnpm exec vitest run packages/core/__tests__/world-tiles-cost.spec.ts packages/core/__tests__/world-terrain-merge-walk.spec.ts --maxWorkers=1`: 10 passed, 2 benchmark skips, exit 0.

Neighbor-LOD scan fix: `world-tiles-cost.spec.ts` red: 75 resident-map lookups, expected 25. Target changes already coordinate the resident ring; the extra neighbor pass is now required only for newly admitted tiles. Green: 25 lookups (50 saved/follow), identical settled positions; terrain cost and merge-walk specs 11 passed, 2 benchmark skips, exit 0.

Frame-work follow-up (2026-10-02): the shared measured frame budget (c13e35a5e: streaming after the draw, deferred in shadow frames, forced within 3) was reverted in c823efa91. Machinefall cut12l (core `7deb743a39daa13e`) clean-ab5 pairs 1-3: walking render p95 26-35 ms vs develop 21.5-24.7, p50 no better; blind ab9 7/8 equal, 1 LOSS (walk-04 bridge: cliff shadow missing on the vans) that a recapture did not repeat (van-band luminance 30.8937 = develop); pop road band 25.940 = develop, pop judge: no late objects. Deferring stacked the backlog rather than spreading it. The two exact scan cuts above stay.

Render-loop node-key fix (2026-10-02, source/unit lane): reuse `three/tsl`'s stock constant shadow-colour node across VirtualShadowNode's per-level materials. Red: 9 prewarmed casters held 2 node states; green: 1, gate cache misses 34 → 21 (compiler stubbed), with unchanged source index ranges, materials and instance counts per pass. All 39 settled submissions still refresh inside three; 0 render-object creations/geometry swaps and 0 late builds for prewarmed keys. Gates: core 2246 passed, 2 skipped; typecheck exit 0; lint 0 errors, 1012 warnings, exit 0; quality 183 findings, exit 0. Browser timing and same-pose GPU output remain unverified; Phase 2 stays open.

Shared shadow colour (2026-10-02): `1299c6a91` shares three's constant shadow colorNode across the virtual levels, so identical level shaders reuse one node-builder state (`world-cells-shadow-prewarm.spec.ts` red: 2 states for 9 casters, expected 1; loading-gate cache misses 34 → 21). cut12n blind ab11: 7 equal, 1 win (develop's bridge-deck capture missed trees), 0 losses; pop band 25.940 = develop.

#### Phase 3: Hold 120 fps with the look intact
**Status:** NOT STARTED
**Files:** Machinefall `apps/client/playtests/scenes/map-walk.playtest.json`; this PRD.

- [ ] map-walk's own scenario reds when CPU or GPU p95 exceeds 8.3 ms. It uses the performance assertion on the render and GPU series, not fps, which Xvfb suppresses. proof: `pnpm test:scenes` green on the candidate and red on the Phase 1 baseline build.
- AC-1 to AC-4 above close this phase.

**Verification:** AC-1 to AC-4 evidence, then `pnpm typecheck && pnpm lint && pnpm test`, and the Machinefall pin moved to the final tarball.

#### Phase 4: Carried over from PRD-473 (João, 2026-10-14)
**Files:** `packages/core/src/world-cells.ts`, `packages/core/src/render/world-impostor-surface.ts`, `packages/assets/src/` (HLOD cook).

- [ ] Bundle replay timing: per-frame JS in the render phase for the world ≤ 1.5 ms at 400 world draws, from paired `TN_FRAME_SPANS` runs (bundles on and off) that survive the harness. proof: the paired reports. PRD-473's 2026-10-13 pairs died with `Bridge operation 'advance' exceeded 22500ms`. Coordinate with the PRD-478 p95 boxes.
- [ ] Impostor look: with `?tnImpostors=1`, `highway_air` is NEUTRAL or better against impostors off (4 settled runs per arm, drain `stats.impostor.pending` first, fresh judge). Open finding: the pine and scots-pine impostors read lighter than the real trees from the air camera (lime crowns, yellower canopy), and keeping the broadleaf asset on real geometry does not fix it. The fix is impostor shading or the switch distance. proof: the judged sheets. Impostors stay opt-in until this passes.
- [ ] HLOD coverage: decide the proxy (4 MiB) and source (64 MiB) admission caps and whether the cook declines proxies with no triangle reduction (cell 14_3: `srcTris=660 proxyTris=660`), then judge active proxies on more than cell 9_2. proof: `hlod.spec.ts` plus a judged before/after on the new cells.
