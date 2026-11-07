# PRD-844 — native-css paints Tailwind filters and backdrop filters like Chromium

**Status:** PARTIAL
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

- [ ] AC-1 [local]: every `filter` unit passes the meter on crate and host, and the judge returns SAME for every cell. proof: `parity:tailwind --family PRD-844` plus `--host`, and the judge verdict on `--sheet PRD-844` — Evidence: pending.
- [ ] AC-2 [local]: every `backdrop-filter` unit passes the same two checks over a busy backdrop (gradient plus text). proof: as AC-1 — Evidence: pending.
- [ ] AC-3 [local]: a game using `backdrop-blur-md` builds for native-css, and the scanner no longer lists filter properties. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| CSS filters on native | game `src/ui` Tailwind class → host `css-ui` paint → `anyrender_vello_cpu` layer | Filter rows deleted from `native-css-compat.ts` | AC-1 to AC-3 |

## Execution Phases

#### Phase 1: Filters reach pixels
**Status:** PARTIAL
**Files:** `native/css-ui/Cargo.toml`, `native/css-ui/vendor/anyrender_vello_cpu-0.17.0/src/{scene,filters}.rs`, `vendor/PATCHES.md`.

- [x] The `filters` feature is on and the single-node filters Tailwind emits reach pixels. proof: `parity:tailwind --family PRD-844`
  Evidence: `blur-3xl` matches Chromium at SSIM 0.9951 (it was 0.538 with the feature off), and the filter panels render
  instead of dropping every filter.
- [ ] Colour-matrix filters paint. proof: `parity:tailwind --family PRD-844` on the eight colour-matrix cells
  Evidence: NOT met. `vello_common` 0.1.0's `PreparedFilter::new` panics on a colour matrix (`unimplemented!`), so the
  vendored backend now drops the primitive instead of aborting the frame — the cells measure and report the real gap
  (SSIM 0.20 to 0.87 against the 0.99 bar) but nothing paints the colour transform. Painting it is a CPU colour-matrix
  pass over the layer, which needs vello_cpu itself, not this crate.
- [ ] Filters still paint with `multithreading` on. proof: `cargo test -p threenative-css-ui --features multithreading`
  Evidence: NOT met. `anyrender_vello_cpu`'s `push_layer` chains `.filter(|_| cfg!(not(feature = "multithreading")))`, so
  the feature and multithreading are mutually exclusive upstream. Confirmed by reading
  `vendor/anyrender_vello_cpu-0.17.0/src/scene.rs`; not measured, because the crate is not built with that feature.

#### Phase 2: Backdrop filter
**Status:** PARTIAL
**Files:** the vendored `scene.rs`, `vendor/blitz-paint-0.3.0-beta.2/src/layers.rs`.

- [ ] Backdrop filters sample and filter what lies under the layer. proof: AC-2

#### Phase 3: Profile opens
**Status:** PARTIAL
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [ ] The filter rows leave the denylist, the guide lists filters as proven, and the meter floor rises. proof: AC-3 and `parity:tailwind --ratchet`

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind --family PRD-844` on the crate subject:
**2 of 19 units pass**, 250 do not discriminate and 0 stages are refused.

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
