# PRD-851 — native-css renders and drives form controls and text input like Chromium

**Status:** PARTIAL
**Priority:** P2 — about 20 Tailwind units (AC-1 to AC-3) style only form controls, and the engine has none: no `<input>`, `<textarea>`, `<select>`, text input or IME.
**Complexity:** 9 (HIGH) — 6 to 10 files (+2), new input subsystem (+2), focus, caret and IME state (+2), Rust crate plus C++ host plus platform text input (+2), host ABI (+1).
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

## Solution

1. Paint the controls first: checkbox, radio, range, text field, textarea and select closed state,
   using the user-agent look Chromium draws (matched by the meter).
2. Then add input: the host's SDL text input (`SDL_StartTextInput`, composition events for IME)
   goes through a new `css-ui` ABI call into the focused field's value. The field has a caret,
   selection and `input`/`change` events reaching React.
3. `<select>` opens an in-engine popup, not an OS one, so it renders the same on every platform.

Platform IME on Android and iOS is outside the batch (see the README scope limits).

## Acceptance Criteria

- [ ] AC-1 [local]: every form-control utility unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-851 --group paint` plus `--host`, and the judge on `--sheet PRD-851` — Evidence: pending.
- [ ] AC-2 [local]: typing `Olá 123` into a focused text field on the desktop host updates React state and paints the same text, caret and placeholder change as Chromium. proof: a desktop playtest with a text input injector, plus `--group input` — Evidence: pending.
- [ ] AC-3 [local]: every form-state variant unit (`checked:`, `invalid:`, `in-range:` and the rest) passes after the same input script, and the judge returns SAME. proof: `--group states` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Form controls on native | game `<input>`/`<select>` in `src/ui` → `css-ui` paint | The guide's "no text input" restriction is removed | AC-1 |
| Text input | SDL text and composition events → desktop host → new `css-ui` ABI → React `onChange` | New | AC-2 |

## Execution Phases

#### Phase 1: Control paint
**Status:** PARTIAL
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render/form_controls.rs`, `vendor/PATCHES.md`.

- [x] The engine admits the control elements, so a control unit is a question it can answer. proof: `parity:tailwind --family PRD-851`
  Evidence: `native/css-ui/src/lib.rs`'s `TAGS` refused `input`, `textarea`, `select`, `option`, `details` and `summary`; they
  are allowed now, and a control utility (`accent-*`, `caret-*`, `appearance-*`, `field-sizing-*`, `resize-*`) is staged on a
  real `<textarea>` focused by the Tab both subjects receive, instead of on a `div` the property cannot apply to.
- [ ] All control types paint, and the paint units pass. proof: AC-1
  Evidence: NOT met — all five paint units measure a real mismatch (SSIM 0.7354 against Chromium's user-agent control) and
  none of them discriminates yet, because a bare field shows no accent, caret or resizer without the state its own driver
  would set.

#### Phase 2: Text input
**Status:** PARTIAL
**Files:** `native/css-ui/src/{lib,abi}.rs`, `include/mystral/platform/ui_overlay.h`, the desktop host input seam, `packages/playtest` text injector.

- [ ] Typing and IME composition reach React on the desktop host. proof: AC-2

#### Phase 3: Form states
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/stylo.rs`, the guide, the floor.

- [ ] Form-state variants pass, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-851`: **0 of 21 units pass**, 5 do not
discriminate and 16 are pending exemptions.

- **The gate is open; nothing paints.** The control elements are admitted and every control unit is staged on a focused
  `<textarea>`, so the family is measured rather than refused — and all five measure 0.7354 against Chromium's own control
  paint. That is the real starting point: `blitz-paint` has `render/form_controls.rs` for checkboxes and radios only.
- **Five cells still do not discriminate** because a field with no user state shows no accent, no caret and no resizer.
  `caret-color` needs a focused field with a caret (Tab is driven); `accent-color` needs a checked control; `resize` needs
  the UA resizer, which Chromium paints and the engine does not.
- **The 16 state variants stay pending**: `checked:`, `invalid:`, `in-range:` and the rest need a control that can *be* in
  that state, which is the same missing paint plus the input plumbing.
- **Text input and IME are untouched**: `native/css-ui` has no editing model, no caret, no selection and no ABI call, and
  the desktop host has no `SDL_StartTextInput` seam into it.
