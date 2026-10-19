---
prd_contract: v1
---

# PRD-127 — One device lane checks the phone's condition and three do not

**Status: PARTIAL, reconciled 2026-08-24.** The header below said "PROPOSED — nothing has
executed"; that stopped being true the same day: the code landed on all four device lanes (per
this batch's README), while every physical criterion stayed UNVERIFIED and the device lanes
observed red on the phone. No device number is revised by this file, and no mobile readiness is
claimed by it; the open physical criteria are queued as Lane C device tails in the night batch of
2026-08-24.

**Priority:** P1 — Open boxes prove one shared device-condition gate; low battery and thermal must exit non-zero.
**Outcome:** the device-condition gate that already works in the engine load test becomes the
gate every device measurement passes through, and it covers thermal state and charging as well as
battery. A measurement taken outside its declared conditions comes back non-zero naming the
condition, or — where an override is deliberately allowed — stamps `PROVISIONAL` into the report
itself rather than into a PRD's prose two days later.

**Depends on:** nothing. `adb`, and `scripts/engine-load-test/run-android.ts`, which already does
the hard half.

**Blocks:** [PRD-117](../done/PRD-117-engine-load-test-godot.md) phone arm,
[PRD-074](../performance/PRD-074-scene-collapse-regression-gate.md) Pixel 8 leg, and
[PRD-066](../performance/PRD-066-android-device-frame-rate.md) Phases 2–5.

**Does not block [PRD-118](../done/PRD-118-android-js-engine.md).** See §1 — PRD-118's retake needs a
charged phone and no code at all.

**Complexity: 4 → MEDIUM mode.** One extraction, three call sites, two new conditions. No package
code, no new dependency.

**Blast radius: ~7 repository paths.** `scripts/engine-load-test/run-android.ts`,
`packages/runtime-native/scripts/` (three callers), `packages/runtime-native/tests/`,
`docs/product/PERFORMANCE-BUDGETS.md`, `docs/verification/`.

---

## 1. Why this exists, and what it is *not*

**Start with the correction, because the obvious version of this PRD is wrong.**

PRD-118 holds a 22× result it will not accept:

| Pixel 8, 16 384 cubes, collapsed scene | frame p50 | JS per frame |
|---|---|---|
| QuickJS | 119.19 ms | 115.64 ms |
| **V8** | **8.20 ms** | **5.25 ms** |
| Godot 4.7.1 Android | 39.27 ms | — |

It is easy to read that as *nothing checked the battery*. **Something did.**
`scripts/engine-load-test/run-android.ts:93` `assertDeviceReady` reads `dumpsys battery`, compares
against `MINIMUM_BATTERY_PERCENT`, and throws
`TN_BENCH_LOW_BATTERY: 21% is below the 50% PRD-117 requires`. It fails closed. The run proceeded
because `--allow-low-battery` was passed, which is a documented escape that marks the result
provisional — and the result *is* marked provisional, in two PRDs, correctly.

**So the gate worked, and PRD-118 needs no code from this PRD.** Charge the phone above 50%,
re-run without the flag, update the status line. That is the whole retake, and it is the cheapest
item in this batch.

**What is actually broken is the blast radius of that gate.** It lives inside the engine load test
and is reached by nothing else:

| Lane | Condition check today |
| --- | --- |
| `scripts/engine-load-test/run-android.ts` | battery, fails closed, documented override |
| `packages/runtime-native/scripts/measure-android-js-engine.mjs` | **none** — no reference to battery, thermal, charging or `dumpsys` |
| `packages/runtime-native/scripts/measure-cold-start.mjs` | **none** |
| `packages/runtime-native/scripts/verify-android-physics-parity.mjs` | **none** |

One lane fails closed and three fail open, on the same phone, often in the same session. PRD-066's
Phases 2–5 build *a device frame-rate gate that does not exist yet*, and on today's tree it would
be the fourth lane with no condition check.

**And the one gate that exists covers one condition.** Battery is not the only device state that
moves a frame time. A phone already in `THERMAL_STATUS_MODERATE` from the previous run reports the
previous run. A phone on a charger runs hotter than one on battery, and neither the bar nor the
report says which it was.

## 2. What gets checked, and why each one

| Condition | Read via | Why a measurement is invalid without it | New? |
| --- | --- | --- | --- |
| **Battery level** | `dumpsys battery` | Below ~30% many Android devices cap clocks in a power-saving governor | exists |
| **Charging state** | same | A charging phone runs hotter and throttles differently. Whichever is chosen, the report must say which | **new** |
| **Thermal status** | `dumpsys thermalservice` | A device already throttling measures the previous run | **new** |
| **Screen state** | `dumpsys power` | A screen-off device does not composite | **new** |

Each is **recorded in the report unconditionally**. Each has a bar the calling measurement
declares. Recording without a bar is a note; the bar is what makes it a gate.

## 3. Public shape

The existing function generalised and moved somewhere three more callers can reach it — not
rewritten, and not given a new vocabulary:

```js
const state = await assertDeviceReady(serial, {
  minBatteryPercent: 50,
  requireDischarging: true,
  maxThermalStatus: "NONE",
  allowOverride: false,
});
```

It returns the observed state, which the caller embeds in its report verbatim, or throws with the
failing condition, its bar and its observed value named.

**The override keeps working, and starts costing something.** `--allow-low-battery` today lets a
run proceed and prints `(PROVISIONAL)` to stdout. After this PRD, an overridden run writes
`"provisional": ["battery"]` **into the report JSON**, and any consumer that aggregates or
compares reports refuses to treat a provisional number as an accepted one. Round 9's lesson
applies: a caveat that lives only in prose gets separated from its number.

| Exit | Meaning |
| --- | --- |
| `0` | Preflight passed; observations are in the report |
| non-zero | A condition failed and no override was permitted. **No number is emitted** |

## 4. Phases

### Phase 0 — Reproduce the three open lanes

Run `measure-android-js-engine.mjs` on the Pixel 8 at whatever charge it holds, and confirm it
emits a full report with no device-condition block. That is the defect observed rather than
inferred from a grep. Half an hour.

### Phase 1 — Extract, generalise, test

Move `assertDeviceReady` somewhere the `runtime-native` scripts can import, add charging, thermal
and screen state, and unit-test the parsers over captured `dumpsys` fixtures — including the
output shapes that vary by Android version. No device needed for the tests.

### Phase 2 — Wire the three unguarded lanes

Each declares its own bar. `measure-cold-start.mjs` keeps its existing emulator refusal; this adds
to it rather than replacing it.

### Phase 3 — Provisional becomes data

`"provisional": [...]` in every device report, and the comparison paths refuse to accept a
provisional number as final.

## 5. Integration ledger

Filled with real non-test `file:line` during implementation. A `TBD` at phase end means the phase
is incomplete.

| # | Thing built | Caller edited so it is reached | What it replaces | When it may claim green | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | Shared `assertDeviceReady` | the three unguarded scripts | a gate reachable from one lane | three callers reach it and their reports carry its block | delete a call → a test fails naming that script |
| 2 | Thermal condition | the shared module | nothing — no thermal check exists anywhere | a throttling device is refused | force a thermal state → refused and named |
| 3 | Charging condition | same | nothing | a charging device fails a discharging bar | measure plugged in → refused and named |
| 4 | Condition block in every device report | the report writers | reports naming the device but not its state | every device report after this date carries one | strip the block → the report is rejected as malformed |
| 5 | `provisional` as a report field | `bench:engines` comparison paths | `(PROVISIONAL)` printed to stdout and lost | an overridden run is refused by the comparison | compare a provisional against a final → refused, exit non-zero |

## 6. Acceptance criteria

- [ ] All four device lanes reach one shared condition gate, and a test fails if any one of them
      stops reaching it.
- [ ] A measurement below its declared battery bar **exits non-zero, names the condition, the bar
      and the observed value, and writes no report** — observed red with its exit code recorded,
      on each of the three newly wired lanes.
- [ ] The same for thermal status and for charging state, observed red.
- [ ] Every device report written after this PRD lands carries a condition block stating battery
      level, charging state, thermal status and screen state.
- [ ] An overridden run writes `"provisional": [...]` into the report, and a comparison that is
      handed a provisional number **refuses it**, observed red.
- [ ] `PERFORMANCE-BUDGETS.md` states, in one plain clause, that a device number without a
      condition block is not evidence.
- [ ] **PRD-118's retake is executed** on a device ≥50% and discharging, without
      `--allow-low-battery`, and PRD-118's own status line is updated to whatever it shows —
      including if the numbers move. *This criterion needs no code from this PRD and should not
      wait for it.*
- [ ] No file says mobile-ready. One Android device is not mobile.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets` passes, and no native toolchain
      becomes part of the default gate.

## 7. Negative controls

Every row must be **observed red** with its exit code recorded before the matching pass is
written. A pass with no observed red is recorded `UNVERIFIED`.

| Control | Change | Expected | Status |
| --- | --- | --- | --- |
| `low-battery-unguarded-lane` | run `measure-android-js-engine.mjs` below the bar | non-zero naming battery; no report | not built |
| `charging` | measure while plugged in under a discharging bar | non-zero naming the charging state | not built |
| `thermal-throttling` | measure with thermal status above the bar | non-zero naming the status | not built |
| `no-device` | pass an unattached serial | non-zero before any measurement, never a zero-filled report | not built |
| `emulator-serial` | pass `emulator-5554` | blocked before measurement — the rule PRD-070 already states, preserved | not built |
| `stripped-block` | remove the condition block from a report | report rejected as malformed | not built |
| `unguarded-caller` | remove the gate call from one lane | a test fails naming that lane | not built |
| `provisional-compare` | compare a provisional number against a final one | refused, exit non-zero | not built |
| `unparseable-dumpsys` | feed an unrecognised `dumpsys` shape | non-zero naming the parse failure, **never** a default value | not built |

The last one matters most. A gate that silently defaults an unparseable battery reading to `100`
is worse than no gate, because it launders an unchecked run as a checked one.

## 8. Non-goals

- **Not a benchmark harness.** It gates measurements; it does not take them.
- **Not removing the override.** `--allow-low-battery` exists because a provisional number beats no
  number. It stops being free, not available.
- **Not iOS.** No Apple hardware is attached, and nothing here touches the simulator lane.
- **Not automatic charge management.** It refuses; a human plugs the phone in.
- **Not a re-measurement of past rounds.** Existing provisional numbers stay provisional and
  labelled.

## 9. Kill switches and rollback

- **If PRD-118's charged retake reproduces the 22× within run-to-run variance**, then the 50% bar
  cost the project a fortnight of provisional labelling for no measurable effect. Record that as a
  result *about the bar*, and consider lowering it with the evidence attached. The gate still ships
  — a declared condition that three of four lanes never check is a defect whichever way this
  particular number falls.
- **If the retake moves the numbers materially**, PRD-118's acceptance is re-derived on the new
  ones and the 22× is retracted everywhere it appears.
- **If thermal status proves unreadable on this device's Android build**, ship battery and charging
  and record thermal as unavailable with the command that failed. Do not fabricate a default.
- Rollback is one module and three call sites.
