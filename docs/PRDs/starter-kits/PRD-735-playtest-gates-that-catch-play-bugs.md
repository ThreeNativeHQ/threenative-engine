---
prd_contract: v1
---

# PRD-735 — Playtest gates that catch the bugs a player finds in five minutes

**Status:** PARTIAL — harness gates landed (explore, frame budget, sharpness, footSlip); kit scenarios and the explore crash catch open
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
- **Frame budget: 60 fps on every tier.** A `performance` assertion without `maxFrameMsP95` holds the
  run to 16.7 ms at p95 on a discrete, integrated or mobile GPU alike (owner: "it shouldnt be capped or
  minimum 60 fps", "goal is 60 fps"). A software adapter is unmeasurable and fails closed. A looser
  `maxFrameMsP95` needs a written `maxFrameMsReason`, which the report prints; the scenario throws at
  load without it. No template pins a frame time.
- **Perf warnings fail the run.** Any `TN_SCENE_WARNING`, and any `TN_RENDER_PROJECTION` decline other
  than the game's `renderer.projection: false` or `belowMeshFloor`, fails the `diagnostics` row
  with the marker text and the `cause` code and hint.
- **No foot plant.** A moving character on an `inPlace` clip with zero `clipGroundSpeed` fails the
  stride and footSlip gates with `no foot plant found: stride sync is off`.
- **Sharpness floor.** `visual.region.minSharpness`: variance of the Laplacian of luminance over the
  region of the final capture. A post stage that smears the frame drops it.
- **Limb slip.** `assert.footSlip[]` advances one labelled step a tick at a time and samples the
  subject and each named sole node. A foot is planted in the lowest quarter of its height below the
  body; slip is planted-foot travel over body travel. Browser target only; elsewhere it fails
  `TN_PLAYTEST_FOOT_SLIP_UNOBSERVED`.
- **Controls from the spawn.** A default `controls` scenario per kit presses each control the HUD
  advertises from the spawn, plus pointer motion for the camera, and asserts each changes state.

## Execution Phases

### Phase 1 — crash and frame budget

- [x] `explore` step kind expands deterministically into input steps; wrong-typed fields throw at load. proof: `pnpm exec vitest run packages/playtest/__tests__/explore-step.spec.ts` — 10/10 green; full playtest suite 1782/1782.
- [x] Every tier is held to 16.7 ms p95; a looser `maxFrameMsP95` needs a written `maxFrameMsReason` that the report prints; a software adapter fails closed as unmeasurable. proof: `pnpm exec vitest run packages/playtest/__tests__/frame-budget.spec.ts` — 8/8 green (30 fps fails, held 60 fps passes, Intel UHD gets 16.7, a looser value without a reason throws at load, SwiftShader fails `TN_PLAYTEST_PERFORMANCE_UNMEASURABLE`).
- [ ] Hop Garden at HEAD fails the `explore` scenario on the wall-probe crash. proof: playtest run against the Hop Garden consumer copy
  Open, second try (host load 41): an `explore` run placed at (-22.5, 0.6, 18) beside the deck failed `applySetup` timeouts with and without the f1a329533 fix, and `clipped-probe` itself timed out with the fix once, so load, not the NaN, caused those reds; no red-green was proven.
  Open: seeds 1-9 x 7200 ticks on a pre-fix copy (headed, nvidia/turing) all passed, no crash. The crash needs the orbiting deck to rise through an airborne Pip; `hop-garden-look` fixed it in f1a329533 with a targeted `clipped-probe` scenario.
- [x] No template pins 33 ms; the three kits' `performance.playtest.json` run at 16.7 ms. proof: 268b1c5f5, `template.spec.ts` asserts every template leaves `maxFrameMsP95` unset; headed, nvidia/turing, host load 35-41 (contended, so the numbers are upper bounds): Clover Cup p95 18.1 ms FAIL, Hop Garden 19.4 ms FAIL, Lantern Vale 18.9 ms FAIL.
- [x] A `TN_SCENE_WARNING` or a `TN_RENDER_PROJECTION` decline (not `disabled`, not `belowMeshFloor`) fails the run and prints the marker and its `cause`. proof: `pnpm exec vitest run packages/playtest/__tests__/perf-warnings.spec.ts` — 7/7 green; real runs: the generated shooter template fails (`notWorthwhile`, 833 renderables, 0 batches) and Lantern Vale fails (`notWorthwhile`, 331 renderables, 0 batches).
- [x] An `inPlace` clip with a moving character and no foot plant fails the stride and `footSlip` gates with `no foot plant found: stride sync is off`. proof: `foot-slip.spec.ts` and `animation-stride.spec.ts` unit cases; the real `inPlace: true` path is unrun because no kit ships an in-place clip, and the fps-friction `stride-locomotion` example passes with `inPlace: false`.

### Phase 2 — image and limbs

- [x] `visual.region.minSharpness` fails a smeared frame and passes a sharp one. proof: `pnpm exec vitest run packages/playtest/__tests__/sharpness.spec.ts` — 5/5 green. Metric: Laplacian variance at full over half resolution. Kit frames 2026-10-24: in-focus 0.39-0.61 (Hop Garden spawn 0.49, Lantern Vale 0.59), smeared 0.21-0.24 (Hop Garden after free play 0.21, Lantern Vale SSR arm 0.22); floor 0.3. Each kit's `explore` end frame carries the floor on its centre band: Clover Cup 0.47 in the run, Hop Garden 0.54 and Lantern Vale 0.62 measured on the same frames offline; the earlier smear did not reproduce at HEAD.
- [x] Limb slip measurement on named nodes fails a time-driven run cycle, and `maxSlideSpeed: 1` (m/s) is the default class guard on every kit with legs. proof: `foot-slip.spec.ts` (speed bound, `stepSeconds`, unnamed soles fail closed) — foot-slip, scenario, vacuous-assertion and schema-boundaries specs 115 passed; real runs headed, nvidia/turing: Lantern Vale HEAD slip 1.54 / 1.93 vs ceiling 0.35 FAIL; Hop Garden hero worst slide 1.60 m/s vs 1 FAIL (slip ratio 0.25 passes the old 0.35 bound); runner template `stride.playtest.json` 8.02 m/s, ratio 0.70 FAIL. Not run: starter and minimal (the consumer fails with `ReferenceError: booleanUniforms`), so they ship no stride scenario; kart has no legs.

### Phase 3 — controls

- [x] Lantern Vale ships `controls` and `look` scenarios from the spawn and Hop Garden ships `look`; each fails at HEAD. proof: playtest run against the Lantern Vale consumer copy — bf8e37804; Lantern Vale HEAD `controls`: `state.slashes` 0, expected >= 1, FAIL; `look`: `camera.main` rotationDelta 0, FAIL; a fixture copy (pointer-relative look, sword at spawn) passes both. Hop Garden working tree `look`: rotationDelta 0, FAIL. All headed, nvidia/turing.
- [x] The kits' `AGENTS.md` name the default gates and the rule that a new binding joins `explore` and `controls`. proof: `pnpm check:docs` and `pnpm sync:agents --check` — bf8e37804; check:docs 3519 links ok, mirrors in sync, instruction budgets met, template.spec 38/38. `explore` at HEAD passes on all three kits (Lantern Vale 13.6 m, Hop Garden working tree 35.7 m, Clover Cup 74.1 m).

## Acceptance criteria

- [ ] A cold agent's kit gets the crash, the frame budget, the smear and the dead control as red scenarios without adding a check. proof: the Phase 1 and 3 red runs above

## Decisions

- 2026-10-24 (playtest-gates): `controls` ships for Lantern Vale only, where the owner found the
  dead controls; Hop Garden's moves already have one scenario each, and Clover Cup's chase camera
  takes no mouse look, so it gets `explore` alone.

- 2026-10-24 (lead brief): the gates do not fix the kits. A red kit goes to its owning agent
  (`hop-garden-look`, `lantern-vale-look`, `kart-kit`) with the scenario and the numbers.
