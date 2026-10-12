# PRD-487 — Imported materials keep their detail

**Status:** PROPOSED
**Priority:** P2 — Importer drops every unmapped texture as UnsupportedTexture; mapping unbuilt.
**Complexity:** 3 (LOW) — 1–5 implementation files (+1: two importer files, the cook's path rewrite, the starter's `materials.ts`); the importer is the separate `threenative-asset-mcp` repo, a linked dependency released on its own (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-485](../../done/PRD-485-high-quality-assets-go-through-the-cook.md) (the Fab tree cooks by default). Excludes skin and hair, which are [PRD-VQ-14](../../rendering/PRD-VQ-14-skin-material-qualification.md) and [PRD-VQ-15](../../rendering/PRD-VQ-15-hair-card-material-qualification.md). Must keep [PRD-369](../../assets/PRD-369-material-variation-is-data.md)'s program-count discipline.

## Context

The Unreal importer (`/home/joao/projects/threenative/threenative-asset-mcp`, a linked dependency, not in this repo) maps a material graph onto glTF's five slots (`SLOT_ORDER`, `src/unreal/importer.ts:721`). It already repacks Unreal's packed masks into glTF `metallicRoughness` and `occlusion` (`importer.ts:699`). Every other texture becomes an `UnsupportedTexture { texture, reason }` (`src/unreal/materials.ts:50`). That record drops the Unreal parameter name. The texture is written beside the GLB and listed only in the import report's `sidecarTextures` (`importer.ts:93`, `:329`). Nothing in `packages/` reads it: `rg sidecar` over `packages/core/src` and `packages/assets/src` finds nothing.

The Fab Hornbeam (PRD-485) shows the cost. Its unmapped inputs are `TwoSided_Summer_Mask`, `TwoSided_Winter_{Albedo,Mask,Normal}`, `Decoration_Mask`, `Tileable_Mask` and `T_WindNoise`, all 8192² or 4096². The game excludes them (`exclude: ["fab/c6f917b6/textures/**"]`), so its leaves render as flat, opaque glTF PBR with no back-lighting and no detail normal. No template or core file builds a detail normal or foliage translucency today.

The transport already exists. Three's `GLTFLoader` copies a material's glTF `extras` onto `material.userData` (`three@0.185.1` `GLTFLoader.js:3684`), and `ctx.assets.texture(path)` loads any cooked texture by logical path.

## Solution

The importer records, the cook carries, and the template decides the look:
1. **Importer (mechanism, linked repo).** Each glTF material gets `extras.unreal = { textures: { <parameter>: <relative path> }, scalars: {…}, vectors: {…} }`. It holds every unmapped texture under its Unreal parameter name, plus the instance's scalar and vector parameters (tiling, translucency strength).
2. **Cook (mechanism, `packages/assets`).** Material extras survive the model pass. The textures they name are cooked like any other texture, and their paths are rewritten to logical paths the loader resolves.
3. **Look (template source).** `importedSurface(model, assets)` is added to `packages/create-threenative/templates/starter/src/render/materials.ts`. It reads `userData.unreal` and applies two things in TSL: a tiled detail normal and foliage back-light translucency driven by the two-sided mask. Materials with the same input set share one program.

## Decisions

- 2026-10-03 (agent, proposed): foliage translucency is template TSL, never `KHR_materials_transmission` written into the GLB. AutoLOD declines any material with a transmission extension (`packages/assets/src/lod/eligibility.ts:137`), so a 755k-triangle tree would lose its chain. Transmission also adds a refraction pass that foliage does not need.
- 2026-10-03 (agent, proposed): no new core API. The `extras` → `userData` path and `ctx.assets.texture` already carry everything. If a core helper turns out to be needed, it must first beat the kill switch (`scripts/count-loc.ts`).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Named Unreal inputs | `fab_import_asset` / `asset_import_unreal` → `resolveMaterial` → glTF material `extras` | report-only `sidecarTextures`; kept as a summary | Phase 1 |
| Cooked inputs at runtime | `threenative build` model + texture passes → `ctx.assets.model()` → `material.userData.unreal` | game `exclude` of the importer's textures; deleted | Phase 2 |
| Detail and translucency look | `importedSurface()` in the starter's `src/render/materials.ts` | flat glTF PBR | Phase 3 |

## Blocked on

- Agents invoke the importer from a prebuilt copy under `../sandbox/.mcp-tools/`, not from source, so a merged importer change reaches them only after that copy is rebuilt and published. This is unblocked by an asset-mcp release.

## Execution Phases

#### Phase 1: The importer names what it could not map
**Status:** NOT STARTED
**Files:** `threenative-asset-mcp/src/unreal/materials.ts`, `threenative-asset-mcp/src/unreal/importer.ts`
- [ ] [local] Every unmapped texture lands in the material's `extras.unreal.textures` under its Unreal parameter name, along with the instance's scalar and vector parameters. proof: red-green case in `npx vitest run tests/unreal-import.integration.test.ts` (asset-mcp).
- [ ] [local] Re-importing the cached Hornbeam pack writes `extras.unreal` naming its two-sided mask and normal. proof: the integration test's cached-pack case, or `fab_import_asset` into a scratch dir and a read of the GLB's material extras.

#### Phase 2: The cook carries them
**Status:** NOT STARTED
**Files:** `packages/assets/src/passes/model.ts` (extras path rewrite); `packages/assets/__tests__/compile.spec.ts`
- [ ] [local] After compact, join and dedupe, a cooked GLB keeps material `extras.unreal`. Each path in it resolves to a cooked texture, and two materials that differ only in extras are not merged. proof: red-green case in `pnpm exec vitest run packages/assets/__tests__/compile.spec.ts`.
- [ ] [local] Loaded through `ctx.assets.model()`, the extras arrive on `material.userData.unreal`, and `ctx.assets.texture()` loads each named path. proof: `pnpm exec vitest run packages/core/__tests__/assets.spec.ts`.

#### Phase 3: The template applies the look
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/materials.ts`, `templates/starter/AGENTS.md`
- [ ] [local] `importedSurface` builds the detail-normal and translucency nodes, and 12 Hornbeam-like materials with one input set compile to one program. proof: new `packages/create-threenative/__tests__/imported-surface.spec.ts`.
- [ ] [local] The Hornbeam with `importedSurface` beats glTF-only PBR at three same-pose views. proof: `pnpm visuals:ab --before <gltf-only> --after <imported> --out <dir>` plus a fresh judge subagent.
- [ ] [local] Native desktop renders the same surface with no shader or loader diagnostics. proof: `fab-import-proof/native-playtests/fab-import-native.playtest.json --target desktop`.
- [ ] [local] The starter's `AGENTS.md` names the convention: imported Unreal inputs reach the look through `importedSurface`. proof: `pnpm exec vitest run scripts/__tests__/instruction-budget.spec.ts`.
