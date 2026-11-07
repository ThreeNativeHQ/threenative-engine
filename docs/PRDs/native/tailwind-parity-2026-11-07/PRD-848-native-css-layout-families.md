# PRD-848 — native-css lays out every Tailwind layout family like Chromium

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/layout/{table,construct,inline}.rs`, `vendor/PATCHES.md`.

- [ ] Tables, floats and columns pass, and their rows leave the denylist. proof: AC-1

#### Phase 2: Scroll family
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{scrolling.rs,layout/mod.rs}`, `corpus/interactions.mjs`.

- [ ] Sticky and snap pass after scroll input, and their rows leave the denylist. proof: AC-2

#### Phase 3: Grid, clamp, queries and logical properties
**Status:** NOT STARTED
**Files:** `vendor/taffy-0.14.0`, `vendor/blitz-dom-0.3.0-beta.2/src/layout/inline.rs`, the guide, the floor.

- [ ] Subgrid, line clamp and container queries pass. proof: AC-3
- [ ] Logical, grid-auto and display units pass, and the floor rises. proof: AC-4 plus `parity:tailwind --ratchet`
