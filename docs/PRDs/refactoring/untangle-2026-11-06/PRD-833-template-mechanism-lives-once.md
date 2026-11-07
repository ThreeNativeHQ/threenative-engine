# PRD-833 — Template mechanism lives once

**Status:** PARTIAL — Phases 1 and 3 landed, Phase 2 box 2 (the patch manifest) landed; Phase 2 box 1 (one source for `vite.config.ts`/`main.ts`/`tsconfig.json`) and AC-2 (the visual judge on starter, racing and snow) are open.
**Priority:** P1 — all phases landed; what is open is verification: AC-1 and AC-2 run on the PR, so the tier rates that run rather than a copy count.
**Complexity:** 6 (MEDIUM); risk override: the moved files measure the environment and wire the backlight, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** PRD-832 (its Phase 1 drift spec guards the copies until this PRD deletes them)
**Batch:** [Untangle report, 2026-11-06](README.md) — R1

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
   `kit.json` names the extra Vite plugins. One `template-assets/patches/manifest.json` feeds
   `copyFrameworkPatches`, `prepack` and the catalog script.
3. `scaffold.spec.ts` keeps two hashes per kit, `shared` and `kit`. `pnpm scaffold:pin` rewrites them
   and names the moved input. `STARTER_PATHS` and its siblings are deleted, and the allowlist owns names.

## Acceptance Criteria

- [ ] AC-1 [local]: A freshly scaffolded starter builds and passes its golden playtest. proof: `pnpm test:templates` (starter and platformer)
- [ ] AC-2 [local]: The visual judge returns NEUTRAL or better on starter, racing and snow, same pose before and after. proof: judge verdict recorded on this box

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Environment measure and backlight | Kit `src/render/` imports the core subpath | 84 template copies deleted | Phase 1 |
| Shared build plumbing | `npm create threenative` → `createProject` | Per-kit copies deleted | Phase 2 |

## Execution Phases

#### Phase 1: Mechanism into core
**Status:** DONE
**Files:** new `packages/core/src/render/environment/*.ts` and subpath export; edit `templates/*/src/render/` callers; delete the 84 copies.

- [x] The core subpath `@threenative/core/render/environment` owns five of the seven files plus the admission gate they needed; the backlight (`backlightMaterial`, `backlightControls`) returned to each kit's `src/render/` under `SHARED_RENDER_SOURCES`, because its shader constants decide how a surface looks; every kit imports it, and all 84 copies are deleted. The one cross-boundary import (`environmentSampling.ts` reading the kit's `quality.ts` for the gate) was inverted by moving the gate into the same subpath, so no parameter object was needed — the tier it compares is still the caller's. Wiring: tsup entry, `exports`, root `tsconfig` path. The kit-side proof is that a real build resolves it: `scaffold.spec.ts`'s recast case builds a scaffolded minimal kit with the new import. proof: `rg -n 'function .*[Ww]ebgl[A-Za-z]*Fallback' packages/create-threenative/templates` returns nothing; `pnpm --filter create-threenative exec vitest run __tests__/backlight-shared-graph.spec.ts __tests__/backlight-render-matrices.spec.ts __tests__/backlight-material-lifecycle.spec.ts __tests__/minimal-material-lighting.spec.ts __tests__/sailing-snow-material-lighting.spec.ts` → 39 passed; `npx vitest run packages/core/__tests__ packages/create-threenative/__tests__` → 7123 passed, 4 skipped, and `pnpm typecheck` → 0.
- [x] One core WebGL-fallback predicate; no `quality.ts` defines its own. Each kit's `quality.ts` is now a three-line re-export of `IMaterialLightingEnvironment`, `isWebGLFallbackRenderer` and `materialLightingEnabled` from the subpath, and the starter's `rendererGate.ts` is deleted. The charter and portability checks were extended deliberately, not bypassed: `constraints.spec.ts` admits `render/environment/**` with a tighter assertion that the block originates no material, light, colour or shader (only the sampling quad's own material and the node twin of the *game's* material, and tone mapping only as the readback's save/restore), and `check-core-boundary.ts` admits the mechanism names with the same proof. proof: the `rg` above returns nothing; `npx vitest run packages/core/__tests__/constraints.spec.ts` → 4 passed.

#### Phase 2: One source for shared plumbing
**Status:** PARTIAL — the patch manifest landed; the build-plumbing restamp is open
**Files:** `packages/create-threenative/src/index.ts`, `template-assets/`, `templates/*/kit.json`, `packages/create-threenative/package.json`.

The three files are one claim each, because each has its own delta and its own risk (a broken `tsconfig.json` breaks typecheck everywhere; a broken `vite.config.ts` breaks every build; `main.ts` is the entry):

- [x] `tsconfig.json` is generated from one source plus the kit's delta. `packages/create-threenative/src/plumbing.ts` owns the text, and the delta is **derived**: a kit ships `jsx` and the `.tsx` glob when its own `package.json` depends on React (`minimal` is the one that does not), so gaining React is a manifest edit with no second list to remember. `pnpm stamp:template-plumbing` writes all sixteen and `--check` fails on a hand edit. One normalisation: a `tests` glob is now in every kit even where no `tests/` directory exists — eight kits carried a variant without it for no recorded reason, and a glob matching nothing costs nothing. That is the eight kits whose pinned hash moved. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 3 passed (and red, naming `snow`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 83 passed.
- [x] `vite.config.ts` is generated from one source plus the kit's delta, and every delta is **derived** from the kit: React and Tailwind by whether its manifest depends on them, the second entry by whether it ships `main.html`. Every kit reproduces its bytes, with one normalisation: `rain`, `sailing` and `snow` were missing the doc comment above `assetsWatchPlugin` — drift, not intent — so the restamp adds four comment lines to those three, and nothing else moved. The generator wraps its plugin array at the same width `biome.json` formats to, so `stamp --check` and `biome format` cannot disagree. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 5 passed (red, naming `kart`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 85 passed.
- [x] `src/main.ts` is generated from one source plus the kit's delta, and every kit reproduces its bytes. Two variants, chosen by the same derived React delta: the React entry mounts the game's `App` through `#root` and keeps the root across hot updates, the plain one mounts the canvas and turns a failed start into a labelled failure element. `adventure` is the one genuine per-kit statement (its entry also binds Tab so the browser cannot move focus off the canvas), so it declares `scaffold.mainHandWritten` in its own `kit.json` with that reason and the restamp leaves it alone. `collectathon` differed from the React variant by one blank line — drift — so its file gains that line and nothing else. proof: `npx vitest run packages/create-threenative/__tests__/plumbing-restamp.spec.ts` → 6 passed (red, naming `kart`, when one file was edited by hand); `pnpm stamp:template-plumbing --check` → current; `npx vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 80 passed.

#### Phase 3: Scaffold pins split
**Status:** DONE
**Files:** `packages/create-threenative/__tests__/scaffold.spec.ts`, new `scripts/scaffold-pin.ts`, root `package.json`.

- [x] Each kit carries a `shared` and a `kit` hash, and `pnpm scaffold:pin` rewrites them and names which bucket moved. `__tests__/scaffold-tree.ts` owns the classification (a file the kit's own template holds is the kit's; anything the scaffolder built from `agent-files`, `template-assets`, core's tables or the shared render sources is shared, plus the generated `AGENTS.md`/`CLAUDE.md` routers). Proof of the split, run here: appending a line to `agent-files/.agents/skills/file-engine-bug/SKILL.md` makes `pnpm scaffold:pin --check` report `stale <kit>: shared` for all sixteen kits and nothing else; restoring it reports `scaffold pins are current`. The box's example says `agent-docs/`, which ships nothing into a scaffold (PRD-449), so it cannot move a pin; `agent-files/` is the shipped shared input. The block also replaced ~600 lines of re-pin history. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 80 passed.
- [x] `STARTER_PATHS` (83 entries), `MINIMAL_RENDER_PATHS` and `PLATFORMER_PATHS` are deleted. What they asserted is covered: the two hashes catch a missing or changed file, the allowlist catches a new kind of file, and the two tests that used them keep their other claims (the minimal kit now asserts it ships a render layer at all, instead of a stale seven-name list the directory had outgrown). proof: the same spec run, and `rg -n 'STARTER_PATHS|MINIMAL_RENDER_PATHS|PLATFORMER_PATHS' packages/create-threenative` returns nothing.
