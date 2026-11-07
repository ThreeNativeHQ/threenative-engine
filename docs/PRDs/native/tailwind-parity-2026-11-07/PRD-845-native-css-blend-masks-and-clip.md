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
- **Blend: 0 of 4 pass, 3 do not discriminate.** `mix-blend-hue` scores 0.5069 and fails: `blitz-paint` never reads `mix-blend-mode`, and
  `layers.rs` hardcodes `Mix::Normal` in `maybe_push_layer`. The fix is to thread the computed blend mode to that
  call — five call sites — and to give the probe a coloured backdrop for the unit to blend with. `bg-blend-*`
  needs two background layers on the probe; `isolate`/`isolation-auto` need a blended child to isolate, so those
  three are staging.
- **Clip: 0 of 2, and neither is non-discriminating** — both measure a real mismatch. `clip-path` with an
  `inset()` radius is `render/clip_path.rs`'s upstream TODO.
