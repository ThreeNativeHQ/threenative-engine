# PRD-850 — native-css proves every unrefused Tailwind paint and typography utility

**Status:** NOT STARTED
**Priority:** P2 — AC-1 to AC-3 cover about 200 properties that build today but have no proof, so a kit can ship one that paints wrong with no warning.
**Complexity:** 6 (MEDIUM) — 6 to 10 files (+2), Rust crate plus host (+2), inline SVG (+2).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

The scanner refuses a short list. Everything else builds, but the guide says "absent is not
supported". The exploration found 200 emitted properties that no fixture proves. They group as:

| Group | Utilities |
| --- | --- |
| Backgrounds | `bg-radial-*`, `bg-conic-*`, gradient stops and `in oklab/oklch` interpolation, `bg-clip-text`, `bg-size`, `bg-repeat-*`, `bg-fixed/local/scroll`, `bg-origin-*`, `bg-position`, `bg-[url()]` |
| Borders and effects | `border-dashed/dotted/double`, `divide-*`, `space-*`, `ring-*`, `inset-ring-*`, `inset-shadow-*`, `outline-dashed/dotted/double`, `text-shadow-*`, colour `/opacity` modifiers (`color-mix()`) |
| Transforms | individual `scale-*`, `rotate-*`, `translate-*`, `skew-*`, `origin-*` |
| Typography | `text-decoration-*`, `underline-offset-*`, `decoration-*`, `italic`, `font-stretch-*`, `font-variant-numeric` (`tabular-nums` and others), `antialiased`, `hyphens-*`, `indent-*`, `text-wrap` balance and pretty, `wrap-anywhere`, `break-*` word, `tab-size`, `uppercase` and other cases, `list-*` (type, position, image) |
| Misc | `fill-*`, `stroke-*` on inline `<svg>`, `cursor-*` (host cursor), `scrollbar` colour, width and gutter, `visibility`, `zoom`, `scheme-*`, `will-change-*`, `contain-*`, `pointer-events` (variants) |

Inline `<svg>` is not in the guide's element list. `fill` and `stroke` need it.

## Solution

Run the meter per group and fix what fails. Expected engine work:

- radial and conic gradients: blitz-paint `gradient.rs` has both, so verify;
- `bg-clip-text`: glyphs as the clip path;
- text shadow: a blur layer under the glyph run;
- decoration styles;
- inline SVG through blitz's SVG path (resvg), if it is in the closure; if it is not, add it as the
  one new dependency and record its licence in `docs/verification/native-css-license-inventory.md`;
- the host cursor: the `css-ui` hit test reports the computed `cursor`, and the desktop host sets the
  SDL cursor.

## Acceptance Criteria

- [ ] AC-1 [local]: every background and border-effect unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-850 --group paint` plus `--host`, and the judge on `--sheet PRD-850` — Evidence: pending.
- [ ] AC-2 [local]: every transform and typography unit passes, and the judge returns SAME. proof: `--group type` — Evidence: pending.
- [ ] AC-3 [local]: every misc unit passes, inline SVG `fill`/`stroke` included, and the host shows the computed cursor over a `cursor-pointer` element. proof: `--group misc`, plus a desktop playtest that reads the host cursor state — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Paint and type utilities on native | game Tailwind class → `css-ui` paint and text | Proven in the guide; nothing removed | AC-1, AC-2 |
| Inline SVG and cursor | game `<svg>` / `cursor-*` → `css-ui` → desktop host SDL cursor | New | AC-3 |

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-850`: **143 of
262 units pass** (misc 120/182, paint 10/39, type 13/41).

- **The container staging rule earned 12 units** (`misc` 99 → 111): a unit whose emitted properties
  are container properties (`justify-content`, `justify-items`, `align-items`, `align-content`, the
  gaps, the grid track and auto properties, `flex-direction`, `flex-wrap`) stages the probe *as* that
  container, with two children and the matching display. Before it, twelve units were inert by
  construction: `justify-end` on a plain block asks a box with nothing to lay out.
- **Colour-only border units earned 5 more**: those probes now carry a dashed 2px border in a grey
  the unit must beat (`border-e-red-50` emits `border-inline-end-color` and nothing else), and the
  six single-side border colours pass at 0.9961-0.9973. `border-red-50` (all four sides at once)
  still does not discriminate.
- **What the rest of the group needs, in short-list order.** `touch-*` (4) and `overflow-clip` (3) change nothing a single frame can see
  (`touch-action` is an input policy, and a clipped overflow needs content to clip); `space-*` and
  `divide-*` (4) put the unit on the *parent*, which the staging does for `divide-x` only; `object-*`
  (2) need an `<img>`; `transform`/`transform-fill` (2) need a transform to change; `mb-40`/`mr-40`/
  `me-40`/`mbe-40` need a following sibling in block flow; `aspect-square` needs the probe's height
  to stop being fixed by the staging; `z-40` needs stacked siblings.
- **`bg-top`, `bg-repeat` and `bg-origin-border` all measure exactly 0.2243: a tiling *phase* (open).**
  One cause, not three — all three units move a repeating gradient image, none changes its stops. The
  contrast that stages these cells is `repeating-linear-gradient(45deg, …)` at `background-size: 24px
  24px`, so a fraction of a tile is worth 1.0 of SSIM on a high-frequency pattern. Measured along the
  same row inside the probe, the stripe transitions are `8, 12, 20, 29, 32, 36, 44, 53` in Chromium and
  `10, 18, 26, 32, 34, 42, 50, 56` here — a phase difference, not a missing image.
  `tests/interaction.rs::a_gradient_background_takes_its_position` already pins the two things that
  *are* right (a repeating gradient moves with `background-position`, and `top` resolves to
  `center top`), so what is left is the tiling origin itself: the next attempt should compare
  `background-size: 24px 24px` against `auto` for one cell.
- **A box shadow's blur is already Chromium's, and a spec-based "fix" broke a reference frame.**
  CSS defines the blur radius as twice the standard deviation, so the outset path was changed to pass
  `blur * 0.5`. The parity scene's `shadow-red-50` cell improved (0.9661 → 0.9756) — and the crate's
  own Chrome-derived `matches_the_chrome_reference_frame` started failing, because that fixture's
  panel shadow was tuned against Chrome with the value as-is. The change was reverted: a test that
  reproduces Chrome by construction outranks a spec reading that improves one cell by 0.01 and breaks
  another frame. What is left on `shadow-red-50` (0.9661) and `inset-shadow-red-50` (0.9809) is
  therefore something else — Tailwind stacks *two* shadow layers, so the second layer's interaction is
  the place to look, not the kernel.
- **Two decoration defects left, measured row by row.** `underline-offset-8` puts the line on row
  60 where Chromium puts it on 59 (the auto position matches to the row, so the difference is how an
  explicit offset is rounded: this crate rounds the line's top, Chromium's rasteriser does not).
  `decoration-wavy` is worse (0.8472): Chromium spreads the wave over three rows at ~70 px each, this
  crate paints one 111 px row, so the amplitude/period constants in `draw_decoration_line` are not
  Chromium's. Both are single functions in `text.rs` and neither is a staging question.
- **The 0.9593 text cells are glyph anti-aliasing, not line breaking (measured).** `break-normal`,
  `text-wrap`, `hyphens-manual` and `wrap-anywhere` all score exactly 0.9593; the two frames for that
  cell put side by side are visually identical, same breaks in the same places ("Lorem ipsum / dolor
  sit amet / consectetur"), and the difference is the glyph edges — white text on a saturated blue
  probe, where FreeType and vello_cpu disagree most. The corpus's own text fixtures score 0.988 on
  the same pair of rasterisers; the parity scene's high-contrast text is simply denser. That is a bar
  question rather than an engine one and the bar is not relaxed here: these cells stay red and are
  recorded as such.

- **Text decoration is now measured rather than vacuous, and it is a real paint gap.** Giving the
  decoration-only units an `underline` companion turned four cells from "does nothing" into 0.8431
  (`underline-offset-8`), 0.9144 (`decoration-2`), 0.96 (`decoration-red-50`) and 0.8597
  (`decoration-wavy`): the engine paints the line, its thickness, its style and its offset
  differently from Chromium. `list-style-*` units now stage the probe as the `<li>` (and the list
  carries no marker of its own), so `list-disc` passes and `list-inside` measures 0.6762 — the
  engine's marker placement.
- **`paint` (10/39) and `type` (13/41) are mostly real engine gaps**, not staging: `bg-clip-text`
  0.41, `bg-repeat`/`bg-origin-border`/`bg-fixed` 0.22, `bg-top` 0.22, `text-shadow-*`, and the
  `contain-*`/`will-change`/`color-scheme`/`scrollbar-*` family, which needs a painted consumer
  before it can discriminate at all.

- **Four `type` cells cannot discriminate with this font, and one pair cannot on Linux.** `tabular-nums`,
  `proportional-nums`, `normal-nums`, `ordinal`, `slashed-zero` and `font-stretch-50%` need a font whose
  digits or width axis differ between the values: Noto Sans' digits are tabular already and its static
  faces carry no width axis, so the frame is identical either way. `antialiased`/`subpixel-antialiased`
  set `-webkit-font-smoothing`, which Chromium ignores on Linux. These are properties of the *corpus
  font and platform*, not staging gaps: proving them needs a font with `zero`/`ord` features and a
  variable width axis, which is a corpus change, not a scene one. `whitespace-pre` was the one in that
  group that was a staging fault — its probe text had single spaces and its contrast was `nowrap`, which
  preserves a run exactly as `pre` does — and it passes now.

## Execution Phases

#### Phase 1: Backgrounds and effects
**Status:** NOT STARTED
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/{gradient.rs,render/background.rs,render/border.rs,text.rs}`, `vendor/PATCHES.md`.

- [ ] Background and border-effect units pass. proof: AC-1

#### Phase 2: Transforms and typography
**Status:** NOT STARTED
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/text.rs`, `vendor/parley-0.11.1`, `vendor/PATCHES.md`.

- [ ] Transform and typography units pass. proof: AC-2

#### Phase 3: SVG, cursor and the rest
**Status:** NOT STARTED
**Files:** `native/css-ui/Cargo.toml` (SVG feature), `native/css-ui/src/abi.rs` (cursor), the desktop host UI overlay seam, the guide, the floor.

- [ ] Misc units pass, and the floor rises. proof: AC-3 plus `parity:tailwind --ratchet`
