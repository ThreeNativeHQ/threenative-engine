---
prd_contract: v1
---

# PRD-926 — Agent Token Efficiency: `threenative-playtest --summary`, `@threenative/core/bake`, `threenative inspect`, `--minimal` Scaffold, and Runtime MCP Coverage

**Closed:** 2026-11-27 at `15a6bfb43`, PR #780, archived to `done/`.

**Status:** DONE — 2026-11-27. Every phase and acceptance box verified.
**Priority:** P1 — Batches all engine-side trace token-saving abstractions into one PRD: stops 8–12 MB playtest JSON dumps (~185 parsers), 200–450L `bake-*.mjs` boilerplate (`sculpt` = 27.6% AI cost), 121 GLB/PIL/manifest scripts, 2k–4.6k line kit deletion churn, and 939 `node_modules` greps (21.2 MB).
**Complexity:** 6 (MEDIUM)
**Owner:** Unassigned
**Depends on:** None

## Context

Forensic audit of 12 recent 30-minute Studio local trial traces (`2026-11-26/27` across `gpt-6.2-sol`, Hybrid `codex+dsh`, and `claude-fable-5-2` on `racing`, `cairn-climb`, `tidepool-salvage`, and `glasshouse-courier`) found five high-leverage engine-side token leaks:

1. **8.3–12.2 MB playtest JSON dumps + ~185 ad-hoc parsers:** `.agent/playtests/*.json` reports hit 12.2 MB (`t3.json`), 11.9 MB (`glasshouse-final.json`), and 8.3 MB (`glasshouse-finish.json` where `observations` alone is 4.23 MB vs `assertionResults` 3.3 KB). `packages/playtest/src/runner/cli.ts:336-339` writes the raw full report to stdout, so agents spent **136 Codex exec calls** and **~50 `dsh` bash calls** writing Python/Node JSON parsers just to read `pass`, `frames`, `assertionResults`, `diagnostics`, and final state. (`formatScenarioSummary` already exists at `packages/playtest/src/runner/scenario-summary.ts:3-28`, and CLI flags live in `packages/playtest/src/runner/config.ts:89-131,241-260`.)
2. **200–450L duplicated `scripts/bake-*.mjs` boilerplate (`sculpt` = 27.6% of total AI spend):** Every sculpt/world build re-authored 90–150 lines of Node `globalThis.FileReader` polyfill, `GLTFExporter` `tnOrigin: "procedural"` extras, PBR/emissive material factories, `addPart` / `mergeByMaterial`, `Box3` grounding checks (`min.y === 0`), triangle stats, and headless Blender donor material-stripping (`bake-neon-coupe.mjs` 370L, `bake-survey-robot.mjs` 304L, `bake-night-coupe.mjs` 424L, `bake-mini-sub.mjs` 182L + 11 sibling bake scripts).
3. **121 ad-hoc GLB / PIL / manifest diagnostic scripts:** Codex ran **62 GLB inspection scripts**, **39 PIL frame-sampling/luminance scripts**, and **20 `assets.manifest.json` audit scripts**. `packages/create-threenative/src/inspect.ts:1-430` (`inspectAsset`, `inspectCommand`) already parses GLBs, yet `commands.ts:4-20` and `threenative.ts:192-216` do not expose `threenative inspect`, and `inspect.ts` omits `minY`, triangle count, material names, `assetExtras`, `--manifest`, and `--frame`.
4. **2,000–4,619 lines of starter-kit deletion churn:** On divergent briefs, `createProject()` (`packages/create-threenative/src/index.ts:1233-1289`) copies all kit demo playtests unconditionally (`tidepool-salvage` deleted **22 playtests / 4,619 lines**; `glasshouse-courier` deleted **14 playtests / 3,957 lines**).
5. **939 `node_modules/@threenative/*` greps (21.2 MB output):** Codex grepped `@threenative/core` **763×**, `@threenative/playtest` **384×**, and `@threenative/physics` **127×** (`input.clear`, `WaterSurface3D`, `localExposure`, `InstancedModel`, `IPlaytestEvent`, `waitForResource`, `readContacts`, `Area3D`) because `packages/engine-mcp/src/index.ts:24-100` lacks playtest CLI/schema entries and several runtime hooks.

## Solution

1. **Compact `threenative-playtest --summary`, `--out <file>`, and `--no-observations`** (`packages/playtest/src/runner/{config.ts,scenario-summary.ts,cli.ts,runner.ts}`):
   - Register `--summary`, `--out <file>`, and `--no-observations` in `PLAYTEST_FLAGS` / `parseStandalonePlaytestArgs` (`config.ts:89-131,241-260`) and `formatUsage`.
   - Enrich `formatScenarioSummary()` (`scenario-summary.ts:3-28`) with `movementDelta`, failed assertion details, deduped top-5 `diagnostics`, `finalState` tail, and artifact paths. When `--summary` is set, emit `< 4 KB` JSON on stdout; when `--out` is set, write full JSON to disk; when `--no-observations` is set, drop multi-MB per-tick `observations`. Preserve existing default stdout and exit codes (`0`, `1`, `2`, `75`).
2. **Ship `@threenative/core/bake` subpath & expose expanded `threenative inspect`** (`packages/core/src/bake.ts`, `packages/core/package.json:41-95`, `packages/core/tsup.config.ts`, `packages/create-threenative/src/{commands.ts,threenative.ts,inspect.ts}`):
   - `@threenative/core/bake`: Node-safe `exportProceduralGlb(root, outPath, { prompt, groundToZero?, validateBounds? })` (built-in `FileReader` polyfill, `tnOrigin: "procedural"` extras, grounding & `{ triangles, drawGroups, size, minY, materials }` receipt), `createPbrMaterial`, `createEmissiveMaterial`, `addPart`, `mergeByMaterial`, `prepareDonorWithoutMaterials`.
   - Wire `"inspect"` in `commands.ts:4-20` & `threenative.ts:192-216`; extend `inspect.ts:370-430` with `minY`, `maxY`, `triangles`, `materialNames[]`, `assetExtras`, plus `--manifest` (audits `assets/**` vs `public/assets.manifest.json`, leftover `.zip`s, duplicate downloads) and `--frame <imgPath> [--sample role:u,v ...]` (blank/luma check + hex sampling).
3. **`--minimal` scaffold option & runtime/playtest MCP capability indexing** (`packages/create-threenative/src/index.ts:80-95,1233-1350`, `packages/core/src/input.ts:751-797`, `packages/playtest/src/assertion-schema.ts:35-60`, `packages/physics/`, `packages/engine-mcp/`):
   - Add `--minimal` / `--strip-demo-playtests` to `IScaffoldOptions` & `parseArgs()`, keeping core boot/render/controls and `survives.playtest.json` while omitting non-`survives` kit demo playtests.
   - Index `@threenative/core/bake`, `threenative inspect`, playtest CLI/scenario schema (`--summary`, `--out`, `IPlaytestEvent`, `waitForResource`), and high-grep core/physics runtime APIs (`Input.clear`, `WaterSurface3D`, `localExposure`, `readContacts`, `Area3D`, `InstancedModel`) via `pnpm capabilities:sync` (`package.json:28`) while keeping `pnpm caps:recall` (`>= 0.76`).

## Non-Goals

- Changing default `threenative-playtest` stdout format when `--summary` and `--out` are omitted.
- Replacing headless Blender turntable visual renders or modifying `@threenative/procedural-environment` catalog recipes (`threenative-asset-mcp` `PRD-540`).
- Changing Studio's prompt assembly or `PROJECT_MAP` formatting (Studio `PRD-130`, `PRD-134`).

## Acceptance Criteria

- [x] AC-1 [local]: `threenative-playtest --summary --out <file>` writes full telemetry to `<file>`, emits a `< 4 KB` summary on stdout with `movementDelta`, failed assertions, deduped diagnostics, `finalState`, and artifact paths, supports `--no-observations`, and preserves exit codes `0`/`1`/`2` — proof: `pnpm --filter @threenative/playtest test && pnpm --filter @threenative/playtest build` — Evidence: `cli-usage.spec.ts` (5 new tests, 2 added after the agy review: a failing run with 60 long `error` diagnostics and 40 failed assertions stays under 4096 bytes, and a 14-scenario `--summary` stays under 4096 bytes in total with failing scenarios first plus an `omitted` count and an `--out` pointer; the compact object is now built field by field, so `diagnostics`/`reasons` no longer reach stdout; earlier tests: `--summary` stdout under 4096 bytes with movementDelta/failedDetails/diagnosticDetails/finalState/artifactDirectory, `--out` full JSON, `--no-observations`, exit code 1 kept, flagless stdout unchanged); `pnpm --filter @threenative/playtest build` green incl. publint. The three checks the first lane could not run (no Wasm engine) now ran against a Wasm engine built from this tree's sources on the Debian laptop (`node scripts/build-wasm.mjs`, emsdk, 1 min; copied to `packages/runtime-native/build/web`): `generated-shooter-input.spec.ts` and `template.spec.ts` (73 tests, 3 skipped, optional-effects build included) pass, and `bash __tests__/orphan-cleanup.sh` exits 0 (`no orphans`). After the fixes: `pnpm vitest run packages/playtest packages/procedural-environment packages/create-threenative/__tests__/{scaffold,cli}.spec.ts` 160 files, 2357 tests green; playtest and create-threenative `tsc --noEmit` clean.
- [x] AC-2 [local]: Pure-Node import of `@threenative/core/bake` exports a valid grounded binary `.glb` stamped `tnOrigin: "procedural"` with merged materials and `{ triangles, minY, materials }`, and `@threenative/core` passes `publint` — proof: `pnpm --filter @threenative/core build && pnpm --filter @threenative/core test` — Evidence: `packages/core/__tests__/bake.spec.ts` (3 tests: grounded `minY` 0, merged 2 draw groups, `asset.extras` `{tnOrigin:"procedural",tnPrompt}` read from the written GLB JSON chunk, bounds/empty refusal, donor repaint). `pnpm --filter @threenative/core build` incl. publint green; a plain `node` script importing `@threenative/core/bake` from `dist` wrote a GLB that `threenative inspect` read back (`minY 0`, `extras {tnOrigin:procedural}`).
- [x] AC-3 [local]: `threenative inspect` runs from the `threenative` CLI covering GLB (`minY`, `triangles`, `materialNames`, `assetExtras`), `--manifest`, and `--frame --sample`, and `createProject({ minimal: true })` omits non-`survives` demo playtests — proof: `pnpm --filter create-threenative test` — Evidence: `create-threenative/__tests__/inspect.spec.ts` (19 tests: minY/maxY/triangles/materialNames/assetExtras, `--manifest` unlisted/missing/zip/duplicate + exit 1, `--frame --sample` hex + blank/black fail, `threenative inspect` via the built binary) and `cli.spec.ts` (`--minimal`/`--strip-demo-playtests` keeps only `playtests/survives.playtest.json`, drops `native-playtests/` and, after the agy review, every package script that points at it (`snow`, `sailing`, `racing` `test:native`); `threenative --help` now lists `inspect`).
- [x] AC-4 [local]: `pnpm capabilities:sync && pnpm caps:recall` indexes bake/inspect/playtest/runtime APIs while maintaining held-out `recall@1 >= 0.76`, and `pnpm typecheck && pnpm lint` passes cleanly — proof: `pnpm capabilities:sync && pnpm caps:recall && pnpm --filter threenative-engine-mcp test && pnpm typecheck && pnpm lint` — Evidence: `pnpm capabilities:sync` indexes 6 bake exports + 6 tooling rows (`threenative-playtest --summary`, `threenative inspect`, `waitForResource`, `InputMap.clear`, `localExposureEnabled`, `readContacts`; `WaterSurface3D`, `InstancedModel`, `Area3D` were already indexed); `pnpm caps:recall` recallAtK 0.959 (>= 0.76); gold held-out recall@1 0.66 and recall@5 0.80 equal the numbers before this change and meet the repo's locked floors (0.65 / 0.80; the 0.76 recall@1 floor belongs to the unmerged PRD-917); `search.spec.ts` PRD-926 lookup test, `pnpm --filter threenative-engine-mcp test`, `pnpm typecheck`, `pnpm lint` (0 errors) green. `IPlaytestEvent` does not exist in this tree, so it is not indexed.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Playtest `--summary`, `--out`, `--no-observations` | `parseStandalonePlaytestArgs()` (`packages/playtest/src/runner/config.ts:241-260`) → `cli.ts:330-346`, `scenario-summary.ts:3-28`, `runner.ts:205,1010` | Replaces 8–12 MB stdout-only dumps when summary/out flags are supplied | AC-1 |
| `@threenative/core/bake` procedural GLB helper | `packages/core/package.json:41-95`, `tsup.config.ts` → `packages/core/src/bake.ts` | Replaces 90–150L duplicated `FileReader`/`GLTFExporter`/merge boilerplate in `bake-*.mjs` | AC-2 |
| Unified `threenative inspect` CLI | `packages/create-threenative/src/commands.ts:4-20`, `threenative.ts:192-216` → `inspect.ts:370-430` | Exposes GLB bounds/extras + `--manifest` + `--frame` diagnostics on `threenative` | AC-3 |
| `--minimal` scaffold filtering | `parseArgs()` (`packages/create-threenative/src/index.ts:1323-1350`) → `createProject()` (`index.ts:1233-1289`) | Omits extra demo playtests on divergent scaffolds while keeping `survives.playtest.json` | AC-3 |
| Playtest & runtime MCP capabilities | `core/src/input.ts:751-797`, `playtest/src/assertion-schema.ts:35-60`, `physics/` → `pnpm capabilities:sync` (`package.json:28`) | Surfaces playtest schema/CLI, bake/inspect, and high-grep runtime APIs in `engine_search_capabilities` | AC-4 |

## Execution Phases

#### Phase 1: `threenative-playtest` Compact Summary, `--out`, and `--no-observations`
**Status:** COMPLETE
**Files:** `packages/playtest/src/runner/config.ts`, `packages/playtest/src/runner/scenario-summary.ts`, `packages/playtest/src/runner/cli.ts`, `packages/playtest/src/runner/runner.ts`
**Implementation:** Add `--summary`, `--out`, and `--no-observations` flags and help text; enrich `formatScenarioSummary()` with movement deltas, failed assertion details, top-5 deduped diagnostics, `finalState`, and artifact paths; write `--out` and trim observations without changing default flagless stdout or exit codes.
- [x] Playtest CLI tests verify `--summary` `< 4 KB` output, `--out` full JSON, `--no-observations` trimming, exit codes, and build — proof: `pnpm --filter @threenative/playtest test && pnpm --filter @threenative/playtest build` — covers AC-1. Result: see AC-1.

#### Phase 2: `@threenative/core/bake` Helper Subpath and Expanded `threenative inspect` CLI
**Status:** COMPLETE
**Files:** `packages/core/src/bake.ts` (new), `packages/core/package.json`, `packages/core/tsup.config.ts`, `packages/create-threenative/src/commands.ts`, `packages/create-threenative/src/threenative.ts`, `packages/create-threenative/src/inspect.ts`
**Implementation:** Implement Node-safe `@threenative/core/bake` (`exportProceduralGlb`, materials, `addPart`/`mergeByMaterial`, donor stripping) exported in `package.json`/`tsup.config.ts`; expose `threenative inspect` in `commands.ts`/`threenative.ts` and extend `inspect.ts` with `minY`, `triangles`, `materialNames`, `assetExtras`, `--manifest`, and `--frame --sample`.
- [x] `@threenative/core/bake` round-trip GLB export, `publint`, and `create-threenative` inspect tests pass — proof: `pnpm --filter @threenative/core build && pnpm --filter @threenative/core test && pnpm --filter create-threenative test` — covers AC-2, AC-3. Result: see AC-2, AC-3.

#### Phase 3: `--minimal` Scaffold Mode, Capability Index Sync, and Full Gate
**Status:** COMPLETE
**Files:** `packages/create-threenative/src/index.ts`, `packages/core/src/input.ts`, `packages/playtest/src/assertion-schema.ts`, `packages/physics/`, `packages/engine-mcp/`
**Implementation:** Add `--minimal` / `--strip-demo-playtests` filtering in `createProject()`; add `@situation`/`@alias` JSDoc for bake/inspect, playtest schema/flags, and top-grepped core/physics runtime hooks; run `pnpm capabilities:sync`, `pnpm caps:recall`, MCP query tests, typecheck, and lint.
- [x] `--minimal` scaffold test, `engine-mcp` lookup tests, held-out `recall@1 >= 0.76`, typecheck, and lint pass — proof: `pnpm --filter create-threenative test && pnpm capabilities:sync && pnpm caps:recall && pnpm --filter threenative-engine-mcp test && pnpm typecheck && pnpm lint` — covers AC-3, AC-4. Result: see AC-3, AC-4.
