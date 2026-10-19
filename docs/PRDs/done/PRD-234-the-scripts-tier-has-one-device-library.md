---
prd_contract: v1
---

# PRD-234 — the scripts tier has one device library

**Status:** EXECUTED AND REJECTED — the implementation was reverted on 2026-08-28 after its own
LOC acceptance criterion and the repository kill switch fired. The attempted shared layer added
402 raw product-script lines (`+1,037/-635`) and `pnpm census` rose from 15,926 to 16,330 script
lines. The restored baseline is 15,926. Evidence:
[native-scripts-adb-kill-switch-2026-08-28](../../verification/native-scripts-adb-kill-switch-2026-08-28.md).

Sixth PRD of the runtime-native refactor batch.

**Goal: one implementation of "talk to an Android device", used by every script that does.**

**Complexity:** +3 (10+ files) +1 (device transport, timeouts, retries) = **4 → MEDIUM mode.**

## The problem, measured

| Metric | Value |
| --- | ---: |
| `packages/runtime-native/scripts/` | **15,347 lines** |
| Shared library directory | **none** |
| Scripts invoking `adb` | 12 |
| Scripts defining their own `adb` wrapper | **9** |
| `qualify-physical-mobile.mjs` | 1,321 lines |
| `measure-android-js-engine.mjs` | 1,024 lines |
| `verify-android-first-proof.mjs` | 700 lines |
| `device-preflight.mjs` | 449 lines |

Nine independent answers to "run a command on the device" means nine independent answers to which
transport is used, what the timeout is, whether a non-zero exit is fatal, and whether the device
was checked for the discharging-battery and thermal preconditions the benchmark protocol requires.
The device lane's known traps — Wi-Fi ADB to keep the phone discharging, `applicationId` that is
not the directory name, verifying the APK actually carries the change — are each implemented in
some scripts and not others.

## Solution

- `scripts/lib/adb.mjs` — one device command surface: transport selection, timeout, exit handling,
  logcat ring sizing.
- `scripts/lib/device.mjs` — preflight (thermal, battery, discharging), package resolution from
  `app.id`, install verification.
- Each script deletes its own copy in the commit that adopts the library.

**Data changes:** none. Every script's CLI, output format and exit codes stay identical — several
are parsed by tests and by the playtest runner.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `scripts/lib/adb.mjs` | each adopting script, one per commit | 9 private wrappers | deleted per commit | a wrapper's behaviour test fails if the library changes timeout or exit semantics |
| 2 | `scripts/lib/device.mjs` | `device-preflight.mjs`, `qualify-physical-mobile.mjs`, `measure-android-js-engine.mjs` | duplicated preflight | deleted per commit | a preflight that should refuse a charging device must still refuse it |

## Execution phases

One adopting script per commit. Order: the two with tests first, so the library is proved before
it spreads.

1. `scripts/lib/adb.mjs` + `device-preflight.mjs` (has `tests/device-preflight.test.mjs`)
2. `scripts/lib/device.mjs` + `measure-android-js-engine.mjs` (has
   `tests/android-js-engine-measurement.test.mjs`)
3. `qualify-physical-mobile.mjs` (has `tests/physical-mobile-qualification.test.mjs`)
4. remaining six adopters, one per commit

**Files per commit:** the library, the adopting script, its test, the record.

**Tests required, per commit:**

| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `tests/scripts-adb-lib.test.mjs` | `should refuse a charging device in preflight` | refusal is returned, not warned | make the device look discharging → passes; charging → red |
| `tests/scripts-adb-lib.test.mjs` | `should use the wireless transport when one is configured` | the command line names it | remove the branch → red |
| the adopting script's existing test | unchanged assertions | the script's output is identical | revert the adoption → still green (proving the adoption changed nothing observable) |

**Revert check per commit:** delete the library import from the adopting script → its existing test
fails to resolve, and the suite reds.

## Acceptance criteria

- [ ] **A device-lane script that gets a new trap right gets it right everywhere** — no script
      defines its own `adb` invocation.
- [ ] **Every adopting script's output and exit codes are unchanged**, proved by its pre-existing
      test.
- [ ] **The preflight refusal rules have one definition** and one test.
- [ ] `scripts/` line count falls, recorded via `pnpm census`.

## Risks

| Risk | Mitigation |
| --- | --- |
| **A script's subtle local behaviour is lost in adoption.** | One script per commit; its own pre-existing test is the control; adoption must be invisible to it. |
| **No device attached when this lands.** | The library is testable with a faked `adb` binary; a device run is required only for the two scripts that already have device evidence, and its absence is recorded, never implied. |

## Verification evidence

- **Executed, failed, and reverted.** Sixteen implementation/evidence commits were trialled one
  adopter at a time with focused behavior tests and independent reviews. Three later deletion
  checkpoints reduced the attempted product delta by 46 lines, but it remained +402 raw lines and
  `pnpm census` remained 404 lines above the pre-PRD script baseline.
- The attempted tree was reverted one checkpoint at a time. The resulting product scripts, tests,
  and interim evidence are byte-identical to commit `93eacaed`; `pnpm census` reports 15,926 script
  lines and 108,160 total lines.
- The unchecked acceptance boxes above are intentionally not rewritten as passes: the one-device
  abstraction did not meet its stated size bar. Rejection is the terminal outcome required by the
  project rule that a more expensive abstraction is deleted.
- **Do not re-attempt the generic-client shape.** Measured 2026-08-29: the real duplication across
  all six scripts is 60 lines, against the 690 the attempted library added, and every adopter kept
  its own helper and gained an adapter on top. The goal PRD-234 wanted was already reachable by
  exporting the resolver `device-preflight.mjs` had all along, which is what landed
  (+16 lines, three bug fixes, two new test files). See the follow-up section of
  [native-scripts-adb-kill-switch-2026-08-28](../../verification/native-scripts-adb-kill-switch-2026-08-28.md).
