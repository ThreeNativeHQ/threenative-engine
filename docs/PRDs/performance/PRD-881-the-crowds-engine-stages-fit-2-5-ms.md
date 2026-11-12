# PRD-881 — The crowd's engine-owned stages fit 2.5 ms

**Status:** OPEN — filed 2026-11-11 from the PRD-878 close-out (owner, João: option 1, "close at measured values, file the follow-ups").
**Priority:** P1 — `?stress` minus `&noCrowd` still costs 3.70 ms of the desktop frame, and the engine-owned CPU stages are about 3.3 ms of the 4.5.
**Complexity:** 8 (HIGH) — renderer scene walk, plan and animation files (+3), cache state across frames (+3), one build boundary: the C++ engine serves native and web Wasm (+2). Risk override: none.
**Owner:** João · 2026-11-11
**Depends on:** [PRD-878](../done/PRD-878-the-walking-crowd-costs-2-5-ms.md) (its Decisions hold the stage attribution and the measured fair window).

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) and `PERFORMANCE-LEARNINGS.md` first.
C++ paths are under `packages/runtime-native/src/engine/`; JS paths under `packages/`.

## Context

PRD-878 cut the head build's `?stress` frame p50 from 9.22 to 7.75 ms (fair window `fwfinal`, ledger rows 376-381), but
the crowd cost (`?stress` minus `&noCrowd`) only from 4.16 to 3.70 ms. The attribution (`~/.cache/tmp-tn/prd878-handoff/out/crowd-attribution.md`,
idle RTX 2080, A B B A, 16-17 windows per arm; the debug flag reads +4.53 ms) puts the cost in:

| Row | Δ ms | Owner |
| --- | --- | --- |
| `update` | +1.42 | the lab's own `Stress.update` calling `AnimationPlayer.update` per walker (`packages/core/src/animation.ts:1306`); game scripting |
| `wasmScene` | +1.31 | `render_database.cpp:2009`, `prepare()` at `:1686` |
| `wasmPlan` | +0.91 | `renderer_frame.cpp:6`; `planVirtualPages` +0.30 (0.79-0.89 ms), `planShadowLists` +0.16 |
| `jsBefore` | +0.75 | engine JS before the render call |

The Codex inventory in PRD-878 proposed these moves, none implemented: a render-target sequence call for auto-exposure, bloom
and local exposure (0.14 + 0.25 + 0.08 ms); `tnw_web_render_targets` for the quad wrapper (0.40); `tn_physics_sync` (0.136);
a general `AnimationPlayer` batch in `tn_anim_tick` (0.068). `Material::version()` misses plain native writes, so a
signature cache keyed on it freezes draws (do not build it). The contiguous per-skeleton transform array is worth about
0.20 ms by linear scaling, below the 0.3 ms floor.

## Solution

Cut the engine-owned rows in order of ratio of ms to risk: the `wasmScene` walk, `jsBefore` (the post-pass sequence),
`planVirtualPages`, then the `AnimationPlayer` share of `update`. Each cut is a same-binary A/B with a red-green case.

## Validation scene

- Consumer: the stress lab `?stress` and `?stress&noCrowd` (`~/projects/threenative/sandbox-stress/stress-lab`), engine
  threenative-wasm, RTX 2080. Controls: `&noCrowd` charges each cut's bookkeeping with no crowd; `&still` holds the pose.
- Comparison: `node scripts/stress-loop.mjs fair` ABBA against PR #659's head `28371fc5c`, two runs per arm, the stage split from `?tnDebug=1`.

## Acceptance Criteria

- [ ] AC-1 [local, measure lane]: the engine-owned CPU stages of the crowd (`wasmScene`, `wasmPlan`, `jsBefore`, `residual`, `engineJs`; every stage except `update`) add 2.5 ms or less to `?stress` over `&noCrowd`, from about 3.3 ms. proof: the stage split, two ABBA runs — Evidence: pending.
- [ ] AC-2 [local]: `planVirtualPages` reads 0.5 ms or less on `?stress` (0.79-0.89 ms at `28371fc5c`). proof: the stage split — Evidence: pending.
- [ ] AC-3 [local]: head frame p50 is lower than `28371fc5c` in both ABBA pairs, p95 no more than 5% worse, a fresh visual judge reads NEUTRAL on the walkers. proof: ledger rows and the verdict — Evidence: pending.

## Execution Phases

#### Phase 1: The scene walk and the plan
**Status:** OPEN
- [ ] `wasmScene` (+1.31 ms): attribute `prepare()` per item, then cut the largest part. proof: same-binary A/B per cut and a red-green case per behaviour change.
- [ ] `planVirtualPages` and `planShadowLists` (+0.30, +0.16) reach 0.5 ms or less and the shadow list cost falls. proof: the stage split and a red-green case.

#### Phase 2: The engine JS and the animation share
**Status:** OPEN
- [ ] `jsBefore` (+0.75): the post-pass sequence (auto-exposure, bloom, local exposure, the quad wrapper) runs as one engine call, with `onRenderUpdate`/`onBeforeRender` order kept. proof: a red-green case on callback order, a `TN_FRAME_BUDGET` A/B, and a cold-start plus light-change capture for the exposure and rim hook-picking risk.
- [ ] The `AnimationPlayer` share of `update` runs through one `tn_anim_tick` extension; the mixer loop and finished-listeners stay JS. proof: red-green case and A/B.

## Blocked on

- Nothing.
