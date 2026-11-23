---
prd_contract: v1
---

# PRD-912 — Hair swings with the head and stays out of the body

**Status:** IN PROGRESS (2026-11-23) — Tier 1: `SpringBoneChain3D` passes AC-1 and AC-2 on `?arm=hair` (tip swing 0.30–0.59 m). Tier 2: `HairStrands3D` (frostbitten kernel in TSL, Unreal groom defaults and its stretch projection) passes the same bounds on `?arm=strands` with 64 guides drawn as ribbon cards; its tip swings only 1–3 cm, because the global-shape constraint holds most of the strand. AC-3 (Unreal swing), AC-4 (cost), AC-5 (judge) and desktop parity are open.
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

- [ ] `SpringBoneChain3D` swings the mannequin's ponytail chain with Unreal's defaults and resets past the error threshold. proof: `pnpm exec vitest run packages/core/__tests__/spring-bone-chain.spec.ts` plus AC-3. — 2026-11-23, open on AC-3 only: the unit half passes (9/9, including "resets to the pose when a particle strays past the error distance").
- [x] The chain collides with the auto-measured head and neck capsules. proof: AC-1 on the chain arm. — 2026-11-23: the scene takes the head and neck capsules from `measureBodyCapsules` (Unreal's physics-asset rule merges the head into `neck_01`: one capsule, r 0.105 m) and passes them to `SpringBoneChain3D`; `acceptance-hair.playtest.json` exits 0 on `?arm=hair` in 2 runs, `hairInsideHead` 0 in every phase.

#### Phase 2: Guide strands on the GPU

- [ ] The frostbitten solver is transliterated to TSL, with its MIT header and a notice line. A unit spec checks length and shape constraints on one strand. proof: `pnpm exec vitest run packages/core/__tests__/hair-strands.spec.ts` — 2026-11-23, open on the unit half: `packages/core/src/hair-strands.ts` (`HairStrands3D`) carries the kernel with its MIT header, and `THIRD_PARTY_NOTICES.md` has the entry. `hair-strands.spec.ts` (4/4) covers rest lengths, one reset then one dispatch per substep, the 50 cm teleport reset, the WindField3D read and the fail-closed inputs. It cannot run the kernel: vitest has no GPU, so the length and shape behaviour is proved on the GPU instead — `acceptance-hair.playtest.json` on `?arm=strands` exits 0 in 3 runs before the 2026-11-23 rig move and 1 after it, `hairStretch` 0 and `hairInsideHead` 0 in all eight phases. Port decisions: Unreal groom defaults (5 substeps, 5 iterations, air drag 0.1 with its drag formula, 0.01 cm thickness, 1 g/cm³); frostbitten stiffnesses; capsules replace the sphere and SDF; the grid is dropped, and with it `friction`, which only mixes toward the grid's mean velocity. Unreal's root-to-tip stretch projection ends each substep (`NiagaraHookeSpringMaterial.ush:28-53,93-118`): without it, stretch reached 5.9–7.9% at 5 iterations and 5.5% at frostbitten's own 7.
- [ ] Hair cards follow their guides through the position node, with no readback. proof: AC-2 and AC-4. — 2026-11-23, AC-2 half met: the strands arm's ribbon cards read `HairStrands3D.positions` in their position node (readback is only the probe's, `readbackEveryFrames: 2`, off by default); `hairStretch` 0 in every phase. AC-4 (GPU cost of 2,000 guides) is not measured yet.

#### Phase 3: Every engine, every agent

- [ ] The desktop host runs the hair arm with conformance parity. proof: `pnpm parity --target desktop --only-tests hair-guides`
- [x] A cold `engine_search_capabilities` for "ponytail" and "hair that moves" returns these rows first. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — 2026-11-23: `search.spec.ts` "leads 'ponytail' / 'hair that moves' with SpringBoneChain3D", 2/2 pass with a clean `TMPDIR`. `HairStrands3D` rows joined it on 2026-11-23: "hair cards follow the head" and "simulate hair guide strands on the GPU" lead with it (4/4).

## Blocked on

- none.

## Decisions

- 2026-11-22 (agent): two tiers, as in Unreal. A bone chain covers most game characters at almost no cost. Guide strands are for card or strand hair that needs many guides.
- 2026-11-22 (agent): transliterate the frostbitten simulation only. Its software rasteriser and tile OIT do not fit the three.js render pipeline (PRD-671 owns strand drawing).
