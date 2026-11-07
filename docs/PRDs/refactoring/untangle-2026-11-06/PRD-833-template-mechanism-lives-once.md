# PRD-833 — Template mechanism lives once

**Status:** PARTIAL — Phases 1 and 3 landed, Phase 2 box 2 (the patch manifest) landed; Phase 2 box 1 (one source for `vite.config.ts`/`main.ts`/`tsconfig.json`) and AC-2 (the visual judge on starter, racing and snow) are open.
**Priority:** P1 — open Phase 2 deletes 84 template copies of 7 render-mechanism files, where a fix to one kit leaves 11 kits wrong with every test green.
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

- [x] The core subpath `@threenative/core/render/environment` owns the 7 files, plus the admission gate they needed; every kit imports it, and all 84 copies are deleted. The one cross-boundary import (`environmentSampling.ts` reading the kit's `quality.ts` for the gate) was inverted by moving the gate into the same subpath, so no parameter object was needed — the tier it compares is still the caller's. Wiring: tsup entry, `exports`, root `tsconfig` path. The kit-side proof is that a real build resolves it: `scaffold.spec.ts`'s recast case builds a scaffolded minimal kit with the new import. proof: `rg -n 'function .*[Ww]ebgl[A-Za-z]*Fallback' packages/create-threenative/templates` returns nothing; `pnpm --filter create-threenative exec vitest run __tests__/backlight-shared-graph.spec.ts __tests__/backlight-render-matrices.spec.ts __tests__/backlight-material-lifecycle.spec.ts __tests__/minimal-material-lighting.spec.ts __tests__/sailing-snow-material-lighting.spec.ts` → 39 passed; `npx vitest run packages/core/__tests__ packages/create-threenative/__tests__` → 7123 passed, 4 skipped, and `pnpm typecheck` → 0.
- [x] One core WebGL-fallback predicate; no `quality.ts` defines its own. Each kit's `quality.ts` is now a three-line re-export of `IMaterialLightingEnvironment`, `isWebGLFallbackRenderer` and `materialLightingEnabled` from the subpath, and the starter's `rendererGate.ts` is deleted. The charter and portability checks were extended deliberately, not bypassed: `constraints.spec.ts` admits `render/environment/**` with a tighter assertion that the block originates no material, light, colour or shader (only the sampling quad's own material and the node twin of the *game's* material, and tone mapping only as the readback's save/restore), and `check-core-boundary.ts` admits the mechanism names with the same proof. proof: the `rg` above returns nothing; `npx vitest run packages/core/__tests__/constraints.spec.ts` → 4 passed.

#### Phase 2: One source for shared plumbing
**Status:** PARTIAL — the patch manifest landed; the build-plumbing restamp is open
**Files:** `packages/create-threenative/src/index.ts`, `template-assets/`, `templates/*/kit.json`, `packages/create-threenative/package.json`.

- [ ] `vite.config.ts`, `main.ts` and `tsconfig.json` are restamped from one source with a per-kit plugin delta, and each kit reproduces today's bytes. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts`

  Measured deltas, so the next attempt starts from data rather than a survey (16 kits; `md5sum templates/*/{vite.config.ts,tsconfig.json,src/main.ts}`):

  | File | Variants | The delta, exactly |
  | --- | --- | --- |
  | `vite.config.ts` | 10 / 3 / 2 / 1 | canonical carries five plugins; `minimal` drops `react()` and `tailwindcss()`; `starter` and `shooter` add `build: { rollupOptions: { input: { index: "index.html", main: "main.html" } } }`; `rain`, `sailing`, `snow` differ **only** by the missing doc comment above `assetsWatchPlugin` — drift, not intent, so a restamp changes three kits' bytes by a comment and nothing else (prove it by diffing with comments stripped). |
  | `tsconfig.json` | 8 / 7 / 1 | `adventure`, `collectathon`, `kart`, `platformer`, `puzzle`, `racing`, `runner`, `tower-defense` include `tests/**/*.ts`; `minimal` drops `jsx: react-jsx` and the `**/*.tsx` glob as well. |
  | `src/main.ts` | 11 / 3 / 1 / 1 | canonical mounts React through `#root`; `collectathon` differs by one blank line (drift); `minimal` has no React at all and mounts the canvas directly; `adventure` adds a Tab `keydown` preventer above the mount (the only genuine per-kit statement). |

  So the delta a `kit.json` must carry is four flags (`react`, `tailwind`/`plugins`, `tests` include, worker entry) plus one escape hatch for `adventure`'s extra statement — a single canonical file with a placeholder line the scaffolder resolves, failing closed when a placeholder survives.
- [x] The patch filename lives in one manifest that `prepack` reads: `template-assets/patches/manifest.json` names each patch with its repository source, `packages/create-threenative/scripts/sync-patches.mjs` (run by `prepack` and `pnpm sync:patches`) copies exactly those into the tarball, `copyFrameworkPatches` resolves a kit's `patchedDependencies` through it, and `__tests__/framework-patches.spec.ts` holds every kit to it (shown red by dropping an entry: both the kit check and the shipped-set check fail, naming each kit). proof: `rg -c 'three@0\.' packages/create-threenative/src packages/create-threenative/package.json` returns nothing, and `pnpm --filter create-threenative pack` lists `package/template-assets/patches/{manifest.json,three@0.187.0.patch,vite@8.2.0.patch,@tailwindcss__node@4.3.3.patch}` in the tarball.

#### Phase 3: Scaffold pins split
**Status:** DONE
**Files:** `packages/create-threenative/__tests__/scaffold.spec.ts`, new `scripts/scaffold-pin.ts`, root `package.json`.

- [x] Each kit carries a `shared` and a `kit` hash, and `pnpm scaffold:pin` rewrites them and names which bucket moved. `__tests__/scaffold-tree.ts` owns the classification (a file the kit's own template holds is the kit's; anything the scaffolder built from `agent-files`, `template-assets`, core's tables or the shared render sources is shared, plus the generated `AGENTS.md`/`CLAUDE.md` routers). Proof of the split, run here: appending a line to `agent-files/.agents/skills/file-engine-bug/SKILL.md` makes `pnpm scaffold:pin --check` report `stale <kit>: shared` for all sixteen kits and nothing else; restoring it reports `scaffold pins are current`. The box's example says `agent-docs/`, which ships nothing into a scaffold (PRD-449), so it cannot move a pin; `agent-files/` is the shipped shared input. The block also replaced ~600 lines of re-pin history. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts` → 80 passed.
- [x] `STARTER_PATHS` (83 entries), `MINIMAL_RENDER_PATHS` and `PLATFORMER_PATHS` are deleted. What they asserted is covered: the two hashes catch a missing or changed file, the allowlist catches a new kind of file, and the two tests that used them keep their other claims (the minimal kit now asserts it ships a render layer at all, instead of a stale seven-name list the directory had outgrown). proof: the same spec run, and `rg -n 'STARTER_PATHS|MINIMAL_RENDER_PATHS|PLATFORMER_PATHS' packages/create-threenative` returns nothing.
