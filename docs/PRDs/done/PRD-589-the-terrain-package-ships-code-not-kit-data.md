# PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data

**Status:** DONE — all phase and acceptance boxes verified; published-kit runtime passed 2026-10-12.
**Priority:** P2 — On-request kit delivery needs the published archive and GPU playtest qualification (AC-3).
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md)

## Context

Package and core audits of `2d2124792` (2026-10-10):

- `npm pack --dry-run` in `packages/terrain`: 32.6 MB packed, 40.7 MB unpacked. `package.json`
  `files` ships `starter/` (5.7 MB) and `starter-assets/` (34 MB, 15 MB of it `fir_tree_01`).
- Four `starter/*/recipe.json` files are 66k lines (about 1.3 MB) each, because a `heightmap`
  layer inlines 257×257 numbers. `forest` has no inline array and is 4.5k lines.
- `starter-assets/forest_leaves_02` and `grass_medium_02` are referenced by nothing found;
  `bark_brown_02`, `cliff_side`, `fern_02`, `lichen_rock` and `river_small_rocks` are used only
  by the example.
- `src/core/io.ts:~403` writes the glTF generator string `"Strata Terrain 0.1.0"`.
- Registration: `scripts/prepare-release.ts` `syncPeerRanges` has no terrain entry.
- CHARTER: the new terrain allowance (owner, 2026-09-30) admits terrain-only editor companions,
  but the closed-list row "An editor | Not in v1…" (`docs/architecture/CHARTER.md:102`) was not
  reworded, and root `AGENTS.md` "Where a change goes" has no terrain row.

## Solution

Move kit binaries out of the runtime tarball: the scaffolder copies a kit into the game on
request, and the shared terrain resolver supplies models and textures from a SHA256-pinned
release archive when the package has no local starter assets. Store inline heightmaps as RAW16 sidecars that `decodeRAW16` already reads, with
the recipe naming the file. Delete unreferenced assets and move example-only ones into the
example. Fix the generator string, the peer-range sync and the CHARTER row.

## Acceptance Criteria

- [x] AC-1 [local]: The packed tarball is under 2 MB, enforced by a cap in `pnpm budgets`. proof: `pnpm budgets` — Evidence: 2026-10-11 PASS (exit 0), 600,908 B packed; strict cap < 2,000,000 B.
- [x] AC-2 [local]: Every `recipe.json` is under 200 KB, and each kit bake's output bytes are unchanged by the sidecar move. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with a golden hash — Evidence: 27 tests pass across five kit specs (parent run, 20.55 s); all 79 old/new bake files are byte-identical (7 s).
- [x] AC-3 [local]: A scaffolded game that asks for the forest kit gets its recipe and assets, and the kit playtest passes. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit` — Evidence: complete; fresh published-archive runtime passes at `3314a6717` (see completion note). Prior local-archive run: 2026-10-12 rerun at `9735adf6a` on a quiet host (load 6): `KIT=forest pnpm --filter strata-terrain-preview test:kit` exit 0, `pass: true`, adapter `nvidia/turing`, 819 frames, ground error 0.010 m, 8 794 fir instances drawn, view frame p95 16.1 to 19 ms; the load-34 render failure from 2026-10-11 did not recur. This run packs the starter assets from the checkout, so it does not exercise the published archive: the release URL is still unpublished (404 earlier), so the box stays open until the archive is uploaded and the kit is scaffolded from it.
  - 2026-10-11 (EPIC `43ad67b2e`, before the release upload): `THREENATIVE_TERRAIN_ASSETS_URL=file://…/terrain-starter-assets-0.1.0.tar.gz KIT=forest pnpm --filter strata-terrain-preview test:kit` scaffolded the forest kit from the packed tarballs, which carry no starter assets. It fetched and verified the pinned archive (sha256 `38191c06…`), cooked, built and played on NVIDIA/Turing (`webgpu:architecture=turing|vendor=nvidia`). Of 25 assertions, 24 pass. The one failure is `performance.maxPhaseMsP95.render` at 75.4 ms over 1 024 samples, against 40 ms, at host load average 34. Delivery works; the performance bound stays open until a quiet-host run (see PRD-584/585). The unpublished release URL answered 404 and the forest driver failed closed with `TN_TERRAIN_ASSETS_HTTP: 404`.
- [x] AC-4 [local]: No asset directory without a reference remains. proof: `pnpm exec vitest run packages/terrain/__tests__/kit-assets.spec.ts` — Evidence: 2026-10-11, asset-reference spec passes; removed `forest_leaves_02` and `grass_medium_02` (6 files). All 15 remaining directories have a kit or example source reference.
- [x] AC-5 [local]: `prepare-release` syncs terrain's peer ranges, and the CHARTER closed-list row names the terrain allowance. proof: `pnpm check:docs` and the package-lists drift spec — Evidence: `prepare-release.spec.ts` 12/12 PASS (4 new terrain fixtures, 3 RED before the fix). `package-list-drift.spec.ts` 7/7 PASS. `terrain-consumer.spec.ts` 18/18 PASS. `check:docs` from the parent run (3057 links). Core-independent strict typecheck of `io.ts` and `prepare-release.ts` passes. CHARTER row in `a9a997baf`.

## Execution Phases

#### Phase 1: recipes shrink, bytes hold
**Status:** COMPLETE
**Files:** `packages/terrain/starter/*/recipe.json`, sidecar `.r16` files, kit specs and bake loaders
- [x] Recipes under 200 KB, same bake bytes. proof: `starter-kit.spec.ts`
  - All five recipe JSON files are 2,253–5,359 B; each little-endian RAW16 sidecar is 132,098 B. Existing `decodeRAW16` hydrates values in the Node bake loaders; pure `Terrain` owns no file I/O. The authored 0.1 m precision limit is explicit in each loader.
  - Self-contained pinned SHA256 tests prove decoded Float32 heights and evaluated height grids equal the original inline recipes. Parent full focused run: all 27 tests pass across `starter-kit`, `alpine-kit`, `coastal-kit`, `desert-kit` and `tundra-kit` (20.55 s).
  - Parent complete bake comparison against `e12a5d578`: all ten bakes exit 0; every emitted file matches by path and full-byte SHA256 (79 files: alpine 15, coastal 12, desert 15, forest 22, tundra 15; 7 s). No bake arithmetic, seed or placement changed.
  - Fixture copy lists include the sidecars; alpine first reproduced `ENOENT heightmap.r16`, then all four biome specs passed. The game harness already copies kit directories recursively.
  - Two stale forest assertions were aligned with cooker commit `4cf0664e7`: historical comparison proves only six model path aliases changed in the manifest. The combined GLB (24,641,592 B) and streamed package (24,073,955 B) each retain the 25 MiB cap. All other golden hashes remain unchanged. Scoped Biome and diff checks pass.

#### Phase 2: kits leave the tarball
**Status:** DONE
**Files:** `packages/terrain/package.json` `files`, `packages/create-threenative/src/` kit copy, `starter-assets/` moves
- [x] Tarball under 2 MB. proof: `pnpm budgets` — 2026-10-11 PASS (exit 0), 600,908 B packed.
- [x] Kit still scaffolds and plays. proof: `test:kit` — 2026-10-12 fresh published-archive run exit 0; pass true, NVIDIA/Turing, 819 frames.
- [x] No unreferenced assets. proof: `kit-assets.spec.ts` — 2026-10-11 PASS; 15 referenced directories, 2 unreferenced directories removed.

2026-10-11 integration check: rebuilt terrain (JavaScript, declarations and publint pass), then all 37 release/drift/consumer tests pass (4.35 s). The wider five-kit suite passes 26/27 tests (45.64 s), including every pinned bake hash and RAW16 height comparison. Its packaging test fails because included kit files total 83,718,967 B, above the unchanged 40 MiB content cap; this measures included file bytes, not compressed tarball size. Phase 2 must exclude generated cook outputs and complete on-request delivery. The 2 MB runtime tarball target remains unverified.

#### Phase 3: registration and charter
**Status:** COMPLETE
**Files:** `scripts/prepare-release.ts`, `docs/architecture/CHARTER.md`, `AGENTS.md`, `src/core/io.ts`
- [x] Peer sync and charter row. proof: `pnpm check:docs` + drift spec
  - Evidence: `prepare-release.spec.ts` 12/12 PASS. `package-list-drift.spec.ts` 7/7 PASS. `terrain-consumer.spec.ts` 18/18 PASS. `check:docs` from the parent run. Core-independent strict typecheck passes for `io.ts` and `prepare-release.ts` (`tsc --ignoreConfig --noEmit --strict --skipLibCheck --types node --target ES2022 --module NodeNext --moduleResolution NodeNext`). Package-wide terrain `typecheck` remains blocked by 19 errors outside changed files. Causes: `@threenative/physics` has no built `dist`, and `examples/strata-terrain-preview/src/world/horizon.json` is absent.

2026-10-11 charter clarification: the closed-list row now names the existing narrow terrain-only authoring allowance, and root `AGENTS.md` places those optional companions in `packages/terrain/` while preserving game-owned appearance. `pnpm sync:agents` updated one generated mirror. Parent documentation checks pass: 3,057 links across 1,360 Markdown files and all 252 tests in the six required documentation specs (8.40 s). Release synchronization and package-list drift proof are recorded below.

2026-10-11 release synchronization follow-up: actual terrain peers stay unchanged when absent from the selected versions map; a selected cohort peer uses the existing range synchronizer. Terrain generator versions now use `requiredVersion` and the existing source-update table. Three new fixtures fail before the source fix; all 37 release/drift/consumer tests pass afterward (2.30 s). The focused core-independent strict typecheck passes; package-wide missing physics output and horizon fixture are not repaired by this phase. Documentation proof for the charter and mirrors remains the parent’s accepted 252-test run.

2026-10-11 current kit delivery component evidence: the earlier full run passed 27 of 27 terrain-kit tests in 8.78 s. Prerequisite builds passed in order (BlenderMCP, physics, playtest, then create-threenative tsup, DTS and publint), and the full create-threenative typecheck and Biome passed. With the root rule `/packages/create-threenative/template-assets/terrain/`, the packed-tarball case passed: 1 test passed, 26 skipped, in 5.71 s. The packed tarball holds 5 kits and 30 source files, including HDR provenance records but no HDR, texture or model binaries. An external import of `create-threenative/terrain-kit` from the extracted tarball copied 6 files for one kit. Phase 2 stays PARTIAL, and Phase 2, AC-1, AC-3 and AC-4 stay open until the under-2 MB tarball, scaffolded asset delivery and playtest proof pass.

2026-10-11 Phase 2 package delivery: owner decision fixes one versioned archive in `ThreeNativeHQ/threenative-engine`: tag `terrain-starter-assets-v0.1.0`, asset `terrain-starter-assets-0.1.0.tar.gz`. `starterAssetsDir` is shared by copied-kit baking, MCP cooking, scaffolder staging, preview serving and golden-path staging. `--assets` remains an explicit override. Packed kit source includes RAW16 sidecars, per-asset provenance in `starter-credits.json` and `THIRD_PARTY_NOTICES.md`; it excludes binary `starter-assets/` and generated `starter/*/world/` outputs. Referenced example-only directories remain in the shared archive; no directories moved.

- Archive: `/tmp/terrain-starter-assets-0.1.0.tar.gz`, 31,598,641 B, SHA256 `38191c06a778d06fd79061ea25365e35da0c7c81e7c173ba752e706f9e2a1391`. Deterministic repeated packing and manifest drift pass. The manifest version and release URL match the terrain package version. 2026-10-12 update: the Biome reformat of `credits.json` changed the packed bytes, so the manifest now records 31,598,616 B, SHA256 `3062b90cd7f84e6ff14f6a96de64ad406eeba30c55c95cc045b6219edf71f5b0` (`kit-assets.spec.ts` and `starter-kit.spec.ts` 31/31). The release asset is still not uploaded, so upload this archive, not the earlier one.
- Package: initial pre-build `npm pack --dry-run --json` measured 32,667,416 B; built candidate measures 600,908 B packed / 1,801,637 B unpacked (74 files). The cap spec proves missing builds fail and compressed packages at or above 2,000,000 B fail.
- Verification: terrain build, strict publint and package typecheck PASS. Terrain suite: 270/271 PASS initially; the one editor-assets failure was an unreachable local editor URL, and its isolated retry passes. All 19 starter-kit tests pass, including unchanged pinned bake hashes. Archive/reference specs: 11/11 PASS; an additional scaffolded forest bake against the local archive passes (12 total). `create-threenative` build/publint and terrain-kit specs: 27/27 PASS. Budget specs: 38/38 PASS plus the new cap spec PASS. Scoped Biome PASS (8 complexity warnings); `pnpm check:docs` PASS (3,057 links). Capability and API surface drift regenerated. The first `pnpm budgets` run stopped on the existing missing `cookTerrainWorld` example tag; its actual invocation is now documented.
- AC-3 and the kit-playtest box stay open: the coordinator must upload the release and run `THREENATIVE_TERRAIN_ASSETS_URL=file:///tmp/terrain-starter-assets-0.1.0.tar.gz KIT=forest pnpm --filter strata-terrain-preview test:kit`. Local scaffold/bake delivery passes; GPU playtest and published-release download remain unverified. No browser/Xvfb runs, tags, releases or pushes were performed in this lane.

2026-10-11 final budgets: `pnpm budgets` PASS (exit 0), terrain compressed tarball 600,908 B against a strict 2,000,000 B ceiling. Nonfatal workspace LOC triggers and existing native census drift remain reported by the existing gate. The only new package mechanism is one shared Node archive resolver: no runtime appearance code, wrapper system or dependency added; deterministic packing remains a repository authoring script. This replaces the repeated installed-directory assumptions and keeps the tarball free of generated cook output. All acceptance criteria except AC-3 are now verified; Phase 2 remains PARTIAL pending the coordinator's release/playtest proof.

2026-10-12 publication proof: created immutable release `terrain-starter-assets-v0.1.0` from pushed EPIC `9735adf6a` (the manifest is unchanged in the integrated candidate). Public download returned 31,598,616 bytes with SHA256 `3062b90cd7f84e6ff14f6a96de64ad406eeba30c55c95cc045b6219edf71f5b0`. A freshly packed/extracted terrain package without local `starter-assets/`, using `env -u THREENATIVE_TERRAIN_ASSETS_URL XDG_CACHE_HOME=/tmp/prd589-public-hfcLJB/cache node --input-type=module`, resolved `starterAssetsDir()` through the published URL and extracted 18 asset entries, exit 0. At that publication-only stage, the scaffolded-game runtime proof was still pending; the successful fresh-cache run below closes it.

2026-10-12 AC-3 and Phase 2 completion: after sourcing the matching NVIDIA ICD shim, `env -u THREENATIVE_TERRAIN_ASSETS_URL PLAYWRIGHT_BROWSERS_PATH=/home/joao/.cache/ms-playwright XDG_CACHE_HOME=/tmp/pr483-forest-public-cache.Jilsa8 KIT=forest DISPLAY=:0 pnpm --filter strata-terrain-preview test:kit` exited 0 on `3314a6717`. The asset cache was newly created and empty; no URL override or package-local starter assets were present. The generated game scaffolded, downloaded the published pinned archive, baked 4,820 placements, passed typecheck/build and played 819 frames on NVIDIA/Turing. Result: pass true, 216 prop colliders, ground error 0.010110 m, 8,711 fir instances drawn, 30,947,731 cooked bytes. Captures are in the existing `examples/strata-terrain-preview/artifacts/playtest/starter-kit` harness directory. Frame p95 was 21.5–35.3 ms; this is kit-delivery acceptance, not the separate PRD-584 16.7 ms performance target. The first fresh-cache attempt relocated Playwright's browser lookup and failed before launch; `doctor --text` confirmed installed Chromium and the successful rerun pinned its path while retaining a new empty asset cache.

Completion audit (2026-10-12): current packed terrain is 616,539 bytes, below the strict 2,000,000-byte cap and without bundled asset binaries; all five recipes are 2,253–5,359 bytes. Current golden-height/bake hashes, asset references, release synchronization and package-list contracts pass: 50 tests across four files. The charter explicitly permits terrain in its closed list. Independent bounded audit approves AC-1 through AC-5.

2026-10-13 qualification follow-up: the shared `kit-assets.spec.ts` beforeAll fixture retained `tn-terrain-pack-*/assets.tar.gz` after the Vitest worker finished; a monitored real package-test run identified that exact path. The fixture now removes its directory in a finally block immediately after reading the archive bytes. The package-test phase passes with socket-origin observation enabled and the unmodified suite cleanup guard reports 1 → 1 directories (exit 0), instead of the reproduced 1 → 2 failure. Published archive bytes and package behavior are unchanged. The separate intermittent editor ECONNRESET and root unit/full CI qualification are not claimed fixed by this cleanup.
