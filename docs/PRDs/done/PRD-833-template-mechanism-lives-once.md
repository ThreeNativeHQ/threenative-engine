# PRD-833 — Template mechanism lives once

**Status:** DONE — all three phases landed, AC-1 is green and the AC-2 visual judge returned NEUTRAL (2026-11-08).
**Priority:** P1 — all phases landed; AC-1 is green and AC-2 is the one open verification (a before/after visual judge), so the tier rates that judge rather than a copy count.
**Complexity:** 6 (MEDIUM); risk override: the moved files measure the environment and wire the backlight, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** PRD-832 (its Phase 1 drift spec guards the copies until this PRD deletes them)
**Batch:** [Untangle report, 2026-11-06](../refactoring/untangle-2026-11-06/README.md) — R1

## Context

Report ids B1, F1, F2, F3, F4, F8, B2. Root `AGENTS.md` puts "plumbing every game repeats" in
`packages/core/src/`. The templates hold copies instead.

| Problem | Where |
| --- | --- |
| 7 render files byte-identical in 12 kits, 9 084 lines. `c93b427d0` touched 552 files for one look change. | `templates/*/src/render/{environmentContribution,environmentRadiance,environmentSampleCache,environmentSampling,environmentSnapshot,backlightControls,backlightMaterial}.ts` |
| WebGL fallback predicate defined 12 times | `templates/*/src/render/quality.ts:73`, `templates/starter/src/render/rendererGate.ts:28` |
| Build plumbing copied: `vite.config.ts` 10/16, `src/main.ts` 11/16, `tsconfig.json` 8/16 | `templates/*/` |
| Framework patch filename spelled in 40 places, including a `prepack` one-liner | `packages/create-threenative/src/index.ts:729-731`, `packages/create-threenative/package.json:74`, 16× `templates/*/package.json` |
| 16 whole-tree hashes re-pin on any shared edit. The spec changed in 301 commits in 90 days. | `packages/create-threenative/__tests__/scaffold.spec.ts:238-530` |
| "What ships" pinned 3 times: hashes, `STARTER_PATHS` (149 entries), allowlist | `scaffold.spec.ts:532-670`, `scaffold-file-allowlist.spec.ts:21-51` |

## Solution

1. The 7 mechanism files move to one core subpath, for example `@threenative/core/render/environment`.
   Each template keeps a small parameter object for its colours, gains and thresholds: the
   `GPUParticles3D` shape. The WebGL predicate becomes one core export.
2. Build plumbing comes from one shared source, restamped by `createProject`. A per-kit delta in
   the kit's own manifest names the Vite plugins it needs. One `template-assets/patches/manifest.json` feeds
   `copyFrameworkPatches`, `prepack` and the catalog script.
3. `scaffold.spec.ts` keeps two hashes per kit, `shared` and `kit`. `pnpm scaffold:pin` rewrites them
   and names the moved input. `STARTER_PATHS` and its siblings are deleted, and the allowlist owns names.

## Acceptance Criteria

- [x] AC-1 [local]: A freshly scaffolded starter builds and passes its golden playtest. proof: `TN_GOLDEN_PATH_SCENARIOS=1 TN_PLAYTEST_ALLOW_SOFTWARE=1 TN_GOLDEN_PATH_TEMPLATES=starter,platformer pnpm verify:golden-path` → **EXIT=0**, every layer reached for both kits (`scaffold, install, mcp, dev, driving, test, driving, build, assert`) with `TN_GOLDEN_PATH_FAILED` absent. That is the lane CI's `golden-path-template` job runs for these two kits; starter and platformer are the two kits `pnpm test:templates` excludes because that job already boots them (`ALREADY_BOOTED_TEMPLATES`). The same command **unfiltered** (`TN_GOLDEN_PATH_SCENARIOS` unset, so each project's own `pnpm test` — eslint included — runs) found a real defect that CI's lane cannot see: eleven kits shipped an orphaned `import type { QualityTier }` after Phase 1 deleted its last reader, and a freshly scaffolded `action-rpg` failed `pnpm test` on `@typescript-eslint/no-unused-vars`. Fixed here, re-pinned, and proven green in a scaffolded project (`pnpm exec eslint src` → 0 errors, 4 pre-existing warnings).
- [x] AC-2 [local]: The visual judge returns NEUTRAL or better on starter, racing and snow, same pose before and after. proof: judge verdict recorded on this box. Judge 2026-11-08 (fresh read-only Opus subagent, `judge-632`): BEFORE `b48c653c1` (origin/develop) vs AFTER `5bd45931a` (this PR), headed WebGPU on NVIDIA turing (RTX 2080) for all 44 images, 2 runs per arm, BEFORE/AFTER burned in; images and `manifest.md` in `~/Downloads/pr632-visual-judge/`. Criteria set before judging: no visible change in exposure, colour, sky and environment light, shadows, LOD and geometry presence, fog or sharpness beyond the same-arm run-to-run noise. Verdict: **NEUTRAL, PASS** — starter (noise RMSE 0.0006-0.0012, cross-arm 0.0007-0.0010, mean luminance 0.5785-0.5787 in all four runs), racing (cross-arm 0.0002-0.0006, below the noise), snow (cross-arm 0.0002-0.0016 inside the 0.0011-0.0016 noise); sky, exposure, shadows, fog, distant trees and characters match.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Environment measure and sample | Kit `src/render/` imports the core subpath | 60 template copies deleted; the backlight stays kit source, restamped | Phase 1 |
| Shared build plumbing | `npm create threenative` → `createProject` | Per-kit copies deleted | Phase 2 |

## Execution Phases

#### Phase 1: Mechanism into core
**Status:** DONE
**Files:** new `packages/core/src/render/environment/*.ts` and subpath export; edit `templates/*/src/render/` callers; delete the copies of the five moved files (60), and list the backlight in `SHARED_RENDER_SOURCES` instead of moving it.

- [x] The core subpath `@threenative/core/render/environment` owns five of the seven files plus the admission gate they needed; the backlight (`backlightMaterial`, `backlightControls`) returned to each kit's `src/render/` under `SHARED_RENDER_SOURCES`, because its shader constants decide how a surface looks; every kit imports it, and the 60 environment copies are deleted (the 24 backlight copies stay (12 kits × 2 files), restamped from one source). The one cross-boundary import (`environmentSampling.ts` reading the kit's `quality.ts` for the gate) was inverted by moving the gate into the same subpath, so no parameter object was needed — the tier it compares is still the caller's. Wiring: tsup entry, `exports`, root `tsconfig` path. The kit-side proof is that a real build resolves it: `scaffold.spec.ts`'s recast case builds a scaffolded minimal kit with the new import. proof: `rg -n 'function .*[Ww]ebgl[A-Za-z]*Fallback' packages/create-threenative/templates` returns nothing; `pnpm --filter create-threenative exec vitest run __tests__/backlight-shared-graph.spec.ts __tests__/backlight-render-matrices.spec.ts __tests__/backlight-material-lifecycle.spec.ts __tests__/minimal-material-lighting.spec.ts __tests__/sailing-snow-material-lighting.spec.ts` → 39 passed; `npx vitest run packages/create-threenative/__tests__ scripts/__tests__/check-core-boundary.spec.ts` → 2056 passed, and `pnpm typecheck` → 0.
- [x] One core WebGL-fallback predicate; no `quality.ts` defines its own. Each kit's `quality.ts` is now a three-line re-export of `IMaterialLightingEnvironment`, `isWebGLFallbackRenderer` and `materialLightingEnabled` from the subpath, and the starter's `rendererGate.ts` is deleted. The charter and portability checks were extended deliberately, not bypassed: `constraints.spec.ts` admits `render/environment/**` with a tighter assertion that the block originates no material, light, colour or shader (only the sampling quad's own material and the node twin of the *game's* material, and tone mapping only as the readback's save/restore), and `check-core-boundary.ts` admits the mechanism names with the same proof. proof: the `rg` above returns nothing; `npx vitest run packages/core/__tests__/constraints.spec.ts` → 4 passed.

#### Phase 2: One source for shared plumbing
**Status:** DONE
**Files:** `packages/create-threenative/src/index.ts`, `template-assets/`, `templates/*/kit.json`, `packages/create-threenative/package.json`.

The three files are one claim each, because each has its own delta and its own risk (a broken `tsconfig.json` breaks typecheck everywhere; a broken `vite.config.ts` breaks every build; `main.ts` is the entry):

- [x] `tsconfig.json` is generated from one source plus the kit's delta. `packages/create-threenative/src/plumbing.ts` owns the text, and the delta is **derived**: a kit ships `jsx` and the `.tsx` glob when its own `package.json` depends on React (`minimal` is the one that does not), so gaining React is a manifest edit with no second list to remember. `pnpm stamp:template-plumbing` writes all sixteen and `--check` fails on a hand edit. One normalisation: a `tests` glob is now in every kit even where no `tests/` directory exists — eight kits carried a variant without it for no recorded reason, and a glob matching nothing costs nothing. That is the eight kits whose pinned hash moved. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 3 passed (and red, naming `snow`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 83 passed.
- [x] `vite.config.ts` is generated from one source plus the kit's delta, and every delta is **derived** from the kit: React and Tailwind by whether its manifest depends on them, the second entry by whether it ships `main.html`. Every kit reproduces its bytes, with one normalisation: `rain`, `sailing` and `snow` were missing the doc comment above `assetsWatchPlugin` — drift, not intent — so the restamp adds four comment lines to those three, and nothing else moved. The generator wraps its plugin array at the same width `biome.json` formats to, so `stamp --check` and `biome format` cannot disagree. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 5 passed (red, naming `kart`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 85 passed.
- [x] `src/main.ts` is generated from one source plus the kit's delta, and every kit reproduces its bytes. Two variants, chosen by the same derived React delta: the React entry mounts the game's `App` through `#root` and keeps the root across hot updates, the plain one mounts the canvas and turns a failed start into a labelled failure element. `adventure` is the one genuine per-kit statement (its entry also binds Tab so the browser cannot move focus off the canvas), so it declares `scaffold.mainHandWritten` in its own `kit.json` with that reason and the restamp leaves it alone. `collectathon` differed from the React variant by one blank line — drift — so its file gains that line and nothing else. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 6 passed (red, naming `kart`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 80 passed.

- [x] The patch filename lives in one manifest that `prepack` reads: `template-assets/patches/manifest.json` names each patch with its repository source, `packages/create-threenative/scripts/sync-patches.mjs` (run by `prepack` and `pnpm sync:patches`) copies exactly those into the tarball, `copyFrameworkPatches` resolves a kit's `patchedDependencies` through it, and `__tests__/framework-patches.spec.ts` holds every kit to it (shown red by dropping an entry: both the kit check and the shipped-set check fail, naming each kit). proof: `rg -c 'three@0\.' packages/create-threenative/src packages/create-threenative/package.json` returns nothing, and `pnpm --filter create-threenative pack` lists `package/template-assets/patches/{manifest.json,three@0.187.0.patch,vite@8.2.0.patch,@tailwindcss__node@4.3.3.patch}` in the tarball. The manifest is **tracked**: the ignore rule covered the whole directory, so a clean checkout had no list and `prepack` died at `ENOENT … template-assets/patches/manifest.json` in the merge's first CI run — the copies are output, the list is source, and the rule now negates just the one file.

#### Phase 3: Scaffold pins split
**Status:** DONE
**Files:** `packages/create-threenative/__tests__/scaffold.spec.ts`, new `scripts/scaffold-pin.ts`, root `package.json`.

- [x] Each kit carries a `shared` and a `kit` hash, and `pnpm scaffold:pin` rewrites them and names which bucket moved. `__tests__/scaffold-tree.ts` owns the classification (a file the kit's own template holds is the kit's; anything the scaffolder built from `agent-files`, `template-assets`, core's tables or the shared render sources is shared, plus the generated `AGENTS.md`/`CLAUDE.md` routers). Proof of the split, run here: appending a line to `agent-files/.agents/skills/file-engine-bug/SKILL.md` makes `pnpm scaffold:pin --check` report `stale <kit>: shared` for all sixteen kits and nothing else; restoring it reports `scaffold pins are current`. The box's example says `agent-docs/`, which ships nothing into a scaffold (PRD-449), so it cannot move a pin; `agent-files/` is the shipped shared input. The block also replaced ~600 lines of re-pin history. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 80 passed.
- [x] `STARTER_PATHS` (83 entries), `MINIMAL_RENDER_PATHS` and `PLATFORMER_PATHS` are deleted. What they asserted is covered: the two hashes catch a missing or changed file, the allowlist catches a new kind of file, and the two tests that used them keep their other claims (the minimal kit now asserts it ships a render layer at all, instead of a stale seven-name list the directory had outgrown). proof: the same spec run, and `rg -n 'STARTER_PATHS|MINIMAL_RENDER_PATHS|PLATFORMER_PATHS' packages/create-threenative` returns nothing.
