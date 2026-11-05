# PRD-793 — The terrain MCP answers any terrain request, and makes a new biome in one call

**Status:** PARTIAL — Phase 1 is done on this branch (every shipped kit's cook is pinned, with its
counts and its cook time as the AC-3 baseline); Phase 2 and Phase 3 wait on PRD-792's `bakeBiome`,
which is what lets the tool build a recipe from an `IBiomeSpec`.
**Priority:** P1 — The owner's goal: an agent asking for a terrain outside five fixed names gets no world today (all phases open).
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md), [PRD-792](PRD-792-one-bake-for-every-biome.md)
**Batch:** [Strata refactoring](README.md)

## Context

- `TERRAIN_KITS` (`packages/terrain/src/mcp/tools.ts:9`) is `forest | coastal | alpine | desert | tundra`. `terrain_generate` (`tools.ts:24`) accepts `kit`, `request`, `sizeMeters`, `seed` and `out`, and resolves every request to one of the five kits.
- `LANDFORMS` (`packages/terrain/src/core/presets.ts:39`) has seven shapes (`alpine`, `temperateMountains`, `rollingHills`, `desertMesa`, `coastalCliffs`, `tundra`, `volcanic`). `rollingHills` and `volcanic` have no kit, so no MCP call can reach them.
- `ICookRequest.kit` (`packages/terrain/src/mcp/cook.ts:14`) names a starter folder; the cook child reads that folder's files.
- `packages/terrain/__tests__/terrain-mcp.spec.ts` pins today's tool contract. [PRD-762](../../strata-terrain-hardening/PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) (P0) proves a cooked kit runs on the default engine.

## Solution

`terrain_generate` takes `biome`: a starter name, a project biome folder, or an inline `IBiomeSpec`.
Optional overrides are `landform`, `sizeMeters`, `seed` and `water`. A free-text `request` resolves
through each biome's `aliases`. With no match it fails and lists the nearest biomes; it never falls
back to a default kit. A new tool, `terrain_biome_new { from, name, overrides }`, copies a base
`biome.json` into `<assets.source>/biomes/<name>/`, applies the overrides, validates the file with
`validateBiome`, and cooks it with `bakeBiome`. Both tools return the same measured stats as today
(triangles, instances, draws) and the load snippet.

## Acceptance Criteria

- [ ] AC-1 [local]: Each of the seven landforms cooks under any shipped biome. proof: `terrain-mcp.spec.ts` matrix — Evidence: pending.
- [ ] AC-2 [local]: One `terrain_biome_new` call makes and cooks a sixth biome with no code edit. proof: `terrain-mcp.spec.ts` plus `git diff --stat` of the call touching only `<assets.source>/biomes/<name>/` — Evidence: pending.
- [ ] AC-3 [local]: The new biome cooks no slower than the slowest of the five kits. proof: cook wall time in `terrain-mcp.spec.ts` output against the Phase 1 baseline — Evidence: pending.
- [ ] AC-4 [local]: The new biome's GLB loads in a sandbox game on the default engine and draws a non-blank frame that a fresh judge reads as the requested biome. proof: `pnpm sandbox` game plus a headed `--browser-recipe webgpu` capture — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Open terrain request | MCP `terrain_generate` → `bakeBiome` → `world.glb` | The `TERRAIN_KITS` enum check stays only as the starter list | AC-1 |
| New biome | MCP `terrain_biome_new` → `validateBiome` → `bakeBiome` | New | AC-2, AC-4 |

## Execution Phases

#### Phase 1: pin today's contract
**Status:** DONE
**Files:** `packages/terrain/__tests__/terrain-mcp.spec.ts`
- [x] Every case the spec does not cover today is added: each kit cooks and reports triangles, instances and draws; an unknown field fails; an `out` that exists fails. Green on today's code, and each kit's cook time is recorded as the baseline. proof: `pnpm exec vitest run packages/terrain/__tests__/terrain-mcp.spec.ts` — Evidence: the new `every shipped kit cooks` matrix is 5/5 green (`-t "every shipped kit cooks"`: 5 passed, 42 skipped), cooking each starter kit into a temp project with `@threenative/assets` linked, then re-measuring the written `world.glb` and asserting `measureGlb(bytes)` equals the reported `{draws, instances, triangles}`; every count is above zero and the load snippet carries `WorldCells.load({`. Two of the three cases were already pinned and are not repeated: an unknown field fails (`rejects malformed fields before any evaluation starts`, `unknownField: true`) and an `out` that exists fails (`refuses an existing output directory and leaves its files untouched`). The Phase 1 baselines, printed by the run as `TN_TERRAIN_KIT`:

  | kit | triangles | instances | draws | cook |
  |---|---|---|---|---|
  | forest | 507 894 664 | 34 720 | 29 | 3 839 ms |
  | coastal | 4 533 424 | 80 | 20 | 2 528 ms |
  | alpine | 3 114 664 | 90 | 17 | 2 049 ms |
  | desert | 4 767 664 | 140 | 17 | 2 000 ms |
  | tundra | 2 453 464 | 70 | 17 | 2 197 ms |

  The slowest kit is forest at 3 839 ms on this box (AMD Ryzen 9 5900X), which is the AC-3 budget a sixth biome has to stay under. `pnpm --filter @threenative/terrain typecheck` exits 0.

#### Phase 2: open the command
**Status:** NOT STARTED
**Files:** `packages/terrain/src/mcp/{tools,cook,cook-child}.ts`
- [ ] `biome`, inline spec, `landform` and `water` overrides cook; an unmatched request fails and lists candidates. proof: AC-1 matrix plus the fail-closed cases in `terrain-mcp.spec.ts`

#### Phase 3: a new biome in one call
**Status:** NOT STARTED
**Files:** `packages/terrain/src/mcp/tools.ts`, `packages/engine-mcp` tool registration if the server lists tools there
- [ ] `terrain_biome_new` makes a `savanna` biome (`rollingHills`, grass cover, sparse trees from starter assets). proof: AC-2 and AC-3
- [ ] The savanna GLB runs in a sandbox game. proof: AC-4
