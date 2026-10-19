---
prd_contract: v1
---

# PRD-245 — Indirect light is a node the game composites

**Status: SUPERSEDED 2026-10-03 — folded into
[PRD-267](../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) at runbook row C6,
which carries its charter veto, its cost verdict and its borrow map as Phase 3. Kept in place with
its text: `docs/PRDs/AGENTS.md` archives *finished* work in `done/` and a superseded proposal with 0
ticked boxes is not finished. The file below is PROPOSED 2026-08-28. Nothing below has been
executed. Depends on
[PRD-242](../done/PRD-242-gpu-simulation-has-one-lifetime.md) for lifetime and
[PRD-244](../done/PRD-244-the-scenes-bvh-reaches-the-gpu.md) for the traceable scene.**

**Priority:** P2 — Its own status says nothing below has been executed: the surfel GI node, the TSL depth/normal/albedo nodes and the colour-bleed A/B capture are open.
Source of the borrowed architecture: [`jure/webgiya`](https://github.com/jure/webgiya), MIT, cloned
at depth 1 on 2026-08-28 and read (7 509 lines across `src/`). **Nothing is copied.**

Parent batch: feature-mining.

**This PRD reverses a refusal.** The round-two survey refused surfel GI on the grounds that
"lighting is something a screenshot shows". That is the wording **§5b of the charter explicitly
retired**, in a paragraph naming `GPUParticles3D` as the code it wrongly banned. The live test is
below, and GI passes it.

**Complexity:** +3 touches 10+ files, +2 new subsystem, +2 complex state (a surfel pool with
allocation, ageing and spatial hashing across frames), +2 multi-package = **9 → HIGH mode.
Mandatory checkpoint every phase, and §10b's review trigger applies.**

## The hard veto, answered first

> **The test, and it is a hard veto:** can the game change the appearance completely without editing
> framework code? If any answer is no, the whole thing ships as generated source in `src/render/`.
> There is no partial credit and no "sensible default" that a game reaches through a config option —
> `postprocessing: ['bloom']` is still the v1 mistake, and it is still removed.
> — CHARTER §5b

| Appearance decision | Who makes it under this design |
| --- | --- |
| Whether indirect light appears at all | **The game.** If `src/render/postprocessing.ts` does not reference the node, nothing changes on screen. |
| How it is composited — added, multiplied, energy-conserving, tonemapped before or after | **The game**, in its own output node. |
| Bounce strength, colour bleed, saturation | **The game**, as TSL it writes. |
| Materials, albedo, lights that feed the solve | **The game.** They already do. |
| Surfel budget, ray count, update cadence | The framework, as **performance** parameters with no look defaults, documented in milliseconds rather than in adjectives. |

The framework owns the surfel pool, allocation, ageing, the spatial hash, ray integration and
dispatch — the same kind of thing `GPUParticles3D` owns — and hands back **one TSL node**. It ships
no preset, no default composite, and no `gi: true` config flag. A game that wants GI writes one line
in a file it owns:

```ts
// src/render/postprocessing.ts — generated for you, edit or delete it freely
postProcessing.outputNode = fxaa(directLight.add(gi.indirectLight.mul(0.8)));
```

That line is the whole opt-in, and it is in the game's repository. Deleting it removes the feature,
which is also this PRD's negative control.

**This is exactly how the source does it.** `webgiya/src/main.ts:709-722` assembles
`postProcessing.outputNode` from `directLight` and `indirectLight` in application code — the split
already exists upstream; this PRD keeps the line on the same side.

## Why the framework and not the game

Question 1 — *could the game write this portably itself?* — needs an honest answer, because GI is
TSL and TSL is portable. What a game **cannot** reach:

- The render-pass ordering around `renderer.render()`, owned at `game.ts:841-842`.
- Buffer residency across a scene change, owned by PRD-242.
- The scene in traceable storage buffers, owned by PRD-244.

And what a game should not have to write: 7 509 lines. §11.1's clause — *"something that passes both
becomes framework code once one game writes it more than twice"* — is not yet satisfied by count,
and this PRD says so rather than pretending. **The owner's call is whether the framework leads here.**
If the answer is "wait for a second game to write it", this PRD parks with that recorded, and PRD-244
still stands on its own — a GPU-traceable scene is what makes the game's own version writable.

## What the source actually contains

| Claim | Evidence |
| --- | --- |
| The frame graph is cleanly separable: GBuffer → prepare surfels → find missing → allocate/age → hash grid → integrate → resolve → composite | `src/gbuffer.ts`, `surfelPreparePass.ts` (133), `surfelFindMissingPass.ts` (595), `surfelAllocatePass.ts` (298), `surfelAgePass.ts` (186), `surfelHashGrid.ts` (934), `surfelIntegratePass.ts` (1 266), `surfelGIResolvePass.ts` (373) |
| Composition is application code, not library code | `src/main.ts:709-722` |
| It traces the scene through a BVH in storage buffers | `src/sceneBvh.ts` (212 lines) — **this is PRD-244** |
| It vendors `three-mesh-bvh` only because it pins `^0.9.2` | `sceneBvh.ts:3-4`; this repository is on 0.9.14, where `./webgpu` is published |
| GPU-computed indirect dispatch args | `surfelDispatchArgs.ts`, `integratorDispatchArgs.ts` |
| `three@^0.182.0`; this repository is on `0.185.x` | `package.json` |
| MIT | `LICENSE` |

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `templates/*/src/render/postprocessing.ts` (14–20 lines each) | **The composite site.** Untouched by the framework; one template gains a line in Phase 3, as generated source. |
| `IComputeDriven` (PRD-242) | Depended on for pool lifetime, ordered dispatch and scene-change release. |
| `GPUSceneBVH` (PRD-244) | Depended on for the traced scene. **This PRD does not build a second one.** |
| Nothing else | No GI, no light probes, no irradiance cache exists. `Replaces` is empty and this row says so. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `SurfelGI` implementing `IComputeDriven` | a template scene that constructs it | nothing | n/a | remove it → the template's GI comparison capture reverts to the direct-only baseline |
| 2 | `gi.indirectLight` TSL node | that template's `src/render/postprocessing.ts` output node | nothing | n/a | delete the composite line → the frame is byte-comparable to direct-only; if it is not, the node is leaking into the pipeline somewhere it should not be |
| 3 | Surfel pool + hash grid buffers | `SurfelGI` build, released via PRD-242 | nothing | n/a | `goto` and assert buffers released; a `goto` loop must not grow memory |
| 4 | Cost record | `docs/verification/runtime-perf-state.md` | nothing | n/a | the measurement is its own control: ON/OFF paired arms |

## Execution Phases

### Phase 1 — a GBuffer the solve can read, and nothing else

**Files (4):** `packages/core/src/gi/gbuffer.ts` (NEW), `packages/core/src/game.ts` (EDIT — the pass
is opt-in and off unless something asks for it), tests (NEW), an example (EDIT).

- [ ] Depth, normal and albedo available as TSL nodes. **A game that constructs nothing pays
      nothing** — asserted by a draw-call and timing comparison, not by inspection.
- [ ] No visual change of any kind lands in this phase. If a capture moves, the phase is wrong.

### Phase 2 — surfels cover a static scene, measured not admired

**Proof subject:** an interior with a strong single light source and a coloured wall — the case GI
exists for. A flat outdoor scene lit by ambient would let every assertion pass while proving nothing.

**Files (5):** `gi/surfel-pool.ts`, `gi/hash-grid.ts`, `gi/integrate.ts` (NEW), tests (NEW),
verification record (NEW).

- [ ] Coverage is a **number**: fraction of visible pixels with a live surfel, asserted, not judged.
- [ ] Allocation, ageing and eviction survive a camera sweep with a bounded pool — the failure mode
      is unbounded growth, and it must be asserted against.
- [ ] Cost per frame recorded on the desktop lane, reading `render.p50`, never fps.

### Phase 3 — the node, and one game composites it

**Files (4):** `gi/index.ts` (EDIT — expose `indirectLight`), one template's
`src/render/postprocessing.ts` (EDIT — the one opt-in line), its playtest (NEW), capture baseline.

- [ ] Colour bleed is visible in an A/B capture and the difference is measured, not asserted by eye.
- [ ] **Removing the composite line removes the feature completely** — pasted as the negative
      control, and it is also the charter test made executable.
- [ ] No `gi:` option exists anywhere in `threenative.config.ts`. Grep pasted.

### Phase 4 — the cost verdict, on a phone, with the authority to refuse

**Files (2):** verification record (EDIT), this PRD (EDIT).

- [ ] Paired arms on a physical Pixel 8, GI on and off, cool device, cold launch.
- [ ] **If the cost does not fit a 30 fps floor with headroom, this PRD closes as REFUSED ON COST**
      with the number recorded, and PRD-244 keeps the value: the scene is traceable, and a game that
      wants GI can write it in `src/render/` against buffers the framework already maintains.
- [ ] That outcome is a success for this document, not a failure. A 7 509-line subsystem admitted
      without a device number would be the largest unmeasured thing in the repository.

## Acceptance criteria (consumer-scoped)

- [ ] A shipped template shows colour bleed from a coloured wall onto a neighbouring surface, and
      the A/B capture difference is measured — web and physical Android, both pasted.
- [ ] Deleting one line from that template's `src/render/postprocessing.ts` removes GI entirely, and
      the resulting frame matches the direct-only baseline.
- [ ] Changing the wall's material colour changes the bounce, with no framework file edited.
- [ ] No preset, no `gi: true`, no default composite, no appearance constant in `packages/` — grep
      pasted for each.
- [ ] A game that never constructs `SurfelGI` has identical draw calls and identical frame timing to
      HEAD.
- [ ] Frame cost on a Pixel 8 is recorded, and the PRD states whether it passed or was refused on it.
- [ ] `pnpm budgets` passes, including §10b's line-count justification if the subsystem crosses it.

## Kill switch

§11.2 applies retroactively and unsentimentally. The measurement in Phase 4 has the standing to
delete this whole subsystem, and Phase 2's coverage number has the standing to stop it before Phase
3 is written. Neither is a formality: a GI system that ships and is then always turned off for
performance is worse than no GI system, because the manifest advertises it.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`jure/webgiya` @ `0cd7f968`**.

| To implement | Read |
| --- | --- |
| surfel pool and allocation | `src/surfelPool.ts:1-319`, `src/surfelAllocatePass.ts:1-298` |
| the spatial hash grid | `src/surfelHashGrid.ts:1-934` |
| ray integration | `src/surfelIntegratePass.ts:1-1266` |
| coverage detection and ageing | `src/surfelFindMissingPass.ts:1-595`, `src/surfelAgePass.ts:1-186` |
| the resolve that produces the node we hand back | `src/surfelGIResolvePass.ts:1-373` |
| GPU-computed indirect dispatch args | `src/surfelDispatchArgs.ts`, `src/integratorDispatchArgs.ts` |
| **the line that stays in the game**, and the proof the split already exists upstream | `src/main.ts:709-722` — `postProcessing.outputNode = fxaa(directLight.add(indirectLight))` |
| **do NOT borrow** — look and demo scaffolding | `src/lighting.ts`, `src/content.ts`, `src/ui.ts` |
