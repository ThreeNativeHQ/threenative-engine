# PRD-793 — The terrain MCP answers any terrain request, and makes a new biome in one call

**Status:** PARTIAL — Phases 1-3 are done: the tool takes `biome` (a starter's name, one of its
alias words or an inline spec) with `landform`, `sizeMeters`, `seed` and `water`, and
`terrain_biome_new` makes and cooks a `savanna` from the forest's data in one call that writes only
under `<assets.source>/biomes/savanna/`. Open: AC-4 and the Phase 3 sandbox box, which need the
sandbox and judge lane.
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

- [x] AC-1 [local]: Each of the seven landforms cooks under any shipped biome. proof: `terrain-mcp.spec.ts` matrix — Evidence: the `every landform under every biome` matrix is 35/35 green (7 presets × 5 kits, one `it.each` row each, 81 s): every pair cooks through `landform(kind, { size, seed, resolution: 257 })` with the kit's own `surface.json`, `assets.json` and `biome.data.json`, writes a manifest whose extent is square with at least one cell, reports `biome` equal to the kit, triangles and draws above zero, and writes a recipe with no `heightmap` layer — the preset's chain, not the starter's crop. A landform preset authors the ground and no scatter rules, so a pair currently cooks terrain with no props (`instances` 0, `cells` `[]`), which the matrix asserts on purpose: the day the biome's foliage reaches a preset (PRD-792's spec-driven scatter) that assertion is the one that flips. `pnpm --filter @threenative/terrain build` runs before the spec in CI because the cold-handoff case spawns `dist/mcp/server.js`; run against the rebuilt dist.
- [x] AC-2 [local]: One `terrain_biome_new` call makes and cooks a sixth biome with no code edit. proof: `terrain-mcp.spec.ts` plus `git diff --stat` of the call touching only `<assets.source>/biomes/<name>/` — Evidence: the `terrain_biome_new` case `makes and cooks a savanna in a game project, touching only its own folders` drives the built `dist/mcp/server.js` with one `tools/call` against a temp game project. The reply is `biome: "savanna"`, `biomeJson: "assets/biomes/savanna/biome.data.json"`, `out: "assets/biomes/savanna/world"`, with triangles above zero and `bands` resolved. The file on disk is the validated spec: `look: "savanna"`, `landform: "rollingHills"`, `seed: 11`, one `spruce` foliage row at density 160 with `far: null`, one `grass` row at density 1, `water: []`, `aliases: ["savanna"]`, and the starter's `species` list (`spruce`, `grass`). The case lists the project tree before and after the call: every added path starts with `assets/biomes/savanna/` (`biome.data.json`, `world/world.glb`, `world.json`, `recipe.json`, `terrain-table.json`, `water.json`, `sky.hdr`, the heightmap) and no file was removed, so the call wrote only under `<assets.source>/biomes/savanna/` and changed no source file. A second call with the same name fails with `already exists` instead of overwriting the biome. Full spec: 97/97 green.
- [x] AC-3 [local]: The new biome cooks no slower than the slowest of the five kits. proof: cook wall time in `terrain-mcp.spec.ts` output against the Phase 1 baseline — Evidence: `TN_TERRAIN_BIOME_NEW savanna: cook 2 982 ms, tool call 3 253 ms` against the Phase 1 baseline's slowest kit, forest at 3 839 ms (the same run re-cooked forest at 3 467 ms, so the box was not faster than in Phase 1). The case asserts the cook stays under 3 839 ms and prints both numbers.
- [ ] AC-4 [local]: The new biome's GLB loads in a sandbox game on the default engine and draws a non-blank frame that a fresh judge reads as the requested biome. proof: `pnpm sandbox` game plus a headed `--browser-recipe webgpu` capture — Evidence: pending. Open: needs sandbox + judge lane.

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
**Status:** DONE
**Files:** `packages/terrain/src/mcp/{tools,cook,cook-child}.ts`
- [x] `biome`, inline spec, `landform` and `water` overrides cook; an unmatched request fails and lists candidates. proof: AC-1 matrix plus the fail-closed cases in `terrain-mcp.spec.ts` — Evidence: `pnpm exec vitest run packages/terrain/__tests__/terrain-mcp.spec.ts` is 97/97 green in 118.69 s after `pnpm --filter @threenative/terrain build` (the spec spawns `dist/mcp/server.js`), and the AC-1 matrix is 35/35 inside it. `pnpm exec tsc --noEmit -p packages/terrain/tsconfig.json` exits 0. The new green cases:
  - `terrain_generate biome` (5): a bare `biome` selects its kit by name and by every alias word (`woods` → forest, ` Sea ` → coastal, `dunes` → desert); an explicit `kit` stays the override; an unmatched biome fails with every word (`biome 'castle' matches no biome. Try one of: forest (pine, pines, woods, woodland); …`); an inline `IBiomeSpec` is validated at the tool boundary (`biome field 'moons' is not a field a biome has`, `biome field 'bake' is missing`) and cooks with forest's art unless `kit` names another; a malformed `water` list fails before any evaluation.
  - `terrain_generate biome cooks` (2): an inline `savanna` spec cooks from its own `rollingHills` shape at 256 m and seed 11 — the written recipe has no `heightmap` layer, its `config` is `{ seed: 11, size: 256 }`, triangles and draws are above zero and its bands resolve — and the forest cook's declared river and lake are replaced by the request's ocean (`result.water` is the override).
  - Landed: `biome` is the wide input. A string resolves through the same alias rows as `request`; an object is checked by `validateBiome` before a cook starts and cooks the starter's surface and assets (forest unless `kit` names another, because a spec carries no appearance). `water` replaces the `IBiomeSpec.water` rows the bake validates, and the cook reports them as `result.water`, so a caller reads the flooded bodies this world was baked for. A spec's own `landform`/`sizeMeters`/`seed` build the ground, and the request's explicit overrides still win; a landform cook under a starter now takes that biome's `seed` and `sizeMeters` when the request names neither, which is the world's own number rather than a constant, and the AC-1 matrix still passes 35/35. `water` rows deeper than the array shape are checked by `validateBiome`, which already owns them.
  - Limited: `biome` does not read a project biome folder back into `terrain_generate`; the tool validates a spec object, and `terrain_biome_new` (Phase 3) cooks the spec it writes, so no caller needs the folder read today.
  - Landed: `landform` is a first-class input — `terrain_generate` declares the seven `LANDFORMS` in its schema, `parseGenerateInput` validates the name and lists all seven on a miss, and `cookKit` builds the recipe with `landform(kind, { size, seed, resolution: 257 })` instead of reading the starter's authored heightmap crop. The kit still supplies the surface, assets and biome file, so "any landform under any shipped biome" is the same code path for all 35 pairs. Proof: `terrain-mcp.spec.ts`'s `terrain_generate landform` (3 cases) plus `cooks a landform preset the five starters do not ship` — `rollingHills` under the forest kit cooks with no `heightmap` layer in the written recipe and reports triangles and draws above zero; the whole terrain suite is 34 files / 457 tests green after the build.
  - Landed, and it was a bug: `sizeMeters` and `seed` were accepted by the tool and written to `recipe.recipe.size`/`.seed`, a field beside the document's `config` that `Terrain.fromJSON` never reads, so both overrides were silently ignored (the document validator only checks known fields, so nothing failed). The cook now writes `config.size`/`config.seed`, and `applies sizeMeters and seed to the recipe's own config` pins the written recipe's `config` and the manifest extent at 256 m. Red before the fix, green after.
  - Landed: an unmatched `request` now names every biome *and* the words it answers to (`request 'castle' matches no biome. Try one of: forest (pine, pines, woods, woodland); coastal (beach, coast, sea, ocean); …`), and the parser's synonym table is no longer a second copy of the aliases: `core/biome-words.ts` holds a mirror of the five `aliases` rows, and `biome-words.spec.ts` (6/6) fails the moment a mirror row stops matching its `biome.data.json`. `TERRAIN_KITS`/`TerrainKit` moved to `core/kits.ts` so the words module does not import the tool module; `tools.ts` re-exports both, so its public surface is unchanged. The old spec's expectation of a bare `forest, coastal, …` list was updated to the new message, with each alias word asserted.

#### Phase 3: a new biome in one call
**Status:** PARTIAL — the biome and its cook are done; the sandbox arm is open.
**Files:** `packages/terrain/src/mcp/tools.ts`, `packages/engine-mcp` tool registration if the server lists tools there
- [x] `terrain_biome_new` makes a `savanna` biome (`rollingHills`, grass cover, sparse trees from starter assets). proof: AC-2 and AC-3 — Evidence: one `terrain_biome_new { from: "forest", name: "savanna", overrides }` call writes `assets/biomes/savanna/biome.data.json` and cooks `assets/biomes/savanna/world/`: `rollingHills` ground, the forest's grass row as cover, and the forest's `spruce` row thinned to density 160 with spacing `[12, 26]` and no far field, all species from the starter pack. Cook 2 982 ms, under the forest baseline of 3 839 ms (AC-3). The call edits no code: `tools.ts` gained the tool once, and the test drives it through the built server. The preset ground carries no scatter rules yet, so this world's `instances` stay 0; the biome's foliage reaches the bake with PRD-792 Phase 2's spec-driven scatter, which is why AC-4 is still open.
- [ ] The savanna GLB runs in a sandbox game. proof: AC-4. Open: needs sandbox + judge lane.
