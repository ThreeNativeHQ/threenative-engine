# PRD-854: One terrain request decides the landform, water, size and a real survey

**Status:** NOT STARTED
**Priority:** P1 — `terrain_generate` drops every request word except the biome word, so "a forest with mountains and a river" cooks a flat default forest (Phase 1).
**Complexity:** 5 (MEDIUM)
**Depends on:** [PRD-762](PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) (same MCP tool, path must start first)
**Epic:** [Strata terrain hardening](README.md), chain step PR-5 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Owner direction (2026-11-07): the terrain MCP receives a request such as "create a forest with mountains and a river" and decides everything itself. Real elevation is one of its internal choices, not an input the agent prepares.

Today `parseGenerateInput` (`packages/terrain/src/mcp/tools.ts:192`) reads only the biome words (`BIOME_WORD_ROWS`). "Mountains", "river", "island", "huge" and every other word are dropped silently. `landform`, `water` and `sizeMeters` come only from explicit arguments.

The spike in [PR-CHAIN.md](PR-CHAIN.md) measured the parts: AWS terrarium tiles need no key (Mount Fuji z12 decodes to 1 317–3 754 m at 31.2 m/px), and `decodeHeightPNG`, `decodeRAW16` and the `heightmap` layer already ship.

All work is bake time. No network call at runtime.

## Execution Phases

### Phase 1 — request words pick the landform, water and size

- [ ] Request words pick the landform ("mountains" → `alpine` or `temperateMountains`), the water rows ("river", "lake", "island" → `coastalCliffs` plus an ocean row) and the size ("huge", "small"). An explicit argument wins over a word. proof: a red-green case per word row in `packages/terrain/__tests__/terrain-mcp.spec.ts`
- [ ] The result carries `decided` (each choice with the word that made it, or `"argument"`) and `unused` (request words that matched nothing). proof: the same spec asserts both fields

### Phase 2 — the tool picks the ground source

- [ ] A curated survey table: one or more real locations per landform, each with lat, lon, zoom and attribution. The cook picks a row from the landform. proof: a spec asserts every landform has a row and every row an attribution
- [ ] The cook fetches AWS terrarium tiles, caches them on disk, decodes `height = R·256 + G + B/256 − 32768` and feeds the `heightmap` layer. The kit README gets the attribution. proof: a spec on a checked-in tile fixture, plus one real cook from "alpine mountains"
- [ ] Without network the cook fails closed and names the missing tile, unless `ground: "procedural"`. No silent switch to procedural. proof: a spec with the fetch stubbed to fail

### Phase 3 — named overrides

- [ ] `ground: "procedural" | { heightmap: <16-bit PNG or .r16 path> } | { location: { lat, lon } }` overrides the automatic choice, and the result names the override. proof: a spec per variant
- [ ] A PNG over 4 097 px or an 8-bit file throws and names the field. proof: a spec per refusal

## Acceptance Criteria

- [ ] "create a forest with mountains and a river" cooks a forest kit on a mountain landform with a river, and the result lists every choice and the word behind it. proof: one real `terrain_generate` cook, result JSON in the PR
- [ ] The MCP surface snapshot and the capability manifest name the new fields. proof: `pnpm build` and the terrain MCP surface snapshot spec
