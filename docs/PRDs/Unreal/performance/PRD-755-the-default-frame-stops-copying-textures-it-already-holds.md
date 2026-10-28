# PRD-755 — The default frame stops copying textures it already holds

**Status:** IN PROGRESS
**Priority:** P1 — on Iris Xe, 14.0 ms of the 19 ms Hop Garden frame does not scale with the render resolution ([PRD-741](../../done/PRD-741-the-owned-engine-shades-fewer-pixels-and-its-temporal-resolve-writes-the-display-frame.md), final box); the copies and blits below are part of it, on every game with the default look.
**Complexity:** 4 (MEDIUM) — the temporal resolve and the post-target render path in the native renderer (+2), bit-identical output proven by readback (+1), a GPU A/B on Iris Xe (+1).
**Owner:** João
**Parent:** [PRD-400](../../performance/PRD-400-the-frame-gets-cheaper-one-measured-cost-at-a-time.md) (it owns the remaining fixed cost). Sibling: [PRD-756](PRD-756-the-temporal-resolve-feeds-one-shared-post-chain.md). Lane of the PR #574 follow-up.
**Depends on:** none.

**Update rule:** this PRD has no PR of its own. Its commits land on `lane/pr574-gpu` and merge into the PR #574 follow-up. Tick each box, with its result, in the commit that proves it.

## Problem

Found by reading the code and the PRD-741 per-pass table (2026-10-27):

- The resolve copies three textures into history every frame instead of swapping them: the display-size `RGBA16Float` colour, the input-size depth and the `RG8` motion mask (`packages/runtime-native/src/engine/renderer/post/traa.cpp:653-654`). That is about 50 MB of memory traffic a frame at 1080p (estimate: bytes read plus bytes written). The pass timer does not see copies, so no dashboard shows this cost.
- Every post-target render (bloom chain, local exposure, meters) draws its scene pass, then an `output` pass into the target (`Renderer::outputPass`, `packages/runtime-native/src/engine/renderer/renderer.cpp:4467`). The PRD-741 table holds 28 `output / 2 / N` occurrences, about 0.45 ms summed on Iris Xe (measured per pass).

## What Unreal does (UE 5.8.3)

- TSR keeps its history as render-graph textures and extracts the new ones for the next frame; it copies nothing. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:3505-3518` (`QueueTextureExtraction`).

## Goal

The resolve and the post targets do the same work with no history copy and no extra output pass, the frame is bit-identical, and a test fails when either lever is undone.

### Phase 1: The resolve swaps its history

- [x] The colour history and the motion mask are swapped each frame instead of copied, and the resolve writes the next history directly. A counter reports the resolve's texture copies per frame. proof: a new ctest, red at 3 copies a frame, green at 0 (or 1 if the scene depth stays a copy, with the reason here); every `native_engine_traa_*` ctest passes with unchanged metric values. Result (`aecafb9ba`): `native_engine_traa_history_swap` red `steady=3 (colour 1, depth 1, mask 1)`, green `steady=1 (colour 0, depth 1, mask 0)`, also into a caller's target. The depth stays one copy: it is the caller's scene depth, which the resolve only samples. With a caller target, the next history is a third colour attachment (one 8 B/px write in place of an 8 B/px read plus write). `ctest -R "native_engine_traa|native_engine_renderer|velocity_needs_traa"` 95/95 (93/93 before, metric lines unchanged), rerun by the lead.
- [x] The resolved frame is bit-identical to the copy path over 60 frames of a moving scene. proof: a ctest that reads back both paths. Result: `native_engine_traa_history_swap_is_bit_identical` `120 frames compared, 0 differing`; with the swap undone, 118 differ, so the check is not vacuous.

### Phase 2: A post target draws without the extra output pass

- [ ] A render into a post target whose output stage is an identity draws its scene pass straight into the target. proof: a ctest, red at one `output` pass per target render, green at 0.
- [ ] The target holds the same pixels as the old path, or this box records why it cannot. proof: a readback ctest.

### Phase 3: Prove it on games

- [ ] Paired GPU A/B on Iris Xe, Hop Garden medium and the shooter, three pairs from one code state, GPU p50 and presented p95, load and temperature recorded. proof: the table here.
- [ ] The kit scenarios pass on both kits. proof: `pnpm test:templates` on Hop Garden and the shooter.

## Done when

Every box above is ticked.

## Decisions

- 2026-10-27, lead: with no caller target the resolve still writes a third attachment beside `resolve_`. Resolving straight into the next history slot would remove that write too, at the cost of a second pipeline. Left for Phase 3's measurement to price.

## Blocked on
