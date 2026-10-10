# PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data

**Status:** NOT STARTED
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
- [ ] AC-2 [local]: Every `recipe.json` is under 200 KB, and each kit bake's output bytes are unchanged by the sidecar move. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with a golden hash — Evidence: pending.
- [ ] AC-3 [local]: A scaffolded game that asks for the forest kit gets its recipe and assets, and the kit playtest passes. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit` — Evidence: pending.
- [ ] AC-4 [local]: No asset directory without a reference remains. proof: an asset-reference spec — Evidence: pending.
- [ ] AC-5 [local]: `prepare-release` syncs terrain's peer ranges, and the CHARTER closed-list row names the terrain allowance. proof: `pnpm check:docs` and the package-lists drift spec — Evidence: pending.

## Execution Phases

#### Phase 1: recipes shrink, bytes hold
**Status:** NOT STARTED
**Files:** `packages/terrain/starter/*/recipe.json`, sidecar `.r16` files, `starter-kit.spec.ts`
- [ ] Recipes under 200 KB, same bake bytes. proof: `starter-kit.spec.ts`

#### Phase 2: kits leave the tarball
**Status:** NOT STARTED
**Files:** `packages/terrain/package.json` `files`, `packages/create-threenative/src/` kit copy, `starter-assets/` moves
- [ ] Tarball under 2 MB. proof: `pnpm budgets`
- [ ] Kit still scaffolds and plays. proof: `test:kit`
- [ ] No unreferenced assets. proof: asset-reference spec

#### Phase 3: registration and charter
**Status:** NOT STARTED
**Files:** `scripts/prepare-release.ts`, `docs/architecture/CHARTER.md`, `AGENTS.md`, `src/core/io.ts`
- [ ] Peer sync and charter row. proof: `pnpm check:docs` + drift spec
