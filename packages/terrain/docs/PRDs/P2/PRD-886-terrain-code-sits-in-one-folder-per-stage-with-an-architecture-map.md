# PRD-886 — Terrain code sits in one folder per stage, with an architecture map

**Status:** IN PROGRESS — Phase 1 and Phase 2 complete, Phase 3 code complete (2026-11-14); one proof is open: the shared web scenario has not run green on this host.
**Priority:** P2 — An agent that changes terrain output cannot find the owning file from the folder names (AC-1 to AC-5 closed; Phase 3's box waits only on its web run).
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

A bake that detects a stale `dist` fails closed (owner, 2026-11-13). Phase 2 adds the guard in
`packages/terrain/src/kit.ts`, the cook and the preview bake: when a package's `src/` is newer than
its `dist`, the bake stops with a named error and the one command that fixes it.

Guardrails keep the stage folders small after the split (owner, 2026-11-13: "guardrails like eslint
to avoid ... DRY/SRP/KISS violations, godzilla files"). Biome already lints this package, so no
second linter: `scripts/check-quality.ts` ratchets file length (notice 400, loud 800, cap 3 000) and
Biome's `noExcessiveCognitiveComplexity` (15) warns on 83 functions today. Phase 2 makes both fail
for `packages/terrain/src/` once the split removes the existing offenders, and adds a duplicate-code
check only if the existing tools cannot report it.

## Acceptance Criteria

- [x] AC-1 [local]: `packages/terrain/docs/architecture/architecture.md` has the four Mermaid diagrams, the routing table and the stale-output table, and each path it names exists. proof: `pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts && pnpm check:docs` — Evidence (2026-11-13): census 7/7 green, `pnpm check:docs` exit 0 (3 968 links).
- [x] AC-2 [local]: No stage function is left in the cook: `cook/cook.ts` is 450 lines or fewer, and `core/` holds the evaluator files only. proof: `wc -l packages/terrain/src/cook/cook.ts` and `ls packages/terrain/src/core` against the Solution table — Evidence (2026-11-14): `cook/cook.ts` is 368 lines; `core/` holds exactly the twelve files the table keeps (`erosion.ts`, `fluvial.ts`, `gully.ts`, `io.ts`, `masks.ts`, `math.ts`, `operations.ts`, `scree.ts`, `stats.ts`, `terrain.ts`, `types.ts`, `validation.ts`); the seven stage folders exist beside it (`biome/`, `cook/`, `ground/`, `mcp/`, `package/`, `population/`, `request/`, `water/`, plus `editor/`).
- [x] AC-3 [local]: The published package and the capability manifest are the same before and after. proof: `npm pack --dry-run --json` in `packages/terrain` gives the same file list on both arms, and `pnpm build && git diff --exit-code packages/core/capabilities.json` — Evidence (2026-11-14): a `git worktree` at HEAD built with the same tsup config packs 82 files and the refactored tree packs the same 82, the lists identical (`diff` empty); the full `pnpm build` regenerated 575 capability entries and `packages/core/capabilities.json` has no diff.
- [x] AC-4 [local]: Terrain output is the same before and after. proof: `pnpm --filter @threenative/terrain test` (it includes `bake-golden.spec.ts` and `terrain-mcp.spec.ts`), and `sha256sum` of `world.glb` from `node packages/terrain/starter/forest/bake.mjs --out <dir>` is equal on both arms — Evidence (2026-11-14): the forest bake before the move and after it are byte-identical — `world.glb` `03c9810d9c222ebc4493b3aac3f1fc90dcfc31da497f77adb858c4989df638b4`, `world.json` `55a744b509ba9d57e7728b60ae9d15795fc46351c8a2f1a86693e36a214c2893`, `water.json` `c3b55b339c498f919625e4701063a914983ac8eda0a5312e4cfc20e4542db287`. The package suite is 649 passed, 1 failed: `forest-ground-cover.spec.ts` asserts a `near` file for `fern-a`, which this branch's `starter/forest/assets.json` replaced with `{"arbor":"bracken@6"}` — both files are identical to HEAD (`diff` empty), so the failure predates this PRD's move.
- [x] AC-5 [local]: A bake on a stale `dist` stops by name, and a new terrain file over 800 lines or a function over complexity 15 fails the lint. proof: a red-green spec for each guard — Evidence (2026-11-14): `stale-dist.spec.ts` (2 green) proves the throw and the pass on a throwaway layout; a `ground/ground.ts` probe function pushed the complexity ratchet red and removing it restored green; appending the file to 814 lines turned `pnpm quality` red (`quality gate failed: 1 fatal finding`) and restoring it to 494 returned exit 0. Both ratchets are green on the tree: Biome reports 0 errors over `packages/terrain/src` (83 inherited complexity warnings), `pnpm quality` exits 0. Repository-wide `pnpm lint` exits 0 (0 errors); the three formatting errors that stood in files this PRD does not touch were fixed by another lane in `b3027c677`.

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
- 2026-11-13 (owner): Phase 2 runs on its own branch from `origin/develop`, in its own draft PR, after PR #677 merges.
- 2026-11-13 (owner): a bake on a stale `dist` fails closed with a named error; it does not rebuild or only warn.
- 2026-11-13 (owner): docs split by reader. `README.md` and `docs/authoring/` ship to npm; `AGENTS.md` and `docs/architecture/` stay in the repository.
- 2026-11-13 (agent): guardrails reuse Biome and `scripts/check-quality.ts`; ESLint would report the same findings a second time.
- 2026-11-13 (agent): `core/` keeps its name for the evaluator, so the smallest number of files move and the package rule "preserve the recovered evaluator" stays true by path.
- 2026-11-14 (agent): the complexity guardrail is a ratchet, not a Biome error: 83 functions over 15 exist across the package (the recovered evaluator and the editor hold most of them), and turning the rule into an error would demand a behaviour refactor this PRD forbids. `packages/terrain/__tests__/complexity-ratchet.spec.ts` holds a committed per-file count, so a new offender fails and a removal passes.
- 2026-11-14 (agent): the stale-`dist` guard sits in `src/dist-fresh.ts` and is called from `bakeKit`, `cookKit` and the preview's `scripts/bake.mjs`. It is not called inside `bakeBiome`, because `bakeBiome` is exported from the published `index` entry and adding a Node `fs` import there would make that entry unloadable in a browser.

## Execution Phases

#### Phase 1: The map exists and a spec keeps it true

**Status:** COMPLETE (2026-11-13). Beyond the plan: shipped authoring docs in `docs/authoring/` (recipes, editor, world export) replace `AGENT_GUIDE.md`; `README.md` is the npm entry and `AGENTS.md` is repository-only; the preview `AGENTS.md` keeps its rules and moves its script index to `examples/strata-terrain-preview/docs/scripts.md`; package scripts `rebake`, `dev:fresh`, `bake:<world>`, `test:map`, `test:consumer`.
**Files:** `packages/terrain/docs/architecture/architecture.md` (new), `scripts/__tests__/terrain-architecture-census.spec.ts` (new, cloned from `strata-script-census.spec.ts`), `packages/terrain/AGENTS.md`, `examples/strata-terrain-preview/AGENTS.md`, `docs/PRDs/AGENTS.md`, `.ignore`, the generated `CLAUDE.md` mirrors, and the moved PRD folders.
**Implementation:** Write the six parts from Solution 1 against the layout as it is today. Trace each diagram edge from an import or a call, not from memory. Add the pointer lines and run `pnpm sync:agents`. Then move the Strata PRDs in one commit of `git mv` and fix each link.
**Verification:** the census spec, `pnpm check:docs`, `pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts`.

- [x] `packages/terrain/docs/architecture/architecture.md` is written, both AGENTS files point to it, and the census spec fails when the map names a missing path or omits a terrain folder. proof: `pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts` — Evidence (2026-11-13): census 7/7, and with `primary-docs`, `sync-agent-docs`, `check-doc-links` and `strata-script-census` 35/35; a fake path and a fake script name in `cook.md` each turned the spec red, and restoring it turned it green. The map also has two companions, `cook.md` and `world-package.md`, held to the same checks.
- [x] The open Strata PRDs are under `packages/terrain/docs/PRDs/` and each link resolves. proof: `ls packages/terrain/docs/PRDs docs/PRDs/refactoring/strata-refactoring` finds no folder, and `pnpm check:docs` exits 0 — Evidence (2026-11-13): `docs/PRDs/refactoring/strata-refactoring` and `docs/PRDs/open-world/PRD-580*` are gone (moved in `ae25772ac`); `docs/PRDs/AGENTS.md` names `packages/terrain/docs/PRDs/` and its `done/`, `.ignore` hides that `done/`; `pnpm check:docs` exit 0 (3 989 links).

#### Phase 2: `packages/terrain/src/` has one folder per stage

**Status:** COMPLETE (2026-11-14). Beyond the plan: the cook's reply format moved to `cook/reply.ts` (the 450-line cap needed it), the request layer split into `request/generate-request.ts` (words to a decided request) and `request/args.ts` (the shared argument checks), `round` joined `core/math.ts`, and the lint guardrails are two ratchets: `check-quality` makes a terrain file over 800 lines fatal when new, and `__tests__/complexity-ratchet.spec.ts` holds Biome's per-file complexity count, because Biome 1.9 has no baseline for its warning.
**Files:** every file in the Solution 2 table, the public entry files (import paths only), `packages/terrain/tsup.config.ts` (source paths only, same keys), the deep-path consumers under Risks, `packages/terrain/docs/architecture/architecture.md`.
**Implementation:** Record the before arm first: the packed file list and the forest `world.glb` hash. Move one stage per commit with `git mv` and fix imports. Then cut the stage functions out of `cook.ts` into their stage folders. Keep each exported name. Update the map in the same commit as each move.
**Verification:** `pnpm --filter @threenative/terrain typecheck`, `pnpm --filter @threenative/terrain test`, the census spec, `pnpm exec vitest run scripts/__tests__/mcp-tool-schemas.spec.ts scripts/__tests__/temp-dir-guard.spec.ts scripts/__tests__/prepare-release.spec.ts`.

- [x] The six stage folders exist and `core/` holds the evaluator files only. proof: `pnpm --filter @threenative/terrain typecheck && pnpm exec vitest run scripts/__tests__/terrain-architecture-census.spec.ts` — Evidence (2026-11-14): typecheck exit 0; census 7/7; `pnpm check:docs` exit 0 (3 994 links); `mcp-tool-schemas`, `temp-dir-guard` and `prepare-release` specs green.
- [x] `cook/cook.ts` is 450 lines or fewer and the package tests pass. proof: `wc -l packages/terrain/src/cook/cook.ts && pnpm --filter @threenative/terrain test` — Evidence (2026-11-14): 368 lines; 649 of 650 tests pass, the one failure is `forest-ground-cover.spec.ts` against this branch's Arbor `fern-a` row, identical to HEAD (see AC-4).
- [x] A starter bake, the MCP cook and the preview bake stop by name on a stale `dist`. proof: a red-green spec that touches a `src/` file after a build, then rebuilds — Evidence (2026-11-14): `assertDistFresh` (`packages/terrain/src/dist-fresh.ts`) is called first by `bakeKit`, `cookKit` and the preview's `scripts/bake.mjs`; it names `pnpm --filter @threenative/terrain build`. `stale-dist.spec.ts` proves the stale throw and both pass arms. The spec uses a throwaway layout rather than the real tree's mtimes, which vitest's parallel workers would race.
- [x] `packages/terrain/src/` fails the lint on a new file over 800 lines or a function over cognitive complexity 15. proof: `pnpm lint` and `pnpm quality` exit 0 after the split, and a red-green fixture for each rule — Evidence (2026-11-14): Biome over `packages/terrain/src` 0 errors, and repository-wide `pnpm lint` 0 errors after `b3027c677`; `pnpm quality` exit 0, with `core/operations.ts` (866) and `population/scatter-ordered.ts` (963) grandfathered as baseline rows; both red-green probes above.

#### Phase 3: The preview has one folder per concern

**Status:** CODE COMPLETE (2026-11-14). `src/render/` is grouped into `ground/`, `props/`, `water/`, `sky/` and `editor/` with the shared files beside them, and `scripts/` into `bake/`, `prep/`, `verify/` and `measure/`; `dem/` and `fixtures/` stay. Typecheck passes, the preview suite is 289 passed and 3 skipped, both censuses pass, and the bake, the script index and the follow-up PRD paths follow the move. The box's third proof, the shared web scenario, has not yet run green on this host: it times out its 5 s travel wait under a load average of 27–33 with two other lanes' headless Chrome at about 800 % CPU each, while the page draws (84 frames, an NVIDIA Turing adapter, 0 console errors). Re-run `pnpm --filter strata-terrain-preview test:terrain:web` on an idle host.
**Files:** `examples/strata-terrain-preview/src/render/**`, `scripts/**`, `package.json`, `AGENTS.md` (script index), `__tests__/**` (import paths), `scripts/__tests__/strata-script-census.spec.ts` if a path pattern changes, `packages/terrain/docs/architecture/architecture.md`.
**Implementation:** Inventory open pull requests and worktrees first (Risks). Move `src/render/` in one commit and `scripts/` in a second one, with import paths as the only content change.
**Verification:** `pnpm --filter strata-terrain-preview typecheck`, `pnpm --filter strata-terrain-preview test`, `pnpm --filter strata-terrain-preview test:terrain:web`, both census specs.

- [ ] `src/render/` and `scripts/` are grouped as in Solution 3, and the preview tests and the shared web scenario pass. proof: `pnpm --filter strata-terrain-preview test && pnpm --filter strata-terrain-preview test:terrain:web && pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts scripts/__tests__/terrain-architecture-census.spec.ts`
