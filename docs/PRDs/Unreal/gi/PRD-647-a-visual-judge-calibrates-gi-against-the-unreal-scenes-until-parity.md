---
prd_contract: v1
---

# PRD-647 — A visual judge calibrates GI against the Unreal scenes until parity

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no repeatable loop puts an Unreal calibration frame, the ThreeNative frame before a change and the frame after it in front of a judge, and nothing records how far each scene still is from parity.
**Complexity:** 5 (MEDIUM) — 1–5 files: a calibrate command, a sheet layout, per-scene criteria, a scoreboard, specs (+1), new state: a parity scoreboard with history per commit (+2), a fresh judge subagent per round (+1), every GI PRD consumes it (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the Unreal frames) and [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 (a recreated scene whose direct light already matches). Every GI PRD in [`gi/`](./) and [`../rendering/`](../rendering/) records its visual verdict through this loop.

## Context

- The root `AGENTS.md` visual judge rule: capture the same pose before and after, headed, with
  `--browser-recipe webgpu` and `adapter.info` checked, at least two runs per arm, BEFORE and AFTER
  burned in large. A fresh read-only subagent that did not write the change returns IMPROVEMENT,
  NEUTRAL or REGRESSION per frame and overall, against criteria set from the task first. The verdict
  goes in the PRD box, and the images go on the PR (orphan `<prd>-screenshots` branch).
- PRD-631 adds the Unreal frame as the stated target and sheets laid out ENGINE before, ENGINE after,
  Unreal, with the engine named on every frame. `pnpm unreal-look:compare --sheet` writes a contact
  sheet, and the numeric report gives per-region luminance quantiles and CIEDE2000.
- What is missing for GI: per-scene criteria that tell the judge where to look, a second question
  ("how close to Unreal is it?") next to "better than before?", one place that records the answers
  across rounds, and a rule that says when a scene has reached parity.

## Solution

1. **`pnpm unreal-look:calibrate --scene gi:<name> --tier <low|medium|high> --before <commit>` (Phase 1).**
   One command runs a calibration round. It captures the ThreeNative cells of the scene twice per
   arm on the owned engine (before and after), runs the numeric compare against the Unreal level of
   the tier (PRD-644 table: `low` against Low, `medium` against Medium, `high` against Epic), and
   writes one sheet per pose: **UNREAL | ENGINE BEFORE | ENGINE AFTER**, with the engine, adapter,
   commit, tier and pose burned in large on each frame. For a motion run, the sheet holds frames 0,
   60, 90, 120 and 179 of each column and the three motion metrics. The command fails closed on a
   missing cell, a single run per arm, an unnamed engine or adapter, or a scene whose PRD-646
   direct-light check is red.
2. **Per-scene criteria (Phase 1).** `tools/unreal-reference/gi/<scene>/criteria.md` names, per pose
   and region, what the judge must look at and what Unreal shows there. For example, `cornell`: red
   tint on the white wall within 0.5 m of the red wall, the ceiling lit only by bounce, darkening into
   the far corners without a band. The owning PRD writes the criteria with its scene, before its
   first round. The judge reads only the criteria, the sheets and the numeric report.
3. **Two answers per cell (Phase 2).** The judge returns, per cell and overall:
   - **against BEFORE:** IMPROVEMENT, NEUTRAL or REGRESSION (the root rule, unchanged);
   - **against UNREAL:** MATCH (no visible difference a player would notice), CLOSE (the same
     lighting with a named difference) or FAR (a different lighting result), each with the named
     differences.
   REGRESSION against BEFORE, in any cell of any scene, blocks the change, as the root rule says.
4. **The parity scoreboard (Phase 2).** `tools/unreal-reference/gi/parity.json` keeps, per scene, pose,
   tier and motion run: the numeric deltas per region, the last judge answers, the commit and the
   date. Each round appends. The scoreboard is consumed by `calibrate` (it prints the cells still
   CLOSE or FAR as the gap list) and by the GI PRD boxes that cite it.
5. **The parity rule (Phase 3).** A scene reaches parity at a tier when every region is inside the
   PRD-631 thresholds (from the PRD-638 noise floor) **and** two judges, fresh in separate rounds,
   return MATCH on every cell of it. GI reaches parity at a tier when every registered scene does.
   [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) copies a tier to the
   templates only after parity at that tier.

**How a GI PRD uses this.** Its visual box reads: "PRD-647 round on `<scenes>` at `<tier>`: no REGRESSION
against BEFORE, and every target cell moves toward MATCH." The box cites the scoreboard entry. The
loop runs again on every later change to that behaviour.

**Images.** Sheets are written outside the repo (the scratch folder of the run) and posted on the PR
through the orphan screenshots branch. Only `parity.json` and the criteria files are tracked. The
scoreboard is a workflow input, so it is allowed under the evidence rules in `docs/PRDs/AGENTS.md`.

## Acceptance Criteria

- [ ] AC-1 [local]: The first round on `cornell` at `high` (before = the PR #541 harness with `giCache.ts`, after = the same commit) produces three sheets per pose, a judge answer per cell and a scoreboard entry. This is the GI baseline. proof: `pnpm unreal-look:calibrate --scene gi:cornell --tier high --before HEAD` and the judge verdict recorded here — Evidence: pending.
- [ ] AC-2 [local]: The same baseline exists for `sunlit-room` at `high` and `medium`. proof: `pnpm unreal-look:calibrate --scene gi:sunlit-room --tier high|medium --before HEAD` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `calibrate` command | `pnpm unreal-look:calibrate` → capture, compare, sheet | New. Reuses `capture.ts`, `compare.ts` and `--sheet` | AC-1 |
| Criteria files | `tools/unreal-reference/gi/<scene>/criteria.md`, read by the judge | New, one per scene, written by the owning PRD | Phase 1 |
| Parity scoreboard | `tools/unreal-reference/gi/parity.json`, read by `calibrate` and cited by GI PRD boxes | New | AC-1, AC-2 |

## Execution Phases

#### Phase 1: One round on one scene
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/calibrate.ts` (new), `package.json` (the `unreal-look:calibrate` script), `scripts/unreal-look/compare.ts`, `tools/unreal-reference/gi/cornell/criteria.md` (new), `scripts/__tests__/unreal-look-calibrate.spec.ts` (new)
- [ ] `calibrate` fails closed on a missing cell, one run per arm, an unnamed engine or adapter, and a red direct-light check. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate.spec.ts`.
- [ ] The `cornell` sheets show UNREAL, ENGINE BEFORE and ENGINE AFTER with engine, adapter, commit, tier and pose burned in. proof: `pnpm unreal-look:calibrate --scene gi:cornell --tier high --before HEAD`.

#### Phase 2: Judge answers and the scoreboard
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/calibrate.ts`, `tools/unreal-reference/gi/parity.json` (new), `tools/unreal-reference/gi/judge-brief.md` (new), `scripts/__tests__/unreal-look-calibrate.spec.ts`
- [ ] A round appends one scoreboard entry per cell with the numeric deltas and both judge answers, and rejects an answer outside IMPROVEMENT/NEUTRAL/REGRESSION or MATCH/CLOSE/FAR. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate.spec.ts`.
- [ ] `calibrate` prints the cells still CLOSE or FAR, ordered by numeric delta, as the gap list. proof: the AC-1 command.

#### Phase 3: The parity rule
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/calibrate.ts`, `scripts/__tests__/unreal-look-calibrate.spec.ts`
- [ ] A scene is reported at parity for a tier only with every region inside the thresholds and MATCH on every cell from two separate judge rounds. One round, or one CLOSE cell, keeps it open. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate.spec.ts`.
**Verification:** AC-2.

## Decisions

- 2026-10-20 (owner): the visual judge on the Unreal calibration scenes is the measure of the GI
  sub-epic until parity. Numbers locate a gap, and the judge decides whether it is closed.
