---
prd_contract: v1
---

# PRD-778 — Spells that arc, trail and draw sigils

**Status:** NOT STARTED
**Priority:** P2 — Every box is open: 10 of the 39 spells the owner asked to absorb need bolts, analytic ribbons and sigils that core does not have.
**Complexity:** 6 (MEDIUM) — 11+ implementation files (+3), new mechanisms (+2), a run-time cast state (+1). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-777](../done/PRD-777-a-spell-is-a-timeline-that-changes-the-world-it-lands-in.md)

## Context

Second wave of the Ultra Elements absorption. PRD-777 holds the contract, the pinned upstream commit and the epic table. Upstream: `src/vfx/Bolts.js` (420 lines), `src/vfx/Ribbons.js` (417), `src/vfx/Sigils.js` (351).

**Spells (10):** Chain Arc, Ball Lightning, Thunderstorm, Starfall, Solar Flare, Aurora Veil, Wind Slash, Cyclone, Fire Tornado, Phoenix.

## Solution

Each spell is a `create<Spell>(world, overrides?)` factory on `@threenative/core/spells`. Each mechanism takes its appearance from the caller.

- **Bolts:** per-vertex evaluation from a few per-instance numbers. Compare with the bolt in rain's `src/render/lightning.ts` first, and reuse its camera-facing ribbon.
- **Analytic ribbons and trails:** run `engine_search_capabilities` first, and share the mechanism with [PRD-705](../Unreal/vfx/PRD-705-a-sword-swing-leaves-one-connected-trail-not-a-cloud-of-dashes.md). Defaults follow Niagara: tessellation factor 16 and angle 15 (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRibbonRendererProperties.cpp:79-80`).
- **Sigils:** SDF circles in TSL on a pooled quad.
- **Thunderstorm:** upstream uses post access for the flash, so route it through the `SpellWorld` flash limiter.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| 10 spell factories | `examples/spell-lab` cast by name (fill `file:line`) | Appends to the lab | Phase 2 and 3 boxes |

## Execution Phases

#### Phase 1: Bolts, ribbons and sigils draw with no spell attached

**Status:** NOT STARTED
**Files:** `packages/core/src/spells/bolts.ts`, `ribbons.ts`, `sigils.ts` (new), `packages/core/__tests__/spell-mechanisms.spec.ts`.
**Implementation:** Port the algorithms to TSL. Each pool allocates once, and a seed reproduces a bolt.

- [ ] A bolt, a ribbon and a sigil each reuse a pooled slot with no allocation per acquire. proof: `pnpm exec vitest run packages/core/__tests__/spell-mechanisms.spec.ts`

#### Phase 2: The ten spells land

**Status:** NOT STARTED
**Files:** 10 spell factories under `packages/core/src/spells/`, `examples/spell-lab/`, `scripts/fixtures/capability-recall/corpus.json`.
**Implementation:** Port the timelines. Ship upstream presets as named override objects.

- [ ] Chain Arc, Ball Lightning and Thunderstorm each cast and change the pixels at the target. proof: `spell-lab.playtest.json --browser-recipe webgpu`, per-spell steps
- [ ] Starfall, Solar Flare and Aurora Veil each cast and change the pixels at the target. proof: same scenario, per-spell steps
- [ ] Wind Slash, Cyclone, Fire Tornado and Phoenix each cast and change the pixels at the target. proof: same scenario, per-spell steps

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`, spell default values only.

- [ ] All ten spells cast on the desktop host. proof: `spell-lab.playtest.json --target desktop`
- [ ] Casting all ten in sequence from a cold start stays inside the lab's frame budget. proof: `TN_FRAME_BUDGET` presented p95 and worst frame
- [ ] A visual judge passes all ten for silhouette, four-beat timeline and world response, against upstream `?shot=` reference frames. proof: sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: `engine_search_capabilities` returns the matching factory for each of the ten spell names. proof: `pnpm caps:recall` — Evidence: pending.
