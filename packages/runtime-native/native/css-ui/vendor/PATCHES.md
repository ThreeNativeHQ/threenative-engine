# Vendored patches

Six upstream crates are vendored here and wired with `[patch.crates-io]` in this crate's
`Cargo.toml`. Each is a pinned version copied from the crates.io registry source unchanged apart
from the hunks below; `LICENSE-MIT` / `LICENSE-APACHE` are the upstream licences, which the
published `.crate` archives omit.

A crate is vendored only where the defect is inside a dependency this crate does not own and no
public API of it reaches the behaviour: four of taffy's percentage-padding call sites resolve the
block axis against the container's height, and fontique resolves a family name through a map of
*installed* families, so a document naming `Arial` gets nothing at all. Both are reachable only by
carrying the crate.

Every hunk is here because a measurement proves the behaviour it fixes — almost always a fixture in
the browser oracle in `examples/native-css-hud/corpus`, which each hunk names — and each is kept to
a single property so that dropping a patch is a one-line change in `Cargo.toml`. The exception is
the one the browser cannot see, blitz-dom hunk 4, a retained record that only shows up in
`bench mount`'s resident set and in the crate's own release build.

Run `cd examples/native-css-hud && node corpus/oracle.mjs` for the measurements quoted below, and
`node corpus/interaction.mjs` for the interaction scenarios (hunks 8-12), which is the oracle an
interaction hunk is proved against.

Each crate heading counts added lines against the crates.io source of the same version, comments,
blank lines and the licence files excluded:
`diff -ru -x Cargo.lock -x .cargo-ok -x 'LICENSE*' ~/.cargo/registry/src/*/<crate> vendor/<crate>`,
counting the `+` lines that are neither blank nor a comment.

Four hunks are over the ~80-line guideline: parley hunk 1 below, blitz-dom hunk 11, and the two
halves of the inline box decoration (blitz-dom hunk 14, blitz-paint hunk 3). Hunk 11 is
the hit-test clip, and the overage is the rounded-rectangle test (~20 of those lines): a
`border-radius` may round a corner to an ellipse, so one point needs both radii to be answered, and
answering it in the shared walk is what keeps a click in a clipped-away corner from being one hit
per ancestor. The separable part is the `clip` argument on `hit_inner`; dropping it leaves the
radius half working for the element's own box only. Parley hunk 1 is ~130 lines, 49 of them
`strut_metrics` — a strut needs its own font query, which the shaper's does not expose — and 24 the
shared `leading_box` helper that replaced two copies of the same half-leading arithmetic; four
fixtures now depend on it (`box-model-and-sizing`, `inline-runs`, `text-line-height-normal`,
`dpr-2-layout-and-paint`), and its three separable parts each fail one of them on their own.
Blitz-dom hunk 14 is ~164 lines, of which ~50 are `Node::inline_decoration` (twelve sides resolved
from Stylo, because a span is never a Taffy node and so has no Taffy style to read) and ~35 are the
old `inline_fragment_rects` loop moved into `inline_fragments` so paint can share it; blitz-paint
hunk 3 is ~94, almost all of it `draw_inline_decorations`, and deletes the 40-line
`draw_inline_backgrounds` it replaces.

## `blitz-paint-0.3.0-beta.2` — 352 added code lines

### 1. `outline-offset` was ignored: the outline was drawn inside the border box

* **Where:** `src/kurbo_css/css_box.rs` (`CssBox::new`, `CssBox::outline`, `CssBox::corner`,
  `CssBox::is_sharp`, `CssBox::ellipse`), `src/kurbo_css/mod.rs` (a new
  `CssBoxKind::OutlineInnerBox`), `src/render.rs` (`create_css_rect` reads
  `style.get_outline().outline_offset`).
* **Why:** the outline ring ran from `border_box.inset(outline_width)` (kurbo's `inset` grows for a
  positive amount) to the border box, so `outline-offset: 3px` left the ring touching the box. CSS
  UI 4 §4.2 puts the ring `outline-offset` away from the border edge and `outline-width` thick
  outwards from there. The inner edge is a new box kind because the ring can no longer start at the
  border box, and its corner radii grow by the offset.
* **Proves it:** `paint-radius-border-shadow` — the white outline now sits 3px off the blue box
  (SSIM 0.9425 → 0.9996, fixture passes). `outline-offset` 0, 3 and 6 on a bare 100×60 box are each
  pixel-identical to Chromium.

### 2. an inline layout's cut line was not the line that got painted

* **Where:** `src/render.rs` (`draw_inline_layout`: one `painted` binding, and the three text passes
  that read it).
* **Why:** `text-overflow: ellipsis` is laid out as its own inline layout alongside the whole line
  (blitz-dom hunk 7), and paint drew the whole line — the ellipsis was laid out and thrown away.
  Nothing else in this crate reads it: the element's box, hit testing and selection all still use
  the uncut line, which is what keeps a resize honest.
* **Proves it:** `text-ellipsis` — SSIM 0.9603 → 0.9947, fixture passes on the strict 0.99 bar.

### 3. a non-atomic inline painted a text-width background and no border at all

* **Where:** `src/render.rs` (the new `ElementCx::draw_inline_decorations`, called from
  `draw_inline_layout`), `src/text.rs` (`draw_inline_backgrounds` deleted).
* **Why:** an inline element's background was one rectangle per glyph run, the run's own font box
  and nothing else: no padding, no border, no `border-radius`, and an inline nested in another left
  a hole in its parent's background. Each inline element in the layout is now painted per line
  fragment (blitz-dom hunk 14's `inline_fragments`) through the same `ElementCx` a block box uses —
  `create_css_rect`, `draw_background`, `draw_border` — on a `taffy::Layout` built for the fragment.
  The sides are `box-decoration-break: slice`, Chromium's default: only the first fragment carries
  the start side's border, padding and corner radii, only the last the end side's (swapped for
  `direction: rtl`). Outermost elements paint first. An element with no background and no border
  costs one style read. Box shadows and outlines of inlines are still not painted.
* **Proves it:** `inline-margins` (SSIM 0.9532 → 0.9964), `inline-borders-radius` (0.9892: a
  different colour per border side and a pill radius) and `inline-margins-wrap` (0.9806: a rounded,
  bordered span sliced across two lines), plus
  `tests/inline_box.rs::an_inline_paints_its_border_and_its_padding_box`, which fails against the
  previous vendor sources.
### 4. a multi-layer mask painted nothing: an identity layer took the composite

* **Where:** `src/render/mask.rs` (`draw_css_mask`, plus `is_uniform_opaque`).
* **Why:** Tailwind 4's `mask-image` names six layers, five of which are the registered initial value
  `linear-gradient(#fff, #fff)`. Two things broke this: a layer pushed with `SrcIn`/`DestIn` *inside* the
  mask's own `DestIn` layer erases the whole mask (measured: `SrcIn` hides everything, `SrcOver` shows
  everything), and the bottom-most-layer test used the *list index* rather than the first layer actually
  drawn, so skipping an identity layer left the one real layer composited `SrcIn` against an empty mask.
  Identity layers (one opaque colour repeated) are now skipped — intersecting with an opaque mask is the
  identity — and the first layer drawn is the one that composites `SrcOver`.
* **Proves it:** `a_tailwind_three_layer_mask_composition_paints` (a six-layer intersected composition
  fades across the box) and `a_mask_gradient_whose_stops_come_from_registered_variables_paints`, both of
  which failed before this hunk. `parity:tailwind --family PRD-845 --group mask` now measures every cell
  instead of reporting "does nothing" for ten of them.
### 5. `mask-mode: luminance` weighted linear-light values, and Chromium weights the stored sRGB ones

* **Where:** `src/gradient.rs` (`apply_luminance_alpha`).
* **Why:** CSS Masking describes a linear-light `luminance()`, and hunk 5's first version followed it — the
  earlier note in this file even said so. Measured against Chromium on the parity scene, that is wrong for a
  CSS gradient in this build. The difference only shows on a gradient whose stops are *resampled* (Tailwind
  writes `in oklab`, which this crate now resamples): with two stops both readings reduce to the same linear
  alpha ramp between the endpoint colours, but with intermediate stops the per-stop luminance decides the
  curve. With linear-light weights the six `mask-{linear,conic,radial}-{from,to}-red-50` cells scored
  0.8145–0.8928 against the 0.99 bar; with the weights applied to the stored sRGB components all eighteen
  `-red-50` cells pass at 0.994–0.996 and the mask group goes **23 → 29 of 50** with no cell lost.
* **Proves it:** `a_luminance_mask_weights_the_srgb_components` (the midpoint of a
  `linear-gradient(to right in oklab, #fef2f2, #000)` mask reads blue 104 with the sRGB weights and 50 with
  the linear-light ones, so the test fails against the previous source), and
  `parity:tailwind --family PRD-845 --group mask`.


## `blitz-dom-0.3.0-beta.2` — 760 added code lines

### 1. hoisted (`z-index`) children were painted one frame late, at the wrong offset

* **Where:** `src/layout/damage.rs` (`flush_styles_to_layout_impl`, plus the new
  `resolve_hoisted_paint_positions{,_impl}`), `src/resolve.rs` (one call after `resolve_layout`).
* **Why:** `flush_styles_to_layout` runs *before* layout and folded each node's
  `final_layout().location` into the hoisted children's paint offsets while the tree was being
  built. Those locations are the previous frame's, and all zero on the first frame, so a
  `position: absolute; z-index: 1` box was painted at its containing block's origin instead of
  where it laid out — the cyan square in `positioning` was 10px (the margined parent's offset) off.
  The same staleness fed `HoistedPaintChildren::content_area`, which hit testing reads, so that is
  recomputed here too.
* **Proves it:** `positioning` — SSIM 0.9603 → 1.0, fixture passes. Every box in it already matched
  within 1px, which is what made this a paint-only bug.

### 2. a non-atomic inline's box was its line box instead of its font box

* **Where:** `src/document.rs` (`inline_fragment_rects`).
* **Why:** the fragment rect of an inline element used the line box's block extent (the
  leading-included extent text selection highlights use), so `getClientRects()` reported every
  inline as tall as its line. Browsers report the font box: the run's ascent and descent either
  side of the line's baseline.
* **Proves it:** `ua-defaults` — five inline elements (`a`, `strong`, `em`, `b`, `i`) go from
  1.06px tall on the bottom edge to within 1px, and the fixture passes.

### 3. an atomic inline had no baseline of its own

* **Where:** `src/layout/inline.rs` (the inline-box sizing loop), `src/layout/construct.rs` (two
  `InlineBox` literals).
* **Why:** `parley::InlineBox` had no baseline, so parley aligned every atomic inline by its bottom
  margin edge. That is only right for a box with no in-flow line boxes (CSS 2.1 §10.8.1); an
  `inline-block` or `inline-flex` with text aligns on its content's baseline. Without this, patch 1
  below makes every line holding a button 6px too tall — visible as a regression in this crate's own
  Chrome-derived reference frame. The sizing loop therefore asks for a *perform-layout* pass (the
  child's baseline is not reported by a measure-only pass) and stores it, measured from the margin
  box top like the box's height.
* **Proves it:** `cargo test --release` (34 tests, including `matches_the_chrome_reference_frame`,
  which compares against a frame Chrome produced) plus the `positioning` and `box-model-and-sizing`
  fixtures.

### 4. every node ever created was recorded, and freed

* **Where:** `src/document.rs` (`remove_node_from_tree`, plus the new `BaseDocument::node_count`).
* **Why:** `create_node` records each new node in `changed_nodes` for the accessibility tree, and
  nothing ever drained that record: the only reader is `has_changes()`, which no caller has and
  whose sense is inverted. So the set grew by one entry per node the document had ever built, for
  as long as it lived. A HUD mounts and disposes panels, so this is the normal path, not an edge
  one: `bench mount` reported 58 → 77 → 114 MB of resident set over 3,200 build-then-remove cycles
  of a 1,000-element HUD, and a `HashSet<NodeId>` of 6.08M entries accounts for the climb. The set
  describes the nodes that changed *and are still live*, so freeing the node frees its record, and
  `remove_node_from_tree` is the one place every removal (a dropped subtree, a deallocated anonymous
  block) funnels through.
* **Proves it:** `cargo test --release` —
  `mounting_and_disposing_repeatedly_releases_every_node` runs 600 mount/dispose cycles and fails
  on the released heap (4.7 MB retained, against a 256 KB budget for a neighbouring test's frame
  buffer). `bench mount` over 3,200 cycles of a 1,000-element HUD now reports 33 → 36 → 33 → 33 MB
  at the quarters where it used to report 58 → 77 → 114 → 114, and `bench resheet` 30 → 37 → 30 →
  30 MB against 58 → 77 → 114 → 114: flat inside allocator noise, where it climbed before.

### 5. `<button>`'s user-agent sheet claimed a centring Chromium does not do

* **Where:** `assets/default.css` (the `button` / `input[type=…]` rule).
* **Why:** the sheet is Gecko's, and Gecko emulates the button box with `display: inline-flex;
  align-items: center; justify-content: center`. Chromium's own sheet is `display: inline-block;
  text-align: center; align-items: flex-start` — it centres the content in its *own* box rather than
  as a flex item. The two agree for a button with no author `display`, and disagree for an author
  `display: flex`: with Gecko's values the label is centred, with Chromium's it is flush to the
  content box's top-start, which is what a fixed-height `display: flex` button looks like there.
* **Proves it:** `button-centring` — the author-`display: flex` button's label lands where
  Chromium's does, and the inline-block button's is centred (SSIM 0.9968, fixture passes). Dropping
  the alignment hunk below puts that label 5px high and the fixture at 0.9769.

### 6. a `<button>`'s content was top-aligned in its content box

* **Where:** `src/layout/inline.rs` (the new centre-the-content step after the line boxes are
  aligned, and its `shift_lines` call), with `Layout::shift_lines` in the parley hunk below.
* **Why:** a button's box is not its content box — Blink's `LayoutNGButton` and Gecko's
  `-moz-button-content` both centre the content in it — so a fixed-height button's label sat
  ~5px high in every fixed-height button this crate laid out. Only a flow-rooted inside display is
  that button box: `display: flex`/`grid` is the author's own layout, where the user-agent sheet's
  `align-items` governs instead (hunk 5), so the two halves are kept apart. The content's own
  height is the only height known where this can be applied, so what it centres is the line boxes:
  a button whose content is a block box stays top-aligned, which is the one case this hunk does not
  cover and no fixture measures.
* **Proves it:** `state-selectors-and-environment` — its three `display: block` buttons' labels move
  from 5px high to centred (SSIM 0.9650 → 0.9952, fixture passes), and `button-centring` covers
  `inline-block` and `flex` in the same frame. `cargo test --release` (35 tests, including
  `matches_the_chrome_reference_frame`) plus every other fixture stay green.

### 7. `text-overflow: ellipsis` painted nothing

* **Where:** `src/layout/inline.rs` (the new `ellipsize_inline_layout`, called once the line boxes
  are aligned), `src/node/text.rs` (`TextLayout::ellipsized`), with the paint half in blitz-paint
  below.
* **Why:** neither Stylo nor parley nor blitz implements `text-overflow`, so an overflowing
  `white-space: nowrap` line was simply clipped at the content box, and Chromium's U+2026 was
  missing from the frame. Cutting the line is not something a shaped layout can do: a `nowrap` line
  is never broken, so narrowing the break advance moves nothing, and parley cannot drop trailing
  clusters. So the prefix that still fits — the last whole cluster whose advance, plus the
  ellipsis's own, stays inside the content box — is re-shaped with a U+2026 appended and kept as
  `TextLayout::ellipsized`. It is a second layout rather than a replacement on purpose: `layout`
  still holds every cluster of the line, so the element's own box is measured from the uncut text
  and a wider content box breaks the whole line again instead of staying stuck short. Only the
  single-line case is modelled (`text-overflow: <string>` and a multi-line ellipsis are not), the
  cut is by logical cluster so a right-to-left line is cut at its start, and the ellipsis takes the
  inline root's font rather than the run's.
* **Proves it:** `text-ellipsis` — SSIM 0.9603 → 0.9947, fixture passes on the strict 0.99 bar, and
  `text-overflow-fits` proves the other half, that a line which fits comes out exactly as it would
  with no `text-overflow` at all (forcing the ellipsis on a fitting line drops it to 0.9786).

### 8. `:focus-visible` never matched, and a pointer focus could not be told from a keyboard one

* **Where:** `src/stylo.rs` (`NonTSPseudoClass::FocusVisible`), `src/document.rs` (the new
  `set_focus_visible`, with `set_focus_to` delegating to it), `src/node/node.rs` (`Node::focus`
  takes the focus-visible flag).
* **Why:** `:focus-visible` was hard-coded to `false`, so a control focused by Tab looked the
  same as one never focused — a keyboard HUD gave no feedback at all. Matching it needs a state bit
  to read, and `ElementState::FOCUSRING` was already set on *every* focus, so there was no way to
  keep a pointer focus (a click on a button) from raising the ring. `focus_visible` is the flag
  that separates them, and it is a per-call argument rather than a document setting because the
  caller is the only one that knows which kind of focus caused the change.
* **Proves it:** `focus-traversal-and-activation` — the pixel after two Tabs is `#f59e0b`, the
  `:focus-visible` colour, and the pixel after a mouse click on the same button is its own
  `#334155`; `tests/interaction.rs::a_pointer_focus_is_not_a_focus_visible_one`. Reverting the
  `stylo.rs` line alone fails the scenario and the test.

### 9. the device could not say it was driven by touch

* **Where:** `src/document.rs` (`make_device` takes a `touch` flag, the new `set_touch`, and the
  `touch` field), `src/mutator.rs` (one argument at the `ViewportMut` drop).
* **Why:** `make_device` passed `PointerCapabilities::default()`, which is a mouse with hover on
  every non-mobile target, so `@media (hover: hover)` and `(pointer: coarse)` could not be
  answered at all. A touch-only device is `(hover: none) (pointer: coarse)`, which is what makes
  Tailwind's `@media (hover:hover){.hover\:bg-…:hover{…}}` — the wrapper Tailwind puts around
  every `hover:` class — not apply on a phone. The flag is a plain `bool` rather than the stylo
  `PointerCapabilities` bitflags so that no caller has to name a stylo type to reach it.
* **Proves it:** `touch-hover-and-environment` (a tap leaves `.h` its own colour under
  `(hover:hover)`, and `tests/interaction.rs::a_mouse_hovers_and_a_finger_does_not`), plus
  `a_tap_leaves_no_hover_behind`.

### 10. a wheel delta that a scroller could not fully take was handed to its parent

* **Where:** `src/scrolling.rs` (the new `scroll_wheel`).
* **Why:** `scroll_chain_by` transfers whatever the first scroller could not consume to its parent
  within the same event, which is right for a fling and wrong for a wheel tick: a browser latches
  the tick to one scroller. Over a list that could take 90px of a 300px tick, the browser scrolled
  the list by 90 and stopped, while this scrolled the list by 90 and the page by 210. It also
  walked the whole ancestor chain for a *programmatic* scroll, which is not a user scroll at all.
  `scroll_wheel` takes the nearest scroller that can move in the requested direction — one with
  room left takes the whole delta and keeps the rest, one at its limit passes the event on — and
  never reaches the viewport, because this document has no page to scroll.
* **Proves it:** `nested-scroll` — three wheels of 50, 300 and 300px land at `[0,50]`, `[0,140]`
  (outer still 0) and `[0,300]`, and `tests/interaction.rs`'s three wheel tests.

### 11. hit testing ignored the overflow clip, the border radius, and `pointer-events` on the element itself

* **Where:** `src/node/node.rs` (the new `Clip` and `Node::clip_shape`, and `hit_inner` taking the
  ancestor clip and testing it), `src/document.rs` (`hit_with_scrollbar` passes `None`).
* **Why:** `hit_inner` descended into children whose box lay outside a clipping ancestor, so a
  click in the clipped-away part of a scroll panel hit the content that was not painted there: an
  `overflow: hidden` HUD card with a tall list inside it would swallow clicks meant for the game
  behind it. It also compared points against each element's plain rectangle, so the corner a
  `border-radius` rounds away was still a hit, and the clip an ancestor establishes was never
  intersected with a child's. `clip_shape` is the one place that knows both halves — the padding
  box when the node clips its overflow, the border-radius curve always, since a rounded corner is
  not painted — and the clip is threaded down the same walk, in the coordinate space each level is
  already tested in, so transforms need no special case. `pointer-events: none` was already
  honoured (hunk-free); the element's own rounded box was not.
* **Proves it:** `clipped-hit-test` (four clicks: inside the clip, outside it, in the rounded
  corner, in the circle) and `transform-hit-test-and-pointer-events`, plus five tests in
  `tests/interaction.rs`. Dropping the clip test, the radius test, or the inverse transform fails
  one of them each.

### 12. `<button disabled>` was focusable, because an empty attribute value does not parse as `false`

* **Where:** `src/node/element.rs` (`flush_is_focussable`).
* **Why:** `attr_parsed::<bool>("disabled")` on `<button disabled>` — the attribute HTML writes
  with no value — returns `None`, and `unwrap_or(false)` read that as "not disabled". So a
  disabled button was in the tab order, and `focus-traversal-and-activation` stopped on it. What
  disables a control is the attribute's presence, which the sibling `ElementState::DISABLED` code
  already used (`has_attr`).
* **Proves it:** `focus-traversal-and-activation` — Tab visits 1, 3, 4 and 6 and never the disabled
  2 — and `tests/interaction.rs::tab_stops_at_focusable_elements_in_document_order`.

### 13. `line-height: normal` was 1.2 of the font size

* **Where:** `src/stylo_to_parley.rs` (`style`: `stylo::LineHeight::Normal` now maps to
  `parley::LineHeight::MetricsRelative(1.0)`).
* **Why:** `normal` is the used font's own line height — its ascent, descent and line gap — and not
  an approximation in ems. `FontSizeRelative(1.2)` is right for a font whose metrics happen to be
  1.2 em and wrong for every other face: Noto Sans is 1.362 em and Noto Sans Arabic 2.112 em, so a
  `normal` line came out shorter than its own text at one size and taller at another, and a fallback
  face's metrics never reached the line box at all. `MetricsRelative` is parley's own variant for
  exactly this, and parley hunk 1 below is what makes it resolve to Chromium's number.
* **Proves it:** `text-line-height-normal` — the mixed-script paragraph is Chromium's 34px and the
  Latin-only one 22px (SSIM 0.5536 with `FontSizeRelative(1.2)`), and `ua-defaults`' bare `<button>`
  is its 21px, which is what the UA sheet's `line-height: normal` is for.

### 14. a non-atomic inline's horizontal margin, border and padding took no space in the line

* **Where:** `src/layout/construct.rs` (the non-replaced `(Inline, Flow)` branch pushes an edge box
  either side of the span's content; `edge: None` on the two existing `InlineBox` literals),
  `src/layout/inline.rs` (the inline-box sizing loop sizes an
  edge from the element's decoration instead of laying out a node; the placement loop skips it),
  `src/node/node.rs` (the new `InlineDecoration` and `Node::inline_decoration`), `src/document.rs`
  (`inline_fragment_rects` now delegates to the new `inline_fragments`, which paint shares).
* **Why:** a `<span>` is a style span in its inline root's parley layout, and parley has no inline
  start/end spacing, so `a<span style="margin:0 20px">b</span>c` and `padding: 0 12px` both laid out
  as `abc` with nothing between — every Tailwind badge (`px-2 rounded bg-…` on a span) came out
  text-tight. Each span whose start or end side has a non-zero margin + border + padding now gets a
  zero-height `parley::InlineBox` at that edge (`edge: Some(Start | End)`, parley hunk 4), whose
  width is that sum, resolved in `inline.rs` with percentages against the inline root's content
  width (the containing block; 0 while that width is indefinite, i.e. during intrinsic sizing).
  `direction: rtl` puts the start edge's sum on the right side. `inline_fragments` is the old
  per-line union, with the element's own edges counted minus their margin, its vertical padding and
  border added around the font box (which paints without moving the line, as in a browser), the
  whitespace a line ends with excluded (it hangs outside every box), and the run's ascent and
  descent rounded at the CSS font size as Chromium rounds them — so `getClientRects()`/`node_box`
  is the border box, margin excluded.
* **Proves it:** `inline-margins` — 2 edge misses → 0, SSIM 0.9532 → 0.9964, fixture passes;
  `inline-borders-radius` and `inline-margins-wrap` (0 edge misses each). Unrounded ascent/descent
  puts the wrapped fragment's bottom border a device pixel low (`inline-margins-wrap` 0.9806 →
  0.9765), and counting the hanging space draws the first fragment 3px too wide (→ 0.9794).
  `tests/inline_box.rs::an_inline_reserves_its_margin_border_and_padding_in_the_line` fails against
  the previous vendor sources. Known limits: a click on a span's padding hits the inline root rather
  than the span (parley's cluster hit test skips inline boxes), and RTL is implemented but no
  fixture measures it.

### 15. an animation at the exact end of an iteration held the previous iteration's last frame

* **Where:** `src/stylo.rs` (`resolve_stylist`, the per-animation tick in the restyle loop).
* **Why:** CSS Animations defines `iterationProgress = (localTime / duration) mod 1`, so a
  one-second animation sampled at exactly 1000 ms is at the *start* of its second iteration and
  paints its `from` keyframe. Stylo's `iterate_if_necessary` wraps on a strict `>` (`iteration_over`),
  so at that one instant the frame stayed on the previous iteration's `to` value — animated
  invisibly, and measurably wrong. The parity meter samples 100 % of a one-second clock, which is
  exactly that instant: `animate-ping` (Tailwind's `ping 1s … infinite`) measured SSIM 0.5111 at
  1000 ms while its 0, 250, 500 and 750 ms samples were 1.0, 0.999, 0.9959 and 1.0. One ulp past
  the instant (`now.next_up()`) puts the boundary on the iteration after it and moves no other
  frame; a finite animation's `has_ended`/`forwards` fill is untouched because it reads `now`.
* **Proves it:** `tests/animation.rs` — `an_infinite_animation_wraps_at_the_exact_iteration_boundary`
  fails against the previous vendor sources (`rgb(0,0,255)` at 1000 ms instead of Chromium's
  `rgb(255,0,0)`) and passes with it, and `a_finished_animation_holds_its_last_frame` pins the
  `forwards` fill the hunk must not disturb. The meter's `--family PRD-847` sample moves from
  0.5111 to the bar.

### 16. a client rect ignored `transform`, so a rotated or animated box reported its untransformed size

* **Where:** `src/document.rs` (`get_client_bounding_rect` now composes the element's and its
  ancestors' transforms over the box's four corners; the old body is `untransformed_client_rect`,
  and the viewport-scroll subtraction moved to the caller so it happens once, after the transform).
* **Why:** CSSOM client rects are *transformed* — `rotate(45deg)` on a 100x40 box reports 99x99 —
  and this returned the layout box. Paint and hit testing already apply the same composition (each
  node's `transform` about its own origin, stored in device-pixel space by `resolve_2d_transform`,
  which also folds in `transform-origin`, `translate`, `rotate` and `scale`), so a transformed
  element was painted and clicked where it was, but *reported* where it was laid out. The parity
  meter's geometry bar is that rectangle, so every transform unit measured as a 56 px edge miss
  while its pixels matched: `animate-ping`'s 250/500/750 ms samples scored 0.999, 0.9959 and 1.0
  against a 0.99 bar and failed on the box alone.
* **Proves it:** `tests/interaction.rs::a_transformed_element_reports_its_transformed_box` (a
  `rotate(45deg)` 100x40 box is 98.99 square and a `translate(30px,20px)` box moves to `[40, 30]`)
  fails against the previous vendor sources, and `a_transformed_element_is_hit_where_it_is_painted`
  still passes, which is the composition this shares with hit testing. The 32-fixture browser
  oracle (`corpus/oracle.mjs`) is unchanged.

### 17. a scrolled box reported its own rect 140 px above itself

* **Where:** `src/document.rs` (`untransformed_client_rect`: the element's own `scroll_offset` is
  added back onto `absolute_position`).
* **Why:** `absolute_position` subtracts a node's own scroll offset as well as its ancestors', which
  is what paint wants for the node's *contents* — a scrolled box paints its subtree up by its scroll.
  A client rect is the box itself, and a browser leaves a scrolled container where it is; only its
  children move. Without the add-back, every scrolled container in the parity meter's scroll family
  reported itself 140 px above its own box after one wheel, so the whole group read as a real
  mismatch against Chromium (6 cells) or as a `NaN`-collapsed pixel score (the rest).
* **Proves it:** `tests/interaction.rs::a_scrolled_box_keeps_its_own_rect_and_moves_its_content` — the
  container stays at `[20, 20, 200, 100]` after a 140 px wheel while its child moves to `-120`, and
  the test fails against the previous vendor sources. The parity meter's `--family PRD-848 --group
  scroll` stops reporting the 140 px lie: 30 of 31 cells are now honestly "does not discriminate"
  (they need a `scrollIntoView` driver or a snap implementation) instead of a false failure.

### 18. a table's row and row group never received a layout

* **Where:** `src/layout/table.rs` — `TableContext` gains `cell_rows` and `row_boxes`, `TableRow` gains
  its `group`, `collect_table_cells` threads the row and the group through, and
  `TableTreeWrapper::set_unrounded_layout` grows each row, and each row its group, as taffy reports the
  cells.
* **Why:** a table is mapped onto taffy's grid and the wrapper exposes the *cells* only. A `tr` and a
  `tbody` are in the box tree but not in the grid, so neither was ever laid out: both stayed as
  zero-width boxes at the table's origin. A browser gives `tr` the row's area and `tbody` the union of
  its rows, spanning the table's content width — and the parity meter reads exactly those boxes for its
  1-px edge bar, so `border-collapse`, `table-fixed` and the three `border-spacing` cells each failed on
  a `tbody` miss of 300 px and more.
* **Proves it:** `tests/table_boxes.rs` (`a_row_and_its_group_span_the_table_instead_of_collapsing_to_nothing`):
  before this hunk `tbody` reads `[0.0, 0.0, 0.0, 0.0]` against a 200 px table, after it
  `[0.0, 0.0, 190.0, 62.0]` covering both rows. Measured on the parity meter,
  `--family PRD-848 --group flow`: the `tbody` edge miss on `border-collapse` falls from 309.5 px to
  34.5 px and on `table-fixed` from 308 px to 36 px. The group stays at 2 of 15 because the remaining
  misses are elsewhere (a `<caption>` is still never laid out — see below — and the table's own bottom
  edge is short); no cell was lost.

## `stylo-0.20.0` — 118 added code lines and 22 TOML lines, and `stylo_atoms-0.20.0` — 4 added lines

### 1. a colour transition to an `oklch()` value interpolated in sRGB

* **Where:** `values/animated/color.rs` (`Animate for Color`): the `ColorInterpolationMethod` is
  `best_interpolation_between` for two `Absolute` colors and `srgb()` otherwise, where the whole
  implementation had `srgb()` hardcoded. (`AbsoluteColor::animate` in the same file was already
  correct; the transitions of a `<color>`-typed property go through the generic `Color` one.)
* **Why:** CSS Color 4 names Oklab as the interpolation space unless **both** ends are legacy sRGB
  syntax, and Tailwind 4's whole palette is `oklch()`. A legacy start (`#2563eb` from a staged
  declaration) against an `oklch()` end therefore has to interpolate in Oklab; in sRGB the two ends
  agree exactly and the middle is a dozen units per channel off, which is precisely what a parity
  sample mid-transition sees and a sample at rest does not.
* **Proves it:** `a_colour_transition_to_an_oklch_value_interpolates_in_oklab` (fails on the previous
  code with the sRGB blend `[135, 74, 152]`, passes with the Oklab one `[153, 102, 164]`), and
  `parity:tailwind --family PRD-850 --group misc`: the whole transition group went from two cells at
  0.94–0.98 to six passing at 0.9992–0.9999 (`transition`, `transition-none`'s neighbours,
  `duration-75`, `duration-initial`, `delay-75`, `ease-in`, `ease-initial`), the group 131 → 137 of
  182, and the scene 290 → **295 of 503**.

### 2. the servo build had no `prefers-reduced-motion`, and no way to carry the preference

* **Where:** `servo/media_features.rs` (a new `eval_prefers_reduced_motion` and its
  `feature!` entry, `MEDIA_FEATURES` 15 → 16), `device/servo.rs` (`ExtraDeviceData` gains
  `prefers_reduced_motion`, plus `set_prefers_reduced_motion`/`prefers_reduced_motion`),
  `queries/values.rs` (the `PrefersReducedMotion` value, which the Gecko build declares privately),
  and `stylo_atoms-0.20.0/static_atoms.txt` (the feature's name has to be a static atom).
* **Why:** Stylo's Servo media-feature list had no `prefers-reduced-motion` at all, so
  `@media (prefers-reduced-motion: reduce)` **and** `(no-preference)` both failed to match. That is
  exactly what Tailwind's `motion-reduce:` and `motion-safe:` compile to, so both variants resolved
  to nothing and the parity meter measured identical wrong frames (SSIM 0.6492 for both, against a
  0.99 bar). No public API reaches the media-feature table, which is what makes this a vendored
  hunk rather than a crate change.
* **Proves it:** `tests/interaction.rs::reduced_motion_is_a_media_query_the_stylesheet_sees` — a
  document whose colour is chosen by the two queries is blue with no preference and red after
  `set_env(false, true)`, and blue again when the preference is cleared; it fails against the
  previous vendor sources. The parity meter's `--family PRD-847` moves from 1/5 to **3/5**:
  `motion-safe:bg-red-500` and `motion-reduce:bg-red-500` go from 0.6492 to 1.0.

### 3. `scroll-margin` and `scroll-padding` were Gecko-only, so the servo build never parsed them

* **Where:** `properties/longhands.toml` (16 `scroll-margin-*`/`scroll-padding-*` longhands lose
  `engine = "gecko"`) and `properties/shorthands.toml` (the six shorthands).
* **Why:** the codegen skips a longhand whose `engine` is not the build's (`declare_longhand`), so
  Servo's build had no `scroll-margin`/`scroll-padding` at all: Tailwind's `scroll-m*`/`scroll-p*`
  utilities parsed to nothing, and no driver could move a scroller by them. The rest of the engine's
  scroll support already existed — this was the missing half.
* **Proves it:** `tests/interaction.rs::scroll_into_view_honours_scroll_margin_and_scroll_padding`
  reads both back through `scrollIntoView` (below), and the parity meter's scroll group moves from
  0 of 31 to **7 of 31** with 23 cells still needing drivers rather than a missing property.

### 4. the same for `prefers-contrast`, `forced-colors` and `inverted-colors`

* **Where:** the three hunks above, repeated for three more features: `queries/values.rs`
  (`PrefersContrast`, `InvertedColors`), `device/servo.rs` (three fields, their accessors, and
  `forced_colors()` returning the field instead of a hardcoded `ForcedColors::None`),
  `servo/media_features.rs` (three evaluators and entries, `MEDIA_FEATURES` 16 → 19), and three
  atoms in `stylo_atoms`' list.
* **Why:** Tailwind's `contrast-more:`, `contrast-less:`, `forced-colors:` and `inverted-colors:`
  compile to those queries and none of them could match, so all four variants were dead on the
  engine and the parity meter carried them as pending exemptions.
* **Proves it:**
  `tests/interaction.rs::contrast_forced_and_inverted_colours_are_media_queries_the_stylesheet_sees`
  (contrast more/less and inverted invert by colour; forced colours are proved by geometry, because
  that mode rewrites every painted colour the way a browser does — Canvas is white — and a colour
  cannot show it). The meter's `--family PRD-849 --group media` moves 13/24 → **15/22**, with
  `contrast-more:` and `forced-colors:` passing and both leaving the exemption list; `contrast-less:`
  and `inverted-colors:` stay exemptions for a reason that is the *reference browser's*, recorded
  there.

`blitz-dom` hunk 17 in this same change carries the device flag through
(`BaseDocument::set_reduced_motion`, `make_device` takes it), and `css-ui`'s `set_env` now sets it
instead of injecting the `transition-duration: 0s !important` sheet — the workaround the PRD asked
to delete once the query worked.

### 5. `any-pointer` was a platform guess, not the device's own pointer

* **Where:** `src/document.rs` (`make_device` passes the primary's `PointerCapabilities` as the
  all-pointer union instead of `PointerCapabilities::default()`).
* **Why:** `default()` is compiled per platform and answers `COARSE` on this build, so a desktop
  reported `(any-pointer: coarse)` and not `(any-pointer: fine)` — Tailwind's `any-pointer-coarse:`
  variant fired on a mouse-only host and `any-pointer-fine:` did not. A device with one pointer has
  the same union as its primary, which is what this engine models.
* **Proves it:** `tests/interaction.rs::any_pointer_mirrors_the_device_it_is_driven_by` — a mouse
  box is `(40, 20)` (fine, not coarse) and the same document on a finger is `(20, 40)`; it fails
  against the previous vendor sources. The parity meter's `any-pointer-coarse:` cell stops reporting
  a real mismatch.

### 6. `scrollIntoView` scrolled only the viewport, and ignored `scroll-margin`/`scroll-padding`

* **Where:** `src/scrolling.rs` (the new `scroll_node_into_view`; `scroll_into_view` is left as the
  viewport-only entry point it was).
* **Why:** `Element.scrollIntoView()` aligns the element's *scroll-margin* box with every scrollable
  ancestor's *scroll-padding* edge, innermost first. The engine had a viewport-only version and read
  neither property, so Tailwind's `scroll-m*`/`scroll-p*` units had no consumer at all. The walk
  reads everything out of the tree into plain numbers before scrolling, because the mutable scroll
  cannot overlap the borrows the computation needs.
* **Proves it:** `tests/interaction.rs::scroll_into_view_honours_scroll_margin_and_scroll_padding` —
  an item 200px down a scroller aligns at 200 with nothing declared, and at 110 with
  `scroll-margin-top: 60px` plus `scroll-padding-top: 30px`; the test fails against the previous
  vendor sources. The meter's scroll group goes 0/31 → 7/31.
* **Alignment is per axis:** `scroll_node_into_view` takes `block_end`/`inline_end`, because an
  end-side `scroll-margin` or `scroll-padding` only moves a scroller that aligns to the *end* —
  `scroll-pr-*`/`scroll-pb-*` measured "does nothing" against a start-only driver. The end alignment
  is computed from the element's extent plus its end margin and the scroller's end padding, against
  the scroller's own size. The group goes **14/31 → 20/31**.
* **A follow-up fixed the last 2 px:** the element's position was taken relative to the scroller's
  *padding edge* and then the scroller's own border and padding were subtracted again, so every
  `scroll-p*` cell stopped two pixels high (measured against Chromium: target rows 188..221 against
  186..221). `absolute_position` already reports boxes from that edge — a child's layout location is
  relative to its parent's content box — so neither is subtracted now, and the group goes **7/31 →
  14/31** (every block-axis `scroll-m*` and `scroll-p*` cell passes at 1.0000).

### 7. a decoration line was drawn half a pixel off, so a 1px underline covered two rows

* **Where:** `src/text.rs` (`draw_decoration_line`: both edges of the line are snapped to whole device
  pixels; the `snap` argument carries it).
* **Why:** the line is a stroke centred at `baseline - offset + size/2`, and at a fractional
  coordinate a 1px stroke covers two rows at 50 % each. A browser pixel-aligns the decoration
  rectangle: measured on the parity scene's `underline` cell, Chromium paints one crisp row at y=52
  and the engine painted rows 52 and 53 — visible as a soft, thicker line, SSIM 0.9604 against a 0.98
  bar for a decoration whose *position* already matched Chromium's to the row.
* **Proves it:** the parity meter's `underline` goes 0.9604 → 0.9777, `decoration-2`/`decoration-red-50`
  0.914/0.96 → 0.977, and `line-through` passes (0.9823). The 32-fixture browser oracle is unchanged
  (28/28) and the crate's own suite is green. `overline` is still 0.8544: the snap did not change its
  offset, which is a separate measurement (the em-box top) and the next thing to look at there.

### 8. a `display: none` element reported the position it last had

* **Where:** `src/document.rs` (`untransformed_client_rect`: a `display: none` element answers a zero
  rect at the origin).
* **Why:** taffy leaves a stale location with a zero size, so `getBoundingClientRect()` on a hidden
  element returned e.g. `[0, 506, 0, 0]`. CSSOM says a box-less element's rect is all zeros, and the
  parity meter's geometry bar read the stale `y` as a 506 px edge miss on a cell whose pixels already
  matched to 1.0.
* **Proves it:** the parity scene's `hidden` cell passes (1.0 pixels, 0 edge misses). The crate test
  suite and the 32-fixture browser oracle are unchanged.

### 9. a colour matrix and a component transfer were dropped, so every CSS colour filter painted nothing

* **Where:** `src/scene.rs` (the new `ColourLayer`: a filter that is exactly one per-pixel colour
  function renders its layer into its own `RenderContext`, the pixels are transformed, and the result
  is composited back as a registered image), `src/filters.rs` (`colour_filter_only`).
* **Why:** `vello_common` 0.1.0 `unimplemented!`s on both primitives, so `grayscale()`,
  `saturate()`, `hue-rotate()`, `sepia()`, `brightness()`, `contrast()`, `invert()` and `opacity()`
  were dropped — 15 of the parity meter's filter cells measured a real difference for that reason.
  Both primitives are per-pixel functions of the layer's own pixels, which is exactly what an
  offscreen render makes available. The clip passed to `push_layer` is in the element's *local* space
  and the ops that follow carry their own world transforms, so the child's clip is transformed by the
  layer's transform before it is pushed — the first attempt pushed it untransformed and the child
  clipped every pixel away (measured: 0 opaque pixels, and the element's paint was lost).
* **The backdrop half is written and does not land.** A backdrop filter needs a copy of what is
  painted *under* the layer, which means rendering the parent — and `vello_cpu` panics ("some layers
  haven't been popped yet") when that is asked of a context with an open layer, which blitz has (it
  wraps some elements in a clip-path or mask layer). A depth counter refuses the capture there instead
  of crashing, so the eight `backdrop-*` cells keep the values they had; the next attempt needs a
  capture that does not require closing the parent's layers.
* **Proves it:** `tests/interaction.rs::a_colour_filter_transforms_the_layer_it_wraps` —
  `brightness(50%)` on `#2563eb` gives `#13327` and `grayscale(100%)` gives `#606060`, the CSS values.
  The parity meter's filter family moves 2/19 → **9/19**: brightness, contrast, grayscale,
  hue-rotate, invert, saturate and sepia go from 0.20–0.88 to **1.0000**, and the two cells that
  already passed (blur, backdrop-opacity) are unchanged. The 32-fixture browser oracle stays 28/28.

### 10. `mask-mode: luminance` fell back to alpha, so a colour mask hid everything

* **Where:** `src/gradient.rs` (the new `apply_luminance_alpha`), `src/render/mask.rs` (reads the
  layer's `mask-mode` and passes it down), `src/render/background.rs` (`draw_image_layer` and
  `draw_gradient_layer` take the flag and rewrite the peniko gradient's stops after conversion).
* **Why:** this crate composites every mask layer with `Compose::DestIn`, which reads *alpha*, and CSS
  luminance masks carry their mask value in *luminance*: Tailwind's `mask-linear-from-red-50` stops
  are two opaque colours that differ only in brightness, so as an alpha mask both are 1 and the mask
  hid nothing — eight colour-mask cells measured 0.52 to 0.72 against a 0.99 bar. The luminance is
  computed on linear-light values (sRGB → linear, then `0.2126 R + 0.7152 G + 0.0722 B`), which is
  what CSS Masking defines; on the stored sRGB values a `red-50` stop reads 0.96 against Chromium's
  0.91.
* **Proves it:** the parity meter's eight colour-mask cells move from 0.52–0.72 to **0.945–0.982**
  (still failing the 0.99 bar, so the family stays at 23 of 50 — what is left is the mask geometry,
  not the mode). The 32-fixture browser oracle is unchanged (28/28) and the crate's 57 tests are
  green. Raster and SVG image masks are still alpha-only, which the hunk says.

### 11. an overline's top edge was one thickness above the ascent

* **Where:** `src/text.rs` (the overline's offset is `ascent`, not `ascent + size`).
* **Why:** measured against Chromium on the parity scene's `overline` cell, the engine's line was one
  row higher than the browser's (y=34 against y=35). The line's *top* edge sits on the ascent; the
  engine put its top one thickness above it and the pixel snap then locked the error in.
* **Proves it:** the cell goes 0.8949 → **0.9793** against a 0.98 glyph bar — still 0.0007 short, and
  what is left is the line's *length*: a decoration is drawn across the run's advance, which includes
  the white space a line ends with (measured on `underline`: 103 px against Chromium's 93, and
  Chromium trims it). `GlyphRun` exposes `glyphs()` and the run's `clusters()`, not per-line clusters,
  so trimming needs the line's portion of the run — that is the next measurement here.

### 12. an inset box shadow ignored its spread, so a ring with no blur painted nothing

* **Where:** `src/render/box_shadow.rs` (`draw_inset_box_shadow`: the `DestOut` cut-out is the border
  box deflated by the shadow's `spread`).
* **Why:** the spread is the width of an inset shadow's band, and the cut-out was the border box
  itself — so an inset shadow with a spread and no blur covered the whole box and then erased itself.
  Tailwind's `ring-inset` plus a ring width is exactly `box-shadow: inset 0 0 0 4px …`: measured, the
  parity scene's cell showed no ring where Chromium paints one, and a 48×48 box with
  `inset 0 0 0 4px #ffffff` stayed entirely blue.
* **Proves it:** `tests/interaction.rs::an_inset_box_shadow_paints_inside_the_box` fails against the
  previous vendor sources. The parity meter's `ring-inset` and `inset-ring-red-50` go from 0.747 to
  **1.0000**, the `misc` group 125 → 127 of 182, and the 32-fixture browser oracle is unchanged
  (28/28). `inset-shadow-red-50` now discriminates for the first time and measures 0.9809 — its blur
  kernel is the next question there.

### 13. `mix-blend-mode` was never read, so every blend painted as `Normal`

* **Where:** `src/render.rs` (`peniko_mix` maps the computed `mix-blend-mode`; the element's effect
  layer is pushed when the mode is not `Normal`), `src/layers.rs` (`maybe_with_layer` /
  `maybe_push_layer` take the mode and pass it to `push_layer`, and the clip-only fast path is not
  taken for a non-normal mode), `src/render/background.rs` and `src/render/box_shadow.rs` (their layer
  calls pass `Normal`).
* **Why:** `maybe_push_layer` hardcoded `Mix::Normal`, and blitz's `is_stacking_context` does not
  consider the property, so an element with `mix-blend-mode` painted as if it had none.
* **Proves it:** `tests/interaction.rs::mix_blend_mode_composites_the_element_against_its_backdrop` —
  a blue square with `multiply` over red is black and the backdrop outside it is untouched; the test
  fails against the previous vendor sources. **The parity scene's blend cells do not move**: they are
  all `hue` (Tailwind's `mix-blend-hue`, `bg-blend-hue`), and `vello_cpu` 0.1's `try_u8_mix` returns
  `None` for the non-separable modes (`hue`, `saturation`, `color`, `luminosity`, `color-dodge`,
  `color-burn`, `soft-light`), so the layer is composited as `Normal` anyway. Separable modes work;
  the non-separable ones are a `vello_cpu` limitation, not this crate's.

### 14. a perspective-free 3D transform was dropped instead of projected

* **Where:** `src/stylo_to_kurbo.rs` (`resolve_2d_transform`: a matrix with no perspective row keeps
  its 2D submatrix instead of being filtered out).
* **Why:** outside a 3D rendering context CSS Transforms 2 paints a 3D transform as its projection onto
  the plane — its own example paints `rotateY(50deg)` narrower — and this crate dropped every matrix
  that merely *contained* a 3D function, so `rotate-x-45` and `rotate-y-45` painted an untransformed
  box (0.6410 and 0.7942 against Chromium).
* **Proves it:** `tests/interaction.rs::a_perspective_free_3d_rotation_paints_its_2d_projection` — a
  100×40 box with `rotateY(45deg)` reports 70.71 wide, and one with `perspective(500px) rotateY(45deg)`
  keeps its layout width because a perspective row still needs a projective rasterisation this backend
  does not have. The parity meter's `transform3d` family goes 1/9 → **3/9** (both rotations 0.9991 and
  0.9996) and the whole scene 272 → **274/503 (54.5 %)**.

### 15. a wavy decoration's wavelength was four pixels where Chromium's is six

* **Where:** `src/text.rs` (`draw_decoration_line`: `half_wave` is three thicknesses, not two).
* **Why:** measured on the parity scene's `decoration-wavy` cell — the decoration's lowest lit row per
  column cycles `47, 47, 48, 49, 50, 50, 49` in Chromium (a period of six at a one-pixel thickness) and
  `46, 46, 46, 47, 47` here (a period of four). The squiggle was therefore twice as dense as the
  browser's, which a 0.99 SSIM bar sees as a different pattern whatever the amplitude does.
* **Proves it:** the engine's period is now six, matching Chromium's (re-measured the same way:
  `46, 46, 45, 46, 47, 47, 47`). The squiggle then sat **2–2.5 px higher** than Chromium's (lit rows
  45..47 against 47..50) and its wave was shallower, so the same measurement fitted two more
  constants: the centre is `y + 2.5 * size` and the amplitude `1.5 * size`, which puts the engine's lit
  rows at 47..50–ish against Chromium's 47..50. The cell goes 0.8472 → **0.9067** and still fails the
  0.98 glyph bar — the remainder is the wave's phase and the stroke's shape, not the period, the depth
  or the position. Both constants are fitted to a measurement, and the hunk says so because Chromium
  does not document the squiggle's geometry.

### 16. a decoration ran through the white space a line ends with

* **Where:** `src/text.rs` (the decoration range subtracts the trailing spaces of the run, for the
  glyph run that reaches that run's end).
* **Why:** the range came from `glyph_run.offset() + advance()`, and a run's advance includes the space
  a line ends with — which hangs outside the line box and is not decorated. Measured on the parity
  scene: the engine's underline was 103 px wide where Chromium's is 93. Every decoration unit measured
  just under its 0.98 glyph bar because of it (`underline` 0.9777, `decoration-2` 0.9772,
  `decoration-red-50` 0.9777).
* **Proves it:** those three cells pass at **0.9819, 0.9821 and 0.9821**, and the `type` family goes
  13/41 → **17/41**. The trim applies only to the glyph run that reaches the end of its own run, so a
  line's earlier runs keep their inner spaces.

## `parley-0.11.1` — 240 added code lines

Hunk 1 is the one over the guideline and it is separable in three pieces, each of which a fixture
fails on its own: the strut (`box-model-and-sizing`), the order and scale of the quantisation
(`inline-runs`, `dpr-2-layout-and-paint`) and the metrics-relative line height
(`text-line-height-normal`). Hunk 2 is 10 lines, hunk 3 ~40 and hunk 4 ~57, each on its own.

### 1. line boxes had no strut, and the half-leading was quantised in the wrong order and at the wrong scale

* **Where:** `src/layout/line_break.rs` (`finish_line`, `start_new_line`),
  `src/layout/data.rs` (`LayoutData::strut_ascent`/`strut_descent`, and the metrics-relative line
  height in `push_run`), `src/layout/line.rs` (the new `leading_box`, and `InlineBox` placement in
  `line.rs`'s item iterator), `src/layout/mod.rs` (`leading_box` is now crate-visible),
  `src/inline_box.rs` (the new `InlineBox::baseline`), `src/builder.rs` (`strut_metrics`, called
  from `build_into_layout`), `src/resolve/tree.rs` (`begin` now puts the root style at style-table
  index 0).
* **Why:** parley computed a line's height as the largest `line-height` on it and then split the
  remaining leading once for the whole line. CSS 2.1 §10.8.1 is per inline box: each one's
  half-leading sits around *its* baseline, and every line also carries a strut built from the block
  container's own font and line-height. So a line holding only atomic inlines lost the strut's
  descent (a 100×60 line of two `inline-block`s came out 36px instead of 42px), and a line mixing a
  16px and a 12px run came out 24px instead of 25.35px. `strut_metrics` measures the strut through
  the same font query the shaper uses, so it is the same face at the same scale; with no resolvable
  font it is `(0, 0)` and line boxes stay as tall as their content. The root style is now always
  style-table entry 0, because a layout with no text never commits a span and the strut is measured
  before line breaking.

  Three details of Chromium's arithmetic are what `leading_box` now follows, and each one was
  measured against it rather than inferred. **Rounding order:** Chromium rounds the ascent and
  descent before it splits the leading and gives the larger half below (`NGLineHeightMetrics`, and
  the comment this crate already carried in its own line-level metrics). That order is what a run
  smaller than the block's own font turns on: at 12px in a `line-height: 24px` line the leading box
  is 16 above and 8 below, where rounding each side once it has its share of an *unrounded* split
  gives 17 and 7 — and a line holding both a 16px and a 12px run then comes out 25px where Chromium
  has 26. **Scale:** a browser's font metrics and line boxes come out the same number of CSS px at
  every device scale factor, so the rounding and the split happen at the CSS font size and the
  result is scaled; quantizing in device pixels moves a line by half a CSS px as soon as the scale
  is not 1, which at dpr 2 is a whole device pixel of the baseline. **A metrics-relative line
  height** is the font's own, so it is built from those same rounded numbers: 16px Noto Sans is
  17 + 5 = 22 and not the 21.792 skrifa reports, and the 0.208 that rounding takes away would
  otherwise come back as negative leading whose floored half lands a pixel above the baseline of
  every `line-height: normal` line.
* **Proves it:** `box-model-and-sizing` — the `div` holding two inline-blocks is 42px, matching
  Chromium (fixture passes, SSIM 1.0), and `inline-runs`' paragraph is 50px. `inline-runs` is also
  what fails if the split rounds after the leading is divided rather than before: 0.9882 → 0.9446,
  with its second line a pixel low. `dpr-2-layout-and-paint` fails if the quantisation happens in
  device pixels: 0.9939 → 0.9836, the 18px `h3`'s baseline half a CSS px low. `text-line-height-normal`
  fails if the metrics-relative height is left unrounded: 0.9906 → 0.9068, every glyph a pixel high.

### 2. a line box could not be moved along the block axis

* **Where:** `src/layout/layout.rs` (the new `Layout::shift_lines`).
* **Why:** a container whose content box is taller than its content aligns that content rather than
  growing to fill the box — a `<button>` centres its label (blitz-dom hunk 6). The line boxes are
  where the content's geometry lives, so moving them there reaches every consumer at once (painting,
  hit testing, `getClientRects()`) instead of an offset each of them would have to add and forget.
  The layout's own `height()` is left alone: it is the extent of the content, not of the box.
* **Proves it:** `button-centring` and `state-selectors-and-environment` (0.9769 and 0.9650 without
  it, both fixtures fail).

### 3. a fallback run stretched the line it borrowed glyphs for

* **Where:** `src/shape/mod.rs` (`FontSelector` remembers the first font the style's family list
  resolves to, and `shape_item` hands it to `push_run`), `src/layout/data.rs` (`push_run` takes the
  inline box's own font and derives `box_ascent`/`box_descent` from it when the run's face is a
  fallback), `src/layout/run.rs` (the two new `RunMetrics` fields), `src/layout/line_break.rs`
  (`finish_line` reads them).
* **Why:** the half-leading of a specified `line-height` belongs to the *inline box*, and an inline
  box's font is the first one its family list resolved to — not a fallback that merely supplied
  glyphs that font lacks. Without this, a paragraph that fixed `line-height: 24px` and mixed in
  Arabic from a fallback face 2.1 em tall grew its line boxes to 25px, because that run's own
  leading box (17 above, 7 below) outgrew the strut's (18 above, 6 below) on the block axis. A
  `line-height: normal` line is the exception and is left alone: there the run's own metrics *are*
  what set the line height, so they still apply — which is why the same fallback face takes
  `text-line-height-normal`'s first paragraph from 22px to Chromium's 34px.
* **Proves it:** `text-mixed-direction` — its three 24px lines are Chromium's 24px again (SSIM
  0.9847; 0.839 with two edge misses when `finish_line` reads `ascent`/`descent` instead of
  `box_ascent`/`box_descent`). `text-line-height-normal` is the other half and stays green either
  way, which is what makes the exception in this hunk a measured one rather than an assumption.

### 4. an inline element's edges had no way into a line

* **Where:** `src/inline_box.rs` (`InlineBox::edge` and the new `InlineBoxEdge`, re-exported from
  `src/lib.rs`), `src/layout/line.rs` (`PositionedInlineBox::edge`), `src/builder.rs`
  (`TreeBuilder::push_inline_edge`), `src/layout/line_break.rs` (`start_edge_boundary`, and no
  break opportunity after an edge), `src/layout/data.rs` (`calculate_content_widths`).
* **Why:** blitz-dom hunk 14 reserves a span's margin, border and padding as inline boxes, and an
  ordinary inline box is wrong three ways for that. It is a break opportunity after itself, so a
  span wrapping at its first word left its start edge — padding and border — stranded at the end of
  the line above; a browser breaks *before* the edge, because the break opportunity belongs to the
  text and the edge travels with the content it opens. So a text break that lands right after one
  or more start edges is taken before them (`start_edge_boundary`), and no edge marks a break of its
  own; an end edge that overflows takes the last break before the content it closes. It also resets
  white-space collapsing, so `a <span> b</span>` would keep both spaces; `push_inline_edge` leaves
  that state alone (an end edge commits the span's text as its last, as popping it would). And it
  splits the min-content width, where an edge now joins the word it opens or closes.
* **Proves it:** `inline-margins-wrap`'s second paragraph wraps at the span's first word: with the
  start-edge boundary disabled it is 1 edge miss and SSIM 0.9202 (0.9806 with it, fixture passes).

## `taffy-0.14.0` — 4 added code lines

### 1. four of twenty-eight call sites resolved a percentage padding against the container's *height*

* **Where:** `src/compute/block.rs:806` (the aspect-ratio block container's padding and border) and
  `src/compute/flexbox.rs:2061` (the same pair in the `max-width` aspect-ratio transfer).
* **Why:** CSS 2.1 §8.3 resolves a percentage `padding`/`border-width` against the containing
  block's width on all four sides. taffy resolves a `Rect` against a `Size`, so a caller that passes
  the whole size hands the block axis the container's height: in a 400×340 block,
  `padding-top: 5%` came out 17px instead of 20px, and every percentage `border-width` with it.
  Twenty-four of the crate's own padding and border call sites already pass
  `node_inner_size.width`; these four were the only ones passing the size, and matching them is the
  whole fix.
* **Proves it:** `intrinsic-sizing-and-margins` — the `.pp` rule (`width: 50%; padding: 5% 0 0;
  height: 20px`) is 20px of top padding and every box below it lands where Chromium's does
  (5 edge misses and SSIM 0.9954 → 0.9607 with the registry's four lines restored).

## `fontique-0.11.1` — 50 added code lines

### 1. a family name no installed font carries resolved to nothing at all

* **Where:** `src/collection/mod.rs` (`Collection::family_id` asks the system backend once the
  registered fonts and the system name map have answered), `src/backend/fontconfig.rs`
  (`SystemFonts::family_id`, `substituted_family`, and the `substituted` cache that holds the
  answer), and a `family_id` that answers `None` in `src/backend/{android,coretext,dwrite,mod}.rs`.
  Those four exist because `Collection::family_id` calls the method on every platform: the first cut
  defined it only for fontconfig and broke the Android build (`E0599`, found by the emulator run);
  the other backends have no substitution to offer, so their lookup is exactly what it was.
* **Why:** the family map fontique builds is the *installed* fonts' own names, so a document that
  names a family the machine has never heard of — `Arial`, `Helvetica`, anything in a design system's
  stack — matched nothing: no font, no metrics, and a silent fall through to whatever the query's
  script fallback happened to offer. fontconfig is what decides what stands in for such a name
  (`fc-match Arial` is Liberation Sans here), and Chromium on this platform asks fontconfig the same
  question, so this asks it too and takes the identifier of the family it substituted. The answer is
  cached, negative results included: a stylesheet names every family in its stack on every element it
  matches, and an uncached `FcFontMatch` per name per element turns laying out a thousand nodes into
  seconds of FFI round-trips.
* **Proves it:** `ua-defaults` — its bare `<button>` takes the UA sheet's `font: 400 13.3333px
  Arial`, and with this hunk its 21px line box is the one Chromium measures on Liberation Sans;
  without it the button is 3.09px tall at the bottom and the column above it with it (2 edge misses).

## `blitz-paint-0.3.0-beta.2` — a gradient named `in oklab` interpolates in Oklab

### 1. peniko interpolates in sRGB, so a gradient's named space was ignored

* **Where:** `src/gradient.rs` (`resample_stops`, threaded through `resolve_color_stops` and the three
  `*_gradient` builders; their tuples and the match arms now carry `color_interpolation_method`).
* **Why:** CSS Images 4 interpolates a gradient's stops in the space its `in <space>` names, and Tailwind
  4 emits `linear-gradient(<angle> in oklab, …)` for every gradient inside an `@supports` block that
  every current browser takes. peniko interpolates in premultiplied sRGB, so the two renderers agree at
  both ends of a gradient and differ most in the middle — which is where a parity sample of a gradient
  sits. Stops are now resampled in the named space through stylo's own `mix::mix_many` (48 per pair)
  before they reach peniko, which keeps both the colour space and the hue method correct.
* **Proves it:** `a_gradient_named_oklab_interpolates_in_oklab` reads the sRGB midpoint `[125, 0, 130]`
  on the previous code and the Oklab midpoint `[140, 83, 162]` with it; `parity:tailwind --group paint`
  takes `bg-linear-60` from 0.9642 to 0.9983 and the group from 18 to 20 of 39.

## `anyrender_vello_cpu-0.17.0` — 250 added code lines

### 1. a filter primitive the backend cannot paint aborted the whole frame

* **Where:** `src/filters.rs` (`convert_filter_effect`).
* **Why:** this backend's `filters` feature is what makes `filter:` reach pixels at all, and with it
  on, `vello_common` 0.1.0's `PreparedFilter::new` *panics* on any primitive it has not implemented
  (`unimplemented!("Other filter primitives not yet implemented")`). Tailwind's colour-matrix
  utilities — `grayscale`, `brightness`, `contrast`, `saturate`, `sepia`, `hue-rotate`, `invert`, and
  every `backdrop-*` — are exactly those, so one of them on screen aborted the host's frame instead
  of painting an unfiltered box. Dropping the primitive keeps the two things apart: a filter the
  backend cannot paint is a visible difference a comparison reports, and an unsupported feature is
  no longer a crash that reports nothing.
* **Proves it:** `parity:tailwind --family PRD-844` — before this hunk seven cells of the filter
  family were `the engine refused this stage: not implemented: Other filter primitives not yet
  implemented` and could not be measured at all; after it all nineteen are measured, `blur-3xl`
  matches Chromium at SSIM 0.9951, and the colour-matrix cells report the real gap (0.20 to 0.87).
  Multi-primitive graphs and the backdrop filter argument are still unimplemented upstream and are
  PRD-844's remaining work.
