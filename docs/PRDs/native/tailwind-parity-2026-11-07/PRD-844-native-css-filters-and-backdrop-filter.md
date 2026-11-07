# PRD-844 — native-css paints Tailwind filters and backdrop filters like Chromium

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** `native/css-ui/Cargo.toml`, `native/css-ui/vendor/anyrender_vello_cpu-0.17.0/src/{scene,filters}.rs`, `vendor/PATCHES.md`.

- [ ] The `filters` feature is on, filter chains run every function, and colour-matrix filters paint. proof: `cargo test -p threenative-css-ui` plus AC-1
- [ ] Filters still paint with `multithreading` on. proof: `cargo test -p threenative-css-ui --features multithreading`

#### Phase 2: Backdrop filter
**Status:** NOT STARTED
**Files:** the vendored `scene.rs`, `vendor/blitz-paint-0.3.0-beta.2/src/layers.rs`.

- [ ] Backdrop filters sample and filter what lies under the layer. proof: AC-2

#### Phase 3: Profile opens
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [ ] The filter rows leave the denylist, the guide lists filters as proven, and the meter floor rises. proof: AC-3 and `parity:tailwind --ratchet`
