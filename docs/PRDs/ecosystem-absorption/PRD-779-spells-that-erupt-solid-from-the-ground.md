---
prd_contract: v1
---

# PRD-779 — Spells that erupt solid from the ground

**Status:** NOT STARTED
**Priority:** P2 — Every box is open: 8 of the 39 spells the owner asked to absorb need erupting solids and lit debris that core does not have.
**Complexity:** 6 (MEDIUM) — 11+ implementation files (+3), new mechanisms (+2), a run-time cast state (+1). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-777](PRD-777-a-spell-is-a-timeline-that-changes-the-world-it-lands-in.md); [PRD-778](PRD-778-spells-that-arc-trail-and-draw-sigils.md) for the bolts in Frozen Lightning.

## Context

Third wave of the Ultra Elements absorption. PRD-777 holds the contract, the pinned upstream commit and the epic table. Upstream: `src/vfx/Spikes.js` (33 KB) and the debris style in `src/vfx/Particles.js`.

**Spells (8):** Ice Wall, Absolute Zero, Blizzard, Upheaval, Meteor, Fissure, Lava Geyser, Frozen Lightning.

## Solution

Each spell is a `create<Spell>(world, overrides?)` factory on `@threenative/core/spells`.

- **Spikes:** instanced erupting rock and ice that rise from `groundAt`. Upstream samples the opaque frame for ice refraction. Ship without refraction first, and add it only if the judge rejects a spell. The look is lit through the normal material path.
- **Debris:** instanced lit meshes on the kind table.
- **Fissure and Lava Geyser:** drive the crack and glow channels of `ReactionField`. The game's floor material reads them.
- **Blizzard:** run `engine_search_capabilities` first, because the snow kit already has a storm kernel in `src/render/weather.ts`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| 8 spell factories | `examples/spell-lab` cast by name (fill `file:line`) | Appends to the lab | Phase 2 and 3 boxes |

## Execution Phases

#### Phase 1: Spikes and debris rise from any floor

**Status:** NOT STARTED
**Files:** `packages/core/src/spells/spikes.ts`, `debris.ts` (new), `packages/core/__tests__/spell-mechanisms.spec.ts`.

- [ ] A spike set rises from `groundAt` on a sloped floor, not from a fixed arena height. proof: `pnpm exec vitest run packages/core/__tests__/spell-mechanisms.spec.ts`

#### Phase 2: The eight spells land

**Status:** NOT STARTED
**Files:** 8 spell factories under `packages/core/src/spells/`, `examples/spell-lab/`, `scripts/fixtures/capability-recall/corpus.json`.

- [ ] Ice Wall, Absolute Zero, Blizzard and Frozen Lightning each cast and change the pixels at the target. proof: `spell-lab.playtest.json --browser-recipe webgpu`, per-spell steps
- [ ] Upheaval, Meteor, Fissure and Lava Geyser each cast and change the pixels at the target. proof: same scenario, per-spell steps

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`, spell default values only.

- [ ] All eight spells cast on the desktop host. proof: `spell-lab.playtest.json --target desktop`
- [ ] Casting all eight in sequence from a cold start stays inside the lab's frame budget. proof: `TN_FRAME_BUDGET` presented p95 and worst frame
- [ ] A visual judge passes all eight for silhouette, four-beat timeline and world response, against upstream `?shot=` reference frames. proof: sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: `engine_search_capabilities` returns the matching factory for each of the eight spell names. proof: `pnpm caps:recall` — Evidence: pending.
