---
prd_contract: v1
---

# PRD-781 — Spells made of liquid and bent space

**Status:** NOT STARTED
**Priority:** P2 — Every box is open: the last 8 of the 39 spells the owner asked to absorb need fluid, metaballs, lensing and a portal view, and the 39-of-39 capability gate waits on them.
**Complexity:** 7 (HIGH) — 11+ implementation files (+3), new mechanisms (+2), GPU state across frames (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-777](PRD-777-a-spell-is-a-timeline-that-changes-the-world-it-lands-in.md); [PRD-778](PRD-778-spells-that-arc-trail-and-draw-sigils.md), [PRD-779](PRD-779-spells-that-erupt-solid-from-the-ground.md) and [PRD-780](PRD-780-spells-made-of-volumes-and-swarms.md) for the 39-of-39 gate only.

## Context

Last wave of the Ultra Elements absorption. PRD-777 holds the contract, the pinned upstream commit and the epic table. Upstream: `src/vfx/ParticleFluid.js` (FLIP in local boxes), `src/vfx/Metaballs.js`, `src/vfx/Lens.js` (thin-lens point mass), `src/spells/void/portal.js` (mirrored camera), `src/spells/water/tsunami.js`.

**Spells (8):** Tidal Lance, Geyser, Tsunami, Toxic Bloom, Singularity, Rift, Portal, Supernova.

## Solution

Each spell is a `create<Spell>(world, overrides?)` factory on `@threenative/core/spells`.

- **Fluid:** `packages/core/src/fluid-particles.ts` already ships. Build on it, and do not port upstream FLIP unless a spell fails on it.
- **Metaballs:** a bounded TSL march, sharing the PRD-780 march.
- **Lens:** screen-space distortion of the scene colour. `viewportSharedTexture` appears only in `packages/three-native/src/browser-tsl.ts`, and no kit uses it, so Phase 1 proves it on native.
- **Portal view:** check the engine's reflection capture before a second camera pass.

**Risk:** ⚠️ if the scene colour read has no native path, the lens spells cannot pass on desktop. That is an engine gap to fix in this PRD, not a reason to ship them web-only.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| 8 spell factories | `examples/spell-lab` cast by name (fill `file:line`) | Appends to the lab | Phase 2 and 3 boxes |

## Execution Phases

#### Phase 1: Scene colour distortion and the portal view run on both runtimes

**Status:** NOT STARTED
**Files:** `packages/core/src/spells/lens.ts`, `metaballs.ts`, `portal-view.ts` (new), conformance rows in `packages/runtime-native/conformance/registry.json`.

- [ ] A lens distorts the scene colour within tolerance on web and native. proof: `pnpm parity`, new spell lens case
- [ ] A portal shows a second view of the scene within tolerance on web and native. proof: `pnpm parity`, new spell portal case

#### Phase 2: The eight spells land

**Status:** NOT STARTED
**Files:** 8 spell factories under `packages/core/src/spells/`, `examples/spell-lab/`, `scripts/fixtures/capability-recall/corpus.json`.

- [ ] Tidal Lance, Geyser, Tsunami and Toxic Bloom each cast and change the pixels at the target. proof: `spell-lab.playtest.json --browser-recipe webgpu`, per-spell steps
- [ ] Singularity, Rift, Portal and Supernova each cast and change the pixels at the target. proof: same scenario, per-spell steps

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`, spell default values only.

- [ ] All eight spells cast on the desktop host. proof: `spell-lab.playtest.json --target desktop`
- [ ] Each fluid and lens spell at its worst pose stays inside the lab's frame budget. proof: `TN_FRAME_BUDGET` presented p95 and worst frame
- [ ] A visual judge passes all eight for silhouette, four-beat timeline and world response, against upstream `?shot=` reference frames. proof: sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: The manifest lists all 39 spell factories under `@threenative/core/spells`, and a search for each spell name returns its factory. proof: `pnpm caps:recall` — Evidence: pending.
- [ ] AC-2 [local]: A cold agent in a sandbox, asked for an RPG with a fireball, a tsunami and a portal, imports the factories and writes no particle kernel or shader. proof: `pnpm sandbox`, then a cold build — Evidence: pending.
