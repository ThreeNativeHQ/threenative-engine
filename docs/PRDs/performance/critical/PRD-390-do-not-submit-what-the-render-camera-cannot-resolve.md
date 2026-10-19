---
prd_contract: v1
---

# PRD-390 — do not submit what the render camera cannot resolve

## TL;DR

A shipped game (`sandbox/midway-open-pacific`, RTX 2080, WebGPU) reached its 60 fps target only after
**ten cuts, every winning one game-owned code in `src/render/`**:

| Cut | Measured effect |
| --- | --- |
| far-field cull `FAR_HULL 15000` / `FAR_AIRCRAFT 12000` | draws **1,555 → 849**, triangles **4,902,321 → 2,533,415** |
| projected-size gate: an aircraft under **2 px** is not drawn | 68-aircraft roster **99.6 % → 0.46 %** of frames over 16.67 ms (1472×935) |
| merged single-draw stand-in under **36 px** (`src/render/airframe-lod.ts`) | recovery **16.1 % → 4.2 %** over budget |
| static-transform freeze | `updateMatrix` composes **7,247 → 2,905** per frame |
| HUD drawn once per presented frame, forced layout removed | `drawFlight` **4.518 → 1.000** /frame; Layout events **0.404 → 0** |

None of it is game-specific. All of it is one rule — **do not submit what the render camera cannot
resolve** — that every 3D game needs and none should have to discover.

Three measurements explain the 18 hours. The cost is **per-draw CPU, ~14 µs/draw**, not pixels or
triangles: three US carriers submitted **1.04 M triangles across ~294 draws to cover 34 px** (PRD-386).
An engine optimizer admitted itself on **predicted** draw count, cost **+26 ms/frame**, froze **2.0–3.4 s**
on activation and changed the image, with no game-facing opt-out until the campaign added one
(PRD-388). The engine's own `gpuMs` was **one lagged sample** reporting 3–10 ms when the true cost was
**~17 ms**, sending the search after the wrong term for hours (PRD-389).

Wanted: **projected-size culling on by default in the engine**, gated on what the render camera
resolves; **static transforms as a first-class engine concept the engine never overrides**; the
**frame-cost budget in the scaffold's default playtest**; and the **template `AGENTS.md` entry** that
makes the capability exist.

**Status:** PARTIAL — mechanisms shipped, gates unticked. **Evidence:** `8c182343f` (PR #263,
"render-camera cull by default, projection fixes, honest frame instruments, AutoLOD sibling join")
landed `packages/core/src/render-camera-cull.ts` (+ `render-camera-cull.spec.ts`),
`packages/core/src/render-pass-budget.ts`, the `matrixWorldAutoUpdate` static-transform contract in
`renderProjection.ts`, and the entry in every template `AGENTS.md`. The phase boxes below are
therefore stale, not unmet: they were never ticked because the PRD was written as a specification.
The gates still open are the ones the shipped work does not cover — mobile evidence, the native
`--target` leg, and the second in-repo consumer. Tick each box against its own proof before this
PRD moves to `done/`.
**Date:** filed 2026-09-15.
**Scope:** Engine render-visibility policy and the static-transform contract in `@threenative/core`,
plus the template's default playtest and `AGENTS.md`. No game code, no new package, no new scene format.
**Complexity:** HIGH — the default changes what every existing game draws, which the charter treats as
its highest-scrutiny category.
**Charter:** [`docs/architecture/CHARTER.md`](../../../architecture/CHARTER.md) binds and outranks this
document. §1 ("Conventions ship on by default"), §10a and rule 8 ("Performance is a default, not a
tuning pass") are the whole PRD; §5b (never own the look) is the boundary. No IR, scene format, editor,
preset/genre system, code-first ECS or bespoke CLI vocabulary is introduced. Vocabulary is borrowed from
Three.js, WebGPU and Godot before anything is invented.

**Priority:** P1 — Shipped mechanisms still carry the open gates: mobile evidence, the native `--target` leg and the second in-repo consumer.
## Closure Gates

Every box requires evidence from an implementation revision. Merging this PRD completes none of them.
The reachability column is honest about a single NVIDIA GPU and no mobile hardware.

| Gate | Evidence required | Reachable here |
| --- | --- | --- |
| Projected-size cull is on by default and correct | With no option passed, a real game's sub-threshold objects are absent from submission; a same-build control with the gate disabled draws them; the decision reads the **render camera's** projected size, not player range. | Yes — browser WebGPU, headless adapter named. |
| The threshold is laddered, not picked | A pixel-diff ladder reports per-rung draws/triangles and changed pixels at the ordinary player views against a same-build control (noise floor stated), and the shipped threshold is the conservative rung whose player views are byte-identical. | Yes — browser capture. |
| The override exists and reports | A named per-object/per-scene override keeps the object drawn and reports that it was overridden; turning the gate off does not turn its measurement off. | Yes — browser. |
| Static transforms are honoured, never forced | With `matrixWorldAutoUpdate = false` (or a per-object `matrixAutoUpdate = false`), the engine does not force `updateMatrixWorld(true)`, composes do not return, and a still-moving subtree is still refreshed. | Yes — unit test plus browser; the contract already exists at [`renderProjection.ts:241`](../../../../packages/core/src/renderProjection.ts). |
| The scaffold's default playtest fails on a regression | A scaffolded project's default playtest carries `assert.performance.maxPassDrawCalls` / `maxPassTriangles` derived from representative runs, and an observed budget breach makes it red. | Yes — template/non-visual lane; needs no new hardware. |
| The capability is in the template `AGENTS.md` | The scaffold's `AGENTS.md` names the default, the threshold, the override and the budget, and a doc test fails if it drifts. | Yes. |
| A second consumer, not just Midway | The gate and the budget are exercised by an in-repo example/template consumer with its own playtest, so the landing is not justified by one external game. | Yes — but must be run; Midway is external and not sufficient alone. |
| Native parity | The same source culls by projected size on the owned native host through the real entry point. | Partly — `pnpm native:build` + Dawn on the one GPU; host present, path unproven. |
| Android and iOS run it | Per-platform render and correctness evidence. | **No** — no mobile hardware here; these gates stay open and are named, not silently skipped. |
| The budget holds on a phone | A representative run on mid-range Android hardware. | **No** — no device; the emulator fakes the GPU driver and cannot settle it. |

## 1. Problem and repository grounding

### What the winning cuts have in common

Every cut that won removed **draw submissions the camera could not resolve**, and the mechanism was
game-owned because nothing in the engine offered it:

- `FAR_HULL` was already camera-relative, but `FAR_AIRCRAFT` was **player-relative** — so a fixture
  camera 13–18 km from the formation still paid **420 main draws / 537 k triangles** for aircraft it
  resolved to **0.7–0.9 px**. Tightening the player range alone changed nothing until it started
  deleting engageable aircraft (`report-R68`).
- The 68-aircraft roster's 2 px projected-size gate took over-budget frames from **99.6 % → 0.46 %**
  at 1472×935, with the player's own cockpit, chase and wide frames **byte-identical** and the fixture
  changing 8 of 2,073,600 px (`report-R68`, `report-SUS2`).
- The merged stand-in under 36 px (`src/render/airframe-lod.ts`) took recovery from **16.1 % → 4.2 %**
  over budget with ≤6 px changed in its ladder (`report-RECV`).

This is the charter's own test: the *mechanism* (deciding what is submitted) belongs to the framework;
the *appearance* (the stand-in's geometry, material, colour) comes from the game. `GPUParticles3D` is
the reference shape. The engine can own "is this smaller than N camera-resolved pixels, and if so do
not submit it / swap it"; it must not own what the swapped mesh looks like.

### The two engine failures that hid the cost

- **The optimizer.** `SceneRenderProjection` admitted itself on `WORTHWHILE_DRAW_RATIO` predicted
  draws, added 4.2–5.1 ms/frame of `reconcile` and a 2.0–3.4 s activation freeze, and its batches
  hard-code `frustumCulled = false` so the shadow/reflection cameras cannot cull them (1,742 draws /
  6.60 M triangles projected against 1,741 / 4.92 M declined). PRD-388 owns the self-pricing rule and
  the honest opt-out; this PRD must not add a second culling policy on top of an unpriced one.
- **The instrument.** `gpuMs` is one instantaneous `info.render.timestamp`, lagging up to 8 frames with
  a 3.5× spread; it read 2.98–10.40 ms when the true per-pass GPU was **~17.6 ms** (main 11.9,
  reflection 4.1, shadow 0.7). PRD-389 owns the series/staleness contract. Until it lands, no cut here
  may be justified by `gpuMs`.

### Existing surfaces this PRD must respect

| Existing surface | What this PRD must do |
| --- | --- |
| [`renderProjection.ts:241`](../../../../packages/core/src/renderProjection.ts) `if (this.#source.matrixWorldAutoUpdate === true) this.#source.updateMatrixWorld();` | Preserve it. This is the fixed bug: forcing `updateMatrixWorld(true)` overrode a game's deliberate static marking and recomposed every node. The engine must never take ownership of a game's static transforms again. |
| [`projection-apply.ts:905,988`](../../../../packages/core/src/projection-apply.ts) `proxy.matrixAutoUpdate = false` | The projection already freezes its own proxies. The engine-owned static concept must compose with this, not contradict it. |
| [`renderer.ts`](../../../../packages/core/src/renderer.ts) frame budget and `assert.performance` (`maxFrameMsP95`, `minFps`) on `develop` | The per-pass draw/triangle assertions this PRD requires in the scaffold are **not on `develop`**: they exist on the campaign branch as `edf9a9c3c feat(core,playtest): per-pass draw/triangle attribution and budget assertions` (plus game `45fd225`). This PRD requires that work to land and the scaffold to require it. |
| The batch group key (`batchFlagsOf` keys on `layers.mask`, `castShadow`, `receiveShadow`, `frustumCulled`) | Do not gate on any of these per frame. Flipping `castShadow` split the batch groups, pushed predicted candidates past the worthwhile ratio, and made projection decline the whole scene; the same is recorded for `layers` and `frustumCulled`. **`object.visible` is the one per-frame flag that does not churn grouping** (`report-R68`, `report-O`). |
| `src/render/airframe-lod.ts` (game-owned, shipped) | The proven stand-in shape: one merged geometry, one averaged-colour material, every animated node kept on the full-detail path. The engine may own the *swap decision*, never that geometry. |

## 2. Outcomes and non-goals

**Required:** a projected-size visibility decision that reads the **render camera** and is correct with
no option passed; a conservative default threshold justified by a pixel-diff ladder; a named override
that reports; a static-transform contract the engine never overrides; a per-pass draw/triangle budget in
the scaffold's default playtest, derived from representative runs; the template `AGENTS.md` entry; and
honest reporting of what was culled and why.

**Not required for v1:** a GPU compute cull or indirect draws (that is PRD-386), a meshlet renderer, a
virtual-geometry/LOD system, a new optimizer, a configurable policy language, or unifying this with
`ClusteredMesh`. This PRD is the CPU visibility rule the campaign proved, not the GPU path PRD-386
scopes.

## 3. Mechanism contract

- **The gate reads the render camera.** The projected size is computed from the object's world-space
  bounds and the camera that is about to render it, so the reflection and shadow cameras decide their
  own submission. Player range is a separate, *less* correct guard and must not stand in for it. The
  trap is recorded: an early version culled by player range while a camera 13–18 km away still paid for
  the specks.
- **Default on, override named.** Ordinary games get the gate working with no config, per charter §1.
  The override is a documented field on the same object (or scene), never a fork; it reports when set,
  and disabling the gate does not disable its measurement.
- **Two responses, one decision.** The default response to "below threshold" is **do not submit**. A
  game may instead supply a reduced stand-in, and the engine swaps to it rather than dropping it;
  geometry, material and colour come from the game (charter §5b). The engine owns the swap, never the
  mesh.
- **Static transforms are a first-class concept.** `matrixAutoUpdate = false` (and
  `matrixWorldAutoUpdate = false`) is a promise the game makes, and the engine honours it: it does not
  force a world update, does not recompose a static node, and does refresh a static-marked subtree whose
  parent moved. A game that marks transforms static keeps correct rendering and pays fewer composes; the
  engine never overrides the marking — the measured bug was the engine forcing one.
- **Nothing is culled silently.** The frame report names what was culled, by what threshold and from
  which camera; absence of a measurement is `unavailable`, never zero (PRD-389).
- **The budget is declared, not vibed.** The scaffold's default playtest asserts per-pass draw and
  triangle limits. The limits are re-derived from **five representative runs** on the same tree, not from
  one unrepresentative run: this campaign shipped limits from a single run and the gate was red on the
  shipping tree until `b015f70` re-derived them. A wrong budget is worse than none.

### The default is risky, and the risk is first-class

Culling on by default changes what **every existing game draws**. This is an appearance-affecting
default, the charter's highest-scrutiny category, and it lands only with:

1. **A conservative threshold.** The starting value is **2 projected pixels for aircraft-scale
   objects** and **36 px for the merged stand-in**, both taken as the largest rung whose ordinary player
   views were byte-identical; a threshold is chosen by the **ladder** against a same-build control, never
   by a constant someone liked. No consumer may lose anything a player can identify. If a ladder has no
   conservative rung that saves, the answer is not to ship a guess.
2. **A documented opt-out** on the same object and at the scene level.
3. **Evidence from more than one consumer** before the default lands — the external Midway game alone is
   a demonstration, not a qualification; an in-repo example or template must exercise it with a playtest.
4. **An explicit statement**, in the PRD and the template `AGENTS.md`, that this is an
   appearance-affecting default and where its override lives.

## 4. Dependencies and order

| Depends on | Why | Blocking? |
| --- | --- | --- |
| PRD-389 | A cut may not be justified by `gpuMs` until the number is a series with declared staleness; the per-pass budget assertion needs the same attribution. | Yes — sequence 389 before 390's budget phase. |
| PRD-388 | Do not build a culling policy on top of an optimizer that has not priced its own cost and cannot be turned off. The projection opt-out must ship first. | Yes — sequence 388 before 390's engine phase. |
| PRD-386 | The GPU-driven cut is the same question one layer down; when it lands it must read the same camera-resolved visibility, not a second divergent test. | Record; do not duplicate its mechanism. |
| `edf9a9c3c` (per-pass budget assertions, not on `develop`) | The scaffold budget phase requires it. | Yes — land it first. |

## 5. Execution phases

### Phase 0 — census and ladder

- [ ] On a real consumer, a census reports per-pass draws/triangles and the projected pixel size of
  the objects the cuts would remove, at the ordinary player views.
- [ ] A pixel-diff ladder at the candidate thresholds reports changed pixels at each view against a
  **same-build control** with the gate disabled, with the noise floor stated, and the conservative rung
  named. The player's own views must be byte-identical at the shipped rung.

### Phase 1 — the projected-size gate, engine-owned, default on

- [ ] The engine computes projected size from the render camera and does not submit sub-threshold
  objects, with no option passed.
- [ ] The named override keeps the object drawn and reports; the gate's measurement stays on when it is
  disabled.
- [ ] A game-supplied reduced stand-in is swapped in below the threshold, or the object is dropped; the
  engine owns only the decision.

### Phase 2 — the static-transform contract is first-class and never overridden

- [ ] A game marking a subtree static keeps correct rendering across the projection and shadow/reflection
  paths; the engine does not force a world update over it.
- [ ] A static-marked subtree whose parent moved is still refreshed; a moving subtree is not frozen.
- [ ] The regression at [`renderProjection.ts:241`](../../../../packages/core/src/renderProjection.ts)
  is covered by a test that fails if the engine again forces `updateMatrixWorld(true)`.

### Phase 3 — the budget in the scaffold, and the docs that make it exist

- [ ] The default scaffolded project's playtest carries `assert.performance.maxPassDrawCalls` /
  `maxPassTriangles` per pass.
- [ ] The limits are re-derived from five representative runs on the shipped tree, and a scratch copy
  with the cull reverted fails the gate (the budget measures the defect, not a number).
- [ ] Every template's `AGENTS.md` states the default, the threshold, the override and the budget, and a
  test fails on drift.

### Phase 4 — second consumer and native proof

- [ ] An in-repo example/template consumer exercises the gate and the budget with its own playtest, so
  the landing is not justified by Midway alone.
- [ ] The same source culls by projected size on desktop native through the real entry point.
- [ ] Android/iOS gates are backed by target evidence or explicitly left open with the missing lane
  named.

## 6. Completion boundary and references

Complete only when an ordinary scaffolded project gets the visibility rule and the frame-cost budget by
doing nothing, the static-transform contract is honoured by the engine and covered by a regression that
fails on the old forcing behaviour, a second consumer proves it, and a reverting scratch copy fails the
scaffold budget — with revision-linked evidence. A budget derived from one unrepresentative run does not
satisfy the gate; neither does a threshold chosen without a ladder.

**Verification:** browser WebGPU with a named adapter (`--browser-recipe webgpu`, `adapter.info`);
per-view pixel diffs against a same-build control with the noise floor stated; deterministic counts
(draws, triangles, composes) rather than frame times; the scaffold/non-visual lane for the budget and
`AGENTS.md` tests; desktop native via `pnpm native:verify:desktop`. Report actual runs, or say
"unverified". Desktop is never an fps verdict; the phone owns fps.

This PR changes this PRD and the [critical README](README.md) only. No source, package, workflow or
previous PRD status is changed by its merge.
