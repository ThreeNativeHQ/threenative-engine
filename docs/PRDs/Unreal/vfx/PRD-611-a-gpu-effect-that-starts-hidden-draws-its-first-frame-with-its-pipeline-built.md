# PRD-611 — A GPU effect that starts hidden draws its first frame with its pipeline built

**Status:** NOT STARTED
**Priority:** P2 — AC-1 is open: the action-rpg attack, hit and surge emitters start with `visible = false`, so their draw pipelines are predicted to build in the frame each effect first appears.
**Complexity:** 4 (MEDIUM) — 1–5 files (`particles.ts`, `warmup.ts`, two specs, the template notes) (+1), a flag that the warm-up honors beside `includeHidden` (+1), an async compile state that carries across frames (+2); risk override: none
**Owner:** unassigned
**Depends on:** None. Independent of [PRD-609](../../done/PRD-609-a-gpu-burst-starts-where-and-when-it-is-asked-and-live-particles-stay-put.md), which removes the template's hide/show pair, and of [PRD-569](../../done/PRD-569-gpu-particle-emitters-cull-and-yield-to-the-frame-budget.md), whose `"pause"` cull reaction only suspends a dispatch.

## Context

Three builds a render list by walking the scene and returning at the first object with `visible === false` (`packages/core/node_modules/three/src/renderers/common/Renderer.js:3102`, three 0.185.1). A hidden object's pipeline is not built until the first frame that draws it. The engine documents this. The `prewarm` export says to keep a transient surface visible at zero opacity and never to hide it with `visible = false` (`packages/core/src/index.ts:1312-1318`, `packages/core/src/renderer.ts:104-113`).

Two things break that advice for the engine's own particle class:

- `prewarm` only touches objects whose `isMesh` flag is true (`packages/core/src/renderer.ts:123`). `GPUParticles3D` extends `Sprite` (`packages/core/src/particles.ts:30`), and a three `Sprite` sets `isSprite`, not `isMesh` (`packages/core/node_modules/three/src/objects/Sprite.js:65`). So `prewarm(emitter)` does nothing for a particle emitter. The existing spec only checks that sprites it does not target stay untouched (`packages/core/__tests__/prewarm.spec.ts:225-290`).
- The startup warm-up does not cover it either. `warmUpScene` leaves hidden objects hidden unless `includeHidden` is set, and its default is off (`packages/core/src/warmup.ts:117-126, 772-776`). Its `compileAsync` builds main-pass pipelines for visible objects only (`warmup.ts:100-106`). The emitter's compute kernels are warmed (`particles.ts:60`, `packages/core/src/game.ts:915-921`). Its draw pipeline is not.

The action-rpg template parks all three emitters after `ctx.add` (`packages/create-threenative/templates/action-rpg/src/scenes/Play.ts:213-218`) and shows one on each burst (`Play.ts:225`). By the code, the first attack, hit and surge each build a sprite pipeline in the frame they appear. The cost of one build is large on weak adapters. A Pixel 8 first frame spent 8.0 s of 12.0 s on 105 pipeline compiles (`packages/core/src/game.ts:363-366`). A native launch built 44–107 pipelines after ready, with freezes up to 615 ms (`warmup.ts:104-106`). Three sprite pipelines are far fewer than those, and Phase 1 measures what they cost here before this PRD builds anything.

Layer: engine, with a game-side symptom. A game cannot call the engine's documented fix on the engine's own class. The template's `visible = false` is the symptom. The root fix is that `GPUParticles3D` warms its own draw pipeline by default, so every game that parks an emitter benefits. PRD-609 later deletes the template's hide/show pair, but any game may still park an emitter, so the fix stays needed.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **The renderer reports its pipeline needs, and the component precaches them.** Each renderer type collects the pipeline state data of its emitter (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraSpriteRendererProperties.h:140`, `Public/NiagaraRendererProperties.h:350-361`). The component runs an asset-level precache once, then the ordinary precache (`Private/NiagaraComponent.cpp:4825-4830`). Nothing waits for the first draw to find out.
- **A system that is not ready delays its rendering, not its simulation.** The default delay mode is `DelayRendering`: the system keeps simulating and draws nothing until its pipeline is ready. The other mode, `DelayActivation`, holds both (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraScalabilitySettings.h:21-27, 86-88`).
- **The defaults precache early and urgently.** The priority boost is the highest. The precache time is on initialize, and the load-time cache is off by default (`NiagaraScalabilitySettings.h:50-58, 90-100`).
- **Pooling is bounded and cleaned.** A component returns to the pool only while the free count is under the system's maximum (`Private/NiagaraComponentPool.cpp:131`). Priming creates the smaller of the prime size and the maximum (`NiagaraComponentPool.cpp:285`). An unused pooled component dies after 180 s and the pool is cleaned every 30 s. Pooled components stay registered but invisible so that reuse is cheap (`NiagaraComponentPool.cpp:17-22, 38-50`).
- **Warm-up pre-rolls a simulation.** A system may tick for a warm-up time before its first frame at a default tick of 1/15 s (`Classes/NiagaraSystem.h:1087-1097`). This is state pre-roll and is not the pipeline warm-up above.

## Solution

All of it lives in `packages/core`. The template changes only its instructions.

1. **Warm at registration, on by default.** `ctx.add(new GPUParticles3D(...))` marks the emitter with a `warmWhenHidden` flag. `warmUpScene` already forces `includeHidden` objects visible for its one covered render and restores them (`warmup.ts:770-776`). It now also forces any object with the flag, whatever `includeHidden` says. The count shows in the existing `visibilityForced` report. The named override is the constructor option `warmWhenHidden: false`. With the override the census still reports the late pipeline, so the measurement survives.
2. **An emitter added after startup compiles before it draws.** On its first `process(renderer, camera)` call, which carries the render camera (`packages/core/src/compute-driven.ts:79-85`), the emitter asks `renderer.compileAsync` to build its draw pipeline, with the sprite shown for that call and restored after. Until the promise settles, the emitter draws nothing by holding its instance `count` at 0. Its compute keeps running, which is Unreal's `DelayRendering`. When the promise resolves, `count` returns to `amount`. A renderer without `compileAsync` resolves at once, so a stub and a WebGL fallback behave as today. The game's own `visible` toggles are untouched.
3. **`prewarm` is not widened.** It stays mesh-only. The particle class warms itself, and a non-particle sprite with a measured first-use hitch gets its own change.

Consumer flow: a game calls `ctx.add(new GPUParticles3D(options))` and parks it with `visible = false`. The startup warm-up draws it once under the cover. The first burst then draws with its pipeline built.

Reused systems: `warmUpScene` and its `visibilityForced` report (`packages/core/src/warmup.ts`), `IRendererLike.compileAsync` (`packages/core/src/renderer.ts:166`), the pipeline census (`packages/core/src/pipeline-census.ts`), the compute-driven lifecycle (`packages/core/src/compute-driven.ts`).

## Acceptance Criteria

- [ ] AC-1 [local]: In the action-rpg first-use run (two attacks, two surges), the runner's pipeline summary reports 0 render pipelines created after the first present for the sprite emitters. Phase 1 records the baseline count. proof: `pnpm test:templates` (action-rpg), reading `afterFirstPresent` in the pipeline summary — Evidence: pending.
- [ ] AC-2 [local]: The longest frame in the three frames after the first attack is at most 1.25 times the longest frame in the three frames after the second attack, as the median of three runs. proof: the same run's performance series (`performanceSeries` in the run report) — Evidence: pending.
- [ ] AC-3 [local]: An emitter added after startup draws nothing while a late-settling `compileAsync` is pending, keeps dispatching compute, and draws `amount` particles once it settles. proof: `pnpm exec vitest run packages/core/__tests__/particles.spec.ts` — Evidence: pending.
- [ ] AC-4 [native]: The same first-use scenario on the desktop host shows 0 post-present sprite pipelines. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/action-rpg/playtests/vfx-first-use.playtest.json --target desktop --executable <pkg>` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Warm-at-registration flag | `ctx.add(new GPUParticles3D(...))`, then `warmUpScene` at startup | A documented rule ("do not hide with `visible = false`") that the particle class could not follow | AC-1, AC-4 |
| Compile before first draw | The first `process` call of an emitter added after startup | None (new). A hitch in the first frame is accepted today | AC-3 |
| `warmWhenHidden: false` | A game that parks an emitter on purpose | None (new). The census still reports the cost | Phase 2 spec |

## Execution Phases

#### Phase 1: Measure the first-use cost of a parked emitter
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/playtests/vfx-first-use.playtest.json` (new), `packages/create-threenative/__tests__/scaffold.spec.ts` (the scaffold path list)
**Implementation:** the existing combat scenario presses attack and surge once, so it has no second use to compare. The new scenario presses attack twice and surge twice with waits between, and asserts only that the console stays clean. Read the runner's pipeline summary for it (`packages/playtest/src/runner/pipeline-summary.ts:131-133, 497-498` count creations before and after the first present). Count the render creations after the first present whose provenance material type is a sprite material. Sum their `serviceMs` and `promiseMs`. Read the longest frame in the three frames after the first and the second attack from the performance series. **Gate:** continue only if at least one sprite render pipeline is created after the first present, or the first-attack window is at least twice the second. Otherwise record the decline under `## Decisions` and delete Phases 2–3 (R4).
- [ ] The report prints the post-present sprite pipeline count, their summed time and the two frame windows. proof: `pnpm test:templates` (action-rpg), and `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts`

#### Phase 2: The particle class warms its own draw pipeline
**Status:** NOT STARTED
**Files:** `packages/core/src/particles.ts`, `packages/core/src/warmup.ts`, `packages/core/__tests__/particles.spec.ts`, `packages/core/__tests__/warmup.spec.ts`
**Implementation:** add the flag, the warm-up rule, the `warmWhenHidden` option and the late-compile gate as in Solution.
**Verification:** AC-3 closes this phase. Nothing new reaches the screen, because the warm render is covered, so no visual judge applies.
- [ ] `warmUpScene` forces a flagged hidden emitter visible for the covered render, restores it, and counts it in `visibilityForced`. With `warmWhenHidden: false` it does neither. proof: red-green `pnpm exec vitest run packages/core/__tests__/warmup.spec.ts`
- [ ] A late-settling `compileAsync` holds `count` at 0 and keeps compute running, a rejected `compileAsync` still restores `count` and reports once, and a renderer without `compileAsync` draws at once. proof: red-green `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`

#### Phase 3: Prove it on the template and on the desktop host
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/AGENTS.md`, `packages/core/src/index.ts` (the `prewarm` tags)
**Implementation:** the template already parks the emitters, so it needs no code change. The first-use scenario reports the numbers and does not assert them, because the playtest schema has no pipeline assertion. The Phase 2 specs are the regression guard. Update the `prewarm` tags to say that `GPUParticles3D` warms itself. Add one line to the template instructions. Run `pnpm sync:agents`.
- [ ] The first-use run meets AC-1 and AC-2. proof: `pnpm test:templates` (action-rpg)
- [ ] The desktop host meets AC-4. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/action-rpg/playtests/vfx-first-use.playtest.json --target desktop --executable <pkg>`
- [ ] The instructions and mirrors match the new behavior. proof: `pnpm sync:agents && pnpm check:docs`

## Decisions

- 2026-10-12 (Unreal source review): no component pool and no pool priming. A `GPUParticles3D` is already the pool: one emitter, a fixed slot count, and a restart or a ring. An idle one costs two small storage buffers. Unreal pools whole components with their scene registration, so it needs a size cap, a priming count and a kill timer. None of those has a counterpart here.
- 2026-10-12: no pre-roll. A closed-form emitter is mid-life at its first frame by construction, and runner dust, rain and snow are of this kind. A spawn-driven emitter (PRD-609) starts empty on purpose, because a burst must start at its birth. File a pre-roll only with a steady, stateful emitter that has a real consumer.
- 2026-10-12: `prewarm` stays mesh-only. Widening it would change a tested behavior (sprites under the requested root are untouched today) for a gain that `GPUParticles3D` already gets in its own class.
