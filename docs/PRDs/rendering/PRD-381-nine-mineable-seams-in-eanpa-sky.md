---
prd_contract: v1
---

# PRD-381 — nine mineable seams in Eanpa-Sky

**Status: PROPOSED, 2026-09-11.** Filed for later. Nothing here is built, measured or scheduled;
no box below may be ticked from this filing.

**Priority:** P2 — Open ACs are seam-mining checks that file child PRDs per observed row.
**Complexity:** +1 for 1–5 implementation files (rows 1 and 2 only; rows 3–7 carry their own
scores in their own PRDs), +2 for a renderer adapter with cache-lifetime semantics = **3 → LOW
mode.** Self-review at each checkpoint.

**Owner:** unassigned
**Depends on:** none. Related: [PRD-360](../done/PRD-360-android-launch-is-playable-within-eight-seconds.md)
(launch shader count), [PRD-248](../done/PRD-248-the-atmosphere-is-luts-the-sky-is-the-games.md)
(the sky is the game's).

Mined read-only from **[`SkyeShark/Eanpa-Sky`](https://github.com/SkyeShark/Eanpa-Sky)** at
`2b7a5518a8ec6b3b2d679c2eb40dc3ba75318384` (v0.2.1, 2026-09-11), cloned at depth 1 and read. MIT,
same as this repository. Every claim about that source is cited by file and line against that
commit; every claim about this repository is cited against `HEAD` at filing. **No row here claims a
measurement — nothing has been run.**

## 1. Context

Eanpa-Sky is a volumetric sky and weather engine for `three` WebGPU/TSL (29,638 lines of `src/` +
`engine/`) shipped inside a playable first-person desert world. Almost all of it is *look* —
skyboxes, storm canopies, red giants, puddle noise — and under this repository's rules that is
generated user source, not framework code. Nine things in it are not look. They are mechanisms a
game repeats and none should write. A first pass stopped at three; reading the remaining
twenty-five files found six more gaps, and confirmed four candidates as already covered here.

**Manifest searched before filing** (`engine_search_capabilities`, four situations):

| Situation searched | Best hit | Gap |
| --- | --- | --- |
| a moving overhead cloud layer darkens every surface | `WaterSurface3D` (0.48) | no overhead attenuation field |
| shadow pass recompiles shaders every frame | `createPipelineCensus` (0.60), `VirtualShadowNode` (0.30) | census can *measure* it; nothing fixes it |
| is a point under cover or exposed to the sky | `buildStaticColliders` (0.88) | no visibility/exposure query |
| prepare every pipeline before the first frame | `ComputeDrivenRegistry` (0.73) | `packages/core/src/warmup.ts` is the incumbent |

### The ledger

Thirteen candidates, every one read. Nine are gaps here, four are already covered — the covered
rows are recorded because a later round that re-mines this source must not re-propose them.

| # | Seam | Eanpa source | Incumbent here | Verdict |
| --- | --- | --- | --- | --- |
| 1 | **Stable shadow-pass material variant per source material.** `three` r184 shares one mutable override material across every caster; alternating opaque and alpha-tested casters bumps its `version` on each switch, so every previously drawn caster rebuilds its cache key. | `src/shadow_material_cache.js:1-9` (defect statement), `:44-55` (real graph changes still invalidate), `:57-66` (`renderer.renderObject` wrap) | none. `VirtualShadowNode` uses `light.shadow.shadowNode` and inherits the same override path | **MINE — in place.** A defect fix with no appearance decision in it, and `createPipelineCensus` already exists to red it |
| 2 | **The emissive target is allocated only when something emits.** A conservative scene test: dynamic node outputs stay eligible even when currently black; an override material answers for the whole scene. | `src/visible_emission.js:1-16` | `RenderChain` composes stages and reports the tier; nothing asks the scene whether the target is needed | **MINE — in place.** Auto by default: the engine can measure this where it is used, so it should decide |
| 3 | **A surface knows whether the sky can see it.** One orthographic depth/normal capture along a chosen direction, published as `visibilityAt(worldPos, biasMetres)`; includes off-screen roofs and ordinary/instanced/skinned opaque geometry, no terrain height callback. | `engine/rain_surface_field.js:1-3`, `:4-20`, `:21-31` (`renderGroup` uniforms), `:41`, `:141`. Consumed by rain (`engine/weather_system.js:1312`), storm opacity (`:479`), audio shelter (`src/audio_system.js:937`) | none | **MINE — own PRD.** The game owns the direction, the radius and every use of the scalar |
| 4 | **An overhead field the whole world samples.** Light-column transmittance in a two-tile atlas, texel-snapped to a world lattice with a guard band, temporally blended between completed captures. | `engine/cloud_shadow_map.js:1-3`, `:18-20` (the game's `transmittance(p)` *is* the fragment node), `:27-37`, `:48-96` | `VirtualShadowNode` (sun shadow only) | **MINE — own PRD, conditional.** `GPUParticles3D` shape. Must pass the kill switch first |
| 5 | **A dynamic local reflection probe.** Parallax-corrected cube capture filling what SSR cannot see; six faces refresh over six frames and **only a completed cube is prefiltered and published**, so the visible frame never reads a half-updated probe; two PMREM outputs blend. | `src/local_reflection_probe.js:1-3` (the contract), `:6-16` (cube, camera, two prefiltered targets) | `ProbeVolume` bakes **static diffuse irradiance**; `ssr` is the screen-space stage. Neither is a dynamic local specular probe | **MINE — own PRD.** Mechanism: capture cadence, completeness, prefilter. The game owns position, size and every material that samples it |
| 6 | **Analytic colliders that stream around the player for instanced content.** Rendering keeps the authored GLBs; physics never duplicates those triangles — small capsule unions are allocated inside `activeRadius` 7 m and released at 9.5 m, on a 0.12 s / 1.25 m cadence. Written dependency-free so the contract is CPU-testable without a renderer. | `src/vegetation_collision.js:1-20` (the split), `:96` (`makeVegetationCollisionProxy`), `:350` (`createVegetationCollisionStreamer`) | `buildStaticColliders` is a one-shot trimesh build over authored meshes; nothing streams, and nothing serves instanced or batched content | **MINE — own PRD.** The largest gap found. A game with a million grass candidates (PRD-255) has no answer today for colliding with them |
| 7 | **A viewmodel layer.** First-person arms draw with the camera through the same render pipeline while staying out of world collision, reflections, shadows, terrain queries and body physics — one reserved layer, enabled on the world camera and disabled for every capture. | `src/first_person_viewmodel.js:1-3` (the contract), `:70`, `:94` (layer 31), `:133` (layer 30 for its own lights), `:414` (disabled for captures) | none. `CharacterBody3D` is the body, not the seam | **MINE — own PRD.** "A weapon stays in the hand that holds it" is already a stated convention here; this is the missing mechanism under it |
| 8 | **Shadow refresh cadence for lights that are not the sun.** `light.shadow.autoUpdate=false` plus an explicit Hz budget; a moved light or target invalidates immediately. | `src/shadow_refresh.js:1-16` | `VirtualShadowNode` does this properly for a `DirectionalLight`, and only for one | **PARTIAL — narrow row.** Extend the existing discipline to spot and point lights, or decline; do not add a second shadow system |
| 9 | **A screen-space trace as a node the game composites,** with `sampleRadiance` supplied by the caller, plus receiver ids packed into normal-buffer alpha so only explicitly convex groups reject their own pixels. | `src/screen_space_trace.js:1-16`, `src/reflection_receiver_id.js:1-15` | `ssr` and `ssgi` ship as chain **stages** | **PARTIAL.** A stage is not a node; take it only if a real caller needs the trace inside its own lighting lobe |
| 10 | Bounded-concurrency pipeline build queue and exact pass/attachment/override reuse at precompile (`STARTUP_REVIEW.md`: 132 s to 42 s local cold Shieldworld, uncontrolled conditions). | a **fork of vendored `three`** — `vendor/three/three.webgpu.js:54296`, plus `src/main.js:1119-1165` | `packages/core/src/warmup.ts` slices at the scene level and reports progress | **DEFER.** The missing part is inside the renderer, so it is an upstream `three` change. PRD-360 already measured four warm-up shapes and lost on all four |
| 11 | Retiring obsolete draw objects and TSL-generated instance attributes on a full scene rebuild. | `src/rebuild_resource_cache.js:1-5`, `:39-59` | none | **DEFER.** Reaches `renderer._objects` / `renderer._attributes`, explicitly pinned to those internals; no equivalent native seam |
| 12 | Per-draw material gating: one shared material, per-object parameters via `uniform().onObjectUpdate(({ object }) => object.userData…)` — "receiver flags must follow the draw, not the first mesh". Retry-with-backoff on a transient asset fetch (`src/asset_blob.js:1-14`). Copy view state instead of `Camera.clone()`, which in this `three` revision also clones the host's attached hands, lights and player rig (`src/sky_geometry_layer.js:6-9`). | `engine/weather_system.js:1301-1307` | stock `three` TSL; ordinary loading code | **DOCUMENT ONLY.** No code to write. These are traps, and a convention missing from the templates' `AGENTS.md` does not exist |
| 13 | Static instancing by spatial cell / loop-seam crossfade / step-up onto a low kerb / parallax occlusion mapping | `src/static_instances.js:1-16`, `src/audio_loop.js:1-16`, `src/movement_step.js:1-9`, `src/parallax_occlusion.js:1-6` | `projection-apply.ts:380,386` already rejects mirrored instances and `ClusteredBatch` ships; `audioPass` measures the loop seam **at build time and fails the build**, which is stronger; `CharacterBody3D.ts:117-123` exposes Rapier autostep; POM is already an upstream `three` addon a game can import | **NO — covered.** Recorded so a later round does not re-propose them |

**Attribution.** Rows 1–3 are to be re-derived against this repository's own types and tests, not
copied. If any file lands as a derivation of Eanpa-Sky source, it carries the MIT notice and a
credit line, the way Eanpa-Sky itself credits CK42BB in its README.

## 2. Solution

**This PRD is the ledger and the gate, not nine implementations.** Nine rows is four times a MEDIUM
closability budget, and a PRD carrying nine open implementations is the 46–67-box shape that never
closes. So the work splits:

- **Rows 1 and 2 land here.** Both are small, both are defect-or-default fixes with no new public
  concept, and both already have their instrument: `createPipelineCensus` for the shadow variant
  churn, and the existing `RenderChain` observation for an emissive target that was allocated and
  never written. Neither needs a child PRD to justify a screenful of code.
- **Rows 3–7 each get their own PRD**, opened only after Phase 1 clears it. Each is a new public
  capability with its own consumer, its own kill-switch score and its own playtest.
- **Rows 8 and 9 stay parked** until a real caller needs them. A narrow extension to
  `VirtualShadowNode` and a node-level trace are both cheaper to judge with a game in hand.
- **Rows 10–13 are closed** in this file. Nothing to open.

Shapes for the two rows that land here:

- **Row 1** — `installShadowVariantCache(renderer)` (name provisional), returning `{ stats, dispose }`.
  Wraps the renderer's `renderObject`, keyed by `(overrideMaterial, sourceMaterial)`, releasing on
  either one's `dispose`. It decides nothing about how anything looks: the same shadow is drawn,
  with fewer pipeline rebuilds.
- **Row 2** — a conservative "does anything in this scene emit" test consulted where the emissive
  target is provisioned. Dynamic node outputs stay eligible even when currently black; an override
  material answers for the whole scene. Wrong in the safe direction: it never skips a target the
  frame needs.

**Risk, stated plainly.** Rule 1(a) asks whether a game could write these portably itself. Rows 3–7
need no browser global and no platform seam — a game *could* write them. They are proposed under
the "plumbing every game repeats and none should write" clause plus the kill switch, and the honest
outcome of Phase 1 may be that some are declined. A declined row is a result, not a failure;
PRD-252 and PRD-260 both closed as declines.

## Acceptance criteria

- [ ] **AC-1** [local; actor: agent]: the shadow-pass pipeline churn is observed before the fix and
      absent after it, through `createPipelineCensus` on a scene alternating opaque and
      alpha-tested casters under a shadow-casting directional light — Evidence: pending.
- [ ] **AC-2** [local; actor: agent]: a scene with nothing emissive runs without provisioning the
      emissive target, and a scene whose only emitter is a dynamic node currently evaluating to
      black still provisions it — Evidence: pending.
- [ ] **AC-3** [local; actor: agent]: every row 3–7 carries either a filed child PRD number or a
      written decline with the measurement that declined it; no row is left undecided — Evidence:
      pending.
- [ ] **AC-4** [local; actor: agent]: row 12's three traps are in the templates' `AGENTS.md`, where
      a convention has to be for it to exist — Evidence: pending.

## 4. Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Stable shadow variant | a template's render setup → `@threenative/core` export; fill actual `file:line` in Phase 2 | adds to the stock shadow path; nothing removed | AC-1 |
| Emissive target decided automatically | the existing emissive-target provisioning path; fill actual `file:line` in Phase 2 | replaces an unconditional allocation | AC-2 |
| Rows 3–7 | each child PRD owns its own ledger row | new; no incumbent | AC-3 |

## 5. Execution Phases

#### Phase 1: the gate, before any code
**Status:** NOT STARTED
**ACs:** AC-3, AC-4
**Files:** this PRD; `templates/*/AGENTS.md` for row 12.
**Implementation:** For each of rows 1–7, answer the two questions and the kill switch in writing
against `HEAD`: could a game write it portably; does it decide how anything looks; what does
`scripts/count-loc.ts` score it at across two call sites. Re-run `engine_search_capabilities` and
`engine_capability_detail` on every near hit — four rows already died that way and more may.
File a child PRD for each survivor among rows 3–7; write the decline for the rest.
- [ ] Rows 1–7 each carry a verdict with a `count-loc` number or a decline reason.
- [ ] Every surviving row among 3–7 has a filed child PRD number recorded in this table.
- [ ] Row 12's three traps are written into the templates' `AGENTS.md`.

#### Phase 2: the two fixes that need no PRD of their own
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `packages/core/src/` (adapter + export, emissive-target decision),
`packages/core/__tests__/`, one playtest scenario.
**Implementation:** Row 1 wraps `renderer.renderObject` only while `scene.overrideMaterial` is the
shadow material and the drawn material allows override; explicit custom-shadow graph changes and
normal invalidation must still work (`shadow_material_cache.js:44-55` is the reference for what must
*not* be swallowed), and variants release on either material's `dispose`. Row 2 consults the scene
test where the emissive target is provisioned, defaulting to provisioning it.
**Verification:** E1 — unit specs reading `createPipelineCensus` and the render-chain observation,
each red before its fix; plus one playtest scenario on a template that casts shadows, on a real build.
- [ ] Red observed for row 1: census reports the rebuild churn without the adapter.
- [ ] Red observed for row 2: the target is provisioned for a scene with nothing emissive.
- [ ] Both green, dispose releases every variant, and the playtest passes on a real build.

## 6. Not mined, and why

`weather_system.js` (2,374 lines), `sky_system.js` (2,871) and `terrain_real.js` (3,493) are the
game. Eight weather states, a storm canopy, a red giant, puddle noise thresholds, Mojave flora and
wind response are all appearance decisions, and this repository ships those as generated source in
`src/render/` — the same answer PRD-248 already gave for the sky itself. The interesting part of
that code is not portable capability; it is the comment density (`weather_system.js:1300-1345` names
the failure each line prevents), which is a documentation lesson, not a PRD.
