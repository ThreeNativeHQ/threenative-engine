---
prd_contract: v1
---

# PRD-655 — The L9 final frames of the GI scenes are locked, so a finishing stage cannot wash them out

**Status:** DONE — `gi:cornell` and `gi:sunlit-room` have L9 ratchet locks cut from the frames of the last good head (`dd489e9e4`). The locks pass those frames and fail the frames after the break.
**Complexity:** 3 (LOW) — 1–5 files: the lock module, one command route, a lock file, specs (+1), new state: locks that have no overlap bound and are cut from one capture (+1)
**Owner:** João
**Depends on:** [PRD-654](../Unreal/gi/PRD-654-an-approved-gi-round-becomes-a-ratchet-lock-and-no-region-gets-worse.md) (the lock module, its check and its ratchet rules)

## Context

- The L7 locks of PRD-654 see the GI layer only. They cannot see a finishing stage such as exposure, tone mapping, bloom or
  temporal anti-aliasing. At head `ff837b1f2` the L9 frame of `gi:cornell` washed out: the mean of the corner view went from
  95.3 to 210.2, and Unreal shows 97.8. No lock saw it, and the break reached the epic.
- The owner preview loop captures one L9 frame per epic head. That frame has no ID frame and no second run. The committed
  Unreal statistics already hold an `L9-Epic` cell for every pose, so a compare needs no Unreal capture.
- A lock needs the noise of a capture, and one run cannot measure it. Other heads of the loop hold pairs of runs (`3844cece8`
  and `7688a516e`). The spread between the two runs of a pair is the noise of the capture method.

## Solution

1. A capture with no ID frame takes the committed Unreal ID frames for its masks. It cannot measure the ID overlap, so every
   row has `iou: null` and a lock cut from it has no overlap bound. The overlap of a scene stays with its L7 lock.
2. `pnpm unreal-look:compare --write-locks <head> --scene gi:<name> --layer L9 --captures <run> --noise <run>,<run>` cuts the
   locks of one layer from one capture. Each `--noise` names the two runs of another head. A bound is the value, plus the
   widest spread of any pair for that region, plus one display level of the Unreal median. The merge follows the PRD-654
   ratchet: a looser cut needs `--relax`, a tighter cut needs `--tighten`, and no cut drops a region.
3. A lock cut from one capture records `runs: 1`. The check reads that many captures for it. A lock cut from the two runs of a
   round keeps the two-run check.
4. `gi:cornell` (12 regions in 2 poses) and `gi:sunlit-room` (40 regions in 6 poses) are locked at L9 from the frames of head
   `dd489e9e4`, the last head before the break.

## Acceptance Criteria

- [x] AC-1 [local]: the frames of `dd489e9e4` pass the L9 locks of both scenes. proof: `pnpm unreal-look:compare --check --scene gi:cornell --layer L9 --captures <dd489e9e4 capture>` — exit 0, `12 locked region(s) on 1 run, every bound holds`; the same for `gi:sunlit-room` — exit 0, `40 locked region(s) on 1 run, every bound holds`.
- [x] AC-2 [local]: the cornell lock fails the washed-out frames of `ff837b1f2`. proof: the same command on the `ff837b1f2` capture — exit 1, 24 broken bounds in all 12 regions (`Wall_Red` dP50 1.028 against the lock 0.11215, `Floor` deltaE 26.56 against 2.4452).
- [x] AC-3 [local]: the cornell lock fails the captured heads after the break. proof: head `3844cece8`, the latest head with two captured runs — exit 1, 13 broken bounds in each run (`corner Floor` dP50 0.1263 against 0.021053, `Box_Short` deltaE 15.13 against 10.246); `gi:sunlit-room` at `3844cece8` — exit 1, 53 broken bounds in each run, in 28 of 40 regions and all 6 poses.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| L9 lock cut | `pnpm unreal-look:compare --write-locks <head> --scene gi:<name> --layer L9 --captures <run> --noise <run>,<run>` | New, next to `calibrate --lock` (PRD-654). The reference scene's `--write-locks <since>` keeps its own route | Phase 1 |
| L9 lock check | `pnpm unreal-look:compare --check --scene gi:<name> --layer L9 --captures <run>`, run by a lane on the L9 frames of its head | Extends the PRD-654 check to one capture and to a capture with no ID frame | AC-1 to AC-3 |

## Execution Phases

#### Phase 1: Lock a capture that has no second run and no ID frame
**Status:** DONE
**Files:** `scripts/unreal-look/giLocks.ts`, `scripts/unreal-look/compare.ts`, `scripts/unreal-look/calibrate.ts`, `scripts/__tests__/unreal-look-gi-locks.spec.ts`, `scripts/__tests__/unreal-look-calibrate-command.spec.ts`
- [x] A lock is cut from one capture and the noise of other captures, and the check reads one capture for it. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-gi-locks.spec.ts` — 57 passed; the `lockCells`, `checkGiLocks` and `check command` specs cover the noise groups, the widest spread, a missing noise, a short group, a region that the noise lacks and the one-capture check.
- [x] A capture with no ID frame takes the committed Unreal ID frames for its masks, and its locks have no overlap bound. proof: the `a capture with no ID frames` specs — green: a flat grey `gi:cornell` capture reads 12 rows with `iou` null, and the same capture with its own ID frames reads `iou` 1 in every row.
- [x] `compare --write-locks <head> --scene gi:<name> --layer <layer>` cuts and merges the locks under the PRD-654 ratchet rules. proof: the `the lock command` specs — green: a looser cut fails with LOCK_LOOSER and leaves the file as it was, and `--relax` accepts it.

#### Phase 2: Lock the last good head
**Status:** DONE
**Files:** `tools/unreal-reference/gi/parity-locks.json`, `.agents/skills/tune-look-to-unreal/SKILL.md`, `.claude/skills/tune-look-to-unreal/SKILL.md`
- [x] `gi:cornell` and `gi:sunlit-room` are locked at L9 from head `dd489e9e4`. proof: `pnpm unreal-look:compare --write-locks preview-dd489e9e4 --scene gi:cornell --layer L9 --captures <dd489e9e4 capture> --noise <3844cece8 pair> --noise <7688a516e pair>` — `locked cornell L9 from preview-dd489e9e4: 12 region(s) in 2 pose(s), 12 added`; for `gi:sunlit-room` — `40 region(s) in 6 pose(s), 40 added`. The spec `cuts the L9 locks from one capture of a preview head` checks all 52 locks.
- [x] The skill `tune-look-to-unreal` names the L9 lock commands. proof: `diff .agents/skills/tune-look-to-unreal/SKILL.md .claude/skills/tune-look-to-unreal/SKILL.md` — identical; `pnpm check:docs` — exit 0.
**Verification:** AC-1 to AC-3.

## Decisions

- 2026-10-21 (judge lane): the L9 locks come from head `dd489e9e4`, as the lead asked. Its frames were taken 45 frames
  after the pose, before the wait for a settled exposure (`7a75b4654`). The exposure may have moved a little after the
  frame, so the level of these locks is provisional. A re-cut from a settled capture of an approved head is
  `compare --write-locks <head> ... --relax`, and the ratchet then reports each bound that moved.
- 2026-10-21 (judge lane): the noise of the locks comes from the pairs of runs of heads `3844cece8` and `7688a516e`, and a
  bound takes the widest spread of the two pairs. The preview loop made one run at `dd489e9e4`. In the pairs, most
  regions have a spread of 0, because the median is a whole 8 bit level. The widest spread is 0.0138 in dP50 and 0.603 in
  deltaE, in the `sun15-door` pose. The locks carry that spread, so the same code does not break its own lock on a one
  level flip.
- 2026-10-21 (judge lane): the `dd489e9e4` frames show the `gi:cornell` level from before the walls were trimmed
  (`34e845cc7`). The masks come from the committed ID frames of the rebuilt level, which differ by 255 pixels along the wall
  seams. A region median does not move for that, and the lock digest (`basis`) names the rebuilt level.
- 2026-10-21 (judge lane): a capture with no ID frame has no overlap bound, and the lock file marks it by leaving the
  fields out. A lock with a bound of 0 would read as measured. The check still fails a lock that has an overlap bound
  and a capture that has none.
- 2026-10-21 (judge lane): the `ff837b1f2` break is not only the cornell wash-out. `gi:sunlit-room` is also darker in 27 of 40
  regions at L9 (for example `sun60-window` `Floor` 126 against 140 at `dd489e9e4`, Unreal 138), and head `3844cece8` still
  shows it in 28 regions. This PRD does not say whether the cause is a finishing stage or the exposure wait. A capture
  of `dd489e9e4` with a settled exposure would tell.
