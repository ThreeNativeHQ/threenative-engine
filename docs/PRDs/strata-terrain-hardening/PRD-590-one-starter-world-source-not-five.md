# PRD-590 — One starter-world source, not five copies

**Status:** PARTIAL
**Priority:** P2 — About 6 000 lines of near-copies across kits, fixtures and specs remain until AC-1 to AC-4 land; a fix in one kit misses the other four.
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Package and example audits of `2d2124792` (2026-10-10), diff lines measured against alpine:

- `packages/terrain/starter/*/bake.mjs`: five files of 118 lines that differ by 2 lines each.
- `starter/*/world.ts`: 335–413 lines each; desert differs from alpine by 34 lines, tundra by 67,
  coastal by 95. About 2 800 lines, mostly shared loader and streaming code.
- `examples/strata-terrain-preview/scripts/fixtures/kit-game/{Alpine,Desert,Tundra,Coastal,Forest}.ts`:
  2 651 lines; Alpine and Desert differ by 0 lines after a biome-name swap.
- `packages/terrain/__tests__/{alpine,coastal,desert,tundra}-runtime.spec.ts` (335–346 lines,
  about 75 % identical) and the four `*-kit.spec.ts` files (61–74 lines): about 1 400 lines.
- Inverted dependency: seven `packages/terrain/__tests__` specs import example source
  (`examples/strata-terrain-preview/src/render/{loading,props,propStreaming,pack,propMaterials,texturePreparation}.js`,
  `viewStatistics.js`, `scripts/fixtures/kit-game/*`). The package cannot test without the example.

`sky.ts` per kit is real per-world look data and stays per kit.

## Solution

One `bakeKit(url, { sky, cookTerrainWorld })` at `@threenative/terrain/kit`, built
from `src/kit.ts`; each kit's `bake.mjs` becomes a small call. Forest supplies its existing
`@threenative/assets` cook; the other four retain their streamed-world bake. One `addStarterWorld(spec)` holds the shared world loader; each kit's `world.ts`
keeps only its look data. One `KitScene` fixture parameterised by kit. One `describe.each(kits)`
runtime spec with a table of per-kit expectations. Package specs that need example code move into
the example, or the code they test moves into the package (PRD-591).

## Acceptance Criteria

- [x] AC-1 [local]: Each kit `bake.mjs` is at most 10 lines, and all five kits bake the same bytes as before. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with golden hashes — Evidence: 2026-10-11, 19/19 tests passed before and after; alpine/coastal/desert/tundra wrappers are 6 lines each, forest is 8; all five pinned hashes unchanged.
- [ ] AC-2 [local]: Five kit playtests pass on one `KitScene` fixture. proof: `pnpm --filter strata-terrain-preview test:kit` for each `KIT` — Evidence: pending.
- [ ] AC-3 [local]: One table-driven runtime spec replaces the four per-kit runtime specs with the same assertions. proof: `pnpm --filter @threenative/terrain test` — Evidence: pending.
- [ ] AC-4 [local]: No file under `packages/terrain/__tests__` imports from `examples/`. proof: a grep spec — Evidence: pending.
- [ ] AC-5 [local]: Net line count of kits, fixtures and specs drops by at least 4 000. proof: `pnpm tsx scripts/count-loc.ts` before/after — Evidence: pending.

## Execution Phases

#### Phase 1: bake and world source
**Status:** DONE
**Files:** `packages/terrain/src/kit.ts` (new), `packages/terrain/tsup.config.ts`, `packages/terrain/package.json`, `starter/*/bake.mjs`, `packages/create-threenative/scripts/stage-terrain-kits.mjs`
- [x] Same bytes from one bake helper. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` — 2026-10-11: 19/19 before and after, including all-five golden hashes and invalid flags. `pnpm exec vitest run packages/create-threenative/__tests__/terrain-kit.spec.ts`: 27/27 after preparing its missing dist with `pnpm exec tsup --config tsup.config.ts` in that package (first run 26/27). `pnpm --filter @threenative/terrain build`: exit 0, including publint.

`pnpm exec tsc -p packages/terrain --noEmit`: exit 1, six errors from the existing example import of missing generated `examples/strata-terrain-preview/src/world/horizon.json`; no kit/helper diagnostics. No assertions or goldens changed. World source and later phases remain open.

- [x] Shared starter-world mechanism with game-owned look. proof: terrain runtime specs, terrain build and scaffolder terrain-kit spec — 2026-10-11: all 70 runtime tests and 27 scaffold tests passed; build including declarations and publint exited 0. Public `@threenative/terrain/starter` keeps Node-only bake imports out of browser games.

#### Phase 2: fixtures and specs
**Status:** IN PROGRESS
**Files:** `scripts/fixtures/kit-game/*`, `packages/terrain/__tests__/*-runtime.spec.ts`, `*-kit.spec.ts`
- [ ] Kit playtests on one fixture. proof: `test:kit`
- [ ] Table-driven spec. proof: `pnpm --filter @threenative/terrain test`
- [ ] No package spec imports the example. proof: grep spec
- [ ] Line count drops by 4 000+. proof: `count-loc.ts`

## Execution scope (2026-10-11)

Parts A–D run only in this checkout, one local commit each, no push. Reuse WorldCells, loadWorldHeightmap, Heightfield and existing physics; keep per-kit dress/water/sky choices in copied source. Preserve all assertions and five bake hashes. Baseline before Part A: 17 337 lines across 86 authored kit, fixture and package-test files (.ts/.mjs/.mts/.json); 36 package spec files. Final census also includes extracted package helpers and moved example specs, so moving files earns no LOC reduction.

Part B (2026-10-11): five scenes replaced by one parameterised KitScene; four runtime files become one 56-test table (same 14 tests per kit), four bake specs become one 8-test table. Differences are columns: runtime asset, water response/request and missing-model filename; bake scatter count, water identities, river point count and compared files. Focused 56 runtime + 8 bake + 31 loading + 3 forest startup tests pass. The startup VM now supplies performance/Error and the actual spawn-admission promise; assertions are unchanged. Scoped Biome exits 0 (3 complexity warnings). Full terrain proof is pending the Part C separation; the first run exposes the example’s missing generated horizon.json, now prepared by the existing example bake (five worlds + horizon, exit 0).
