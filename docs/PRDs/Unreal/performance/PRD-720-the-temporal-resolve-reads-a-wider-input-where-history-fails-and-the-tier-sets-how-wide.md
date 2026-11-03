---
prd_contract: v1
---

# PRD-720 — The temporal resolve reads a wider input where history fails, and the tier sets how wide

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the default temporal resolve reads one input texel per output pixel and has no temporal quality tier, while Unreal reads a wider kernel where history is rejected and sets its width, its rejection anti-aliasing and its history size from four named levels.
**Complexity:** 6 (MEDIUM) — 3–5 files (+1), a change in a shared resolve (+2), the same rule on the owned engine (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-539](PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md) for the corpus and the history-size arm. `docs/PRDs/Unreal/look/PRD-636-the-finishing-post-chain-matches-unreal-defaults.md` Phase 4 (on `feat/unreal-look-epic`) for the temporal default. Coordinates with `docs/PRDs/Unreal/shadows/PRD-652-the-shadow-tier-follows-unreal-shadow-quality-levels.md`, whose budget ladder Phase 3 reuses.

## Context

**Unreal LOC:** about 1,200: the input filter in `TSRUpdateHistory.usf` (about 180 of 1,426), the kernel tables in `TSRKernels.ush` 455, and the cvar and permutation switches in `TemporalSuperResolution.cpp` (about 500 of 3,780). **Port estimate:** about 200 lines of resolve source plus a tier table.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The input filter widens with doubt.** The update pass filters the current frame's input around
  each output pixel. The kernel size comes from the rejection and from the number of samples already
  in the history. Where history was rejected, the kernel shrinks its pixel count to keep sharpness and
  refines by a hysteresis. A noisy input softens the kernel so a parallax disocclusion of fine detail
  distracts less (`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRUpdateHistory.usf:1070-1249`,
  kernel size at `:1109`, softening at `:1157`).
- **Four update qualities.** Quality 0 and 1 read five input samples in a plus shape. Quality 2 and 3
  read the plus shape with its farthest sample moved toward the closest corner. Quality 0 turns
  rejection anti-aliasing off (`TSRUpdateHistory.usf:38-52`).
- **Four named levels.** The scalability file sets, per level: update quality 0, 1, 2, 3, flickering
  analysis 0, 0, 1, 1, rejection anti-aliasing 0, 1, 1, 2, reprojection field 0, 0, 1, 1, resurrection
  0, 1, 1, 1, and history size 100%, 100%, 100%, 200%. The Cinematic level repeats Epic with a
  full-precision history (`UE 5.8.3: Engine/Config/BaseScalability.ini:52-104`).
- **The shipped default.** A fresh project runs the Epic level (`PRD-634` records the same for shadows).

### ThreeNative today

- `TRAANode` reads the current input at one texel, with sub-pixel correction for velocity
  (`TRAANode.js:614`). Edge quality at 100% comes from the jitter and the variance clip only.
- The templates run temporal AA at the `high` and `medium` tiers and SMAA at `low`
  (`PRD-636` Phase 4). No field of `quality.ts` names a temporal quality. PRD-539 adds the history
  size as a gate arm. PRD-717, 718 and 719 add features with no switch.
- `ShadowFilterBudget` (PRD-652, done phase) steps a filter down one level when it stays over budget
  for 120 frames. No temporal stage reads it.

## Solution

**The gate first (Phase 1).** On the PRD-539 corpus compare three input kernels at 100% scale: one
texel (today), the plus shape, and the moved-far shape. Record the edge error, the flicker and the
GPU time. **Continue** only if a wider kernel lowers the static edge error by 10% or more at a cost of
0.3 ms or less on the RTX 2080 at 1920 × 1080. Otherwise record the table under `## Decisions` and
delete Phases 2 and 3.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Input kernel from rejection and sample count | the resolve source, one kernel function with a width input | generated template source |
| Update quality 0 to 3 | tier field `temporalUpdateQuality`, 0 to 3 | generated template source |
| Rejection anti-aliasing quality | the same table, a switch read by PRD-539's lever 3 arm | generated template source |
| The four levels | the template's `quality.ts` tier table, one row per tier | generated template source |
| Step on measured cost | a new reader on the existing budget ladder in `packages/core` | core mechanism |

- **Auto by default.** The tier picks the row. A game that sets a field owns it, and the report says
  `overridden`. A tier over budget for 120 frames steps one row down and steps up below 70% of the
  next row's budget, as PRD-652 does.
- **Unreal names.** Fields use Unreal's names in camelCase, with `@alias TSR`.
- **Deferred, not built:** the flicker analysis, the reprojection field and the history size. PRD-539
  levers 1, 4 and 5 own them. Each joins this table as a column when it ships.

## Acceptance Criteria

- [ ] AC-1 [local]: With the chosen kernel, the static edge error is at least 10% lower than the one-texel kernel, and the moving-edge ratios of PRD-539 hold. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` — Evidence: pending.
- [ ] AC-2 [local]: Every template tier names its row, and `engine_search_capabilities` with "temporal quality" returns the tier report. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Wider input kernel | the template's `temporalAAResolve.ts` | Replaces the one-texel read, when the gate passes | AC-1 |
| Temporal tier table | every template's `quality.ts` | Adds a field beside the shadow and GI tiers | AC-2 |

## Execution Phases

#### Phase 1: Does a wider input kernel pay at 100% scale?
**Status:** NOT STARTED
**Files:** `scripts/verify-temporal-motion.ts` (arms only)
- [ ] The edge error, flicker and GPU time of the three kernels are recorded with the verdict under `## Decisions`. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts`, one run per arm on hardware WebGPU.

#### Phase 2: The kernel
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/temporalAAResolve.ts`, `packages/core/__tests__/temporal-input-kernel.spec.ts` (new)
- [ ] The kernel weights sum to 1, shrink where the history weight is low and match a CPU reference within 1/255. proof: red-green `pnpm exec vitest run packages/core/__tests__/temporal-input-kernel.spec.ts`.
- [ ] AC-1 holds. proof: the AC-1 command.

#### Phase 3: The tier table
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/quality.ts`, `packages/core/src/`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A temporal stage over budget for 120 frames steps one row down, steps up below 70%, and leaves an explicit setting alone with a report. proof: red-green `pnpm exec vitest run packages/core/__tests__/budget-ladder.spec.ts`.
- [ ] AC-2 holds, and each template's `AGENTS.md` names the temporal tier and its override. proof: `rg -l 'temporalUpdateQuality' packages/create-threenative/templates/*/AGENTS.md` lists every template, and `pnpm sync:agents --check` exits 0.
**Verification:** AC-1 and AC-2.
