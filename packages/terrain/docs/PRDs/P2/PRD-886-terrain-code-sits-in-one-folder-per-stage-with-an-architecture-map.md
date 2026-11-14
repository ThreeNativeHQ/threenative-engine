# PRD-886 — Terrain code sits in one folder per stage, with an architecture map

**Status:** IN PROGRESS
**Priority:** P2 — An agent that changes terrain output cannot find the owning file from the folder names (AC-1 to AC-4 open); no architecture document for terrain exists.
**Complexity:** 3 (LOW); risk override: MEDIUM, because `@threenative/terrain` is published and its public exports, `dist` layout and capability manifest must not change.
**Owner:** ThreeNative maintainers
**Depends on:** None. [PRD-887](../P2/PRD-887-a-region-request-cooks-its-real-ground-and-plant-community.md) builds on the folders this PRD creates.

## Context

Owner, 2026-11-13: "I'm having a hard time changing output of terrains", then "lets plan for a
structural refactoring, I think things are not properly placed on correct folders that make it
intuitive for any AI working here to work", then "this initial PRD will also create the proper
docs, architecture.md for the terrain, using mermaid diagrams to display relationships", then
"must be in a docs folder here, not on root engine ... strata related PRDs".

Read on 2026-11-13 at `dc131b610` (branch `prd-584-forest-60fps`):

- **`packages/terrain/src/core/` is one flat folder of 32 files and 9 174 lines.** It holds the
  recovered evaluator (`terrain.ts`, `operations.ts`, `erosion.ts`) beside request words
  (`request-words.ts`, `biome-words.ts`), the biome schema (`biome.ts`), survey sites
  (`surveys.ts`), scatter (`scatter-ordered.ts`, 963 lines) and world packaging
  (`world-package.ts`, `prop-package.ts`). The folder name does not tell an agent which stage a
  file belongs to.
- **`packages/terrain/src/mcp/cook.ts` is 1 468 lines.** One file reads the ground
  (`readGroundHeightmap`, `applyGround`, `forestFloor`, `farRing`), shapes the water
  (`applyWaterRows`, `placeLakes`, `routeRivers`, `shapeCoast`), scatters foliage
  (`scatterFoliage`), calls the world cook and writes the game snippet (`cookInto`, 300 lines).
- **Three producers write terrain output, and no document says which one an agent is looking at.**
  A starter `bake.mjs` calls `bakeKit` (`src/kit.ts`). The MCP tool `terrain_generate` calls
  `cookKit` (`src/mcp/cook.ts`). The preview runs `examples/strata-terrain-preview/scripts/bake.mjs`
  and draws with its own `src/render/`. The bridge between them is the environment variable
  `STRATA_WORLD` (`scripts/recipe.mjs:149`).
- **The preview is flat too.** `examples/strata-terrain-preview/src/render/` holds 39 files and
  14 901 lines in one folder (`terrain.ts` 1 805, `propMaterials.ts` 1 258, `editorView.ts` 1 230).
  `scripts/` holds 42 entries in one folder: bakes, asset preparation, measures and proofs.
- **One visual change crosses five packages.** The uncommitted forest diff on this branch touches
  10 files in `packages/assets`, `packages/core`, `packages/create-threenative`, `packages/terrain`
  and the preview.
- **Stale output hides edits.** A bake imports `@threenative/assets` from its built `dist`, the
  generated `world.glb` is not tracked, and Vite prebundles installed packages. Each one has shown
  an old result after a correct edit.
- **Strata planning files sit in the engine root.** `packages/terrain/docs/PRDs/` holds 20
  files, `docs/PRDs/refactoring/strata-refactoring/` holds 3 and
  `docs/PRDs/open-world/PRD-580-strata-starter-kit-art-bar.md` is a Strata PRD in a third folder.
  An agent that works in `packages/terrain/` does not see them.
- **No terrain architecture document exists.** `docs/architecture/` has 11 documents and none for
  terrain. The knowledge is spread over `packages/terrain/AGENTS.md`, `AGENT_GUIDE.md`, the preview
  `AGENTS.md` and five starter READMEs.

Related work that this PRD does not repeat: PRD-588 (done) split the editor into typed modules.
PRD-797 to PRD-799 split the core world files. [PRD-864](../P2/PRD-864-prop-and-collar-mechanisms-leave-the-strata-preview.md)
and [PRD-591](../P2/PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md)
move mechanisms out of the preview into the engine. This PRD moves files and writes the map. It
changes no behaviour.

## Solution

### 1. The map: `packages/terrain/docs/architecture/architecture.md`

Strata documents live in `packages/terrain/docs/`, beside the code (owner, 2026-11-13).
`packages/playtest/docs/` and `packages/runtime-native/docs/` are the precedent. The package
`files` list does not name `docs`, so nothing new is published.

One document, written first, so it helps before any file moves. Diagrams are Mermaid. It has these
parts:

1. **Pipeline diagram** (`flowchart LR`): request → `parseGenerateRequest` → biome spec → ground →
   evaluator → water → population → `cookTerrainWorld` (`@threenative/assets`) → world package
   (`world.glb`, `world.json`, tiles, `water.json`, `ring.json`) → `addStarterWorld` and
   `TerrainWorldCells` in the game.
2. **Package diagram** (`flowchart TD`): `@threenative/terrain`, `@threenative/assets`,
   `@threenative/procedural-vegetation`, `@threenative/core/world`, `@threenative/physics`,
   `create-threenative` (kit staging) and the preview, with the direction of each import.
3. **Producer diagram**: the three producers of terrain output, the files each one reads, the
   files each one writes and the `STRATA_WORLD` bridge.
4. **Edit-to-pixel diagram** (`sequenceDiagram`): edit a file → which `dist` to rebuild → which
   bake to run → which page shows it.
5. **Routing table**, one row per thing an agent changes: ground shape, ground texture, tree
   species, tree density, water, sky and light, far ring, loading and streaming, request words.
   Each row names the file, the rebuild command and the page that shows the result.
6. **Stale-output table**: stale `dist`, stale `world.glb`, Vite prebundle, each with its symptom
   and its one command.

A census spec keeps the map true: every path the document names in backticks exists, and every
folder under `packages/terrain/src/` and under the preview `src/render/` and `scripts/` has a row.
It is a clone of `scripts/__tests__/strata-script-census.spec.ts`. A move that forgets the map
fails that spec in the same commit.

`packages/terrain/AGENTS.md` and the preview `AGENTS.md` each get one line that points to the map.
`pnpm sync:agents` regenerates the mirrors.

**Strata PRDs move to `packages/terrain/docs/PRDs/`.** `git mv` moves the two root folders and
PRD-580, with each link fixed. `docs/PRDs/AGENTS.md` gets the rule, and `.ignore` hides
`packages/terrain/docs/PRDs/done/` as it hides `docs/PRDs/done/`. A Strata PRD that finishes after
the move goes to `packages/terrain/docs/PRDs/done/`. The PRDs already in `docs/PRDs/done/` and in
`docs/PRDs/BLOCKED/` stay there, because a finished PRD is not un-filed and the blocked folders
name what unblocks each file.

### 2. `packages/terrain/src/`: one folder per stage

`core/` keeps the recovered evaluator and the files every stage shares. Each other stage gets its
own folder. The public entry files, the `tsup` entry keys and each exported name stay the same, so
the `dist` layout and the capability manifest do not change.

| Folder | Stage | Files that move in |
| --- | --- | --- |
| `core/` | The evaluator and shared types | Stays: `terrain.ts`, `operations.ts`, `erosion.ts`, `fluvial.ts`, `gully.ts`, `scree.ts`, `masks.ts`, `math.ts`, `types.ts`, `validation.ts`, `stats.ts`, `io.ts` |
| `request/` | Words to a decided request | `core/request-words.ts`, `core/biome-words.ts`, and `parseGenerateRequest` with its helpers from `mcp/tools.ts` |
| `biome/` | The biome file and its rules | `core/biome.ts`, `core/bands.ts`, `core/kits.ts`, `core/bake-biome.ts` |
| `ground/` | Where the heights come from | `core/surveys.ts`, `core/presets.ts`, `core/massif.ts`, `mcp/survey.ts`, and from `cook.ts`: `readGroundHeightmap`, `applyGroundLayer`, `seededCrop`, `forestFloor`, `applyGround`, `farRing` |
| `water/` | Rivers, lakes, coast | `core/water.ts`, and from `cook.ts`: `applyWaterRows`, `seaLevel`, `carveFeatures`, `shapeCoast`, `placeLakes`, `routeRivers`, `floodedBodies` |
| `population/` | What grows and where | `core/scatter-ordered.ts`, `core/placements.ts`, `core/placement-edits.ts`, `core/cover-field.ts`, `core/grass-field.ts`, `mcp/arbor-species.ts`, and `scatterFoliage` from `cook.ts` |
| `package/` | The files a world ships as | `core/world-package.ts`, `core/prop-package.ts`, `core/export.ts`, `core/far-field.ts`, `core/bake.ts`, `mcp/glb-stats.ts` |
| `cook/` | The cook's order of stages only | `mcp/cook.ts` (what is left: `cookKit`, `cookInto`, `loadCooker`), `mcp/cook-child.ts`, `mcp/child.ts` |
| `mcp/` | Tool schemas and dispatch | Stays: `server.ts`, `tools.ts` |
| `editor/` | The live editor | Stays as PRD-588 left it |

Step 1 of Phase 2 confirms each row from the file's imports. A file that two stages import stays
in `core/`. `core/io.ts` stays because `scripts/prepare-release.ts:280` names its path.

### 3. The preview: one folder per concern

| Today | After |
| --- | --- |
| `src/render/` (39 files) | `src/render/ground/`, `src/render/props/`, `src/render/water/`, `src/render/sky/`, `src/render/editor/`, and the files that serve all of them at `src/render/` |
| `scripts/` (42 entries) | `scripts/bake/`, `scripts/prep/`, `scripts/verify/`, `scripts/measure/` |

Appearance stays under `src/render/`, as the root `AGENTS.md` requires. `package.json` scripts,
the script index in the preview `AGENTS.md` and the test imports change with the move.

### Risks

- **Public surface.** A consumer imports `@threenative/terrain`, `/three`, `/export`, `/kit`,
  `/starter`, `/editor` and `/editor/server`. AC-3 compares the packed file list and the capability
  manifest before and after.
- **Deep paths in this repository.** `scripts/capture-terrain-mcp-tools.ts`,
  `scripts/__tests__/mcp-tool-schemas.spec.ts`, `scripts/__tests__/temp-dir-guard.spec.ts`,
  `scripts/__tests__/ci-structure.spec.ts:4440`, `scripts/prepare-release.ts:280` and
  `examples/strata-terrain-preview/__tests__/editor-durability.spec.ts` name paths under
  `packages/terrain/src/`. Each move updates the ones it breaks.
- **PRD paths in open work.** Open pull requests and the PRD dashboard name the root PRD paths.
  The move is one commit of `git mv` plus link fixes, and `pnpm check:docs` finds each broken link.
- **Open pull requests.** PR #677 (`prd-584-forest-60fps`) and PR #591 edit the preview. Before
  Phase 3, run `gh pr list` and `pnpm worktree:status`. Move with `git mv` in one commit that
  changes import paths only, so Git follows each rename in a later merge.
- **A move that changes output.** The moves change no logic. AC-4 proves it with the golden bake
  digests and the kit bake.

Not in this PRD: a bake that detects a stale `dist` and fails closed. The map documents the trap.
A guard is a separate change in `packages/terrain/src/kit.ts` and `packages/assets`.

## Acceptance Criteria

- [x] AC-1 [local]: `packages/terrain/docs/architecture/architecture.md` has the four Mermaid diagrams, the routing table and the stale-output table, and each path it names exists. proof: `pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts && pnpm check:docs` — Evidence (2026-11-13): census 7/7 green, `pnpm check:docs` exit 0 (3 968 links).
- [ ] AC-2 [local]: No stage function is left in the cook: `cook/cook.ts` is 450 lines or fewer, and `core/` holds the evaluator files only. proof: `wc -l packages/terrain/src/cook/cook.ts` and `ls packages/terrain/src/core` against the Solution table — Evidence: pending.
- [ ] AC-3 [local]: The published package and the capability manifest are the same before and after. proof: `npm pack --dry-run --json` in `packages/terrain` gives the same file list on both arms, and `pnpm build && git diff --exit-code packages/core/capabilities.json` — Evidence: pending.
- [ ] AC-4 [local]: Terrain output is the same before and after. proof: `pnpm --filter @threenative/terrain test` (it includes `bake-golden.spec.ts` and `terrain-mcp.spec.ts`), and `sha256sum` of `world.glb` from `node packages/terrain/starter/forest/bake.mjs --out <dir>` is equal on both arms — Evidence: pending.

## Integration Ledger

Integration: unchanged — files move and one file splits. Each public entry (`src/index.ts`,
`src/kit.ts`, `src/starter.ts`, `src/three.ts`, `src/export.ts`, `src/editor/index.ts`,
`src/editor/server.ts`, `src/mcp/server.ts`) keeps its path, its `tsup` key and its exports. AC-3
and AC-4 prove it through the packed package, the MCP spec and the kit bake.

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Terrain architecture map | An agent opens `packages/terrain/AGENTS.md` or the preview `AGENTS.md` and follows the one link | New; replaces no file. The AGENTS files keep their rules | AC-1 |

## Decisions

- 2026-11-13 (owner): Strata PRDs and Strata documents live in a docs folder inside `packages/terrain/`, not in the engine root `docs/`.
- 2026-11-13 (agent): the structural work and the region work are two PRDs, because the filing rule caps a PRD at 3 phases and about 8 boxes. PRD-887 holds the region work.
- 2026-11-13 (agent): `core/` keeps its name for the evaluator, so the smallest number of files move and the package rule "preserve the recovered evaluator" stays true by path.

## Execution Phases

#### Phase 1: The map exists and a spec keeps it true

**Status:** IN PROGRESS — the map is done; the `docs/PRDs/AGENTS.md` rule and the `.ignore` entry for the moved PRDs are still open.
**Files:** `packages/terrain/docs/architecture/architecture.md` (new), `scripts/__tests__/terrain-architecture-census.spec.ts` (new, cloned from `strata-script-census.spec.ts`), `packages/terrain/AGENTS.md`, `examples/strata-terrain-preview/AGENTS.md`, `docs/PRDs/AGENTS.md`, `.ignore`, the generated `CLAUDE.md` mirrors, and the moved PRD folders.
**Implementation:** Write the six parts from Solution 1 against the layout as it is today. Trace each diagram edge from an import or a call, not from memory. Add the pointer lines and run `pnpm sync:agents`. Then move the Strata PRDs in one commit of `git mv` and fix each link.
**Verification:** the census spec, `pnpm check:docs`, `pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts`.

- [x] `packages/terrain/docs/architecture/architecture.md` is written, both AGENTS files point to it, and the census spec fails when the map names a missing path or omits a terrain folder. proof: `pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts` — Evidence (2026-11-13): census 7/7, and with `primary-docs`, `sync-agent-docs`, `check-doc-links` and `strata-script-census` 35/35; a fake path and a fake script name in `cook.md` each turned the spec red, and restoring it turned it green. The map also has two companions, `cook.md` and `world-package.md`, held to the same checks.
- [ ] The open Strata PRDs are under `packages/terrain/docs/PRDs/` and each link resolves. proof: `ls packages/terrain/docs/PRDs docs/PRDs/refactoring/strata-refactoring` finds no folder, and `pnpm check:docs` exits 0

#### Phase 2: `packages/terrain/src/` has one folder per stage

**Status:** NOT STARTED
**Files:** every file in the Solution 2 table, the public entry files (import paths only), `packages/terrain/tsup.config.ts` (source paths only, same keys), the deep-path consumers under Risks, `packages/terrain/docs/architecture/architecture.md`.
**Implementation:** Record the before arm first: the packed file list and the forest `world.glb` hash. Move one stage per commit with `git mv` and fix imports. Then cut the stage functions out of `cook.ts` into their stage folders. Keep each exported name. Update the map in the same commit as each move.
**Verification:** `pnpm --filter @threenative/terrain typecheck`, `pnpm --filter @threenative/terrain test`, the census spec, `pnpm exec vitest run scripts/__tests__/mcp-tool-schemas.spec.ts scripts/__tests__/temp-dir-guard.spec.ts scripts/__tests__/prepare-release.spec.ts`.

- [ ] The six stage folders exist and `core/` holds the evaluator files only. proof: `pnpm --filter @threenative/terrain typecheck && pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts`
- [ ] `cook/cook.ts` is 450 lines or fewer and the package tests pass. proof: `wc -l packages/terrain/src/cook/cook.ts && pnpm --filter @threenative/terrain test`

#### Phase 3: The preview has one folder per concern

**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/src/render/**`, `scripts/**`, `package.json`, `AGENTS.md` (script index), `__tests__/**` (import paths), `scripts/__tests__/strata-script-census.spec.ts` if a path pattern changes, `packages/terrain/docs/architecture/architecture.md`.
**Implementation:** Inventory open pull requests and worktrees first (Risks). Move `src/render/` in one commit and `scripts/` in a second one, with import paths as the only content change.
**Verification:** `pnpm --filter strata-terrain-preview typecheck`, `pnpm --filter strata-terrain-preview test`, `pnpm --filter strata-terrain-preview test:terrain:web`, both census specs.

- [ ] `src/render/` and `scripts/` are grouped as in Solution 3, and the preview tests and the shared web scenario pass. proof: `pnpm --filter strata-terrain-preview test && pnpm --filter strata-terrain-preview test:terrain:web && pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts scripts/__tests__/terrain-architecture-census.spec.ts`
