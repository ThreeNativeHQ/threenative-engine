# PRD-845 — native-css composites blend modes, masks and clip paths like Chromium

**Status:** PARTIAL
**Priority:** P1 — `mask-*` is 6 265 of Tailwind's classes, two kits ship `clip-path`, and AC-1 to AC-3 are open.
**Complexity:** 5 (MEDIUM) — 3 to 5 Rust files (+1), vendored paint path (+2), meter run (+2).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

- `mix-blend-mode` and `background-blend-mode`: blitz-paint has no mapping. peniko `BlendMode`
  and vello_cpu layers already take a blend mode.
- `mask-*`: `vendor/blitz-paint-0.3.0-beta.2/src/render/mask.rs` paints alpha masks only.
  `mask-mode: luminance` falls back to alpha. Tailwind's `mask-linear-*`, `mask-radial-*` and
  `mask-conic-*` compose several gradient layers with `mask-composite: intersect`.
- `clip-path`: `render/clip_path.rs` has basic shapes, but `inset()` ignores its radius (an
  upstream TODO). Tailwind emits `clip-path` in `sr-only` and in arbitrary values.
- `isolation: isolate` decides the blend group.

## Solution

Map both blend properties onto the existing layer blend argument. Complete mask layering, the
composite operators and luminance mode in `mask.rs`. Add the `inset()` radius. Each hunk gets a
`PATCHES.md` entry. Delete the blend, mask and `clip-path` rows from `native-css-compat.ts` in
the commit that turns their units green.

## Acceptance Criteria

- [ ] AC-1 [local]: every blend-mode and isolation unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-845 --group blend` plus `--host`, and the judge on `--sheet PRD-845` — Evidence: pending.
- [ ] AC-2 [local]: every `mask-*` unit passes the same checks, including composed linear, radial and conic masks. proof: as AC-1 with `--group mask` — Evidence: pending.
- [ ] AC-3 [local]: every `clip-path` unit passes the same checks, including `sr-only`. proof: as AC-1 with `--group clip` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Blend, mask, clip on native | game Tailwind class → `css-ui` paint → vello_cpu layer | Rows deleted from `native-css-compat.ts` | AC-1 to AC-3 |

## Decisions

**A `mask-<axis>-to-*` unit sets only the end *position*, and the end colour keeps its initial
`transparent`.** With a transparent companion both stops were transparent, so the probe was invisible in
both arms and six cells read "does nothing" — the mask never existed. The opposite end is now opaque
(`from-black`) for the position units, and stays transparent for the colour units, which supply their own
colour; measured, the family's non-discriminating count falls 19 → 13 with nothing lost (23/50 either
way).

**Every one of those six cells now measures a real engine difference, and the cause is single: this engine
paints no mask at all for Tailwind's composition.** Measured on `mask-t-to-40`: the browser's column fades
`(34,81,183)` → `(36,95,225)` as the masked blue composites over the page colour, while the engine's is
the unmasked `(37,99,235)` at every row. Tailwind emits

```
mask-image: var(--tw-mask-linear), var(--tw-mask-radial), var(--tw-mask-conic);
mask-composite: intersect;
```

— a **three-layer** mask intersected. A single-layer mask paints (the `mask-*` cells at 0.99+), so what is
missing looked like multi-image `mask-image` with `mask-composite`.

**It is not that feature.** Three crate tests now build the *exact* Tailwind shape — six layers
(`--tw-mask-linear` expands to four more), `mask-composite: intersect`, the stops' colours and positions
taken from `@property` registered variables, inside `@layer utilities` — and the engine paints a correct
fade in every one. So the mask paint path is complete for what Tailwind emits, and the panel's flat blue
comes from something in that panel's stylesheet rather than from the feature. The next experiment is to
bisect the panel sheet against the passing test: the two differ only in the rest of the 100-odd rules and
in the probe's staging, and the cell is worth six more.

The three tests stay: they are what turned "multi-layer masks are unimplemented" into a statement that
was false, and they pin the shape for whoever bisects the sheet.

**The panel now reproduces standalone, which is the instrument for that bisect.** Copying the panel's own
`batch.json` and running the crate's `oracle` example on it paints the same flat blue as the meter, so the
difference can be bisected rule by rule without a browser in the loop. Two candidates are already ruled
out this way: removing the companion rule from the sheet changes nothing, and the `@property` fallback
block (`@layer properties { @supports (…) { * { --tw-mask-top: initial } } }`) is harmless — a registered
property set to `initial` keeps its registered initial value, and a fourth test proves the mask still
paints through that reset. The half-split is done, and it rules out a single rule: dropping *either* half of the panel's 83 flat
utility rules leaves the panel unmasked, measured by whether the probe's region holds more than two
distinct blue values (a criterion that cannot be fooled by a rule removal shifting the layout — a shifted
probe is a flat page, not a fade). Two more clip-layer tests pass as well, with one and with two nested
`overflow: hidden` ancestors, so it is not the cell's clip either.

With every *other* probe's mask classes stripped — one masked element left in the whole document, layout
untouched — the region is still flat, so the number of masked elements is not the cause either. The
remaining hypothesis is the sheet's own text: something earlier in it stops the mask declarations from
being applied.

Bisecting that needs a **block-level pass over the stylesheet**, and a quick brace-scanner is not good
enough: it mis-slices `html,body{…}` and produces garbage (measured — the frame came back all black). The
next attempt should use `cssparser`, which this crate already depends on through stylo, to walk top-level
rules and drop them in halves. That is the one piece of tooling standing between this family and its
answer, and it is worth building once: the same bisect applies to every family whose cells are inert in a
panel but correct in isolation.

**Built, and the answer is that it is not a rule at all.** A tokenizer that skips strings and comments
slices the sheet correctly, and the bisect over it gives one clean working configuration: **the panel's own
staging plus a single mask utility rule fades correctly** (measured 51 → 206 down the probe). Everything
else fails regardless of what is dropped — halving the 39 utility rules either way, dropping all 35
`@property` blocks, dropping the mask ones alone. So the break is *cumulative*, not a rule, and the next
hypothesis is the sheet's size: 36 KB of CSS parses to no mask while 17 KB with the same staging and one
mask rule works. A reduce-from-the-end test would confirm a threshold in one pass.

**Found it, by instrumenting rather than bisecting.** A temporary print in
`vendor/blitz-paint-0.3.0-beta.2/src/render/mask.rs` shows the working configuration with **one** mask
layer and the broken one with **six**; a single-layer alpha mask fades correctly
(`a_single_layer_alpha_mask_fades_the_box`), and a six-layer `mask-composite: intersect` composition paints
**nothing at all**.

Two experiments pin the shape: with `Compose::SrcIn` (what the code uses for `intersect`) the box is fully
hidden; with `Compose::SrcOver` it is fully visible. The accumulated mask is uniform either way, so the
fade layer's alpha never reaches the composite — the bug is in how the per-layer compositing accumulates,
not in the gradient, the variables, the clip, the layers' `@property` initial values (each proved correct
by its own test) or the sheet's size.

**Fixed.** Two faults, both in `draw_css_mask`: a layer pushed with `SrcIn`/`DestIn` *inside* the mask's
own `DestIn` layer erases the whole mask, and the bottom-most test used the *list index* rather than the
first layer actually drawn — so the one real layer ended up composited `SrcIn` against an empty mask. The
fix skips identity layers (one opaque colour repeated — intersecting with an opaque mask changes nothing)
and composites `SrcOver` for the first layer *drawn*.

Measured effect: every mask cell now measures instead of reading "does nothing", and the family's honest
score is 22 of 50 rather than 23 — the engine paints masks now, and the differences that appear
(0.58–0.93, `mask-add` worst at 0.588, the `-red-50` luminance cells around 0.87–0.89) are real
mask-rendering gaps that were previously invisible behind a mask that did nothing. Scene 313 → 311 for the
same reason: one point of apparent score was a mask that was not being painted at all.

Two tests pin it: `a_tailwind_three_layer_mask_composition_paints` (six layers, intersected, fading) and
`a_mask_gradient_whose_stops_come_from_registered_variables_paints`. The earlier version of the first one
asserted "fully masked out" and **passed on the bug** — which is why three turns of bisecting found
nothing.

Also learned and worth keeping: a registered property that is never set *does* read as its declared
`initial-value` (`an_unset_registered_property_is_its_initial_value`).

## Open: the eight colour-mask cells differ by a mask *curve*, measured (2026-11-07)

`mask-mode: luminance` now paints (gradient stops rewritten so their alpha carries their luminance,
see `vendor/PATCHES.md`), and the cells moved from 0.52–0.72 to 0.945–0.982 — close, and not the
mode. Sampling the probe of `mask-linear-from-red-50` in both frames at the same rows:

| row (probe) | Chromium | this crate | implied mask alpha |
| --- | --- | --- | --- |
| top +4 | rgb(24,25,30) | rgb(26,33,49) | 0.02 / 0.11 |
| middle | rgb(28,52,106) | rgb(31,60,125) | **0.38** / **0.47** |
| bottom −4 | rgb(34,87,203) | rgb(36,87,200) | 0.85 / 0.83 |

The direction agrees (the gradient is `linear-gradient(0deg, red-50 0%, black 100%)`, so the mask is
opaque at the bottom) and the ends agree; the **middle is 0.09 of alpha off**. That is the luminance
formula, not the geometry: sRGB-space luminance of the interpolated mid colour is 0.48, linear-light
is 0.21, and Chromium's 0.38 is neither — so Chromium either interpolates the gradient in another
space before taking luminance or applies a different transfer. The next attempt starts from this
table, and `tests/interaction.rs::a_zero_degree_gradient_runs_to_the_top` already pins the direction
(a flipped `0deg` was the first hypothesis and it was wrong).

## Open: blend modes, threaded and half-painted (2026-11-07)

`mix-blend-mode` is now read and threaded into the element's paint layer, so a *separable* mode
composites: `tests/interaction.rs::mix_blend_mode_composites_the_element_against_its_backdrop` proves
`multiply` (blue over red is black) and fails against the previous vendor sources.

The parity scene's blend cells still do not move, and the reason is upstream: they are all `hue`
(`mix-blend-hue`, `bg-blend-hue`), and `vello_cpu` 0.1's layer blend has a u8 fast path that returns
`None` for the non-separable modes — `hue`, `saturation`, `color`, `luminosity`, `color-dodge`,
`color-burn`, `soft-light` — and no float fallback for layers. So the blend is threaded and painted as
`Normal` in exactly those cases. `isolate`/`isolation-auto` are a scene question on top of it: both
need a blended child to isolate, which the staging does not give them.

## Open: the seven `mask-*-to-*` cells need an *opaque* other end, and that change cost more than it won

Measured in Chromium, the staged `mask-b-to-40` probe computes
`mask-image: …, linear-gradient(rgba(0,0,0,0) 0%, rgba(0,0,0,0) 160px), …` — both ends transparent,
because the companion that completes a `-to-*` unit is `mask-b-from-transparent`. The mask is therefore
transparent in *both* arms (the stripped arm keeps the companion), which is why those cells measure
"does nothing" rather than a mismatch.

Giving a `-to-*` unit an opaque other end (`mask-b-from-black`) does wake them — and costs six cells
elsewhere in the family (23/50 → 17/50), measured on the same run, so it was reverted. The next attempt
should change the companion for `-to-*` units and the *contrast* together: those cells' contrast is what
sets `mask-image: none`, and it has to keep doing so once the companion is opaque.

## Execution Phases

#### Phase 1: Blend modes
**Status:** PARTIAL
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render.rs`, `layers.rs`, `vendor/PATCHES.md`.

- [ ] Both blend properties and `isolation` reach the layer. proof: AC-1

#### Phase 2: Masks and clip paths
**Status:** PARTIAL
**Files:** `render/mask.rs`, `render/clip_path.rs`, `vendor/PATCHES.md`.

- [ ] Gradient masks compose, and luminance mode paints. proof: AC-2
- [ ] `inset()` takes its radius. proof: AC-3

#### Phase 3: Profile opens
**Status:** PARTIAL
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [ ] The rows leave the denylist, the guide lists the families, and the floor rises. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` plus `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-845`: **9 of 56 units pass**
across the three groups, 36 cells do not discriminate.

- **Masks: 9 of 50 pass, 33 do not discriminate.** Two separate things, and the first matters more. The scene
  reports a smaller number than an earlier run because that run counted *vacuous matches*: both renderers painted
  an unclipped box, the whole-cell luminance bar saw nothing, and 25 cells read as passes; nine still pass with the honest measure. The measure is now
  colour-aware and scored over the probe, so it no longer accepts those. Staging is the other half:
  `mask-linear-0` alone is a one-stop gradient — a solid image that hides nothing — and the stops are other
  units, so a mask unit needs them as companions. Adding `mask-linear-from-20%`/`to-80%` as companions on both
  arms made it worse (40 of 50 stopped discriminating) because the mask then hid the probe in both arms; the
  staging that works is per-unit and is not written yet.
- **Blend: 0 of 4 pass, 3 do not discriminate.** `mix-blend-hue` scores 0.5069: `blitz-paint` never reads
  `mix-blend-mode` and `layers.rs` hardcodes `Mix::Normal` in `maybe_push_layer`. A patch that threads the
  computed mode was written and then **reverted unproven**: it compiled — the styles field's type is
  `style::properties::longhands::mix_blend_mode::computed_value::T`, and peniko 0.6.1's `Mix` has no
  `plus-lighter` (its `PlusLighter` belongs to `Compose`, so CSS's `plus-lighter` was mapped to `Screen`) — but
  `mix-blend-hue` still measured 0.5069, so the mode was not reaching the pixels through that path. Landing a
  vendor hunk nothing proves is what `vendor/PATCHES.md` forbids, so the next attempt starts from here rather
  than from a claim. `bg-blend-*` needs two background layers on the probe; `isolate`/`isolation-auto` need a
  blended child to isolate, so those three are staging.
- **Clip: 0 of 2, and neither is non-discriminating** — both measure a real mismatch. `clip-path` with an
  `inset()` radius is `render/clip_path.rs`'s upstream TODO.
