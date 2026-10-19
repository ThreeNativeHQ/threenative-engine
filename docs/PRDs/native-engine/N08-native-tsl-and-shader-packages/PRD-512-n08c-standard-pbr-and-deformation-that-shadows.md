# PRD-512 — Standard PBR and deformation that shadows (N08c)

**Status:** PROPOSED
**Priority:** P2 — Wave 3: standard PBR and deformation pinned to the reference shadows; 5 open boxes.
**Complexity:** 4 — reference-pinned lighting maths plus a shadow pass that must reuse the deformed position
**Owner:** João
**Work package:** N08 — [native-engine batch](../README.md) · [N08 index](README.md)
**Depends on:** [PRD-511](PRD-511-n08b-shader-packages-not-wgsl-text.md)

## Context

§9.4 proofs one and two: standard lit PBR, and a TSL vertex deformation whose shadow follows the
deformed shape. §9.3 pins PBR equations, lighting units, colour conversions, tonemapping,
environment filtering, alpha behaviour, normal handling and material defaults to
`three@0.185.1` (with the repo patch `packages/core/patches/three@0.185.1.patch`). Improving the look
is a separate opt-in change, not parity. Existing native-vs-browser comparison lives in
`pnpm parity` (`packages/runtime-native/conformance/registry.json`, `conformance/browser-reference/`).

## Solution

1. **Native TSL lighting library** (proposed: `src/engine/shader/tsl/lighting/`): the
   `MeshStandardMaterial` node chain — BRDF, punctual lights in physical units, ambient and
   hemisphere, an environment map with the reference PMREM filtering, sRGB/linear conversion, the
   tonemapping operators the catalog lists — ported from the pinned source, not re-derived.
2. **Material defaults** match the reference constructor defaults exactly.
3. **Deformation reaches every pass:** `positionNode` (and `normalNode`) feed the colour pass and
   the shadow/depth variant from one IR graph, so the shadow pass never falls back to undeformed
   geometry.
4. **Comparison method:** the reference scene renders under upstream `WebGPURenderer` in the
   browser lane; the native scene renders through a minimal native draw path (one pass + one shadow
   map; the full renderer is N09). Compare with the existing conformance metrics and a documented
   tolerance.
5. **Unsupported advanced materials** (e.g. `MeshPhysicalMaterial` features not yet ported) report
   `TN_MATERIAL_UNSUPPORTED <feature>`; never mapped silently to a simpler shader (§9.3).

## Out of scope

- The full renderer, alpha paths, multiple cameras — [PRD-514 (N09)](../PRD-514-n09-native-renderer-and-standard-materials.md).
- Physical material features beyond what representative games need — [PRD-514 (N09)](../PRD-514-n09-native-renderer-and-standard-materials.md).

## Execution Phases

#### Phase 1: Standard lit PBR
**Status:** NOT STARTED
**Files:** proposed `src/engine/shader/tsl/lighting/*.cpp`, `packages/runtime-native/conformance/scenes/native-engine-pbr/`
- [ ] A sphere grid (roughness × metalness) under a directional light and an environment map matches the browser reference within the documented tolerance, with no upstream `three` in the native app. proof: `pnpm parity -- --case native-engine-pbr-grid`
- [ ] Each catalogued tonemapping operator matches the reference on a luminance ramp. proof: `pnpm parity -- --case native-engine-tonemap-ramp`
- [ ] An unported physical-material feature raises `TN_MATERIAL_UNSUPPORTED`. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_material_unsupported`

#### Phase 2: Deformation that shadows
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/conformance/scenes/native-engine-deform-shadow/`
- [ ] A plane deformed by a TSL `positionNode` wave casts a shadow matching the reference silhouette. proof: `pnpm parity -- --case native-engine-deform-shadow`
- [ ] The app's linked modules contain no upstream `three` and no JS engine while running that case. proof: `node packages/runtime-native/scripts/inspect-js-free.mjs <native-engine-deform-shadow binary>`

## Decisions

- **Parity first; visual improvements are separate opt-in changes (§9.3).**
