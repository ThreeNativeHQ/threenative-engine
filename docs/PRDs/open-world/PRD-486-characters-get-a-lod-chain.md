# PRD-486 — Characters get a LOD chain

**Status:** PROPOSED
**Priority:** P2 — AutoLOD still declines skinned and morph primitives; shared-attribute chains unbuilt.
**Complexity:** 4 (MEDIUM) — 6–10 engine files (+2: `lod/eligibility.ts`, `lod/generate.ts`, `model-lod.ts`, `projection-skinned.ts`, the crowd example); pose-sampled error is a new module in `packages/assets/src/lod/` (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-377](../assets/PRD-377-auto-lod-is-on-by-default.md) (the discrete-LOD contract, PARTIAL); builds on [PRD-448](../done/PRD-448-cross-platform-asset-cooking-and-device-budgets.md), which deferred skeletal reduction to separate work (its non-goals table, line 87)

## Context

AutoLOD declines every character. `classifyPrimitive` returns `deforming` in three cases: a skinned owner (`packages/assets/src/lod/eligibility.ts:186`), morph targets (`:190`), and `JOINTS_0`/`WEIGHTS_0` attributes (`:194`). As a result, characters and MetaHumans always draw LOD0:

| Subject | Triangles | Rig | Morphs |
| --- | --- | --- | --- |
| `packages/create-threenative/template-assets/assets/mannequin-combat.glb` (shooter, action-rpg) | 13,744 | 1 skin, 33 clips | none |
| `../sandbox/metahuman-lab/content/specimen.glb` (licensed, local only) | 101,518 | 1 skin | 10 primitives, up to 821 targets |

Two existing facts keep this small:
- **Levels are index-only views over LOD0's vertices** (`packages/assets/src/lod/generate.ts:5`). A level never moves or rewrites a vertex, so skin weights and morph deltas are valid at every level by construction. What is missing is a *safe choice of triangles*. The simplifier (`MeshoptSimplifier.simplifyWithAttributes`, `generate.ts:661`) never sees joint influences, and the error it records is measured in bind pose only.
- **Runtime selection swaps `mesh.geometry`** (`packages/core/src/model-lod.ts:392`), and it uses the base geometry's bind-pose bounding sphere (`:892–908`). `isDeforming` (`:494`) only guards the opt-in joined rung. The skinned palette (`packages/core/src/projection-skinned.ts`) makes one instanced draw per shared geometry and material, so each level becomes its own palette draw.

`examples/skinned-crowd` draws 64 procedural tubes with one palette draw per pass (`playtests/crowd.playtest.json`, `maxDrawCalls: 8`). It has no GLB character and no LOD.

## Solution

1. **Bake.** Admit skinned and morphed primitives. Pass `WEIGHTS_0` to the simplifier as attributes so collapses respect influence boundaries. Record each level's error as the maximum over poses sampled from the asset's own clips, not the bind pose. A level still shares every vertex attribute and morph target.
2. **Run.** For a `SkinnedMesh`, `model-lod` selects from a posed sphere built from the bones, not the vertices. The sphere covers the world positions of the skeleton's bones, padded by the largest distance from a vertex to its heaviest bone, computed once per level at load from the bind pose. That costs O(bones) per frame. three's `SkinnedMesh.computeBoundingSphere` runs every vertex through the skinning transform on the CPU (`three/src/objects/SkinnedMesh.js:138-160`), about 13,744 vertex transforms per mannequin per call, so it is not called per frame. The palette draws a crowd at mixed levels as one draw per level per pass.
   Unreal makes the same choice. A visible rig takes its bounds from its physics-asset bodies, which are shapes attached to bones. A rig that is not visible, or that has fixed bounds, takes the asset bounds offset by the root bone. Per-vertex posed bounds come only from the GPU skin cache, and only on higher-end platforms (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp:2225-2295`, `Private/GPUSkinCache.cpp:205-215`).
3. **Measure.** Add a mannequin crowd to `examples/skinned-crowd`, then decide morph handling from numbers (Decisions).

## Decisions

- 2026-10-03 (agent, proposed): morph targets stay on every level by default. Index-only levels share LOD0's morph buffers, so keeping them costs no bytes, only vertex work on fewer referenced vertices. They are dropped at far levels only if the Phase 3 morph box shows the far rung's GPU time with 821 live targets is materially above the stripped arm. The result and the threshold used go here.
- 2026-10-03 (agent, proposed): no bone or skeleton reduction. A far character still runs its full skeleton. That is PRD-448's separate "skeletal/facial/bone reduction" work, and it is not needed for a triangle chain.
- 2026-10-09 (João, via the Unreal review request): the bone-reduction deferral above stands, and Unreal shows what the later work involves. Each Unreal LOD carries its own `RequiredBones` and `ActiveBoneIndices` lists, so a far level also evaluates fewer bones (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/SkeletalMeshLODRenderData.cpp:560-591`). Unreal also lets a LOD level choose an animation frame-skip (`Classes/Engine/EngineTypes.h:2787-2794`). Evaluation rate by screen size is [PRD-570](../Unreal/animation/PRD-570-a-character-costs-what-the-camera-sees-of-it.md), not this PRD.
- 2026-10-09 (João, via the Unreal review request): posed bounds are built from bones, not vertices (Solution step 2), following Unreal's physics-asset bounds. The Phase 2 bounds box was re-worded to forbid the per-frame per-vertex walk.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Skinned/morphed chain bake | `threenative build` → model pass → `generateDiscreteLod` (`packages/assets/src/passes/model.ts:934`) → `classifyPrimitive` | `deforming` skip for skins and morphs; removed (kept for joined rungs) | Phase 1 |
| Skinned runtime selection | `ctx.assets.model()` → `model-lod` selector → `projection-skinned` palette | LOD0-only draw of every rig | Phase 2–3 |

## Blocked on

- Android frame time for the crowd needs a physical phone, because the emulator cannot hold a performance claim. It is unblocked when João attaches the Pixel 8.

## Execution Phases

#### Phase 1: The bake admits characters
**Status:** NOT STARTED
**Files:** `packages/assets/src/lod/eligibility.ts`, `packages/assets/src/lod/generate.ts`, a pose sampler beside them; `packages/assets/__tests__/lod-generation.spec.ts`
- [ ] [local] A skinned primitive and a morph-target primitive each get a chain. Every level shares `JOINTS_0`, `WEIGHTS_0` and every morph target unchanged. proof: red-green cases in `pnpm exec vitest run packages/assets/__tests__/lod-generation.spec.ts` on `test-support/fixtures/skinned-character.glb` plus a morph fixture.
- [ ] [local] On `mannequin-combat.glb`, each level's recorded error bounds the skinned deviation from LOD0 at every pose sampled from its 33 clips, and the far rung is at most 25% of 13,744 triangles. proof: new `packages/assets/__tests__/lod-skinned.spec.ts`.

#### Phase 2: The runtime selects for rigs
**Status:** NOT STARTED
**Files:** `packages/core/src/model-lod.ts`, `packages/core/src/projection-skinned.ts`
- [ ] [local] A `SkinnedMesh` whose clip carries it 3 m from its bind-pose bounds selects from the bone-built posed sphere, not the bind-pose one, and the selector never calls `SkinnedMesh.computeBoundingSphere` per frame. proof: red-green case in `pnpm exec vitest run packages/core/__tests__/model-lod-runtime.spec.ts`.
- [ ] [local] 64 palette rigs split across three levels draw as three instanced draws per pass, each with the right instance count. proof: `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`.

#### Phase 3: A crowd, measured
**Status:** NOT STARTED
**Files:** `examples/skinned-crowd/src/scenes/`, `examples/skinned-crowd/playtests/crowd-lod.playtest.json`
- [ ] [local] Web: 256 `mannequin-combat` rigs receding to 120 m submit at most 40% of the LOD0 arm's triangles, with GPU p95 no higher than LOD0, both arms from one build. proof: `crowd-lod.playtest.json --browser-recipe webgpu` with `playtest perf`, adapter named.
- [ ] [local] Native desktop: the same scenario passes its triangle assertion. proof: `node packages/playtest/dist/runner/cli.js examples/skinned-crowd/playtests/crowd-lod.playtest.json --target desktop`.
- [ ] [local] The crowd at 10, 40 and 120 m shows no visible loss against LOD0. proof: `pnpm visuals:ab --before <lod0> --after <chain> --out <dir>` plus a fresh judge subagent.
- [ ] [local] Morph cost measured: `specimen.glb` far-rung GPU time with all morph targets against the stripped arm, recorded under Decisions. proof: `metahuman-lab/playtests/presets-replay-lod.playtest.json` with `playtest perf`, both arms.
