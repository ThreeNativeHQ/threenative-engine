---
prd_contract: v1
---

# PRD-654 — An approved GI round becomes a ratchet lock, and no region gets worse

**Status:** PARTIAL — the lock tooling ships with unit proof, and `sunlit-room` at `high` is locked and proven on real frames. `cornell` at `high` is locked, but the scenes lane rebuilt its level after the lock was cut, so the lock reports LOCK_STALE until a new approved round re-cuts it.
**Priority:** P2 — AC-2 is open: the `cornell` lock reads LOCK_STALE until a new approved round on the rebuilt level re-cuts it.
**Complexity:** 4 (MEDIUM) — 1–5 files: a lock module, a check command, a lock file, specs (+1), new state: a committed lock file with a scene digest (+2), one flag on an existing command (+1)
**Owner:** João
**Depends on:** [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (the calibrate command and its rounds) and [PRD-631](../look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) (the compare and its parity locks)

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
   (`reference-stats.json`, the ID frames and `scene.json`). When another lane rebuilds a scene, the bounds
   no longer describe it. The check then fails with LOCK_STALE, a calibrate round logs the stale lock and
   does not fail, and `--lock <round> --relax` cuts the lock again from a new approved round.
5. **`compare --write-locks` cannot drop a lock silently.** A re-seed of the reference scene's locks names
   each lock whose cell no longer holds and stops, unless `--drop-locks` asks for it.

## Acceptance Criteria

- [x] AC-1 [local]: `sunlit-room` at `high` is locked from round `20261021T211118Z-sunlit-room-high-0f48b22`: 40 regions in 6 poses. The two approved runs pass the check, and real frames of a lower tier fail it. proof: `pnpm unreal-look:compare --check --scene gi:sunlit-room --captures <arm>/run1 --captures <arm>/run2` — exit 0, `40 locked region(s) on 2 runs, every bound holds`; the same command on the stored `medium` arm presented as the `high` layer — exit 1, 27 broken bounds in each run, in all 6 poses (16 `dP50`, 11 `deltaE`).
- [ ] AC-2 [local]: `cornell` at `high` is locked from a round on the rebuilt level, and the check holds on that round's frames. proof: `pnpm unreal-look:calibrate --scene gi:cornell --tier high --before HEAD`, then `pnpm unreal-look:calibrate --lock <that round> --relax`, then `pnpm unreal-look:compare --check --scene gi:cornell --captures <arm>/run1 --captures <arm>/run2` — exit 0. Open: the scenes lane rebuilt the `cornell` level after round `20261021T212345Z-cornell-high-9154b17` (the committed ID frames, `scene.json` and `scene.glb` changed), so that round's lock reads LOCK_STALE on the epic. A new capture needs a Wasm pair built from the epic head: the pair in this lane predates the `twoSidedFoliage` binding and fails with `TN_ABI_6`.

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
**Verification:** AC-1 (done) and AC-2 (open).

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
- 2026-10-21 (judge lane): real-frame regression proof uses frames that exist. A fresh capture at the `low`
  tier needs a Wasm pair that matches the merged tree, and the pair in this lane does not. The stored
  `medium` arm of `sunlit-room`, presented as the `high` layer, is real engine output of a lower GI tier, and
  it breaks 27 bounds in each run.
