# PRD-605 — The probe field follows the camera in nested rings

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 value gate, the camera rings and the ring-aware refresh order are all unbuilt.
**Complexity:** 6 (MEDIUM) — 1–5 implementation files: `probe-volume.ts`, one ring helper, specs, one conformance scene (+1), new state: ring origin, wrap addressing, cell ages (+2), new sampler path across rings (+1), native proof (+1), two prerequisite PRDs (+1); risk override: none
**Owner:** unassigned
**Depends on:** Part of the GI set in [`../gi/`](../gi/) (PR #541). Phase 1 depends on nothing. Phases 2 and 3 depend on [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (a refresh cheap enough to follow a camera) and [PRD-604](PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md) Phase 2 (the explicit corner sampler and the validity weight). If either PRD declines at its gate, this PRD records a decline in `## Decisions` unless the executor re-scopes it.

## Context

`ProbeVolume` has fixed bounds. Its option comment says "the volume does not move with the object after construction" (`packages/core/src/render/probe-volume.ts:83`). Density is one value for the whole box (`probe-volume.ts:86`). The atlas stacks seven coefficient volumes along z with padding, so its depth is `7 × (zResolution + 2)` and must fit the device `maxTextureDimension3D` (`checkedAtlasDepth`, `probe-volume.ts:1430`). With the WebGPU default limit of 2048, one axis holds at most 290 probes.

A world volume is therefore possible in memory but not in time. The 256 m open-world fixture (`examples/abyss-framework/src/scenes/WorldProbe.ts`, 32 m tall) at 0.5 probes per metre has 129 × 17 × 129 = 282,897 probes. Its atlas is 129 × 17 × 917 texels at 16 bytes each, about 31 MiB. Even if PRD-603 refreshes 16 probes per frame, a full pass takes 17,681 frames, about 5 minutes at 60 fps. Most of that work lights probes the player cannot see. A uniform 2 m spacing is also too coarse near the camera and too fine at the horizon.

[PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) ships the room-scale volume and says it is "static-lighting-first". [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) covers dirty regions inside a fixed volume. Nothing covers a volume that moves. Whether a moving volume pays off in an outdoor scene is open. Phase 1 measures it before any code is written.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Nested levels around the eye.** The radiance cache has 4 levels by default. The first spans 2,500 world units (centimeters) and each next level is 2 times larger. Each level is a grid of 48 cells per axis (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:604-640`). The cheaper irradiance-field path uses 4 levels, a first extent of 5,000 units and a grid of 64 (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenIrradianceFieldGather.cpp:18`, `:26`, `:49`).
- **A position uses the finest level that covers it.** The loop starts at level 0. A level accepts a point when the point lies inside it and outside an edge-fade band, compared with a dither value. Otherwise the loop moves to the next level (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenRadianceCacheMarkCommon.ush:60-88`). The 8 probes around the point are the ones marked (UE 5.8.3: `LumenRadianceCacheMarkCommon.ush:76-77`).
- **Only used probes exist.** A pixel writes a "used" marker for each probe it interpolates (UE 5.8.3: `LumenRadianceCacheMarkCommon.ush:102-107`). A probe that stays marked keeps its slot, a probe unmarked for 8 frames frees it, and a new probe takes a free slot (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenRadianceCacheUpdate.usf:96-135`). The slot pool is 128 × 128 probes by default and an overflow "results in incorrect rendering" (UE 5.8.3: `LumenScreenProbeGather.cpp:657-663`).
- **Coarse levels refresh less.** The refresh priority divides the age gap by the level index plus one (UE 5.8.3: `LumenRadianceCacheUpdate.usf:221-241`). A new probe jumps to the front. PRD-603 describes the budget pass.
- **The irradiance field keeps probes 2 frames.** Its probes are marked by the GBuffer pixels that read them, at half resolution and jittered, and leave after 2 unused frames (UE 5.8.3: `LumenIrradianceFieldGather.cpp`, `MarkProbesUsedByGBufferCS`). The screen-probe radiance cache keeps them 8 frames.
- **The mainstream tier skips screen probes.** Medium quality sets the final-gather method to the irradiance field, which "places world space radiance cache probes around pixels, pre-calculates their irradiance, and interpolates" (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/Lumen.cpp:56-62`, `Engine/Config/BaseScalability.ini:333`). That is the closest Unreal analogue of `ProbeVolume`.

## Solution

1. **Measure first (Phase 1).** Two measurements decide whether the PRD continues. First, bake one coarse static volume over the 256 m fixture (0.1 probes per metre) with a raised work-item budget, offline. Run the visual judge on the same pose with and without it, and compare both against the Unreal L7 exterior cells of PRD-631. The owner made Lumen-like GI the default on 2026-10-19, so the judge's stated target is the Unreal frame, not "no field". Second, run the fly-through with 4 candidate rings of 24 × 12 × 24 cells and record the share of cells that sit inside the camera frustum, per frame. **Gate:** continue only if the judge returns IMPROVEMENT on at least one frame with no REGRESSION, and the median frustum share is 50% or less. A NEUTRAL verdict against the Unreal target means outdoor scenes do not need the field at this density, and the PRD declines (R4) with the Unreal comparison recorded.
2. **Rings (Phase 2).** `ProbeVolume` gains an optional `follow` object, the same idea as `IDaylightOptions.follow` (`packages/core/src/render/daylight.ts:21`). With `follow` and no `bounds`, the volume becomes rings. The finest ring uses the given `density`. Each next ring doubles the cell size. The ring count comes from the camera far distance, capped at 4 and limited by the device 3D texture size. This is the auto default. The grid size per ring follows the same limit and a byte budget that the game may lower. Each ring origin snaps to whole cells of its own size as the eye moves. A cell keeps its storage slot through toroidal wrap addressing, so a scroll moves no data. A cell that enters the ring is stale and untraced. Until its first refresh, it carries zero weight, using PRD-604's validity weight. If all eight corners of a sample have zero weight, the sampler falls through to the next coarser ring. The sampler picks the finest ring whose interior, minus a one-cell margin, holds the point. It blends two rings only inside that margin.
3. **Ring-aware refresh (Phase 3).** The PRD-603 stale queue gets the ring index as the divisor of its priority, and a "used" window: a cell outside the frustum for 8 frames stops refreshing. Its data stays readable. The game does not pick a ring count, an extent or a priority.

**Why not an indirection pool like Unreal.** Unreal's grids are 48³ per level, so a pool of used probes saves memory. The rings here are about 24 × 12 × 24 cells, roughly 7,000 probes per ring and 28,000 for four, near 3 MiB. Wrap addressing costs one modulo per corner. An indirection texture would cost one extra fetch per corner. Reopen the pool idea if Phase 1 shows a used share under 10% and a bigger grid is wanted.

**Names.** The rings are Unreal's radiance cache clipmaps, so the options take Unreal's names in camelCase: `numClipmaps` (4), `clipmapWorldExtent` (50 m for the irradiance field, in metres, not Unreal centimetres), `gridResolution` (64 in Unreal; this PRD starts at 24 × 12 × 24, see below). They live on `RadianceCache` ([PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md)). The manifest entry carries `@alias lumen radiance cache clipmaps`. Unreal marks used probes from the pixels that read them. This PRD uses a CPU frustum test first, because it needs no readback. Phase 3 switches to pixel marking only if the frustum test refreshes many probes no pixel reads.

**Where each part lives.** Ring layout, wrap addressing and the priority change are mechanism in `packages/core/src/render/`. The game's materials still call `sampleNode` and still own the composite. `TN_PROBE_VOLUME` adds the ring count, per-ring cell size, per-ring atlas bytes, and the stale share of cells in view.

**Consumer flow.** The game builds `RadianceCache({ follow: ctx.camera, density, trace })` and adds it with `ctx.add()`. The volume centers itself on the camera each frame, refreshes the stalest used cells inside its budget, and answers `sampleNode` from the finest ring that is ready.

## Acceptance Criteria

- [ ] AC-1 [local]: On the `?world` fly-through, after 120 warm-up frames, at most 5% of the cells inside the frustum are stale, and no refresh slice exceeds 2.5 ms. — proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/probe-rings.playtest.json --url 'http://127.0.0.1:5183/?world&probeRings' --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5183 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: The total ring atlas size is 8 MiB or less at the default, and `TN_PROBE_VOLUME` reports the bytes per ring. — proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts` — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The new conformance row `probe-volume-rings` passes on the desktop lane within its tolerance. It covers one scroll step and one ring-boundary sample. — proof: `pnpm parity --target desktop --only-tests probe-volume-rings` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Camera-following rings | A game passes `follow` to `ProbeVolume` and leaves out `bounds` | Fixed bounds stay for room-scale volumes. Both forms share one sampler | AC-1 |
| Ring-aware refresh order | The PRD-603 stale queue, every frame | Extends the PRD-603 priority with the ring divisor and the used window | AC-1 |
| `probe-volume-rings` conformance row | `pnpm parity` on web and desktop | New row in `packages/runtime-native/conformance/registry.json` | AC-3 |

## Execution Phases

#### Phase 1: Decide whether a world needs the field
**Status:** NOT STARTED
**Files:** `examples/abyss-framework/src/scenes/WorldProbe.ts`, `examples/abyss-framework/playtests/probe-rings.playtest.json` (new)
**Implementation:** add `?probeRings=static` to the world scene. It builds the coarse volume and raises `maxWorkItemsPerFrame` and `bakeBudgetMs` for the offline bake, which is acceptable for a one-time measurement. Add `?probeRings=share` to log the frustum share of candidate ring cells per frame. The verdict goes under `## Decisions`.
- [ ] The visual judge verdict for the coarse static volume against none, on the same pose, is recorded here. proof: the AC-1 playtest command with `probeRings=static`, two runs per arm, adapter named
- [ ] The median and 95th-percentile frustum share of ring cells on the fly-through is recorded here. proof: the AC-1 playtest command with `probeRings=share`
**Verification:** the gate in Solution step 1 decides whether Phases 2 and 3 continue.

#### Phase 2: Rings with wrap addressing
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/src/render/probe-rings.ts` (new), `packages/core/__tests__/probe-volume.spec.ts`
**Implementation:** ring layout from density, camera far and device limits, snapped origins, wrap addressing, stale untraced entry, the finest-ready-ring sampler and the one-cell blend margin. Fail closed: a request larger than the device 3D texture limit throws at construction and names the limit.
- [ ] After a scroll step, cells that stay keep their values exactly, and cells that enter report stale and read as zero weight, not black light. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
- [ ] On the CPU reference sampler, a point crossing a ring boundary changes by 2% or less per centimeter step. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
**Verification:** AC-2 closes this phase. The change alters what reaches the screen, so the visual judge from the root `AGENTS.md` runs on the fly-through, with one frame taken just after a scroll. A NEUTRAL or REGRESSION verdict means fix the cause and judge again.

#### Phase 3: Refresh where the camera looks
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/runtime-native/conformance/scenes/shared/probe-volume-rings.js` (new), `packages/runtime-native/conformance/registry.json`
**Implementation:** the ring divisor and the 8-frame used window in the stale queue, then the conformance scene. Fix or record the cause of the existing `probe-volume-sample` desktop failure first (`docs/verification/tier-1-2026-09-29.md:152`).
- [ ] A cell outside the frustum for 8 frames stops refreshing but stays readable, and with equal age a finer ring wins the budget. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
**Verification:** AC-1 and AC-3 close this phase.
