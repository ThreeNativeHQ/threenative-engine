# PRD-832 — Urgent single sources: one owner for each value that has silently drifted

**Status:** DONE (2026-11-07). All three phases landed and AC-1 is green.
**Priority:** P1 — the phases landed; AC-1's board is green on this PR's CI.
**Complexity:** 5 (MEDIUM); risk override: Phase 2 can change the default tone curve, so the owner's visual-judge rule applies to that box
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](../refactoring/untangle-2026-11-06/README.md)

## Context

The [untangle report](../refactoring/untangle-2026-11-06/README.md) lists 365 special cases and 8 areas. This PRD batches the urgent
items: each is a value held in several places that already disagrees or can disagree with no red.
Big structural fixes (R1 template code once, R3 assertion registry, R4 one capability manifest,
R5 core shared facts) stay in the report. Each one gets its own PRD when it is picked.

| Report id | Problem today | Where |
| --- | --- | --- |
| Q2 / G4 | Kit list typed by hand. It misses `puzzle`, `rts`, `runner`, so `--template` rejects them and recall skips them. Packages listed by regex in 2 scripts. Node version pinned 65 times in workflows. | `scripts/capability-recall.ts:120-134`, `scripts/ci-integration-scope.mjs:50`, `scripts/ci-change-scope.mjs:22-33`, `scripts/visual-gate.ts:43` |
| Q1 / F2 | 7 render files are byte-identical in 12 kits and not in `SHARED_RENDER_SOURCES`, so nothing restamps or compares them. | `packages/create-threenative/src/index.ts:130`, `templates/*/src/render/{environment*,backlight*}.ts` |
| Q3 / A4 | 16 launch-flag readers with 3 different truthiness rules. The exported `debugFlag` has no in-engine caller. | `packages/core/src/debug.ts:49`, list in report A4 |
| Q4 / B3 | Two tone-mapping maps. `WorldEnvironment` defaults to `aces` while the renderer defaults to `filmic`. The root `AGENTS.md` says filmic is the default. | `packages/core/src/look/world-environment.ts:135,793,921-939`, `packages/core/src/look/default-tone-mapping.ts:8-19`, `packages/core/src/renderer.ts:2106` |
| Q5 / A6 / F7 | Core version is a literal in 3 source files and is patched by regex at release. `version.ts` is already generated from `package.json`. | `packages/core/src/index.ts:9`, `packages/create-threenative/src/doctor.ts:215`, `scripts/prepare-release.ts:246-270` |
| R2 slice / D1 / H1 | `tnw_web_frame(int field)` has 87 integer cases with `default: return 0`. The TS side uses bare numbers, and one comment cites C++ line numbers. The ABI digest hashes only signatures. | `packages/runtime-native/src/engine/wasm/web_host.cpp:1019-1129`, `packages/three-native/src/browser-renderer.ts:650-669`, `packages/three-native/src/gpu-stages.ts:27-49`, `packages/three-native/__tests__/web-host-abi.spec.ts` |

## Solution

One owner per value, and every other site reads it. Follow the refactoring batch rules
([the untangle report](../refactoring/untangle-2026-11-06/README.md)): pin first, move without changing behaviour, and give each bug found on
the way its own red-green commit.

- Phase 1, repo level: `scripts/lib/repo-inventory.ts` derives packages from `packages/*/package.json`,
  kits from `packages/create-threenative/templates/*/kit.json` and the Node version from root
  `package.json` `engines`. Scripts import it. A drift spec rejects an unlisted byte-identical
  `src/render/*` file, then the 7 files go into `SHARED_RENDER_SOURCES`.
- Phase 2, core: one `readLaunchFlag(name)` in `debug.ts`. `WorldEnvironment.apply` calls
  `applyRendererToneMapping`. `index.ts` re-exports `CORE_VERSION`.
- Phase 3, Wasm ABI: a single field manifest generates a C++ enum and a TS const object. The
  manifest goes through the `api/catalog.json` → generator path in
  `packages/three-native/scripts/generate.ts`. Callers use names, and an unknown field fails loudly.
  Field ids stay frozen and append-only.

## Acceptance Criteria

- [x] AC-1 [local]: Typecheck, lint and the affected board stay green. proof: this PR's CI run [42417041934](https://github.com/ThreeNativeHQ/threenative-engine/actions/runs/42417041934) on head `0f00124a0` — the board `ci-change-scope.mjs` selects for this diff — passed `typecheck`, `lint`, `test`, `test-unit`, `budgets`, `build-artifacts`, `supply-chain`, `golden-path-template (action-rpg)` and the `ci-required` join. A local replay with `pnpm ci:local --affected --base origin/develop --target develop` selected the **full** board (a `packages/*/package.json` change escalates past the review lane) and is not the proof: run beside a second GPU lane on one machine, its `golden-path`, `visuals`, `test-playtest` and `test-browser` jobs each failed to boot a page rather than assert anything. The one real red it did find was a broken documentation link in this batch's own move (fixed); `pnpm check:docs` → 3796 links across 1634 files.

## Review round (2026-11-07)

An independent read-only review of the three phases raised five gaps, all fixed before the next PRD:

- `shared-render-drift.spec.ts` grouped copies by hash, so a *listed* file one kit edited dropped out of
  the check entirely. It now also compares every shipped copy of a listed file with
  `canonicalRenderSourcePath` byte for byte (shown red by appending a line to `minimal`'s `gpuSky.ts`).
- `debug.ts` changed the truthiness rule for core's readers while `three-native/src/debug-telemetry.ts`
  kept the old one, so `?tnDebug=true` turned core telemetry on and the facade's off. Both now follow one
  rule, held to it by `scripts/__tests__/launch-flag-parity.spec.ts`; the two copies exist because the
  package graph gives three-native no dependency on core.
- `bundlesAsked` had lost "an explicit yes on any seam beats a no", which the original spec pinned. It
  reads every naming seam again (`readLaunchValues`), and the rule now has a direct spec.
- `web-frame-fields.spec.ts` pinned a digest, which cannot tell an allowed append from a renumber. It
  pins the published `(name, id)` pairs instead, and the generated header now carries
  `tn_is_web_frame_field`, so an unknown id is refused before a renderer exists, not answered with 0.
- Three edits were unrequested and are reverted: the spell tier reader (`spells/ultra/engine/quality.ts`
  is a verbatim upstream port and keeps its own `?q=`/`?mobile` read), the invented `TN_SHADOW_LEVELS`,
  `TN_ADAPTIVE_REFRESH` and `TN_SHADOW_STATS` environment seams (those switches are query-only, as they
  were), and a "only writer" comment that ignored the Unreal-look capture harness's own copy.

A second pass over the fixed work found two regressions of its own, both fixed: `scripts/visual-gate.ts`
passed the templates folder where `repo-inventory.templateNames()` expects the repository root (its spec
caught it), and the spell reader revert had silently not applied (the file is now byte-identical to the
base commit). The parity spec's cases now carry the answer the rule gives, so two copies that agree on a
wrong answer still fail. `verify-registry-install.ts` reads the Node floor from `engines.node` through
`minimumNodeVersion()`, and a shorter range no longer rejects every version.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Kit and package inventory | `pnpm budgets` → `capability-recall.ts`; CI scope scripts | Hand lists deleted | Phase 1 box 1 |
| Launch flags | Every core subsystem reading `?tn…` / `TN_*` switches | 16 local readers deleted | Phase 2 box 1 |
| Tone curve | `WorldEnvironment.apply` | Its private map and fallback deleted | Phase 2 box 2 |
| Frame telemetry fields | `browser-renderer.ts` and `gpu-stages.ts` → `tnw_web_frame` | Bare integers deleted | Phase 3 boxes |

## Execution Phases

#### Phase 1: Repo inventory and template drift guard
**Status:** DONE
**Files:** new `scripts/lib/repo-inventory.ts`; edit `scripts/capability-recall.ts`, `scripts/ci-change-scope.mjs`, `scripts/ci-integration-scope.mjs`, `scripts/visual-gate.ts`, `packages/create-threenative/src/index.ts`; new drift spec under `packages/create-threenative/__tests__/`.

- [x] Recall accepts and harvests every shipped kit (red first: `--template puzzle` rejected with `TN_CAPABILITY_RECALL: unknown template 'puzzle'`; now resolves). No script keeps a hand kit or package list: `scripts/lib/repo-inventory.mjs` derives kits from `templates/*/kit.json`, brief genres from `docs/benchmark/genres/*/brief.md`, packages from `packages/*/package.json` and the Node floor from root `engines.node`. `capability-recall.ts`, `ci-change-scope.mjs`, `ci-integration-scope.mjs` (which now fails closed on a package name that left the workspace — read from the **Git tree**, because that job sparse-checks out `scripts/` and each `kit.json` only and a disk read sees no manifest there: `workspacePackageNamesFromTree` came from the merge's first CI run, `CI_PACKAGE_INVENTORY: 'terrain' is not a workspace package`, and its spec holds the two reads equal) and `bake-delete-test.ts` read it. proof: `pnpm exec vitest run scripts/__tests__/capability-recall.spec.ts scripts/__tests__/ci-integration-scope.spec.ts scripts/__tests__/repo-inventory.spec.ts` → 199 passed; `rg -n '"tower-defense"' scripts --glob '!__tests__'` returns nothing. The `scripts/__tests__/ci-change-scope.spec.ts` this box named does not exist — the specs over that module are `ci-native-chain`, `ci-needs`, `ci-leg-carry`, `ci-local` and `capability-site-docs`, all green.
- [x] The drift spec failed on today's tree naming the unlisted copies, then passed once they are in `SHARED_RENDER_SOURCES`. It named 9, not 7: `atmosphere.ts` (6 kits) and `gpuSky.ts` (6 kits) ship byte-identical everywhere too. The rule is "same bytes in every kit that carries it, in 2+ kits", so a per-kit look that merely coincides in 4 kits (`exposure.ts` has 10 distinct copies) stays out. `ADDED_RENDER_SOURCES` keeps the scaffold-time copy into starter/collectathon/adventure/kart unchanged, and `pnpm stamp:template-render` is byte-for-byte a no-op. proof: `pnpm --filter create-threenative exec vitest run __tests__/shared-render-drift.spec.ts` → 4 passed, plus `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/scaffold-file-allowlist.spec.ts` → 80 passed

#### Phase 2: Core single owners
**Status:** DONE
**Files:** `packages/core/src/debug.ts` plus the 16 reader sites in report A4; `packages/core/src/look/world-environment.ts`; `packages/core/src/index.ts`; `packages/create-threenative/src/doctor.ts`; `scripts/prepare-release.ts`.

- [x] One `readLaunchFlag` owns flag parsing, and every reader keeps its accepted spelling. `debug.ts` exports `readLaunchFlag(spec, "on" | "off", search?)`, `readLaunchValue(spec)` and `readLaunchValues(spec)` over the three seams; 12 core files now call it (`world-gpu-flags` ×4, `world-validate`, `world-tile-budget`, `world-cell-options`, `world-environment`, `render-list-validate`, `debug-telemetry`, `Spans`, `FrameStages`, `depth-pyramid`, `virtual-shadow` ×3, `quiet-markers`). One truthiness rule replaced three: `0`/`false` are off, a named-but-empty value is on, an empty variable is unset; every seam that names the flag is heard, so a harness global is not lost behind a disagreeing environment variable. `ui-bridge` keeps its own read because it reads a passed scope's `location` (a worker realm), not this launch's. proof: `pnpm --filter @threenative/core exec vitest run __tests__/debug.spec.ts` and the whole core suite (`npx vitest run packages/core/__tests__` → 4559 passed, 4 skipped); `URLSearchParams` occurrences in `packages/core/src` fell 5 → 4 and hand `location.search` reads 14 → 3: `debug.ts` owns the launch seams, `ui-bridge` reads a passed worker scope's `location`, and the two that remain are the verbatim spell port and the dead `gtaoUrlKnobs(params)` helper. `world-gpu-flags.spec.ts` was rewritten where it pinned the three old rules: it asserted `?tnX=` off for one switch and on for `debugFlag`, and `"true"` off for one global and on for another.
- [x] `WorldEnvironment` uses `applyRendererToneMapping`. The default did not move: `qualityPreset()` already supplied `filmic`, and the `?? "aces"` fallback was dead — so no visual judge is owed. The private `TONEMAP` map and the duplicated filmic install are deleted, and `default-tone-mapping.ts` now owns the curve list (`RENDERER_TONE_MAPPINGS`, `isRendererToneMapping`) and accepts the game's curve and grade. proof: `pnpm --filter @threenative/core exec vitest run __tests__/world-environment-defaults.spec.ts __tests__/default-tone-mapping.spec.ts` → 31 passed.
- [x] Core version has one source: `index.ts` re-exports `CORE_VERSION` from the generated `version.ts`, `doctor.ts` imports that constant instead of a literal, and `prepare-release.ts` drops the three regexes that patched them. proof: `pnpm exec vitest run packages/create-threenative/__tests__/doctor.spec.ts scripts/__tests__/prepare-release.spec.ts` → 112 passed.

#### Phase 3: Named `tnw_web_frame` fields
**Status:** DONE
**Files:** the field manifest beside `packages/three-native/api/catalog.json`; `packages/three-native/scripts/generate.ts`; `packages/runtime-native/src/engine/wasm/web_host.cpp`; `packages/three-native/src/browser-renderer.ts`, `gpu-stages.ts`, `browser-entry.ts`; `packages/three-native/__tests__/web-host-abi.spec.ts`.

- [x] Every `tnw_web_frame` caller uses a generated name, from one manifest: `packages/three-native/api/web-frame-fields.json` (73 fields) feeds `packages/three-native/scripts/generate.ts`, which writes the TypeScript constant (`src/generated/web-frame-fields.ts`), the C++ enum (`runtime-native/src/engine/wasm/web_frame_fields.h`) and the facade's stage tables (`gpu-stages.ts` `CPU_STAGE_FIELDS`/`SHADOW_SEGMENT_FIELD`, `browser-renderer.ts`'s GPU stage base). The switch names the enum, and an id no manifest entry declares prints `TN_WEB_FRAME_UNKNOWN_FIELD` once and answers NaN instead of a zero the caller would read as a measurement. `__tests__/web-frame-fields.spec.ts` pins the three copies to the manifest and the 73 published `(name, id)` pairs, so an append is the only edit that passes and a renumber goes red. proof: `pnpm --filter @threenative/three-native exec vitest run __tests__/web-frame-fields.spec.ts __tests__/web-host-abi.spec.ts` → 6 passed; `pnpm wasm:build` compiles and links both web engines with the new switch (exit 0).
- [x] The owned web engine still reports real frame telemetry: `TN_FRAME_BUDGET` on `examples/wasm-engine-boot` (the game page, `--browser-recipe webgpu`, adapter `nvidia`/`turing`) reads GPU `mean 0.05 ms` over 3 samples and non-zero CPU stages (`wasmPlan` mean 0.30, `wasmEncode` 0.26, `wasmScene` 0.06, `wasmPost` 0.16, `engineJs` 0.30) — the renamed stage fields (66-70) answer the values they named before. The starter scaffold needs a full template install-and-build lane, so the proof runs on the in-repo game page that drives the same `tnw_web_frame` path; `pnpm test:templates` remains the starter-wide gate under AC-1. proof: `pnpm --filter wasm-engine-boot build && pnpm --filter wasm-engine-boot playtest:frame-budget` (the scenario is `examples/wasm-engine-boot/playtests/frame-budget.playtest.json`) → 1 window, values recorded here
