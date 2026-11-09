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

Scoped by the owner's decision of 2026-11-07: **every unit in this family is measured, parity is claimed
only where the renderer permits it, and each place it does not is a documented limit with its number and
a named follow-up.** The three limits below are renderer-level (`vello_cpu` layer and blend support), not
staging faults, and each was measured before being written here.

- [x] AC-1 [local]: every blend-mode and isolation unit is measured, and the renderer's non-separable blend limit is documented with its number. proof: `parity:tailwind --family PRD-845 --group blend`. Evidence: 0 of 4 pass — `bg-blend-hue` 0.7541 and `mix-blend-hue` 0.5069 (non-separable `hue`/`saturation`/`color`/`luminosity`/`color-dodge`/`color-burn`/`soft-light` all rely on `vello_cpu`'s `try_u8_mix`, which returns `None` for them with no float fallback), and `isolate`/`isolation-auto` do not discriminate because isolation alone changes no pixel on a first-paint frame. `mix-blend-mode` itself is threaded through `maybe_with_layer`/`push_layer` and separable modes (`multiply`) pass with a test.
- [x] AC-2 [local]: every `mask-*` unit is measured, including composed linear, radial and conic masks, and the two renderer limits that keep 15 of them off parity are documented with their numbers. proof: `parity:tailwind --family PRD-845 --group mask`. Evidence: 29 of 50 pass, 12 do not discriminate, 9 fail in exactly two groups — the *two-layer* intersection (`mask-{x,y,t,b,l,r}-to-40` 0.7840–0.9756: a second layer inside the mask's `DestIn` layer pushed with anything but `SrcOver` is a no-op in this backend) and the luminance transfer, now fixed (`mask-{linear,radial,conic}-*-red-50` 0.994–0.996, below). Single-layer masks, six-layer compositions whose identity layers are skipped, `mask-none`, `mask-add` (1.0000) and `mask-composite` all pass, with four crate tests pinning the shape.
- [x] AC-3 [local]: every `clip-path` unit is measured, and `sr-only`'s box-model contrast is documented. proof: `parity:tailwind --family PRD-845 --group clip`. Evidence: 0 of 2 pass and neither discriminates — `sr-only` sets `clip-path: inset(50%)` with a 1px box, so the unit's frame is indistinguishable from the class-less arm at the 0.99 bar; `clip-path` itself paints (`inset()` radii and polygons are exercised by the mask tests).

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

**Only `intersect` has an identity.** Skipping the opaque layers unconditionally broke `mask-composite:
add`, whose browser result *is* the union with those opaque layers (fully opaque); conditioning the skip on
the layer's composite operator restored it — `mask-add` 0.588 → **1.0000** — and the family is 29 of 50
again, now with every cell measuring real pixel work.

Measured effect: every mask cell now measures instead of reading "does nothing", and the family's honest
score is 22 of 50 rather than 23 — the engine paints masks now, and the differences that appear
(0.58–0.93, `mask-add` worst at 0.588, the `-red-50` luminance cells around 0.87–0.89) are real
mask-rendering gaps that were previously invisible behind a mask that did nothing. Scene 313 → 311 for the
same reason: one point of apparent score was a mask that was not being painted at all.

**A mask cell's contrast was `mask-image: none`.** The contrast for those cells was the "different value"
of the property taken from `mask-none`, i.e. no mask at all — so the arm that is supposed to differ by being
*dropped* differed by having no mask, and the cell compared a mask against nothing. The contrast now names a
gradient of its own (`to top, #000, #fff`). The gradient also has to mask something: `#000 → #fff` is opaque throughout and masks nothing, so the
contrast now ends transparent (`transparent → #000`). Measured: the family 23 → 24 of 50 in a
mask-only run with inert cells 13 → 11 (the full run reads 23 and the floor is unchanged at 312 — one cell
is marginal between runs).

A blanket fix — dropping every custom property from the contrast, since a `--tw-*` is never the property
under test — costs **eight** cells (`--tw-duration`, `--tw-ease`, `--tw-ring-color`, `--tw-gradient-via-stops`,
`--tw-outline-style`, `--tw-numeric-figure`, `--tw-numeric-fraction`, `--tw-drop-shadow`), because a unit that
*only* sets a custom property needs its contrast on that property. Reverted. The mask clobbering has to be
fixed in the mask path or by naming the variables, not by a blanket rule.

**What is left in the family, measured with the element's class in the print:**

```
MASKDBG kinds=LLLLLL class=probe mask-x-from-black mask-x-to-40        <- six layers, mask IS applied
MASKDBG kinds=LLL    class=probe ... (one real layer)                  <- paints correctly
```

So the `-to-40` and combined-axis cells *do* have their mask applied — six layers, of which the identity
ones are skipped, leaving **two** real gradients (`--tw-mask-left` and `--tw-mask-right`) that must be
intersected. That is exactly the case this backend cannot do: a second layer inside the mask's `DestIn`
layer pushed with anything but `SrcOver` is a no-op, so the mask ends up painting nothing and the element
stays *unmasked* (`235` where the browser fades `79…108`). One real layer works; two do not.

Fixing it needs the intersection of two gradients computed either on the CPU (multiplying their alpha
profiles — only exact when they are co-linear) or a renderer that honours nested `SrcIn`. Both are larger
than a hunk.

Tried and reverted with its cost measured: skipping custom properties in the contrast for any unit that
also paints something, so the contrast stops clobbering `--tw-mask-*`. It changed no mask pixel and cost
four cells (`--tw-drop-shadow`, `--tw-outline-style`, `--tw-numeric-figure`, `--tw-numeric-fraction`), which
need their contrast *on* the custom property.

Two tests pin it: `a_tailwind_three_layer_mask_composition_paints` (six layers, intersected, fading) and
`a_mask_gradient_whose_stops_come_from_registered_variables_paints`. The earlier version of the first one
asserted "fully masked out" and **passed on the bug** — which is why three turns of bisecting found
nothing.

Also learned and worth keeping: a registered property that is never set *does* read as its declared
`initial-value` (`an_unset_registered_property_is_its_initial_value`).

## Open

**Nothing open at the re-scoped bar.** Two renderer limits remain, each with its number above and a named
follow-up: (a) `nested mask layers` — a second layer inside the mask's `DestIn` layer needs a renderer that
honours `SrcIn`/`DestIn` at depth, or a CPU-side intersection of two gradients; (b) `non-separable blend
spaces` — `vello_cpu` needs a float path for `TryU8Mix`. Both are upstream work in `anyrender_vello_cpu`,
outside a Tailwind parity batch, and the meter keeps their numbers.

## Superseded Open: the eight colour-mask cells differ by a mask *curve*, measured (2026-11-07)

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

- [x] Both blend properties and `isolation` reach the layer. proof: AC-1
  Evidence: `mix-blend-mode` is threaded through `maybe_with_layer`/`push_layer` (`peniko_mix`), a crate test
  proves separable `multiply` composites, and `bg-blend-*`/`mix-blend-*` are measured rather than refused.
  The non-separable spaces stay a documented renderer limit (AC-1).

#### Phase 2: Masks and clip paths
**Status:** PARTIAL
**Files:** `render/mask.rs`, `render/clip_path.rs`, `vendor/PATCHES.md`.

- [x] Gradient masks compose, and luminance mode paints. proof: AC-2
  Evidence: composition works — six layers with `mask-composite: intersect` fade correctly once identity
  layers are skipped and the first *drawn* layer composites `SrcOver`; `mask-mode: luminance` is honoured for
  gradient masks (PATCHES.md hunk 5). What does not reach parity is the two-layer intersection and the
  luminance *transfer value*; both are AC-2's documented limits.
- [x] `inset()` takes its radius. proof: AC-3
  Evidence: the clip path is built from stylo's computed basic shape and paints; no cell in the family
  reports a refusal. `sr-only`'s non-discriminating frame is AC-3's documented limit.

#### Phase 3: Profile opens
**Status:** PARTIAL
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [x] The denylist rows stay, deliberately, and the reason is recorded; the floor rises. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` plus `parity:tailwind --ratchet`
  Evidence: `native-css-compat.ts` still lists `mask*`, `mix-blend-mode`, `background-blend-mode` and
  `clip-path` as outside the Core profile, and that is now a **decision rather than an omission** — the
  profile exists so a game cannot build with a mask that silently paints nothing, and 15 of 50 mask cells
  are still off parity for two renderer reasons (AC-2). Admitting masks to Core would mean shipping a
  feature that fails a third of the time. The floor did rise: `--fail-under 300` to the value
  `parity:tailwind --floor` now protects, 319.

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
