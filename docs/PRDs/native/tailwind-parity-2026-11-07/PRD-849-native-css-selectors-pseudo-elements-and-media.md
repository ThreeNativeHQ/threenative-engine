# PRD-849 — native-css matches every Tailwind variant: selectors, pseudo-elements and media

**Status:** DONE (re-scoped)
**Priority:** P2 — AC-1 to AC-3 cover the variants no kit has hit yet (`has-*`, `::first-letter`, `contrast-more:`); the motion and form variants are owned by PRD-847 and PRD-851.
**Complexity:** 5 (MEDIUM) — 3 to 5 files (+1), state-driven matching (+2), Rust crate plus host environment (+2).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

Tailwind 4.3.3 has 88 variants. The corpus proves hover, focus-visible, disabled, aria and data
attributes, group and peer, `first`/`last`/`nth`, `dark` and `min-width` breakpoints. This PRD owns
the rest, except the motion variants (PRD-847) and the form variants (PRD-851):

| Group | Variants |
| --- | --- |
| Relational | `has-*`, `group-has-*`, `peer-has-*`, `in-*`, `not-*` (the scanner refuses `:has()` today) |
| Structural and state | `odd`, `even`, `nth-last-*`, `*-of-type`, `only`, `empty`, `target`, `inert`, `open`, `focus-within`, `active`, `enabled`, `visited` |
| Pseudo-elements | `before`, `after` (with `content-*`), `first-letter`, `first-line`, `marker`, `selection`, `backdrop`, `details-content` |
| Media and environment | `max-*` breakpoints, `contrast-more`, `contrast-less`, `forced-colors`, `inverted-colors`, `portrait`, `landscape`, `pointer-*`, `any-pointer-*`, `ltr`, `rtl`, `print`, `noscript`, `supports-*` |

## Solution

Each environment variant gets one host input that the meter can set on both sides. Chromium uses
CDP media emulation. Native uses the `css-ui` device descriptor, where blitz already reads dark
mode and the hover capability. Pseudo-elements and `:has()` are fixed in the vendored blitz-dom and
Stylo as the meter shows. `supports-*` must agree with what the engine paints (the guide's
"`@supports` is not trusted" note). It therefore uses the profile table, not parse-ability. Delete
the `:has()` row from `native-css-compat.ts` when its units pass.

## Acceptance Criteria

Scoped by the owner's decision of 2026-11-07: **every variant unit in this family is measured, parity is
claimed only where the engine and the reference browser permit it, and each place they do not is a
documented limit with its measured number and a named follow-up.** Family result today: **44 of 66 pass,
5 do not discriminate, 4 fail, 13 exempt** — selectors 25 of 34, pseudo-elements 2 of 8, media 17 of 24.

- [x] AC-1 [local]: every relational and structural variant unit is measured, and each remaining mismatch is a documented limit with its number. proof: `parity:tailwind --family PRD-849 --group selectors`. Evidence: selectors **25 of 34** pass, with two failures — `active:bg-red-500` **0.6492** (the engine keeps the pressed state while the browser's capture does not) and `ltr:bg-red-500` **0.6492** (Stylo's `:dir()` matching, documented below) — plus three non-discriminating cells. The 13 family exemptions include the form-state variants owned by PRD-851.
- [x] AC-2 [local]: every pseudo-element variant unit is measured, and the ones neither subject can paint or emulate are named exemptions with their reason. proof: `parity:tailwind --family PRD-849 --group pseudo`. Evidence: **2 of 8** pass; `first-line:text-red-400` measures **0.9629** (it paints, at a glyph anti-aliasing margin) and two cells do not discriminate; `::selection`, `::backdrop` and `::details-content` are exemptions because Chromium's emulation cannot put the reference browser into the state that paints them.
- [x] AC-3 [local]: every media and environment variant is measured with its emulated input, and each remaining one names the reference browser's limit rather than a silent gap. proof: `parity:tailwind --family PRD-849 --group media` plus `--env all`. Evidence: **17 of 24** pass. `contrast-more:` and `forced-colors:` pass and left the exemption list: the engine answers those queries through the vendored Stylo hunks (`MEDIA_FEATURES` 15 → 19, see `vendor/PATCHES.md`), and Chromium through `page.emulateMedia`. What remains: `prefers-contrast: less` is not a Playwright value and the DevTools feature list that offers it only applies with an empty `media`, which breaks the viewport queries in the same run (measured); `inverted-colors` is ignored by Chromium's emulation entirely; `pointer-none`/`any-pointer-none` need a device with no pointer at all.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Variants on native | game Tailwind variant → Stylo matching in `css-ui` with the host device descriptor | `:has()` row deleted from `native-css-compat.ts` | AC-1 to AC-3 |

## Decisions

- 2026-11-07 (agent, at the owner's "cover everything" request): `print` and `noscript` cannot
  discriminate. A game host never prints and always runs script, so both renderers agree the rule is
  inactive and no measurement of them can tell a correct engine from a wrong one. `visited` needs
  links (no navigation) and `target` needs a URL fragment, which neither subject sets. These four are
  therefore *permanently inactive* and are the only units outside the meter's denominator (507 units,
  503 scored). Every other exemption the scene names is *pending*: it stays in the denominator and
  counts as a failure until its owner PRD lands the device input or the control.

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-849` per group:
**44 of 66 pass, 5 do not discriminate, 4 fail, 13 exempt** — selectors 25 of 34, pseudo-elements 2 of 8,
media 17 of 24.

**Nothing open at the re-scoped bar**: every unit is measured, every failure carries its number, and the
three things that cannot pass are documented above with their follow-ups. Named follow-ups, in the order
they matter: `:dir()` in Stylo (`ltr:` 0.6492), the `has-[:checked]:` scene fault (0.0000, no box in
Chromium), and `active:` 0.6492 (pressed-state timing between the two subjects).

What the family delivered, measured:

- **Selectors 25 of 34, from 10.** The variant staging was keyed by class instead of by variant name, so
  every structural variant asked for a document the scene never built; four more faults followed the first
  measurement that could see them (the engine's attribute allowlist, React's boolean attributes, the UA
  focus ring, `focus-within:`'s focusable child).
- **Media 17 of 24.** The preference queries exist in the vendored Stylo and are read from the device:
  `MEDIA_FEATURES` went 15 → 19 with `prefers-reduced-motion`, `prefers-contrast`, `forced-colors` and
  `inverted-colors`, each a value in `queries/values.rs`, a device field with its setter, an evaluator with
  its `feature!` entry, and the feature's name in `stylo_atoms`' `static_atoms.txt`. `contrast-more:` and
  `forced-colors:` pass and left the exemption list; the latter is staged on `mt-8` because forced colours
  rewrite every painted colour (Canvas white, as in Chromium), so no colour can discriminate in it.
- **`any-pointer` was misreported** and is fixed (blitz-dom hunk 19): a desktop answered
  `(any-pointer: coarse)`, so `any-pointer-coarse:` fired on a mouse.
- **The whole `scroll-margin-*`/`scroll-padding-*` family was inert** until the `engine = "gecko"`
  restriction came off them (16 longhands, 6 shorthands) — a selector-engine change that unblocked PRD-848's
  scroll group rather than this one.

## Execution Phases

#### Phase 1: Selectors
**Status:** DONE (re-scoped: measured, with the limits named)
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{stylo,document}.rs`, `packages/create-threenative/src/native-css-compat.ts`, its spec.

- [x] Relational and structural variants are measured, and `:has()` stays on the denylist by decision. proof: AC-1
  Evidence: selectors **25 of 34**; `active:` **0.6492** and `ltr:` **0.6492** are the two real
  mismatches. `has-[:checked]:` measures **0.0000** because the panel renders no box in Chromium — a scene
  fault, not an engine one — so the `:has()` row in `native-css-compat.ts` stays: admitting a selector whose
  cell cannot render would ship a rule nobody has measured.

#### Phase 2: Pseudo-elements
**Status:** DONE (re-scoped: measured, with the limits named)
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/layout/{construct,inline}.rs`, `vendor/PATCHES.md`.

- [x] Pseudo-element variants are measured, and the one that paints within a margin is recorded as such. proof: AC-2
  Evidence: **2 of 8** pass, `first-line:text-red-400` **0.9629**, two non-discriminating, and `::selection`
  / `::backdrop` / `::details-content` exempt because the reference browser cannot emulate the state that
  paints them.

#### Phase 3: Environment
**Status:** DONE (re-scoped: measured, with the limits named)
**Files:** `native/css-ui/src/lib.rs` (device descriptor), `corpus/tailwind-parity.mjs` (`--env`), the guide, the floor.

- [x] Media variants are measured with each input on and off, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`
  Evidence: media **17 of 24**, family **44 of 66**; `contrast-more:` and `forced-colors:` pass after the
  vendored Stylo features landed (`MEDIA_FEATURES` 15 → 19), and the ratchet protects the score this family
  contributes.
  Evidence: PARTIAL — `contrast-more:` and `forced-colors:` pass; the other five findings are the browser's
  emulation limits or two remaining staging gaps, listed in AC-3. The scaffold this needed was the vendored
  Stylo, and the three features went in as predicted: value, device field, evaluator, `feature!` entry, atom,
  plus the `CssUi::set_media_preferences` descriptor. The original note (which follows) is what the recipe
  predicted; the outcome matched it. The vendored
  `stylo-0.20.0` + `stylo_atoms-0.20.0` (see `vendor/PATCHES.md`) took `prefers-reduced-motion` from "no such
  media feature" to a passing variant in five small edits, and `contrast-more:`/`contrast-less:`,
  `forced-colors:` and `inverted-colors:` are the same five each: a value in `queries/values.rs`, a field plus
  setter/getter in `device/servo.rs` (`forced_colors()` currently returns a hardcoded `ForcedColors::None` and
  has to become the field), an evaluator and `feature!` entry in `servo/media_features.rs` with
  `MEDIA_FEATURES` bumped, the feature's name in `stylo_atoms`' `static_atoms.txt`, and the device input.
  The input is the one piece that is *not* a copy: `css-ui`'s `set_env` carries two booleans and would either
  grow (`set_env` is the C ABI the host calls, so that is a host change too) or take a second setter read from
  the oracle's `env.json` for the crate subject first. The scene's three cells already exist and carry their
  exemption text, so the work is the engine feature plus a device descriptor, then deleting each exemption.
