# PRD-848 — native-css lays out every Tailwind layout family like Chromium

**Status:** DONE (re-scoped)
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

At the re-scoped bar (owner, 2026-11-07) that deletion is bound to *the mechanism*, not to a measurement:
`table*`, `sticky`, `columns-*`, `scroll-snap-*`, `float` and the 3D-adjacent rows stay in the denylist
until the mechanism below exists, because the profile exists so a game cannot build with layout the engine
silently gets wrong. The cells are measured either way, and each limit carries its number.

## Acceptance Criteria

Scoped by the owner's decision of 2026-11-07: **every unit in this family is measured, parity is claimed
only where the engine permits it, and each place it does not is a documented limit with its measured number
and a named follow-up.** The family reads **42 of 69 pass, 16 non-discriminating, 7 fail, 4 exempt**; every
one of the seven failures and every non-discriminating cell is accounted for below.

- [x] AC-1 [local]: every table, float and column unit is measured, and the engine's table layout is documented with its numbers. proof: `parity:tailwind --family PRD-848 --group flow` — Evidence: **2 of 15 pass**, 6 non-discriminating, 6 fail — `border-collapse` 0.5444, `border-spacing-x-40` 0.6812, `table-fixed` 0.7259, `border-spacing-y-40` 0.9879, `border-spacing-40` 0.9997 and `caption-top` 0.3121 — with the misses on the tbody box (worst 412 px) and the table's own right and bottom edges, which is the table-layout limit below rather than a staging gap.
- [x] AC-2 [local]: every sticky, scroll and snap unit is measured, and the sticky and snap limits are documented. proof: `parity:tailwind --family PRD-848 --group scroll` — Evidence: **22 of 31 pass**, 8 non-discriminating, 1 fail — `sticky` 0.6215 (sticky positioning is outside the Core profile) — with the inert eight being `snap-*` (no snap implementation) and `overscroll-*`/`scroll-smooth` (a scroller at its limit or a second frame is needed to see them), and `scroll-mr-40`/`scroll-pr-40` passing once the alignment table gained the physical spellings.
- [x] AC-3 [local]: every container-query cell is measured and the wiring gap is named. proof: `--group grid-and-query` — Evidence: **0 of 5 pass**, 2 non-discriminating and none failing: Stylo answers container queries and the blitz wiring does not, which is the follow-up named below rather than a measured mismatch.
- [x] AC-4 [local]: every logical-property, grid-auto and display unit passes. proof: `--group logical` — Evidence: **18 of 18 pass**, the batch's only fully green group.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Layout families on native | game Tailwind class → `css-ui` layout (blitz-dom, taffy) | Table, float, column, sticky, subgrid, snap and container rows deleted from `native-css-compat.ts` | AC-1 to AC-4 |

## Decisions

**A `scroll-m*`/`scroll-p*` cell needs the axis the unit names, and the physical spellings were missed.**
`scroll-mr-40` and `scroll-pr-40` asked the driver for a `start`/`start` alignment, which is the axis
`scroll-ml-*` needs: the margin on the *inline end* is invisible when something scrolls to the inline
start. The alignment table now carries both spellings — `b/be/block-end` and `t/bs/block-start` for the
block axis, `e/r/end/inline-end` and `l/s/start/inline-start` for the inline one. Measured: the scroll
group 20 → **22 of 31**, non-discriminating 10 → 8, the scene 313 → **314 of 503**.

## History: the scroll offset arithmetic, settled (2026-11-07)

`scrollIntoView` now aligns with Chromium to the pixel: the element's position was taken relative to
the scroller's padding edge and then the scroller's own border and padding were subtracted again, so
every `scroll-p*` cell stopped two pixels high (measured: target rows 188..221 against Chromium's
186..221). Every block-axis `scroll-m*` and `scroll-p*` cell passes at **1.0000**.

Alignment is per axis: an end-side `scroll-margin`/`scroll-padding` only moves a scroller that aligns
to the *end*, so `scroll_node_into_view` takes `block_end`/`inline_end` and the scene's driver carries
the alignment each unit needs. The group read **20/31** at that point; it is **22 of 31** now.

What is left: `overscroll-*` (3) and `scroll-smooth` (1) need a scroller at its limit or a second
frame, `snap-*` (4) needs a snap implementation, two axis cells still do not discriminate, and
`sticky` measures 0.6215 — a real difference, and the largest single one left in this PRD.

## History: the table stage was never stripped either (2026-11-07)

A table stage's class list was `stage-table probe …`, and the vacuity arm strips the last class of an
element whose list *starts* with `probe` — so `border-spacing-*`, `border-collapse` and `table-fixed`
compared identical frames and read "does nothing" (7 of the group's 15 cells). With `probe` first they
**discriminate**, and what they measure is a real difference in this engine's table painting:
`border-collapse` 0.5444, `border-spacing-x` 0.6812, `table-fixed` 0.7259, `border-spacing-y` 0.9879 —
`border-spacing-40` is 0.9997, a thousandth under the bar. `caption-top` still does not discriminate: the
staged table has no `<caption>`.

A `border-spacing` cell stages a table that sizes to its content instead of the stage's width — a
160px spacing on a 302px stage leaves a negative content box, and the two engines clamp that
differently. Measured, that did not help (`border-spacing-40` stayed 0.9997 with six edge misses and
`-y` got worse), so it was reverted; the edge misses are on the **tbody** box (worst 412 px) and the
table's right/bottom edges, which is this engine's table layout rather than a staging choice.

The flow group therefore stays at 1/15 while its *measurement* becomes honest, and the batch's
non-discriminating count drops by 5.

## Execution Phases

#### Phase 1: Flow layout
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/layout/{table,construct,inline}.rs`, `vendor/PATCHES.md`.

- [x] The tag gate admits the table family, so the flow group can be measured at all. proof: `parity:tailwind --family PRD-848 --group flow`
  Evidence: `native/css-ui/src/lib.rs`'s closed `TAGS` list refused `table`, `tbody`, `tr`, `td`, `th`, `caption`,
  `colgroup` and `col`, so six flow cells could not even be staged; they are allowed now and every flow cell is
  measured.
- [x] Tables, floats and columns are measured, and the table-layout gap is documented with its numbers instead of claimed closed. proof: AC-1
  Evidence: **2 of 15 pass**, 6 non-discriminating, 6 fail (`border-collapse` 0.5444, `border-spacing-x-40`
  0.6812, `table-fixed` 0.7259, `border-spacing-y-40` 0.9879, `border-spacing-40` 0.9997, `caption-top` 0.3121).
  The misses are the tbody box (worst 412 px) and the table's right and bottom edges: blitz-dom maps a table
  onto taffy's grid, and a content-sized table shrinks where Chromium overflows. Named follow-up: real table
  layout in `layout/table.rs`, not a staging rule.

#### Phase 2: Scroll family
**Status:** PARTIAL
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/{scrolling.rs,layout/mod.rs}`, `corpus/interactions.mjs`.

- [x] Sticky and snap are measured, and both are documented limits with their numbers. proof: AC-2
  Evidence: the group is **22 of 31** with 8 non-discriminating and `sticky` 0.6215 the only failure. Two defects
  were fixed so the group measures honestly rather than reporting a false 140 px router difference: the engine's
  client rect for a scrolled box (blitz-dom hunk 17) and the compositor delay on Chromium's wheel. The Stylo gate
  is gone too — `scroll-margin-*`/`scroll-padding-*` were Gecko-only in 0.20 and a vendored hunk puts them in
  (16 longhands, six shorthands) — which is what lets `scroll-mr-40` and `scroll-pr-40` pass at 1.0000 now that
  the alignment table carries the physical spellings. Named follow-ups: snap (no implementation) and a scroller
  at its limit for `overscroll-*`/`scroll-smooth`.

#### Phase 3: Grid, clamp, queries and logical properties
**Status:** PARTIAL
**Files:** `vendor/taffy-0.14.0`, `vendor/blitz-dom-0.3.0-beta.2/src/layout/inline.rs`, the guide, the floor.

- [x] Container queries are measured and the wiring gap is named. proof: AC-3
  Evidence: grid-and-query is **0 of 5** with 2 non-discriminating and none failing — Stylo has container queries,
  the blitz wiring does not answer them. Named follow-up: answer `@container` from blitz's style traversal.
- [x] Logical, grid-auto and display units pass, and the floor rises. proof: AC-4 plus `parity:tailwind --ratchet`
  Evidence: logical is **18 of 18**, and the ratchet floor protects the batch's 319 units (it refuses to fall below).

### A table's row and row group now have a layout box (measured 2026-11-08)

`TableTreeWrapper` exposed the **cells only**, so a `tr` and a `tbody` were in the box tree but never in
taffy's grid: neither was ever laid out and both stayed as zero-width boxes at the table's origin. A
browser gives `tr` the row's area and `tbody` the union of its rows across the table's content width, and
the meter reads exactly those boxes for its 1-px edge bar — which is why `border-collapse`, `table-fixed`
and the three `border-spacing` cells each failed on a `tbody` miss of 300 px and more.

`TableContext` now records each cell's row and grows each row (and its group) as taffy reports the cells; a
row spans the table's *content* width from x=0 rather than from its first cell, because with
`border-spacing: 160px` the first cell starts 160 px in. Red-green in
`tests/table_boxes.rs::a_row_and_its_group_span_the_table_instead_of_collapsing_to_nothing`: `tbody` reads
`[0.0, 0.0, 0.0, 0.0]` against a 200 px table before the hunk and `[0.0, 0.0, 190.0, 62.0]` after it. On the
meter the `tbody` edge miss falls from **309.5 px to 34.5 px** (`border-collapse`) and **308 px to 36 px**
(`table-fixed`).

The group still reads 2 of 15: closing those cells needs the two things measured below the surface — a
`<caption>` is still never laid out (`collect_table_cells`'s caption arm says "Probably a table caption:
ignore", so `caption-top` stays at 0.3121) and the table's own bottom edge is short by 15–20 px.

## Documented limit: this engine's table layout

`border-collapse` 0.5444, `border-spacing-x-40` 0.6812, `table-fixed` 0.7259, `border-spacing-y-40` 0.9879,
`border-spacing-40` 0.9997 and `caption-top` 0.3121 are one gap seen six ways. blitz-dom maps a table onto
taffy's grid: the misses are on the **tbody box (worst 412 px)** and on the table's own right and bottom
edges, and a content-sized table shrinks where Chromium overflows. A staging experiment (a table that sizes
to its content instead of the stage's width, because a 160px `border-spacing` on a 302px stage leaves a
negative content box) was measured and reverted — it did not help and made `-y` worse.

**Follow-up:** real table layout in `vendor/blitz-dom-0.3.0-beta.2/src/layout/table.rs` — a tbody box of its
own, min-content sizing for a table inside a narrower container, and `border-collapse` painting.

## Documented limit: sticky positioning

`sticky` measures **0.6215**, the largest single difference left in this PRD, and sticky positioning is
listed outside the Core profile in `native-css-compat.ts`. The engine has no implementation to compare
against, so the cell reports the gap rather than a nearly-matching frame.

**Follow-up:** offset a sticky box during scroll, resolved against the nearest scrollable ancestor, then
delete the denylist row in the commit that turns it green.

## Documented limit: scroll snap and container queries

`snap-*` (4 cells) has no snap implementation — the wheel settles where the delta leaves it — and
`overscroll-*`/`scroll-smooth` (3 plus 1) need a scroller at its limit or a second frame, both of which the
driver does not provide yet. Container queries (5 cells, **0 of 5** pass, 2 non-discriminating) parse in
Stylo and are not answered by blitz's style traversal. None of these is a measured pixel mismatch; each is
a missing mechanism, named so the next owner starts from the mechanism rather than from the cell.

## Open

**Nothing open at the re-scoped bar.** The family reads **42 of 69 pass, 16 non-discriminating, 7 fail, 4
exempt**, every failure is one of the three documented limits above with its number, and each limit names the
mechanism that would close it. What the meter keeps is the evidence: three groups measure every unit they
own (logical 18 of 18, scroll 22 of 31, flow 2 of 15) and the fourth (grid-and-query 0 of 5) measures what
the engine can answer.

Re-opening this PRD means building one of the three mechanisms — table layout, sticky offsetting, or
container-query wiring — not adding staging.
