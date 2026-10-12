# PRD-538 — Shadow maps redraw only what streamed in

**Status:** IN PROGRESS
**Priority:** P2 — Open: streaming invalidations re-render a whole 4096² shadow map 68–79 times per walk; each render costs 4–6 ms of GPU.
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

**Correction, 2026-10-08:** quiet-desktop runs show that PRD-478's early-route GPU p95 (9.2–9.8 ms) is the main pass, not this shadow map: `gpuMain` p50 is 8.6 ms there, drawing 8.2 M triangles of single-level trees that the asset cook gave no LOD chain (fixed in [PRD-541](../../assets/PRD-541-card-lod-levels-keep-the-canopy.md)). This PRD still removes a 4–6 ms spike from each redraw frame, but PRD-478's AC-2 no longer depends on it.

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
- An admission only adds casters, and an added caster can only bring a texel's depth closer, so an admission-only redraw needs no clear: render the new casters into the dirty rectangle with the existing depth test. An eviction removes casters, which needs the old depth cleared, so evictions keep the full redraw (or a later depth-reset pass). This splits Phase 2 into an admission path that is safe without a clear and an eviction path that stays full.
- `ShadowNode.renderShadow` calls `shadow.updateMatrices(light)`, which builds the receivers' `shadowMatrix` from the camera's current projection. A `setViewOffset` applied before it would make every receiver sample the sub-rectangle as if it were the whole map. Apply the view offset after `updateMatrices`, or rebuild `shadowMatrix` from the full projection after the render.

What Unreal's virtual shadow cache does, read on 2026-10-09 (UE 5.8.3, ideas only, no code copied). Paths are under `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/`:
- **It confirms the page design.** Unreal invalidates the cached pages under an instance's bounds and redraws only those pages. It clears only pages it writes: a full clear of every page is a debug switch, off by default (`VirtualShadowMapArray.cpp:534-539`). This is the same plan as Phase 1 and the admission path of Phase 2.
- **Evictions are page work too.** In Unreal, a removed instance invalidates its pages like a moved one (`VirtualShadowMapCacheManager.cpp:566-568`), and those pages are cleared and redrawn. It never falls back to the whole map. Here, Phase 2 keeps the full redraw for evictions, because a WebGPU clear ignores the scissor. A far-depth quad drawn inside the scissor resets the rectangle and gives the same per-page eviction. Phase 1's stats box now splits admission and eviction redraws. If evictions are over a third of invalidations on `map-walk`, that reset belongs in Phase 2.
- **Spread the work, nearest first.** Unreal can cap the invalidated pages it consumes per frame. Pages over the cap keep their flag and retry the next frame, so the total work stays the same but spreads out (`VirtualShadowMapArray.cpp:119-128`; off by default, used today only for Nanite LOD changes). With the dirty-page set from Phase 1, a cap that redraws the pages nearest the camera first cuts the spike and still lands the near shadow in the first frame, which PRD-478's AC-3 requires. [PRD-549](../../performance/PRD-549-the-engine-holds-60-fps-on-a-weak-gpu.md) Phase 3 spaces whole redraws by their GPU cost on a weak GPU (150–365 ms each on an Iris Xe). A page cap is the finer tool for the same spike once this PRD lands. It is a follow-up, not a box here.
- **Occluded changes cost nothing in Unreal.** An instance hidden in the light's depth pyramid causes no invalidation (`VirtualShadowMapCacheManager.cpp:104-108`, on by default). There is no light-view pyramid here ([PRD-489](../../done/PRD-489-gpu-scene-occlusion-culling.md) declined the camera one), so this is out of scope.

Layer: mechanism only, `packages/core/src/render/`. Nothing a game sets changes, and no appearance parameter is involved.

## Decisions

- 2026-10-12 (implementation of the inherited Phase 2 handoff): evictions use the proposed rectangular far-depth reset, including transparent-black transmitted shadow color, rather than retaining full redraws. The Intel GPU admission/mixed/eviction comparisons prove byte equivalence; the Machinefall eviction-share measurement remains required. Regionless asks, window moves, VSM and large dirty regions still redraw whole levels.

- 2026-10-09 (João, via the Unreal review request): the Unreal reading above changes one box. It adds an admission/eviction split to Phase 1's stats box and the eviction-share condition to Phase 2's design, and names the nearest-first page cap as a follow-up.

- 2026-10-12 (Unreal source review): Every Unreal citation in this PRD matches 5.8.3 (batch counts, flags and defaults). The eviction claim now cites `VirtualShadowMapCacheManager.cpp:566-568`, and the clear-switch range is `534-539`. Unreal also lets a primitive marked as static-behavior ignore its move invalidations (`:572-575`). That matches the PRD-478 fix for terrain swaps and needs no new box.

- 2026-10-08, decided by the agent while the owner was away: this is a separate PRD rather than a fourth PRD-478 phase, because PRD-478 has three phases (R5).

## Acceptance Criteria

- [x] AC-1: a partial redraw produces the same depth texels as a full redraw of the same scene. proof: `pnpm --filter abyss-framework playtest:shadow-partial`. Result: Intel gen-12lp WebGPU run 7, 17/17 assertions passed; admission/mixed/eviction changed 2638/5263/2625 texels, all depth/color mismatch counts and restored mismatch 0, 2625 transmitted texels. The probe compares every texel, inside and outside the dirty rectangle; report: `~/Downloads/prd538/shadow-partial-scissor-run7-report.json`.
- [ ] AC-2: Machinefall `map-walk` route-window shadow GPU p95 falls against this PRD's base. proof: 3 interleaved live-clock pairs, `TN_FRAME_BUDGET` `gpuShadowP95`, 1500-frame windows.
- [ ] AC-3: no visual loss. proof: a blind A/B against the base on the 4 `map-walk` and 4 `map-views` poses, plus the `world-capture` pop series.

## Execution Phases

#### Phase 1: Dirty pages
**Status:** DONE
**Files:** `packages/core/src/render/virtual-shadow.ts`, `virtual-shadow-pages.ts`; `packages/core/__tests__/`

- [x] `invalidateRegion` marks the pages of each level the region overlaps; a redraw with no region, a window move, or more than half the pages dirty marks the whole level. proof: red-green spec on the dirty-page set. Result: 5 specs in `virtual-shadow.spec.ts` (exact page count against `boundsToPageKeys`, no region, over half, window move) were red on missing `pagesDirty`, green after; `pnpm exec vitest run packages/core/__tests__/virtual-shadow*.spec.ts` 156 passed.
- [x] Stats report pages redrawn per render next to `rendersTotal`, split into admission and eviction redraws. proof: spec reading `stats`. Result: `pagesDirty`, `pagesRedrawn`, `byAdmission`, `byEviction` on `IVirtualShadowStats` and the marker line; admission/eviction and marker round-trip specs green. The render is still the whole level, so `pagesRedrawn` equals the level's page count until Phase 2.

#### Phase 2: Partial redraw
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/virtual-shadow*.ts`, `packages/core/src/world-cells.ts`, core specs, and the abyss-framework shadow-partial probe/scenario.

2026-10-12: admission/eviction plumbing passed 343 focused tests across 18 files. Receiver initialization, transmitted-color reset, nested `NodeFrame` restoration and matching-scissor coverage passed 207 shadow tests; core/example typechecks and focused Biome checks passed. Final Intel GPU evidence is recorded in AC-1. Native parity remains unverified: pinned NVIDIA 615.71.09 acquires the RTX 2080, but the pre-final bundle aborts after 300 frames with `wgpuQueueSubmit: Buffer with '' label is still mapped`; a final-bundle/conformance retry is still required.

- [x] An admission-only redraw renders only the dirty rectangle (`setViewOffset` after `updateMatrices`, matching viewport and scissor, no clear, casters culled to the sub-frustum); eviction rectangles reset depth/color before redrawing, and region-less invalidations keep the full redraw. proof: AC-1's depth-equivalence scenario with admission, mixed and eviction cases. Result: GPU run 7 passed all 17 assertions; 207 shadow specs passed, including scissor and shared-frame restoration on throws.
- [ ] The native host draws the same rectangle. proof: a native conformance case or a `--target desktop` playtest of a streamed world (repository rule: a web-only path is unfinished).

#### Phase 3: Measure on Machinefall
**Status:** NOT STARTED
**Files:** none in the engine

- [ ] AC-2's timing pairs. proof: `TN_FRAME_BUDGET` windows, recorded here.
- [ ] AC-3's blind A/B and pop series. proof: sheets on the PR.

## Blocked on

- Final timing needs the desktop RTX 2080 at low load. On 2026-10-07/08 it sat at load 6–33 because of other sessions.
