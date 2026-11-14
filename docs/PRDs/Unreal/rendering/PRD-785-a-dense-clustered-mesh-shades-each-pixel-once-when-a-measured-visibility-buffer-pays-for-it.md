---
prd_contract: v1
---

# PRD-785 — A dense clustered mesh shades each pixel once, when a measured visibility buffer pays for it

**Status:** NOT STARTED
**Priority:** P3 — the Phase 1 gate is unbuilt. The whole clustered quarry costs 1.28 ms of GPU time on the browser, and PRD-284 declined occlusion because that number is the whole prize. Adoption is also an owner call (see `## Blocked on`).
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (+1), an experimental upstream add-on whose interface can change (+1), Phase 2 crosses the native engine boundary (+2); risk override: none
**Owner:** unassigned
**Depends on:** None. Respects [PRD-279](../../done/nanite-like/PRD-279-geometry-the-camera-cannot-resolve-is-never-submitted.md) decision 1 (no visibility buffer) until the owner reopens it, and [PRD-284](../../done/nanite-like/PRD-284-the-frame-does-not-draw-what-the-frame-already-hid.md) (occlusion declined on 1.28 ms). Shares the quarry `?pipeline=` knob with [PRD-600](../../done/PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md) Phase 1: the PRD that lands first adds it, and the other reuses it.

## Context

ThreeNative draws a clustered mesh with the game's own material through the ordinary hardware path. It has no visibility buffer. The Nanite dashboard lists five rows that this gap leaves open (`docs/PRDs/Unreal/research/internals/nanite.json`):

| Row | Unreal LOC | Status today |
| --- | --- | --- |
| Visibility buffer clear and raster context | 405 | deferred: "Revisit if the owner reopens decision 1 for the owned engine and every shipped target has 64-bit atomics." |
| Shade binning | 1483 | deferred: needs a visibility buffer that owns shading |
| Compute material shading and GBuffer export | 2418 | deferred: same reason. Coarse rate is PRD-682. |
| Depth export, material depth and composition | 1142 | deferred: hardware draws write depth and velocity already |
| Shared and glue (Shading and materials) | 331 | not filed: glue |

**Why PRD-279 said no.** In plain words: every reference implementation renders into a visibility buffer and then resolves materials in one full-screen pass. That pass is the shading path. If the framework owned it, the framework, not the game, would decide how lighting, tone mapping and material evaluation happen for a clustered mesh. That breaks the rule that the game owns the look, and that rule outranks the "framework owns what the game cannot write" rule. So PRD-279 kept the game's own `NodeMaterial` on every cluster and accepted that this "costs most of the published speedups" (PRD-279, §2 and §9 risk 2). The 64-bit atomics condition came later, in the dashboard row, not in PRD-279.

**What the numbers say today.** On the quarry route at 1080p on browser WebGPU, the `virtual` arm costs 1.28 ms of GPU time and submits 7.1 million triangles, against 6.97 ms and 104.5 million for `dense` ([batch README](../../done/nanite-like/README.md)). 7.1 million triangles over 2.07 million pixels is about 3.4 triangles per pixel. That is the case where a hardware rasterizer shades many 2×2 quads per pixel, and where a visibility buffer gains most. On native at 720p the `virtual` arm costs 3.05 ms. No measurement yet says how much of the 1.28 ms is shading, how much is quad overdraw, or what share of the triangles is a few pixels wide.

**The new fact.** three.js 0.187.0 (on `origin/develop`, `pnpm-workspace.yaml`) ships `VisibilityBufferDrawingPipeline` (three#35191, `examples/jsm/pipelines/VisibilityBufferDrawingPipeline.js`, 954 lines, built on `MeshletDrawingPipeline.js`). A game turns it on with `renderer.drawingPipeline = new VisibilityBufferDrawingPipeline()`. It builds its own meshlets from plain geometry. Read on 2026-11-02:

- **No 64-bit atomics.** It keeps two 32-bit storage buffers per pixel. One packs 16 bits of depth above a 16-bit triangle index. The other packs 15 bits of depth above a 17-bit instance index. Depth sits in the high bits, so one `atomicMax` per buffer does the depth test and the payload write together (lines 21-30, 180-192, 429-442). Depth uses a fourth-root distribution, and 0 means "not covered" (lines 429-433, 676-680). 32-bit storage atomics are core WebGPU, so this removes the old dashboard condition.
- **Hybrid raster.** A compute thread rasterizes each triangle whose screen box is at most `maxRasterSize` pixels wide and tall (default 8). Larger triangles and triangles that cross the near plane go to a hardware queue of at most 65,536 triangles per batch (lines 33, 355, 386-388, 798-817).
- **The game's material still shades.** The resolve copies the game's material (`createDrawMaterial`) and evaluates its node graph on the reconstructed surface, with analytic UV derivatives. Each object draws its bounding box, and a pixel is shaded only when the visibility buffer says that object owns it. Fragment depth comes from the buffer (lines 545-565, 690-721). This answers most of PRD-279's rule-3 reason: the game still decides the look. The framework still chooses the derivatives and the reconstruction, so the pixels can differ.
- **Limits that fall back to the hardware path:** a geometry whose most detailed level has more than 65,536 triangles (line 942, and the doc at 776), any render call with MRT such as a velocity output (line 778, `updateView`), shadow passes (line 835), materials with `maskNode`, `mrtNode` or `alphaTest` (lines 859, 934), and instanced meshes with instanced attributes or instance colours. The buffer holds one sample per pixel. No depth prepass runs (line 877).

Three of these limits hit ThreeNative directly. Every quarry body is above 65,536 triangles (the cliff has 1,999,200, the boulders 151,380 to 397,620, the floor 524,288), so the pipeline would draw the quarry on its hardware fallback. Core adds a velocity MRT for TRAA (`ensureVelocityOutput`, `packages/core/src/render/velocity.ts:81`), and the Unreal look scaffold uses MRT (`scripts/unreal-look/scaffold/render/worldEnvironment.ts`), so a template frame can fall back in full. The high quality tier uses 4× MSAA, and the effect of a one-sample buffer on its edges is unverified. A further risk, inferred from the code and unverified: the two words quantize depth at different precision, so at a near tie they can name a triangle and an instance from different objects.

**The owned engine.** The owned C++ engine is the default renderer on web and desktop. It runs a three symbol only when its API catalog covers it (`docs/architecture/NATIVE-ENGINE-DECISION.md`). On 2026-11-02 the catalog (`packages/three-native/api/catalog.json`, 506 rows) marks `atomicAdd` and `atomicStore` supported, and marks `StorageBufferNode`, `instanceIndex` and `RenderPipeline` unsupported. `atomicMax`, `atomicLoad`, `StorageBufferAttribute` and `drawingPipeline` have no row. So the pipeline runs only on `engine: "threejs"` today.

### What Unreal does (UE 5.8.3, read 2026-11-02, clean-room summary, no code copied)

- **One 64-bit word per pixel.** The raster context allocates `Nanite.VisBuffer64` as `PF_R64_UINT`, or as `PF_R32G32_UINT` where 64-bit textures are absent, with the atomic-64 flag. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:6604-6612` (inside `InitRasterContext`, `:6561`).
- **Depth in the high word, cluster and triangle in the low word.** The low word is the visible cluster index plus one, shifted left by 8, joined to an 8-bit triangle index, so 0 means empty. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteDataDecode.ush:889-911`. One 64-bit image `InterlockedMax` writes the pixel, and a platform without 64-bit image atomics fails to compile. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteWritePixel.ush:19-34`. Three's two-word split is the workaround Unreal does not have.
- **The split is per cluster at 32 pixels.** `r.Nanite.MinPixelsPerEdgeHW` defaults to 32: a cluster whose triangle edges project under 32 pixels goes to the software rasterizer. UE 5.8.3: `NaniteCullRaster.cpp:140-145`, `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:195-203`. Three splits per triangle at an 8-pixel box. PRD-696 files the same split for shadow casters.
- **Shade binning.** A compute pass classifies every visibility-buffer pixel by shading bin, counts it, reserves space and scatters pixel or 2×2-quad records with a write mask. The mode is automatic by default (`r.Nanite.ShadeBinningMode` 0: auto, 1: pixel, 2: quad). UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:202-221`, `:1958` (`ShadeBinning`), `Engine/Shaders/Private/Nanite/NaniteShadeBinning.usf:184-241`.
- **Compute material shading.** Each bin is shaded once in compute (`DispatchBasePass`, `NaniteShading.cpp:1670`), from commands built per mesh pass (`BuildShadingCommands`, `:654`). Software variable rate shading is on by default (`r.Nanite.SoftwareVRS` 1, `:224-230`), and quad records coarsen by a VRS shift (`NaniteShadeBinning.usf:220`). Tiles clear fast by default (`r.Nanite.FastTileClear` 1, `NaniteShading.cpp:123-129`).
- **Depth export and composition.** One compute pass per HTILE tile writes scene depth, stencil and velocity from the visibility buffer (`r.Nanite.ExportDepth` 1). UE 5.8.3: `NaniteShared.cpp:30-35`, `Engine/Shaders/Private/Nanite/NaniteDepthExport.usf:70-71`, `:185` (velocity). `EmitDepthTargets` drives it (`Engine/Source/Runtime/Renderer/Private/Nanite/NaniteComposition.cpp:256`). Pixel-shader fallbacks exist (`Engine/Shaders/Private/Nanite/NaniteExportGBuffer.usf:70`, `EmitSceneDepthPS`).
- **Shared and glue.** `NaniteMaterials.cpp` is 84 lines: one cvar (`r.Nanite.MultipleSceneViewsInOnePass`, `:34`) and two debug uniform-buffer helpers (`:43`, `:67`).

The three pipeline covers the clear, the packing and the raster split. It has no shade binning, no compute shading and no velocity export. Its box resolve shades through the hardware path with the game's material, so this PRD does not port binning or compute shading. It measures whether the upstream piece pays first.

## Solution

1. **Measure first (Phase 1).** The quarry gains a `?pipeline=standard|meshlet|visbuffer` knob on `engine: "threejs"`. It sets `renderer.drawingPipeline` and nothing else. For the `visbuffer` arm the quarry splits each body into parts of at most 65,536 triangles, so the pipeline does not fall back. The run reports the share of submitted triangles that took the visibility-buffer path, and the measure fails closed when that share is under 90%. All arms run from one code state through the URL knob, at least 5 paired runs per arm, at 1080p on a named WebGPU adapter (`adapter.info` checked). The table records GPU time, the share of triangles at or under 8 pixels of screen box and under 32 pixels of edge, fragment invocations per covered pixel, and shading time (the game's material minus a flat material). A second run uses the template look path (velocity MRT on, default anti-aliasing) and records the visibility-buffer share there.
2. **The gate.** Continue only if all three lines hold:
   - **Time:** the `visbuffer` arm's route-median GPU time is lower than the best hardware arm (`virtual` on the standard path, or `meshlet`) by at least 0.25 ms and at least 20%, in at least 4 of 5 paired runs. The bar is a fifth of the 1.28 ms prize that PRD-284 named, and it matches PRD-600's 0.25 ms bar.
   - **Reach:** on the template look path, at least 50% of the submitted clustered triangles still take the visibility-buffer path. A win that every template frame falls back from reaches no game.
   - **Look:** the changed-pixel ratio against `dense` is at most 0.5 points above the hardware arm, and the visual judge returns NEUTRAL or IMPROVEMENT, with the 4× MSAA tier included.

   If a line fails, record the numbers and the decline under `## Decisions`, delete the Phase 2 boxes (R4) and keep Phase 3.
3. **Price the owned engine (Phase 2).** Add a catalog row for every three symbol the pipeline needs, with its status or a named `TN_NATIVE_UNSUPPORTED_*` diagnostic. Add one conformance case that runs the pipeline on a small clustered scene on web and on the desktop engine. It passes with matching frames, or it fails closed with the diagnostic that names the missing row.
4. **Report (Phase 3).** The five dashboard rows name PRD-785 with the gate result and the revisit condition. The quarry README documents the knob, because primary docs name only shipped commands.

**Where it goes.** Phase 1 changes only `examples/quarry/`. Choosing the visibility buffer changes shading inputs (derivatives, reconstruction), so it is a look decision. A later template opt-in lives in that template's `src/render/`, not in `packages/core/src/`. Core changes nothing in this PRD.

**Left out on purpose:** a port of shade binning, compute material shading and depth export (the upstream resolve does without them), software VRS (PRD-682 owns coarse shading), a 64-bit visibility buffer, and shadow casters (PRD-696).

## Acceptance Criteria

- [ ] AC-1 [local]: The quarry route at 1080p on a named WebGPU adapter records the Phase 1 table for `standard`, `meshlet` and `visbuffer`, with at least 5 paired runs per arm, at least 90% of submitted triangles on the visibility-buffer path in the `visbuffer` arm, 0 console errors, and the gate verdict under `## Decisions`. proof: `pnpm --filter quarry measure -- --arm virtual --pipeline visbuffer --url http://127.0.0.1:5191` and the same command per arm — Evidence: pending.
- [ ] AC-2 [local]: The conformance case passes on web and desktop, or fails closed with a named diagnostic for each missing catalog row. proof: `pnpm parity --only-tests visbuffer-small-triangles` — Evidence: pending.
- [ ] AC-3 [local]: The five nanite.json rows name PRD-785 and the feature map is current. proof: `pnpm unreal:status && pnpm check:docs` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `?pipeline=` knob | `pnpm --filter quarry measure -- --pipeline <arm>` | New reference arm. The standard path stays the default. | AC-1 |
| Body split at 65,536 triangles | the `visbuffer` arm of the quarry | Applies only to that arm. `positionHash` per body stays the same. | AC-1 |
| Catalog rows and conformance case | `pnpm parity`, the native API catalog | Turns "no row" into supported or a named diagnostic | AC-2 |
| Dashboard rows | `pnpm unreal:status` | Replaces the 64-bit atomics revisit text with the measured gate result | AC-3 |

## Execution Phases

#### Phase 1: Measure the r187 visibility buffer on the quarry
**Status:** NOT STARTED
**Files:** `examples/quarry/src/game.ts`, `examples/quarry/src/quarry/bodies.ts`, `examples/quarry/scripts/measure.ts`, `scripts/__tests__/quarry-instrument.spec.ts`
**Implementation:** the URL knob, the 65,536-triangle split for the `visbuffer` arm, the path-share report that fails closed under 90%, the fragment-invocation counter (a debug material with an atomic counter) and the flat-material arm. The gate verdict goes under `## Decisions`.
- [ ] The knob selects each pipeline, the split keeps each body's `positionHash`, and a `visbuffer` run under 90% path share fails. proof: red-green `pnpm exec vitest run scripts/__tests__/quarry-instrument.spec.ts`
- [ ] The route table (GPU ms, small-triangle shares at 8 px box and 32 px edge, fragment invocations per covered pixel, shading ms) exists for all three arms, 5 paired runs each. proof: `pnpm --filter quarry measure -- --arm virtual --pipeline visbuffer --url http://127.0.0.1:5191`
- [ ] The template look path (velocity MRT on, default anti-aliasing) reports its visibility-buffer share. proof: the same command with `--look template`
- [ ] The visual judge compares `visbuffer` and the best hardware arm at the same poses, 4× MSAA tier included, at least two runs per arm, and returns its verdict. proof: `pnpm --filter quarry compare -- --reference artifacts/quarry/virtual --candidate artifacts/quarry/virtual-visbuffer`, then a fresh read-only judge subagent

#### Phase 2: Price the owned engine path
**Status:** NOT STARTED
**Files:** `packages/three-native/api/catalog.json`, `packages/runtime-native/conformance/registry.json`, one conformance scene
**Implementation:** runs only if the Phase 1 gate passes. One catalog row per needed symbol (`atomicMax`, `atomicLoad`, `StorageBufferAttribute`, `StorageBufferNode`, `instanceIndex`, `drawingPipeline` and the rest the pipeline imports), then the conformance case.
- [ ] Every three symbol the pipeline imports has a catalog row with a status or a named diagnostic. proof: `pnpm exec vitest run packages/three-native/__tests__/catalog.spec.ts packages/three-native/__tests__/catalog-registry.spec.ts`
- [ ] The conformance case runs on web and on the desktop engine. proof: `pnpm parity --only-tests visbuffer-small-triangles`

#### Phase 3: Report the result on the dashboard
**Status:** NOT STARTED
**Files:** `docs/PRDs/Unreal/research/internals/nanite.json`, `examples/quarry/README.md`
**Implementation:** each of the five rows names PRD-785, the gate numbers and the revisit condition. The README names the knob and its arms.
- [ ] The five rows name PRD-785 and the map refreshes. proof: `pnpm unreal:status && pnpm check:docs`
- [ ] The quarry README documents `?pipeline=` and its arms. proof: `pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts`

## Decisions

- 2026-11-02 (filing): the PRD measures the upstream pipeline as a reference arm and ports no Unreal shading code. Shade binning, compute shading and depth export stay deferred until the gate passes and the owner reopens PRD-279 decision 1. Revisit condition if the gate fails: a game asset on which the `visbuffer` arm saves at least 0.25 ms, or a three release that lifts the 16-bit triangle limit or the MRT fallback.

## Blocked on

- **Owner: reopen PRD-279 decision 1 for the owned engine.** Ask only when all three Phase 1 gate lines pass (time, reach, look) and Phase 2 shows the desktop engine runs the case or names each missing row.
- **Owner: replace the dashboard revisit condition.** Ask, with the same gate result, whether "every shipped target has 64-bit atomics" becomes "32-bit storage atomics with depth packed above the payload", which core WebGPU has.
- **Upstream three.js:** the pipeline is marked experimental and "its interface might change". A later three bump re-opens Phase 1, and that bump is its own batch (`docs/architecture/NATIVE-ENGINE-DECISION.md`).
