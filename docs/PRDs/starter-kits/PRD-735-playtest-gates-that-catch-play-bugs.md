---
prd_contract: v1
---

# PRD-735 — Playtest gates that catch the bugs a player finds in five minutes

**Status:** PARTIAL — Phase 1 harness boxes landed
**Priority:** P1 — every kit had green scenarios while the owner hit a crash, 30 fps, skating limbs, dead controls and a smeared image by hand (all phases open).
**Complexity:** 5 (MEDIUM) — `packages/playtest` schema, evaluators and capture (+3), kit scenario files (+1), template `AGENTS.md` rules (+1). Risk override: none.
**Owner:** João
**Depends on:** none. Sibling of [PRD-732](PRD-732-hop-garden-3d-platformer-starter-kit.md), [PRD-733](PRD-733-lantern-vale-3d-action-adventure-starter-kit.md) and [PRD-734](PRD-734-clover-cup-kart-racer-starter-kit.md); the gates ship in their PR (#563).

## Context

The owner played Hop Garden and Lantern Vale for five minutes on 2026-10-24 and wrote: "all of
this should have surfaced automatically during playtest...". Every kit scenario was green. He found:

1. A crash: `IPhysicsSimulation ray from vector must contain finite x, y, and z values` from the
   Hop Garden hero's airborne wall probe. A NaN reached the hero in a place no script visited.
2. 30 fps on a desktop RTX 2080, because every kit's performance scenario asserts
   `maxFrameMsP95: 33`, a 30 fps budget.
3. Limbs that swing faster than the character moves: the procedural run cycles run on elapsed time,
   not on ground speed. `AnimationPlayer` stride sync measures clips, not procedural rigs.
4. No mouse camera, a lock-on that does nothing from where a player stands, no visible way to learn
   the attack. The scenarios put the player beside a target and pressed keys a player would not know.
5. A blurred image and a featureless blurred ocean. Only a human saw it.

The harness already fails closed on page errors (`diagnostics.noConsoleErrors` reads `pageerror`),
classifies the adapter from `adapter.info` (`evaluators/adapter-class.ts`) and decodes every capture
(`capture.ts`). What it lacks is input a script did not choose, a budget the author did not pick, and
measurements of sharpness and limb slip.

Capability lookups run (2026-10-24): `engine_search_capabilities` for random input exploration,
foot sliding on procedural rigs, display-derived frame budgets and image sharpness. Hits:
`createRandom` (core; the playtest package may not depend on core, so the expansion carries its own
four-line mulberry32), `AnimationPlayer` stride (clips only), `decideDisplayStrategy`. No
exploration step, no sharpness metric and no procedural-rig slip measurement exist.

## Solution

- **`explore` step.** `{ "kind": "explore", "seed", "ticks", "move": [...], "actions": [...], "pointer"? }`
  expands at load into ordinary seeded `input` steps. It reuses every runner path, so it runs on every
  target that runs `input` steps. The default scenario that holds it asserts clean diagnostics and a
  finite, grounded subject.
- **Frame budget from the adapter.** A `performance` assertion without `maxFrameMsP95` gets the
  budget for the classified adapter: a 60 Hz frame (16.7 ms plus 20% vsync jitter, 20 ms) on a
  discrete or unnamed hardware GPU, 30 Hz (40 ms) on integrated and mobile families. A software or
  unclassified adapter reports the budget as not applied, with the reason. An explicit number is an
  override and the result says so.
- **Sharpness floor.** `visual.region.minSharpness`: variance of the Laplacian of luminance over the
  region of the final capture. A post stage that smears the frame drops it.
- **Limb slip.** Deferred to Phase 2 design once the cheaper gates land: a named-node planted-foot
  slip measurement that works for procedural rigs.
- **Controls from the spawn.** A default `controls` scenario per kit presses each control the HUD
  advertises from the spawn, plus pointer motion for the camera, and asserts each changes state.

## Execution Phases

### Phase 1 — crash and frame budget

- [x] `explore` step kind expands deterministically into input steps; wrong-typed fields throw at load. proof: `pnpm exec vitest run packages/playtest/__tests__/explore-step.spec.ts` — 10/10 green; full playtest suite 1782/1782.
- [x] A `performance` assertion without `maxFrameMsP95` applies the adapter-derived budget and reports its source. proof: `pnpm exec vitest run packages/playtest/__tests__/frame-budget.spec.ts` — 6/6 green; 30 fps (33.3 ms) on an RTX 2080 identity fails the derived 20 ms, held 60 fps passes, Intel UHD gets 40 ms, SwiftShader and no adapter report why no budget applied.
- [ ] Hop Garden at HEAD fails the `explore` scenario on the wall-probe crash. proof: playtest run against the Hop Garden consumer copy
- [ ] The three kits' performance scenarios drop the 33 ms constant for the derived budget. proof: playtest run of each kit's `performance.playtest.json`

### Phase 2 — image and limbs

- [x] `visual.region.minSharpness` fails a smeared frame and passes a sharp one. proof: `pnpm exec vitest run packages/playtest/__tests__/sharpness.spec.ts` — 5/5 green. Metric: Laplacian variance at full over half resolution. Kit frames 2026-10-24: in-focus 0.39-0.61 (Hop Garden spawn 0.49, Lantern Vale 0.59), smeared 0.21-0.24 (Hop Garden after free play 0.21, Lantern Vale SSR arm 0.22); floor 0.3.
- [ ] Limb slip measurement on named nodes fails a time-driven run cycle. proof: unit spec and a Lantern Vale run

### Phase 3 — controls

- [ ] Each kit ships a `controls` scenario from the spawn, with pointer camera motion; Lantern Vale at HEAD fails it. proof: playtest run against the Lantern Vale consumer copy
- [ ] The kits' `AGENTS.md` name the default gates and the rule that a new binding joins `explore` and `controls`. proof: `pnpm check:docs` and `pnpm sync:agents --check`

## Acceptance criteria

- [ ] A cold agent's kit gets the crash, the frame budget, the smear and the dead control as red scenarios without adding a check. proof: the Phase 1 and 3 red runs above

## Decisions

- 2026-10-24 (lead brief): the gates do not fix the kits. A red kit goes to its owning agent
  (`hop-garden-look`, `lantern-vale-look`, `kart-kit`) with the scenario and the numbers.
