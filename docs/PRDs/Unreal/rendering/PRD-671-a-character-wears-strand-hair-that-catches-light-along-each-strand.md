---
prd_contract: v1
---

# PRD-671 — A character wears strand hair that catches light along each strand

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is an unbuilt cost gate. No template ships hair, hair cards (PRD-VQ-15) are still proposed, and a fresh Unreal project draws no groom until a character brings one.
**Complexity:** 7 (HIGH) — 1–5 implementation files (+1), a segment-to-ribbon draw with sub-pixel coverage is a new mechanism (+2), a hair BSDF with three lobes is new template source (+2), a visual judge (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. Follows [PRD-VQ-15](../../rendering/PRD-VQ-15-hair-card-material-qualification.md) in spirit: cards stay the far and low-tier hair, and this PRD adds strands only where Phase 1 says they pay. Builds on the template temporal AA, which resolves the hashed coverage.

## Context

**Unreal size.** Hair strands are 45,936 lines in the feature map (17,639 C++ in
`Engine/Source/Runtime/Renderer/Private/HairStrands/`, 28,297 shader). The groom asset, its
interpolation and its simulation live in the HairStrands plugin, which the sparse clone does not
hold. Nanite curves add about 2,800 lines (`NaniteCurve.usf`, `NaniteCurveCommon.ush`,
`NaniteCurveRaster.inl`). The first slice here is about 450 TypeScript lines and about 200 C++ lines.
A full port (deep shadows, voxel transmittance, visibility buffer, LOD to cards, simulation) is
several times that and is out of this PRD.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The renderer path is on, the content is opt-in.** `r.HairStrands.Enable` defaults to 1
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/GroomVisualizationData.cpp:13-14`). A fresh
  project draws no strands until a groom component is placed. Nanite curves are off:
  `r.Nanite.AllowCurves` defaults to 0 and is read-only
  (`Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:136-140`).
- **Strands are thinner than a pixel, so coverage is the problem.** The raster snaps a strand to at
  least half a pixel wide (`r.HairStrands.RasterizationScale` 0.5,
  `Engine/Source/Runtime/Renderer/Private/HairStrands/HairStrandsUtils.cpp:23-24`). The visibility
  pass keeps several samples per pixel. The count follows shading quality: 1 at levels 0 and 1, 4
  at levels 2 and 3, and 8 at cinematic (`Engine/Config/BaseScalability.ini:1006-1033`,
  cvar at `HairStrandsVisibility.cpp:88`).
- **The BSDF is an approximation of Marschner's three lobes.** R is the surface reflection, TT is
  the light through the fibre, and TRT is the inner reflection. Each lobe has its own switch
  (`Engine/Shaders/Private/HairBsdf.ush:271-277`, `:338`, `:378-379`,
  `HairStrandsUtils.cpp:18-21`). The sources are Marschner et al. 2003 and Pekelis et al. 2015,
  both published.
- **Self-shadow uses deep opacity maps and a voxel density volume.** The deep opacity map is 2048
  texels by default (`HairStrandsDeepShadow.cpp:13-14`). Voxelization for transmittance is on by
  default (`HairStrandsVoxelization.cpp:33-34`).
- **Nanite curves put curve segments in the cluster DAG.** A group of curves simplifies by curve and
  segment count, never into voxels (`Engine/Source/Developer/NaniteBuilder/Private/ClusterDAG.cpp:1455-1486`).

### ThreeNative today

- No package or template draws strands (`rg -i "hair|strand" packages/core/src packages/create-threenative/templates`, 2026-10-21: only comments).
- PRD-VQ-15 proposes hair cards with tangent highlights. PRD-465 (done) disclosed that strand
  grooming is not reproduced.
- glTF has a `LINES` primitive, and three's `GLTFLoader` loads it as `LineSegments`. That is the
  input format here, so the PRD adds no new file format.

## Solution

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Strand raster with a 0.5 px floor (`HairStrandsUtils.cpp:23-24`) | `packages/core/src/hair-strands.ts`: each segment of a `LineSegments` geometry draws as a camera-facing ribbon. The drawn width is at least 0.5 px, and the true width over the drawn width becomes the coverage | core mechanism |
| Samples per pixel (`BaseScalability.ini:1006-1033`) | coverage drives a hashed alpha test that the template temporal AA resolves. The tier sets the hash scale | core mechanism, tier from template |
| Hair BSDF, R, TT, TRT (`HairBsdf.ush:271-379`) | `templates/starter/src/render/hairShading.ts`, a TSL function written from the two papers. Colour, shift and roughness come from the game | template look |
| Groom import | a Blender script turns hair curves into a glTF `LINES` primitive with a root UV and a strand coordinate | asset recipe |

- **Auto by default.** The ribbon width floor, the coverage and the tangent come from the geometry
  and the view. `TN_HAIR_STRANDS` reports the strand count, the segment count and the drawn width
  floor.
- **Shadows in the first slice** come from the existing sun shadow, with the ribbon as a hashed
  caster. Deep opacity maps and voxel transmittance wait under `## Decisions`.

Risks:

- Hashed coverage shimmers without temporal AA. The low tier keeps cards (PRD-VQ-15).
- Segment count drives cost directly. Phase 1 sets the strand budget per tier from a measurement.

## Acceptance Criteria

- [ ] AC-1 [local]: At a close character pose, a fresh visual judge returns IMPROVEMENT for strand hair against the same character with hair cards, and names the highlight along the strands. proof: headed `--browser-recipe webgpu` captures, before and after, two runs each, fresh visual-judge subagent — Evidence: pending.
- [ ] AC-2 [local]: The Phase 1 strand budget draws in at most 2.0 ms GPU at 1080p on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host draws the strand fixture within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests hair-strands` — Evidence: pending.

## Blocked on

- A licence-clear groom asset. The Phase 1 fixture is a generated groom. A real character groom needs an asset source that allows redistribution.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `HairStrands3D` | starter `src/render/hairShading.ts` → `new HairStrands3D(gltf.lineSegments, { shading })` on the character head bone | New. Cards (PRD-VQ-15) stay the low tier | Phase 2, AC-1 |

## Decisions

- 2026-10-21 (filing): Deferred, not declined, under the owner rule of 2026-10-21. A fresh Unreal project draws no strands, and no template has a character with hair. The revisit condition is a template or game whose character needs hair closer than cards hold, or a Phase 1 result inside its threshold.
- 2026-10-21 (filing): Deep opacity maps, voxel transmittance, the visibility buffer, LOD to cards, strand simulation and Nanite curves for grass are later PRDs. Each waits for this first slice to pass AC-1.

## Execution Phases

#### Phase 1: Price a groom before building the shading
**Status:** NOT STARTED
**Files:** `examples/hair-strands/` (new: a generated groom and a ribbon draw with flat colour), `examples/hair-strands/hair-strands.playtest.json`
- [ ] A generated groom of 50,000 strands with 16 segments each draws as ribbons on browser WebGPU, and the playtest records GPU time at 1080p. proof: `node packages/playtest/dist/runner/cli.js perf` on the fixture.
- [ ] The gate verdict and the strand budget per tier are written under `## Decisions`: continue only if 50,000 strands cost at most 2.0 ms. proof: the Phase 1 table in this PRD.

#### Phase 2: Strands with hair shading on the web
**Status:** NOT STARTED
**Files:** `packages/core/src/hair-strands.ts`, `packages/core/src/index.ts`, `packages/core/__tests__/hair-strands.spec.ts`, `packages/create-threenative/templates/starter/src/render/hairShading.ts` (new)
- [ ] The ribbon width never falls below 0.5 px, and the coverage equals the true width over the drawn width. proof: `pnpm exec vitest run packages/core/__tests__/hair-strands.spec.ts`.
- [ ] The hair shading keeps its energy at or below 1 in a white furnace for every lobe, and each lobe can be switched off. proof: `pnpm exec vitest run packages/core/__tests__/hair-strands.spec.ts`.
- [ ] A character with strand hair renders on browser WebGPU. proof: AC-1 visual judge and AC-2 perf run.

#### Phase 3: The owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/hair-strands.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host draws the strand fixture and matches the browser reference. proof: `pnpm parity --target desktop --only-tests hair-strands`.
