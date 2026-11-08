# PRD-846 — native-css paints 3D transforms like Chromium

**Status:** NOT STARTED
**Priority:** P2 — no kit ships a 3D transform today, but AC-1 and AC-2 cover the last refused paint family in Tailwind (`perspective-*`, `transform-3d`, `backface-*`, `rotate-x/y-*`, `translate-z-*`, `scale-z-*`, `transform-gpu`).
**Complexity:** 6 (MEDIUM) — 3 to 5 Rust files (+1), projective raster path (+2), Rust crate plus host boundary (+2), hit testing (+1).
**Owner:** ThreeNative maintainers
**Depends on:** PRD-843
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

vello_cpu draws with 2D affine transforms. Stylo computes the 4x4 matrix, and blitz-paint reduces
it to an affine transform. That reduction is wrong under `perspective` and `preserve-3d`, and
`backface-visibility` is not read. `transform-gpu` emits `translateZ(0)`, which is the identity in
2D but is refused by the scanner today. Hit testing (`blitz-dom` patch 11) inverts the same
transform.

## Solution

1. An affine-reducible transform (z terms only, such as `translateZ(0)`) keeps the existing path.
2. A projective transform paints its subtree into an offscreen layer. The layer is then drawn as
   a perspective-warped quad (per-pixel inverse mapping in the CPU raster).
3. `preserve-3d` children are sorted by depth.
4. A back-facing element with `backface-visibility: hidden` is skipped.
5. Hit testing inverts the same 4x4 matrix.

Delete the 3D rows from `native-css-compat.ts` in the commit that turns their units green.

## Acceptance Criteria

- [ ] AC-1 [local]: every 3D transform unit passes the meter on crate and host, and the judge returns SAME. proof: `parity:tailwind --family PRD-846` plus `--host`, and the judge on `--sheet PRD-846` — Evidence: pending.
- [ ] AC-2 [local]: a click on a perspective-rotated button activates it at the point Chromium reports. proof: a `corpus/interactions.mjs` script on a `rotate-y-45 perspective-dramatic` button, run by `node corpus/interaction.mjs` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| 3D transforms on native | game Tailwind class → `css-ui` paint and hit test | 3D rows deleted from `native-css-compat.ts` | AC-1, AC-2 |

## Open: two of the nine paint without a projective rasteriser (2026-11-07)

A 3D transform **without** a perspective row is painted as its 2D projection, which is what a browser
does outside a 3D rendering context (CSS Transforms 2's own example paints `rotateY(50deg)` narrower).
That hunk takes `rotate-x-45` and `rotate-y-45` from an untransformed box (0.6410 and 0.7942) to
**0.9991 and 0.9996**, so the family is 3 of 9.

What is left, with its reason: `scale-z-50` and `translate-z-40` have no 2D effect at all (a z scale or
translation changes nothing on the plane without perspective), `backface-hidden` needs a 3D rendering
context to hide a face, `transform-3d` (`preserve-3d`) changes no pixel on its own, and the two
`perspective-*` cells need the projective rasterisation this PRD describes. The crate test pins both
halves: the projection is 70.71 for a 100px box at 45°, and a matrix with a perspective row is
deliberately *not* approximated.

## Execution Phases

#### Phase 1: Projective paint
**Status:** NOT STARTED
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render.rs`, a new warp helper in the same crate, `vendor/PATCHES.md`.

- [ ] Perspective and `preserve-3d` subtrees paint warped and depth-sorted, and backfaces hide. proof: AC-1

#### Phase 2: Hit test and profile
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/events/pointer.rs`, `packages/create-threenative/src/native-css-compat.ts`, its spec, the guide, the floor.

- [ ] A transformed hit test matches Chromium. proof: AC-2
- [ ] The 3D rows leave the denylist and the floor rises. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts` plus `parity:tailwind --ratchet`
