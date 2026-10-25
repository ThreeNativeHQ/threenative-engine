---
prd_contract: v1
---

# PRD-654 — An approved GI round becomes a ratchet lock, and no region gets worse

**Status:** DONE — the lock tooling ships with unit proof, and `sunlit-room` and `cornell` at `high` are locked from rounds on the current scene and the current engine (gi-layer gate, `cf72b5346`). The L9 locks are PRD-655.
**Complexity:** 4 (MEDIUM) — 1–5 files: a lock module, a check command, a lock file, specs (+1), new state: a committed lock file with a scene digest (+2), one flag on an existing command (+1)
**Owner:** João
**Depends on:** [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (the calibrate command and its rounds) and [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) (the compare and its parity locks)

## Context

- The owner approved the `sunlit-room` round at `high` ("really good, harden tests around it") and the
  `cornell` round at `high` ("LGTM, harden tests"). A green round tells the next lane nothing about a
  regression, because nothing keeps the numbers of the approved round. A later change can make a region
  worse, and only a judge that happens to look at that region sees it.
- PRD-631 has parity locks for the reference scene (layers L1 to L9). They read a ThreeNative capture and
  the committed Unreal statistics. The GI scenes have no such lock, and they need more than a bound: two
  runs of one capture differ by a measured noise, and `dP50` moves in steps of one 8 bit display level.
- The approved numbers stay in `tools/unreal-reference/gi/parity/<round>.json`, and the committed Unreal
  statistics (`reference-stats.json` and the ID frames) already allow an offline compare. So a lock needs
  no new Unreal capture and no GPU.

## Solution

1. **`pnpm unreal-look:calibrate --lock <round id>`.** It measures the two runs of the round's arm again,
   offline, and checks that they still show the numbers of the round file. Then it writes one lock per
   region and pose to `tools/unreal-reference/gi/parity-locks.json`: a ceiling for `dP50` and `deltaE`, a
   floor for the ID overlap, and the noise between the two runs. A ceiling is the mean of the runs plus that
   noise plus one display level at the Unreal median, because `dP50` is quantized and some approved regions
   measure exactly 0. Bounds round away from the measured value.
2. **A lock moves only on request.** A round that is tighter than a lock changes nothing, unless
   `--tighten` ratchets it down. A round that is looser fails with LOCK_LOOSER, unless `--relax` accepts it.
   A round that no longer measures a locked region fails with LOCK_DROPPED, with or without `--relax`.
3. **`pnpm unreal-look:compare --check --scene gi:<name> --captures <run1> --captures <run2>`.** It checks
   two capture folders against the locks and exits 1 with one line per broken bound. It fails closed on a
   missing region, a missing frame, one run only, and two runs that differ by more than the locked noise.
   `calibrate` runs the same check on the AFTER arm of every round, logs it, and exits 2 when a lock breaks.
4. **A lock names its basis.** Each lock records a digest of the committed scene and Unreal reference
   (`reference-stats.json`, the ID frames and `scene.json` without its `motion` runs). When another lane rebuilds a scene, the bounds
   no longer describe it. The check then fails with LOCK_STALE, a calibrate round logs the stale lock and
   does not fail, and `--lock <round> --relax` cuts the lock again from a new approved round.
5. **`compare --write-locks` cannot drop a lock silently.** A re-seed of the reference scene's locks names
   each lock whose cell no longer holds and stops, unless `--drop-locks` asks for it.

## Acceptance Criteria

- [x] AC-1 [local]: `sunlit-room` at `high` is locked from round `20261021T211118Z-sunlit-room-high-0f48b22`: 40 regions in 6 poses. The two approved runs pass the check, and real frames of a lower tier fail it. proof: `pnpm unreal-look:compare --check --scene gi:sunlit-room --captures <arm>/run1 --captures <arm>/run2` — exit 0, `40 locked region(s) on 2 runs, every bound holds`; the same command on the stored `medium` arm presented as the `high` layer — exit 1, 27 broken bounds in each run, in all 6 poses (16 `dP50`, 11 `deltaE`).
- [x] AC-2 [local]: `cornell` at `high` is locked from a round on the rebuilt level, and the check holds on that round's frames. proof: `pnpm unreal-look:calibrate --scene gi:cornell --tier high --before 96be19ad3 --unreal <tree> --allow-red-direct-light` — round `20261022T034904Z-cornell-high-0d05970`, judge IMPROVEMENT overall (corner IMPROVEMENT, cornell NEUTRAL, vs Unreal CLOSE); `pnpm unreal-look:calibrate --lock 20261022T034904Z-cornell-high-0d05970 --relax` — `12 region(s) in 2 pose(s), 0 added, 12 moved`; `pnpm unreal-look:compare --check --scene gi:cornell --layer L7-high --captures <arm>/run1 --captures <arm>/run2` — exit 0, `12 locked region(s) on 2 runs, every bound holds`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `calibrate --lock` | `pnpm unreal-look:calibrate --lock <round id>` writes `tools/unreal-reference/gi/parity-locks.json` | New. Reuses the round file, the arm store and `compareGiToUnreal` | AC-1 |
| GI lock check | `pnpm unreal-look:compare --check --scene gi:<name> --captures ...`, and every `calibrate` round | New, next to the reference scene's `--check` (PRD-631), which it leaves unchanged | AC-1 |
| `--drop-locks` | `pnpm unreal-look:compare --write-locks <since> --drop-locks` | Extends the reference scene's re-seed with a guard | Phase 2 |

## Execution Phases

#### Phase 1: Cut and keep the locks
**Status:** DONE
**Files:** `scripts/unreal-look/giLocks.ts` (new), `scripts/unreal-look/calibrate.ts`, `scripts/unreal-look/calibrateRound.ts`, `tools/unreal-reference/gi/parity-locks.json` (new), `scripts/__tests__/unreal-look-gi-locks.spec.ts` (new), `scripts/__tests__/unreal-look-calibrate-command.spec.ts`
- [x] `calibrate --lock <round id>` cuts one lock per region and pose from the two runs of an approved round, with the noise and one display level in each ceiling. It checks that the arm still shows the numbers of the round first. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-gi-locks.spec.ts scripts/__tests__/unreal-look-calibrate-command.spec.ts` — green; the `lockCells` and `--lock` specs cover the noise, the display level, the rounding, a missing arm, a dirty arm and an arm that no longer reproduces its round.
- [x] A later round cannot loosen a lock or drop a region unless asked: LOCK_LOOSER, LOCK_DROPPED, and `--tighten` or `--relax` only on request. proof: the `mergeLocks` and `--lock` specs in the same two files — green.

#### Phase 2: Check and fail closed
**Status:** DONE
**Files:** `scripts/unreal-look/giLocks.ts`, `scripts/unreal-look/compare.ts`, `scripts/unreal-look/calibrate.ts`, `scripts/__tests__/unreal-look-compare.spec.ts`
- [x] `compare --check --scene gi:<name> --captures <run1> --captures <run2>` exits 1 on a bound past its lock, a missing region or frame, a single run, and runs that disagree by more than the locked noise. `calibrate` runs the check on every round and exits 2 on a broken lock. proof: the `checkGiLocks`, `check command` and `checks the locks of its AFTER arm` specs — green; on real frames, a capture without the `sun60-window` frame in run 2 exits 1 with MISSING_CELL, and one `--captures` folder fails with TOO_FEW_RUNS.
- [x] `compare --write-locks` cannot drop a lock silently. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-compare.spec.ts` — the spec `refuses a re-seed that would drop a lock, and drops it only on --drop-locks` failed against the old `compare.ts` (`expected [Function] to throw an error`) and passes now.
- [x] A lock records the digest of the scene and Unreal reference it was cut against. A changed reference gives LOCK_STALE in the check, a log line in a calibrate round, and a re-cut only with `--relax`. proof: the `sceneBasis`, `LOCK_STALE` and `stale` specs — green; on the epic, `pnpm unreal-look:compare --check --scene gi:cornell --captures <old arm>/run1 --captures <old arm>/run2` exits 1 with `LOCK_STALE: cornell L7-high: 12 of 12 lock(s) were cut against another scene or Unreal reference`.

#### Phase 3: Lock the approved rounds on real frames
**Status:** DONE
**Files:** `tools/unreal-reference/gi/parity-locks.json`, `.agents/skills/tune-look-to-unreal/SKILL.md`, `.claude/skills/tune-look-to-unreal/SKILL.md`
- [x] `cornell` at `high` is locked from round `20261021T212345Z-cornell-high-9154b17` (12 regions in 2 poses), and the approved runs passed it before the scenes lane rebuilt the level. proof: at commit `2ec5f3410`, `pnpm unreal-look:compare --check --scene gi:cornell --captures <arm>/run1 --captures <arm>/run2` — exit 0, `12 locked region(s) on 2 runs, every bound holds`; the frames of the older `cornell` tree (arm `98a0afd`) presented as the `high` layer — exit 1, 6 broken bounds in each run (`Box_Short` `dP50` 0.8276 against 0.65518, `Wall_Green` `deltaE` 2.233 against 1.9602).
- [x] The skill `tune-look-to-unreal` names the lock commands and the stale rule. proof: `diff .agents/skills/tune-look-to-unreal/SKILL.md .claude/skills/tune-look-to-unreal/SKILL.md` — identical; `pnpm check:docs` — exit 0.
- [x] The `sunlit-room` lock follows the engine after the gi-layer gate (`f9326e238`), which gates SSGI and SSR on the scene's own layer. proof: `pnpm unreal-look:calibrate --scene gi:sunlit-room --tier high --before ad18729b8 --unreal <tree> --allow-red-direct-light` — round `20261022T034406Z-sunlit-room-high-2a38e65`, judge IMPROVEMENT overall (3 poses IMPROVEMENT, 3 NEUTRAL, no REGRESSION); `--lock <that round> --relax` — `0 added, 18 moved, 22 tighter and kept`; the check on the new arm — exit 0, `40 locked region(s) on 2 runs, every bound holds`.
**Verification:** AC-1 and AC-2 (done).

## Decisions

- 2026-10-21 (judge lane): the GI locks live in `tools/unreal-reference/gi/parity-locks.json`, not in the
  reference scene's `parity-locks.json`. The reference check is a merge gate for every lane, and its spec
  requires that a lock naming a scene fails there. A separate file leaves both untouched.
- 2026-10-21 (judge lane): a ceiling is the mean of the runs plus the measured noise plus one display
  level of the Unreal median. `dP50` is the median difference over the Unreal median in 8 bit units, so one
  level at a median of 12 is 0.083, and several approved regions measure 0. Without the level, a one level
  flicker in a region that measures 0 would break a lock. The noise of the two approved rounds was 0
  everywhere, because the renders are deterministic, so the level is the only slack in practice.
- 2026-10-21 (judge lane): a lock is checked and cut offline against the committed Unreal statistics. That
  makes the check cheap, but it ties a lock to the committed reference. The scenes lane changed the `cornell`
  level the same day, which proved the point, so each lock records a digest of that reference and the
  check says LOCK_STALE instead of reporting bounds it cannot judge. The digest leaves out the time stamp
  of the statistics file, so writing the same statistics again keeps it.
- 2026-10-21 (judge lane): a stale lock does not fail a calibrate round. The lane that runs the round
  cannot re-cut the lock without an approved round, so the round logs the stale lock and continues. The
  explicit check fails, because a check that cannot judge must not report success.
- 2026-10-21 (judge lane): there is no CI spec that the committed locks match the committed scene. It
  would turn the CI red for every lane that changes a locked scene, and only an approved round can re-cut a
  lock. The spec on the committed file checks what a hand edit can break: each lock names a round on the
  scoreboard that holds its region, and the round's numbers sit inside the bounds of the lock.
- 2026-10-22 (judge lane): a round measures against the committed Unreal statistics, not against the local Unreal
  tree. The local `cornell` tree held the Unreal frames of 2026-10-20 (90 frame warm-up), and the committed
  statistics came from the 180 frame capture of 2026-10-21. The round and `--lock` then disagreed by 1.2 percent in
  `Floor` deltaE (ROUND_MISMATCH). The tree now feeds only the judge images and the sheets. The numbers of a round and
  of its lock come from one reference. Proof: the same `cornell` arm failed `--lock` with ROUND_MISMATCH before the
  change and locked after it.
- 2026-10-22 (judge lane): the recapture on the gate commit shows run to run spread in `sunlit-room` that the first
  approved round did not have (0.0006 to 0.125 deltaE in 7 regions). The first round had a locked noise of 0, so the
  check failed those 7 bounds. The locks take the new spread with `--relax` (23 bounds moved by 0.0003 to 0.155
  deltaE). The cause of the spread is open: some stage of the gated layer is not deterministic between two runs.
- 2026-10-22 (judge lane): the digest of a scene leaves out the `motion` runs of `scene.json`. The motion lane added a
  `motion` block to the `cornell` scene about two hours after the lock was cut, and that alone made every lock
  LOCK_STALE, although the Unreal statistics, the ID frames and the still poses had not changed. A still pose does not
  read a motion run. The `basis` of the 104 existing locks was written again with the new rule, and no bound moved.
  Proof: the spec `ignores the time the statistics were written and the motion runs` fails when the digest keeps the
  block, and on the merged epic the `cornell` check went from LOCK_STALE to `every bound holds`.
- 2026-10-21 (judge lane): real-frame regression proof uses frames that exist. A fresh capture at the `low`
  tier needs a Wasm pair that matches the merged tree, and the pair in this lane does not. The stored
  `medium` arm of `sunlit-room`, presented as the `high` layer, is real engine output of a lower GI tier, and
  it breaks 27 bounds in each run.
- 2026-10-22 (judge2 lane): the cause of the run-to-run spread of the gated layer is temporal anti-aliasing. `quality.ts`
  sets `temporalAA: true` in the `high` and `medium` tiers (`e23c6e92e`), so the camera jitters every frame and a
  screenshot lands on an arbitrary frame after the 45-frame wait. Proof: eight screenshots of one `sunlit-room` pose, 0
  to 32 frames apart, in one page session. With `temporalAA: true` each pair differs in 20,000 to 50,000 pixels (largest
  step 15 to 45 levels). With `temporalAA: false` all eight shots of three poses are identical, 0 differing pixels. The
  arm at `ad18729b8` (before the default) has two identical runs, the arm at `cf72b5346` differs in 35,000 to 110,000
  pixels, even at L1, where the jitter moves the edges. The cause went to `post2-lane`. Until the still frame converges
  to one image, every GI lock takes its noise from two random draws, and a lock cut with `--relax` carries the spread
  that its two runs happened to show (the `cornell` L7-high bounds widened by up to 1.5 deltaE at `5bf588c`).
