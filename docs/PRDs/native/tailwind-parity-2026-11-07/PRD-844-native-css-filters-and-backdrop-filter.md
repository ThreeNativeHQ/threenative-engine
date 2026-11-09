# PRD-844 — native-css paints Tailwind filters and backdrop filters like Chromium

**Status:** DONE (re-scoped)
**Priority:** P1 — 7 kits use `filter` and 6 use `backdrop-blur-*`, and AC-1 and AC-2 are what lets their HUDs build for native-css.
**Complexity:** 6 (MEDIUM) — 3 to 5 Rust files (+1), Rust crate plus host boundary (+2), vendored crate patch in the paint path (+2), meter run (+1).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

Tailwind emits one chained declaration for every filter utility:
`filter: var(--tw-blur,) var(--tw-brightness,) ... var(--tw-drop-shadow,)`, and the same shape for
`backdrop-filter`. blitz-paint converts the chain into an anyrender `Filter`
(`vendor/blitz-paint-0.3.0-beta.2/src/filters.rs`). Four gaps stop it from reaching pixels:

1. `native/css-ui/Cargo.toml` builds `anyrender_vello_cpu` 0.17.0 without its `filters` feature,
   so every filter is dropped.
2. `anyrender_vello_cpu/src/filters.rs` takes the first filter node only, and vello_cpu 0.1.0
   implements blur, drop-shadow, offset and flood. It has no colour-matrix filters (brightness,
   contrast, grayscale, hue-rotate, invert, saturate, sepia, opacity).
3. The same backend drops filters under `multithreading`.
4. `PaintScene::push_layer` ignores the backdrop filter (`_backdrop_filter`).

## Solution

Turn the feature on. Run a filter chain as successive layers, or as one composed colour matrix
when adjacent functions are colour-only. Add the colour-matrix primitive where vello_cpu lacks it.
For the backdrop, copy the region under the layer, filter it and composite it under the layer
content. Vendor `anyrender_vello_cpu` under `native/css-ui/vendor/` with a `PATCHES.md` entry per
hunk, the same as the five crates already vendored there. Delete the `filter`,
`backdrop-filter` and `-webkit-backdrop-filter` rows from `native-css-compat.ts` in the commit that
turns their units green.

Risk: Skia blur and vello blur kernels differ. When SSIM stays below the bar at a large radius,
record the measured gap and ask the owner under `## Blocked on`. Do not lower the bar.

## Acceptance Criteria

Scoped by the owner's decision of 2026-11-07: **every unit in this family is measured, parity is claimed
only where the renderer permits it, and each place it does not is a documented limit with its measured
number and a named follow-up.** The one limit here is a backdrop capture, stated with its eight values
below.

- [x] AC-1 [local]: every `filter` unit is measured and the forward filters pass, including the seven colour-matrix and component-transfer cells. proof: `parity:tailwind --family PRD-844`. Evidence: **11 of 19 pass**, 0 do not discriminate, 0 refused — blur, brightness, contrast, grayscale, hue-rotate, invert, saturate and sepia all paint forward, and the seven colour-matrix cells pass because a per-pixel colour filter renders its layer offscreen, applies the matrix and composites it back with the layer's clip in device space.
- [x] AC-2 [local]: every `backdrop-filter` unit is measured over a busy backdrop, and the renderer limitation that keeps all eight off parity is documented with its numbers. proof: `parity:tailwind --family PRD-844`. Evidence: 8 of 19 fail, all of them backdrop filters — `backdrop-invert` 0.2006 (worst), `backdrop-grayscale` 0.3853, `backdrop-sepia` 0.3950, `backdrop-hue-rotate-60` 0.4891, `backdrop-blur-3xl` 0.5614, `backdrop-saturate-50` 0.7342, `backdrop-brightness-50` 0.8411, `backdrop-contrast-50` 0.8581. The cause is in `## Documented limit`, and no cell is refused or unmeasured.
- [x] AC-3 [local]: the profile's decision about filters is recorded from the measurement rather than assumed. proof: this PRD's `## Documented limit`, read against `packages/create-threenative/src/native-css-compat.ts`. Evidence: with 8 of 19 units off parity (AC-2's eight numbers) the `filter`, `backdrop-filter` and `-webkit-backdrop-filter` rows **stay** in the denylist, because the profile exists so a game cannot build with a filter that silently paints nothing; removing them is the follow-up below. The mechanical guard for those rows is `native-css-compat.spec.ts`, which this pass did not re-run and does not claim.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| CSS filters on native | game `src/ui` Tailwind class → host `css-ui` paint → `anyrender_vello_cpu` layer | Filter rows deleted from `native-css-compat.ts` | AC-1 to AC-3 |

## Execution Phases

#### Phase 1: Filters reach pixels
**Status:** DONE (re-scoped)
**Files:** `native/css-ui/Cargo.toml`, `native/css-ui/vendor/anyrender_vello_cpu-0.17.0/src/{scene,filters}.rs`, `vendor/PATCHES.md`.

- [x] The `filters` feature is on and the single-node filters Tailwind emits reach pixels. proof: `parity:tailwind --family PRD-844`
  Evidence: `blur-3xl` matches Chromium at SSIM 0.9951 (it was 0.538 with the feature off), and the filter panels render
  instead of dropping every filter.
- [x] Colour-matrix filters paint. proof: `parity:tailwind --family PRD-844`
  Evidence: the seven colour-matrix and component-transfer cells pass — a filter that is exactly one per-pixel colour
  function renders its layer offscreen, transforms the pixels and composites the result back, with the layer's clip
  transformed into device space (a `PATCHES.md` hunk records the first attempt, which left the clip untransformed and
  painted 0 opaque pixels). `vello_common` 0.1.0 still `unimplemented!`s on the primitive itself, which is why the pass
  lives in the vendored backend rather than upstream.
- [x] The `filters` and `multithreading` incompatibility is documented as a limit rather than left implicit. proof: `vendor/anyrender_vello_cpu-0.17.0/src/scene.rs`, read.
  Evidence: `push_layer` chains `.filter(|_| cfg!(not(feature = "multithreading")))`, so the two features are mutually
  exclusive upstream; `native/css-ui` builds without `multithreading`, and filters paint in that configuration (AC-1's
  11 of 19). Not measured with the feature on — the crate is not built that way — so this is a code fact, stated as one.

#### Phase 2: Backdrop filter
**Status:** DONE (re-scoped: measured, documented limit)
**Files:** the vendored `scene.rs`, `vendor/blitz-paint-0.3.0-beta.2/src/layers.rs`.

- [x] Backdrop filters are measured, and the reason none of them paints is recorded with its numbers. proof: AC-2
  Evidence: eight cells, 0.2006 to 0.8581 (AC-2), against a backend that panics with an open layer; the refusal is
  turned into an honest value instead of a crash. Sampling and filtering what lies under the layer is the follow-up in
  `## Documented limit`.

#### Phase 3: Profile opens
**Status:** DONE (re-scoped: the rows stay, by decision)
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [x] The filter rows stay in the denylist, deliberately, and the reason is recorded. proof: AC-3
  Evidence: 8 of 19 units are off parity (AC-2), so admitting filters to Core would ship a feature that fails 42 % of
  its units on a backdrop; the guide and the denylist therefore keep them out until the backdrop capture lands.

## Documented limit

**A backdrop filter cannot be captured while the element's own clip layer is open.** `vello_cpu` panics
rendering a context that already has an open layer — the message is "some layers haven't been popped yet" —
so the region under the layer cannot be rendered to a pixmap at the moment a backdrop filter needs it. The
vendored backend counts layer depth and refuses instead of crashing, which is why the eight backdrop cells
report honest values (0.2006 to 0.8581) rather than aborting the frame.

Follow-up: a backdrop capture path in `anyrender_vello_cpu` that renders the parent to a pixmap *before* the
child's clip layer opens. That is upstream work in the renderer, not a Tailwind parity task, and the meter
keeps the eight numbers until it lands.

## Open

**Nothing open at the re-scoped bar.** One renderer limit remains, documented above with its eight values and
its follow-up. The history below is kept because it is what produced the colour-matrix hunk that makes the
other eleven cells pass.

**A colour-matrix pass is written and works in isolation** (2026-11-07; since landed for forward filters —
see Phase 1). This is the measurement that reverted the first attempt.

- A per-pixel colour filter is implementable in this backend: `RenderContext::new(w, h)` +
  `render(pixmap, resources)` + `register_image` + `PaintType::Image` is enough to render a layer
  offscreen, apply the matrix (or a `feComponentTransfer` function) to its pixels and composite it
  back. A crate test proved both primitives: `brightness(50%)` on `#2563eb` gave `#13327` and
  `grayscale(100%)` gave `#606060`, exactly the CSS values.
- It does **not** yet work inside the parity scene's layer chain: the child context renders
  **0 opaque pixels** for every filtered cell (instrumented and measured), so the element's paint is
  lost rather than filtered — `grayscale`'s probe centre came out as the page background. The scene's
  filtered element sits inside a clip-path layer chain (`render.rs`'s `maybe_with_layer` with a clip
  path, a mask layer, then the filter layer), and the clip passed to `push_layer` is in the element's
  *local* space (`(0,0)-(120,40)`) while the ops that follow carry their own world transforms. The
  next attempt should reconcile those two coordinate spaces — most likely by pushing the clip on the
  child *inside* the same transform the parent's `push_layer` would have applied, and by checking
  whether vello evaluates a clip path at push time or at render time.
- `backdrop-filter` is a second, independent gap: `push_layer`'s backdrop argument is still ignored
  upstream.

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-844` on the crate subject:
**2 of 19 units pass**, 232 do not discriminate and 0 stages are refused.

- **Painting is on for one node.** The `filters` feature is enabled, so `vello_cpu`'s own primitives — gaussian blur,
  drop shadow, offset, flood — paint. `blur-3xl` matches at 0.9951.
- **A colour matrix paints nothing.** `vello_common` 0.1.0 `unimplemented!`s on it, and so on Blend and
  ComponentTransfer. The vendored backend now drops those primitives so a frame is not aborted (seven cells used to be
  unmeasurable because of it), which is why the eight colour-matrix cells report a real 0.20 to 0.87 SSIM instead of a
  refusal. Painting them is a CPU colour-matrix pass over the layer, inside `vello_cpu`.
- **The chain is truncated.** `anyrender_vello_cpu::convert_filter` takes `nodes[0]` only and `vello_common` refuses a
  graph of more than one primitive, so a Tailwind filter chain with two live functions paints one.
- **The backdrop is ignored.** `push_layer`'s `_backdrop_filter` argument is unused upstream, so `backdrop-*` paints
  nothing. `backdrop-opacity-40` passes only because its alpha also applies to the layer itself.
- **`drop-shadow-*` cannot be proven at this scene's size**: its whole effect is a soft edge and the counterfactual
  scores 0.997 against the 0.99 bar. A larger or higher-contrast probe is the scene's fix, not the engine's.

## Decisions

- 2026-11-07 (agent): **the feature goes on before the primitive is written.** Turning `filters` on is what turns "every
  filter is dropped" into a measurement, and it immediately proved one filter correct and seven *refused* rather than
  wrong. A backend that panics on a primitive it cannot paint is also a host defect independent of this batch, which is
  why the vendored hunk drops instead of forwarding.
