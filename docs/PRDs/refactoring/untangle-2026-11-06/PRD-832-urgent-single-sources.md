# PRD-832 — Urgent single sources: one owner for each value that has silently drifted

**Status:** NOT STARTED
**Priority:** P1 — the open Phase 1 box fixes a live gap: `pnpm budgets` runs capability recall without the `puzzle`, `rts` and `runner` kits. The open Phase 3 boxes remove a web telemetry channel that answers 0 to an unknown field.
**Complexity:** 5 (MEDIUM); risk override: Phase 2 can change the default tone curve, so the owner's visual-judge rule applies to that box
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md)

## Context

The [untangle report](README.md) lists 365 special cases and 8 areas. This PRD batches the urgent
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
([../README.md](../README.md)): pin first, move without changing behaviour, and give each bug found on
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

- [ ] AC-1 [local]: Typecheck, lint and the affected board stay green. proof: `pnpm typecheck && pnpm lint && pnpm ci:local --affected --base origin/develop --target develop`

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Kit and package inventory | `pnpm budgets` → `capability-recall.ts`; CI scope scripts | Hand lists deleted | Phase 1 box 1 |
| Launch flags | Every core subsystem reading `?tn…` / `TN_*` switches | 16 local readers deleted | Phase 2 box 1 |
| Tone curve | `WorldEnvironment.apply` | Its private map and fallback deleted | Phase 2 box 2 |
| Frame telemetry fields | `browser-renderer.ts` and `gpu-stages.ts` → `tnw_web_frame` | Bare integers deleted | Phase 3 boxes |

## Execution Phases

#### Phase 1: Repo inventory and template drift guard
**Status:** NOT STARTED
**Files:** new `scripts/lib/repo-inventory.ts`; edit `scripts/capability-recall.ts`, `scripts/ci-change-scope.mjs`, `scripts/ci-integration-scope.mjs`, `scripts/visual-gate.ts`, `packages/create-threenative/src/index.ts`; new drift spec under `packages/create-threenative/__tests__/`.

- [ ] Recall accepts and harvests every shipped kit (red first: `--template puzzle` rejected today). No script keeps a hand kit or package list. proof: `pnpm exec vitest run scripts/__tests__/capability-recall.spec.ts scripts/__tests__/ci-change-scope.spec.ts scripts/__tests__/ci-integration-scope.spec.ts` plus `rg -n '"tower-defense"' scripts --glob '!__tests__'` returns nothing
- [ ] The drift spec fails on today's tree with the 7 unlisted files named, then passes once they are in `SHARED_RENDER_SOURCES`. proof: `pnpm --filter create-threenative exec vitest run __tests__/shared-render-drift.spec.ts`

#### Phase 2: Core single owners
**Status:** NOT STARTED
**Files:** `packages/core/src/debug.ts` plus the 16 reader sites in report A4; `packages/core/src/look/world-environment.ts`; `packages/core/src/index.ts`; `packages/create-threenative/src/doctor.ts`; `scripts/prepare-release.ts`.

- [ ] One `readLaunchFlag` owns flag parsing, and every reader keeps its accepted spelling. proof: `pnpm --filter @threenative/core exec vitest run __tests__/debug.spec.ts` plus `rg -c 'URLSearchParams' packages/core/src` drops by the deleted copies
- [ ] `WorldEnvironment` uses `applyRendererToneMapping`. A scene with no look options gets `filmic` and reports it in `TN_TONEMAP`. If that changes the default from today, a visual judge on the starter returns NEUTRAL or better. proof: `pnpm --filter @threenative/core exec vitest run __tests__/world-environment-defaults.spec.ts`, plus the judge verdict on this box if the default moved
- [ ] Core version has one source: `index.ts` re-exports `CORE_VERSION`, `doctor.ts` reads core's resolved `package.json`, and `prepare-release.ts` drops those regexes. proof: `pnpm exec vitest run packages/create-threenative/__tests__/doctor.spec.ts scripts/__tests__/prepare-release.spec.ts`

#### Phase 3: Named `tnw_web_frame` fields
**Status:** NOT STARTED
**Files:** the field manifest beside `packages/three-native/api/catalog.json`; `packages/three-native/scripts/generate.ts`; `packages/runtime-native/src/engine/wasm/web_host.cpp`; `packages/three-native/src/browser-renderer.ts`, `gpu-stages.ts`, `browser-entry.ts`; `packages/three-native/__tests__/web-host-abi.spec.ts`.

- [ ] Every `tnw_web_frame` caller uses a generated name. The C++ switch uses the generated enum, and an unknown field fails loudly. The ABI spec digests the field list, so a renumbered field goes red. proof: `pnpm --filter @threenative/three-native exec vitest run __tests__/web-host-abi.spec.ts` plus `pnpm native:build` for the Wasm target
- [ ] Starter on the owned web engine still reports real frame telemetry: `TN_FRAME_BUDGET` GPU and CPU stage values are non-zero. proof: `node packages/playtest/dist/runner/cli.js` on the starter golden scenario with `--browser-recipe webgpu`, `adapter.info` checked
