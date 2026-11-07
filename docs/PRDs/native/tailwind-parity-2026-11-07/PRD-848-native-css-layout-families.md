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
  1/15 with 233 non-discriminating and 1 refused.
- [ ] Tables, floats and columns pass, and their rows leave the denylist. proof: AC-1
  Evidence: NOT met — 1 of 15. `columns-12` beside a float is the one stage the engine does not finish in 60 s;
  each flow cell now has its own panel so that costs one cell instead of nine. The rest are staging gaps:
  `border-collapse`/`border-spacing`/`caption-top` need a table whose cells have borders, `clear-end` and
  `break-*` need content that actually breaks, `box-decoration-clone` needs a fragmented box.

#### Phase 2: Scroll family
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{scrolling.rs,layout/mod.rs}`, `corpus/interactions.mjs`.

- [ ] Sticky and snap pass after scroll input, and their rows leave the denylist. proof: AC-2

#### Phase 3: Grid, clamp, queries and logical properties
**Status:** PARTIAL
**Files:** `vendor/taffy-0.14.0`, `vendor/blitz-dom-0.3.0-beta.2/src/layout/inline.rs`, the guide, the floor.

- [ ] Subgrid, line clamp and container queries pass. proof: AC-3
- [ ] Logical, grid-auto and display units pass, and the floor rises. proof: AC-4 plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-848`: **19 of 69 units pass**
across the four groups (flow 1/15, logical 12/18, scroll 6/31, grid-and-query 1/5), with 31 cells that do not
discriminate.

- **Flow (1/15).** The tag gate is open (see Phase 1) and every cell but one is measured. `columns-12` with a float
  does not finish in the meter's 60 s budget — a real engine hang in the multicolumn path, and the only refused
  cell left in the batch. The thirteen that do not discriminate are staging: a border-spacing or caption needs a
  table whose cells carry borders and whose caption is content; `clear-*`/`break-*` need a float to clear and a box
  that can fragment.
- **Scroll (6/31).** `scroll-m*`/`scroll-p*`/`snap-*` need a wheel script: at scroll 0 they change nothing, which is
  what a `scroll-snap-align` looks like before anything scrolls. `corpus/interactions.mjs` already has the grammar
  (the corpus drives nested scrollers with it); pointing it at a parity panel is the work.
- **Logical (12/18) and grid-and-query (1/5).** The logical cells that do not discriminate are `border-*-start`-style
  longhands on a probe with no border width, and the query cells need a sized container ancestor.
