---
prd_contract: v1
---

# PRD-696 — Tiny triangles of a clustered shadow caster rasterize in compute

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is an unbuilt cost gate: no number says how much of a shadow level's GPU time goes to clustered triangles a few texels wide, and PRD-602, which prices clustered casters at all, has not run its own gate.
**Complexity:** 7 (HIGH) — 1–5 implementation files (+1), a compute rasterizer with atomic depth is a new GPU path (+2), its depth must merge with the hardware depth of the same level (+1), a per-cluster split between two rasterizers (+1), a visual judge (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-602](../rendering/PRD-602-a-clustered-shadow-caster-draws-what-its-shadow-texel-resolves.md) Phase 1 (its `?shadows=virtual` quarry switch and the per-level triangle count) is required. Its Phase 2 (a cut per shadow level) is optional: without it, this PRD splits the camera cut.

## Context

**Unreal size.** The software rasterizer is about 2,300 lines: the triangle path of
`NaniteRasterizer.usf` (lines 1-885 and the entry at 2420-2442), `NaniteRasterizationCommon.ush`
(727), `NaniteRasterizer.ush` (299), `NaniteWritePixel.ush` (110) and the compute raster shader
class in `NaniteCullRaster.cpp` (lines 1515-1763). **Port estimate:** about 450 TypeScript lines
(TSL compute), plus the native host's atomic storage support if Phase 3 finds it missing.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Compute rasterization is on by default.** `r.Nanite.ComputeRasterization` defaults to 1
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:79-84`).
- **The split is per cluster, by projected edge length.** A cluster goes to the hardware
  rasterizer when its triangle edges project to 32 pixels or more (`r.Nanite.MinPixelsPerEdgeHW`,
  `NaniteCullRaster.cpp:140-145`). The test runs beside the LOD test, on the same projected scale
  (`Engine/Shaders/Private/Nanite/NaniteClusterCulling.usf:287-311`). A cluster that crosses the
  near or far plane always goes to hardware (`NaniteClusterCulling.usf:860`).
- **Depth-only targets need only 32-bit atomics.** The main view packs depth and a visibility
  payload into one 64-bit atomic max. A depth-only target writes a 32-bit atomic max of depth
  (`Engine/Shaders/Private/Nanite/NaniteWritePixel.ush:20-31`). Virtual shadow map pages take the
  same 32-bit atomic max (`NaniteWritePixel.ush:79-94`).
- **The triangle setup is fixed point.** Vertices snap to 8 subpixel bits
  (`Engine/Shaders/Shared/NaniteDefinitions.h:5-8`), and the setup rejects back faces by the sign of
  the edge determinant (`Engine/Shaders/Private/Nanite/NaniteRasterizer.ush:28-55`).
- **Small triangles walk their box, larger ones walk scanlines.** A wave uses scanlines when any
  of its triangles spans more than 4 pixels, and the bounding box otherwise
  (`NaniteRasterizer.ush:292-299`).

### ThreeNative today

- PRD-279 dropped software rasterization from virtual geometry: it needs 64-bit image atomics and a
  visibility buffer that owns shading ([PRD-279](../../done/nanite-like/PRD-279-geometry-the-camera-cannot-resolve-is-never-submitted.md), "Out of v1").
  The feature map repeats that reason for the whole row.
- **Neither blocker applies to a depth-only pass.** A shadow level writes depth and no material.
  WebGPU has 32-bit atomics on storage buffers, and TSL exposes `atomicMax`. The engine already uses
  it in `packages/core/src/fluid-particles.ts:33-35`.
- `VirtualShadowNode` renders each clipmap level with three's hardware rasterizer into a depth
  target (`setupRenderTarget`, `packages/core/src/render/virtual-shadow.ts:810-813`). A clustered caster draws the camera cut
  in every level today (PRD-602, Context).

## Solution

**The gate first (Phase 1).** On the quarry with `?shadows=virtual`, record for each level the
clustered caster triangles, their mean projected edge in texels, and the level's hardware raster
time. Then time a test compute pass that rasterizes the clusters under 32 texels per edge of the
finest two levels into a storage buffer with `atomicMax`. **Continue only if** the compute pass plus
the remaining hardware draw is at least 0.3 ms faster per frame than the hardware draw alone at
1080p on the RTX 2080 browser lane, or at least 25% of the clustered caster shadow time. Otherwise
record the verdict under `## Decisions` and delete Phases 2 and 3 (R4).

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Per-cluster split at 32 px (`NaniteClusterCulling.usf:287-311`) | the shadow cut splits into a hardware index range and a compute cluster list, at `minTexelsPerEdgeHW` (default 32), measured on the level's texel | core mechanism |
| Depth-only atomic max (`NaniteWritePixel.ush:20-31`) | `packages/core/src/render/compute-depth-raster.ts` (new): one workgroup per cluster, fixed-point setup with back-face reject, box walk, `atomicMax` on a `u32` buffer per level | core mechanism |
| Near and far plane clusters to hardware (`NaniteClusterCulling.usf:860`) | a cluster whose sphere crosses the level's near or far plane stays in the hardware range | core mechanism |
| Merge into the level | a full-screen pass writes the buffer into the level's depth target with a depth test, so both rasterizers resolve to the nearest depth | core mechanism |

- **Auto by default.** The split threshold is measured on the level texel, so the author sets
  nothing. `minTexelsPerEdgeHW` is the named override, and `TN_VIRTUAL_SHADOW` reports the compute
  and hardware triangle counts per level.
- **Masked and moving casters stay in hardware.** A material with `alphaTest`, an alpha-test node
  or a `positionNode` needs its own shader, so its clusters never take the compute path. This keeps
  the game's material in charge of every look decision.
- **The look is untouched.** The shadow depth is the same depth. Bias and filtering stay in the
  template.

**Left out on purpose:** compute raster of the main view (it needs a visibility buffer, which
PRD-279 decision 1 rules out, and 64-bit atomics, which WebGPU lacks), and of local-light shadows
(PRD-695 owns their views).

## Acceptance Criteria

- [ ] AC-1 [local]: For 64 seeded clusters and level windows, the compute depth equals a CPU reference rasterizer with the same top-left fill rule, with 0 differing texels. proof: red-green `pnpm exec vitest run packages/core/__tests__/compute-depth-raster.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: With `?shadows=virtual` on the quarry route at 1080p on the RTX 2080 browser lane, median `gpuMs` falls by the Phase 1 margin or more, with 0 console errors. proof: `pnpm --filter quarry measure -- --arm virtual --url 'http://127.0.0.1:5191/?shadows=virtual'`, compute raster on against off — Evidence: pending.
- [ ] AC-3 [local]: The desktop host renders the shadow fixture within the conformance tolerance of the browser. proof: `pnpm parity --target desktop --only-tests compute-depth-raster` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Compute depth raster | `VirtualShadowNode` level render for a clustered caster with an opaque material | Replaces the hardware draw of that caster's small-triangle clusters | AC-1, AC-2 |

## Decisions

- 2026-10-21 (filing): Filed from the Nanite internals read. The feature map deferred software
  rasterization as a whole on 64-bit atomics and the visibility buffer. Unreal's own depth-only
  path needs neither (`NaniteWritePixel.ush:20-31`), so the shadow half is filed with a gate. The
  main-view half stays deferred under PRD-279 decision 1.

## Execution Phases

#### Phase 1: Price small triangles in the shadow levels
**Status:** NOT STARTED
**Files:** `examples/quarry/scripts/measure.ts`, `packages/core/src/render/virtual-shadow.ts` (counters only), `packages/core/src/render/compute-depth-raster.ts` (test pass)
- [ ] Each level's clustered triangles, mean projected edge in texels and hardware raster time are recorded here. proof: `pnpm --filter quarry measure -- --arm virtual --url 'http://127.0.0.1:5191/?shadows=virtual'`
- [ ] The test compute pass is timed on the finest two levels, and the gate verdict is written under `## Decisions`. proof: the same command with `--compute-depth-probe`

#### Phase 2: The split and the compute raster
**Status:** NOT STARTED
**Files:** `packages/core/src/render/compute-depth-raster.ts`, `packages/core/src/render/virtual-shadow.ts`, `packages/core/__tests__/compute-depth-raster.spec.ts` (new)
- [ ] The compute raster matches the CPU reference, and a cluster that crosses the near plane or uses a masked or moving material stays in hardware. proof: red-green `pnpm exec vitest run packages/core/__tests__/compute-depth-raster.spec.ts`
- [ ] A fresh visual judge compares quarry shadow frames before and after, two runs per arm, and returns NEUTRAL or IMPROVEMENT with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent

#### Phase 3: The owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/compute-depth-raster.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host runs the compute raster with storage-buffer atomics and matches the browser fixture, or the PRD records the missing native capability. proof: `pnpm parity --target desktop --only-tests compute-depth-raster`
**Verification:** AC-1 to AC-3.
