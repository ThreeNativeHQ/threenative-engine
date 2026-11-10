# Untangle report, 2026-11-06

Date: 2026-11-06. Snapshot: `origin/develop` 58a83ce4b. No code changed.
Method: 8 read-only leanpi scouts on DeepSeek v4.1 flash max (0 Claude escalations), one per key area. The coordinator merged the findings and spot-checked the highest-impact ones.
Raw scout reports (local to the owner machine, not tracked): `~/.cache/tmp-tn/untangle/out/{A..H}.md`. The urgent slice is [PRD-832](../../done/PRD-832-urgent-single-sources.md).

| Scout | Area |
| --- | --- |
| A | core hub: `game.ts`, `index.ts`, `config.ts`, `playtest.ts` |
| B | core render pipeline: `renderer.ts`, `render/`, `look/world-environment.ts` |
| C | core world streaming and assets: `world-*`, `model-lod.ts`, `assets.ts`, terrain overlap |
| D | three-native facade and native host seam: `browser-backend.ts`, `bindings.cpp`, `runtime.cpp` |
| E | playtest harness: runner, scenario schema, evaluators |
| F | create-threenative scaffolder and templates |
| G | `scripts/`, root `package.json`, `.github/workflows/` |
| H | native C++ engine: `runtime-native/src/engine/`, CMake |

Verified by the coordinator (re-ran the command): B1/F2 (7 render files, 12 copies, 1 hash each), A1 (two byte-identical 556 KB `capabilities.json`), A6 (literal `version = "0.3.12"`), C2 (`?? 0.1` outlier at `world-cell-chunks.ts:784`), D5 (`MYSTRAL_USE_LIBUV_TIMERS` defined in no build), E1 (`924b92f82` = 18 files in `playtest/src` for one assertion kind), E3 (`PlaytestTarget = "web" | "desktop" | "bevy"`), F5 (stale 4-kit name list at `index.ts:918`), G4 (recall list misses 3 kits), G7 (`.mjs` duplicate unused), H2 (`renderer.cpp` 7 102 lines), A2 (`Object.defineProperties` boot proxy). Everything else is a scout claim, not verified.

## PRDs

| PRD | Report id | Goal | Priority |
| --- | --- | --- | --- |
| [PRD-832](../../done/PRD-832-urgent-single-sources.md) | Q1-Q5, R2 slice | Urgent single sources: kit inventory, render drift guard, launch flags, tone curve, core version, named `tnw_web_frame` fields | P1 |
| [PRD-833](../../done/PRD-833-template-mechanism-lives-once.md) | R1 | Template mechanism lives once | P1 |
| [PRD-835](../../done/PRD-835-one-registry-entry-per-assertion.md) | R3 | One registry entry per assertion | P1 |
| [PRD-840](../../done/PRD-840-platform-difference-is-a-value.md) | N3 | Platform difference is a value, not a scattered `#ifdef` | P1 |
| [PRD-834](../../done/PRD-834-cross-language-contracts-are-generated.md) | R2 | Cross-language contracts are generated | P2 |
| [PRD-836](../../done/PRD-836-one-committed-capability-manifest.md) | R4 | One committed capability manifest | P2 |
| [PRD-837](../../done/PRD-837-core-owns-each-shared-fact-once.md) | R5 | Core owns each shared fact once | P2 |
| [PRD-838](../../done/PRD-838-scripts-share-one-runtime-layer.md) | N1 | Scripts share one runtime layer | P2 |
| [PRD-839](../../done/PRD-839-ci-contract-is-a-model-not-text.md) | N2 | The CI contract is a model, not text matches | P2 |
| [PRD-841](../../done/PRD-841-game-ts-stops-being-the-hub.md) | N4 | `game.ts` stops being the hub | P2 |
| [PRD-842](../../done/PRD-842-native-tests-check-behaviour-not-source-text.md) | N5 | Native tests check behaviour, not source text | P2 |
| [PRD-862](PRD-862-untangle-native-leftovers.md) | N3, N5 | The untangle batch's native leftovers (moved from PRD-840 and PRD-842) | P2 |

The "Later" god-file splits below have no PRD yet. Each one gets its own PRD when it is picked.

## Priority table (effort x impact)

Effort: S < 1 h, M half day, L 1-3 days. Impact 1-5 (5 = touches most future changes in the area).

### Quick wins (effort S, impact 3+)

| # | Fix | Solves | Effort | Impact |
| --- | --- | --- | --- | --- |
| Q1 | Drift test: fail when a `src/render/*` path is byte-identical in 2+ kits and not in the shared list | F2, guards B1 until R1 lands | S | 5 |
| Q2 | One `scripts/lib/repo-inventory.ts` (packages, kits, Node version derived from disk) | G4 (bug: recall skips `puzzle`, `rts`, `runner`), 65 Node pins | S | 4 |
| Q3 | One `readLaunchFlag(name)` in core, delete 16 copies with 3 truthiness rules | A4 | S | 4 |
| Q4 | `WorldEnvironment.apply` calls `applyRendererToneMapping`; delete its own map and `?? "aces"` | B3 (also check: `aces` default vs the owner's filmic default, unverified) | S | 4 |
| Q5 | Core version from `version.ts` only; delete the literal and the release regexes; doctor reads core's `package.json` | A6, F7 | S | 3 |

Also S: C4 asset-loader fallback fails closed, C5 move `cullDistance`, C6 `WorldCells.terrain` getter, A5 one `dev-global.ts`, B6 exposure probe into `startup-readiness.ts`, B8 failed adapter probe lands on `low`, D7 script-name enum fails closed, D8 merge 6 audio fragments, G5 perf verdict rule in one place, G7 delete 5 dead scripts and wire or delete 4 orphan gates, H4 one C++ `flags.h`, H6 one CMake renderer link function, E5 split `perf.ts`, E7 one `delay`, F5 delete stale kit list.

### Big bets (impact 5)

| # | Root fix | Solves | Effort | Impact |
| --- | --- | --- | --- | --- |
| R1 | Template mechanism lives once: move the 7 render files to a core subpath; restamp other shared sources from one copy; scaffold hash split into `shared` + `kit` with a `pnpm scaffold:pin` | B1, F1, F2, F3, F4, F8, B2 (12 copies of the WebGL gate) | L | 5 |
| R2 | One manifest per cross-language contract, generating C++ enum + TS const, unknown id aborts | D1 = H1 (`tnw_web_frame` 87 integer cases, `default: return 0`), D3 (frame-op opcodes), E4 (`TN_*` markers, 4 declarations), A8 (config keys read by string in C++), C7 (`__tnCopyMatrixWorld`), D7 | L (first slice `tnw_web_frame`: M) | 5 |
| R3 | One registry entry per extension point carries validate, evaluate, observation path and supported lanes; the rest is generated | E1 (17 files per assertion), E3, E6, E2 (`requiresPixels` x3) | M | 5 |
| R4 | One committed capability manifest; everything else is build output | A1 (median 34 files per `index.ts` commit, pre-commit hook adds 5 files silently) | M | 5 |
| R5 | Core owns each shared fact once: `selectLodFor`, the `world.json` contract, `rendererFacts()`, one `GpuReadings` | C2 (LOD recipe x6), C1 (3 manifest declarations, dead `impostor: 110` knob), B2 (`"engine" in info` x8, `kind === "webgpu"` x58), B4 (3 freshness rules) | M each | 5 |

### Next (impact 4-5, larger)

| # | Root fix | Solves | Effort | Impact |
| --- | --- | --- | --- | --- |
| N1 | `scripts/lib/{dev-server,exec,mcp-client,gh,args}.ts`, strictest variant wins | G1 (4 helper families x5-11), G6 | M | 5 |
| N2 | CI workflow model in `ci-workflow.ts`; invariants as data; split classifier from reuse | G2 (5 048-line text-match spec), G3, G8 | L | 5 |
| N3 | `RenderFeatures` value set at construction instead of `#ifdef __EMSCRIPTEN__` in render semantics; then split `renderer.cpp` by concern | H3, H2 (2 743-line `renderPrepared`) | M + L | 5 |
| N4 | `game.ts`: phases take narrow interfaces, each acquisition pushes its disposer, scene-entry inspectors register in one ordered list | A2 (46-field proxy), A3 (hand-ordered teardown), A7 | M-L | 5 |
| N5 | Behaviour seams instead of regex over C++ source | D2 (35 test files read `bindings.cpp`/`runtime.cpp` as text) | L | 5 |

Later (impact 3-4, god-file splits along their own seams): B5 `renderer.ts`, B7 `WorldEnvironment.apply`, C3 two residency budgets, C8 `CellRender` host, D4 browser-backend mirror table, D5 `runtime.cpp`, D6 `bindings.cpp` + twin `BindingsState`, E3 `deviceRunner.ts`, F6 scaffolder `index.ts`, H5 `MATERIAL_FIELDS` table, H7, H8 shared host support.

## Decision log (fix above the problems it solves)

- **R1. Template mechanism lives once.** AGENTS.md already says mechanism goes to `packages/core/src/`; the templates hold copies instead.
  - B1/F2: `environmentContribution`, `environmentRadiance`, `environmentSampleCache`, `environmentSampling`, `environmentSnapshot`, `backlightControls`, `backlightMaterial` are byte-identical in 12 kits (9 084 lines). `c93b427d0` touched 552 files for one look change.
  - F3: `vite.config.ts` 10/16 identical, `main.ts` 11/16, `tsconfig.json` 8/16, no restamp.
  - F4: the framework patch filename is spelled in 40 places, including a `prepack` one-liner.
  - B2: the WebGL fallback predicate is defined in 12 `templates/*/src/render/quality.ts:73`.
  - F1: `scaffold.spec.ts` (301 commits in 90 days, the most-changed file) holds 16 whole-tree hashes and ~170 lines of re-pin prose. A shared edit re-pins 16.
  - F8: "what ships" is pinned 3 times (hashes, `STARTER_PATHS`, allowlist).
  - F5: `index.ts:918` re-copies for 4 named kits; 7 kits ship the file.
- **R2. One manifest per cross-language contract.** The existing `api/catalog.json` → `catalog_types.inc` generator is the precedent.
  - D1/H1: `web_host.cpp:1019` `tnw_web_frame(int)`, 87 cases, `default: return 0`; TS mirrors at `browser-renderer.ts` (56 call sites) and `gpu-stages.ts:33-49`. The ABI digest hashes signatures only.
  - D3: `frame-op-stream.js` has 60 bare opcode ints mirrored in `bindings_frame_stream.cpp:76` and two switches.
  - E4: markers printed in C++ and TS, parsed in `perf.ts:30-58`, re-declared in `engine-cost.ts:4` and `frame-cost.ts:6`. Window payload type declared twice (`frame-budget.ts:264`, `perf.ts:112`).
  - A8: `window.cpp:181` reads `"bootSplash"` by string search; TS has both `render` and `renderer`.
  - C7: `__tnCopyMatrixWorld` defined in `bindings_scene.cpp:714`, read in 3 JS files, no shared name.
  - D7: 16 embedded-script call sites pass literal names; a missing script prints one stderr line.
- **R3. One registry entry per extension point.**
  - E1: one assertion kind = 17 hand-edited files; `runner.spec.ts:676-694` pins 3 kinds that shipped with no runner.
  - E3: `supportedOn` cannot name android or ios; the lane matrix is 11 `if` blocks in `androidRunner.ts:1185-1275`.
  - E6: `geometry` is outside the registry; `requiredCapabilities` and `trivialityRationale` are read by nothing at runtime.
  - E2: capture-with-retry is open-coded 5 times across browser and device lanes.
  - H5 (C++ analogue): one material field touches 11-17 files.
  - A7 (core analogue): each scene audit edits `#enterScene` in `game.ts:693-703`.
- **R4. One committed capability manifest.**
  - A1: `core/capabilities.json` and `create-threenative/capabilities.json` are the same 556 KB. 82 of 117 `index.ts` commits also touch the copy. The pre-commit hook stages 5 regenerated files.
  - A6/F7: version literal in `index.ts:9`, `doctor.ts:215`, plus 5 regex patches in `prepare-release.ts:246-270`.
- **R5. Core owns each shared fact once.**
  - C2: `worldSphere → conservativeViewDepth → bias → selectLodLevel` inline at 6 sites; one uses `near ?? 0.1`, five use `?? 0`.
  - C1: `world.json` declared in core, terrain and assets; terrain lacks `impostorDistance`; biome `impostor: 110` is read by nothing.
  - B2: backend facts re-derived as `"engine" in info` (8 sites) and `kind === "webgpu"` (58 sites).
  - B4: GPU-sample freshness is 8 frames in the renderer, 16 in the scaler, per-frame in the budget.
  - B3: two tone-mapping maps, defaults `filmic` vs `aces`.
  - A4: 16 launch-flag readers with different truthiness.
  - A5: `__THREENATIVE__` has 6 owners; a missing worker mirror entry hides a member in worker mode.
  - H4: 31 C++ env flags, some read once, some per frame.
  - G4/G5: kit and package lists typed by hand in scripts; perf verdict rule copied into `@threenative/playtest`.
- **N3. Platform difference is a value, not a scattered `#ifdef`.**
  - H3: 27 `__EMSCRIPTEN__` sites; 3 change which picture is drawn (`renderer.cpp:3142`, `render_database.cpp:1434,1535`).
  - H6: renderer link list written twice in CMake.
  - H8: `run.cpp` and `web_host.cpp` re-implement adapter, limits, surface and readback setup.
  - D6: `BindingsState` has two layouts under `#if` (`bindings_state.h:641-679`).
- **N4. `game.ts` stops being the place every feature edits.**
  - A2: 196-line `Object.defineProperties` proxy of 46 private fields, cast hides a forgotten field.
  - A3: 93-line hand-ordered teardown beside an unused `#cleanup` stack.
  - A7: UI bridge, scene-entry policy, config and lifecycle in one file (116 commits in 90 days).
- **N5 and N2. Tests check behaviour, not source text.** (This is the skill's optional "Tests" step.)
  - D2: 35 test files (12 397 lines) regex `bindings.cpp`, `runtime.cpp` and `browser-renderer.ts`; 166 `doesNotMatch`.
  - G2: `ci-structure.spec.ts` 5 048 lines, 594 text assertions on `ci.yml`.
  - G8: a spec splices 3 688 characters of a historical workflow onto the live one.
  - D5: `timer-contract.test.mjs` locks the shape of a timer branch compiled in no build.

## Special cases (the skill's progress measure)

| Area | Count | Main kinds |
| --- | --- | --- |
| A core hub | 6 | 2 empty catches, 4 timer waits in `playtest.ts` |
| B render | 28 | 25 empty catches, duplicate defaults |
| C world | 19 | 10 empty catches in `assets.ts`, 4 `skipIf(!bench)` |
| D facade/host | 62 | 39 platform `#if`, negative-number commands, dead macro branch |
| E playtest | 111 | 63 empty catches, 31 `target === "…"`, 12 hand waits |
| F scaffolder | 62 | 42 empty catches, 12 `process.platform`, 4 per-kit lists in tests |
| G scripts | 54 | 21 `setTimeout` waits, 8 retry loops, 7 conditional skips |
| H C++ engine | 23 | `__EMSCRIPTEN__` forks, single-value flags |
| **Total** | **365** | about 150 swallowed catches |

## Defects found on the way (not a bug hunt)

- ✅ fixed, measured 2026-11-07: `pnpm budgets` had failed on the capability-recall floor after this
  branch added public API — `recallAtK` 0.9279 against 0.9369, with `snow.refill` ("fresh snowfall
  slowly fills old tracks back in") no longer returning `SnowField`. That entry was byte-identical to
  the merge base, so it was a ranking shift from the fifteen new entries, not a doc regression; the
  class's own doc now names the recovery it already performs, and recall is back at the floor exactly
  (0.9369, 104/111). The same run also caught a stale native-coverage digest, regenerated.

- ✅ verified: `scripts/capability-recall.ts:120` skips kits `puzzle`, `rts`, `runner` (fixed by Q2).
- ✅ verified: LOD near-plane default disagrees (`?? 0.1` vs `?? 0`) (fixed by R5).
- ⚠️ unverified: failed adapter probe → software machine gets tier `high` (`renderer.ts:1975`, B8).
- ⚠️ unverified: registry marks `tone` unsupported on android while the android runner supports it (E3).
- ⚠️ unverified: `WorldEnvironment` defaults `tonemapMode` to `aces` (`world-environment.ts:793`); the owner rule says filmic by default. A preset may supply filmic upstream.
- ⚠️ unverified: `render` vs `renderer` config keys, one silently ignored (A8).
