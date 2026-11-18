# PRD-900 — Every procedural asset is browsable, absorbed whole and found by the asset MCP

**Status:** IN PROGRESS
**Priority:** P2 — no viewer shows what `@threenative/procedural-environment` bakes, the Apex city kit is not absorbed at all, and the asset MCP does not return any procedural asset.
**Complexity:** 5 (MEDIUM) — one new dev viewer, one new vendored generator (75 modules), one cross-repo MCP source.
**Owner:** João
**Depends on:** none. It builds on [PRD-889](../done/PRD-889-the-forest-floor-bakes-and-scatters-from-one-nature-package.md) and PRD-892 (Outcrop as `bakeRock`, rename to `procedural-environment`).

## Context

Owner, 2026-11-17: "we should create a 'project' that's essentially a asset library visualizer ... should behave like storybook ... everything available on the procedural environment package", "should open with a pnpm asset-library command", "I dont think it was implemented properly, please put side by side and compare, also check if all were absorbed. the comparison checker should be a tmp project only", "this new one should be absorbed 100% apex-city-kit.html", "hook this properly with threenative assets mcp for discoverability".

Raw material: `~/Downloads/PROCEDURAL ENVIRONMENT/` — `arbor.js`, `GrassSystem.js`, `forest-kit-source.zip`, `Outcrop Rock Generator.html`, `apex-city-kit.html`.

**Absorption audit (2026-11-17, read at `39c3a6e5e`):**

| Source | State | Evidence |
| --- | --- | --- |
| `arbor.js` 1.0.0 (28 trees, 27 cover) | ✅ absorbed. The core is the same, and only `Arbor.three` and `encodePNG` are cut | `diff` of raw against `vendor/arbor.js` |
| `arbor.js`: `saguaro` | ❌ → ✅ the bake threw in `leafTexture` on a leafless preset | fixed in this PRD's first commit, spec "bakes every preset" red, then green |
| `GrassSystem.js` | ✅ mechanism in `GrassField3D` (core), look in the adventure kit `src/render/grass.ts` | PRD-883 |
| forest-kit `debris.js`, `grassClump` gaps (`reeds`, `tussock`, `seedgrass`, `clover`, `dock`, `plume`) | ✅ vendored copies are the same, apart from import paths and the three-free icosphere | `diff -u` |
| forest-kit `fern`, `flowerCluster`/`flowerSpike` (BLOOMS), `herb`, `broadleaf`, `grassClump`/`grassLods` | ⚠️ not vendored. PRD-889 counts Arbor's `bracken`, `daisy` and `meadowgrass` as cover for them, and Phase 1 compares them side by side | Phase 1 |
| forest-kit `trees.js` (`birch`, `broadleaf`, `pole`, `shrub`, `snag`) | ⚠️ not vendored. PRD-889 does not mention it. Arbor has no standing dead tree (`snag`) | Phase 1 |
| forest-kit `foliage.js`, `forestBiome.js`, `Sky`, `SunRig`, `Water`, `BiomeMap`, `Terrain`, `textures/*` | out by decision (PRD-889): they decide the look, or core and terrain own them | PRD-889 Decisions |
| Outcrop (9 forms, 6 biomes) | ✅ `bakeRock`. The generator body is the same | `diff` of the page's first script against `vendor/outcrop.js` |
| Outcrop `createRockTextures` / `createRockMaterial` | ⚠️ cut. The GLB has no UVs, and the README tells the game to project triplanar | Phase 1 |
| `apex-city-kit.html` (75 modules, 11 categories) | ❌ not absorbed | Phase 2 |

## Solution

```mermaid
flowchart LR
  G[vendored generators: Arbor, forest-kit, Outcrop, Apex] --> B[bake calls in procedural-environment]
  B --> L[pnpm asset-library: story tree, controls, docs panel]
  B --> M[asset MCP procedural source: search returns the bake call]
  R[raw pages in Downloads] -.tmp compare, scratchpad only.-> L
```

1. **`pnpm asset-library`** opens a Storybook-shaped viewer: a sidebar tree by kind (trees, cover, debris, rocks, city categories) with search, one story per element, controls (seed, LOD, biome for rocks, wind on or off), and a docs panel (name, latin name, biomes, triangles, bounds, the paste-ready bake call). It lists `environmentElements()` and bakes on demand through the package's own bake calls, so the viewer cannot show something the package does not ship. It lives in `packages/procedural-environment/library/` as a dev-only Vite page. It is not in `files`, so the package does not ship it.
2. **Side-by-side check (temporary, scratchpad only):** each raw generator next to our baked GLB, at the same seed and pose, plus the list of raw generators that have no row. Its results go in the audit table above. The project is deleted afterwards.
3. **Apex city kit:** vendor the generator, bake each of the 75 modules to a GLB (`bakeCity` or presets of a new kind), keep its textures and the seed determinism, and list them in `environmentElements`.
4. **Asset MCP:** a `procedural` source in `threenative-asset-mcp`, so `asset_search_sources` and `asset_search` return the element and its bake call, next to Poly Haven scans.

## Execution Phases

#### Phase 1: the library and the audit
- [ ] `pnpm asset-library` opens the viewer, and every element of `environmentElements()` has a story that bakes and draws. proof: a playtest-free headed check that opens each story and counts drawn meshes, screenshots in `~/Downloads/asset-library/`
- [ ] The side-by-side check runs for every raw generator, and the audit table records each verdict. proof: contact sheets in `~/Downloads/asset-library/compare/`, read by a fresh visual judge
- [ ] Each gap the comparison rates as a real loss is absorbed, or recorded as a decision with its reason. proof: package spec plus the audit table

#### Phase 2: the Apex city kit
- [ ] All 75 Apex modules bake to deterministic GLBs, and each has its textures. proof: package spec (same bytes twice, one GLB per module)
- [ ] The city categories show in the library next to Apex's own page, side by side. proof: contact sheet and visual judge

#### Phase 3: the asset MCP finds it
- [ ] `asset_search` for "oak tree", "mossy boulder" and "traffic light" returns the procedural element with its bake call. proof: asset MCP spec
- [ ] The engine pins the asset MCP release that carries the source. proof: `packages/core/package.json` and `pnpm exec vitest run packages/engine-mcp/__tests__`

## Blocked on

- Package name: keep `procedural-environment` or rename to `procedural-assets` before 0.3.16 publishes. Waits for the owner.

## Decisions

- 2026-11-17 (agent): the viewer is a dev-only page inside the package, not an `examples/` game. It shows bake output, and a game would add a renderer and a look that hide what the bake writes.
