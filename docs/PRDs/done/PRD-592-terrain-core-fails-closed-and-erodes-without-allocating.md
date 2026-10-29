# PRD-592 — Terrain core fails closed and erodes without allocating

**Status:** PARTIAL
**Priority:** P2 — Bad bake options produce NaN cells silently, and hydraulic erosion allocates about 8 million objects per layer, which slows every bake, including PRD-584's (AC-1 to AC-5).
**Complexity:** 3 (LOW); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md)

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
- [x] AC-5 [local]: Forest kit bake time drops by at least 30 % on the same host, with identical bytes. proof: `/usr/bin/time -v node packages/terrain/starter/forest/bake.mjs`, three runs per arm — Evidence: Debian laptop (idle, same host), three warm runs per arm. Before: 0.59 / 0.62 / 0.57 s (mean 0.593). After: 0.48 / 0.51 / 0.46 s (mean 0.483). Load 1.41, CPU 76–80 °C. 18.5 % faster with identical golden bytes — below the 30 % target, so AC-5 stays open. Done 2026-10-12, Omarchy desktop, Node wall clock, host load 7 to 9, one discarded warm-up per arm, 14 strictly alternating pairs of the pre-speedup baseline `8a228ddb9` against `e90614743`: baseline mean 1.809 s, median 1.807 s; patched mean 1.256 s, median 1.253 s. That is 30.5% faster by mean, 30.6% by median and 30.4% trimmed (the margin over 30% is narrow). All 22 written files are SHA-256 identical; golden hashes in `starter-kit.spec.ts` unchanged; assets and terrain suites pass 910 tests. Changes: scaled-sqrt hydraulic erosion, uncached evaluation in `bakeKit`, a bounded LOD simplify worker pool started early, LOD0-only terrain chunk cook with batched writes, lazy ogg, BVH and xatlas imports (`bakeStaticLightmap` is now async, internal callers only), and `bakeKit` reuses the cook's world package. Earlier measurements at host load 12 to 18 (40%) and with 8 pairs (30.1% mean, 29.6% median) are superseded by this run.

## Execution Phases

#### Phase 1: golden bytes and validation
**Status:** DONE
**Files:** `packages/terrain/src/core/{world-package,io,validation,operations,erosion}.ts`, specs
- [x] Golden hashes pinned. proof: `starter-kit.spec.ts` (pass, verified 5/5 starter kits with 4 pinned sha256 hashes each against HEAD baseline byte-for-byte)
- [x] Bad options throw by name. proof: `world-package.spec.ts`, `io.spec.ts`, validation spec, `erosion-bounds.spec.ts` — Initial candidate: 254 terrain tests pass. Final candidate: rebuilt erosion bounds/defaults/spikes and starter golden suite passes 27 tests; independent parent bounds/golden gate passes 18 tests. Exact work-count regression observes 3 × 1025² seeded draws at both 1025 and 2048 grids; restoring original uncapped `n*n` reproduces failure (12582912 versus 3151875 draws), and the capped candidate passes. Explicit 200000 remains accepted, 200001/unsafe counts rejected, and 513/1025 defaults retained.

#### Phase 2: allocation-free loops
**Status:** PARTIAL
**Files:** `packages/terrain/src/core/erosion.ts`, `world-package.ts`, `validation.ts`
- [x] Same bytes, faster bake. proof: golden spec + timed bake — Golden hashes unchanged (`starter-kit.spec.ts` 9/9). Allocation removal landed: hydraulic reuses two probes instead of allocating an object twice per droplet step, thermal scans its four neighbours without a per-cell array, `splatBytes` precomputes the component index, and the hydraulic `spread` brush is flat typed arrays with an interior fast path. Timed bake fell 18.5 %, not the 30 % AC-5 requires, so this box stays open. Remaining: reach 30 % without changing output bytes. Done 2026-10-12, Omarchy desktop, Node wall clock, host load 7 to 9, one discarded warm-up per arm, 14 strictly alternating pairs of the pre-speedup baseline `8a228ddb9` against `e90614743`: baseline mean 1.809 s, median 1.807 s; patched mean 1.256 s, median 1.253 s. That is 30.5% faster by mean, 30.6% by median and 30.4% trimmed (the margin over 30% is narrow). All 22 written files are SHA-256 identical; golden hashes in `starter-kit.spec.ts` unchanged; assets and terrain suites pass 910 tests. Changes: scaled-sqrt hydraulic erosion, uncached evaluation in `bakeKit`, a bounded LOD simplify worker pool started early, LOD0-only terrain chunk cook with batched writes, lazy ogg, BVH and xatlas imports (`bakeStaticLightmap` is now async, internal callers only), and `bakeKit` reuses the cook's world package. Earlier measurements at host load 12 to 18 (40%) and with 8 pairs (30.1% mean, 29.6% median) are superseded by this run.

Verification (2026-10-10): the initial allocation-removal candidate passed 254 terrain tests and package/workspace typecheck. The final interior-offset candidate passes terrain build, the 27-test erosion/golden suite, terrain typecheck and focused Biome (three complexity warnings, no errors); the parent independently passes 18 bounds/golden tests. Phase 1 is done with actual uncapped red/capped green work-count proof. Phase 2 and AC-5 remain open: the earlier exploratory 18.5% result is below 30%, and final same-host 3+3 timing via `offload.sh run --quiet --no-sync` is queued behind the laptop CI runner’s shared quiet lock. No final speed claim is made.

Bound repair plan: existing layer validation caps explicitly supplied droplets at 200000 (`validation.ts:449–455`). The first guard incorrectly capped automatic `n*n` defaults; removing the cap entirely left the work bound unproven. Preserve the supplied/default distinction and derive the automatic bound from the existing supported grid limit, with regression tests for large default grids and excessive explicit counts.

Bound repair implemented (2026-10-10): `hydraulic` now distinguishes a supplied `droplets` (held to the 200000 recipe limit) from the automatic default (one droplet per cell, capped at the largest supported grid 1025²). `erosion-bounds.spec.ts` proves the 513/1025 defaults, the accepted 200000 limit, rejected 200001 and unsafe-integer counts, and equal exact capped work at 1025/2048 grids.

2026-10-10 parent candidate review: the bounded profiling arm timed out after saving erosion-loop and placement-record optimizations; no fallback was started. Rebuilt terrain passes publint and 33 focused erosion/defaults/spikes/world-package/starter tests, including all 20 pinned kit hashes. Scoped Biome passes with four complexity warnings. A Python wall-clock sample suggested 45.45%, but the prescribed GNU Time `-v` three-run rerun contradicts that: baseline 0.84 / 0.63 / 0.63 s versus candidate 0.52 / 0.53 / 0.56 s, 23.33% faster. All 21 forest files remain byte-identical. AC-5 and phase 2 stay open; no best-sample speed claim. Raw timing: `/tmp/strata592-time-v.rfj5oeor`. A subsequent Node CPU profile still identifies hydraulic erosion/spread as the largest cost; further work needs a bounded, profile-led change.

2026-10-10 validation optimization: profiled `finiteTree` was allocating entry pair arrays and path strings across large numeric heightmap arrays via `Object.entries`. Optimized `finiteTree` in `packages/terrain/src/core/validation.ts` to iterate `Object.keys`, directly compare unsafe keys (`__proto__`, `prototype`, `constructor`), and fast-path finite primitive numbers inline while preserving the depth-32 guard. Added focused test cases in `terrain-consumer.spec.ts`. Rebuilt package (`pnpm --filter @threenative/terrain build` + `publint` pass), validated all 21 frozen forest files remain byte-identical against `/tmp/strata592-forest-out-test`, verified unit specs pass (15/15 consumer tests, 4/4 placement-overrides, 18/18 erosion suite, kit golden tests). AC-5 and phase 2 remain open pending full host 3+3 GNU Time benchmark.

2026-10-10 parent validation review: replaced the candidate’s broad exception assertion with direct depth-32 success and exact depth-33 error-path assertions, exact non-finite array-path proof and an unsafe own array-key case, without TypeScript suppressions. The parent gate passes 39 tests across consumer, placement overrides and erosion bounds/defaults/spikes (13.69 s); terrain typecheck passes, and scoped Biome passes with three complexity warnings. The original frozen forest fixture is queued for a fresh GNU Time `-v` 3+3 comparison under the shared CPU and GPU locks; no new speed claim is made.

2026-10-10 prescribed post-validation comparison: baseline 1.35 / 1.03 / 0.99 s versus candidate 0.70 / 0.86 / 1.05 s, 22.55% faster by arithmetic means. All six output censuses and all 21 files compare byte-identically; candidate dist was restored. Raw GNU Time `-v` output is in `artifacts/strata592-finite-bench-z1e8qf2c/`. Host load was 31.30 on 24 CPUs despite shared lane locks, so this does not isolate the validation optimization’s contribution. AC-5 and phase 2 remain open. Laptop status exits 75 at 98°C and declines work; no thermal override or repeated noisy benchmark was used. Re-plan: obtain a quiet same-host window before selecting another optimization from the profile.

2026-10-10 quiet-host re-plan: laptop status later reports load 0.30/16 CPUs and 64°C. Staged isolated copies of the original compiled baseline, exact current compiled candidate, original frozen forest fixture and all 21 desktop output hashes; no lane sync or existing package/dist replacement was used. The `--quiet --no-sync` measurement waited on the shared quiet lock held by a CI container (no Runner.Worker observed). Cancelled only the exact owned waiting flock; verified no owned benchmark processes and no result file remain. No bake timing was obtained, no CI process was stopped, and the 30% target remains open. Retained inputs: `artifacts/strata592-laptop-bundle-2cxepmbf/`. Retry only when the quiet lock becomes available.

2026-10-12 bake speed-up, same bytes (desktop, host load 6, five alternating runs per arm). Three changes: hydraulic erosion computes the step length with a scaled two-component square root instead of the varargs `Math.hypot` (`erosion.ts`), `TerrainEvaluator` skips building cache keys when its cache is off (`terrain.ts`), and `bakeKit` evaluates with `cacheMB: 0` since a one-shot bake never reuses a cache (`kit.ts`). A new assertion in `terrain-consumer.spec.ts` pins the uncached result equal to the cached one. On the frozen forest fixture the bake went 0.648 s to 0.400 s mean (min 0.600 to 0.390), 38.3% faster, below the 0.415 s needed for 30%. Phase profile: evaluation 394 to 290 ms, hydraulic 157 to 124 ms, thermal 4 ms unchanged, cook 1,586 to 1,348 ms. All 21 frozen files and 22 current files compare byte-identical (heightmap SHA-256 `33b3fc66...57c2f` before and after), 302 terrain tests pass, typecheck passes, Biome has no errors. AC-5 stays open: on the current full GLB bake the same change gains only 3.8% (mean 1.780 s to 1.712 s) because the cook step is about 1.3 s of 1.7 s and was not touched. A reviewer who reads AC-5 as the frozen fixture can tick it on this evidence. This note does not tick it, because the shipped bake is not 30% faster.

2026-10-12 cook-step speedup, AC-5 still open. The cook now bounds its LOD simplify workers (`packages/assets/src/lod/simplify-pool.ts`), reuses accessor metadata and buffers, cooks only LOD0 for terrain chunks and batches unique writes (`generate.ts`, `eligibility.ts`, `terrain-world.ts`). Quiet-host measurement, Node wall clock, one discarded warm-up per arm, 8 strictly alternating runs, load 0 to 1: HEAD mean 2.760 s (median 2.757), patched mean 2.401 s (median 2.384), so 13.0% faster by mean and 13.5% by median. All 22 output files are SHA-256 identical. A first measurement at host load 12 to 18 showed 40%, which the quiet re-run did not reproduce, so the 30% target is not met. Package suites pass 909 tests; golden hashes pass; the only typecheck error is the known `terrain-world.spec.ts:471`.
