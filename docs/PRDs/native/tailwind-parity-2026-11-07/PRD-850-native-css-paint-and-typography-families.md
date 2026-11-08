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

## Decisions

**`fill`, `stroke` and `stroke-width` need a shape, and this crate has no SVG.** Staged on an
`<svg><rect>` probe the engine refuses the whole panel — 24 cells of the paint family come back as
`the engine refused this stage` — because `threenative-css-ui`'s element list creates no SVG nodes and
nothing paints them. Reverted: three paint cells stay "does nothing" because there is no shape to paint,
and the real fix is SVG element support, not a staging change.

**Gradient stops interpolate in sRGB here and in Oklab in every current browser.** Measured on
`bg-linear-60`: the two subjects differ at 0.9642 while the *class* does not discriminate at all — so
the cell is reporting an engine difference, not a staging one. Tailwind 4 emits
`linear-gradient(<angle> in oklab, …)` inside an `@supports` block, and Chromium takes that branch while
this engine ignores the interpolation method.

The fix is contained and named for the next run: `vendor/blitz-paint-0.3.0-beta.2/src/gradient.rs`
builds peniko stops from stylo's items and peniko interpolates in sRGB, so the stops for a gradient whose
method is explicit (`GradientFlags::HAS_DEFAULT_COLOR_INTERPOLATION_METHOD` **unset**) have to be
resampled in Oklab before they are pushed — insert k intermediate stops per pair, converting through
`AbsoluteColor::to_color_space(ColorSpace::Oklab)` and back. Not shipped this turn because stylo's
gradient variant keeps only that one flag and not *which* space was named, so an explicit `in srgb`
gradient would be mis-sampled; the honest order is to carry the method through stylo first, then
resample. Every gradient cell in the scene sits between 0.96 and 0.99 for the same reason.

## Decisions

**Seven misc cells needed a second item, one dimension, or something to transform.** `flex`, `gap-40`,
`shrink`, `self-end` and `justify-self-end` are decided against a *sibling*, so those cells now stage a
flex row with a trailing item; `aspect-square` was ignored because the staged probe sets both width and
height, so it states one; `origin-right` moves nothing until something transforms, so it stages a
`scale-50` companion. Measured: misc 144 → 146, and the whole scene 307 → **311 of 503**.

Two measured trade-offs, both taken deliberately:

- `.stage-border` keeps its dashed grey. Removing its colour lets a border-colour unit win the cascade
  as intended, but it costs the five border-*width*/style cells that the colour is what discriminates —
  five for one is the wrong way round.
- `basis` was dropped from the sibling staging: `flex-basis` needs a *constrained* flex line, and a row
  with one extra item is not one, so it lost the cell it used to pass.

Three type cells (`truncate` 0.9897, `wrap-anywhere` 0.9933, `break-words`) sit within a thousandth of
the 0.99 bar and pass in a type-only run but not in a full one: marginal, not regressions, and recorded
here rather than chased.

## Decisions

**A break or an ellipsis is measured with wide identical glyphs, not a dense word.** The earlier run was
a long word: `truncate` read 0.9747 and `wrap-anywhere` 0.9260, and the diff was spread across the whole
line — which is what this engine's glyph anti-aliasing does to *any* dense run (0.982 is its floor), not
a layout difference. `"WWWWWWWW…"` makes the break and the ellipsis a whole-glyph event: the two
renderers either agree on which glyph starts the next line or they do not. Measured: type 17 → **21 of
41**, `truncate` 0.9897, `wrap-anywhere` 0.9933, `break-all` 0.9933, and the scene 303 → **307 of 503**.

## Decisions

**The transition group needs a changing property, and staging it broke on a pointer.** `transition`,
`transition-none`, `transition-discrete`, `duration-*`, `delay-*` and `ease-*` (8 cells) all measure
"does nothing" because a static frame contains no change for a transition to interpolate. The staged
recipe — a `hover:bg-red-500` companion plus a pointer move onto the probe, sampled by the motion bar at
five points — does not run yet: the hover drive is intercepted by a sibling cell's `position: fixed`
probe (Playwright refuses after 60 s), and a positioned probe does not lift above it. Attempted and
reverted; `.stage-escape` now carries `pointer-events:none` so an overflow decoration can never eat a
drive's pointer again.

A second attempt — a `<button>` probe with a `focus:bg-red-500` companion and a Tab — was also reverted:
the engine's Tab and Chromium's both move focus to the *first* stop in the document, so a single Tab
reaches the first panel's control and never the cell's probe, and the engine has no focus-by-id command.
The staged companion did flip the colour (`ease-in` read 0.9596 that way), which is what proved the
driver can work and the addressing cannot.

**Solved, and it exposed a real engine difference.** The engine gained `CssUi::focus(id)` — a host
capability, not a test hook: a dialog's first field or a form activated from code needs it, and both
`tests/interaction.rs` cases prove it (`focus` moves to the named element and refuses one that is not
focusable; a programmatic focus *paints* `:focus`, which needed an explicit `dirty` flag because the
document's redraw request is not what restyles it).

With the driver in place, a second measurement defect surfaced: the pin that seeks the clock ran in its
own task *after* the drive, and a finished transition is dropped from `document.getAnimations()`, so
every sample of every transition cell showed the end state and read "does nothing". The pin now rides in
the same task as the focus, after a forced style flush. Measured effect: the group's five inert cells
became real measurements — `transition` 0.9198, `duration-initial` 0.9198, `delay-75` 0.8787, `ease-in`
0.9596, `ease-initial` 0.6511 — and non-discriminating cells across the scene fell 130 → 126.

The curve itself is correct; three crate tests now say so, each written from the CSS definition rather
than from this engine's output:

- `cubic-bezier(0.4,0,0.2,1)` at a third and two thirds of a 150 ms colour change gives `#81559f` and
  `#df4651`, which the engine produces within a channel of rounding;
- a var chain whose inner variable is unset — `var(--tw-ease, cubic-bezier(...))`, the shape Tailwind
  emits — resolves to the outer fallback and times identically to the literal curve;
- `@property`-registered `--tw-*` reading a `:root` theme variable (`var(--tw-duration,
  var(--default-transition-duration))`) resolves to 150 ms and times identically.

A fourth test copies Tailwind 4's `transition` utility **verbatim** — the long property list that names
two custom properties, the var chain for the timing function and the var chain for the duration — and it
animates correctly: mid-flight at 50 ms, arrived at 150 ms.

Yet the panel itself jumps. Measured on the engine's own frame of panel 18: at 50 ms and at 100 ms the
probe is already `#fb2c36` (Tailwind's `red-500`), while the browser is part-way along the same change;
the engine reports `focused_id = Some(33)` for the cell, so the focus is not the missing piece. The two
differences left between the test and the panel are that the panel's rules sit in `@layer theme` /
`base` / `utilities` blocks and that the probe is a `<button>` with the theme's `:root, :host` variables.
Bisected, and not it: the same declarations wrapped in `@layer theme` for the variables and
`@layer utilities` for the utility still animate correctly, so the panel's cascade layers are not the
cause. Neither is the `<button>` probe with Tailwind's preflight, nor the theme's `:root, :host` selector
list, nor the `@property` registrations — the test carries all four now and still animates.

**What it was: two focus cells sharing a panel.** The drive runs every cell's steps in sequence, so a
panel with two focus-driven cells focuses the second and *blurs* the first: the frame measured one cell
mid-revert and the other mid-transition. A cell whose drive contains a `focus` step now gets a panel of
its own. Measured: the misc group 130 → **131/182**, non-discriminating 126 → **124**, and
`ease-initial` went from 0.6511 to 0.9615 purely because it is no longer reading a neighbour's blur.

Every transition cell now reads the same shape: 1.0000 at rest, 0.94–0.98 at the two mid-flight samples,
1.0000 again from 150 ms on. A difference that exists only between the ends of a transition, and is the
same size for `linear` and for both `cubic-bezier` curves, is an **interpolation space** difference:
Tailwind 4's colours are `oklch()`, and CSS Color 4 interpolates `oklch()` values in **oklab**, while
this engine interpolates in sRGB. The two agree exactly at both ends and differ by a few units per
channel in between, which is the 0.96. **Fixed, and it took the group with it.** Stylo's generic `Animate for Color` hardcoded
`ColorInterpolationMethod::srgb()`, where CSS Color 4 names Oklab unless *both* ends are legacy sRGB
syntax — and Tailwind's palette is `oklch()`. Both absolute ends now use
`best_interpolation_between`, with sRGB kept for the non-absolute cases (`currentColor`, a colour
function, `color-mix`). Proven red-green: the new test fails on the previous code with exactly the sRGB
blend `[135, 74, 152]` and passes with the Oklab one `[153, 102, 164]`.

Measured: the transition group 131 → **137 of 182** — `transition` 0.9999, `duration-75` 0.9999,
`duration-initial` 0.9999, `delay-75` 0.9992, `ease-in` 0.9995, `ease-initial` 0.9999 — and the scene
290 → **295 of 503**. `transition-none` stays inert by design (`transition: none` has nothing to show)
and is the group's only remaining "does nothing".

So the remaining difference is in *when* each subject starts the clock, not in the curve or the chain:
at 0 ms and at every sample from 150 ms on, the two agree exactly, and only the two mid-flight samples
differ (50 ms 0.9711, 100 ms 0.9198). Next step: log both arms' computed colour at 50 ms for this cell
— the browser's transition `startTime` against the engine's clock — before changing anything else.

Those numbers are now a real engine gap rather than a staging one: the engine's transition interpolation
departs from Chromium's part-way through a 150 ms `background-color` change, with the size of the
departure tracking the timing curve (a `linear` curve agreeing, both `cubic-bezier` curves not), which is
what a wrong easing solve looks like. Next step: compare the engine's bezier solve against Chromium's at
the sampled instants for one cell.

The motion clock now samples 0, 50, 100, 150, 250, 500, 750 and 1000 ms instead of 0, 250, 500, 750 and
1000: a Tailwind transition is 0–200 ms (the default is 150), so the old grid could not see a duration, a
delay or an easing change at all. Measured, that changes no verdict today — the transition group still
has no driver — and `animate-ping` reads 0.9917 rather than a bare 1.0000, i.e. the fine samples see a
difference in the first 150 ms that the coarse grid could not.

## Decisions

**Seven misc cells were staged so that nothing could move.** A margin on the *end* side (bottom, right,
inline-end, block-end) moves the *next* box, not this one, so `mb-40`, `mbe-40`, `mr-40` and `me-40`
read "does nothing" with the probe alone in its stage; an inline-direction margin also needs something
sharing its line. `order-*` needs a second item to be ordered against, `z-index` two overlapping boxes
and a positioned probe of its own — with `relative` only in the contrast, *neither* arm ordered anything
and the cell read "does nothing" for that reason alone. `outline-offset-*` needs a line to offset.

Each cell now stages what its declaration moves: a trailing sibling (`.stage-trail`, inline-block for the
inline axis, overlapping with a `z-index` of its own for the stacking units), `relative` as a companion
for `z-*`, and an outline for `outline-offset-*`. Measured: the misc group 137 → **144 of 182**, the
scene 295 → **303 of 503 (60.2 %)**, non-discriminating 124 → 117.

## Decisions

**A text-dominated cell cannot discriminate at a 0.99 vacuity bar, and larger type does not help.**
Measured: this engine's glyph anti-aliasing against Chromium's is already about 0.982 in a small run, so
dropping a declaration that moves glyphs by a pixel leaves the region *at* 0.98 and the cell reads "does
nothing" — which is what `ordinal`, `slashed-zero`, `tabular-nums`, `proportional-nums` and `normal-nums`
all do, whatever run they are given. Staging `text-2xl` made it worse, not better: the noise scales with
glyph area, so the signal-to-noise ratio is unchanged and the family fell 16 → 15 of 41. Reverted.

Two things were learned that a later pass can use:

- the run each variant needs is a *full digit set with ordinals* (`0 1 2 3 … 1st 2nd 3rd`), but the
  generic run discriminates `oldstyle` and the digit run does not, so the two are mutually exclusive
  until a single run satisfies both;
- a long unbreakable run (`truncate`, `wrap-anywhere`) turns both cells into *real* measurements —
  0.9747 and 0.9264 — i.e. an engine difference in where the ellipsis falls and where a long word
  breaks. That is a gap to investigate, not a staging defect, and it was reverted with the rest because
  it costs `oldstyle` and neither cell passes yet.

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
- **Faux italic is applied, so `italic`'s 0.790 is a *degree*, not a missing feature.** The corpus
  ships Noto Sans Regular and Bold only, so CSS `italic` asks for a synthetic oblique: fontique reports
  a skew, blitz passes it as a glyph transform and the painter applies it.
  `tests/interaction.rs::an_italic_run_is_slanted_when_the_family_has_no_italic_face` proves the run
  is slanted; what differs from Chromium is therefore the angle (fontique suggests 14°, Skia's faux
  oblique is `tan = 0.25`) or how the slant composes with the line box. Recorded with that split so the
  next attempt measures the angle rather than re-testing whether italic works.
- **`bg-top`, `bg-repeat` and `bg-origin-border` all measure exactly 0.2243: a tiling *phase* (open).**
  One cause, not three — all three units move a repeating gradient image, none changes its stops. The
  contrast that stages these cells is `repeating-linear-gradient(45deg, …)` at `background-size: 24px
  24px`, so a fraction of a tile is worth 1.0 of SSIM on a high-frequency pattern. Measured along the
  same row inside the probe, the stripe transitions are `8, 12, 20, 29, 32, 36, 44, 53` in Chromium and
  `10, 18, 26, 32, 34, 42, 50, 56` here — a phase difference, not a missing image.
  Both sides tile at **24 px** and both show two transitions per tile — so the size and the repeat are
  right. Measured at the scene's exact geometry (120×40, `box-sizing: border-box`, 2 px padding) the
  engine's transitions inside the probe are `3, 11, 20, 24, 27, 35, 44, 48, 51, 59`, a 24 px tile with
  transitions at +3 and +11; Chromium's from the same row are `8, 12, 20, 29, 32, 36, 44, 53`, the same
  shape at +4 and +12 from a tile origin five pixels later. That is a **5 px origin offset**, not a
  scale or a repeat difference, and `background-origin`'s default (`padding-box`), its mapping and
  `box_rect` were all read and are correct — so the offset is in how the gradient's *tile rectangle* is
  derived from the origin box (the padding box is 116×36 here).
  A negative result narrows it further: a `TN_BG_DEBUG` print inside `draw_gradient_layer` **never
  fires** for that panel, so the stripes in the engine's own frame do not come from the gradient layer
  path at all. The next attempt starts by finding which path paints them (the cell's contrast rule is
  `:where(.c3) .probe{background-image: repeating-linear-gradient(…)}`, and something resolves it
  elsewhere — a raster image layer, or a background on a different box), rather than by adjusting the
  tile rect.
- **A box shadow's blur is already Chromium's, and a spec-based "fix" broke a reference frame.**
  CSS defines the blur radius as twice the standard deviation, so the outset path was changed to pass
  `blur * 0.5`. The parity scene's `shadow-red-50` cell improved (0.9661 → 0.9756) — and the crate's
  own Chrome-derived `matches_the_chrome_reference_frame` started failing, because that fixture's
  panel shadow was tuned against Chrome with the value as-is. The change was reverted: a test that
  reproduces Chrome by construction outranks a spec reading that improves one cell by 0.01 and breaks
  another frame. What is left on `shadow-red-50` (0.9661) and `inset-shadow-red-50` (0.9809) is
  therefore something else — Tailwind stacks *two* shadow layers, so the second layer's interaction is
  the place to look, not the kernel.
- **A decoration no longer runs through the white space a line ends with.** The range came from the
  glyph run's advance, which includes that space: the engine's underline was 103 px where Chromium's is
  93. Trimming it took `underline`, `decoration-2` and `decoration-red-50` from 0.977 to **0.982** and
  the `type` family from 13/41 to **17/41**.
- **Two decoration defects left, measured row by row.** `underline-offset-8` puts the line on row
  60 where Chromium puts it on 59 (the auto position matches to the row, so the difference is how an
  explicit offset is rounded: this crate rounds the line's top, Chromium's rasteriser does not).
  `decoration-wavy` improved from 0.8472 to **0.9067** in three measured steps: the wavelength is
  Chromium's six pixels (was four), the centreline is `y + 2.5 * size` (the squiggle sat 2.5 px high)
  and the amplitude `1.5 * size`. Chromium's lit rows are 47..50 and the engine's now match them; what
  remains under the 0.98 bar is the wave's *phase* and the stroke's shape. Both cells are single
  functions in `text.rs`, not staging questions.
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
