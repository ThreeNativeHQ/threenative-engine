# PRD-848 — native-css lays out every Tailwind layout family like Chromium

**Status:** PARTIAL
**Priority:** P1 — the rts kit ships `float-right`, every kit emits `.table`, and AC-1 to AC-4 still refuse or do not prove tables, floats, columns, sticky, subgrid, line clamp, container queries and scroll snap.
**Complexity:** 7 (HIGH) — 6 to 10 files (+2), layout engine patches (+2), Rust crate plus TS build (+2), scroll state (+1).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

The scanner refuses, or no fixture proves, these Tailwind layout units:

| Group | Units | Engine state (blitz-dom 0.3.0-beta.2, taffy 0.14.0) |
| --- | --- | --- |
| Tables | `table*`, `border-collapse`, `border-spacing-*`, `caption-*`, `table-auto/fixed` | `layout/table.rs` exists, unproven |
| Floats | `float-*`, `clear-*` | float boxes are constructed, unproven |
| Columns | `columns-*`, `break-before/after/inside-*`, `box-decoration-*` | multicolumn code exists, unproven |
| Sticky | `sticky` | no implementation found |
| Subgrid | `grid-cols-subgrid`, `grid-rows-subgrid` | unproven in taffy 0.14 |
| Line clamp | `line-clamp-*` (`-webkit-box`, `-webkit-line-clamp`) | no implementation found |
| Container queries | `@container`, `@sm:` to `@7xl:`, `@min-*`, `@max-*`, `container-type` | Stylo has container queries; blitz wiring unproven |
| Scroll | `snap-*`, `scroll-m*`, `scroll-p*`, `scroll-smooth`, `overscroll-*` | no snap, rest unproven |
| Logical and grid-auto | `inset-s/e/bs/be`, `ms/me/ps/pe`, `border-s/e`, `rounded-s/e/ss/se/es/ee`, `block-*`/`inline-*` sizes, `grid-flow-*`, `auto-cols/rows-*`, `justify-items/self`, `place-*`, `align-*` (vertical-align), `display: contents/flow-root/list-item` | mapped by Stylo, unproven |

## Solution

Run the meter per group and fix the gaps it shows, in the vendored blitz-dom and taffy, with one
`PATCHES.md` entry per hunk. New work:

- sticky: offset during scroll, resolved against the nearest scroller;
- line clamp: truncate after N lines and paint the ellipsis, reusing patch 7 (the single-line
  ellipsis);
- scroll snap: settle the scroll offset after wheel input.

Sticky and snap need scroll input, so they run through `corpus/interactions.mjs` scripts. Delete
each refused row from `native-css-compat.ts` in the commit that turns its group green.

## Acceptance Criteria

- [ ] AC-1 [local]: every table, float and column unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-848 --group flow` plus `--host`, and the judge on `--sheet PRD-848` — Evidence: pending.
- [ ] AC-2 [local]: every sticky, scroll and snap unit passes after the same wheel script in both renderers, and the judge returns SAME. proof: `parity:tailwind --family PRD-848 --group scroll` — Evidence: pending.
- [ ] AC-3 [local]: every subgrid, line-clamp and container-query unit passes, and the judge returns SAME. proof: `--group grid-and-query` — Evidence: pending.
- [ ] AC-4 [local]: every logical-property, grid-auto and display unit passes, and the judge returns SAME. proof: `--group logical` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Layout families on native | game Tailwind class → `css-ui` layout (blitz-dom, taffy) | Table, float, column, sticky, subgrid, snap and container rows deleted from `native-css-compat.ts` | AC-1 to AC-4 |

## Execution Phases

#### Phase 1: Flow layout
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/layout/{table,construct,inline}.rs`, `vendor/PATCHES.md`.

- [x] The tag gate admits the table family, so the flow group can be measured at all. proof: `parity:tailwind --family PRD-848 --group flow`
  Evidence: `native/css-ui/src/lib.rs`'s closed `TAGS` list refused `table`, `tbody`, `tr`, `td`, `th`, `caption`,
  `colgroup` and `col`, so six flow cells could not even be staged; they are allowed now and the group measures
  1/15 with 232 non-discriminating and 1 refused.
- [ ] Tables, floats and columns pass, and their rows leave the denylist. proof: AC-1
  Evidence: NOT met — 1 of 15. `columns-12` beside a float is the one stage the engine does not finish in 60 s;
  each flow cell now has its own panel so that costs one cell instead of nine. The rest are staging gaps:
  `border-collapse`/`border-spacing`/`caption-top` need a table whose cells have borders, `clear-end` and
  `break-*` need content that actually breaks, `box-decoration-clone` needs a fragmented box.

#### Phase 2: Scroll family
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{scrolling.rs,layout/mod.rs}`, `corpus/interactions.mjs`.

- [ ] Sticky and snap pass after scroll input, and their rows leave the denylist. proof: AC-2
  Evidence: NOT met, and the group now measures honestly (0/31, 30 non-discriminating) after two fixes that
  removed a false 140 px failure: the engine's client rect for a scrolled box (blitz-dom hunk 17) and the
  compositor delay on Chromium's wheel. What is left is drivers plus one upstream gate: `scroll-margin-*` and
  `scroll-padding-*` are Gecko-only in Stylo 0.20, so the 21 `scroll-m*` cells need a vendored Stylo hunk before
  any driver can prove them.

#### Phase 3: Grid, clamp, queries and logical properties
**Status:** PARTIAL
**Files:** `vendor/taffy-0.14.0`, `vendor/blitz-dom-0.3.0-beta.2/src/layout/inline.rs`, the guide, the floor.

- [ ] Subgrid, line clamp and container queries pass. proof: AC-3
- [ ] Logical, grid-auto and display units pass, and the floor rises. proof: AC-4 plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-848`: **19 of 69 units pass**
across the four groups (flow 1/15, logical 18/18, scroll 7/31, grid-and-query 0/5); the scroll group's 23 non-discriminating
cells are the driver gaps above, and 2 of the 5 grid-and-query cells are exempt.

- **Flow (1/15).** The tag gate is open (see Phase 1) and every cell but one is measured. `columns-12` with a float
  does not finish in the meter's 60 s budget — a real engine hang in the multicolumn path, and the only refused
  cell left in the batch. The thirteen that do not discriminate are staging: a border-spacing or caption needs a
  table whose cells carry borders and whose caption is content; `clear-*`/`break-*` need a float to clear and a box
  that can fragment.
- **A scroller that is also the probe must not carry the probe's fill, and its content must be
  text-free.** Two staging faults in the same family: `.probe`'s blue fill painted the scroller solid and
  hid its own children, and the fillers' labels put glyph anti-aliasing — the one difference this engine
  and Chromium always have — into a cell that measures a *position*. Clearing the fill and dropping the
  labels moved the `scroll-p*` cells from 0.92 to **0.97** against the 0.99 bar; what is left is the
  stopped position itself.
- **`scroll-p*` cells discriminate now and measure a real difference (0.92 to 0.98).** The vacuity arm
  strips the last class of an element whose class list *starts* with `probe`, and the scroller was spelled
  `stage-scroll probe scroll-p-40` — so both arms rendered the same document and the staging looked inert.
  With `probe` first they discriminate, and the remaining mismatch is the engine's offset against
  Chromium's: the browser stops at 176 for a 160px `scroll-padding` with the target 336px down (checked in
  isolation) and the crate's own test pins the same arithmetic, so the difference is in the scene's staged
  geometry — the next thing to measure there.
- **Superseded note:** The unit's class now goes
  on the *scroller* — which becomes the probe — with a distinct target inside it that the driver seeks, so
  the cell measures 0.9984 against a 0.99 bar. Both arms stop within 160px of each other and the frame
  they show is too similar to tell: the next attempt needs a marker at a fixed offset inside the scroll
  content, so the stopped position is visible rather than inferred.
- **Scroll (7/31, 23 do not discriminate).** The wheel driver is built: a scroll cell is captured after one
  `wheel` of 140 px, dispatched at the probe's centre in Chromium and by `drive.json` on the engine, and each
  scroll cell now has its own panel because twelve wheels in one frame is not the same input on both subjects —
  the first one moves the layout under the coordinates the others aim at.
  - **The "140 px wheel-routing difference" was two defects, neither of them routing.** Chromium applies a
    wheel on the compositor: measured on a `.stage-scroll` cell, `scrollTop` is 0 when `page.mouse.wheel`
    resolves and 140 two animation frames later, so the capture compared a scrolled engine frame against an
    unscrolled browser one. The engine, separately, reported a *scrolled container* 140 px above its own box,
    because `absolute_position` subtracts a node's own scroll offset (right for paint, wrong for a client rect —
    blitz-dom hunk 17). Both are fixed and both have a check; the family now says what is true: **0/31 with 30
    cells honestly non-discriminating** instead of 6 false failures.
  - **A probe scrolled out of its cell collapsed the region** to a one-row crop, and SSIM over that is `NaN`
    (printed as 0.0 for all 31). The region now falls back to the cell's own stage when nothing of the probe is
    inside it.
  - What the group still needs is drivers, not pixels: `scroll-margin`/`scroll-padding` only move a scroller when
    a *snap* or a `scrollIntoView` lands on them, `snap-*` needs snap, `overscroll-*` needs a scroller at its
    limit, and `sticky` needs the scroller to move under it.
  - **The upstream gate is gone.** Stylo 0.20 built `scroll-margin-*`/`scroll-padding-*` for Gecko only, so the
    servo build never parsed them; a vendored hunk (16 longhands and six shorthands, `vendor/PATCHES.md`) puts
    them in. `scrollIntoView` also scrolled only the viewport and read neither property, and now walks every
    scrollable ancestor innermost-first (blitz-dom hunk 20). The group is **7 of 31**: the block-axis margins
    pass on both subjects, and the rest need drivers — `overscroll-*` needs a scroller at its limit, `snap-*`
    needs snap, and the 11 `scroll-p*` cells need a stage that puts the class on the *scroller* (their property
    is the container's, like `justify-*`), which is the next staging rule in this group.
- **Logical (12/18) and grid-and-query (1/5).** The logical cells that do not discriminate are `border-*-start`-style
  longhands on a probe with no border width, and the query cells need a sized container ancestor.
