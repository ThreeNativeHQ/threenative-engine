# PRD-493 — Terrain layers past sixteen textures

**Status:** PARTIAL — phases 1, 2 and 3 landed; both Machinefall acceptance criteria are blocked on what is listed under `## Blocked on`
**Priority:** P2 — Open: AC-1 and AC-2 both need Machinefall's private walk, listed under `## Blocked on`.
**Complexity:** 3 (LOW) — 1–5 implementation files (`world-terrain-splat.ts`, the two identical `export_world.py` recipe copies) (+1); Machinefall re-exports its table and releases separately (+2); risk override: none
**Owner:** João
**Depends on:** None

## Context

`loadTerrainSplat` (`packages/core/src/world-terrain-splat.ts`) builds the splat material for `WorldCells`. Machinefall uses it (`apps/client/src/level/World.ts`) for a base plus 7 layers, 3 of them with normal maps. The audit's "capped at 16 textures" is only half true:

- **Already stacked:** the splat masks are one `DataArrayTexture` (`splatArray`). The albedo and normal sets each collapse into one `CompressedArrayTexture` (`stackLayers`), as long as every layer is compressed with the same format, size and mip count. That path costs one sampler per set, whatever the layer count.
- **Still capped:** uncompressed layers do not stack. `stackLayers` returns `undefined` for anything that is not a `CompressedTexture`, so each layer binds its own sampler and only a `TN_TERRAIN_SPLAT` warning is printed. That is the path for any game that skips the KTX2 cook, and for Android and iOS, which have no KTX2 transcoder (`packages/runtime-native/AGENTS.md`). On those hosts the cap is real.
- **Stale contract:** the `@constraint` still says "planes + diffuse maps + normal maps must fit" in 16. It also names an `export_terrain_layers.py` recipe that does not exist; the function `export_terrain_layers` lives in `export_world.py`. `capabilities.json` repeats both.
- **No per-layer roughness or AO.** The material hard-codes `MeshStandardNodeMaterial({ metalness: 0, roughness: 0.92 })`. That is a look constant in package code, and every layer gets it. Megascans-grade layers ship albedo + normal + ORM.
- **Cost grows with layer count.** Every pixel samples every layer through the `mix` chain, and triplanar layers sample three times.

Out of scope: virtual texturing (WORLD-STREAMING.md) and texture residency ([PRD-VQ-10](../Unreal/performance/PRD-VQ-10-texture-mip-residency.md)), and per-layer height blending ([PRD-567](../done/PRD-567-terrain-layers-blend-by-their-own-height.md)), which keeps this PRD's "no new curve vocabulary" rule by adding only a height set and a weight seam to the package and leaving the curve in game source.

## Solution

Mechanism in `packages/core`, values in the game's table:
1. **Uncompressed layers stack too.** Same-size uncompressed maps go into one array texture per set, through a GPU copy into each layer and not a CPU pixel read. Mixed sizes still fall back, now with a marker that names the sampler count.
2. **ORM is a third set.** A layer with `orm: true` in the table reads `<id>_orm.jpg` as linear data into `roughnessNode`, `aoNode` and `metalnessNode`. Layers without it use the table's own `roughness` and `metalness`. The 0.92 constant leaves the package. The export recipe writes `_orm` beside `_diff` and `_nrm`, in both copies of `export_world.py`.
3. **The marker reports cost.** `TN_TERRAIN_SPLAT layers=<n> samplers=<n> stacked=<sets>` prints once per material.

The blend curve keeps its current form (mask, `lo`/`hi`, breakup push, macro noise), and every value still comes from the game's table. A game that wants a different curve edits the returned material. No new curve vocabulary goes into the package. Top-K weight sampling is added only if AC-2 fails without it.

## Acceptance Criteria

- [ ] AC-1 [local]: Machinefall's map-walk with ORM layers is judged at or above develop on every pose, with no seam or tiling artefact named. proof: `pnpm visuals:world --before <develop> --after <candidate>` plus 3 verdicts. Not attempted: Machinefall (`apps/client`) is a private repo this tree cannot see, so there is no walk to run or to capture here; the branch's own sixteen-layer package is captured instead (`/home/joao/projects/threenative/threenative-engine/.afk/scratch/prd493-captures/phase-1-2/`, `after.png` this branch against a develop frame that never reaches one — 34 samplers against a limit of 16). A judge still has to say whether the ORM layers look right.
- [ ] AC-2 [local]: the same walk's `gpuMain` p95 rises by no more than 0.5 ms over develop on the RTX 2080. proof: `TN_FRAME_BUDGET` from `node packages/playtest/dist/runner/cli.js perf`, 3 interleaved runs. Not attempted: same private repo, and the budget names an RTX 2080 this machine does not have.

## Blocked on

- **Machinefall's own walk (AC-1, AC-2)** — the private repo holding `apps/client/src/level/World.ts`; the owner has to run the walk and the three interleaved perf runs, or make it reachable.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Stacked uncompressed sets and ORM set | `loadTerrainSplat` → `WorldCells.load({ surface })` (Machinefall `World.ts:125`) | Per-layer sampler fallback kept only for mixed sizes | Phase 1–2, AC-1 |

## Execution Phases

#### Phase 1: Every same-size set is one sampler
**Status:** LANDED
**Files:** `packages/core/src/world-terrain-splat.ts`; `packages/core/__tests__/world-terrain-splat.spec.ts`
- [x] Sixteen uncompressed same-size layers with normals build a material that references one array texture per set (3 sampled textures with the splat array). Mixed sizes still fall back and the marker names the count. proof: red-green `pnpm exec vitest run packages/core/__tests__/world-terrain-splat.spec.ts` — 3 red (uncompressed stack `undefined`, `renderer` unknown), then 9/9 green exit 0; the 16-layer case walks the node graph and counts 3 distinct sampled textures, and `TN_TERRAIN_SPLAT layers=4 samplers=6 stacked=1` names the fallback's cost.
- [x] The `@constraint` and recipe name are corrected, and the regenerated manifest carries them. proof: `pnpm build` exit 0, then `pnpm exec vitest run scripts/__tests__/capability-manifest.spec.ts scripts/__tests__/generate-capability-reference.spec.ts` — 28/28 green, both exit 0. `pnpm typecheck` and `pnpm lint` exit 0.

Uncompressed layers stack through `renderer.copyTextureToTexture` per layer (`ILoadTerrainSplatOptions.renderer`, so a game passes `ctx.renderer`); the array itself is created with `source.dataReady = false`, so no CPU pixel read and no zero upload stand in for a copy. Without a renderer every layer keeps its own sampler and the marker says what that costs.

#### Phase 2: ORM per layer
**Status:** LANDED
**Files:** `packages/core/src/world-terrain-splat.ts`, `packages/blender-mcp/gpl/recipes/export_world.py`, `packages/core/gpl/recipes/export_world.py`
- [x] A table layer with `orm: true` drives roughness, AO and metalness from its map. A layer without it uses the table's values, and no numeric look constant remains in `loadTerrainSplat`. proof: red-green `world-terrain-splat.spec.ts` — 4 red (no `_orm.jpg` request, no `aoNode`/`roughnessNode`/`metalnessNode`), then 11/11 green exit 0. `MeshStandardNodeMaterial()` now takes no `metalness: 0, roughness: 0.92`, the three nodes carry the blended ORM chain, and a layer that states neither an ORM map nor both numbers throws before any texture loads.
- [x] The recipe writes `<id>_orm.jpg` for a layer whose material has a roughness input. proof: red-green `pnpm exec vitest run packages/blender-mcp/__tests__/export-world.spec.ts` — with the recipe change stashed the case saw 3 files where it wanted 4 (red), then 9/9 green exit 0 with Blender 5.2.0 LTS (not skipped: no `TN_BLENDER_TESTS_SKIPPED`). A second case proves a table naming no `orm` source fails closed. Both copies of `export_world.py` remain byte-identical.

## Decisions

- **2026-10-04 — the recipe keys ORM off the table's `orm` flag, not a Blender material lookup.** The
  table is the file the DCC's own terrain shader already reads, and it is what `normal` has always
  keyed off, so a second source of truth (a material named after the layer id) would be a new
  convention to keep in sync. The recipe fails closed when a layer asks for an ORM map and the table
  names no `orm` source.
- **2026-10-04 — a layer with neither `orm` nor `roughness`/`metalness` throws.** The alternative was
  a neutral default inside the package, which is the look constant this PRD exists to remove; a table
  written before ORM now fails with a message naming the recipe instead of silently changing how every
  layer catches the light.

#### Phase 3: Native and mobile sample the arrays
**Status:** LANDED
**Files:** `packages/runtime-native/conformance/scenes/shared/terrain-splat-array.js` (new), `registry.json`
- [x] A conformance row renders a 16-layer uncompressed splat package (albedo, normal and ORM per layer) on desktop within tolerance of the browser reference, with `samplers=4` in its marker. proof: `pnpm parity --target web --only-tests terrain-splat-array` captured the browser reference (pass, 1280x720, non-uniform), then `pnpm parity --target desktop --only-tests terrain-splat-array` — pass, 16.6 s, `metrics.pixelMismatchRatio: 0`, `metrics.perceptualDeltaE: 0`, 0 GPU validation errors; the scene throws unless the marker reads `layers=16 samplers=4 stacked=3`. `packages/runtime-native` conformance suite 76/76 green. Captures for a judge: `/home/joao/projects/threenative/threenative-engine/.afk/scratch/prd493-captures/phase-3/` (`before.png` the browser reference, `after.png` the desktop-native frame, same pose; develop has no such row to capture from).
- [x] The same row on the Android emulator, which is the host without a KTX2 transcoder. proof: `pnpm parity --target web --only-tests terrain-splat-array` captured the browser reference (pass, nvidia/turing, 1280x720, non-uniform), then `pnpm parity --target android --only-tests terrain-splat-array --device emulator-5554` (2026-10-06, AVD `threenative_api35`, API 35, x86_64, `-gpu host`, not a phone): the row is `pass`, `metrics.pixelMismatchRatio: 0`, `metrics.perceptualDeltaE: 0`, 0 GPU validation errors, fresh install, APK bundle verified. The scene throws unless the marker reads `layers=16 samplers=4 stacked=3`, so the pass is that marker on Android. The earlier `:app:verifyV8Dependency` refusal is gone because this worktree carries a receipt-verified `third_party/v8-android` (PRD-485's lane). The command still exits 1: its separate `supplemental.androidMultitouch` lane (`examples/native-smoke` multitouch playtest) fails with `maxPointers: 1` and `TN_PLAYTEST_AXIS_DELTA_ASSERTION_FAILED`, which is not this row. Note: since PRD-485, Android V8 does transcode KTX2, so "no KTX2 transcoder" now holds for Android QuickJS and iOS only. The row's fixture is `DataTexture`s, so it proves the uncompressed stack on Android, not the compressed one.

The row builds its 48 maps as `DataTexture`s from a pure function of their cell, so both lanes
derive the same bytes; a 4x4 mask grid gives each layer its own region, which is what makes one
sampled texture per set visible in a single frame rather than asserted only by the marker.
