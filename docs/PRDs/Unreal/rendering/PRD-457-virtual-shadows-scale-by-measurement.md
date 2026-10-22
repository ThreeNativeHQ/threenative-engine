---
prd_contract: v1
---

# PRD-457 — Virtual shadows page only when pages are cheaper than cached clip levels

**Status:** PROPOSED — filed 2026-09-26.  
**Priority:** P1 — Declared required by P1 PRD-458 for its shadow half; 6 open boxes and no sparse page atlas renders yet.
**Complexity:** 7 → HIGH. The bookkeeping already exists; the risk is turning it on where many page renders cost more than the current cached-level path.  
**Depends on:** the shipped `VirtualShadowNode` and `virtual-shadow-pages.ts` infrastructure.

## Problem

The old UE-gap notes describe virtual shadows as greenfield, but that is no longer true.
`VirtualShadowNode` already ships camera-centred, texel-snapped directional clip levels, cached
static maps, separate mover maps, invalidation/reporting and native conformance. Separately,
`virtual-shadow-pages.ts` already contains a bounded physical page pool, receiver demand,
light-space page addressing and dirty-page tracking.

The current implementation deliberately **does not** render a sparse page atlas. Its source states
why: rendering the scene once per demanded page can cost more than rendering a small number of
cached clip levels, particularly for forests with many instanced meshes.

So the gap is not “implement VSM.” It is: **measure when the finer-grained machinery actually wins,
then admit it only for those workloads.**

## Outcome

A repeatable shadow-cost census compares today's cached-level renderer with a sparse-page candidate
on representative static/moving scenes. The engine uses sparse pages only if the workload and target
meet an explicit measured win gate; otherwise the existing clip-level path remains the default.

The work also produces the instrumentation needed to answer the next question—local-light shadow
scalability—without pretending directional clipmaps solve point/spot lights.

## Decisions

- **Measurement is Phase 1, not polish.** No sparse-page renderer is enabled until the baseline
  reports shadow GPU/render cost, level renders, mover renders, reuse ratio and demanded page count.
- **One shadow authority per light.** A directional light uses either cached clip levels or the
  admitted sparse-page path for a frame/configuration, never both as duplicate shadow work.
- **Reuse the existing page model.** `PhysicalPagePool`, `ReceiverDemandPass`,
  `ShadowInvalidationTracker` and `DirectionalClipmap` are incumbents, not scaffolding to rewrite.
- **Do not optimize draw calls by multiplying them.** Page rendering must batch/limit work so “24
  tiny pages” is not automatically 24 complete scene traversals.
- **2026-10-09 (João, via the Unreal review request): overflow degrades resolution before it switches path.** Unreal's answer to page-pool pressure (below) replaces this PRD's plain overflow fallback in Phase 2's first box. No other box changes.
- 2026-10-12 (Unreal source review): All cited line ranges and defaults match Unreal 5.8.3, except the static-return range, now `1767-1820`. The `trackCaster` remark was stale because PRD-572 is done. Unreal also skips small instances in coarse pages by pixel footprint. Phase 2's first box now names that limit.
- **Local lights are a measured follow-on.** This PRD may establish a common budget/update scheduler
  for one spot-light fixture, but does not claim full Unreal-style point/spot shadow virtualization
  unless the acceptance evidence actually covers it.
- 2026-10-19 (PRD-631 reference plan): [PRD-634](../look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md) now owns the template sun-shadow method and the source-angle penumbra, measured on layer L5 of the Unreal reference. If its Phase 1 picks virtual shadows, this PRD's page-cost gate decides whether that default holds the frame budget. No box changed.

## What Unreal does (UE 5.8.3, read 2026-10-09; ideas only, no code copied)

Paths are under `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/`.

- **It also refuses one scene traversal per page.** Non-Nanite instances render into all their
  pages in one batched pass (`VirtualShadowMapArray.cpp:490-494` and `:637-641`, both on by
  default). This supports this PRD's "do not multiply draw calls" decision: a page path that
  cannot batch has already lost.
- **Pressure lowers resolution before anything breaks.** When page allocation passes 0.85 of the
  pool, a global resolution LOD bias rises, up to 2 levels (`VirtualShadowMapCacheManager.cpp:155-187`).
  An experimental mode does the same from a measured shadow-depth time budget, smoothed with a
  history weight of 0.9 (`VirtualShadowMapArray.cpp:786-807`). The pool defaults to 2048 physical
  pages (`VirtualShadowMapArray.cpp:173-178`). This is the graceful step that Phase 2's first box
  now takes before its fallback. The cached-level path has the same idea in
  [PRD-549](../../performance/PRD-549-the-engine-holds-60-fps-on-a-weak-gpu.md) Phase 3: a level whose
  redraw exceeds its share halves its map.
- **Residency rules are cheap and already match.** An unrequested page lives at most 1000 frames
  (`VirtualShadowMapCacheManager.cpp:127-133`), and allocation keeps the most recently requested
  pages first (`VirtualShadowMapArray.cpp:527-532`). `PhysicalPagePool` already evicts by LRU.
- **Static and dynamic casters are sorted automatically.** Any invalidation marks an instance
  dynamic. After 100 frames with no invalidation it returns to the static cache
  (`VirtualShadowMapCacheManager.cpp:142-147`, `:1767-1820`). ThreeNative now does the same:
  [PRD-572](../../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md) shipped
  automatic mover detection with `staticAfterFrames` (default 100). `trackCaster`
  (`packages/core/src/render/virtual-shadow.ts:1244`) is only an override. Phase 1 counters count
  automatic and pinned movers together.
- **Small instances skip the coarse pages.** A dynamic non-Nanite instance under 16 pixels of
  estimated footprint is not drawn into a coarse page. The static limit is 1 pixel. A flag removes
  non-Nanite geometry from coarse pages entirely, and its text calls that a significant win
  (`VirtualShadowMapArray.cpp:437-443`, `:504-517`). A forest with many tiny instances is the case
  this PRD fears, so Phase 2 must apply a footprint limit before it counts page draws.
- **Soft shadows by shadow-map ray marching** (7 rays of 8 samples for a directional light,
  fewer in fully lit or fully shadowed areas; `VirtualShadowMapArray.cpp:674-678`, `:728-740`)
  are a desktop look option. They are out of scope here.

## Integration ledger

| Existing surface | Change |
| --- | --- |
| `packages/core/src/render/virtual-shadow.ts` | Add attributable per-frame shadow cost/work counters and, only after the gate, an admitted sparse-page render mode. |
| `packages/core/src/render/virtual-shadow-pages.ts` | Reuse demand, invalidation and LRU residency; extend only where real rendering requires missing metadata. |
| `packages/core/__tests__/virtual-shadow*.spec.ts` | Add work-count, invalidation, overflow and mode-selection contracts. |
| Native conformance | Run the same static/mover scenario and record the actual adapter/backend. |

### Phase 1 — Price the current path and the page demand

- [ ] A fixed shadow corpus records current clip-level renders, cached serves, mover-map renders, demanded/dirty page counts, submitted shadow draws and attributable GPU/render time. **proof:** browser WebGPU and desktop-native tables for static city block, moving forest and moving-caster fixtures include all counters from the same camera routes.
- [ ] The census derives a concrete admission threshold where page work is predicted cheaper than whole-level work, and a control workload where it is predicted worse. **proof:** verification report shows the arithmetic from observed demanded pages/draws/cost rather than a hard-coded “pages are faster” assumption.

### Phase 2 — Admit sparse pages only behind the measured gate

- [ ] The admitted path renders only demanded dirty pages into bounded physical storage and reuses clean resident pages. It skips instances under a pixel-footprint limit in coarse pages. Under pool pressure it first raises a resolution bias, and it falls back to the cached-level path only at the bias cap or on an unsupported case, never dropping shadows. **proof:** focused specs exercise demand, LRU eviction, invalidation, the footprint limit, the pressure bias and overflow; a forced-small pool preserves a valid shadow through the bias and then the fallback.
- [ ] Page marking skips back-facing receiver pixels, widens each marked page by a 0.05-page border, and requests a coarser level for out-of-focus pixels, as Unreal's VSM page marking does. **proof:** red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow-pages.spec.ts` on `ReceiverDemandPass`.
- [ ] On the Phase-1 winning workload, sparse pages reduce attributable shadow GPU/render p95 without increasing total frame p95 or visible shadow error beyond the pinned threshold. **proof:** paired A/B run on the same adapter records shadow cost, total frame cost, page/level render counts and image delta; if the win gate is missed, sparse mode remains unshipped/disabled.

### Phase 3 — Establish the local-light boundary honestly

- [ ] A many-light fixture attributes point/spot shadow cost separately from the directional path and demonstrates whether the same budget/update scheduler can reduce redundant updates for at least one supported local-light type. **proof:** fixture reports lights, faces/maps updated, shadow draws and GPU/render cost before/after scheduler reuse; unsupported light types are named.
- [ ] The public diagnostics distinguish directional clip/page work from local-light work so future MegaLights/local-shadow work starts from measured data. **proof:** diagnostics/parser test reads one mixed-light frame and reports separate counters whose totals reconcile with the renderer's shadow submissions.

## Acceptance criteria

ThreeNative already has a virtual-shadow implementation; this PRD succeeds by making its next
scaling step **conditional on measured value**. The sparse page path is not a checkbox to turn on.

If cached clip levels remain cheaper on the representative corpus, that is a valid result: keep the
current implementation and retain the new attribution data rather than regressing the engine to
look more like Unreal internally.
