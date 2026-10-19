---
prd_contract: v1
---

# PRD-287 — the default look holds the phone's budget, or steps down and says so

**Status: PARTIAL — starter implementation and desktop/browser wiring proofs exist; physical-phone
acceptance and the other templates remain open.** Filed 2026-08-30 against `728f72e8`. Part of
the decent-defaults batch. Depends on
[PRD-278](../done/PRD-278-every-template-ships-the-render-chain-and-says-what-ran.md) for a chain to
measure, The ruling on where the ladder lives was answered
2026-08-30 in
PRD-266: the
budget signal and its meter are core, the tier→stage mapping is template source. AC1 below is that
signal; AC4's defaults are graded in seven generated files, not one seam.

**Priority:** P2 — Open ACs finish six templates and prove the mobile default's floor on a phone.
**Goal: the tier a scaffolded game runs is chosen against the meter that is actually limiting the
frame, proven on a physical phone, and the step-down says why it happened.** Today the ladder is
specified against the wrong meter and gated on the wrong platform, and the mobile defaults were
picked by hand from a desktop capture.

## Starter slice — September 5, 2026

PRD-362 implements the
starter slice. Core reports successful GPU-query age beside GPU duration; generated starter
source owns the hysteresis, tier mapping, explicit override and fallback reason. Its fallback
uses presented-frame timing as allowed by that delivery slice. No appearance policy moved to core.

The actual starter callback has browser deletion/restoration proof and native live-game proof.
Browser and desktop-native resource cycles have disposal mutation/restoration proof: removing
replacement disposal grows textures from 26 to 34 at the repeated high tier, and restoration
passes. These inputs are synthetic and do not prove measured-load recovery. The browser stress
calibration lowered high→medium→low but failed recovery; phone performance, real pinned-load
behavior, phase checkpoint review and all-template coverage remain unverified. No acceptance box
below is closed by these partial results. Commands, source identities and limitations are in the
[batch ledger](../../verification/batch-2026-09-05-execution.md); timing findings are in the
[single performance record](../../verification/runtime-perf-state.md).

## The two defects, both already measured

### 1. The ladder reads `render`, and `render` is not the limiter

`lighting/PRD-266` specifies the tier ladder as *"selected from the `FrameBudget` `render` phase
against `display.maxFps`"*, mirroring `ResolutionScaler`. On the one scene where the chain has been
measured, that phase cannot see the cost it is supposed to react to:

| meter | value, five-stage chain, 1600×900, RTX 2080 |
| --- | --- |
| CPU `render` phase | ~5.5 ms |
| `gpuMs` (timestamp query) | 14.7 ms |
| fps | 56.8 |

Source: `docs/verification/runtime-perf-state.md`, "Per-stage attribution, by GPU time", 2026-08-30,
which states the conclusion outright — *"`gpuMs` is the honest meter here and `render.p50` is not …
the GPU is the limiter by 3x and the CPU only discovers it when `queue.submit` blocks."* A ladder
driven by `render` steps down late, or never, on exactly the machine class that needs it.

`gpuMs` is already published: `packages/core/src/frame-budget.ts:168` declares it, line 443 reads
it, line 463 emits it under `TN_FRAME_BUDGET` (`frame-budget.ts:25`). No new instrument is needed —
the selection input changes, and the ladder falls back to `render` only where no timestamp query
exists, and **says so** rather than silently reading a phase that is not the limiter.

### 2. The mobile defaults were chosen on a desktop and never run on a phone

PRD-278 §3 sets the shipped mobile column — SSGI off, SSR off, godrays off — from a desktop capture
of one sandbox scene, and correctly notes the templates' Tier 1 floors: **browser-Android 30 fps,
native-Android 55 fps** (`templates/starter/AGENTS.md`). `lighting/PRD-266`'s own acceptance gate is
a browser-lane playtest. So the entire mobile half of the default look is currently an inference.

The lane exists and is runnable: `node packages/playtest/dist/runner/cli.js <scenario> --device
<serial>`, `perf --logcat <serial>`, and `doctor --device <serial> --text` for the thermal
precondition. Desktop fps is not a substitute — presents throttle under a private Xvfb, so desktop
arms report `render.p50` and `gpuMs` and the **device lane owns every fps verdict** in this PRD.

## Scope

**In:** the selection meter; a device-measured tier table per platform class; the step-down report;
one physical-device proof per shipped default.

**Out:** new stages, new nodes, new quality knobs (`lighting/PRD-267`, `PRD-268`); the mobile frame
levers themselves (`mobile/PRD-214` phases 1–2); anything that changes a colour, strength or curve —
those stay in `src/render/` under the charter's look veto, and this PRD may not move one.

## Acceptance criteria

- [ ] **AC1 — the ladder reads the limiter.** Tier selection consumes `gpuMs` when the frame budget
      reports it and `render` only when it does not, and the emitted report names which input was
      used. *Mutation:* force the selector back to `render` on a window whose `gpuMs` is over budget
      and `render` is under it — the step-down spec fails.
- [ ] **AC2 — no timestamp query is a stated fallback, not a silent one.** On a target with no
      timestamp query the report carries a non-empty reason naming the fallback. *Mutation:* blank
      the reason and the spec fails on the empty string, not on the tier.
- [ ] **AC3 — the phone is measured, not inferred.** For each platform class in the templates'
      Tier 1 table, one run on a physical Android device records fps, `gpuMs`, the tier that ran and
      the thermal status at start and end. A class not executed is recorded UNVERIFIED and its
      default is not claimed.
- [ ] **AC4 — the shipped mobile default clears its floor.** On the device, every template's default
      path holds its Tier 1 floor (browser-Android 30 fps, native-Android 55 fps) for a steady-state
      window with window 1 discarded. A template that cannot is fixed by moving its default down a
      tier, never by moving the floor.
- [ ] **AC5 — the step-down is observable from a scenario.** A playtest asserts the tier and the
      source (`pinned` / `auto`), and fails — not passes — when the report is absent.
      *Mutation:* delete the report emission and the scenario fails closed.
- [ ] **AC6 — turning it off does not turn the measurement off.** With the ladder pinned, the report
      still names the tier, the source `pinned`, and every stage's applied/refused reason.
- [ ] **AC7 — the record.** One dated file in `docs/verification/` names the serial, the adapter,
      the thermal status, the build under test and every command run; runtime/core performance
      findings update `docs/verification/runtime-perf-state.md` in place per that file's policy.

## What not to do

- Do not grade fps from a desktop or Xvfb arm. Those arms are for `gpuMs` and `render.p50` only.
- Do not raise a Tier 1 floor to make a default pass. The default moves; the floor does not.
- Do not add a knob to `packages/core` that names a colour, a strength or a curve. If the fix reads
  as an appearance parameter, it belongs in the template's `src/render/`.
- Do not start before PRD-278 lands a chain in more than one template — one template is an anecdote.
