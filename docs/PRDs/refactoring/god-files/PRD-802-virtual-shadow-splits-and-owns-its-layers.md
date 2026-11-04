# PRD-802 — `virtual-shadow.ts` splits, and owns its layer numbers

**Status:** NOT STARTED
**Priority:** P2 — `world-cell-render.ts` repeats two shadow layer numbers by hand, so a layer change breaks world casters without an error; `VirtualShadowNode` is 2 635 lines (all phases open).
**Complexity:** 5 (MEDIUM); risk override: shadows reach the screen, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** None (PRD-798 imports the layer exports this PRD creates)
**Batch:** [God files](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/core/src/render/virtual-shadow.ts` is 3 807 lines: options and stats types (99–435), layer and tuning constants with `clipLadder` (435–590), caster and level helpers (593–1 012), `VirtualShadowNode` (1 013–3 647: constructor, caster tracking 1 505–1 970, `#probe`, adaptive gate 2 504–2 670, `#init`, `#updateFrame` about 480 lines), marker parsers (3 648–3 807).
- `packages/core/src/world-cell-render.ts:176` and `:186` hold the layer numbers 26 and 25 as literals.
- `packages/core/__tests__/constraints.spec.ts` (about lines 177–182) exempts files by name from the visual-concern scan; each new `render/virtual-shadow-*.ts` file needs a line there.
- Pinned by `virtual-shadow.spec.ts` (4 277 lines), `-caster-draws`, `-caster-faces`, `-bundle-nesting`, `-pages`, `-partial`, and world shadow specs. Thin or unpinned: the layer and marker constants (one spec each), the adaptive `gateScale` trace, `shadowRedrawGpuMs`, the stats-query cadence.

## Solution

Pin, then extract: `virtual-shadow-layers.ts` (layer constants and `clipLadder`, imported by
`world-cell-render.ts` in place of its literals), `virtual-shadow-markers.ts`,
`virtual-shadow-options.ts`, `virtual-shadow-casters.ts`, `virtual-shadow-adaptive.ts`.
`virtual-shadow.ts` keeps the class and re-exports the moved symbols; `index.ts` is unchanged.

## Acceptance Criteria

- [ ] AC-1 [local]: The shadow layer numbers have one owner, and `world-cell-render.ts` imports them. proof: `rg -n '\b2[56]\b' packages/core/src/world-cell-render.ts` shows no layer literal, plus `virtual-shadow-layers.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: `virtual-shadow.ts` is under 2 000 lines, no new file exceeds 1 000, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/core/__tests__/` — Evidence: pending.
- [ ] AC-3 [local]: Shadow and world specs, `constraints.spec.ts` and `build.spec.ts` stay green. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow*.spec.ts packages/core/__tests__/world-*shadow*.spec.ts packages/core/__tests__/constraints.spec.ts packages/core/__tests__/build.spec.ts` — Evidence: pending.
- [ ] AC-4 [local]: Shadows keep their look. proof: Strata forest and the shooter template, same pose before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Shadow layer numbers | `Daylight` → `VirtualShadowNode`; `CellRender` caster layers | Literals at `world-cell-render.ts:176,186`: deleted | AC-1 |

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/virtual-shadow-layers.spec.ts` (new), `virtual-shadow.spec.ts` (new cases only)
- [ ] A spec asserts `world-cell-render.ts`'s literals equal the exported layers. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow-layers.spec.ts`
- [ ] A numeric trace of `gateScale` over over-budget frames is pinned. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`

#### Phase 2: one owner for layers
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow-layers.ts` (new), `virtual-shadow.ts`, `world-cell-render.ts`, `constraints.spec.ts`
- [ ] Layers extracted and imported by `world-cell-render.ts`. proof: AC-1

#### Phase 3: extract the rest
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow-{markers,options,casters,adaptive}.ts` (new), `virtual-shadow.ts`, `constraints.spec.ts`
- [ ] Four modules extracted. proof: AC-2 and AC-3
- [ ] Fresh visual judge passes. proof: AC-4
