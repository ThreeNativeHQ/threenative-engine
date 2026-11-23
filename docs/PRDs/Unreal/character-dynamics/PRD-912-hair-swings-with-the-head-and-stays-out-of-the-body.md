---
prd_contract: v1
---

# PRD-912 — Hair swings with the head and stays out of the body

**Status:** IN PROGRESS (2026-11-23) — `SpringBoneChain3D` ships with Unreal SpringBone defaults (stiffness 50, damping 4, 1/120 s step) and 7 unit tests. The scene has a 6-bone ponytail in every arm; `?arm=hair` simulates it against a head sphere and a neck capsule. Measured, owned engine, 1 run: tip offset 0.05–0.57 m (rigid control ≈ 1e-7 m), segment stretch ≤ 7e-6, 0–2 bones inside the probe shapes (the nape root bone, not a simulated segment). The colliders are placed by hand, not auto-measured, so the Phase 1 collider box stays open.
**Priority:** P2 — No hair moves today. A character request with a ponytail or long hair gets a rigid mesh.
**Complexity:** 7 (HIGH) — spring bone chain (+1), GPU guide strands transliterated from WGSL (+2), card skinning to guides (+2), shared colliders and wind (+1), native proof (+1)
**Owner:** João
**Depends on:** [PRD-910](PRD-910-a-running-character-proves-its-cape-and-hair-in-one-scene.md) (scene, hair probe, reference). Reuses the body colliders and `WindField3D` from [PRD-911](PRD-911-a-cape-on-a-skinned-character-trails-swings-and-stays-out-of-the-body.md).

## Context

Unreal moves hair in two tiers. The cheap tier is a bone chain: `AnimNode_SpringBone` with stiffness 50, damping 4 and a 1/120 s step, and AnimDynamics (`UE 5.8.3: Engine/Source/Runtime/AnimGraphRuntime/Private/BoneControllers/AnimNode_SpringBone.cpp:16-20`, `AnimNode_AnimDynamics.cpp:202-203,1151-1157`). The full tier is the groom Niagara solver on guide strands, with 5 substeps, 5 iterations, stretch 1, bend 0.01 and air drag 0.1. Render strands follow the guides by root-frame interpolation (`Engine/Plugins/Runtime/HairStrands/Source/HairStrandsCore/Private/GroomAssetPhysics.cpp:8-80`, `Shaders/Private/NiagaraInterpolateGroomGuides.usf:104-147`). frostbitten-hair-webgpu (MIT) holds a working GPU guide solver in WGSL: Verlet, length, global shape, local shape, and sphere and SDF collision.

## Solution

- **Bone chains, the default for game characters.** `SpringBoneChain3D` is a `Skeleton3D` modifier, in Godot's `SpringBoneSimulator3D` vocabulary. It takes a root bone name and simulates the chain below it with Unreal's SpringBone defaults, a stretch limit and a reset past an error threshold. It suits a ponytail, braids, ears, tails, a scarf on bones and dangling props. The work is tiny per bone, so it runs on the CPU in the fixed step; it has no GPU round trip.
- **Guide strands, for hair cards and strands.** `HairStrands3D` takes guide curves (from a GLB curve, card spines, or generated), and simulates them in TSL compute. The kernel is a line-by-line transliteration of the frostbitten WGSL, with its MIT header. Cards (PRD-909) or ribbons (PRD-671) follow the guides in their position node, so the sim never leaves the GPU.
- **Shared world.** Both read the PRD-911 body capsules (head and neck capsules auto-measured) and `WindField3D`. Both have teleport and reset guards with the PRD-911 thresholds.
- **Auto by default.** The chain stiffness and damping are Unreal's. Segment rest lengths come from the bind pose. Collider radii come from the skin. Each value has a named override.
- **Searchable.** `@situation` lines cover "ponytail", "long hair moves", "braid", "tail swings", "hair cards follow the head" and "jiggle bones".

## Acceptance Criteria

- [x] AC-1: On the PRD-910 scene (`?arm=hair`), no hair vertex enters the head or neck capsule beyond its thickness in any phase. proof: `examples/character-dynamics/playtests/acceptance.playtest.json` — 2026-11-23: `acceptance-hair.playtest.json` on `?arm=hair` exits 0; `hairInsideHead` 0 in all eight phases, 2 runs. The first run read 1 in snapTurn: the segment-length projection pulled a pushed-out particle back into the head sphere. `SpringBoneChain3D` now alternates push-out and length up to 4 rounds (red-green: `spring-bone-chain.spec.ts` "keeps a particle out of a sphere that its length constraint would pull it back into").
- [x] AC-2: The max hair segment stretch stays ≤ 5% in every phase. proof: same scenario. — 2026-11-23: `acceptance-hair.playtest.json` on `?arm=hair` exits 0; `hairStretch` ≤ 7e-6 in every phase, 3 runs.
- [ ] AC-3: The ponytail tip swing after the hard stop and the snap turn is within the Unreal reference ± its 3-run spread. proof: same scenario against `tools/unreal-reference/character-dynamics/reference.json`.
- [ ] AC-4: Hair simulation costs ≤ 0.15 ms GPU at 1080p on the RTX 2080 owned-engine lane for 2,000 guides of 16 points, with no steady-state readback. proof: `node packages/playtest/dist/runner/cli.js perf` with `?probe=0`.
- [ ] AC-5: A fresh visual judge returns IMPROVEMENT over the rigid-hair arm on the hard-stop, jump and snap-turn frames. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judge subagent.

## Execution Phases

#### Phase 1: Bone chains

- [ ] `SpringBoneChain3D` swings the mannequin's ponytail chain with Unreal's defaults and resets past the error threshold. proof: `pnpm exec vitest run packages/core/__tests__/spring-bone-chain.spec.ts` plus AC-3.
- [ ] The chain collides with the auto-measured head and neck capsules. proof: AC-1 on the chain arm.

#### Phase 2: Guide strands on the GPU

- [ ] The frostbitten solver is transliterated to TSL, with its MIT header and a notice line. A unit spec checks length and shape constraints on one strand. proof: `pnpm exec vitest run packages/core/__tests__/hair-strands.spec.ts`
- [ ] Hair cards follow their guides through the position node, with no readback. proof: AC-2 and AC-4.

#### Phase 3: Every engine, every agent

- [ ] The desktop host runs the hair arm with conformance parity. proof: `pnpm parity --target desktop --only-tests hair-guides`
- [ ] A cold `engine_search_capabilities` for "ponytail" and "hair that moves" returns these rows first. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`

## Blocked on

- none.

## Decisions

- 2026-11-22 (agent): two tiers, as in Unreal. A bone chain covers most game characters at almost no cost. Guide strands are for card or strand hair that needs many guides.
- 2026-11-22 (agent): transliterate the frostbitten simulation only. Its software rasteriser and tile OIT do not fit the three.js render pipeline (PRD-671 owns strand drawing).
