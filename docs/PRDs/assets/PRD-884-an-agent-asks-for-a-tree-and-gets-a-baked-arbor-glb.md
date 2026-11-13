# PRD-884 — An agent asks for a tree and gets a baked Arbor GLB

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: no engine surface bakes a procedural tree (AC-1), and neither MCP offers one (AC-2).
**Complexity:** 6 (MEDIUM) — 6 to 10 implementation files (2), a new optional package (2), crosses into the separate `threenative-asset-mcp` repository and its release (2); risk override: none.
**Owner:** João
**Depends on:** None. Related: [PRD-883](../rendering/PRD-883-grass-grows-sways-and-parts-on-every-engine.md) (grass, its sibling), [PRD-870](../strata-terrain-hardening/PRD-870-the-procedural-forest-set-reads-like-the-fab-set.md) (the procedural Strata spruce could come from here once this lands).

## Context

Owner, 2026-11-13: "very useful for the terrain or as engine_capabilities search … maybe as a dedicated step on threenative-asset mcp too and on the terrain mcp? i want to make it really discoverably". The owner wrote Arbor and holds its licence. It ships to the engine under the repository's MIT licence.

Source: `/home/joao/Downloads/ARBOR.zip` → `arbor.js` (ESM) and `arbor.global.js` (an IIFE build of the same file), 1 901 lines each, with no dependencies. Phase 1 copies `arbor.js` into the repository before work starts, because the Downloads folder is not durable.

What it does (read 2026-11-13):

- `Arbor.generate(preset, { seed, lod })` returns plain typed arrays (`bark` and `leaves`: position, normal, uv, color, wind, index).
- It has 28 tree species, defined with `def(...)` at `arbor.js:525`–`:822`: oak, beech, birch, spruce, scots pine, aspen, douglas fir, red cedar, olive, acacia, baobab, coconut, sakura, bamboo, saguaro, ipê, jacaranda and more. Ground-cover presets follow at `:838`.
- `Arbor.toGLB(tree)` writes binary glTF with `_WIND`, `COLOR_0`, `TEXCOORD_0`, embedded bark and leaf images, and `alphaMode: 'MASK'` leaves.
- `Arbor.scatter(...)` is a Poisson-like disc sampler.
- `Arbor.three(THREE)` is a runtime adapter that injects wind through `onBeforeCompile`.

What fits and what does not:

- ✅ The core and `toGLB` are bake-time content. The output is a GLB that the game owns, so the look stays in game assets.
- ✅ `_WIND` is the attribute name that the existing TSL wind already reads (`examples/integrations/vegetation/src/export.ts:16`, `render/wind.ts`).
- ❌ `Arbor.three()` patches WebGL shaders and owns the look. It is not shipped.

The current engine:

- The `procedural-vegetation` recipe (`packages/core/capabilities.json`, sourced from `scripts/not-owned-capabilities.ts:44`) tells agents to copy EZ Tree from `examples/integrations/vegetation/`. Neither MCP can call that copy.
- Terrain biomes name trees by asset id (`IBiomeSpec.species`, `packages/terrain/src/core/biome.ts`). The cook draws a row only when the kit's `assetTable` has art for its species (`packages/terrain/src/mcp/cook.ts:636`–`:647`). Any other row draws nothing.
- The asset MCP federates providers through `AssetAdapter` (`threenative-asset-mcp/src/discovery/types.ts:50`, `src/discovery/federation.ts:144`) behind `asset_search`, `asset_get` and `asset_download`.
- The capability manifest indexes every public workspace package that has `exports` (`scripts/workspace-packages.ts`, `scripts/build-capability-manifest.ts:470`). A new package therefore reaches `engine_search_capabilities` with no manifest change.

## Solution

One bake function, three thin callers:

- **`@threenative/procedural-vegetation`, a new optional bake-first package** modeled on `@threenative/procedural-animals`.
  - It vendors `arbor.js` with the owner's MIT licence in `LICENSES/`.
  - It exports `bakeVegetation({ preset, seed, lods, out })`. The function writes one GLB per LOD and returns the paths, triangle counts and bounds.
  - It exports `vegetationPresets()`, which returns the id, name, latin name and kind of every preset.
  - Bad input fails closed: an unknown preset throws and names the nearest ids.
  - The package is a dev dependency, so no game ships the generator.
- **Terrain → the `arbor:<preset>[@seed]` species prefix.**
  - The cook resolves such a species by calling `bakeVegetation` into the world's asset folder. It then adds the result to `assetTable`, so the existing scatter draws the row.
  - `terrain_generate` and `terrain_biome_new` accept it, and their schema descriptions list the preset ids.
- **Asset MCP → an `arbor` `AssetAdapter` plus a `vegetation_generate` tool.**
  - `asset_search "oak tree"` returns matching presets as rows that are free, generated and owned by the user.
  - `asset_download` and `vegetation_generate` bake the GLB into the game's `assets/`.
- **Recipe.** The `procedural-vegetation` recipe now points to the package. The EZ Tree integration is deleted in Phase 3, after an Arbor tree sways under the same `render/wind.ts`.

```mermaid
flowchart LR
  A[asset MCP: asset_search / vegetation_generate] --> B
  T[terrain MCP: species arbor:oak@7] --> B
  C[engine_search_capabilities: bakeVegetation row] --> B
  B[@threenative/procedural-vegetation bakeVegetation] --> G[GLB in game assets/: _WIND, MASK leaves, LODs]
  G --> L[ctx.assets.model + game render/wind.ts]
```

Risks:

- Black or white leaves recur in this repository when the alpha, colour or texture path is wrong. The visual judge in Phase 2 checks for them.
- The asset MCP pins `@threenative/*` versions from npm. Its adapter needs a published `@threenative/procedural-vegetation`, so that box waits on the next release cohort that includes the package.

## Acceptance Criteria

- [ ] AC-1 [local]: `engine_search_capabilities "procedural oak tree"` returns `bakeVegetation` as its first row, and the `procedural-vegetation` recipe names the package, not EZ Tree. proof: a new row in `scripts/fixtures/capability-recall/corpus.json`, then `pnpm build && pnpm caps:recall`
- [ ] AC-2 [local]: A cooked world with `species: ["arbor:oak@7"]` draws Arbor oaks that sway. The visual judge returns IMPROVEMENT against the criteria in Phase 2. proof: Phase 2 boxes

## Blocked on

- The asset MCP adapter installs `@threenative/procedural-vegetation` from npm. The adapter can merge only after a release cohort publishes the package. Unblocked by: the next `pnpm release:prepare` cohort with the package in it (owner release).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tree bake | `bakeVegetation` (fill `file:line`) | EZ Tree copy-in recipe; integration deleted in Phase 3 | Phase 1 spec |
| Terrain species | `packages/terrain/src/mcp/cook.ts` `scatterFoliage` → `arbor:` resolver (fill `file:line`) | A row with no kit art used to draw nothing | Phase 2 |
| Asset search and bake | `threenative-asset-mcp` `asset_search` / `vegetation_generate` → `arbor` adapter | New provider | Phase 3 |
| Discovery | manifest rows from `pnpm build` | New package rows | AC-1 |

## Decisions

- 2026-11-13 (João): ship Arbor as a bake-first package that the asset MCP and the terrain MCP both call. Option 1 of the integration review.
- 2026-11-13 (agent): do not ship `Arbor.three()`. It patches WebGL shaders and owns the look, and the GLB plus the game's TSL `render/wind.ts` covers it on every engine.
- 2026-11-13 (agent): Arbor's `_WIND` is a vec4 (x trunk sway m, y branch sway m, z leaf flutter m, w phase), not the scalar `_wind` weight that `examples/integrations/vegetation/src/render/wind.ts` reads, so that wind cannot sway an Arbor tree unchanged. The recipe now documents the vec4 layout and tells the game to write its own `render/wind.ts`.
- 2026-11-13 (agent): the bake needs a Canvas 2D for the leaf atlas (Arbor paints it with Canvas 2D), so the package depends on `@napi-rs/canvas` (MIT, prebuilt binaries). It encodes the bark and leaf PNGs too. This is the dependency the other packages must not inherit.
- 2026-11-13 (agent): Strata reaches Arbor in two ways, both small. (1) The explicit `arbor:<preset>[@seed]` species name in a biome spec's `foliage` or `species` rows (`terrain_generate` with an inline `biome`, `terrain_biome_new` overrides). (2) A tree word in `terrain_generate`'s `request` (`TREE_WORD_ROWS` in `request-words.ts`: oak, birch, aspen, cedar, maple, olive, acacia, baobab, palm, bamboo, cactus and more) cooks that species as `treeSpecies: "arbor:<id>"` in place of the kit's tree art: every variant of the kit's tree family takes consecutive seeds, and a kit with no tree (alpine, desert, tundra) gets the Arbor tree as the one its tree row draws. The reply reports it as `decided.tree` with the word behind it. Words a biome already answers to (spruce, pine, fir) keep their meaning, the kit's own conifer, so a starter request still cooks that starter as shipped; an inline spec wins over a word. A bare preset id with no prefix is not resolved: the forest biome's own `spruce` row would otherwise stop meaning the kit's conifer. The source GLBs bake into a temporary folder, not the world's asset folder: the cook streams its own copy of each species into `models/`, so the world holds no loose LOD files. A row's `far.impostor` must exceed 190 m for an Arbor species (its derived last LOD gate is about 185 m); the bake fails closed naming the gate otherwise, and the tool schema says so.
- 2026-11-13 (agent): Arbor replaces EZ Tree as the recipe answer. The owner can veto this before Phase 3 deletes `examples/integrations/vegetation/`.

## Execution Phases

#### Phase 1: `bakeVegetation` writes a deterministic Arbor GLB

**Status:** DONE (2026-11-13)
**Files:**
- `packages/procedural-vegetation/` (new): `package.json`, `tsup.config.ts`, `src/arbor.js` (vendored), `src/index.ts`, `LICENSES/Arbor-MIT.txt` and `README.md`.
- `scripts/not-owned-capabilities.ts`: the recipe text.
- `scripts/fixtures/capability-recall/corpus.json`: the recall row.

**Implementation:**
1. Copy `arbor.js` with `Arbor.three` and its helpers cut out.
2. Wrap `generate` + `toGLB` per LOD and write the files atomically.
3. Validate the preset, the seed (an integer) and the LODs (0 to 2).
4. Add JSDoc situations: "procedural tree", "oak / pine / palm tree", "forest species", "tree GLB for Unity, Unreal or Godot".

- [x] A spec bakes `oak` seed 7 twice. It asserts three things: the bytes are identical, the GLB parses with `_WIND`, `COLOR_0` and `TEXCOORD_0` on both primitives, and the leaf material is `MASK`. It also asserts that an unknown preset throws and names the nearest ids. proof: `pnpm --filter @threenative/procedural-vegetation test` — 4 tests green, exit 0, publint --strict clean (2026-11-13).
- [x] AC-1 is green. proof: `pnpm build && pnpm caps:recall` — `pnpm capabilities:sync && pnpm caps:recall` exit 0 with row `vegetation.procedural-oak`; `searchCapabilities("procedural oak tree")` returns `bakeVegetation` first, `vegetationPresets` second (2026-11-13).

**Verification:** the two boxes above. Also run `pnpm typecheck && pnpm lint && pnpm budgets`.

#### Phase 2: A terrain cook grows Arbor species

**Status:** PARTIAL (2026-11-13): resolver, request words and spec done; the visual judge box is open.
**Files:**
- `packages/terrain/src/mcp/cook.ts`: the `arbor:` resolver feeds `assetTable`.
- `packages/terrain/src/mcp/tools.ts`: the schema text that lists the presets.
- `packages/terrain/package.json`: the optional peer dependency.
- `packages/terrain/__tests__/arbor-species.spec.ts` (new).

**Implementation:**
1. Parse `arbor:<id>[@seed]`.
2. Bake once per distinct species into the world's asset folder.
3. Fail closed when the package is missing. The error names `npm i -D @threenative/procedural-vegetation`.
4. Visual acceptance criteria, set before judging:
   - each species reads as its own silhouette (oak broad, spruce conical);
   - the leaves are neither black nor white;
   - the trunks stand on the ground;
   - the canopy sways under `render/wind.ts`.

- [x] A spec cooks a biome with `species: ["arbor:oak@7", "arbor:spruce"]`. It asserts that both rows place instances and that each instance references a baked GLB. proof: `pnpm exec vitest run packages/terrain/__tests__/arbor-species.spec.ts`
- [ ] The visual judge returns IMPROVEMENT. The frames show the cooked world against the same world with an empty species row, headed WebGPU, with `adapter.info` checked and two runs per arm. proof: the judge verdict on BEFORE and AFTER sheets posted to the PR (`prd-884-screenshots`)

**Verification:** the two boxes above.

#### Phase 3: The asset MCP finds and bakes trees, and EZ Tree leaves

**Status:** NOT STARTED
**Files:**
- `threenative-asset-mcp/src/discovery/arbor.ts` (new): the `AssetAdapter`.
- `threenative-asset-mcp/src/server.ts`: the `vegetation_generate` registration.
- `threenative-asset-mcp/tests/arbor.test.ts` (new).
- This repository: `git rm -r examples/integrations/vegetation/` and the links to it.

**Implementation:**
1. The adapter matches query words against preset ids, names, latin names and kinds.
2. Search rows carry price 0, the rights "generated, user-owned" and the acquisition "generate".
3. `asset_download` and `vegetation_generate` call `bakeVegetation`.
4. The change lands as its own PR in the asset MCP repository, after the release named under `## Blocked on`.

- [ ] `asset_search { query: "oak tree" }` returns an `arbor` row for `oak`, and `vegetation_generate { preset: "oak", seed: 7 }` writes a GLB that the Phase 1 parser accepts. proof: `npm test -- tests/arbor.test.ts` in `threenative-asset-mcp`
- [x] The EZ Tree integration is deleted, and no doc links to it. proof: `pnpm check:docs && pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/primary-docs.spec.ts` — `pnpm check:docs` exit 0 (3953 links), the two specs plus `vegetation-not-owned`, `ci-structure`, `ci-integration-scope`, `package-list-drift` green, 328 tests (2026-11-13). The `vegetation` integration CI lane left with it; `foliage-conifer.mjs` now bakes an Arbor spruce; PRD-786's wind-helper reference moved to the quarry sway material.

**Verification:** the two boxes above. Then run `pnpm ci:local --affected --base origin/develop --target develop` once before the PR leaves draft.
