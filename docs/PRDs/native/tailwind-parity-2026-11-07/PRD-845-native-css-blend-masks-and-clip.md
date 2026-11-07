# PRD-845 — native-css composites blend modes, masks and clip paths like Chromium

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render.rs`, `layers.rs`, `vendor/PATCHES.md`.

- [ ] Both blend properties and `isolation` reach the layer. proof: AC-1

#### Phase 2: Masks and clip paths
**Status:** NOT STARTED
**Files:** `render/mask.rs`, `render/clip_path.rs`, `vendor/PATCHES.md`.

- [ ] Gradient masks compose, and luminance mode paints. proof: AC-2
- [ ] `inset()` takes its radius. proof: AC-3

#### Phase 3: Profile opens
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/native-css-compat.ts`, its spec, `docs/guides/native-css-support.md`, `corpus/tailwind-parity.floor.json`.

- [ ] The rows leave the denylist, the guide lists the families, and the floor rises. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` plus `parity:tailwind --ratchet`
