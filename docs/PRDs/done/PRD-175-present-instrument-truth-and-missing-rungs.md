---
prd_contract: v1
---

# PRD-175 — The present instrument tells the truth, and the ladder's missing rungs get measured

Complexity: code 3 (LOW lane) · device rungs 7 (HIGH lane)

## Context

Two open items inherited from the PRD-069 measurement session
(`docs/verification/prd-069-phase-0-v8-draw-ladder-2026-08-21.md`):

1. **Known-open instrument defect.** `emitAndroidJsNativeProfile` reports the previous frame's
   present time **once per submit**, and a frame submits ~4×: the report's
   `nativeSubmitPresentMsPerFrame` counts present ~4.3×. The verification record computed
   corrected figures by hand from raw logcat (submit+poll 0.129 ms × ~4.3 submits ≈ 0.55 ms;
   present 0.706 ms counted once ≈ 0.71 ms — against a reported 3.37 ms). The aggregation lives
   at `packages/runtime-native/scripts/measure-android-js-engine.mjs:571-613`
   (`presentNs` summed with `submitPollNs`, divided per frame).
2. **Two unmeasured ladder rungs.** The 500 and 4000-object rungs exhausted their cooled
   retries on 2026-08-21 (thermal LIGHT trips; battery temp settled above the 31.5 °C launch
   margin). The tooling reruns them in one command (`sweep.sh "500 4000"`).

Every number this instrument produces feeds PRD-069's evidence and any future native decision;
a present term inflated 4× distorts exactly the "true native floor" split that record exists to
provide.

## Solution

**LOW lane (tonight, local):** fix the aggregation. Group raw per-submit lines by frame; sum
`submitPollNs` across submits; count each frame's `presentNs` **once** (max of the frame's
reported values — they are repeats of one present). Report fields keep their names so existing
analyses diff cleanly; add the corrected semantics to the field docs where they are defined.

**HIGH lane (operator + cooled phone):** complete the two rungs under the recorded thermal
discipline verbatim — preflight waits for thermal status NONE **and** battery temp ≤ 31.5 °C
before each rung, `--cold-start-runs 0`, Wi-Fi adb so the device discharges, serial
`37251FDJH0037Z`. Append rows to the same ladder table in a dated verification file; label
vsync-clamped rows as clamped. If the phone will not cool, the rungs stay explicitly UNMEASURED
— never skipped-and-claimed.

Data changes: none to schemas; report values change meaning-correctly.

## Integration Ledger

| # | Thing built | Live caller | Replaces | May claim green when | Negative control |
|---|---|---|---|---|---|
| 1 | Once-per-frame present accounting | `measure-android-js-engine.mjs` analysis output | per-submit present summation | synthetic profile fixture: 4 submits/frame with known present → report shows present once | revert formula → inflated figure returns |
| 2 | Rungs 500/4000 measured | sweep tooling on the device | UNMEASURED rows | dated file rows appended with serial + thermal state; clamped rows labelled | n/a (measurement, not code) |

## Execution Phases

### Phase 1 — LOW lane

**Files (3):**

- `packages/runtime-native/scripts/measure-android-js-engine.mjs` - EDIT: frame-grouped aggregation.
- `packages/runtime-native/tests/android-js-engine-measurement.test.mjs` - EDIT: synthetic-fixture cases.
- `docs/verification/prd-175-present-instrument-<date>.md` - NEW.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control (observed red) |
|---|---|---|---|
| measurement spec | present counted once per frame | fixture: 300 frames × 4 submits, presentNs = p each → report ≈ p (+ submit share), not 4p | restore summed formula → assertion red with ~4p |
| measurement spec | submit+poll still summed across submits | fixture with differing per-submit poll values → correct total | break grouping → red |

### Phase 2 — HIGH lane (only if device passes preflight)

Run `sweep.sh "500 4000"`; append results to the ladder record; update G5
(`packages/runtime-native/docs/G5-profiling.md`) rows if the split changes. Device not cooling
→ record the attempt (timestamps, observed temps) and mark the rungs UNMEASURED.

**Verification Plan:** focused runtime-native test suite → `pnpm typecheck && pnpm lint &&
pnpm test`. Phase 2 adds its own device-gate outputs or nothing.

## Acceptance Criteria

- [ ] Synthetic-fixture tests prove once-per-frame present accounting; mutation red pasted.
- [ ] Existing 12/12 measurement-suite expectations updated only where the corrected semantics change them, each edit justified inline.
- [ ] Rung rows either measured with full provenance or recorded UNMEASURED with the failed preflight evidence.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.

## Checkpoint Protocol

Fixture numbers before/after; for Phase 2, preflight logs and per-rung thermal states. No device
claim without the serial in the record.

## Results — 2026-08-22

LOW lane EXECUTED (`8f51a1d8`): frame tag added to the profile marker (profile builds),
aggregator groups or run-length-dedupes, mixed-tag logs throw; both fixtures red before, green
after; 14/14. HIGH lane attempted and not obtained: phone cool enough (28.2 °C) but charging
over USB — the preflight needs discharging and unplugging is physical. Rung 500/4000 stay
UNMEASURED. Evidence: `docs/verification/prd-175-present-instrument-2026-08-22.md`.
