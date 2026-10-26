---
prd_contract: v1
---

# PRD-735 — Playtest gates that catch the bugs a player finds in five minutes

**Status:** PARTIAL — harness gates landed (explore, frame budget, sharpness, footSlip); kit scenarios and the explore crash catch open
**Priority:** P1 — every kit had green scenarios while the owner hit a crash, 30 fps, skating limbs, dead controls and a smeared image by hand (all phases open).
**Complexity:** 5 (MEDIUM) — `packages/playtest` schema, evaluators and capture (+3), kit scenario files (+1), template `AGENTS.md` rules (+1). Risk override: none.
**Owner:** João
**Depends on:** none. Sibling of [PRD-732](PRD-732-hop-garden-3d-platformer-starter-kit.md), [PRD-733](../done/starter-kits/PRD-733-lantern-vale-3d-action-adventure-starter-kit.md) and [PRD-734](PRD-734-clover-cup-kart-racer-starter-kit.md); the gates ship in their PR (#563).

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
  Display-aware (lead decision, 2026-10-24): the rAF interval on the runner's private Xvfb is display cadence (platformer interval 17.7 ms against 4.2 ms CPU and 3.6 ms GPU cost). On that display the bound is p95 of max(CPU update+render, GPU) <= 16.7 and the interval is reported "display cadence, not gated"; on a real display (`TN_PLAYTEST_HOST_DISPLAY=1`) interval and cost are both held at 16.7. A missing CPU split or GPU reading fails closed; the latest window with a GPU reading is used because window 1 holds the startup compile (rts 196 ms in window 1, 6.4 ms in window 2). proof: `pnpm exec vitest run packages/playtest/__tests__/frame-budget.spec.ts performance.spec.ts runner.spec.ts scenario.spec.ts perf-warnings.spec.ts` — 199/199 green (virtual interval 18 / cost 3 passes, virtual cost 18 fails, real interval 18 fails, missing GPU fails). Fresh stamped pack (16:01, 5c0a58a31 plus working tree), virtual display, cost p95 (CPU/GPU): pass kart 1.3/8.6, platformer 4.2/3.6, puzzle 2.3/1.9, racing 5.8/14.1, rts 8.3/5.1, runner 9.8/8.9, sailing 4.7/1.8, snow 4.1/3.9, tower-defense 0.2/4.9, adventure 10.2/14.8, shooter 10.4/9.4, action-rpg 12.9/10.9; FAIL rain GPU 62.9 ms and collectathon "cannot be judged" (no GPU reading, caused by a435fb793, see the crash box note). Other new reds on that sweep: shooter and action-rpg `TN_RENDER_PROJECTION` `notWorthwhile` (cause `uniqueGeometry`, 213 and 42 meshes).
  Thin GPU window (lead, 2026-10-24): a judged window with fewer than `MIN_GPU_SAMPLES` = 3 GPU samples fails `TN_PLAYTEST_PERF_FEW_GPU_SAMPLES` (the row prints `cost.gpuSamples`). 3 is chosen, not measured; windows seen on the kits hold 1 to 6 samples (Hop 3 to 6, Vale 1 to 2, kart 2 to 5, racing 3) and below 20 samples the p95 is the maximum. Red-green: `frame-budget.spec.ts` 1-sample fixture passed before and fails with the code after (3 new tests: one sample fails, 2 fails and 3 passes and an unreported count fails, CPU cost over the ceiling still names `TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED`); `pnpm exec vitest run packages/playtest`: 1818 passed, 1 failed (`generated-shooter-input.spec.ts` on its `TN_RENDER_PROJECTION` perf-warning row, the `uniqueGeometry` red above; not in the frame bound, not re-run on the commit before this change). Cause of the thin windows: the counted-tick clock advances ticks faster than frames draw, so a 300-tick window closed on 44 to 53 presented frames (renderSkips about equal to frames) and held 1 to 3 GPU samples, whether the scenario held an input or idled. Fix: a scenario field `"clock": "wall-clock"` (web only; validated at load; red-green in `live-clock.spec.ts`, 4/4 files 184 tests green) runs that scenario as `--live-clock` does, beside counted ones in one glob run. Diagnostic pack (NOT one git archive: facade, core, three-native and Wasm each built from clean 1b90f1ed4 in a worktree and copied over an older consumer; kit src at 6494a9b98; RTX 2080, shared GPU slot with other lanes running, so the GPU p95 values are contended and not qualified): wall-clock windows held 17 to 38 GPU samples in the judged window (collectathon 24, adventure 26, kart 31, racing 38 with a held input; idle original scenarios 24, 22, -, 27), against 1 to 3 on the counted clock. The held-input edits added nothing, so the kit scenarios keep their steps and gain only `"clock": "wall-clock"`. The default 16.7 ms bound applies to every web scenario with an `assert.performance` block, so all 16 templates carry one (count 16: action-rpg, adventure, collectathon, kart, minimal `play`, platformer, puzzle, racing, rain, rts, runner, sailing, shooter, snow, starter `play`, tower-defense) and all 16 gain the line. All 185 template scenarios load through `validatePlaytestScenario` with 16 carrying the clock; `scaffold.spec.ts`, `playtest.spec.ts` and `template-quality.spec.ts`: 186 passed with the 16 scaffold pins recomputed. Only the 4 kits have measured sample counts; the other 12 are unmeasured on the wall clock, and minimal `play`, starter `play`, rts and shooter also hold non-perf assertions that now run on the wall clock (unverified).
- Moved 2026-10-25 (owner, "trim redundant validation"): the rain kit's GPU p95 box. Rain is not one of this PR's three kits, and PRD-723's rain box already requires its `performance.playtest.json` (16.7 ms since 268b1c5f5) to pass with an IMPROVEMENT judge, which is stricter than NEUTRAL. The measured history stays in that PRD's rain row: a2f5ccb24 holds 27.9-29.2 ms at quality high, and three low-resolution designs failed the judge.
- Dropped 2026-10-26 (lead decision, owner asked to finish PR #574): "Hop Garden at HEAD fails the `explore` scenario on the wall-probe crash". The crash is unreachable at HEAD: engine commit 3554e89e9 makes `intersectRay` skip a solid that contains the ray origin, so no ray returns a zero-normal hit. That class is now held by the engine's own red-green (`packages/physics/__tests__/spatial-query.spec.ts`, web and native), not by a kit scenario. A red run would need a pack before 3554e89e9 and would test a removed bug. The notes below stay as the record.
  Open, second try (host load 41): an `explore` run placed at (-22.5, 0.6, 18) beside the deck failed `applySetup` timeouts with and without the f1a329533 fix, and `clipped-probe` itself timed out with the fix once, so load, not the NaN, caused those reds; no red-green was proven.
  Parked (lead rule: no third round). Laptop round 4, 14 arms (red = collectathon at f1a329533^, green = at f1a329533, `clipped-probe` and `explore-deck` seeds 1-6, start temperatures 79-87 C): all 14 exit 1 with the same "1 browser console error", a 404 on `public/icon.png` that my arm overlay dropped, so it is an environment fault and no arm reached the crash. A corrected round would also be confounded: on a pack with a435fb793, Hop Garden's `setup.place` scenarios fail 8 to 11 of 14 runs with `TN_PLAYTEST_SETUP_UNAPPLIED` ("Resulting promise was garbage collected"), and 7/7 pass with only `this.#sceneEntered &&` removed from the world-pass condition in core's `game.ts`. Reopen after that commit is fixed.
  Open: seeds 1-9 x 7200 ticks on a pre-fix copy (headed, nvidia/turing) all passed, no crash. The crash needs the orbiting deck to rise through an airborne Pip; `hop-garden-look` fixed it in f1a329533 with a targeted `clipped-probe` scenario.
  Open, cannot be met as written (2026-10-26): at HEAD the crash is unreachable. Engine commit 3554e89e9 (24 min after the game guard f1a329533) makes `intersectRay` skip a solid that contains the ray origin unless `hitFromInside` is set (`@threenative/physics` dist `index.js:803,815`), so the zero-normal hit never reaches the kit. A red copy without the game guard passed `clipped-probe` and three `explore` variants placed inside the deck slab (7 runs, headed, nvidia/turing, all `pass: true`, identical trajectories red and green). A red run now needs a pack before 3554e89e9, which tests a bug the engine already removed. Owner call: drop this box or retarget it to a crash HEAD can still reach.
- [x] No template pins 33 ms; the three kits' `performance.playtest.json` run at 16.7 ms. proof: 268b1c5f5, `template.spec.ts` asserts every template leaves `maxFrameMsP95` unset; headed, nvidia/turing, host load 35-41 (contended, so the numbers are upper bounds): Clover Cup p95 18.1 ms FAIL, Hop Garden 19.4 ms FAIL, Lantern Vale 18.9 ms FAIL.
- [x] A `TN_SCENE_WARNING` or a `TN_RENDER_PROJECTION` decline (not `disabled`, not `belowMeshFloor`) fails the run and prints the marker and its `cause`. proof: `pnpm exec vitest run packages/playtest/__tests__/perf-warnings.spec.ts` — 7/7 green; real runs: the generated shooter template fails (`notWorthwhile`, 833 renderables, 0 batches) and Lantern Vale fails (`notWorthwhile`, 331 renderables, 0 batches).
- [x] An `inPlace` clip with a moving character and no foot plant fails the stride and `footSlip` gates with `no foot plant found: stride sync is off`. proof: `foot-slip.spec.ts` and `animation-stride.spec.ts` unit cases; the real `inPlace: true` path is unrun because no kit ships an in-place clip, and the fps-friction `stride-locomotion` example passes with `inPlace: false`.

### Phase 2 — image and limbs

- [x] `visual.region.minSharpness` fails a smeared frame and passes a sharp one. proof: `pnpm exec vitest run packages/playtest/__tests__/sharpness.spec.ts` — 5/5 green. Metric: Laplacian variance at full over half resolution. Kit frames 2026-10-24: in-focus 0.39-0.61 (Hop Garden spawn 0.49, Lantern Vale 0.59), smeared 0.21-0.24 (Hop Garden after free play 0.21, Lantern Vale SSR arm 0.22); floor 0.3. Each kit's `explore` end frame carries the floor on its centre band: Clover Cup 0.47 in the run, Hop Garden 0.54 and Lantern Vale 0.62 measured on the same frames offline; the earlier smear did not reproduce at HEAD.
- [x] Limb slip measurement on named nodes fails a time-driven run cycle, and `maxSlideSpeed: 1` (m/s) is the default class guard on every kit with legs. proof: `foot-slip.spec.ts` (speed bound, `stepSeconds`, unnamed soles fail closed) — foot-slip, scenario, vacuous-assertion and schema-boundaries specs 115 passed; real runs headed, nvidia/turing: Lantern Vale HEAD slip 1.54 / 1.93 vs ceiling 0.35 FAIL; Hop Garden hero worst slide 1.60 m/s vs 1 FAIL (slip ratio 0.25 passes the old 0.35 bound); runner template `stride.playtest.json` 8.02 m/s, ratio 0.70 FAIL. Runner fixed 2026-10-25: the exact GroundSnap pulled the jog's 0.27 m flight phase onto the floor; with `maxRate: 0.25` (downward only, 8fcfaec32) and the ball soles named, runner-stride reads 0.62 m/s and passes (SwiftShader, 9fd484591). Not run: starter and minimal (the consumer fails with `ReferenceError: booleanUniforms`), so they ship no stride scenario; kart has no legs.

### Phase 3 — controls

- [x] Lantern Vale ships `controls` and `look` scenarios from the spawn and Hop Garden ships `look`; each fails at HEAD. proof: playtest run against the Lantern Vale consumer copy — bf8e37804; Lantern Vale HEAD `controls`: `state.slashes` 0, expected >= 1, FAIL; `look`: `camera.main` rotationDelta 0, FAIL; a fixture copy (pointer-relative look, sword at spawn) passes both. Hop Garden working tree `look`: rotationDelta 0, FAIL. All headed, nvidia/turing.
- [x] The kits' `AGENTS.md` name the default gates and the rule that a new binding joins `explore` and `controls`. proof: `pnpm check:docs` and `pnpm sync:agents --check` — bf8e37804; check:docs 3519 links ok, mirrors in sync, instruction budgets met, template.spec 38/38. `explore` at HEAD passes on all three kits (Lantern Vale 13.6 m, Hop Garden working tree 35.7 m, Clover Cup 74.1 m).

## Acceptance criteria

- [ ] A cold agent's kit gets the frame budget, the smear and the dead control as red scenarios without adding a check (the crash leaves this criterion with the dropped wall-probe box, 2026-10-26). proof: the Phase 1, 2 and 3 red runs above

## Decisions

- 2026-10-26 (lead, PR #574, measured): the virtual-display branch of the frame bound is not a verdict on an NVIDIA desktop. On the runner's private Xvfb, Chrome draws only 6-12 frames/s (88-97% `renderSkips`; the Wasm frame gate waits on late work-done callbacks), so the RTX 2080 stays in P5 (645-795 MHz) and the honest per-pass GPU sum reads 2-3x high: Clover Cup judged GPU p95 5.3-19.4 ms over 5 identical quiet runs, shooter 24.7-49.5 ms, tower-defense 41.2, rts 31.0, Lantern Vale 27.5 (golden path). Spikes scale every pass by the same factor, so it is the clock, not a wait. Hardware `performance` verdicts therefore run on a real 60 Hz display (`TN_PLAYTEST_HOST_DISPLAY=1`). Follow-up, not in this PRD: report the drawn-frame rate and fail closed (or mark the lane throttled) when most loop frames draw nothing, so the virtual lane cannot pass or fail a kit on a throttled present path.

- 2026-10-24 (playtest-gates): `controls` ships for Lantern Vale only, where the owner found the
  dead controls; Hop Garden's moves already have one scenario each, and Clover Cup's chase camera
  takes no mouse look, so it gets `explore` alone.

- 2026-10-24 (lead brief): the gates do not fix the kits. A red kit goes to its owning agent
  (`hop-garden-look`, `lantern-vale-look`, `kart-kit`) with the scenario and the numbers.
