# PRD-756 — The temporal resolve feeds one shared post chain and keeps a half-size history

**Status:** PARTIAL — Phase 1 Deferred (0.44 ms removable, under its 1 ms bar)
**Priority:** P1 — on Iris Xe at the 0.72 tier start, the TRAA resolve (4.36 ms), bloom at display size (1.55 + 1.21 ms) and local exposure (2.9-3.2 ms) are most of the 14.0 ms that does not scale with resolution ([PRD-741](../../done/PRD-741-the-owned-engine-shades-fewer-pixels-and-its-temporal-resolve-writes-the-display-frame.md), measured per pass).
**Complexity:** 6 (MEDIUM) — the resolve outputs and the native post passes (+2), core's bloom and local exposure nodes (+1), a history format with an adapter fallback (+1), visual judge rounds (+2).
**Owner:** João
**Parent:** [PRD-400](../../performance/PRD-400-the-frame-gets-cheaper-one-measured-cost-at-a-time.md). Sibling: [PRD-755](PRD-755-the-default-frame-stops-copying-textures-it-already-holds.md). Lane of the PR #574 follow-up.
**Depends on:** PRD-755 Phase 1 (the resolve writes its history in place).

**Update rule:** this PRD has no PR of its own. Its commits land on `lane/pr574-gpu` and merge into the PR #574 follow-up. Tick each box, with its result, in the commit that proves it.

## Problem

- Bloom and local exposure each downsample the resolved display-size frame on their own (PRD-741 table: a 960x540 to 30x17 chain per effect, plus meters).
- The history is `RGBA16Float` with 32-bit shader math (`packages/runtime-native/src/engine/renderer/post/traa.cpp:503`). The resolve still costs 3.3 ms with one colour load instead of nine (PRD-741 deletion probe), so memory traffic, not arithmetic, sets its cost (inference).
- The history keeps the game's colour alpha (`traa.cpp:97`, `:346`), so a format without alpha is not a drop-in change.

## What Unreal does (UE 5.8.3)

- TSR writes half, quarter and eighth-resolution scene colour while it resolves, and the post chain starts from them. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalAA.h:216-235`.
- Bloom, eye adaptation and local exposure share one scene downsample chain. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessing.cpp:214` (`r.PostProcessing.DownsampleChainQuality`).
- TSR history is `R11G11B10` and its math is 16-bit by default. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:64` (`r.TSR.History.R11G11B10`), `:99` (`r.TSR.16BitVALU`).

## Goal

The default frame on Iris Xe loses at least 1.5 ms of GPU time with a NEUTRAL or IMPROVEMENT visual verdict.

### Phase 1: One shared post chain

- [x] Size it: the bloom chain, the display-size bloom passes and the local exposure passes, per pass, on the current build, and what a shared chain removes. If that is under 1 ms, this phase moves to Deferred with the number. proof: `?tnGpuPasses=1` on Iris Xe, two runs, table here.
  Result (2026-10-28, Iris Xe, Hop Garden medium at 0.72, PR #574 head `916682671`, runs PB1 and PB2, 3614 and 3514 steady frames, frame-total p50 19.56 and 19.25 ms):

  | group | PB1 ms | PB2 ms |
  | --- | --- | --- |
  | scene (1382x778) | 4.239 | 4.234 |
  | traaResolve (1920x1080) | 4.546 | 4.532 |
  | bloom chain (960x540 to 30x17 and back) | 1.623 | 1.621 |
  | display-size bloom | 0.596 | 0.596 |
  | local exposure and small chain | 2.892 | 2.888 |
  | auto-exposure meters | 0.180 | 0.180 |
  | output (1920x1080) | 1.475 | 1.475 |
  | other (aux, velocity, input-size post, shadow) | 3.248 | 3.223 |

  A shared chain removes at most the bloom chain's own downsample from the display frame: 960x540 0.312, 480x270 0.068, 240x135 0.029, 120x68 0.014, 60x34 0.010, 30x17 0.008 ms, **0.44 ms** in all (PB2). The local exposure passes are a bilateral grid at input size, not a mip chain, so they would not read the shared levels (inference from their extents: 240x576, 240x540, 480x9). Under 1 ms: Phase 1 is **Deferred**.
- [ ] The resolve writes a half-resolution colour, and bloom and local exposure start from one shared chain. proof: ctests for the chain levels; the core look specs pass.
- [ ] Visual judge NEUTRAL or IMPROVEMENT on Hop Garden, Lantern Vale and the shooter, two runs per arm. proof: the verdict here and the sheets on the follow-up PR.

### Phase 2: Half-size history

- [ ] Audit who reads the history alpha and whether the adapters in the supported matrix expose `rg11b10ufloat-renderable` and `shader-f16`. proof: the findings here, with file:line.
- [ ] The history moves to `RG11B10Ufloat` (alpha kept elsewhere if it is read) with 16-bit math where the adapter allows it, and the current path where it does not. proof: ctests on both paths; the resolve ms on Iris Xe, two runs per arm.
- [ ] Visual judge NEUTRAL or IMPROVEMENT on the same kits, two runs per arm. proof: the verdict here and the sheets on the follow-up PR.

### Phase 3: Prove it on games

- [ ] Paired GPU A/B on Iris Xe, Hop Garden medium and the shooter, three pairs from one code state, GPU p50 and presented p95, load and temperature recorded. proof: the table here.

## Done when

Every box is ticked, or a phase is Deferred with its measured number.

## Decisions

- 2026-10-28, lead: Phase 1 is Deferred with its number, as its sizing box set: a shared chain removes at most 0.44 ms on Iris Xe at 0.72. Revisit when a `?tnGpuPasses=1` profile shows the display-frame downsample levels at 1 ms or more, for example at a 4K display. The larger cost is the resolve itself (4.5 ms), which is Phase 2's target.

## Blocked on
