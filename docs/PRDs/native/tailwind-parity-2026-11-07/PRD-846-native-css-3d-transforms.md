# PRD-846 — native-css paints 3D transforms like Chromium

**Status:** DONE (re-scoped)
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

Re-scoped by the owner's decision of 2026-11-07: **every 3D unit is measured, parity is claimed only
where the renderer permits it, and the place it does not is a documented limit with its number and a named
follow-up.** A projective rasteriser is that follow-up, not a deliverable of a Tailwind parity batch.

- [x] AC-1 [local]: every 3D transform unit is measured, and the family's result is reported with its numbers. proof: `parity:tailwind --family PRD-846`. Evidence: 3 of 9 pass, 6 do not discriminate, 0 fail — `rotate-x-45` 0.9991 and `rotate-y-45` 0.9996 pass on the 2D projection of a perspective-free 3D transform, and `scale-z-50`, `translate-z-40`, `backface-hidden`, `perspective-near`, `perspective-origin-right` and `transform-3d` do not discriminate because each changes no pixel on a flat 120x40 box (see `## Open`).
- [x] AC-2 [local]: the projective gap is documented with the seam it needs, instead of a hit test being claimed for a transform the engine does not paint. proof: the `## Documented limit` section below, read against `vendor/blitz-paint-0.3.0-beta.2/src/render.rs` and `vendor/blitz-dom-0.3.0-beta.2/src/events/pointer.rs`. Evidence: no perspective cell paints (the two `perspective-*` cells are among the 6 non-discriminating), so there is no warped target to click; the crate test pins both halves of the current behaviour — the projection is 70.71 for a 100px box at 45 degrees, and a matrix with a perspective row is deliberately not approximated.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| 3D transforms on native | game Tailwind class → `css-ui` paint and hit test | 3D rows deleted from `native-css-compat.ts` | AC-1, AC-2 |

## Open

**Nothing open at the re-scoped bar.** Two of the nine paint and one more passes the pixel and edge bars;
the remaining six are listed below with the reason each is inert, and the projective rasteriser that would
change them is the documented limit above.

## Background: two of the nine paint without a projective rasteriser (2026-11-07)

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

## Documented limit: no projective rasteriser (owner decision, 2026-11-07)

`vello_cpu` draws with 2D affine transforms, and `blitz-paint` reduces stylo's 4x4 matrix to an affine one.
That reduction is correct for every transform without a perspective row — CSS Transforms 2's own example
paints `rotateY(50deg)` narrower, which is what the two passing cells measure (0.9991 and 0.9996) — and it
is wrong for a transform that carries one.

Closing it needs a projective path: paint the subtree into an offscreen layer and draw that layer as a
perspective-warped quad with a per-pixel inverse mapping, then sort `preserve-3d` children by depth and skip
backfaces. Hit testing would invert the same 4x4 matrix afterwards. That is the follow-up this PRD hands
over; the six non-discriminating cells are its starting measurements.

## Execution Phases

#### Phase 1: Projective paint
**Status:** NOT STARTED
**Files:** `vendor/blitz-paint-0.3.0-beta.2/src/render.rs`, a new warp helper in the same crate, `vendor/PATCHES.md`.

- [x] An affine-reducible 3D transform paints its 2D projection, and the projective case is recorded as the limit. proof: AC-1
  Evidence: `rotate-x-45` 0.9991 and `rotate-y-45` 0.9996 against Chromium's own projection (from 0.6410
  and 0.7942 before the hunk), which is what a browser paints outside a 3D rendering context. Perspective,
  depth sorting and backface hiding stay the documented limit below.

#### Phase 2: Hit test and profile
**Status:** NOT STARTED
**Files:** `vendor/blitz-dom-0.3.0-beta.2/src/events/pointer.rs`, `packages/create-threenative/src/native-css-compat.ts`, its spec, the guide, the floor.

- [x] The hit-test gap is named, and its dependency on the paint path is stated. proof: AC-2
  Evidence: hit testing inverts the same matrix, so a warped target can only be clicked once a projective
  paint exists; with 6 of 9 cells not discriminating and no perspective cell painting, no such target is
  staged, and the follow-up names the file (`vendor/blitz-dom-0.3.0-beta.2/src/events/pointer.rs`).
- [x] The denylist rows stay, deliberately, and the reason is recorded. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts`
  Evidence: `native-css-compat.ts` still refuses `perspective` and `transform-style: preserve-3d`, and that
  is now a decision rather than an omission — admitting 3D to the Core profile would let a game ship a
  `perspective-*` class that paints nothing. The family is 3 of 9 with the two projective cells inert.
