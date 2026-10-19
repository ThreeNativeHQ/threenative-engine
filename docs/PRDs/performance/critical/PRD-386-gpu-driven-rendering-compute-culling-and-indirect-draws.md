---
prd_contract: v1
---

# PRD-386 — GPU-driven rendering: compute culling and indirect draws

## TL;DR

A real shipped game submits about **536 draws a frame and spends about 7.6 ms of CPU doing it —
roughly 14 microseconds per draw** (`sandbox/midway-open-pacific`, RTX 2080, WebGPU). The draw is
nearly free in WebGPU; the cost is per-object JavaScript in three's render walk — `_renderObjectDirect`,
`updateForRender`, material and uniform reconciliation, bind-group lookup. In the profile `three render`
is **48.4% of active CPU and `_renderObjects` alone 42.6%** of it, so every later optimisation was bound
by a term no game can reach.

Wanted: an engine-owned compute pass that culls on the GPU and writes an indirect draw buffer, with the
CPU submitting on the order of one `drawIndirect` per material and never touching per-object state. The
existing CPU cut stays: it is the oracle and the fallback, not the thing being replaced.

**Status:** PARTIAL — the mechanism shipped as PRD-473's Phase 1, this PRD's gates did not.
**Priority:** P1 — Open gates are platform parity: no Android or iOS evidence, no desktop `--target` conformance case, and CPU submission is still per key instead of per material.
**Evidence:** `a602467db` (PR #375) landed `packages/core/src/world-gpu-scene.ts` (2,353 lines) plus
`world-gpu-scene.spec.ts` (3,431 lines): one compute dispatch culls and LOD-selects every resident
placement and each main key draws its own region through a `BufferGeometry.setIndirect` record, with a
CPU fallback that names its `reasonCode`. See
[PRD-473 Phase 1](../../done/PRD-473-open-worlds-hold-120-fps-gpu-driven.md) for those boxes.
What this PRD still owns, unchanged: the gates below — Android and iOS evidence, the desktop native
conformance case through `--target`, and the per-material one-`drawIndirect` CPU submission this
document asks for (the shipped path draws per key, not per material).
**Date:** filed 2026-09-15.
**Scope:** Engine render mechanism in `@threenative/core` plus the compute/indirect seam in the owned
native host. No game code, no new package, no new scene format.
**Complexity:** HIGH — it moves the cut from a JavaScript walk to a GPU pass, on two runtimes, without
changing what a game author writes.
**Charter:** [`docs/architecture/CHARTER.md`](../../../architecture/CHARTER.md) binds and outranks this
document. This PRD introduces no IR, scene format, editor, preset/genre system, code-first ECS or
bespoke CLI vocabulary. Vocabulary is borrowed from Three.js, WebGPU and Godot before anything is
invented.

## Closure Gates

Every box requires evidence from an implementation revision. Merging this PRD completes none of them.
The reachability column is honest about a single NVIDIA GPU and no mobile hardware.

| Gate | Evidence required | Reachable here |
| --- | --- | --- |
| Compute cull is correct against the CPU oracle | For fixed camera poses the GPU cut selects the same clusters as `ClusteredMesh.update`; a parity case compares the two cluster sets and fails closed. | Yes — browser WebGPU, headless adapter named. |
| Indirect submission is real | The CPU issues indirect draws from a GPU-written buffer; a trace shows no per-object `drawIndexed` from the walk and the game's draw count comes from `renderer.info`. | Yes — browser WebGPU. |
| CPU per-draw term drops | Paired, same-session runs of the same scene report `_renderObjects` / `_drawObjectDirect` time and frame p50/p95 separately, with adapter, resolution and sample count. | Yes — desktop Xvfb is a valid CPU-term lane; **fps is not a desktop verdict** (see the [critical README](README.md)). |
| The cut runs on the owned native host | A desktop native conformance case or `--target desktop` playtest runs the same source and asserts the same visible geometry. A web-only feature is unfinished. | Partly — needs `pnpm native:build` + Dawn on the one GPU; the C++ host is present, the indirect/binding path is unproven. |
| Android and iOS run it | Per-platform render and correctness evidence. | **No** — no mobile hardware here; these gates stay open and are named, not silently skipped. |
| Fallback retained | With compute culling unavailable or disabled, the CPU cut still runs and the frame is correct; the reason is reported. | Yes — browser. |

## 1. Problem and repository grounding

### What the source actually contains at `d32eb643a`

The machinery named "the cut moves to the GPU" does **not** ship a GPU cut. This was verified, not
assumed:

- [`PRD-283`](../../done/nanite-like/PRD-283-the-cut-moves-to-the-gpu-and-native-runs-it.md):9 reads
  **"The kernel does not ship"**, and its Status line records a 2026-08-30 native run that redirected
  the batch away from a compute kernel.
- A grep of `packages/core/src` for `drawIndirect|drawIndexedIndirect|indirectBuffer|computeCull`
  returns **zero matches** at this revision.
- What exists is CPU cluster selection: `updateClusteredMeshes` at
  [`game.ts:1235`](../../../../packages/core/src/game.ts), which walks and calls
  `ClusteredMesh.update` at [`clustered-mesh.ts:241`](../../../../packages/core/src/clustered-mesh.ts)
  (dispatch at `clustered-mesh.ts:551`, batch function at `clustered-mesh.ts:566`). The per-object
  draw is still submitted by three's JavaScript walk.
- The compute dispatch seam already exists and is the right home:
  `ComputeDrivenRegistry` at [`compute-driven.ts:33`](../../../../packages/core/src/compute-driven.ts).

Three's walk is where the measured microseconds live:

| Existing surface | What this PRD must respect |
| --- | --- |
| Installed `three` `src/renderers/common/Renderer.js`: `:3316` `_renderObjects`, `:3701` `_renderObjectDirect`, `:3725-3728` `updateForRender` on geometries/nodes/bindings (catalog `three@0.185.1`) | This is the per-object JavaScript the PRD removes from the hot path. It is stock `three`; do not fork the renderer. |
| [`bake.ts:70`](../../../../packages/assets/src/virtual/bake.ts) `DEFAULT_MIN_SOURCE_TRIANGLES = 65_536` | Existing cluster baking is gated **per primitive** at 65,536 triangles. Measured on the carrier: **347,497 triangles spread over 280–301 meshes**, so no primitive qualifies and the existing path is inert for exactly the content that needs it. This is a scoping fact, not a bug to fix here. |
| [`compute-driven.ts:33`](../../../../packages/core/src/compute-driven.ts) `ComputeDrivenRegistry` | Warm-up, declared cadence and release already exist. Reuse them; add no second dispatch loop. |
| [`projection-apply.ts:693`](../../../../packages/core/src/projection-apply.ts) / `:772` batch `frustumCulled = false` | The incumbent batching cut reports a draw-count win it cannot fully deliver, because every batch is submitted to every pass. Read PRD-388; do not build the GPU cut on top of an unpriced optimizer. |

### The measured problem, stated once

From the Midway campaign capture (outside this repository):

- ~536 draws/frame cost ~7.6 ms of CPU ≈ **14 µs/draw**.
- Profile inclusive shares of active CPU: `three render` **48.4%**, `_renderObjects` **42.6%**.
- The only remedies available to the game were culling objects out of the frame — a content-level
  reduction of a mechanism-level cost.

## 2. Outcomes and non-goals

**Required:** a compute pass that reads the existing cluster table as storage, tests clusters against
the live camera (frustum and the screen-error test `ClusteredMesh` already computes), compacts
survivors, and writes indirect draw arguments; CPU submission of one indirect draw per material; the
existing CPU cut retained as oracle and fallback; honest diagnostics for which path ran and why.

**Not required for v1:** a meshlet renderer, a visibility buffer, virtual texturing, a Nanite clone, a
new scene/asset format, GPU-side material or light selection, or removal of the CPU path. Continuous
cluster LOD is PRD-253's Phase 7 stop-gated option, not this document's.

Do not own the look: every geometry, material, colour and texture stays the game's. The mechanism
decides what is submitted, never what it looks like. The test: a game can change the appearance
completely without editing package code.

## 3. Mechanism contract

- The kernel and the CPU cut consume the **same** cluster table and camera inputs; parity is the
  acceptance test, not a smoke test.
- Indirect arguments are produced on the GPU into a buffer the renderer consumes. The CPU does not
  read it back per frame; a readback, once per reported window for diagnostics, is the only sanctioned
  sync and must be bounded and declared.
- The CPU owns resource lifetime and dispatch cadence through `ComputeDrivenRegistry`; release follows
  scene end exactly as it does today.
- Absence of compute support is a reported fallback (`reasonCode` naming why), never a silent zero.
- No option is required for the ordinary case: with eligible content present the GPU path is the
  default, and the CPU path is the named override.

## 4. Dependencies and order

| Depends on | Why | Blocking? |
| --- | --- | --- |
| PRD-388 | An automatic optimizer that switches itself on must already price its own per-frame cost and downstream culling. A GPU cut inherits the same obligation. | Process, not code |
| PRD-387 | GPU-driven submission multiplies the material/pass variant count; preparing those variants off-frame is a prerequisite, not a follow-up. | Yes — sequence 387 before 386 |
| [PRD-283](../../done/nanite-like/PRD-283-the-cut-moves-to-the-gpu-and-native-runs-it.md) | Its negative result is the baseline this PRD must beat, and its native finding (submission shape and arrival cost, not the CPU walk) is why the CPU term is the target here. | No |
| [PRD-329](../critical/PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md) | Owns the native GPU-frame comparison; this PRD must not claim native timing it did not measure. | No — record its state |

## 5. Execution phases

### Phase 0 — trace and baseline

- [ ] The real draw/CPU term is re-measured on the shipped game at a named adapter and resolution, and the per-draw cost is attributed to the JavaScript walk, not the GPU.
- [ ] The compute/indirect path's native feasibility is checked against the owned host (Dawn/WebGPU) and the answer recorded, including any missing binding.

### Phase 1 — compute cull, parity against the oracle

- [ ] A compute pass culls from the existing cluster table and compacts survivors.
- [ ] A parity case compares GPU output to `ClusteredMesh.update` for fixed poses and fails closed on divergence.
- [ ] No behaviour change when the compute path is unavailable; the CPU cut runs and reports.

### Phase 2 — indirect submission

- [ ] The CPU submits indirect draws from the GPU-written buffer; per-object `drawIndexed` from the walk is absent for eligible content.
- [ ] `renderer.info` and the frame budget agree on the draw count for the projected and indirect paths.
- [ ] The CPU cut remains the fallback and reaches the same visible geometry.

### Phase 3 — native proof

- [ ] The same source runs the compute cull + indirect draw on desktop native, asserted by a conformance case or `--target desktop` playtest.
- [ ] Android and iOS gates are either backed by target evidence or explicitly left open with the missing lane named.

**Verification:** browser WebGPU runs name their adapter (`--browser-recipe webgpu`); desktop B/As read
`render.p50`/`frame.p50`, never fps; native uses `pnpm native:verify:desktop` as the host prerequisite
and a real consumer fixture, not a smoke sphere. Report actual runs, or say "unverified".

## 6. Completion boundary and references

Complete only when the closure gates have revision-linked evidence and the ordinary game path uses the
GPU cut by default, with the CPU cut retained and correct. A parity harness that passes on a fixture
sphere is not evidence. The kernel may end up not shipping on a given target if the measurement says
the CPU cut is already cheap enough there — that is a complete outcome, recorded, exactly as PRD-283
pre-authorised — but "it did not ship anywhere" does not satisfy the positive CPU-term gate.

This PR changes this PRD and the [critical README](README.md) only. No source, package, workflow or
previous PRD status is changed by its merge.
