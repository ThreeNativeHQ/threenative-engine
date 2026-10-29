# PRD-590 — One starter-world source, not five copies

**Status:** DONE
**Priority:** P2 — The shared fixture still needs five-kit playtest evidence to close AC-2.
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md)

## Context

Package and example audits of `2d2124792` (2026-10-10), diff lines measured against alpine:

- `packages/terrain/starter/*/bake.mjs`: five files of 118 lines that differ by 2 lines each.
- `starter/*/world.ts`: 335–413 lines each; desert differs from alpine by 34 lines, tundra by 67,
  coastal by 95. About 2 800 lines, mostly shared loader and streaming code.
- `examples/strata-terrain-preview/scripts/fixtures/kit-game/{Alpine,Desert,Tundra,Coastal,Forest}.ts`:
  2 651 lines; Alpine and Desert differ by 0 lines after a biome-name swap.
- `packages/terrain/__tests__/{alpine,coastal,desert,tundra}-runtime.spec.ts` (335–346 lines,
  about 75 % identical) and the four `*-kit.spec.ts` files (61–74 lines): about 1 400 lines.
- Inverted dependency: seven `packages/terrain/__tests__` specs import example source
  (`examples/strata-terrain-preview/src/render/{loading,props,propStreaming,pack,propMaterials,texturePreparation}.js`,
  `viewStatistics.js`, `scripts/fixtures/kit-game/*`). The package cannot test without the example.

`sky.ts` per kit is real per-world look data and stays per kit.

## Solution

One `bakeKit(url, { sky, cookTerrainWorld })` at `@threenative/terrain/kit`, built
from `src/kit.ts`; each kit's `bake.mjs` becomes a small call. Forest supplies its existing
`@threenative/assets` cook; the other four retain their streamed-world bake. One `addStarterWorld` at `@threenative/terrain/starter` holds the browser-safe shared world loader; each kit's `world.ts`
keeps only its look data. One `KitScene` fixture parameterised by kit. One `describe.each(kits)`
runtime spec with a table of per-kit expectations. Package specs that need example code move into
the example, or the code they test moves into the package (PRD-591).

## Acceptance Criteria

- [x] AC-1 [local]: Each kit `bake.mjs` is at most 10 lines, and all five kits bake the same bytes as before. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` with golden hashes — Evidence: 2026-10-11, 19/19 tests passed before and after; alpine/coastal/desert/tundra wrappers are 6 lines each, forest is 8; all five pinned hashes unchanged.
- [x] AC-2 [local]: Five kit playtests pass on one `KitScene` fixture. proof: `pnpm --filter strata-terrain-preview test:kit` for each `KIT` — Evidence: 2026-10-11: the one GPU invocation allowed by the brief, `KIT=alpine`, typechecked and built the packed game (5 443 196 cooked bytes), then failed with exit 2: GameState.worldReady remained 0 after 120 011 ms. Adapter NVIDIA/Turing confirmed under the prescribed environment and lock. Forest/coastal/desert/tundra remain unrun. Final 2026-10-11, lane `strata-starter-dedup` at `2c2726252` (PRD-590 dedup plus the world prewarm gate fix, both now on the EPIC): `KIT=<k> pnpm --filter strata-terrain-preview test:kit` exit 0 for all five kits on one `KitScene` fixture, NVIDIA Turing (`nvidia/turing`), 819 frames each. GPU p95 per view (ms): alpine 1.56–2.96, coastal 2.18–2.57, desert 1.14–1.52, forest 2.68–6.62 (8 791 fir instances drawn), tundra 0.64–1.79. Frame p95 ranged 3.8–92.4 ms with host load average about 34; the kit bounds held.
- [x] AC-3 [local]: One table-driven runtime spec replaces the four per-kit runtime specs with the same assertions. proof: `pnpm --filter @threenative/terrain test` — Evidence: 2026-10-11: 24/24 spec files, 251/251 tests, build and strict publint passed; all 56 table runtime tests and 8 table bake tests retained.
- [x] AC-4 [local]: No file under `packages/terrain/__tests__` imports from `examples/`. proof: `example-imports.spec.ts` — Evidence: 2026-10-11: import scan passed; seven relocated example specs retain all 83 tests; 84/84 including the guard passed.
- [x] AC-5 [local]: Net line count of kits, fixtures and specs drops by at least 4 000. proof: line totals before/after — Evidence: 2026-10-11: 17 337 → 13 145 lines, net −4 192 (24.2%); includes the new 375-line shared runtime helper and all relocated example specs.

## Execution Phases

#### Phase 1: bake and world source
**Status:** DONE
**Files:** `packages/terrain/src/kit.ts` (new), `packages/terrain/tsup.config.ts`, `packages/terrain/package.json`, `starter/*/bake.mjs`, `packages/create-threenative/scripts/stage-terrain-kits.mjs`
- [x] Same bytes from one bake helper. proof: `pnpm exec vitest run packages/terrain/__tests__/starter-kit.spec.ts` — 2026-10-11: 19/19 before and after, including all-five golden hashes and invalid flags. `pnpm exec vitest run packages/create-threenative/__tests__/terrain-kit.spec.ts`: 27/27 after preparing its missing dist with `pnpm exec tsup --config tsup.config.ts` in that package (first run 26/27). `pnpm --filter @threenative/terrain build`: exit 0, including publint.

`pnpm exec tsc -p packages/terrain --noEmit`: exit 1, six errors from the existing example import of missing generated `examples/strata-terrain-preview/src/world/horizon.json`; no kit/helper diagnostics. No assertions or goldens changed. World source and later phases remain open.

- [x] Shared starter-world mechanism with game-owned look. proof: terrain runtime specs, terrain build and scaffolder terrain-kit spec — 2026-10-11: all 70 runtime tests and 27 scaffold tests passed; build including declarations and publint exited 0. Public `@threenative/terrain/starter` keeps Node-only bake imports out of browser games.

#### Phase 2: fixtures and specs
**Status:** PARTIAL
**Files:** `scripts/fixtures/kit-game/*`, `packages/terrain/__tests__/*-runtime.spec.ts`, `*-kit.spec.ts`
- [x] Kit playtests on one fixture. proof: `test:kit` — Done 2026-10-11: all five kits pass at `2c2726252` (see AC-2); the worldReady timeout below was the prewarm gate, fixed in core. Earlier: 2026-10-11: Alpine packed-game typecheck/build pass; NVIDIA/Turing runtime times out on worldReady after 120 011 ms. Four other kits and GPU retry are outside the brief’s one-run limit pending clarification.
- [x] Table-driven spec. proof: `pnpm --filter @threenative/terrain test` — 2026-10-11: 251/251 tests across 24 specs, including 19/19 starter goldens; build and strict publint exit 0.
- [x] No package spec imports the example. proof: grep spec — 2026-10-11: 1/1 guard test passed; 83/83 relocated example tests passed, discovered by root Vitest and the example test command.
- [x] Line count drops by 4 000+. proof: line totals — 2026-10-11: 17 337 → 13 145, −4 192; authored kit/fixture/test .ts/.mjs/.mts/.json plus the new runtime helper; no credit for relocation.

## Execution scope (2026-10-11)

Parts A–D run only in this checkout, one local commit each, no push. Reuse WorldCells, loadWorldHeightmap, Heightfield and existing physics; keep per-kit dress/water/sky choices in copied source. Preserve all assertions and five bake hashes. Baseline before Part A: 17 337 lines across 86 authored kit, fixture and package-test files (.ts/.mjs/.mts/.json); 36 package spec files. Final census also includes extracted package helpers and moved example specs, so moving files earns no LOC reduction.

Part B (2026-10-11): five scenes replaced by one parameterised KitScene; four runtime files become one 56-test table (same 14 tests per kit), four bake specs become one 8-test table. Differences are columns: runtime asset, water response/request and missing-model filename; bake scatter count, water identities, river point count and compared files. Focused 56 runtime + 8 bake + 31 loading + 3 forest startup tests pass. The startup VM now supplies performance/Error and the actual spawn-admission promise; assertions are unchanged. Scoped Biome exits 0 (3 complexity warnings). Full terrain proof is pending the Part C separation; the first run exposes the example’s missing generated horizon.json, now prepared by the existing example bake (five worlds + horizon, exit 0).

Part C (2026-10-11): seven example-owned specs moved to `examples/strata-terrain-preview/__tests__`; root Vitest discovers them and the example test command bakes its inputs first. No implementation code moved; engine ownership decisions remain PRD-591. Existing canopy-admission assertions pass unchanged in the focused example lane; the earlier contended full-suite run left 3 admission jobs pending. Scoped Biome exits 0 (one existing complexity warning).

Part D (2026-10-11): spec files 36 → 31 total (24 package + 7 example); the six-file decrease comes only from the two four-to-one consolidations, while the import guard adds one file. Runtime tests remain 56 for the four table kits plus 14 forest tests; bake table remains 8 tests. Strict terrain typecheck now exits 0 without importing the example’s generated runtime inputs. No dependencies, lockfile, CLAUDE.md files or golden hashes changed; no push.

Final non-GPU checks (2026-10-11): terrain build/test/strict publint exit 0; 251 package tests plus 83 relocated example tests = 334 unique tests (333 preserved + one new import guard). Scaffolder terrain-kit spec 27/27 passed. Strict terrain typecheck exit 0. Scoped Biome: 22 files, exit 0, four complexity warnings. AC-2 remains open unless all five GPU playtests are authorized beyond the brief’s one-GPU-run limit.

Remaining runtime gap (2026-10-11): console records `TN_STARTUP_STALLED` at 90% with `alpine-spawn` still held, followed by `Alpine spawn admission exceeded 120000 ms`. The readiness/prewarm Promise.all does not settle before the deadline; the run does not isolate which promise blocks or establish whether this is a refactor regression. The assumption that prewarm settles while the loading curtain holds needs diagnosis before retry. No timeout, readiness predicate or scenario assertion was weakened. The GPU run-count conflict was raised for clarification; absent an answer, the stricter one-run limit is honored. Document links: 12/12 passed. Worktree retained (990 MB): unmerged local commits, no push and no cleanup authorization for this unfinished lane.

Follow-up diagnosis (2026-10-11): reset this clean lane to epic `e02e0d155`, installed with the frozen lockfile and built terrain/assets/playtest with their dependencies (all exit 0). Added temporary per-second readiness/stats and separate spawn/prewarm settlement logs; the alpine driver scaffolded, baked, typechecked and built 5 443 196 cooked bytes, but the headed WebGPU playtest exited 2 before the game bridge appeared (`TN_PLAYTEST_BRIDGE_MISSING`, frames 0, empty console capture). No readiness counts or promise settlement were observed, so the hanging promise and its cause remain unisolated. The retained game is `/tmp/threenative-kit-zlMir7/kit-game`.

The shipped machine doctor found Node/Playwright/Chromium/Xvfb available. The scene doctor, under the prescribed NVIDIA userspace environment and GPU lock, used its default headless launch and reported `adapter google swiftshader`, a blank scene and zero ticks. Honored this brief's stop-if-SwiftShader rule: no second alpine driver attempt and no coastal/desert/forest/tundra runs. The failed headed driver's adapter was not captured; the headless doctor does not prove what adapter that headed run used. AC-2 and its phase box remain open. Temporary logging removed without committing it; no thresholds, timeouts, radii, appearance or scenario assertions changed.

Existing core deadline proof: `pnpm exec vitest run packages/core/__tests__/world-cells-data.spec.ts -t 'whenSpawnReady'` passed 16/16 selected tests (22 skipped), including finite-deadline rejection and disposal. No engine behavior changed and no new red/green spec was justified without a reproduced root cause. Fixed the example AGENTS fixture index and regenerated its CLAUDE mirror; `pnpm check:docs` passed 3 057 relative links across 1 360 Markdown files. No dependency/lockfile change, no push.
