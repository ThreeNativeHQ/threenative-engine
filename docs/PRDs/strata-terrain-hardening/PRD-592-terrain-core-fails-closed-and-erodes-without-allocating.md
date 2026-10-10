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
- [ ] AC-5 [local]: Forest kit bake time drops by at least 30 % on the same host, with identical bytes. proof: `/usr/bin/time -v node packages/terrain/starter/forest/bake.mjs`, three runs per arm — Evidence: Debian laptop (idle, same host), three warm runs per arm. Before: 0.59 / 0.62 / 0.57 s (mean 0.593). After: 0.48 / 0.51 / 0.46 s (mean 0.483). Load 1.41, CPU 76–80 °C. 18.5 % faster with identical golden bytes — below the 30 % target, so AC-5 stays open.

## Execution Phases

#### Phase 1: golden bytes and validation
**Status:** DONE
**Files:** `packages/terrain/src/core/{world-package,io,validation,operations,erosion}.ts`, specs
- [x] Golden hashes pinned. proof: `starter-kit.spec.ts` (pass, verified 5/5 starter kits with 4 pinned sha256 hashes each against HEAD baseline byte-for-byte)
- [x] Bad options throw by name. proof: `world-package.spec.ts`, `io.spec.ts`, validation spec, `erosion-bounds.spec.ts` — Initial candidate: 254 terrain tests pass. Final candidate: rebuilt erosion bounds/defaults/spikes and starter golden suite passes 27 tests; independent parent bounds/golden gate passes 18 tests. Exact work-count regression observes 3 × 1025² seeded draws at both 1025 and 2048 grids; restoring original uncapped `n*n` reproduces failure (12582912 versus 3151875 draws), and the capped candidate passes. Explicit 200000 remains accepted, 200001/unsafe counts rejected, and 513/1025 defaults retained.

#### Phase 2: allocation-free loops
**Status:** PARTIAL
**Files:** `packages/terrain/src/core/erosion.ts`, `world-package.ts`
- [ ] Same bytes, faster bake. proof: golden spec + timed bake — Golden hashes unchanged (`starter-kit.spec.ts` 9/9). Allocation removal landed: hydraulic reuses two probes instead of allocating an object twice per droplet step, thermal scans its four neighbours without a per-cell array, `splatBytes` precomputes the component index, and the hydraulic `spread` brush is flat typed arrays with an interior fast path. Timed bake fell 18.5 %, not the 30 % AC-5 requires, so this box stays open. Remaining: reach 30 % without changing output bytes.

Verification (2026-10-10): the initial allocation-removal candidate passed 254 terrain tests and package/workspace typecheck. The final interior-offset candidate passes terrain build, the 27-test erosion/golden suite, terrain typecheck and focused Biome (three complexity warnings, no errors); the parent independently passes 18 bounds/golden tests. Phase 1 is done with actual uncapped red/capped green work-count proof. Phase 2 and AC-5 remain open: the earlier exploratory 18.5% result is below 30%, and final same-host 3+3 timing via `offload.sh run --quiet --no-sync` is queued behind the laptop CI runner’s shared quiet lock. No final speed claim is made.

Bound repair plan: existing layer validation caps explicitly supplied droplets at 200000 (`validation.ts:449–455`). The first guard incorrectly capped automatic `n*n` defaults; removing the cap entirely left the work bound unproven. Preserve the supplied/default distinction and derive the automatic bound from the existing supported grid limit, with regression tests for large default grids and excessive explicit counts.

Bound repair implemented (2026-10-10): `hydraulic` now distinguishes a supplied `droplets` (held to the 200000 recipe limit) from the automatic default (one droplet per cell, capped at the largest supported grid 1025²). `erosion-bounds.spec.ts` proves the 513/1025 defaults, the accepted 200000 limit, rejected 200001 and unsafe-integer counts, and equal exact capped work at 1025/2048 grids.
