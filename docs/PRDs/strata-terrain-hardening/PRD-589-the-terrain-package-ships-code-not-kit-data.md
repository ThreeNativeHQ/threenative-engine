# PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data

**Status:** PARTIAL
**Priority:** P2 — Every `npm i @threenative/terrain` downloads 32.6 MB of kit data and four 1.3 MB recipes, whether or not the game uses a kit (AC-1, AC-2).
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Package and core audits of `2d2124792` (2026-10-10):

- `npm pack --dry-run` in `packages/terrain`: 32.6 MB packed, 40.7 MB unpacked. `package.json`
  `files` ships `starter/` (5.7 MB) and `starter-assets/` (34 MB, 15 MB of it `fir_tree_01`).
- Four `starter/*/recipe.json` files are 66k lines (about 1.3 MB) each, because a `heightmap`
  layer inlines 257×257 numbers. `forest` has no inline array and is 4.5k lines.
- `starter-assets/forest_leaves_02` and `grass_medium_02` are referenced by nothing found;
  `bark_brown_02`, `cliff_side`, `fern_02`, `lichen_rock` and `river_small_rocks` are used only
  by the example.
- `src/core/io.ts:~403` writes the glTF generator string `"Strata Terrain 0.1.0"`.
- Registration: `scripts/prepare-release.ts` `syncPeerRanges` has no terrain entry.
- CHARTER: the new terrain allowance (owner, 2026-09-30) admits terrain-only editor companions,
  but the closed-list row "An editor | Not in v1…" (`docs/architecture/CHARTER.md:102`) was not
  reworded, and root `AGENTS.md` "Where a change goes" has no terrain row.

## Solution

Move kit binaries out of the runtime tarball: the scaffolder copies a kit into the game on
request (the same path PRD-584's MCP tool uses), and species GLBs come through the asset MCP
download path. Store inline heightmaps as RAW16 sidecars that `decodeRAW16` already reads, with
the recipe naming the file. Delete unreferenced assets and move example-only ones into the
example. Fix the generator string, the peer-range sync and the CHARTER row.

## Acceptance Criteria

- [ ] AC-1 [local]: The packed tarball is under 2 MB, enforced by a cap in `pnpm budgets`. proof: `pnpm budgets` — Evidence: pending.
- [x] AC-2 [local]: Every `recipe.json` is under 200 KB, and each kit bake's output bytes are unchanged by the sidecar move. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with a golden hash — Evidence: 27 tests pass across five kit specs (parent run, 20.55 s); all 79 old/new bake files are byte-identical (7 s).
- [ ] AC-3 [local]: A scaffolded game that asks for the forest kit gets its recipe and assets, and the kit playtest passes. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit` — Evidence: pending.
- [ ] AC-4 [local]: No asset directory without a reference remains. proof: an asset-reference spec — Evidence: pending.
- [x] AC-5 [local]: `prepare-release` syncs terrain's peer ranges, and the CHARTER closed-list row names the terrain allowance. proof: `pnpm check:docs` and the package-lists drift spec — Evidence: `prepare-release.spec.ts` 12/12 PASS (4 new terrain fixtures, 3 RED before the fix). `package-list-drift.spec.ts` 7/7 PASS. `terrain-consumer.spec.ts` 18/18 PASS. `check:docs` from the parent run (3057 links). Core-independent strict typecheck of `io.ts` and `prepare-release.ts` passes. CHARTER row in `a9a997baf`.

## Execution Phases

#### Phase 1: recipes shrink, bytes hold
**Status:** COMPLETE
**Files:** `packages/terrain/starter/*/recipe.json`, sidecar `.r16` files, kit specs and bake loaders
- [x] Recipes under 200 KB, same bake bytes. proof: `starter-kit.spec.ts`
  - All five recipe JSON files are 2,253–5,359 B; each little-endian RAW16 sidecar is 132,098 B. Existing `decodeRAW16` hydrates values in the Node bake loaders; pure `Terrain` owns no file I/O. The authored 0.1 m precision limit is explicit in each loader.
  - Self-contained pinned SHA256 tests prove decoded Float32 heights and evaluated height grids equal the original inline recipes. Parent full focused run: all 27 tests pass across `starter-kit`, `alpine-kit`, `coastal-kit`, `desert-kit` and `tundra-kit` (20.55 s).
  - Parent complete bake comparison against `e12a5d578`: all ten bakes exit 0; every emitted file matches by path and full-byte SHA256 (79 files: alpine 15, coastal 12, desert 15, forest 22, tundra 15; 7 s). No bake arithmetic, seed or placement changed.
  - Fixture copy lists include the sidecars; alpine first reproduced `ENOENT heightmap.r16`, then all four biome specs passed. The game harness already copies kit directories recursively.
  - Two stale forest assertions were aligned with cooker commit `4cf0664e7`: historical comparison proves only six model path aliases changed in the manifest. The combined GLB (24,641,592 B) and streamed package (24,073,955 B) each retain the 25 MiB cap. All other golden hashes remain unchanged. Scoped Biome and diff checks pass.

#### Phase 2: kits leave the tarball
**Status:** NOT STARTED
**Files:** `packages/terrain/package.json` `files`, `packages/create-threenative/src/` kit copy, `starter-assets/` moves
- [ ] Tarball under 2 MB. proof: `pnpm budgets`
- [ ] Kit still scaffolds and plays. proof: `test:kit`
- [ ] No unreferenced assets. proof: asset-reference spec

#### Phase 3: registration and charter
**Status:** COMPLETE
**Files:** `scripts/prepare-release.ts`, `docs/architecture/CHARTER.md`, `AGENTS.md`, `src/core/io.ts`
- [x] Peer sync and charter row. proof: `pnpm check:docs` + drift spec
  - Evidence: `prepare-release.spec.ts` 12/12 PASS. `package-list-drift.spec.ts` 7/7 PASS. `terrain-consumer.spec.ts` 18/18 PASS. `check:docs` from the parent run. Core-independent strict typecheck passes for `io.ts` and `prepare-release.ts` (`tsc --ignoreConfig --noEmit --strict --skipLibCheck --types node --target ES2022 --module NodeNext --moduleResolution NodeNext`). Package-wide terrain `typecheck` remains blocked by 19 errors outside changed files. Causes: `@threenative/physics` has no built `dist`, and `examples/strata-terrain-preview/src/world/horizon.json` is absent.

2026-10-11 charter clarification: the closed-list row now names the existing narrow terrain-only authoring allowance, and root `AGENTS.md` places those optional companions in `packages/terrain/` while preserving game-owned appearance. `pnpm sync:agents` updated one generated mirror. Parent documentation checks pass: 3,057 links across 1,360 Markdown files and all 252 tests in the six required documentation specs (8.40 s). Release synchronization and package-list drift proof are recorded below.

2026-10-11 release synchronization follow-up: actual terrain peers stay unchanged when absent from the selected versions map; a selected cohort peer uses the existing range synchronizer. Terrain generator versions now use `requiredVersion` and the existing source-update table. Three new fixtures fail before the source fix; all 37 release/drift/consumer tests pass afterward (2.30 s). The focused core-independent strict typecheck passes; package-wide missing physics output and horizon fixture are not repaired by this phase. Documentation proof for the charter and mirrors remains the parent’s accepted 252-test run.
