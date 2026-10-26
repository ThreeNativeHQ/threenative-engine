# PRD-747: Starter kits fit to use — verified bug sweep and an Unreal-matched exposure

**Status:** IN PROGRESS — scouts running, exposure audit started
**Priority:** P1 — every kit still ships unverified play bugs and an exposure the owner reads as dull (Phase 1, Phase 2 boxes open)
**PR:** #574 (owner rule: one PR for related work)
**Owner ask (2026-10-26):** "red green test/fix all broken shit, make sure these starter kits are fine to use. correct exposure. Last iteration made them kind of dull, not sure its matching unreal defaults"

## Why

The owner played the shooter and the action RPG at the PR head and found play bugs a player hits in minutes
(enemies turning invisible, the slash out of sync with the hit, a weird roll, odd leg motion) and a look that
reads warm or dull. PRD-723 moved every kit to core's Unreal look; the owner doubts that look matches
stock Unreal 5.8.3. A starter kit is the first thing an agent copies, so every defect multiplies.

## Scope

- Every kit under `packages/create-threenative/templates/`. The shooter look is PRD-746; the action RPG
  bugs and look run on the lane-arpg branch and count here.
- The engine layer when a defect is in `packages/` (fix it there, never in a kit).
- Out: new kit features, new kits, asset replacement.

## Phase 1 — Exposure matches stock Unreal

- [ ] Core's look (tone curve, auto exposure key and range, bloom, local exposure, colour grading defaults) is checked term by term against UE 5.8.3 source, each deviation fixed in core or recorded with its reason. proof: the term table with `UE 5.8.3: Engine/...:line` per row and a red-green unit spec per fixed term.
- [ ] Every kit's look overrides are listed with their measured effect, and a kit that reads dull against its pre-migration look and the Unreal reference gets fixed (core first, kit override only with a judged reason). proof: per-kit judge verdict (fresh Opus, headed WebGPU, 2 runs per arm) and the median luminance, saturation and contrast per pose.

## Phase 2 — Verified bugs fixed red-green

- [ ] Every scout finding is checked against its cited line; confirmed ones are listed with layer and root cause. proof: the verified table below, rejected findings named with the reason.
- [ ] Each confirmed bug has a playtest scenario (or a unit spec for engine code) that fails before the fix and passes after. proof: red and green run results per bug.

## Phase 3 — Every kit plays clean

- [ ] Every kit passes its own scenarios plus the PRD-735 explore and footSlip gates: `pnpm test:templates`. proof: the run's per-kit result.
- [ ] A fresh agent plays each kit for five minutes with real input and reports no new defect. proof: per-kit play report.

## Acceptance criteria

- [ ] No confirmed scout or owner-reported bug remains open without a named reason. proof: Phase 2 table.
- [ ] No kit reads dull or warm against stock Unreal in a judge round. proof: Phase 1 verdicts.

## Verified findings

(filled as the scouts report)

## Decisions
