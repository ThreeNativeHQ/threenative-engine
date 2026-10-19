---
prd_contract: v1
---

# PRD-288 — the first frame is not the compile bill

**Status: OPEN — filed 2026-08-30 against `728f72e8`. Nothing below has been executed.** Part of
the decent-defaults batch. Depends on
[PRD-278](../done/PRD-278-every-template-ships-the-render-chain-and-says-what-ran.md) for a chain that
has pipelines to compile.

**Priority:** P2 — Open ACs warm the post-chain output graph and count first-frame compile cost.
**Goal: a scaffolded game's loading screen ends when the game is ready to run, not when the scene is
ready and the post chain has not been compiled yet.** A five-stage TSL chain in seven templates adds
pipelines that nothing currently warms, on the platform least able to absorb the stall.

## The gap, verified in this tree

`packages/core/src/warmup.ts` (497 lines) is the warm-up seam and it is a good one: it compiles
through the renderer's own `compileAsync`, slices the work, budgets it
(`STARTUP_COMPILE_BUDGET_MS = 15_000`, `startup-readiness.ts:31`), and already guards the case that
bit this repo once — *"`compileAsync` that never resolved on the device left `#boot` awaiting
forever"* (`warmup.ts:105`).

It compiles **the scene**. `grep -n 'outputNode\|RenderPipeline\|post' packages/core/src/warmup.ts`
returns nothing. `compileAsync(scene, camera)` (`warmup.ts:406`, and the templates' own
`loading.ts:302`) does not walk a `RenderPipeline.outputNode` graph, so every pipeline the post
chain needs is created on its **first render** — which is after warm-up has declared readiness and
after the loading screen has dismissed. Three templates call it from `loading.ts` today; PRD-278
puts a five-stage chain behind all seven.

**What is measured, and what is not.** `docs/verification/runtime-perf-state.md` records a chain
rebuild landing inside a capture window as a **174-texture, 117-pipeline burst** — that observation
is of an HMR reload, not a cold boot, and this PRD does not claim otherwise. It is the reason to
measure a cold boot, not the measurement. The shape of the failure is already documented one batch
over: `nanite-like/` closes with a **649.6 ms `render.p95` on the frame that builds every distance
group at once**. A stall that arrives after the loading screen is a hitch the player sees.

## Scope

**In:** whether the post chain's pipelines are compiled before readiness; a cold-boot measurement on
browser and on a physical Android device, chain on and chain off; an honest report when the warm-up
cannot reach a graph.

**Out:** shader-cache persistence across launches; native pipeline caching in the C++ host;
resume-from-background (`PRD-222`); the per-frame cost of the chain once it is running (that is
[PRD-287](./PRD-287-the-default-look-holds-the-phones-budget.md)); any change to what the chain
looks like.

## The question Phase 0 answers before anything is built

Does `compileAsync(scene, camera)` on `three@0.185.1` compile the pipelines an installed
`RenderPipeline.outputNode` will need, or not? The tree says no and the answer must be measured, not
read: capture per-frame pipeline creation across a cold boot with the chain installed, and see
whether the count is non-zero after readiness. **If it is zero, this PRD closes as DECLINED with its
numbers** and the batch is cheaper by one item. That is a real outcome, not a failure.

## Acceptance criteria

- [ ] **AC0 — the question is answered with a count.** Pipelines created after readiness, cold boot,
      chain installed, on browser WebGPU. Zero closes this PRD as DECLINED; non-zero proceeds.
- [ ] **AC1 — the cost is named before it is fixed.** Time to first presented frame and the worst
      frame in the first 120, chain on versus chain off, on browser and on a physical Android
      device, window 1 discarded. Both arms from the same static build — a dev server another agent
      can edit is not a fixture.
- [ ] **AC2 — readiness covers the chain.** Warm-up compiles the installed output graph, or reports
      by name that it could not and why. *Mutation:* skip the graph and AC0's post-readiness count
      returns to its baseline value, failing the spec.
- [ ] **AC3 — it stays budgeted and it cannot hang.** The added work respects
      `STARTUP_COMPILE_BUDGET_MS` and inherits `warmup.ts`'s never-resolves guard; a compile that
      never settles ends the wait and reports, it does not block boot. *Mutation:* remove the
      timeout wrapper and the device-hang spec fails.
- [ ] **AC4 — the hitch is gone where it was measured.** The worst frame in the first 120 after
      readiness improves against AC1's chain-on baseline on both lanes measured, and the number is
      stated rather than the improvement asserted.
- [ ] **AC5 — no template regression.** Every template's `performance.playtest.json` passes at its
      current thresholds, and `pnpm test:templates` runs all seven.
- [ ] **AC6 — the record.** One dated file in `docs/verification/` naming the build, adapter,
      serial and every command; runtime/core performance findings update
      `docs/verification/runtime-perf-state.md` in place.

## What not to do

- Do not warm the chain by rendering a hidden frame with the real camera and calling it a fix
  without measuring — that moves the stall, it does not remove it, and AC4 is written to catch it.
- Do not compile eagerly on a target with no `compileAsync`; `warmup.ts:386` already handles that
  and the answer there is to report, not to invent a substitute.
- Do not extend `STARTUP_COMPILE_BUDGET_MS` to make a lane pass. A budget raised to fit the work is
  a cap routed around.
- Do not attribute a cold-boot number to the HMR burst in `runtime-perf-state.md`. They are
  different events and only one of them is in scope.
