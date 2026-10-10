# PRD-592 — Terrain core fails closed and erodes without allocating

**Status:** PARTIAL
**Priority:** P2 — Bad bake options produce NaN cells silently, and hydraulic erosion allocates about 8 million objects per layer, which slows every bake, including PRD-584's (AC-1 to AC-5).
**Complexity:** 3 (LOW); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Package audit of `2d2124792` (2026-10-10), `packages/terrain/src/core/`:

- `world-package.ts` `placementCells` / `bakeWorldPackage`: `cellSize` 0 gives `across = Infinity`;
  a negative or NaN `cellSize` or a NaN position gives a `"NaN,NaN"` cell key. Out-of-extent
  placements are clamped into edge cells, not reported. `placementRecord` checks rotation and scale
  but not position.
- `io.ts:~273` `decodeHeightPNG`: `JSON.parse` of the metadata chunk is not checked to be an
  object; `null` throws a plain `TypeError`, not the documented error.
- `erosion.ts`: `thermal` divides by `n - 1` (Infinity at `n < 2`); `droplets` and iterations
  have no proven upper bound.
- `operations.ts`: `scatter` defaults `asset ?? "pine"` and `count ?? 300`, a hidden content
  default in a package (root `AGENTS.md` "never own the look"); `s.instances.push(...accepted)`
  can overflow the stack at large counts.
- Hot loops: hydraulic `get()` returns a new object twice per droplet step (default `n*n` droplets
  × up to 64 steps ≈ 8 M objects per layer at `n = 257`); `thermal` builds a 4-element array per
  cell per iteration; `splatBytes` runs `COMPONENTS.indexOf` in its innermost loop.
- `math.ts` `hashString` hashes only the first UTF-16 unit of astral characters. Changing it moves
  existing placements, so it needs a golden hash first.

## Solution

Pin golden hashes of one bake per kit first. Then validate options and fail by name; require
`scatter.asset`; replace the spread push; rewrite the erosion and splat inner loops with scratch
state and precomputed indices so that output bytes stay identical. Record bake time before and
after on the same host.

## Acceptance Criteria

- [x] AC-1 [local]: Golden hashes of each kit's bake are pinned and unchanged by this PRD. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` — Evidence: rebuilt candidate passes 9 starter-kit tests, including 20 pinned hashes across forest, alpine, coastal, desert and tundra; parent ran terrain build before the golden tests.
- [x] AC-2 [local]: `bakeWorldPackage` throws by name for `cellSize` 0, -1 and NaN, a NaN position and an out-of-extent placement. proof: `world-package.spec.ts` cases — Evidence: verified 6/6 tests passing in `packages/terrain/__tests__/world-package.spec.ts`.
- [x] AC-3 [local]: `decodeHeightPNG` rejects `null`/number metadata, a truncated chunk and a bad CRC with the documented error. proof: new `io.spec.ts` — Evidence: verified 4/4 tests passing in `packages/terrain/__tests__/io.spec.ts`.
- [x] AC-4 [local]: A scatter layer without `asset` fails validation. proof: `validation` spec case — Evidence: verified in `packages/terrain/__tests__/terrain-consumer.spec.ts` rejecting scatter without asset.
- [ ] AC-5 [local]: Forest kit bake time drops by at least 30 % on the same host, with identical bytes. proof: `/usr/bin/time -v node packages/terrain/starter/forest/bake.mjs`, three runs per arm — Evidence: pending.

## Execution Phases

#### Phase 1: golden bytes and validation
**Status:** PARTIAL
**Files:** `packages/terrain/src/core/{world-package,io,validation,operations,erosion}.ts`, specs
- [x] Golden hashes pinned. proof: `starter-kit.spec.ts` (pass, verified 5/5 starter kits with 4 pinned sha256 hashes each against HEAD baseline byte-for-byte)
- [ ] Bad options throw by name. proof: `world-package.spec.ts`, `io.spec.ts`, validation spec, `erosion-bounds.spec.ts` — 252 terrain tests and package/workspace typecheck pass; finite/noninteger checks and zero/large-grid defaults pass. Remaining: establish a compatible practical upper bound on hydraulic droplets; a finite-integer guard alone does not bound bake work.

#### Phase 2: allocation-free loops
**Status:** NOT STARTED
**Files:** `packages/terrain/src/core/erosion.ts`, `world-package.ts`, `operations.ts`
- [ ] Same bytes, faster bake. proof: golden spec + timed bake

Parent verification (2026-10-10): `pnpm exec vitest run packages/terrain/__tests__` passed 34 files / 252 tests; `pnpm --filter @threenative/terrain typecheck`, `pnpm typecheck`, terrain build and Biome checks passed (14 warnings, no errors). The original 513-grid droplet-cap regression failed with `RangeError` before repair and the new bounds spec covers 513/1025 defaults after repair. Phase 1 remains partial until the hydraulic work bound is proven; phase 2 and the three-runs-per-arm 30% speed proof remain unrun.
