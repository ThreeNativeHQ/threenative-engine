# PRD-851 — native-css measures form controls and names the gap; text input is out of scope

**Status:** DONE (re-scoped)
**Priority:** P2 — about 20 Tailwind units style form controls only, and this engine paints none of them.
**Complexity:** 3 (LOW) after the re-scope — the deliverable is a measured, documented limit rather than a subsystem.
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

The guide says "No text input, IME, `<select>`, dialogs or links". Tailwind units that need a form
control:

- `accent-*`, `caret-*`, `field-sizing-*`, `resize-*`, `appearance-*`, `placeholder-*`;
- the variants `placeholder:`, `placeholder-shown:`, `file:`, `autofill:`, `checked:`,
  `indeterminate:`, `default:`, `required:`, `optional:`, `valid:`, `invalid:`, `user-valid:`,
  `user-invalid:`, `in-range:`, `out-of-range:`, `read-only:`.

blitz-paint has `render/form_controls.rs` (checkbox and radio paint). blitz-dom has no text editing
the host can drive.

## Scope decision (owner, 2026-11-07)

**This PRD does not build a form-control subsystem.** The owner re-scoped it to a *measured, documented
limit*: the batch's job is to say exactly what this engine does and does not paint, with numbers, and to
name the follow-up — not to grow a text input, a caret, an IME path and a `<select>` popup inside a
Tailwind parity batch. Building those is its own project, tracked below as the follow-up this PRD hands
over.

What this PRD still owns, and delivers:

1. the control elements are **admitted** by the engine, so a control unit is a question the meter can
   answer rather than a refused stage;
2. every form-control unit is **measured and classified** — passing, not discriminating, or exempt with
   the state it would need;
3. the gap is **documented with its number** and a named follow-up, and the ratchet floor excludes what
   cannot pass.

## Acceptance Criteria

- [x] AC-1 [local]: every form-control utility unit is measured rather than refused, and the family's result is reported with its numbers. proof: `parity:tailwind --family PRD-851`.
  Evidence: **0 of 21 pass, 5 do not discriminate, 16 exempt, 0 refused** — the elements (`input`,
  `textarea`, `select`, `option`, `details`, `summary`) are in `native/css-ui/src/lib.rs`'s `TAGS`, a
  control unit is staged on a real focused `<textarea>`, and all five paint units measure a real
  mismatch against Chromium's user-agent control (SSIM 0.7354).
- [x] AC-2 [local]: the missing input subsystem is named, with the exact seam it would need, instead of being claimed. proof: this section, read against `native/css-ui/src/abi.rs`.
  Evidence: `native/css-ui` has no editing model, no caret, no selection and no ABI call, and the
  desktop host has no `SDL_StartTextInput` seam into it. Nothing in this batch types into a field; the
  `--host` subject refuses driven input by name for the same reason.
- [x] AC-3 [local]: the 16 state variants are pending exemptions owned here, each naming the state a control would have to be in, and the floor excludes them. proof: `parity:tailwind --check` plus the scene's exemption list.
  Evidence: `checked:`, `invalid:`, `in-range:`, `placeholder-shown:` and the rest are `exempt` with
  `owner: PRD-851` and their state in the message; `--check` reports them as named exemptions rather
  than as unowned cells.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Control elements admitted | a game's `<input>`/`<select>` in `src/ui` reaches layout and style | The engine's closed `TAGS` list no longer refuses them | AC-1 |
| Control *paint* | — | **Not delivered**: documented limit, follow-up below | AC-1's 0.7354 |
| Text input and IME | — | **Not delivered**: documented limit, follow-up below | AC-2 |

## Follow-up this PRD hands over

Paint the controls Chromium's way first (checkbox, radio, range, text field, textarea, `<select>` closed),
then add input: the host's `SDL_StartTextInput` and composition events through a new `css-ui` ABI call
into the focused field, with caret, selection and `input`/`change` reaching React. Platform IME on
Android and iOS is outside it. That is a multi-day subsystem, not a Tailwind parity task, and the meter
already tells its future owner the starting number for every cell it touches.

## Execution Phases

#### Phase 1: Control paint
**Status:** DONE (re-scoped: measured, not painted)
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render/form_controls.rs`, `vendor/PATCHES.md`.

- [x] The engine admits the control elements, so a control unit is a question it can answer. proof: `parity:tailwind --family PRD-851`
  Evidence: `native/css-ui/src/lib.rs`'s `TAGS` refused `input`, `textarea`, `select`, `option`, `details` and `summary`; they
  are allowed now, and a control utility (`accent-*`, `caret-*`, `appearance-*`, `field-sizing-*`, `resize-*`) is staged on a
  real `<textarea>` focused by the Tab both subjects receive, instead of on a `div` the property cannot apply to.
- [x] Every control unit is measured, and the gap is recorded with its number. proof: AC-1
  Evidence: 0 of 21 pass; the five paint units measure 0.7354 against Chromium's user-agent control and
  five further cells do not discriminate because a field with no user state shows no accent, no caret
  and no resizer. Painted controls are the follow-up above.

#### Phase 2: Text input
**Status:** OUT OF SCOPE (owner decision, documented)

- [x] The missing seam is named precisely, so the follow-up can start from it. proof: AC-2
  Evidence: no editing model, caret, selection or ABI call in `native/css-ui`; no `SDL_StartTextInput`
  path in the desktop host. Typing and IME composition are not claimed anywhere in the batch.

#### Phase 3: Form states
**Status:** DONE (re-scoped: exempted by name, floor excludes them)

- [x] The 16 state variants are named exemptions owned here, and the floor rises without them. proof: AC-3
  Evidence: `--check` reports 21 named exemptions across the batch, 16 of them these states;
  `parity:tailwind --floor` protects 319 units and none of the 21.

## Open

**Nothing open.** The re-scoped deliverable is complete: the elements are admitted, every unit is
measured, the 0.7354 gap and the five non-discriminating cells are recorded, the 16 state variants are
named exemptions, and the subsystem that would close the gap is written down as the follow-up above.
Re-opening this PRD means building that subsystem, which the owner has explicitly kept out of the batch.
