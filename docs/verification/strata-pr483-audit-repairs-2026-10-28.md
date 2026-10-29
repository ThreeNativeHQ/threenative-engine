# Strata / PR #483 — audit repair pass

**Date:** 2026-10-28. **Answers:** `docs/verification/strata-pr483-full-audit-2026-10-28.md` (the audit report this pass
was run from).

**Worked on:** `pr483-recall` at `bb8657245`, the newest local continuation of the PR head
`ca945345f` the audit reviewed (8 commits ahead, all PRD-762 art/LOD work). Branch:
`fix/pr483-audit-findings`, worktree `.worktrees/pr483-audit-fixes`. Each finding was re-checked
against this head, not taken from the audit text.

## Disposition

| Finding | Status | Evidence |
| --- | --- | --- |
| F01 asset pin vs source pack | ⚠️ pin reproducible, release missing | `kit-assets.spec.ts` green: pack 32,212,004 B, SHA `1bca8689…` equals `starter-assets.json`. The release `terrain-starter-assets-sha256-1bca8689…` is **not published** (`gh release list` has only `…db382c88…`). Publishing is a release action, not covered here. |
| F02 streamed forest ≥ 25 MiB | ✅ fixed, headed playtest owed | One file per species holding every level as a named scene (`lods[].scene`): streamed **40,378,000 → 25,275,134 B**, 939,266 B under the unchanged cap. Level geometry, materials and switch distances are untouched; the 15,090,205 B of repeated textures are stored once. See "F02 — the layout that ships". |
| F03 PNG map labelled JPEG | ✅ fixed | `authoredMime()` in `assets/src/world/terrain-world.ts` sniffs the bytes when no MIME is named, reusing `sniffImageMime` from `health.ts`; unknown bytes fail closed. New spec case red then green. **The live defect was worse than reported:** the mislabelled texture makes `dedup` throw `Corrupt JPG, exceeded buffer limits`, so a PNG cook failed outright. |
| F04 generator version drift | ✅ fixed | `core/io.ts` generator `0.1.2` → `0.1.3`. `terrain-consumer.spec.ts` green. |
| F05 landform double-failure rejection | ✅ fixed | `editor/selection.ts` `saveLayer` now wraps its recovery `snapshot()` like the placement path. New spec case reproduces the audit's case: `Unhandled Rejection: Error: socket closed` before, green after. |
| F06 scatter `asset` no longer defaulted | ✅ fixed | `core/validation.ts` still rejects, and now names the field and the old default: `add "asset": "pine" …`. New spec opens a pre-PR document and asserts the instruction. No silent default restored. |
| F07 credits path removed from the package | ✅ fixed | Five starter READMEs point at `@threenative/terrain/starter-credits.json`, which the tarball packs (`starter-kit.spec.ts` asserts both the name and its bytes). |
| F08 MCP `out` fails after spawning a child | ✅ fixed | `resolveOutput(projectRoot, out, assetSource)` rejects a directory outside `assets.source` before the child starts, with the reason; the tool schema now says so. New spec case red then green. |
| V01 nearshore water discontinuity | ⏭️ not touched | A separate lane already has it in flight (`prd766-shore-breakers-underwater`, `core/src/water-surface.ts` + native reflector edits in the `pr483-recall` worktree). Not duplicated here. |
| Forest performance attribution | ⏭️ not touched | Needs a quiet-GPU, persistent-trace browser run with a valid settled window; nothing in this session can produce an acceptable measurement. The audit's own numbers stay diagnostic. |
| A01–A09 architecture | ⏭️ follow-ups | No code change. A01 (save owners), A02 (readiness in a 2,800-line scene), A04 (duplicated bake/export preparation) are real and each is a PR, not a repair in an audit pass. |

### F02 — the layout that ships

A cooked species writes **one** `models/<species>.glb`: the default scene draws level 0, and each
upper level is its own named scene in the same file. The levels keep their own accessors, materials
and distances and share one texture set, so nothing about what is drawn changes — only where it is
stored. The manifest names it per level:

```json
"fir": {
  "glb": "models/fir.glb",
  "lods": [
    { "distance": 45, "glb": "models/fir.glb", "scene": "fir_lod1" },
    { "distance": 45, "glb": "models/fir.glb", "scene": "fir_lod2" }
  ]
}
```

`scene` is optional: a package that stores one level per file validates and loads exactly as
before, which is what keeps existing cooked worlds working.

Measured on the forest bake, before → after:

| | before | after |
| --- | --- | --- |
| `models/` | 29,850,296 | 14,409,596 |
| — fir | 12,814,712 | 7,388,736 |
| — fir-c | 10,398,504 | 4,597,568 |
| — boulder | 5,397,012 | 2,111,892 |
| **streamed total** | **40,378,000** | **25,275,134** (cap 26,214,400) |
| combined `world.glb` | 25,825,628 | 25,825,628 (unchanged) |

Runtime changes: `loadModelWith` picks the named scene out of the one cached parse
(`packages/core/src/world-cell-models.ts`), `assetLevels`/`IAssetState` carry the scene per level,
`assetSignature` includes it so two levels of one file never alias, and the starter's LOD prewarm
dresses each level's own scene (`packages/terrain/src/starter.ts`). The native host reads no
streamed species file, and its `world.json` validator ignores the new optional field.

### Extra finding this pass

**F09 — the forest species LOD contract test was already red at this head.** `assets/__tests__/terrain-world.spec.ts`
"cooks the real forest with index-only species chains" required every kit species to author a `mid`
GLB and to carry an index-only chain. The ground-cover commit added `fern-a`, `fern-b`,
`boulder-small-a` and `boulder-small-b` without a `mid`, so the test threw
`path.join(assets, undefined)`. Fixed to match the cooker's own rules: `mid` optional (the cooker
derives a level), a species under `DEFAULT_LOD_MIN_TRIANGLES` (128) legitimately has no chain, and
the species set comes from the kit's `assets.json`. The golden base-triangle total moved
505,387,464 → 507,894,664; the delta is exactly the four added species (`+2,507,200`), not drift.

## F02 census — where the 40.4 MB goes

Forest bake, measured on this head (`bake.mjs` from `starter/forest` into a temp dir):

| Group | Bytes | Of which duplicated image bytes |
| --- | --- | --- |
| `models/` (7 species, 20 GLBs) | 29,850,296 | **15,090,205** |
| — `fir` 4 levels | 12,814,712 | 5,421,582 (4 × 1,807,194) |
| — `fir-c` 4 levels | 10,398,504 | 5,796,588 (4 × 1,932,196) |
| — `boulder` 4 levels | 5,397,012 | 3,282,363 (4 × 1,094,121) |
| — `fern-a`, `fern-b` 2 levels each | 1,199,736 | 589,672 (2 × 294,836 each) |
| — `boulder-small-a`, `-b` 2 levels each | 40,332 | 0 (no images) |
| `textures/` (4 layers × diff + nrm) | 5,788,083 | ρ |
| `sky.hdr` | 1,637,206 | |
| `placement-ids.json` (PRD-614 sidecar) | 1,269,097 | |
| `placements.bin` | 1,111,040 | |
| `splat.rgba` | 528,392 | |
| `world.json`, `water.json`, `terrain-table.json` | 61,748 | |
| **Streamed total** | **40,378,000** | **15,090,205 = 37.4 %** |

Every LOD GLB of a species embeds a full copy of that species' textures: `farLevelDocument` ends in
`prune({ keepSolidTextures: true })`, and the authored `-mid` level is a separate file from the same
source. Deduplicating across the levels of a species gives 25,287,795 B — 926,605 B under the
unchanged cap.

Three ways to get there, in the order this repo's contracts allow:

1. **One self-contained GLB per species holding every level** (levels as scenes, textures stored
   once). Meets both the size cap and `starter-kit.spec.ts`'s "no external URI" rule. Costs a runtime
   change: the manifest's `assets[].lods[].glb` and `model-lod.ts`/`world-cell-data.ts` would select a
   scene inside a file instead of a file. Needs web + native proof.
2. **Downscale far-level textures** (they switch in past ~150 m). Roughly 14.1 MB saved by the same
   arithmetic, i.e. within 20 KB of the cap — no margin, and it changes what distant trees look like,
   so it needs the paid visual judgement the audit asks for.
3. **External image files shared by the levels** — cheapest to write, but `starter-kit.spec.ts:241`
   deliberately forbids external URIs in a baked GLB, so this one is out.

Recommendation: (1). It is the only option that removes the duplication *and* keeps the contracts,
and its cost is one runtime change with an existing seam (`TN_discrete_lod` already stores upper
levels inside one document).

Note the derived far levels are not the cause on their own: they added ~11 MB of payload, but every
level of every species duplicates its textures, so the `-mid` level carries the same waste.

## Verification

Run in `.worktrees/pr483-audit-fixes` on `bb8657245` + these changes.

| Check | Result |
| --- | --- |
| `pnpm --filter @threenative/assets typecheck` | ✅ 0 errors |
| `pnpm --filter @threenative/terrain typecheck` | ✅ 0 errors |
| `vitest run packages/terrain/__tests__/{terrain-consumer,terrain-mcp,editor-mechanics}.spec.ts` | ✅ 79/79 |
| `vitest run packages/assets/__tests__/terrain-world.spec.ts` | ✅ 36/36 |
| `vitest run packages/core/__tests__/world-* packages/terrain/__tests__` | ✅ 1,228 passed / 4 skipped, ❌ 2 failed — both pre-existing, reproduced at this head with the change stashed |
| `tsc --noEmit` for core, assets and terrain | ✅ 0 errors |
| `vitest run packages/terrain/__tests__/{kit-assets,starter-kit}.spec.ts` | ✅ 31/31 — the F01 pin and the forest byte contract, with the forest `world.json` hash re-pinned |
| Final sweep: 8 spec files (cook, kits, core manifest, world-cells) | ✅ 285/285 |
| New cases red on the unfixed source | ✅ F03 (`Corrupt JPG`), F05 (`Unhandled Rejection: socket closed`), F06 (message lacks the instruction), F08 (no error thrown) |

F02's byte contract is green with the cap unchanged (`starter-kit.spec.ts`, forest bake).

## Open, in the repair order the audit set

1. **Run the headed forest playtest and a visual judge** for the one-file layout. The levels draw
   the same geometry, materials and textures at the same distances, so the expected verdict is
   NEUTRAL; that is a claim a still cannot prove, and the repo requires the judge for anything that
   changes the path a shipped kit draws through. `pnpm --filter strata-terrain-preview
   test:terrain:web` plus a matched BEFORE/AFTER pair is the recipe.
2. **Publish the pinned starter asset pack** through the existing release path; until then a
   published `@threenative/terrain` cannot resolve its art, and `starterAssetsDir()` fails closed with
   `TN_TERRAIN_ASSETS_HTTP: 404 <pinned url>`. The bytes are reproducible:

   ```sh
   node packages/terrain/scripts/pack-starter-assets.mjs /tmp/terrain-starter-assets-0.1.1.tar.gz
   # -> {"bytes":32212004,"sha256":"1bca8689…"}   (matches starter-assets.json)
   gh release create terrain-starter-assets-sha256-1bca8689b8e872ba5db3c70697e10fa99917932f84cb682327dabaa7a2fd7fe4 \
     /tmp/terrain-starter-assets-0.1.1.tar.gz --title "Terrain starter asset revision 1bca8689"
   ```
3. Forest frame attribution and V01 stay with their own lanes.
4. **F10 — two pre-existing reds at this head**, unrelated to this pass and reproduced with the pass
   stashed: `world-cells-view-distance.spec.ts` ("moves the bodies with the follow point", 42 < 49
   bodies) and `world-impostor-surface.spec.ts` ("shadow cutout uses the view sampled alpha").

## Forest stage hang and load time (2026-10-29)

Measured in Chrome DevTools on `?world=forest&stage=after`, dev server, RTX 2080, 1880x880.

| Item | Status | Evidence |
| --- | --- | --- |
| Loader stuck at 50% | ✅ fixed | `AutoBatch` merged the `TerrainTiles` blocks and hid them, so the stage contact ray found no ground and threw every step. `TerrainTiles` sets `userData.batch = "off"`; `auto-batch.spec.ts` red (2 draws) then green (6). The stage contact ray now uses the kit ground's layer 1. |
| Spawn ready time | ✅ 9.0 s -> 5.6 s | The baked JSON is fetched, not imported: `import()` of `horizon.json` took 2937 ms against 484 ms for fetch plus `JSON.parse`. The world package is now requested at 1.15 s, not 4.17 s. |
| Standing at spawn | ✅ 60 FPS | GPU about 11 ms, CPU render about 2.8 ms, quiet GPU. |
| Walking | ❌ open | 15 s holding W: p50 33.3 ms, p95 50 ms, max 433 ms. CPU render stays about 4 ms; GPU goes from 11 ms to 33-45 ms. |
| GPU time grows after a walk | ❌ open, root cause unknown | Teleported back to the spawn after the walk: same 13 draws and 46k counted triangles, GPU 44.6 ms against 11 ms fresh. The frame counter misses the instanced bundles: the scene census at a fresh spawn shows about 35 M visible instanced triangles (fir bundles 18 M). Next: find what keeps GPU work after the player leaves (bundle instance counts, LOD selection, indirect draws). |
| `scripts/check-temperate.mts` | ⚠️ red before this pass | Fails at `scatter.placements.map((one) => one.id)` on HEAD without these edits. |
