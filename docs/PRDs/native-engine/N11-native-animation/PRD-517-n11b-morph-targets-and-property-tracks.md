# PRD-517 — Morph targets and property tracks (N11b)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: morph targets and property tracks; 4 open boxes.
**Complexity:** 3 — the evaluator comes from N11a; the new work is GPU morph blending and binding to non-skeletal properties
**Owner:** João
**Work package:** N11 — [native-engine batch](../README.md) · [N11 umbrella](README.md)
**Depends on:** [PRD-516 (N11a)](PRD-516-n11a-animation-mixer-semantics-in-native.md), [N08 shader packages](../N08-native-tsl-and-shader-packages/README.md)

## Context

§11.2 asks for animation to cover animated non-skeletal properties and morph targets, not only bones. That means `morphTargetInfluences`, material properties (colour, opacity, emissive), light intensity and colour, camera FOV, visibility, and object transforms on non-bone nodes. Morph attributes are consumed today by the framework's projection and merge paths (`packages/core/src/projection-plan.ts`, `packages/core/src/projection-apply.ts`, `packages/core/src/merge-parts.ts`), which decide when a morphed mesh can join a batch.

## Solution

1. **Property tracks.** N11a's binder extends to the reference's non-bone property paths. Writes go through the native public setters, so revision invalidation (N06/N09) sees them.
2. **Morph targets.** `morphAttributes` and `morphTargetsRelative` are stored natively. The shader package (N08) blends influences in the vertex stage, with the reference's normal handling and influence limits.
3. **Material property animation.** A material property write bumps the material revision. An animated uniform that differs per object takes the object off a shared batch, keeping the existing eligibility rule (PRD-519).
4. **Unsupported** property paths fail with `TN_NATIVE_ANIMATION_PATH_UNSUPPORTED` naming the path.

## Out of scope

- Skeletal palettes: [PRD-518 (N11c)](PRD-518-n11c-skinning-palettes-and-pose-history.md)
- Batching eligibility itself: [PRD-519 (N12)](../PRD-519-n12-native-batching-visibility-lod-gpu-scene.md)

## Execution Phases

#### Phase 1: Non-skeletal property tracks
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/animation/property_binding.cpp`
- [ ] Colour, opacity, light intensity, camera FOV, visibility and node transform tracks match reference value dumps. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_property_tracks`
- [ ] An animated material property bumps the material revision and shows up on the next render. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_animation_material_revision`

#### Phase 2: Morph targets on the GPU
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/shader/morph/`, `packages/runtime-native/src/engine/scene/morph_attributes.cpp`
- [ ] Absolute and relative morph targets blend positions and normals to match the reference capture. proof: `pnpm parity` case `native-engine-morph-targets`
- [ ] A morph-influence clip loaded from glTF plays and matches the reference capture at three sampled times. proof: `pnpm parity` case `native-engine-morph-clip`
