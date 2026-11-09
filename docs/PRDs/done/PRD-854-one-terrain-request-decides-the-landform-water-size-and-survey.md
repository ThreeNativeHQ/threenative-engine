# PRD-854: One terrain request decides the landform, water, size and a real survey

**Status:** PARTIAL — Phases 1 to 3 landed (2026-11-07). The two acceptance boxes are open.
**Priority:** P1 — `terrain_generate` drops every request word except the biome word, so "a forest with mountains and a river" cooks a flat default forest (Phase 1).
**Complexity:** 5 (MEDIUM)
**Depends on:** [PRD-762](../strata-terrain-hardening/PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) (same MCP tool, path must start first)
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md), chain step PR-5 in [PR-CHAIN.md](../strata-terrain-hardening/PR-CHAIN.md)

## Problem

Owner direction (2026-11-07): the terrain MCP receives a request such as "create a forest with mountains and a river" and decides everything itself. Real elevation is one of its internal choices, not an input the agent prepares.

Today `parseGenerateInput` (`packages/terrain/src/mcp/tools.ts:192`) reads only the biome words (`BIOME_WORD_ROWS`). "Mountains", "river", "island", "huge" and every other word are dropped silently. `landform`, `water` and `sizeMeters` come only from explicit arguments.

The spike in [PR-CHAIN.md](../strata-terrain-hardening/PR-CHAIN.md) measured the parts: AWS terrarium tiles need no key (Mount Fuji z12 decodes to 1 317–3 754 m at 31.2 m/px), and `decodeHeightPNG`, `decodeRAW16` and the `heightmap` layer already ship.

All work is bake time. No network call at runtime.

## Execution Phases

### Phase 1 — request words pick the landform, water and size

- [x] Request words pick the landform ("mountains" → `alpine` or `temperateMountains`), the water rows ("river", "lake", "island" → `coastalCliffs` plus an ocean row) and the size ("huge", "small"). An explicit argument wins over a word. proof: a red-green case per word row in `packages/terrain/__tests__/terrain-mcp.spec.ts` — 2026-11-07: `-t "request words"` 30 failed before the change, 43 passed after; whole file 144/144; word tables in `packages/terrain/src/core/request-words.ts`.
- [x] The result carries `decided` (each choice with the word that made it, or `"argument"`) and `unused` (request words that matched nothing). proof: the same spec asserts both fields — 2026-11-07: unit cases plus the built server's reply (`-t "savanna in a game project"` asserts `decided.water.source` and `unused: ["zeppelin"]`), 1/1 pass.

### Phase 2 — the tool picks the ground source

- [x] A curated survey table: one or more real locations per landform, each with lat, lon, zoom and attribution. The cook picks a row from the landform. proof: a spec asserts every landform has a row and every row an attribution — 2026-11-07: `packages/terrain/src/core/surveys.ts`, one real place per landform (Matterhorn, Rocky Mountain NP, Driftless WI, Monument Valley, Étretat, Trail Ridge, Mount Fuji), each with its joerd source attribution and a measured range; `terrain-survey.spec.ts` asserts every row and attribution.
- [x] The cook fetches AWS terrarium tiles, caches them on disk, decodes `height = R·256 + G + B/256 − 32768` and feeds the `heightmap` layer. The kit README gets the attribution. proof: a spec on a checked-in tile fixture, plus one real cook from "alpine mountains" — 2026-11-07: `packages/terrain/src/mcp/survey.ts` (Node zlib decoder, no new dependency), cache in `TN_TERRAIN_TILE_CACHE`; fixture Mount Fuji z12 tile; a real `{"kit":"forest","request":"alpine mountains"}` cook fetched 4 Matterhorn tiles, 6.1 s, and wrote the EU-DEM attribution into the kit README. Look not judged yet (PRD-762 Phase 3 frames).
- [x] Without network the cook fails closed and names the missing tile, unless `ground: "procedural"`. No silent switch to procedural. proof: a spec with the fetch stubbed to fail — 2026-11-07: the spec stubs `fetch` to fail; the cook throws naming the tile URL and `ground: "procedural"`.

### Phase 3 — named overrides

- [x] `ground: "procedural" | { heightmap: <16-bit PNG or .r16 path> } | { location: { lat, lon } }` overrides the automatic choice, and the result names the override. proof: a spec per variant — 2026-11-07: `terrain-survey.spec.ts` covers each variant and `decided.ground`.
- [x] A PNG over 4 097 px or an 8-bit file throws and names the field. proof: a spec per refusal — 2026-11-07: both refusals name `ground.heightmap`; a `.r16` without `min`/`max` and a PNG without an embedded range also throw. Terrain specs 591/591, `tsc` 0.

## Acceptance Criteria

Open gap (2026-11-07): "create a forest with mountains and a river" now fails loudly with `cook: water row 'river' has no river layer in the recipe to take it`. A landform preset authors no river or lake layer, and `applyWaterRows` only re-shapes an existing layer. The AC needs the presets to grow the body a water word asks for. That changes the cooked look, so it needs a visual judge.
Closed for rivers (2026-11-08): a river row with no layer now runs down the finished ground's own drainage (`routeRivers` in `cook.ts`, on the installed `fillDepressions`/`routeFlow`): the main stem of the largest basin that leaves the world, from where its catchment is a tenth of the outlet's to the edge, every 16 m, with the forest starter's bed, depth and shoulder; a second row takes the next basin at least an eighth of the world away. A lake row with no layer still fails closed: a lake needs a basin, and a fluvially eroded preset has none. `terrain-mcp.spec.ts` cases red on HEAD (`has no river layer`, 2 failed) then green; whole MCP and survey specs 157/157. Visual judge of the cooked river in a game: open, with the PRD-762 Phase 3 frames.

- [x] "create a forest with mountains and a river" cooks a forest kit on a mountain landform with a river, and the result lists every choice and the word behind it. proof: one real `terrain_generate` cook, result JSON in the PR — 2026-11-08: the server's own `handleLine` `tools/call`, survey ground (Matterhorn, EU-DEM attribution in the README), 6.0 s, 20 draws, 3 200 firs, `water: [{kind: "river", width: 5.32}]`; `water.json` holds one river of 164 points falling 8.6 to 5.6 m, monotone, ending at the world's edge along the lowland drainage line (hillshade check). `decided`: biome "forest", landform "alpine" from "mountains", water from "river", size default, ground survey default; `unused: []`. Result JSON on the PR.
- [x] The MCP surface snapshot names the new fields. proof: the terrain MCP surface snapshot spec — 2026-11-09: `terrain-mcp-tools.json` names `decided`, `unused` and `ground`; `scripts/__tests__/mcp-tool-schemas.spec.ts` plus `packages/terrain/__tests__/terrain-mcp.spec.ts` 2 files, 153/153 pass. The capability-manifest half was dropped (see Decisions).

## Decisions

- 2026-11-09 (agent): the AC no longer asks the capability manifest to name the new MCP fields. `capabilities.json` indexes code exports only and holds no MCP tool (`terrain_patch` and `terrain_biome_new` are absent too). The MCP `tools/list` reply and its snapshot spec already carry every tool field. Reversible: index MCP tools in the manifest in its own PRD.
