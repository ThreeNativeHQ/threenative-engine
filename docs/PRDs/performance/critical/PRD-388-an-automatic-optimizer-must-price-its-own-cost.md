---
prd_contract: v1
---

# PRD-388 — an automatic optimizer must price its own cost

## TL;DR

The engine's scene-render projection (`SceneRenderProjection`) admitted itself on a **predicted**
draw-count reduction and was a large net loss on a real game. On a paused, identical scene with the
toggle as the only variable it cost **1.378× the total callback time** (p50 **20.4 ms projected vs
14.8 ms declined**), and **1.109×** in time-matched live battle. It added **4.2–5.1 ms/frame** of
`reconcile` the render never recouped. Its draw count fell **527 → 194** while total frame time did
not, because its batches hard-code `frustumCulled = false` and carry one map-spanning bound, so the
shadow and reflection cameras can no longer cull them — counting both passes, projected totalled
**1,742 draws / 6.60 M triangles against 1,741 / 4.92 M declined**. Activating it cost a **2.0–3.4 s**
single-callback freeze every time, with zero counterpart when declined. It also changed the rendered
image, because the mirror `Scene` did not copy `backgroundRotation`/`environmentRotation`.

This PRD is not "delete the projection". It is the rule the campaign proved: **a mechanism that can
switch itself on must price its own per-frame cost against the work it removes, measured on a real
frame rather than predicted from draw candidates, must account for its effect on other passes, must
be trivially and honestly disableable by a game, and must report its verdict and reason honestly.**

**Status:** NOT STARTED — specification only.
**Priority:** P2 — Spec only: reproduce the optimizer A/B and price it from measured reconcile cost.
**Date:** 2026-09-15.
**Scope:** Engine render-projection policy in `@threenative/core`, plus the one game-facing opt-out
that policy requires. No new optimizer, no new render pass, no scene format.
**Complexity:** MEDIUM — the mechanism exists; the work is to make it self-measuring, culling-correct
and honestly disableable.
**Charter:** [`docs/architecture/CHARTER.md`](../../../architecture/CHARTER.md) binds and outranks this
document. No IR, scene format, editor, preset/genre system, code-first ECS or bespoke CLI vocabulary
is introduced. Vocabulary is borrowed from Three.js and WebGPU before inventing.

## Closure Gates

| Gate | Evidence required | Reachable here |
| --- | --- | --- |
| Priced on a real frame | The verdict uses a measured per-frame `reconcile` cost against a measured render saving, not a predicted draw ratio; a paired run shows the decision moves with the measurement. | Yes — browser WebGPU, paused identical scene. |
| Downstream passes accounted | The verdict accounts for shadow/reflection camera submission; the 1,742 vs 1,741 draw result no longer occurs, or is correctly priced as a loss and declined. | Yes — browser. |
| Honest disable | A game can turn the projection off; the frame then runs the authored scene with no mirror and no eligibility scan, and reports reason `disabled`. | **Partial** — the opt-out exists on the campaign branches, not on `develop` (below); this PRD requires it land. |
| Honest verdict and reason | `notWorthwhile`/`belowMeshFloor`/`disabled` and their reasons are emitted, and a decline is never reported as a win. | Yes — browser, via the existing marker. |
| Image unchanged by the toggle | With projection on and off, the rendered image matches for matched camera/lighting, or the difference is a priced, reported loss. | Yes — browser capture; the rotation-copy defect is the precedent. |
| Native parity | The same policy runs on the owned native host through the real entry point. | Partly — native host present; not proven here. |
| Android/iOS | Per-platform evidence. | **No** — no mobile hardware; gates stay open and named. |

## 1. Problem and repository grounding

### The policy that admitted the optimizer

| Existing surface | What this PRD must change or preserve |
| --- | --- |
| [`projection-plan.ts:52`](../../../../packages/core/src/projection-plan.ts) `WORTHWHILE_DRAW_RATIO = 0.75` and `:879` the `notWorthwhile` branch | Admission is decided from **predicted draws**, not measured cost. This is the root cause. Keep the reason code; change what feeds it. |
| [`projection-plan.ts:842`](../../../../packages/core/src/projection-plan.ts) `scanProjection(..., minMeshes, ...)`, `:863-870` `belowMeshFloor`; [`renderProjection.ts:116`](../../../../packages/core/src/renderProjection.ts) `minMeshes` option, `:154` default 200 | The floor is a prediction. The measured game had thousands of eligible meshes and still lost, so the floor alone cannot save it. |
| [`projection-plan.ts:863-885`](../../../../packages/core/src/projection-plan.ts) reason codes `belowMeshFloor` / `notWorthwhile`, mirrored at [`renderProjection.ts:46,50`](../../../../packages/core/src/renderProjection.ts) | Preserve these codes and their honesty; the new cost input must flow through the same verdict path. |
| [`renderProjection.ts:78-108`](../../../../packages/core/src/renderProjection.ts) `IRenderProjectionReport`: `sourceRenderables`, `resultDrawCandidates`, `drawsPlanned`, `timings.reconcileMs/lastReconcileMs/maxReconcileMs` | The report **already measures** `reconcileMs` and already says `drawsPlanned` is a plan, not a measurement. Use the measured timings and the renderer's counted draws; stop trusting the prediction. |
| [`projection-apply.ts:693`](../../../../packages/core/src/projection-apply.ts) (InstancedMesh) and `:772` (BatchedMesh) `frustumCulled = false`; `:770` `perObjectFrustumCulled`; comment at `:692` | A batch is submitted to every pass. That is why the shadow/reflection cameras cannot cull it and why the total draw count rose. Any batching that reports a draw win must account for this. |
| [`projection-marker.ts`](../../../../packages/core/src/projection-marker.ts) `PROJECTION_MARKER` / window JSON | The honest reporting surface already exists. Extend it; add no second dashboard. |
| Midway campaign capture (outside this repository, RTX 2080, WebGPU) | The adopted engine fix and its raw evidence live with that external game; they are not carried in-repo. |

### The disable opt-out, and where it actually lives

The game-facing opt-out is `renderer.projection: false` (`SceneRenderProjection` `enabled` option;
reason code `disabled`, message "the game set renderer.projection to false"). **It does not exist on
`develop` at `d32eb643a`** — verified: `develop`'s `renderProjection.ts` has no `enabled` option and
`game.ts:840` constructs the projection unconditionally. It originates on
`perf/projection-dirty` (`f464c0339`, "reflection cadence, projection opt-out, and mirror fixes") and
is carried on `feat/engine-consolidated`:
`renderProjection.ts:119-125` (`enabled`), `:170`, `:205-209` (`disabled` reason), and
`packages/create-threenative/src/config.ts:57` (`readonly projection?: boolean`). The same branch also
carries the `backgroundRotation`/`environmentRotation` mirror copy (`renderProjection.ts:239-240`)
that fixes the image change. This PRD's job is to make that opt-out land on the shipping tree as the
convention it is — not to claim it already ships.

### The measured loss, stated once

From the Midway campaign capture (outside this repository, RTX 2080, WebGPU, same scene, toggle the
only variable):

| Quantity | Projected | Declined |
| --- | --- | --- |
| Callback p50 (paused scene) | 20.4 ms | 14.8 ms |
| Ratio (paused) | **1.378×** | — |
| Ratio (live battle, time-matched) | **1.109×** | — |
| Added `reconcile` | **4.2–5.1 ms/frame** | — |
| Draw count (main pass) | 194 | 527 |
| Draws / triangles, both passes | 1,742 / 6.60 M | 1,741 / 4.92 M |
| Activation freeze | **2.0–3.4 s** | none |

## 2. Outcomes and non-goals

**Required:** the verdict is priced from a measured per-frame cost against a measured saving; it
accounts for every pass the change affects (shadow, reflection and others), not the main pass alone;
a game can disable it with one named option and no mirror is built; the verdict and reason are
reported honestly, and a decline is as visible as a win.

**Not required for v1:** a new batcher, GPU-driven batching, a configurable policy language, a preset
of optimizer tunings, or removing the projection. The mechanism may survive exactly as it is once it
prices itself honestly; "it was declined on this content" is a complete outcome.

## 3. Mechanism contract

- Measurement, not prediction: the mechanism records its measured `reconcile` cost per frame and the
  measured render change, and only keeps itself on when the former is repaid.
- Cross-pass accounting: the cost model includes draws submitted for every camera that walks the
  result, including shadow and reflection.
- One named override: `renderer.projection: false` builds no mirror and runs no scan; it reports
  `disabled`, not `notWorthwhile`.
- Honest reporting: the existing marker gains the measured cost/saving; absence of a measurement is
  `unavailable`, never zero.
- Default correct with no option: an ordinary scene that benefits keeps the projection on by default.
- No appearance change: the on/off images match for matched camera and lighting, or the difference is
  a reported loss that can flip the verdict.

## 4. Execution phases

### Phase 0 — reproduce the loss and the freeze

- [ ] The paused-scene and live-battle A/B is reproduced at a named adapter and resolution, with the projected/declined callback p50 and the added `reconcile` recorded.
- [ ] The activation freeze is timed; the cross-pass draw/triangle totals are measured for both arms.

### Phase 1 — price the optimizer

- [ ] The verdict consumes a measured per-frame `reconcile` cost and a measured render saving, not `WORTHWHILE_DRAW_RATIO`'s predicted draws.
- [ ] Cross-pass submission is included, so a batching win that forces shadow/reflection submission is priced as a loss and declined.
- [ ] The measured cost and saving are emitted through the existing marker.

### Phase 2 — honest disable and image parity

- [ ] `renderer.projection: false` lands on the shipping tree: no mirror, no scan, reason `disabled`.
- [ ] The `backgroundRotation`/`environmentRotation` copy (or an equivalent guarantee) makes on/off images match for matched camera/lighting.

### Phase 3 — native proof

- [ ] The priced policy and the opt-out run on desktop native through the real entry point.
- [ ] Android/iOS gates are backed by target evidence or left open with the missing lane named.

**Verification:** paired, same-session browser runs on a paused identical scene and a time-matched
live battle; adapter, resolution and sample count recorded; a capture for on/off image parity.
Desktop native via `pnpm native:verify:desktop` plus a real consumer. Report actual runs or
"unverified"; do not claim a platform the run did not execute.

## 5. Completion boundary and references

Complete only when the optimizer's own decision is driven by a measured cost, its downstream culling
effect is accounted for, the game has a working honest off switch on `develop`, and the verdict is
reported. A PRD claiming the projection is "fixed" because a prediction changed, with no measured
frame, does not satisfy the gates.

This PR changes this PRD and the [critical README](README.md) only.
