# PRD-527 — Particles and fluids run native (N14e)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: particles and fluids run native; 4 open boxes.
**Complexity:** 3 — compute-driven systems on top of N08d's compute proof
**Owner:** João
**Work package:** N14 — [native-engine batch](../README.md)
**Depends on:** [PRD-523 (N14a)](PRD-523-n14a-the-render-graph-owns-passes-and-history.md), [PRD-513 (N08d)](../N08-native-tsl-and-shader-packages/PRD-513-n08d-compute-multipass-and-a-dynamic-graph.md)

## Context

§11.3 lists particles and fluid systems among the framework systems to port. Today they are
`packages/core/src/particles.ts` (including `GPUParticles3D`, the shape the charter holds up for
"never own the look"), `packages/core/src/fluid-field.ts` and `packages/core/src/fluid-particles.ts`.
The engine owns pooling, lifetime, billboarding, instancing and dispatch; geometry, material, colour,
curve and timing stay game-supplied.

## Solution

1. Port emitter pooling, lifetime, sorting, billboarding and compute dispatch into proposed
   `packages/runtime-native/src/engine/world/particles/`, with simulation as render-graph compute
   passes (N14a) and appearance supplied as the game's TSL material (N08).
2. Port the fluid field and fluid particles onto the same compute path.
3. Every appearance parameter keeps coming from the game; the port adds none of its own.
4. Rollback: the legacy backend keeps the TS systems.

## Out of scope

- Physics-coupled particles beyond what the TS systems do today (N15).

## Execution Phases

#### Phase 1: Particles
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/particles/`, `packages/runtime-native/tests/native-engine/particles_*.cpp`
- [ ] Emission, lifetime and recycling counts match the TS reference for the same seed and tick count. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_particles_lifetime`
- [ ] A `GPUParticles3D` fixture with a game-supplied material renders within tolerance of the legacy backend. proof: `pnpm parity` (new case `native-engine-gpu-particles`)

#### Phase 2: Fluids
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/fluids/`
- [ ] The fluid field advances to the same state as the TS reference after N fixed steps, within tolerance. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_fluid_field`
- [ ] A fluid-particles fixture renders within tolerance of the legacy backend. proof: `pnpm parity` (new case `native-engine-fluid-particles`)
