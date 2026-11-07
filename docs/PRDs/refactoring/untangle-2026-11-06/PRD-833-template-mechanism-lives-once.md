# PRD-833 — Template mechanism lives once

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** new `packages/core/src/render/environment/*.ts` and subpath export; edit `templates/*/src/render/` callers; delete the 84 copies.

- [ ] The core subpath owns the 7 files, and every kit imports it. `md5sum templates/*/src/render/environment*.ts` finds no file. proof: `pnpm --filter @threenative/core exec vitest run __tests__/` for the moved units, plus `pnpm --filter create-threenative exec vitest run __tests__/backlight-shared-graph.spec.ts`
- [ ] One core WebGL-fallback predicate; no `quality.ts` defines its own. proof: `rg -n 'function .*[Ww]ebgl[A-Za-z]*Fallback' packages/create-threenative/templates` returns nothing

#### Phase 2: One source for shared plumbing
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/index.ts`, `template-assets/`, `templates/*/kit.json`, `packages/create-threenative/package.json`.

- [ ] `vite.config.ts`, `main.ts` and `tsconfig.json` are restamped from one source with a per-kit plugin delta, and each kit reproduces today's bytes. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts`
- [ ] The patch filename lives in one manifest that `prepack` reads. proof: `rg -c 'three@0\.' packages/create-threenative/src packages/create-threenative/package.json` drops to the manifest only, plus `pnpm --filter create-threenative pack` ships the patch

#### Phase 3: Scaffold pins split
**Status:** NOT STARTED
**Files:** `packages/create-threenative/__tests__/scaffold.spec.ts`, new `scripts/scaffold-pin.ts`, root `package.json`.

- [ ] Each kit carries a `shared` and a `kit` hash. An edit to `agent-docs/` changes only `shared`, and `pnpm scaffold:pin` rewrites it. proof: `pnpm --filter create-threenative exec vitest run __tests__/scaffold.spec.ts __tests__/scaffold-file-allowlist.spec.ts`
- [ ] `STARTER_PATHS` and the two sibling path lists are deleted, so the allowlist and per-directory counts are the only ship contract. proof: the same spec run
