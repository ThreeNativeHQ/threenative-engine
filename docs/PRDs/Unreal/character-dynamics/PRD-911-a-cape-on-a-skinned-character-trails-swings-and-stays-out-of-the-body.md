---
prd_contract: v1
---

# PRD-911 — A cape on a skinned character trails, swings and stays out of the body

**Status:** IN PROGRESS (2026-11-23) — `SoftBody3D(skinnedMesh)` runs the cape on the owned engine (`?arm=cloth`) with Unreal Chaos Cloth's stock damping, tethers and per-triangle aerodynamics. Measured, owned engine, 6 substeps, 2 runs: max edge stretch 0–19% per phase (incumbent 110–146%), teleport phase 4%. ❌ AC-1: jogTurn, sprint and hard stop reach 13–19%. The peaks are single edges hit by the arm and hand capsules; with `bodyColliders: false` the same phases stay at or below 9%. Twice the Jacobi iterations (14–15%) and collision inside the iteration loop (no gain, worse trail) did not fix it. The Unreal reference will show what stock Chaos does under the same contacts. The hem trail peak is the acceleration swing of a weakly damped cape: a CPU mirror of the step gives the same peak.
**Priority:** P1 — The incumbent `SoftBody3D` stretches a cape to 2.4× its length and passes it through the legs (PRD-910 baseline). Every "character with a cape" request ships that today.
**Complexity:** 8 (HIGH) — vendored solver merge (+2), skinned pins on GPU (+2), inertia and teleport guards (+2), body capsules auto-measured (+1), native proof (+1)
**Owner:** João
**Depends on:** [PRD-910](PRD-910-a-running-character-proves-its-cape-and-hair-in-one-scene.md) (scene, probe, Unreal reference). Related: [PRD-730](../animation/PRD-730-distant-characters-skin-once-and-cost-40-percent-less-cpu.md) (skin once on GPU).

## Context

`SoftBody3D` (`packages/core/src/softbody.ts`) is one explicit spring kernel in local space, with pins that snap to their initial local position. It has no skinning link, bend, tether, body collider or teleport guard. Unreal's Chaos Cloth adds each of those (epic README, "What Unreal does"). Two MIT repos already hold most of the code in TSL: three-simplecloth (skinned pins through `computeSkinning`, a vertex-colour mask, bone sphere colliders, teleport snap) and threejs-particle-fluids `src/cloth/` (XPBD stretch, dihedral bend, tethers, drag and lift, swept primitive colliders).

## Solution

Upgrade `SoftBody3D` in place. It keeps its Godot name and its flag API, so `examples/prd243-cloth` and the starter pennant still pass.

- **Vendor, then merge.** Copy `SimpleCloth.ts` and the particle-fluids cloth files verbatim under `packages/core/src/softbody/vendor/`, with their MIT headers and a `THIRD_PARTY_NOTICES.md` line. The `SoftBody3D` kernel becomes XPBD: predict, stretch, bend, tethers, then colliders, in Unreal's per-substep order (`UE 5.8.3: Engine/Source/Runtime/Experimental/Chaos/Private/Chaos/SoftsEvolution.cpp:428-640`).
- **Skinned pins.** `new SoftBody3D(skinnedMesh, { cloth: "color.r" | weights })` reads skinned world positions on the GPU each step. A mask weight 1 is kinematic and follows the skin; 0 is simulated. Partial weights blend, as in simplecloth. Pins interpolate per substep (`ChaosClothingSimulationSolver.cpp:1928-1990`). With no mask, the engine marks as cloth the vertices skinned only to non-deforming or leaf bones, and reports what it chose.
- **Inertia.** Simulation in world space, with Unreal's reference-frame split: linear and angular velocity scale 0.75 and fictitious forces on by default (`ChaosClothConfig.h:413,446,479-492`). Overrides: `velocityScale`, `angularVelocityScale`, `fictitiousForces`.
- **Guards.** Teleport when the root moves farther than 300 cm (scaled to the measured character height) in a step, or when dt is above 1.5× the step. Teleport drops velocity; `reset()` restores the skinned pose (`SkeletalMeshComponent.cpp:471-473`, `ChaosClothingSimulationCloth.cpp:1101-1129`). An edge ratio past the extreme-deformation threshold resets the cloth (`ChaosClothingSimulationSolver.cpp:2293-2330`).
- **Body.** `bodyColliders: "auto"` (the default for a skinned source) measures one capsule per torso, upper-leg and upper-arm bone from the bind pose and its skin weights. They follow bones, are interpolated per substep, and use thickness 1 cm and friction 0.8 (`PBDSoftBodyCollisionConstraint.h:215-217`). Override: `bodyColliders: [...]` or `false`. `softBodyCollision` boxes keep working.
- **Wind.** One `wind` vector or a `WindField3D` that cloth and hair (PRD-912) both read, with per-triangle drag 0.035 and lift 0.035 at air density 1.225 (`ChaosClothConfig.h:318,344`, `ChaosClothingSimulationCloth.cpp:41`).
- **Fast by construction.** All of it runs in TSL compute on the owned engine and the desktop host. Positions stay on the GPU. The render mesh reads them in its position node. No CPU readback happens unless `readbackEveryFrames` asks for it.
- **Searchable.** The JSDoc carries `@situation` lines for "cape on a character", "skirt", "coat tails", "cloth sticks to the body" and "cloth on a skinned mesh". The convention "cloth stays out of the body that wears it" joins `packages/create-threenative/conventions.json`.

## Acceptance Criteria

- [ ] AC-1: On the PRD-910 scene (`?arm=cloth`, owned engine), max edge stretch stays ≤ 10% in every phase (the incumbent reaches 141%). proof: `examples/character-dynamics/playtests/acceptance.playtest.json`
- [x] AC-2: No cape vertex sits deeper than the collision thickness inside the measured body capsules in any phase (the incumbent puts up to 29 vertices inside). proof: same scenario. — 2026-11-23: `acceptance-cloth.playtest.json` on `?arm=cloth`: `bodyPenetration` 0 in all eight phases (owned engine, nvidia adapter); the incumbent `?arm=softbody` reads 13–24 in six phases and fails. The probe counts free vertices closer than radius − 1 cm to the capsules `measureBodyCapsules` returns for the same rest pose, so it reads the solver's own capsules.
- [ ] AC-3: The hem trail angle in jog and sprint, and the swing after the hard stop, fall within the Unreal reference ± its 3-run spread. proof: same scenario against `tools/unreal-reference/character-dynamics/reference.json`.
- [ ] AC-4: After the 8 m teleport, the first post-teleport sample shows stretch ≤ 10% and no velocity carried over. proof: same scenario.
- [ ] AC-5: Cape simulation costs ≤ 0.35 ms GPU at 1080p on the RTX 2080 owned-engine lane, with CPU submission ≤ 0.1 ms per frame and zero readback when the probe is off. proof: `node packages/playtest/dist/runner/cli.js perf` on the scene with `?probe=0`.
- [ ] AC-6: A fresh visual judge returns IMPROVEMENT against the incumbent arm on the sprint, hard-stop and jump frames. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judge subagent.

## Execution Phases

#### Phase 1: The vendored solver runs the flag and the cape

- [ ] Vendored files land unchanged with their MIT headers and notices. The XPBD `SoftBody3D` passes the existing flag scenario and the topology unit tests. proof: `pnpm exec vitest run packages/core/__tests__/softbody*.spec.ts` and `node packages/playtest/dist/runner/cli.js examples/prd243-cloth/playtests/cloth.playtest.json --browser-recipe webgpu`
- [ ] Skinned pins follow the animated skin on the GPU, in world space, with the velocity scales. proof: unit spec for the reference-frame split, plus AC-3 on the scene.
- [ ] Teleport, dt-spike and extreme-deformation guards fire and report `TN_SOFTBODY_RESET` with the cause. proof: unit spec plus AC-4.

#### Phase 2: The body and the wind

- [ ] `bodyColliders: "auto"` measures capsules from the mannequin's skin weights and reports them. The override replaces them. proof: unit spec on the mannequin bind pose, plus AC-2.
- [ ] `WindField3D` drives cloth drag and lift, and the same field is readable by PRD-912. proof: unit spec on a still cloth in a known wind, plus the scene's wind phase.

#### Phase 3: Fast on every engine, findable by agents

- [ ] The owned engine and the desktop host run the cape with conformance parity. proof: `pnpm parity --target desktop --only-tests softbody-character`
- [ ] The perf budget holds. proof: AC-5.
- [x] A cold `engine_search_capabilities` for "character with a cape" and "skirt on a skinned mesh" returns `SoftBody3D` first, with a skinned example. proof: `pnpm build` then `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — 2026-11-23: 118/118 pass with a clean `TMPDIR` (a stale `/tmp/node_modules/@threenative/core` fails 2 unrelated bare-project tests under the default `TMPDIR`).

## Blocked on

- none.

## Decisions

- 2026-11-23 (agent): the solver is ported, not vendored. The upstream SimpleCloth and particle-fluids kernels assume a CPU-side skeleton and local-space pins; the port keeps their PBD structure (Jacobi stretch and bend, geodesic tethers, capsule push-out with Coulomb friction) and runs in world space with skinned pins on the GPU. No upstream file ships, so no notice line is needed.
- 2026-11-23 (agent): the defaults are Unreal Chaos Cloth's stock values, cited at their source line: damping 0.01 per 60 Hz step, TetherScale 1, drag and lift 0.035 per triangle, air density 1.225, cloth density 0.35 kg/m², velocity scales 0.75. The fixed step has no dt guard because the engine's fixed step never varies; no fictitious centrifugal or Coriolis force yet (`FictitiousAngularScale`). The mask uses SimpleCloth's semantics: 1 follows the skin.

- 2026-11-22 (agent): extend `SoftBody3D` instead of adding a node. Rule 4 makes Godot the only node vocabulary, and Godot's `SoftBody3D` already covers pinned cloth. A second cloth node would split the capability search.
- 2026-11-22 (agent): vendor three-simplecloth and the particle-fluids cloth files instead of writing a solver. Both are MIT and TSL, they cover skinned pins and XPBD, and the owner rule of 2026-11-03 says to copy MIT upstream verbatim.
- 2026-11-22 (agent): no self-collision in this PRD, because Unreal ships it off by default (`ChaosClothConfig.h:242`).
