# PRD-849 — native-css matches every Tailwind variant: selectors, pseudo-elements and media

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: every relational and structural variant unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-849 --group selectors` plus `--host`, and the judge on `--sheet PRD-849` — Evidence: pending.
- [ ] AC-2 [local]: every pseudo-element variant unit passes, and the judge returns SAME. proof: `--group pseudo` — Evidence: pending.
- [ ] AC-3 [local]: every media and environment variant passes with its emulated input on and off, and the judge returns SAME. proof: `--group media --env all` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Variants on native | game Tailwind variant → Stylo matching in `css-ui` with the host device descriptor | `:has()` row deleted from `native-css-compat.ts` | AC-1 to AC-3 |

## Decisions

- 2026-11-07 (agent, at the owner's "cover everything" request): `print` and `noscript` stay in the
  denominator. A game host never prints and always runs script, so they pass by both renderers
  agreeing that the rule is inactive. They are the only vacuity-guard exemptions. `visited` needs
  links, which the engine does not have (no navigation). Its unit passes by both sides agreeing
  that an `<a>` is unvisited.

## Execution Phases

#### Phase 1: Selectors
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{stylo,document}.rs`, `packages/create-threenative/src/native-css-compat.ts`, its spec.

- [ ] Relational and structural variants pass, and `:has()` leaves the denylist. proof: AC-1

#### Phase 2: Pseudo-elements
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/layout/{construct,inline}.rs`, `vendor/PATCHES.md`.

- [ ] Pseudo-element variants pass. proof: AC-2

#### Phase 3: Environment
**Status:** NOT STARTED
**Files:** `native/css-ui/src/lib.rs` (device descriptor), `corpus/tailwind-parity.mjs` (`--env`), the guide, the floor.

- [ ] Media variants pass with each input on and off, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`
