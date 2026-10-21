---
prd_contract: v1
---

# PRD-647 — A visual judge calibrates GI against the Unreal scenes until parity

**Status:** PARTIAL — the judge command, `calibrate`, the criteria brief, the scoreboard code and the parity rule ship with unit proof; the first live rounds (AC-1, AC-2) and their sheets are open
**Priority:** P1 — the tools exist, but no live round has run: until `cornell` and `sunlit-room` have a recorded baseline round, nobody knows how far GI is from Unreal.
**Complexity:** 5 (MEDIUM) — 1–5 files: a calibrate command, a sheet layout, per-scene criteria, a scoreboard, specs (+1), new state: a parity scoreboard with history per commit (+2), a fresh judge session per round (+1), every GI PRD consumes it (+1); risk override: none
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

0. **`pnpm unreal-look:judge` (Phase 1, shipped).** The judge every lane and `calibrate` call. It takes a
   criteria file and BEFORE, AFTER and UNREAL frame sets, starts a fresh read-only `claude -p` session
   (Sonnet, Read tool only, no project files), and writes the verdict to the lane's own `--out` file. A judge
   started with the Agent tool handed its report to the coordinator and the lane lost the verdict. The
   command pairs frames by path and refuses a layer that differs between the engines, a missing frame and
   a single run per arm. It fails closed when the judge answers for fewer or more frames than the round
   holds, uses an answer outside the two scales, returns text that is not a verdict, or did not open every
   image. `--out` always holds the latest attempt, `"status": "COMPLETE"` or `"FAILED"`.
1. **`pnpm unreal-look:calibrate --scene gi:<name> --tier <low|medium|high> --before <commit> --unreal <dir>` (Phase 1).**
   One command runs a calibration round. It captures the ThreeNative cells of the scene (ID, L1 and
   the tier's L7 layer) twice per arm on the owned engine, runs the numeric compare against the Unreal
   level of the tier (PRD-644 table: `low` against Low, `medium` against Medium, `high` against Epic),
   and writes one sheet per pose: **UNREAL | ENGINE BEFORE | ENGINE AFTER**, one row per run, with the
   engine, layer, tier, pose, commit, adapter and run burned in on each frame. A capture is an *arm*:
   the store keeps it under a stamp of everything that decides the pixels (the framework packages,
   the scaffold, the capture code, the scene and the Wasm pair), so an arm is never captured twice and
   a later round finds its BEFORE by commit. `--before HEAD` on a clean tree is the baseline round: BEFORE
   and AFTER are one arm. The command fails closed on a missing cell, a single run per arm, an unnamed
   or software adapter, a frame that did not draw on the owned engine, a missing Unreal frame, a tier
   layer the capture harness lacks, a BEFORE arm that is not in the store, and a scene whose PRD-646
   direct-light check (the L1 cells, GI off) is red. `--allow-red-direct-light` runs the round anyway:
   it records the override and the round never counts toward parity. A motion run joins when PRD-641 and
   PRD-646 Phase 3 ship their series.
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
4. **The parity scoreboard (Phase 2).** `tools/unreal-reference/gi/parity/` holds one JSON file per
   round (`<utc time>-<scene>-<tier>-<stamp>.json`). It keeps, per pose: the numeric deltas per region,
   both judge answers with their reasons, and per round the commits and stamps of both arms, the engine,
   the adapter, the direct-light check and the judge session. One file per round means two lanes that
   run a round never edit the same file, so the merge into the epic has no conflict. `calibrate` prints
   the cells still CLOSE or FAR as the gap list, the furthest from the thresholds first, and the parity
   status. The GI PRD boxes cite a round file.
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
**Status:** PARTIAL — judge, calibrate and fail-closed checks ship; the sheets of a live round are open
**Files:** `scripts/unreal-look/judge.ts` (new), `scripts/unreal-look/judgeVerdict.ts` (new), `scripts/__tests__/unreal-look-judge.spec.ts` (new), `scripts/unreal-look/calibrate.ts` (new), `scripts/unreal-look/calibrateRound.ts` (new), `package.json` (the `unreal-look:judge` and `unreal-look:calibrate` scripts), `tools/unreal-reference/gi/round_sheet.py` (new), `tools/unreal-reference/gi/judge-brief.md` (new), `tools/unreal-reference/gi/cornell/criteria.md` (new), `scripts/__tests__/unreal-look-calibrate-command.spec.ts` (new), `scripts/__tests__/unreal-look-calibrate-round.spec.ts` (new)
- [x] `pnpm unreal-look:judge` runs a fresh read-only Sonnet judge on BEFORE, AFTER and UNREAL sets and a criteria file, returns IMPROVEMENT, NEUTRAL or REGRESSION per frame and overall plus MATCH, CLOSE or FAR against Unreal, and fails closed on a missing frame, a mismatched layer, a missing or unparseable verdict and a judge that did not open every image. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-judge.spec.ts` (32 passed, no live model call) and one live round on the surface lane's `judge1` frames: `pnpm unreal-look:judge --criteria ~/.cache/tmp-tn/surface/judge1/criteria.md --before <run1> --before <run2> --after <run1> --after <run2> --unreal <dir> --out <verdict.json>` returned `COMPLETE` for 4 frames, 20 images read, claude-sonnet-5-5, $0.17, 28 s, exit 0.
- [x] `calibrate` fails closed on a missing cell, one run per arm, an unnamed engine or adapter, and a red direct-light check. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate-command.spec.ts scripts/__tests__/unreal-look-calibrate-round.spec.ts` — 35 passed, no GPU and no model call. Red first: the round spec could not load `calibrateRound.js`. The command spec also fails closed on a tier layer the harness lacks, a missing Unreal frame, a software adapter, a frame not drawn on the owned engine and a missing BEFORE arm (looked up before any capture).
- [ ] The `cornell` sheets show UNREAL, ENGINE BEFORE and ENGINE AFTER with engine, adapter, commit, tier and pose burned in. proof: `pnpm unreal-look:calibrate --scene gi:cornell --tier high --before HEAD`.

#### Phase 2: Judge answers and the scoreboard
**Status:** PARTIAL — scoreboard entries ship with unit proof; the gap list prints on the first live round
**Files:** `scripts/unreal-look/calibrate.ts`, `scripts/unreal-look/calibrateRound.ts`, `tools/unreal-reference/gi/parity/` (new, one file per round), `tools/unreal-reference/gi/judge-brief.md` (new), `scripts/__tests__/unreal-look-calibrate-round.spec.ts`
- [x] A round appends one scoreboard entry per cell with the numeric deltas and both judge answers, and rejects an answer outside IMPROVEMENT/NEUTRAL/REGRESSION or MATCH/CLOSE/FAR. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate-round.spec.ts scripts/__tests__/unreal-look-calibrate-command.spec.ts` — `buildRound` rejects an off-scale answer, a missing cell and an unfinished verdict, and the baseline-round spec writes one `parity/<round>.json` with both answers per pose.
- [ ] `calibrate` prints the cells still CLOSE or FAR, ordered by numeric delta, as the gap list. proof: the AC-1 command.

#### Phase 3: The parity rule
**Status:** DONE
**Files:** `scripts/unreal-look/calibrateRound.ts`, `scripts/__tests__/unreal-look-calibrate-round.spec.ts`
- [x] A scene is reported at parity for a tier only with every region inside the thresholds and MATCH on every cell from two separate judge rounds. One round, or one CLOSE cell, keeps it open. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate-round.spec.ts` — `parity` stays open with no round, one round, one CLOSE cell, rounds on different stamps, another scene or tier, a red-direct-light round and a region outside the thresholds. It reaches parity with two MATCH rounds on one stamp.
**Verification:** AC-2.

## Decisions

- 2026-10-20 (owner): the visual judge on the Unreal calibration scenes is the measure of the GI
  sub-epic until parity. Numbers locate a gap, and the judge decides whether it is closed.
- 2026-10-21 (judge lane): the judge is a command, not an Agent-tool subagent, because the Agent tool hands
  the report to the coordinator and the lane loses its verdict. The session runs `claude -p --safe-mode
  --tools Read` on Sonnet at high effort, so the judge sees the prompt and the images and nothing else, and
  the command reads the stream to check that every image was opened. The layer of a frame is read from its
  path (`L9/L9_sun60_exterior.png`, `sunlit-room/L7/sun60-window.png`). Unreal GI variants pair as
  `L7-Epic` with L7, `L9-Epic` with L9 and `L7-Low` with ThreeNative L6 (`GI_LAYERS` in
  `capture-gi-threenative.ts`). `--tier medium` pairs `L7-Medium` with the ThreeNative `L7-medium` layer and
  `--tier low` pairs `L7-Low` with `L7-low` (the PRD-644 tier layers). The judge answers both scales (against
  BEFORE and against UNREAL) in one session.
- 2026-10-21 (judge lane): the scoreboard is a folder, `tools/unreal-reference/gi/parity/`, with one JSON
  file per round, not one `parity.json` that every round appends to. Sixteen lanes run rounds, and two
  branches that append to one file conflict at the merge. The scoreboard is still a workflow input, so it
  stays tracked.
- 2026-10-21 (judge lane): the judge reads the raw frames (two runs per arm, one Unreal frame), the GI brief,
  the scene criteria and a table of the regions outside the thresholds. It does not read the composed sheets:
  the command pairs frames by path, checks that the judge opened every image, and a composite hides the
  runs. The sheets are for the PR. The numbers table says where to look, and the images decide, as the owner
  rule says.
- 2026-10-21 (judge lane): `calibrate` keeps each capture as an arm in a store (`$TN_UNREAL_LOOK_ROUNDS`),
  keyed by a stamp of everything that decides the pixels (the framework packages, the scaffold, the capture
  code, the scene and the Wasm pair). The same inputs are never captured twice, and `--before <commit>` finds
  the clean arm of that commit. A lane that wants a BEFORE captures it once with `--capture-only` at that
  commit. `--before HEAD` on a clean tree is the baseline: BEFORE and AFTER are one arm, so the verdict
  against BEFORE is NEUTRAL by construction and the round measures the distance to Unreal.
- 2026-10-21 (judge lane): the L1 direct-light check runs first, as PRD-646 asks. A red check stops the round
  with the worst regions listed. `--allow-red-direct-light` is the named override: the round runs, records
  `directLight.overridden`, and never counts toward parity. The baseline rounds of AC-1 and AC-2 need it
  until PRD-646 Phase 2 closes.
- 2026-10-21 (judge lane): a tier layer (`L7-medium`, `L7-low`) is a PRD-644 capture layer. `calibrate` fails
  closed before any GPU time when `GI_LAYERS` lacks the layer, and the judge refuses ThreeNative frames from
  a different tier than `--tier`. High captures `L7-high`, which pins the tier. The plain `L7` layer keeps the
  engine default tier, and a GPU that measures slow may lower it.
- 2026-10-21 (judge lane): the epic already held a judge brief and per-scene criteria for `cornell` and
  `sunlit-room` (9e4e565ff), written from the Unreal frames. The lane kept those files and dropped its own
  copies. The brief gained one rule (other layers own bloom, exposure, anti-aliasing, shadow edges,
  reflections and the lamp shape) and one section that says a headless round reads raw frames and answers
  through the schema.
- 2026-10-21 (judge lane): a multi-sun scene such as `sunlit-room` reports its engine per sun
  (`sunlit-room/L1/sun60`), not per layer. `calibrate` reads every entry of a layer and fails closed when one
  is missing or is not the owned engine. A run folder that already verifies is kept: the stamp names the
  folder, so the same inputs were captured. A round that died on the second run resumes there.
- 2026-10-21 (judge lane): `compareGiToUnreal` (`scripts/unreal-look/gi.ts`) hands the whole
  `thresholds.json` to `compareCells` as one flat object. The per-layer limits sit under `layers.<name>`, so
  no limit applies, and the IoU is set after the row was judged. All 24 rows of a live `cornell` compare carry
  `pass: null`, so the GI compare reports and does not gate. `calibrate` applies `layers.L7` itself. The
  harness fix belongs to the PRD-631 owner: it changes the exit code of every GI compare.
