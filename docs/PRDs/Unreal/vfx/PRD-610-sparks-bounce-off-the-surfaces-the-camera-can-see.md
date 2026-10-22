# PRD-610 — Sparks bounce off the surfaces the camera can see

**Status:** NOT STARTED
**Priority:** P2 — AC-1 to AC-3 are open: no GPU particle can ask the scene where a surface is, so every spark falls through the floor it was thrown at.
**Complexity:** 6 (MEDIUM) — 6–10 files (a new `scene-depth-sampler.ts`, its spec, the index export, a conformance scene and registry row, the gallery probe, the action-rpg template) (+2), new public class (+2), depth texture paired with the previous frame's camera across frames (+2); risk override: none
**Owner:** unassigned
**Depends on:** None for Phases 1 and 2. Phase 3 waits on [PRD-609](../../done/PRD-609-a-gpu-burst-starts-where-and-when-it-is-asked-and-live-particles-stay-put.md) Phase 3, because the template's hit burst needs a stateful kernel and a real spawn. Respects [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) (§3): the class decides no appearance.

## Context

A GPU particle in ThreeNative cannot ask the scene anything. The shipped effects are closed-form functions of time, so they hold no state to correct. `GPUParticles3D` does keep a persistent `velocities` buffer (`packages/core/src/particles.ts:7-10`), so a game can write a stateful kernel today. It still has no way to find a surface. The action-rpg hit burst launches sparks at 5.7 to 9.2 m/s inside a wide cone and pulls them down at 8.5 m/s² (`packages/create-threenative/templates/action-rpg/src/render/vfx.ts:218-228`). By those numbers a spark thrown from chest height reaches the floor in about half a second. If it were stateful, it would then go below the floor and the depth test would hide it. The floor never answers.

The engine already holds the one thing that can answer. `renderer.scenePassDepth()` returns the scene pass's depth texture, its size and its sample count (`packages/core/src/renderer.ts:272-291`, implementation at `renderer.ts:985-1010`). Asked before the frame draws, it holds the previous frame's depth (`renderer.ts:276-278`). Three consumers read it:

- the world GPU scene pairs it with the previous frame's view and refuses an orthographic camera, a logarithmic depth buffer and a reversed depth buffer (`packages/core/src/world-gpu-scene.ts:2192-2206`),
- the depth pyramid reads it in a compute kernel, including every multisample (`packages/core/src/render/depth-pyramid.ts:405-462`),
- the water surface turns it into meters of water (`packages/core/src/water-surface.ts:359-368`).

A game cannot reach that texture portably. It lives in three's private render-target bookkeeping, so the framework must own the read. That meets the first of the two questions in the root `AGENTS.md`. What a spark does on contact (bounce, slide, die, splash) is the game's, and that meets the second. The shape is `WaterSurface3D`: core owns the plumbing and returns facts, and the game's kernel decides.

The capability search found no existing node for this. `engine_search_capabilities` for "particles bounce off the floor using the scene depth buffer" returned atmosphere, motion blur and ground snap only.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **The scene depth query is a data interface function, and the bounce is not.** The function takes a world position. It returns the scene depth (and -1 when the query fails), whether the position is inside the view, the camera position, the world position rebuilt from the stored depth, and the world normal (default `(0,0,1)`) (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraDataInterfaceCollisionQuery.cpp:211-231`, names at `:29-32`). The reaction (bounce, friction, kill) is a module in the effect. The same split applies here.
- **The tick stage follows the data.** A system whose interfaces need the depth buffer, the global distance field or the ray tracing scene runs after the opaque pass (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraSystemGpuComputeProxy.cpp:45-49`, stages at `Public/NiagaraCommon.h:1918-1930`). The author does not pick it. ThreeNative cannot dispatch compute inside three's frame after the opaque pass, so it reads the previous frame's depth and pairs it with the previous frame's camera. See Solution for the guard this needs.
- **A depth copy has a cost, and Unreal says so.** A variant that excludes opaque emitters from the depth needs a scene depth copy and carries an experimental warning about the base pass (`.../NiagaraDataInterfaceCollisionQuery.cpp:233-242`). ThreeNative sprites do not write depth, so no copy is needed.
- **The off-screen case has its own query.** A global distance field query returns the distance to the nearest surface and a validity flag. Its resolution drops with distance from the camera, and it needs mesh distance fields turned on (`.../NiagaraDataInterfaceCollisionQuery.cpp:268-285, 462-475`). A landscape interface returns a height and a world normal with a validity flag, for GPU only (`.../NiagaraDataInterfaceLandscape.cpp:1429-1445`). ThreeNative has no global distance field. See Decisions.

## Solution

One new core class, `SceneDepthSampler`, in `packages/core/src/scene-depth-sampler.ts`. It follows `WaterSurface3D`: it is a plumbing object that returns nodes and decides no look.

1. **It is a compute-driven object.** `ctx.add(new SceneDepthSampler())` registers it with `ComputeDrivenRegistry` at render cadence (`packages/core/src/compute-driven.ts:83-85`). Each frame it reads `renderer.scenePassDepth()`. It stores the camera matrices that drew that depth, so the depth and its camera always match. Camera motion between frames then needs no cut threshold.
2. **It returns TSL nodes for the game's kernel.** `sampler.hit(from, to, radius)` takes the particle's last and new world positions and its own radius. It returns `{ hit, point, normal }`. `hit` is true when `from` was in front of the stored surface and `to` is behind it. A swept test means a particle that starts behind a surface, such as one spawned inside geometry, never pops. The particle's own radius is the tolerance, so the engine owns no thickness constant. `point` is the surface position rebuilt from the stored depth. `normal` comes from depth neighbors (the smaller difference on each axis, three taps in all).
3. **It refuses honestly.** `hit` is false, and `sampler.status` says why, when the camera is orthographic, when the depth is logarithmic or reversed, when no scene depth exists, or when the position is outside the view. The status strings match the world GPU scene's wording (`refused: not a perspective camera`, `refused: nonstandard depth`, `refused: no scene depth`). A position outside the view is not a refusal. The kernel keeps integrating that particle. The sampler never kills a particle.
4. **A multisampled depth reads sample 0.** The error is under one sample's footprint. The status reports the sample count.
5. **The game owns the reaction.** The restitution, friction, kill rule and any splash live in `src/render/vfx.ts`, as ordinary TSL.

Consumer flow: a hit calls `hitVfx.emitParticle(...)` (PRD-609). Core's frame loop runs the sampler (updating its uniforms from the previous frame's depth), then the emitter's `process` kernel. The kernel integrates gravity, calls `sampler.hit(previous, next, radius)`, and on a hit reflects the velocity with the template's restitution. The spark lands on the floor the camera sees.

Reused systems: `renderer.scenePassDepth`, the previous-camera pairing pattern from `world-gpu-scene.ts`, the multisample handling from `depth-pyramid.ts`, the near/far to meters conversion that `water-surface.ts` uses, `ComputeDrivenRegistry` for lifetime and warm-up.

## Acceptance Criteria

- [ ] AC-1 [local]: In the gallery depth probe, 4,096 sparks dropped on a flat floor with the kernel's bounce on. After 2 s at least 99% of the sparks that stayed in view are at or above the floor height minus one radius, against 0% in the same run with the sampler off. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/depth-probe.playtest.json --url http://127.0.0.1:5186 --server-command 'pnpm --filter vfx-gallery dev --host 127.0.0.1 --port 5186 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: Sparks outside the view or behind the camera keep integrating. The readback has 0 NaN values and the sampler kills none. proof: the same playtest, second arm — Evidence: pending.
- [ ] AC-3 [local]: The sampler reports `refused: not a perspective camera`, `refused: nonstandard depth` and `refused: no scene depth` for the three matching setups, and returns `hit` false in each. proof: `pnpm exec vitest run packages/core/__tests__/scene-depth-sampler.spec.ts` — Evidence: pending.
- [ ] AC-4 [local]: 4,096 queries cost at most the budget set by Phase 1 on a named WebGPU adapter. Phase 1 records the number, and the proposed gate is 0.1 ms. proof: the playtest's `compute` bucket reading — Evidence: pending.
- [ ] AC-5 [native]: The depth-collision conformance row matches the browser reference on the desktop host. proof: `pnpm parity` (new row `vfx-depth-collision`) — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `SceneDepthSampler.hit` | `ctx.add(new SceneDepthSampler())`, then the action-rpg hit-spark `process` kernel in `src/render/vfx.ts` | None (new). Today sparks fall through the floor | Phase 3, AC-1 |
| `sampler.status` | The gallery probe entity `debug()` | None (new) | AC-3 |

## Execution Phases

#### Phase 1: Prove the depth reaches a compute kernel, and what it costs
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/scenes/DepthProbe.ts` (new), `examples/vfx-gallery/playtests/depth-probe.playtest.json` (new)
**Implementation:** a probe scene with a flat floor at height 0 and a box. A throwaway kernel reads `renderer.scenePassDepth()` with the previous frame's camera, rebuilds the world point for 4,096 screen-spread queries, and writes it to a buffer that `GPUReadback` returns. The probe reports whether the depth existed at dispatch time, the share of rebuilt floor points within 5 cm of height 0 out to 10 m, and the GPU cost in the `compute` bucket (`packages/core/src/frame-budget.ts:191`). **Gate:** continue only if the depth exists on web and on the desktop host, at least 95% of in-view floor points are within 5 cm, and 4,096 queries cost at most 0.1 ms. A failure on availability or accuracy declines the PRD. A failure on cost sets a lower particle count or declines it. Record the verdict under `## Decisions` and delete the moot boxes (R4).
- [ ] The web probe prints depth availability, accuracy and cost on a named WebGPU adapter. proof: the AC-1 playtest command
- [ ] The desktop host prints the same three numbers. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/depth-probe.playtest.json --target desktop --executable <pkg>`

#### Phase 2: Core returns hits, normals and honest refusals
**Status:** NOT STARTED
**Files:** `packages/core/src/scene-depth-sampler.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/scene-depth-sampler.spec.ts` (new), `packages/runtime-native/conformance/scenes/shared/vfx-depth-collision.js` (new), `packages/runtime-native/conformance/registry.json`
**Implementation:** build the class as in Solution. Export it from the index with the `@situation` and `@constraint` tags the manifest reads. Replace the probe's throwaway kernel with the sampler.
**Verification:** AC-1 to AC-3 close the web side. The sampler changes no pixel by itself, so Phase 2 needs no visual judge. Phase 3 does.
- [ ] Status cases hold for the three refusals, the pairing of depth version and camera, and a missing depth. proof: red-green `pnpm exec vitest run packages/core/__tests__/scene-depth-sampler.spec.ts`
- [ ] The probe's floor drop meets AC-1 and AC-2 with the sampler. proof: the AC-1 playtest command
- [ ] The desktop host matches the browser reference for the new row. proof: `pnpm parity`
- [ ] `runtime.delta` clamps at 0.125 s, Unreal's `MaxDeltaTimePerTick` (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraSettings.h:177-181`, applied in `NiagaraSystemSimulation.cpp:1182-1185`). After a 2 s stall, no live spark moves more than 0.125 s of its speed. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`

#### Phase 3: The action-rpg hit sparks land on the floor
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/src/render/vfx.ts`, `packages/create-threenative/templates/action-rpg/src/scenes/Play.ts`, `packages/create-threenative/templates/action-rpg/AGENTS.md`
**Implementation:** the hit-spark `process` kernel integrates gravity and calls `sampler.hit`. Restitution, friction and the kill rule are `src/render/` constants. The scene adds one sampler with `ctx.add`. The template instructions name `SceneDepthSampler` for any effect that must land on a surface.
**Verification:** this changes what reaches the screen. The visual judge compares the hit burst before and after, at two runs per arm, with BEFORE and AFTER burned in. NEUTRAL or REGRESSION means fix the cause and judge again.
- [ ] The combat scenario stays green with no console errors, and the hit burst lands on the floor. proof: `pnpm test:templates` (action-rpg)
- [ ] The template instructions and mirrors name the sampler, and the manifest lists it. proof: `pnpm sync:agents && pnpm check:docs && pnpm budgets`

## Decisions

- 2026-10-12 (Unreal source review): no distance field and no off-screen query in this PRD. Depth collision sees only what the camera sees. A spark behind a wall or off screen falls through, and the kernel decides what to do (the default is to keep integrating). Unreal needs a second query for that case. ThreeNative has no global distance field, and Godot's `GPUParticlesCollisionHeightField3D` is the portable analog, a heightfield rendered around a box. File it only after Phase 3 shows an off-screen miss that a player notices.
- 2026-10-12: the swept test replaces a thickness constant. A constant would be a number the author must revisit, which the repository calls a bug.
- 2026-10-12: sparks do not collide with each other or with moving characters. Characters write depth like any opaque mesh, so a spark does bounce off a character the camera sees.
