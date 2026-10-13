# PRD-538 — Shadow maps redraw only what streamed in

**Status:** DONE — archived 2026-10-12 with every unverified requirement recorded under `## Blocked on`; the owner allowed this DONE archive rather than a `BLOCKED/<reason>/` file. No requirement below is claimed as met that is not ticked.
**Priority:** P2 — filed P2. The dirty-page redraw is implemented on this branch and AC-1 is proven; what stays open (native rectangle equivalence, the route timing window, the walk-03 visual regression) is blocked, not dropped.
**Complexity:** 6 (MEDIUM) — one engine module family (`render/virtual-shadow*.ts`), a partial render path through three's shadow pass, and a pixel-equivalence proof
**Owner:** João
**Depends on:** none.

## Context

Measured on Machinefall `map-walk`, desktop RTX 2080, live clock, PRD-478 branch `1fe8b3087` (2026-10-08):

| Fact | Value |
| --- | --- |
| Shadow levels | one, ±250 m, 4096² (`shadowExtents: [250]`) |
| Level renders per walk | 200–280 on `1fe8b3087`, 68–79 after PRD-478's `5a6d9d02f`/`ed75639ef` stopped terrain swaps and non-casting arrivals from invalidating; 13–20 are window moves |
| Invalidation delay | 0.25 s: the default is `0.25 * extent / finestExtent`, and a single level is its own finest |
| GPU p95 per 1500-frame route window | 3–4 ms late in the route; 9–12 ms early, where streaming is heaviest |
| Shadow GPU p95 in those windows | 3.9–6.6 ms |

A streamed cell changes a small part of the map, but `VirtualShadowNode` redraws the whole level for it. `invalidateRegion(region)` already says which part changed; today it only chooses *which levels* redraw.

**Correction, 2026-10-08:** quiet-desktop runs show that PRD-478's early-route GPU p95 (9.2–9.8 ms) is the main pass, not this shadow map: `gpuMain` p50 is 8.6 ms there, drawing 8.2 M triangles of single-level trees that the asset cook gave no LOD chain (fixed in [PRD-541](../assets/PRD-541-card-lod-levels-keep-the-canopy.md)). This PRD still removes a 4–6 ms spike from each redraw frame, but PRD-478's AC-2 no longer depends on it.

A longer delay is not the fix. It cuts renders but lets a newly streamed caster's shadow arrive late near the player, which PRD-478's AC-3 forbids.

## Solution

Redraw only the pages an invalidation touched. The level window is already a grid of `pagesPerAxis²` virtual pages (`virtual-shadow-pages.ts`), and window moves already snap to it. An invalidation with a region marks the pages it overlaps dirty. A redraw then renders only the dirty pages' rectangle:
- The shadow camera gets `setViewOffset` for that rectangle, so its depth values are the full map's.
- The target's viewport and scissor are the same rectangle.
- The rectangle's depth is reset first, because a WebGPU clear ignores the scissor.
- Casters are culled to the sub-frustum.

A window move, an invalidation with no region, or more than half the pages dirty still redraws the whole level.

Design notes from reading three r18x (2026-10-08):
- `Renderer` takes the viewport from `renderTarget.viewport`. It applies `renderTarget.scissor` only while the canvas target has `setScissorTest(true)`, so both must be set and restored around the partial render.
- A WebGPU clear wipes the whole attachment whatever the viewport. A partial redraw that clears would erase the rest of the map.
- An admission only adds casters, and an added caster can only bring a texel's depth closer, so an admission-only redraw needs no clear: render the new casters into the dirty rectangle with the existing depth test. An eviction removes casters, which needs the old depth cleared, so it resets the rectangle and redraws it, the way Phase 2 shipped (2026-10-12). That split is an admission path that is safe without a clear and an eviction path that resets its own rectangle.
- `ShadowNode.renderShadow` calls `shadow.updateMatrices(light)`, which builds the receivers' `shadowMatrix` from the camera's current projection. A `setViewOffset` applied before it would make every receiver sample the sub-rectangle as if it were the whole map. Apply the view offset after `updateMatrices`, or rebuild `shadowMatrix` from the full projection after the render. GPU-key dispatch calls `updateMatrices` a second time inside the render, after the view offset narrowed the camera, so that call would rebake the narrowed receiver matrix. Phase 2's matrix guard (`5d32860ec`) skips the second bake while a partial view offset is active, so the full receiver matrix baked before the offset is preserved and nothing is rebuilt.

What Unreal's virtual shadow cache does, read on 2026-10-09 (UE 5.8.3, ideas only, no code copied). Paths are under `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/`:
- **It confirms the page design.** Unreal invalidates the cached pages under an instance's bounds and redraws only those pages. It clears only pages it writes: a full clear of every page is a debug switch, off by default (`VirtualShadowMapArray.cpp:534-539`). This is the same plan as Phase 1 and the admission path of Phase 2.
- **Evictions are page work too.** In Unreal, a removed instance invalidates its pages like a moved one (`VirtualShadowMapCacheManager.cpp:566-568`), and those pages are cleared and redrawn. It never falls back to the whole map. Here, Phase 2 ships the far-depth rectangle reset (transparent-black transmitted shadow color included) instead of a full redraw, because a WebGPU clear ignores the scissor. Phase 1's stats box splits admission and eviction redraws. The eviction-share condition is now measured: on the paired `map-walk` captures, evictions are 40 of 42 invalidations in repeat 1 and 39 of 44 in repeat 2 — over a third in both, so the reset belongs in Phase 2. Those counts are fixed-step capture windows and say nothing about live route timing.
- **Spread the work, nearest first.** Unreal can cap the invalidated pages it consumes per frame. Pages over the cap keep their flag and retry the next frame, so the total work stays the same but spreads out (`VirtualShadowMapArray.cpp:119-128`; off by default, used today only for Nanite LOD changes). With the dirty-page set from Phase 1, a cap that redraws the pages nearest the camera first cuts the spike and still lands the near shadow in the first frame, which PRD-478's AC-3 requires. [PRD-549](../performance/PRD-549-the-engine-holds-60-fps-on-a-weak-gpu.md) Phase 3 spaces whole redraws by their GPU cost on a weak GPU (150–365 ms each on an Iris Xe). A page cap is the finer tool for the same spike once this PRD lands. It is a follow-up, not a box here.
- **Occluded changes cost nothing in Unreal.** An instance hidden in the light's depth pyramid causes no invalidation (`VirtualShadowMapCacheManager.cpp:104-108`, on by default). There is no light-view pyramid here ([PRD-489](PRD-489-gpu-scene-occlusion-culling.md) declined the camera one), so this is out of scope.

Layer: mechanism only, `packages/core/src/render/`. Nothing a game sets changes, and no appearance parameter is involved.

## Decisions

- 2026-10-12 (implementation of the inherited Phase 2 handoff): evictions use the proposed rectangular far-depth reset, including transparent-black transmitted shadow color, rather than retaining full redraws. The Intel GPU admission/mixed/eviction comparisons prove byte equivalence; the Machinefall eviction-share measurement is now recorded below and came in over a third, which the same entry required. Regionless asks, window moves, VSM and large dirty regions still redraw whole levels.

- 2026-10-12 (archive): the owner authorized this DONE filing with blockers. The native equivalence, the route timing and the visual regression stay unmet under `## Blocked on`, each with its own unblock step. Nothing was ticked to reach the archive.

- 2026-10-09 (João, via the Unreal review request): the Unreal reading above changes one box. It adds an admission/eviction split to Phase 1's stats box and the eviction-share condition to Phase 2's design, and names the nearest-first page cap as a follow-up.

- 2026-10-12 (Unreal source review): Every Unreal citation in this PRD matches 5.8.3 (batch counts, flags and defaults). The eviction claim now cites `VirtualShadowMapCacheManager.cpp:566-568`, and the clear-switch range is `534-539`. Unreal also lets a primitive marked as static-behavior ignore its move invalidations (`:572-575`). That matches the PRD-478 fix for terrain swaps and needs no new box.

- 2026-10-08, decided by the agent while the owner was away: this is a separate PRD rather than a fourth PRD-478 phase, because PRD-478 has three phases (R5).

## Acceptance Criteria

- [x] AC-1: a partial redraw produces the same depth texels as a full redraw of the same scene. proof: `pnpm --filter abyss-framework playtest:shadow-partial`. Result: Intel gen-12lp run 7 passed 17/17 assertions; final RTX 2080 WebGPU run 8 with `tnShadowGpuKeys=1` passed 20/20, including three receiver-matrix comparisons. Admission/mixed/eviction changed 2638/5263/2625 texels; all ten depth/color/matrix/restored mismatch counts were 0, with 2625 transmitted texels. Every texel is compared inside and outside the rectangle. Final report: `~/Downloads/prd538/shadow-partial-keys-run8-report.json`.

AC-2 and AC-3 are not met. Their full requirements and the reason each one stopped are the first two blocked items below.

## Execution Phases

#### Phase 1: Dirty pages
**Status:** DONE
**Files:** `packages/core/src/render/virtual-shadow.ts`, `virtual-shadow-pages.ts`; `packages/core/__tests__/`

- [x] `invalidateRegion` marks the pages of each level the region overlaps; a redraw with no region, a window move, or more than half the pages dirty marks the whole level. proof: red-green spec on the dirty-page set. Result: 5 specs in `virtual-shadow.spec.ts` (exact page count against `boundsToPageKeys`, no region, over half, window move) were red on missing `pagesDirty`, green after; `pnpm exec vitest run packages/core/__tests__/virtual-shadow*.spec.ts` 156 passed.
- [x] Stats report pages redrawn per render next to `rendersTotal`, split into admission and eviction redraws. proof: spec reading `stats`. Result: `pagesDirty`, `pagesRedrawn`, `byAdmission`, `byEviction` on `IVirtualShadowStats` and the marker line; admission/eviction and marker round-trip specs green. The render is still the whole level, so `pagesRedrawn` equals the level's page count until Phase 2.

#### Phase 2: Partial redraw
**Status:** DONE — browser proof complete; native proof is listed under Blocked on.
**Files:** `packages/core/src/render/virtual-shadow*.ts`, `packages/core/src/world-cells.ts`, core specs, and the abyss-framework shadow-partial probe/scenario.

2026-10-12: admission/eviction plumbing passed 343 focused tests across 18 files. Receiver initialization, transmitted-color reset, nested `NodeFrame` restoration and matching-scissor coverage passed 207 shadow tests. A fresh audit found GPU-key dispatch rebaking the narrowed receiver matrix; guarding that rebake reproduced red, then passed 144 focused specs plus root/example typechecks, Biome and budgets. Final RTX GPU evidence is recorded in AC-1. Commit `1177b1813` passed pre-push agents/docs/lint/drift checks, and the matrix guard is commit `5d32860ec` on this branch. Native proof was retried with the scissor/frame-restoration bundle and pinned NVIDIA libraries; its remaining failure is recorded under Blocked on.

- [x] An admission-only redraw renders only the dirty rectangle (`setViewOffset` after `updateMatrices`, matching viewport and scissor, no clear, casters culled to the sub-frustum); eviction rectangles reset depth/color before redrawing, and region-less invalidations keep the full redraw. proof: AC-1's depth-equivalence scenario with admission, mixed and eviction cases. Result: final RTX GPU run 8 passed all 20 assertions with GPU keys enabled; 207 shadow specs and the later 144-spec matrix-regression run passed, including scissor/shared-frame restoration on throws.

#### Phase 3: Measure on Machinefall
**Status:** BLOCKED — captures, counts and blind judging ran to a verdict; the timing and no-visual-loss requirements did not pass and are kept, with their original wording, under `## Blocked on`.
**Files:** none in the engine

2026-10-12 outcome, base `934de90ad` against candidate `5d32860ec`:

- Captures. Two headed WebGPU runs at 1280×720, repeats per arm, 4 `map-walk` plus 4 `map-views` poses plus 34 `world-capture` pop poses — 84 paired poses. All 12 capture runs passed on an NVIDIA Turing RTX 2080 adapter with 0 diagnostics. Files in `~/Downloads/prd538/captures`. Fourteen public BEFORE/AFTER sheets are on the orphan branch `prd538-screenshots` at commit `020a0a5f` ([folder](https://github.com/ThreeNativeHQ/threenative-engine/tree/020a0a5f77e7b9cb9eef6db8f6ebe5228ab81e96)); the per-frame judge report goes on the PR, not here.
- Walk counts. Repeat 1: admission 2, eviction 40, invalidation 42, moves 16, renders 58. Repeat 2: admission 5, eviction 39, invalidation 44, moves 15, renders 59. Both repeats put evictions over a third of invalidations, which is what Phase 2's eviction-share condition asked for. They are fixed-step capture windows and measure no live route timing.
- Blind judging. Two fresh read-only judges, 42 pairs each. Repeat 1: walk 3 REGRESSION (02 softer, 03 lost road shadows, 04 softer) and 1 NEUTRAL; views 2 IMPROVEMENT (02/03 richer terrain) and 2 NEUTRAL; world 15 IMPROVEMENT (base had missing mountains on 02–16) and 19 NEUTRAL — 17 IMPROVEMENT, 22 NEUTRAL, 3 REGRESSION. Repeat 2: walk 1 REGRESSION (03 loses foliage and road shadows) and 3 NEUTRAL; views 1 IMPROVEMENT (candidate avoids base's road-blocking rock on 03) and 3 NEUTRAL; world 34 NEUTRAL — 1 IMPROVEMENT, 40 NEUTRAL, 1 REGRESSION. The candidate reads as a REGRESSION overall, because `map-walk` pose 03 regressed in both repeats. The world-pose improvements do not offset it and the phase does not pass.
- Read-only diagnostics. Camera position and target match between arms, fixed step, 4383 frames of about 60 s of fly time, viewport 1280×720, deferred 0, candidate run 1 held at 0, and neither arm had a render-scale field. At the first by-move rise: base 1 at frame 300, base 2 at frame 420, candidate 2 at frame 600, candidate 1 at frame 1200. Candidate 1's invalidation count stayed at 4 until frame 1140 against base 1's 43 by frame 1020. Totals converge by the end of both arms and the two candidate runs are spread apart, so asynchronous streaming or capture timing and a partial-shadow lag both fit the numbers. The cause is undetermined, and this PRD does not claim one.

2026-10-12 repair pass, local only and no GPU: reading the partial-redraw path end to end against the walk03 captures narrows the cause but does not prove one, so no engine file changed. Three results, each from the code as it stands:

- Coverage cannot be lost through the world tell. `WorldCells` now hands the shadow node two regions where it handed one union, and `dirtyAdmit` and `dirtyEvict` hold both, so every ask dirties at least the pages the base dirtied. The candidate also escalates to a blanket `invalidateAll()` on a missing, empty or non-finite box, where the base skipped that batch and kept a narrower region. The base image is the reference, so a coverage hole on this path cannot explain the candidate showing less shadow.
- The narrowed frustum keeps every caster a whole map keeps. A map texel is keyed by the caster's light-space `u` and `v`, and both axes are perpendicular to the light direction, so a caster and the ground it shadows share one texel. Narrowing the camera to the rectangle keeps exactly the casters whose footprint reaches it: three culls on the object's own published `boundingSphere`, which every `WorldCells` batch sets, and the GPU key dispatch culls on the placement sphere with the same footprint. A tall caster is not culled away, so the instanced fallback in `#casterBounds` is not on this path.
- The page grid is the texel grid. `DirectionalClipmap` is built with `pagesPerAxis: mapSize`, and a window is centred on its own centre, so one page is one texel and the rectangle's page corners land on whole texels. The nearest rounding in `pixelRect` therefore cannot drop a texel here, and the one-texel-per-edge reading is unreachable in this configuration.

What is left is the draw itself, which no CPU test reaches: whether the scissored, no-clear rectangle draw writes the texels a whole-level render would have written. That needs a GPU run. The next probe logs, on the walk03 frame, each pass's rectangle, the caster draws it submitted and the depth the rectangle holds after it.

Paired images, repeat 2 (`~/Downloads/prd538/captures/{base-2,cand-2}-map-walk`): `01-camp` and `02-first-stream` are pixel-identical between the arms (mean absolute difference 0.00 and 0.01 of 255), `04-bridge` differs by a mean of 0.12, and only `03-highway` differs. There the candidate is 10.5 levels brighter on average, 29.6% of its pixels are more than 10 levels brighter and 0.5% are more than 10 levels darker. The loss is one checkpoint of four and not cumulative, so a rectangle that permanently fails to cover its dirty pages does not fit it.

2026-10-12 second repair pass, local only and no GPU: one defect in the partial path is now proven on the actual code and fixed. It is not the draw the previous paragraph left open, and this file does not claim it explains walk03.

- Cause. A granted render planned its rectangles first and then ran `#deriveDepth` on both kinds of render. The derived span is the camera's `near`/`far`, so a streamed caster that widens it re-encoded the whole depth axis while every texel outside the redrawn rectangles kept the values the previous span encoded. The kept texels were then read through a receiver matrix built from the new span. Reproduced red on `virtual-shadow.spec.ts` "should redraw the whole level when a streamed caster moves the span a partial redraw would keep": the span moved and the redraw was still a rectangle. Log `/tmp/prd538-projection-red.log`.
- Not the same defect. A centre that travels along the light only slides the camera down its own axis, so the receiver matrix and every kept texel land where they did; the second test "should keep a partial redraw partial while its span holds, across a camera move along the light" measures that and passed before the fix. The scissored draw, the coverage and the page/texel grid are untouched by this change.
- Fix. `packages/core/src/render/virtual-shadow.ts`: the depth is derived first and a moved span turns the render into a whole-level one, with `#pagesDirty` and `#pagesRedrawn` corrected by the pages the rectangles had already counted. The span is still measured, never pinned or skipped.
- GREEN. `pnpm exec vitest run` over the nine shadow specs: 210 passed, 0 failed (118 in `virtual-shadow.spec.ts`, 2 of them new). `@threenative/core` and `abyss-framework` `tsc --noEmit` exit 0. Biome clean; the only lint delta is `#updateFrame`'s pre-existing complexity warning, 97 to 101.
- UNRUN. `examples/abyss-framework/playtests/shadow-partial.playtest.json` gains a `Travelled` step: the play camera travels 6 m along the sun while the page window stands still, then a caster arrives. Its seven new assertions are written and unproven, because no GPU run was made in this pass. That scene pins `lightDistance` and `depthRange`, which switches the derived span off, so the automatic-span case above still has no GPU proof and the probe's 20 existing assertions keep their original meaning.
- Remaining blocks unchanged: the visual A/B on walk03, the route-window `gpuShadowP95` timing, and native rectangle equivalence all stay under `## Blocked on` below. The walk03 cause is still undetermined; this pass proves a defect, not that this defect caused it.

## Blocked on

- **AC-2 and the Phase 3 "AC-2's timing pairs" box — route-window shadow GPU p95.** The requirement stands exactly as filed: Machinefall `map-walk` route-window shadow GPU p95 falls against this PRD's base, proved by 3 interleaved live-clock pairs, `TN_FRAME_BUDGET` `gpuShadowP95`, 1500-frame windows. It is unproven because the harness never reached the route. The 1500-frame config was set identically in both private caches and rebuilt, then 2 of 6 attempts failed before the route with `state.loading` never becoming true; the stop rule fired after the second attempt with the same cause. The quiet-machine threshold was missed too: before each launch, base 1 measured a load of 10.28 at 1% GPU and candidate 1 a load of 9.71 at 50% GPU, against a quiet threshold of load below 6 and GPU at or below 5%. The result is zero 1500-frame windows and no `gpuShadowP95` median or percentage change; base 2, candidate 2, base 3 and candidate 3 were not run. Artifacts in `~/Downloads/prd538/timing`. No substitute metric stands in for it — `gpuShadowRendered` is not claimed as a proxy. Unblock by catching the missed transient `loading=true` in the harness while keeping the route and its assertions intact, run the pairs on a quiet RTX 2080, and report `gpuShadowP95` over paired 1500-frame windows with comparable tick ranges.

- **AC-3 and the Phase 3 "AC-3's blind A/B and pop series" box — no visual loss.** The requirement stands exactly as filed: a blind A/B against the base on the 4 `map-walk` and 4 `map-views` poses, plus the `world-capture` pop series, shows no visual loss, with the sheets on the PR (the uploaded sheets will be embedded there shortly). It fails today. Two fresh blind judges score the candidate as a REGRESSION overall, on `map-walk` pose 03 in both repeats (repeat 1: lost road shadows, softer frames 02 and 04; repeat 2: loses foliage and road shadows). The cause is not determined; the read-only diagnostics above only show when the arms diverge, not why. Unblock by instrumenting the admission queue and the divergence frames to separate asynchronous streaming or capture timing from a partial-shadow lag, then rerunning the same two arms against the same base and re-judging blind. Until that rerun lands, this PRD claims no visual pass.

- **Phase 2 native rectangle equivalence** remains unverified. The final bundle (SHA256 `b6458dbe2c7968a3bf33fc2de892d02d3b29003dca3e3fbc0d1cb4f20073afe6`, including frame/scissor restoration) acquires the RTX 2080 with `~/.cache/nvidia-615.71.09/env.sh`, then aborts in `wgpuQueueSubmit`: `Buffer with '' label is still mapped`. That bundle predates the matrix guard `5d32860ec`, so it does not cover the final candidate. The unlimited-file-size direct retry exited 1/SIGABRT; log `/tmp/prd538-native-final-unlimited.log`. Native playtest attempts evaluated no partial assertions, so there is no native rectangle equivalence result. Conformance 33/64 each rendered 300 frames and exited 0, but test configuration/CPU projection rather than GPU rectangle equivalence; their runner also lacked browser references. Unblock by repairing native readback/unmap behavior and rerunning the same `--target desktop` shadow-partial scenario or adding a GPU depth-equivalence conformance case. No native parity is claimed.
