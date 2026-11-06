---
prd_contract: v1
---

# PRD-780 — Spells made of volumes and swarms

**Status:** NOT STARTED
**Priority:** P2 — Every box is open: 7 of the 39 spells the owner asked to absorb need raymarched volumes and GPU swarms, and Fireball and Inferno still wait for their volume upgrade.
**Complexity:** 7 (HIGH) — 11+ implementation files (+3), new mechanisms (+2), GPU state across frames (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-777](../done/PRD-777-a-spell-is-a-timeline-that-changes-the-world-it-lands-in.md); [PRD-778](PRD-778-spells-that-arc-trail-and-draw-sigils.md) for the sigils in Black Flame.

## Context

Fourth wave of the Ultra Elements absorption. PRD-777 holds the contract, the pinned upstream commit and the epic table. Upstream: `src/vfx/Volumes.js` (raymarched proxies, so the camera can sit inside), `src/vfx/FluidVolume.js` (combustion solver in a 2D atlas), and the swarm systems in `src/spells/acid/plague-swarm.js` and `src/spells/fire/ember-swarm.js`.

**Spells (7):** Judgment, Radiant Lance, Dust Devils, Black Flame, Corrosion Cloud, Plague Swarm, Ember Swarm. **Upgrades (2):** Fireball, Inferno.

## Solution

Each spell is a `create<Spell>(world, overrides?)` factory on `@threenative/core/spells`.

- **Hero volumes:** back-face proxies with a bounded TSL march. Upstream caps a volume at 12 to 32 steps. A quality tier sets the step count.
- **Combustion solver:** port it only if a hero volume with noise fails the judge on Fireball.
- **Swarms:** agents in a compute kernel through `IComputeDriven`, drawn on the kind table.
- **Heat haze:** needs the scene colour. Prove it on the native host before a spell defaults to it.
- [PRD-664](../Unreal/vfx/PRD-664-smoke-and-explosions-are-lit-volumes-not-flat-sprites.md) ports lit smoke from Unreal. Read its Phase 1 gate first and share any march code.

**Risk:** ⚠️ a TSL march loop through the owned engine's shader IR is unverified. Phase 1 proves it on web and native before any spell uses it.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| 7 spell factories, 2 upgrades | `examples/spell-lab` cast by name (fill `file:line`) | Appends to the lab. The Fireball and Inferno shells become the low tier. | Phase 2 and 3 boxes |

## Execution Phases

#### Phase 1: A bounded volume march runs on both runtimes

**Status:** NOT STARTED
**Files:** `packages/core/src/spells/volumes.ts`, `swarm.ts` (new), one conformance row in `packages/runtime-native/conformance/registry.json`.

- [ ] A hero volume renders within tolerance on web and native. proof: `pnpm parity`, new spell volume case
- [ ] A swarm kernel keeps its agents alive across frames with no CPU readback. proof: `pnpm exec vitest run packages/core/__tests__/spell-mechanisms.spec.ts`

#### Phase 2: The seven spells land, and two upgrade

**Status:** NOT STARTED
**Files:** 7 spell factories, `fireball.ts`, `inferno.ts`, `examples/spell-lab/`, `scripts/fixtures/capability-recall/corpus.json`.

- [ ] Judgment, Radiant Lance, Dust Devils and Black Flame each cast and change the pixels at the target. proof: `spell-lab.playtest.json --browser-recipe webgpu`, per-spell steps
- [ ] Corrosion Cloud, Plague Swarm and Ember Swarm each cast and change the pixels at the target. proof: same scenario, per-spell steps

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`, spell default values only.

- [ ] All seven spells cast on the desktop host. proof: `spell-lab.playtest.json --target desktop`
- [ ] Each volume spell at its worst pose stays inside the lab's frame budget. proof: `TN_FRAME_BUDGET` presented p95 and worst frame
- [ ] A visual judge returns IMPROVEMENT for the Fireball and Inferno upgrades and passes the seven new spells, against upstream `?shot=` reference frames. proof: sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: `engine_search_capabilities` returns the matching factory for each of the seven spell names. proof: `pnpm caps:recall` — Evidence: pending.
