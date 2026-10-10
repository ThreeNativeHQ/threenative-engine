---
prd_contract: v1
---

# PRD-569 — GPU particle emitters out of view stop costing, and effects yield to the frame budget

**Status:** PARTIAL — checkpoint corrections verified; runtime acceptance remains open.
**Priority:** P2 — AC-1 and AC-2 are open: every `GPUParticles3D` simulates and draws every frame, on screen or not, and no effect reads the measured budget.
**Complexity:** 5 (MEDIUM) — 1–5 engine files (`particles.ts`, `render-camera-cull.ts`, a small bounds/significance module) (+1), a measured-bounds reduction is a new mechanism (+2), culled/paused state carries across frames (+2); risk override: none
**Owner:** João
**Depends on:** None. It must pass the core-change admission gate of [PRD-316](../rendering/PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) (§3), because it adds core surface for effects.

## Context

`GPUParticles3D` (`packages/core/src/particles.ts:30`) is the engine's only GPU particle mechanism.
Every instance costs a compute dispatch and a draw every frame, whether or not the camera can see it:

- The constructor sets `this.frustumCulled = false` (`particles.ts:57`). The sprite draws its whole
  pool (`this.count = options.amount`, `particles.ts:56`).
- `render-camera-cull.ts:277-283` reads `frustumCulled = false` as "the bounds cannot be trusted" and
  keeps the object drawn. The comment names the particle batches as the reason for that rule.
- `ComputeDrivenRegistry.processRender` (`compute-driven.ts:78-90`) hands the render camera to every
  render-cadence object. `GPUParticles3D.process(renderer)` (`particles.ts:74-78`) ignores the
  camera, so the simulation runs regardless of view. It only stops when the game clears `emitting`.
- Three cannot cull a GPU particle sprite for us. A `Sprite` is frustum-tested as a unit quad around
  its own position, and every `Sprite` shares one module-level quad geometry
  (`three/src/objects/Sprite.js:12, 69-93`). The particles live in a storage buffer that the CPU
  never sees.

Games already hand-write the missing cull. `examples/vfx-gallery/src/scenes/Gallery.ts:252-257`
sets `emitting = visible` for every emitter on a hidden page, so its 46 effects do not all simulate
at once. Templates that ship emitters: action-rpg (`src/scenes/Play.ts:212-214`), runner
(`src/render/dust.ts`), snow (`src/render/weather.ts`), rain (`src/render/rain.ts`,
`src/render/lightning.ts`).

The measured budget exists but no effect reads it. `frame-budget.ts:191` defines a `compute` GPU
bucket for each window, which the render chain and the resolution scaler already act on.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **GPU emitters cannot measure their own bounds on the CPU.** Niagara offers three bounds modes:
  `Dynamic`, which is "only available for CPU emitters", `Fixed`, and `Programmable`
  (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Classes/NiagaraEmitter.h:128-136`). The
  default fixed box is 2 m on a side (`NiagaraEmitter.h:449`). View-frustum culling "requires fixed
  bounds" (`Classes/NiagaraEffectType.h:156-183`).
- **Culling waits before it acts.** An effect is culled only after it stays out of the frustum, or
  goes unrendered, for longer than `MaxTimeOutsideViewFrustum` / `MaxTimeWithoutRender`. Both
  default to 1 s, and all visibility culls default to off
  (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraEffectType.cpp:217-224`).
- **The cull reaction belongs to the effect.** Five reactions exist: kill and let particles die,
  kill and clear, sleep and resume, sleep-clear and resume, and **pause and resume**, which keeps
  the state and continues on return (`Classes/NiagaraEffectType.h:23-35`).
- **Significance ranks effects when there are too many.** Per effect type, `MaxInstances` keeps only
  the N most significant instances. Without a significance handler, the cap applies at spawn time
  only (`Classes/NiagaraEffectType.h:215-230`). The shipped handlers rank by distance to the nearest
  camera, or by age, newest first (`Classes/NiagaraEffectType.h:375-392`).
- **The global budget scales the caps, with damping.** When enabled, the usage of a global FX budget
  scales `MaxDistance` and the instance caps down through a linear ramp. The default ramp is 1.0 at
  usage 0.5 and 0.5 at usage 1.0. Effects are culled above `MaxGlobalBudgetUsage`, default 1.0
  (`Classes/NiagaraEffectType.h:115-139`, `Private/NiagaraEffectType.cpp:201-213`). The budget
  defaults to 2 ms per thread. Its adjusted usage decays at 0.1 per second, so effects do not flip
  on and off. The whole budget is **off by default** (`FFXBudget::bEnabled = false`)
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Particles/FXBudget.cpp:10, 26, 69, 285`).
- Niagara also draws only the live count through GPU-written indirect arguments
  (`Classes/NiagaraGPUInstanceCountManager.h:101`). See Decisions for why this PRD does not port
  that.

## Solution

Two mechanisms in core. Every appearance decision, and every "what happens to my effect when it is
culled" decision, stays in the game.

1. **Measured bounds, then the existing cull.** Unreal makes the author declare GPU bounds, because it
   cannot measure them. This engine can, so it does: the repository rule says a value the engine can
   measure where it is used is the engine's to decide.
   - `GPUParticles3D` runs a small min/max reduction over its own `positions` buffer every N frames.
     It reads the result through the existing throttled readback (`packages/core/src/gpu-readback.ts`).
   - Until the first sample lands, the emitter counts as visible. The engine never culls on a bound
     it has not measured.
   - An optional `bounds` option (a `Box3` in the emitter's space) is the named override. It suits
     a game that knows its effect's envelope and wants to cull from frame 0.
   - The emitter no longer sets `frustumCulled = false`. Instead it publishes the measured bound to
     `render-camera-cull.ts`, which tests it like any other object and keeps its existing reporting.
     An emitter with neither a sample nor an override stays exempt and is counted as
     `exemptWithoutBounds`. The rule at `render-camera-cull.ts:277-283` stays as written: a game that
     sets `frustumCulled = false` itself still opts out.
   - While an emitter is culled for longer than the grace time (Unreal's 1 s), `process` skips its
     dispatch. The emitter applies its `onCull` reaction: `"pause"`, the default, keeps the buffers
     and resumes where it left off; `"clear"` restarts on return. The reaction is game-owned. The
     template `src/render/` file that builds the effect sets it.
2. **Significance against the measured compute budget.** One ranking pass per frame orders the live
   emitters by projected size, the same measure the camera cull already computes. When the
   frame-budget window reports `compute` over its share, the least significant emitters take their
   `onCull` reaction first. Every cull and every resume reports a reason, as `TN_RENDER_CHAIN` does.
   Damping follows Unreal: usage decays at a fixed rate and an emitter must stay admissible for the
   grace time before it resumes. The engine sets no effect-count cap. The game may set a
   `maxInstances` per effect kind as a named override.

Integration: `ctx.add(new GPUParticles3D(...))` → `ComputeDrivenRegistry.processRender(renderer,
camera)` → `GPUParticles3D.process(renderer, camera)` → skip or dispatch. The draw side runs
`render-camera-cull.ts` → `Object3D.visible`.

## Acceptance Criteria

- [ ] AC-1 [local]: In a `vfx-gallery` scenario, the camera pans so that half of a page's emitters leave the view. The compute dispatches per frame then fall by at least 40% against the same pan with the cull off, and every effect still on screen keeps animating. proof: new `examples/vfx-gallery/playtests/emitter-cull.playtest.json` through `node packages/playtest/dist/runner/cli.js ... --browser-recipe webgpu`, reading `compute-timing` call counts and a per-effect motion probe.
- [ ] AC-2 [local]: On the same gallery, with the frame forced over budget, the least significant emitters pause first, every pause names its reason, and the emitters resume after the budget recovers, with no on/off flip inside the grace time. proof: the same playtest's over-budget arm (`TN_FRAME_BUDGET` override), with assertions on the reported reasons.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Measured emitter bounds and cull | `ctx.add(new GPUParticles3D(...))` → `processRender` → `GPUParticles3D.process(renderer, camera)`; draw via `render-camera-cull.ts` | `frustumCulled = false` at `particles.ts:57`; the hand-written `emitting = visible` gate at `Gallery.ts:252-257` is deleted | Phase 1, AC-1 |
| Budget significance | frame-budget window `compute` bucket → ranking pass → `onCull` reaction | None (new) | Phase 2, AC-2 |

## Decisions

- 2026-10-09 (João, via the Unreal review request): **no live-count indirect draw in this PRD.**
  Niagara draws only live particles through GPU-written indirect arguments. Here the engine cannot
  know which slots are dead: `IGPUParticles3DBuffers` holds only positions and velocities
  (`particles.ts:7-10`), and particle life is the game's kernel's own logic. Also, every `Sprite`
  shares one quad geometry, so `setIndirect` on it would redirect every sprite in the program.
  Reopen this only with a measured dead-slot cost and a liveness signal that the game supplies.
- 2026-10-09 (João, via the Unreal review request): bounds are measured, not declared. Unreal
  declares GPU bounds because it cannot measure them. This engine can, so the declared box is the
  named override, not the default.

- 2026-10-10 (lane agent, AFK, from reading the code): **the emitter owns its draw cull and
  `render-camera-cull.ts` stays unchanged.** Three tests a `Sprite` as a unit quad at its origin
  and ignores `boundingSphere`, so `frustumCulled = true` would cull a cloud whose origin is off
  screen. The emitter keeps `frustumCulled = false` and applies its own measured-bounds cull
  through `visible`, from `process(renderer, camera)`, which runs before the frame's draw. It
  restores `visible` only when it was the one that hid the emitter, so a game that hides one is
  never overruled. `exemptWithoutBounds` therefore gains nothing: an emitter with no sample is
  simply not culled.
- 2026-10-10 (lane agent): **the reduction uses 256 per-lane min/max partials, folded on the
  CPU, not atomics.** A lane scans a strided share of `positions`; the CPU folds 512 partials from
  the existing `GPUReadback`. No bit-pattern ordering of floats, no TSL atomic path to get silently
  wrong. The measured box includes every pool slot, dead ones too, so it is conservative.
- 2026-10-10 (lane agent): **`maxInstances` per effect kind is not built.** No caller names an
  effect kind, and the significance ranking already decides which emitters yield. Reopen it when a
  game asks for a hard cap.
- 2026-10-10 (lane agent): **the budget signal is `shed = clamp((gpuMs - targetFrameMs) /
  gpuCompute, 0, 1)`:** the share of the measured compute bucket that must go to reach the frame
  target. It rises at once and decays at 0.1 per second (the Unreal rate), and an emitter keeps a
  state for `graceSeconds` before it may change it. A window without `gpuMs`, `gpuCompute` or
  `targetFps` sheds nothing: an unmeasured budget is never over budget. The budget cull is
  therefore as inert as `TN_FRAME_BUDGET` needs it to be; the playtest forces an over-budget frame
  with `display.maxFps`, not with the marker, which only reports.
- 2026-10-10 (lane agent): **the proof counts dispatches, not `computeTiming` receipts.**
  `GPUParticles3D.dispatches` counts its own simulation `compute` calls, which is the quantity AC-1
  names, on every target, with no timestamp-query dependency.

- 2026-10-10 (parent-authorized checkpoint save): **save the existing lane independently while
  PRD-478's PR remains open; no fixes, push or PR creation in this save.** The prior readonly arm
  reported 35/35 focused specs passing. Its `pnpm typecheck` failed strict typing in
  `packages/core/__tests__/particles.spec.ts` and procedural-animals declarations; gallery
  typecheck failed at `Gallery.ts:446,578` because the public `graceSeconds` assignments do not
  match the private readonly field. These runtime/type checks were not rerun by the checkpoint
  save, and neither failure is waived. No box is ticked: red-green verification, typing fixes,
  the web AC-1/AC-2 playtest, the native desktop pan, and action-rpg's combat playtest remain
  open. The PRD remains here with doable work; this is a checkpoint, not completion or a
  whole-PRD blocked declaration. Parent review precedes the next push.

## Execution Phases

### Checkpoint corrections — 2026-10-10

- `GPUParticles3D.graceSeconds` is now a validated runtime control, shared with constructor validation. The gallery's existing assignments take effect; Infinity resumes view-culled emitters, and re-enabling culling starts a fresh grace interval. Four regression cases failed before the fix and passed afterward; `pnpm exec vitest run packages/core/__tests__/particles.spec.ts packages/core/__tests__/particle-significance.spec.ts packages/core/__tests__/compute-driven.spec.ts`: **39/39 passed**.
- Strict types in the changed particle tests are corrected. `pnpm exec tsc --noEmit -p packages/core/tsconfig.json` and `pnpm exec tsc --noEmit -p examples/vfx-gallery/tsconfig.json`: **passed**. Root `pnpm exec tsc --noEmit` still fails only on the same preexisting missing procedural-animals declarations and resulting implicit-any errors; no unrelated source was edited.
- Biome formatted the gallery and existing emitter-cull scenario. `pnpm exec biome check . --diagnostic-level=error`: **passed**, with existing warnings retained. The action-rpg scaffold fingerprint was refreshed for this PRD's changed template bytes; `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts -t 'byte-stable|mobile-shippable'`: **2/2 passed** after the shipped assets copy script restored the missing `basis_encoder.wasm` build artifact. `pnpm ci:fast`: **passed** (lint, docs, agent mirrors, drift); the two prior push-gate failures are resolved, without bypassing a gate.
- `pnpm --filter @threenative/core build` emitted the updated JS and declarations, then **failed** because `packages/engine-mcp/dist/index.js` is missing. The gallery typecheck passed against those rebuilt declarations; the full build is not claimed green. `pnpm capabilities:sync` and `pnpm api:surface:sync`: **passed**, with no tracked artifact changes.
- All seven phase boxes and both acceptance boxes remain open: the original bounds/cull/significance red-green requirements, web AC-1/AC-2, native desktop pan, and action-rpg combat proof are not accepted by these corrections. No push or PR creation; parent review remains required before pushing.

### Bounded runtime pass — 2026-10-10

- `pnpm --filter threenative-engine-mcp build`, `pnpm --filter @threenative/core build`, and `pnpm --filter vfx-gallery build:desktop`: **passed**, restoring the missing MCP artifact and producing `examples/vfx-gallery/dist/vfx-gallery-native.js`. No dependencies, lockfile, or engine/game source changed.
- Browser doctor passed. The initial `emitter-cull.playtest.json --browser-recipe webgpu` run **exited 1**: its adapter was Google SwiftShader, with `GPUBuffer.mapAsync` / `Instance dropped in popErrorScope` errors. Counted ticks also produced only 12 observed frames across 2,292 ticks, insufficient for the gallery's 60-render measurements. The laptop initially had room (load 6.24, 17 GB free, 93°C); its queued GPU job then **exited 75 before installation/build/run** at 99°C. No Intel result is claimed.
- The same browser scenario with `--live-clock` and the explicit Vulkan arguments below **exited 1**, on confirmed **NVIDIA / turing**, with diagnostics and frame-difference assertions passing. Dispatch ratio fell from **1.0 to 0.5556** (44.4% reduction), running emitters retained ratio **1.0**, and shortest observed dwell was **3.2168 s**. The scenario still fails: paused share **0.4444 < 0.5**; `culledRatio` and recovered `overBudgetPaused` trigger startup-triviality checks; `yieldedPeak` remains **0**. Tight-budget windows reported `targetFps: 2000`, `gpuMs: 0.17–0.31`, and `gpuCompute: 0.1`: the 0.5 ms target was never exceeded, so this stimulus does not prove AC-2. Capture artifacts: `artifacts/prd569-browser-live/`. This is behavioral evidence, not an independent visual judgment or an FPS claim.
- Desktop invocation with `--target desktop --executable packages/runtime-native/build/tn-linux/mystral --host-arg run --host-arg examples/vfx-gallery/dist/vfx-gallery-native.js` **exited 2**, before launch: `TN_PLAYTEST_UNSUPPORTED_ON_TARGET`, because the scenario explicitly requests network assertions and desktop has no CDP network observer. Neither the source-built nor package-prebuilt Linux executable is present in this checkout; native behavior remains unverified. Action-rpg combat was not run: the shipped template gate builds/packs the full local framework closure, outside this bounded pass.
- All **seven phase boxes and two acceptance boxes remain open**. Parent owns visual judging and any visual pan changes (requested Sonnet 5.5 high); no source fix, push, ready transition, or archive was performed. Documentation verification: `pnpm check:docs` **passed** (2,989 links); the six root prose-lane spec files **passed, 244/244 tests**; `git diff --check` **passed**.

The CLI rejects combining `--browser-recipe` with `--browser-arg`; the successful hardware selection used the recipe's flags plus the repository's existing `verify-temporal-motion.ts` Vulkan flags:

```sh
node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/emitter-cull.playtest.json --url http://127.0.0.1:5189 --server-command 'pnpm --filter vfx-gallery dev --host 127.0.0.1 --port 5189' --browser-arg '--ozone-platform=x11' --browser-arg '--enable-unsafe-webgpu' --browser-arg '--disable-gpu-sandbox' --browser-arg '--ignore-gpu-blocklist' --browser-arg '--enable-features=Vulkan' --browser-arg '--use-angle=vulkan' --browser-arg '--use-vulkan' --browser-arg '--disable-vulkan-surface' --browser-arg '--no-sandbox' --live-clock --artifacts artifacts/prd569-browser-live
```

#### Phase 1: An emitter out of view stops simulating and drawing
**Status:** PARTIAL — runtime grace control corrected; phase proofs remain open.
**Files:** `packages/core/src/particles.ts`, `packages/core/src/render-camera-cull.ts`, `packages/core/__tests__/particles.spec.ts`, `examples/vfx-gallery/src/scenes/Gallery.ts`, `examples/vfx-gallery/playtests/emitter-cull.playtest.json` (new)
- [ ] [local] The reduction measures a known particle cloud inside one sample's bounds, and an emitter with no landed sample is never culled. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`.
- [ ] [local] An emitter culled past the grace time skips its dispatch, `"pause"` resumes with its buffers intact, and `"clear"` restarts. proof: red-green cases in the same spec, counting `renderer.compute` calls on a stub renderer.
- [ ] [local] `vfx-gallery` drops its hand-written `emitting = visible` gate and AC-1 passes. proof: AC-1's playtest.
- [ ] [local] The native desktop host runs the same pan with the cull active. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/emitter-cull.playtest.json --target desktop`.

#### Phase 2: Effects yield to the measured budget by significance
**Status:** NOT STARTED
**Files:** `packages/core/src/particles.ts` (or a sibling `particle-significance.ts`), `packages/core/__tests__/particle-significance.spec.ts`, `examples/vfx-gallery/playtests/emitter-cull.playtest.json`
- [ ] [local] Ranking by projected size, usage decay, and the grace time hold under a scripted budget trace: the smallest projected emitter goes first, and no emitter flips inside the grace time. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/particle-significance.spec.ts`.
- [ ] [local] AC-2 passes on the web lane. proof: AC-2's over-budget arm.
- [ ] [local] One template that ships emitters (action-rpg) sets `onCull` in its `src/render/` source and its existing combat playtest stays green. proof: `pnpm test:templates` for action-rpg.
