# PRD-590 — One starter-world source, not five copies

**Status:** NOT STARTED
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

One `bakeKit(dir)` in `@threenative/terrain` (or its `bin`); each kit's `bake.mjs` becomes a
three-line call. One `addStarterWorld(spec)` holds the shared world loader; each kit's `world.ts`
keeps only its look data. One `KitScene` fixture parameterised by kit. One `describe.each(kits)`
runtime spec with a table of per-kit expectations. Package specs that need example code move into
the example, or the code they test moves into the package (PRD-591).

## Acceptance Criteria

- [ ] AC-1 [local]: Each kit `bake.mjs` is at most 10 lines, and all five kits bake the same bytes as before. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with golden hashes — Evidence: pending.
- [ ] AC-2 [local]: Five kit playtests pass on one `KitScene` fixture. proof: `pnpm --filter strata-terrain-preview test:kit` for each `KIT` — Evidence: pending.
- [ ] AC-3 [local]: One table-driven runtime spec replaces the four per-kit runtime specs with the same assertions. proof: `pnpm --filter @threenative/terrain test` — Evidence: pending.
- [ ] AC-4 [local]: No file under `packages/terrain/__tests__` imports from `examples/`. proof: a grep spec — Evidence: pending.
- [ ] AC-5 [local]: Net line count of kits, fixtures and specs drops by at least 4 000. proof: `pnpm tsx scripts/count-loc.ts` before/after — Evidence: pending.

## Execution Phases

#### Phase 1: bake and world source
**Status:** NOT STARTED
**Files:** `packages/terrain/src/kit.ts` (new), `starter/*/bake.mjs`, `starter/*/world.ts`
- [ ] Same bytes from one bake helper. proof: `starter-kit.spec.ts`

#### Phase 2: fixtures and specs
**Status:** NOT STARTED
**Files:** `scripts/fixtures/kit-game/*`, `packages/terrain/__tests__/*-runtime.spec.ts`, `*-kit.spec.ts`
- [ ] Kit playtests on one fixture. proof: `test:kit`
- [ ] Table-driven spec. proof: `pnpm --filter @threenative/terrain test`
- [ ] No package spec imports the example. proof: grep spec
- [ ] Line count drops by 4 000+. proof: `count-loc.ts`
