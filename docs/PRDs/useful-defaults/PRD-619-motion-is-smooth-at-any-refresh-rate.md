# PRD-619 — Motion is smooth at any refresh rate: interpolate between physics ticks

**Status:** PARTIAL
**Priority:** P0 — fixes the report that every game that moves a body or a camera shows stepped motion on any display that does not present at exactly the 60 Hz simulation rate (owner report on the starter template, 2026-10-15; measured below).
**Complexity:** 4 (MEDIUM) — 4–7 implementation files (`packages/core/src/loop.ts`, `game.ts`, a new `interpolation.ts`, `packages/physics/src/{CharacterBody3D,RigidBody3D,VehicleBody3D}.ts`) (+2); the fixed-step/render contract every game reads (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** none. Related: PRD-615 (PR #508), where the report was made while the starter kit was repaired.

## Bug report

Owner, 2026-10-15, playing the scaffolded starter template in desktop Chrome: "shadow edges look like they're shaking". At rest the frame is stable; the shake appears while the player walks and the camera follows.

Layer: **engine**. The fixed-step loop and the physics bodies are `packages/core` and `packages/physics`; no game can fix this portably, because a game cannot see the loop's leftover time.

### Measured (2026-10-15, starter template, PR #508 head, desktop Chrome, WebGPU, discrete GPU)

- Chrome presented the game at **56.2 Hz** (rAF intervals p10 16.6 ms, p90 19.3 ms). The simulation steps at a fixed 60 Hz.
- `TN_FRAME_BUDGET`: `substeps` p50 1, **p95 2, max 5** per presented frame. So most frames advance the world one tick, and roughly one frame in 17 advances it two ticks: the player and the camera jump a double distance on that frame. High-contrast edges (shadow lines, grid lines) show the jump most.
- With the player idle and the camera settled, only 0.2% of pixels changed between frames (character idle and flag cloth), mean difference 0.55/765. Shadow filtering (`PCFSoftShadowMap`, fixed 4096² map, fixed shadow camera), film grain and the render projection (off: `belowMeshFloor`) are not the cause.

### Cause (code trace)

1. `packages/core/src/loop.ts:337-346` is a classic accumulator: it runs `floor(accumulator / step)` fixed updates per frame and keeps the remainder, but the remainder (`alpha = accumulator / step`) never reaches the render. Every frame draws the state of the last whole tick.
2. Physics bodies write the visual object directly at each tick: `CharacterBody3D.ts:202/233/250`, `RigidBody3D.ts:190/213`, `VehicleBody3D.ts:210`.
3. A scene's frame function — where the starter's spring-arm camera follows the player — runs inside the fixed update, so the camera is stepped at 60 Hz too.
4. Result: at any present rate that is not an integer multiple of 60 Hz (56 Hz missed-vsync browser, 75/90/120/144/165 Hz displays, Pixel 8's 120 Hz with frame drops), the distance moved per presented frame alternates between 0, 1 and 2 ticks.

This is the problem Godot's *physics interpolation* and Unity's `Rigidbody.interpolation` solve; Gaffer on Games "Fix Your Timestep!" is the reference description.

## Outcome

A game that moves a body or a camera in its fixed update presents motion whose per-frame displacement is proportional to the frame's real elapsed time, at any refresh rate, with no game code. Simulation, physics queries and game logic keep reading the true tick state.

## Acceptance criteria

- AC-1: The loop hands every presented frame `alpha = accumulator / step` in `[0, 1)`; `ctx` exposes it read-only.
- AC-2: Interpolation is **on by default** for every physics body's object and for `ctx.camera`: before a world draw the engine places each at `lerp(previousTick, currentTick, alpha)` (position, `slerp` for rotation), and restores the tick state after the draw, so update code and queries never see an interpolated transform.
- AC-3: Named override on the same object and globally: `defineGame({ physicsInterpolation: false })`, `body.interpolate = false`; `ctx.interpolate(object)` opts any other object in; `TN_PHYSICS_INTERPOLATION` reports `enabled`, the override source, and the tracked-object count, under either setting.
- AC-4: A teleport (`CharacterBody3D.teleport`, `RigidBody3D` position set, respawn, scene change) resets that object's history: no smear across the jump. `ctx.resetInterpolation(object)` covers game-driven teleports.
- AC-5: Per-frame displacement of a body moving at constant speed has a coefficient of variation under 10% at simulated present rates of 56, 75, 120 and 144 Hz (today it is above 50% at 56 Hz by construction).
- AC-6: Same behaviour on the native host (the loop is the same JS on V8/QuickJS); no platform claimed that was not run.

## Phases

### Phase 1 — Reproduce in a test
- [x] Loop spec drives `FixedStepLoop` with present intervals of 1/56, 1/75, 1/120 and 1/144 s and records a 2 m/s body's rendered x per frame; asserts AC-5's CV bound. Red reproduced: 4/4 failures, CV 0.242/0.496/1.000/1.179; exit 1. proof: `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts`

### Phase 2 — Engine mechanism
- [x] `loop.ts` exposes `alpha` per presented frame (AC-1). proof: `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts packages/core/__tests__/game.spec.ts packages/physics/__tests__/interpolation.spec.ts` — 73/73 passed (exit 0), including bounded alpha, camera default and override, frozen tick state, teleport and exception restoration.
- [x] Previous/current tick transforms recorded for physics bodies and `ctx.camera`; interpolated before the world draw and restored after (AC-2). proof: Phase 1 green; focused core/game/physics run 299/299 passed (exit 0). Full core/physics: 258 suites passed; three suites hit concurrent rebuilds and passed isolated rerun (18 tests).
- [x] Overrides, opt-in and `TN_PHYSICS_INTERPOLATION` report (AC-3). proof: `packages/core/__tests__/loop-interpolation.spec.ts` override cases and physics registration spec passed in the 73-test run (exit 0).
- [x] Teleport and scene-change history reset (AC-4). proof: core history reset and physical character/rigid teleport cases passed in the 73-test run (exit 0); scene history and stale removal are covered.

### Phase 3 — Proof in games
- [x] Starter live-clock playtest records presented camera and player positions and asserts AC-5. proof: `threenative-playtest playtests/live/smooth-motion.playtest.json --browser-recipe webgpu --headed --live-clock` in a tarball-installed scaffold — all five assertions passed on NVIDIA Turing WebGPU; 31 samples, player speed CV 0.0000409 and camera CV 0.000243 (both below 0.1), movement 4.598 m. Two BEFORE/AFTER rest runs judged NEUTRAL: framing, materials, shadows and HUD preserved. Final fresh read-only visual judge: both moving pairs and overall IMPROVEMENT (30 Hz simulation / 60 Hz display A/B with interpolation disabled/enabled); floor edges, grid lines and shadows advance every frame, no appearance regression. Other refresh rates have unit proof, not visual judgment. Raw rest captures are not bit-identical: before/after mean channel delta 0.199/255 versus 0.198/255 between the two BEFORE runs; the rest judgment establishes appearance preservation, not bit identity.
- [ ] Existing template scenarios still pass. proof: scaffold `pnpm test` — final 25/25 passed; `pnpm test:templates` — repeated GPU device loss in action-RPG combat/fail scenarios. Baseline and global-override-off combat controls passed; repaired default-on combat passed twice in isolated real-display runs. Tone exposure control passed. Owner chose to leave the full matrix proof open; no further retries are running.
- [ ] Native: the same scenario on the desktop host (AC-6). proof: playtest `--target desktop` run
- [x] All 13 template `AGENTS.md` files name the convention and its overrides. proof: `pnpm sync:agents` and `pnpm check:docs` passed (3,097 links); scaffold contract run passed 68 tests, including byte-stable hashes.

## Decisions

- 2026-10-15: expose read-only `ctx.frameTime` alongside `alpha`, so the presentation probe uses the real frame callback timestamp rather than variable post-render wall time. Frozen playtests continue to draw the current tick pose.
- The live-clock scenario lives in `playtests/live/` and is invoked explicitly with `--live-clock`; the ordinary top-level tick-counted scenario glob remains unchanged.

## Blocked on

- Full template matrix: repeated GPU device loss; owner chose to leave this proof open. Final starter 25/25, isolated repaired combat and tone controls passed, but no complete matrix success is claimed.
- Installed desktop host lacks `runtime.network`; the unchanged native scenario fails capability negotiation before motion assertions. Owner chose to leave native proof open rather than disable network diagnostics. A current-host build was stopped during compilation after that decision; no native pass is claimed.

## Notes

- Visual evidence: [motion BEFORE](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/prd619-screenshots/before-motion-1.gif), [motion AFTER](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/prd619-screenshots/after-motion-1.gif). The orphan `prd619-screenshots` branch holds both runs per arm, labeled rest frames and moving contact sheets. Rest judgment NEUTRAL; both motion pairs and overall IMPROVEMENT. The motion A/B deliberately uses a 30 Hz simulation on the 60 Hz display; default 60 Hz behavior is covered by the live-clock scenario and the four unit rates.
- Out of scope: render-rate game logic, variable-step physics, extrapolation.

Current verification: root `pnpm typecheck`, `pnpm lint`, `pnpm check:docs` passed; the six prescribed documentation contract suites passed 248 tests. `pnpm test` reached native package tests and failed on 21 assertions, including unbuilt V8/QuickJS timestamp-query and rg11b10 host test binaries; no native C++ test result is claimed. The scaffolded starter suite passed all 25 scenarios on both the initial and final package (including movement, respawn, pause and restart). Final `pnpm test:templates` was stopped after repeated GPU device loss; no full matrix pass is claimed. Native motion proof remains open by owner request. The settled-matrix flag test reproduced a separate no-op-at-rest defect (1 failed / 12 passed); the five-line restoration guard and the complete 73-test selection passed. GPU failure attribution remains unresolved; the guard is not claimed to repair every device loss.
