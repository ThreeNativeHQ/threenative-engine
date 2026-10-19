---
prd_contract: v1
---

# PRD-387 — shader variants are prepared off-frame, and bounded

## TL;DR

A user-recorded trace of the shipped game contains **one frame of 5,350.824 ms**, of which
**4,115.26 ms is `NodeBuilder.build`** — TSL shader-graph construction, synchronously, in JavaScript,
on the frame — plus **4,488.403 ms of thread CPU** and **430 ms of GC across 21 collections**. The
trigger: the renderer's batching path activated and needed material/pass variants that nothing had
warmed. The mitigation available to a game is to avoid the path entirely, which is the wrong answer.

The engine already warms the projection root that exists **at startup**
([`game.ts:914`](../../../../packages/core/src/game.ts) → [`warmup.ts:545`](../../../../packages/core/src/warmup.ts)).
A path that appears **later** — a dynamically added node, batching activating, a light or pass the
game turns on — gets no equivalent, and the whole graph is built on the next frame.

Wanted: engine-owned preparation of the **actual** material/pass variants, off the frame, bounded,
keeping the currently valid rendering until the new path is ready. Cover the variants the game
actually runs — shadow, reflection and its real render passes — not every conceivable combination.

**Status:** NOT STARTED — specification only.
**Priority:** P2 — Spec only: trace the synchronous build, census variants, prepare off-frame with a bound.
**Date:** 2026-09-15.
**Scope:** Engine warm-up/preparation in `@threenative/core`, on both runtimes. No game code, no new
public shader-authoring surface, no change to how a game writes materials.
**Complexity:** HIGH — it must prepare exactly the variants that will be needed, without building a
combinatorial universe, and without a visible regression in the meantime.
**Charter:** [`docs/architecture/CHARTER.md`](../../../architecture/CHARTER.md) binds and outranks this
document. No IR, scene format, editor, preset/genre system, code-first ECS or bespoke CLI vocabulary is
introduced. Vocabulary is borrowed (Three.js/TSL, WebGPU) before inventing.

## Closure Gates

| Gate | Evidence required | Reachable here |
| --- | --- | --- |
| The synchronous build leaves the frame | A trace of the real activation path shows no single `NodeBuilder.build` stall on a presented frame; the frozen 5,350 ms frame no longer reproduces. | Yes — browser WebGPU. |
| Preparation is bounded | A declared budget (wall-clock and/or variant count) caps preparation per activation; exceeding it defers and reports, never blocks a frame. | Yes — browser. |
| The right variants are covered | Shadow, reflection and the game's actual render passes are the variants prepared; a census names which were prepared and which were not. | Yes — browser; native follows. |
| Rendering stays valid throughout | Frames rendered while preparation is pending are a previously valid variant; no blank, default-material or half-built frame appears. | Yes — browser; a visual assertion plus a capture. |
| Native parity | The same source prepares off-frame on the owned native host, with the same bound and the same fallback. | Partly — `pnpm native:build` + Dawn on the one GPU; unproven today. |
| Android and iOS | Per-platform evidence. | **No** — no mobile hardware here; gates stay open and named. |

## 1. Problem and repository grounding

### What is synchronous at this revision

- Installed `three` (`three@0.185.1`) `src/renderers/common/nodes/NodeManager.js`:191-194 —
  `getForRender( renderObject, useAsync = false )`. The JSDoc says async is opt-in; the default is
  **false**.
- Same file, `:222` and `:268` — on a missing builder state the synchronous branch calls
  `nodeBuilder.build()` directly, on the calling (frame) thread. Three already ships the alternative:
  `getForRenderAsync` at `:314` and `getForRenderDeferred` at `:337`; the engine does not use them on
  the frame path today.
- Engine startup warm-up exists and is real:
  [`warmup.ts:545`](../../../../packages/core/src/warmup.ts) `warmUpScene`, called at
  [`game.ts:914`](../../../../packages/core/src/game.ts) with `projection.root` and the camera;
  [`renderer.ts:118`](../../../../packages/core/src/renderer.ts) declares the `compileAsync` seam and
  `:413` wraps it. This covers **the projection root that exists at startup**.

### Why the later path is different

The batching path, a dynamically added scene, or a pass the game enables after boot introduces
materials and lights that did not exist when `warmUpScene` ran. Nothing prepares them; the next frame
that needs a variant pays `nodeBuilder.build()` in full. That is the measured 5,350 ms frame.

### Measured evidence

From the Midway campaign capture (outside this repository, RTX 2080, WebGPU, real display):

| Quantity | Measured |
| --- | --- |
| Worst single frame | **5,350.824 ms** |
| `NodeBuilder.build` inside it | **4,115.26 ms** |
| Thread CPU in that frame | **4,488.403 ms** |
| GC in that frame | **430 ms across 21 collections** |

These are one trace's numbers, cited as the reason the mechanism must exist, not as a target the
implementation is scored against. The implementation's own runs are the evidence.

## 2. Outcomes and non-goals

**Required:** off-frame preparation of the actual material/pass variants; a declared bound; valid
rendering while preparation is pending; honest reporting of what was and was not prepared; a named
fallback when preparation fails or the budget is exceeded.

**Not required for v1:** preparing every conceivable material/light/pass combination; a compilation
cache format; off-thread/worker shader compilation; a public "prepare my material" API; moving the
same synchronous work into another gameplay callback. **Moving this work into `beforeRender`,
`update`, or any other gameplay callback is not a fix** — it is the same stall relocated, and this PRD
exists to stop that answer.

## 3. Mechanism contract

- Preparation covers the **variants the game actually runs**: the main pass, shadows, reflection and
  the render passes the game enables. A variant census names what was covered.
- Preparation is **bounded** per activation and yields between units so no single frame carries the
  cost. The bound is declared and reported.
- Until a needed variant is ready, the renderer keeps the previously valid variant; no frame is
  blank or half-built. This is a swap, never an unload-then-load.
- Absence of a prepared variant is reported as unavailable, never as a silent success.
- With no option passed, the ordinary case is correct: the engine prepares the real variants by
  default; a named override can disable preparation.

## 4. Dependencies and order

| Depends on | Why | Blocking? |
| --- | --- | --- |
| **PRD-386** | The GPU-driven cut multiplies the number of material/pass variants. Preparing them off-frame is the prerequisite for 386, so **PRD-387 precedes 386**. | Yes |
| PRD-540 (native compile walk) | Its main-thread compile work and native `createRenderPipelineAsync` finding share the "compile off the loop" theme; do not duplicate its mechanism. | Record |

## 5. Execution phases

### Phase 0 — trace and census

- [ ] The activation path is traced on the real game and the synchronous `NodeBuilder.build` frame is reproduced or its absence demonstrated, with the exact trigger named.
- [ ] The variant census names which material/pass variants the game actually needs (main, shadow, reflection, game passes).

### Phase 1 — bounded off-frame preparation

- [ ] Engine-owned preparation builds the censused variants off the frame, with a declared bound and yielding between units.
- [ ] The bound is enforced: exceeding it defers and reports; no frame blocks.
- [ ] Rendering keeps the last valid variant while preparation is pending.

### Phase 2 — coverage and honesty

- [ ] The census is emitted (prepared / deferred / not covered), and absence is reported as unavailable, never zero.
- [ ] The named override disables preparation and the measurement stays on.

### Phase 3 — native proof

- [ ] Off-frame preparation runs on desktop native through the real entry point; the bound and fallback behave as on web.
- [ ] Android/iOS gates are backed by target evidence or left open with the missing lane named.

**Verification:** trace the real activation path on browser WebGPU with a named adapter; assert on the
census and on the absence of a per-frame `NodeBuilder.build` stall; capture a frame during preparation
to show valid rendering. Use existing warm-up/compile instruments; add no second compiler. Report
actual runs or "unverified".

## 6. Completion boundary and references

Complete only when a real activation path prepares its variants off-frame within a declared bound,
renders valid frames throughout, and reports its census — with revision-linked evidence. A fix that
merely moves the stall to another callback, or that prepares the startup root again, does not satisfy
the gates.

This PR changes this PRD and the [critical README](README.md) only.
