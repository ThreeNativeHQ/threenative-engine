# PRD-858: World impostors bake on the owned web engine

**Status:** OPEN — found 2026-11-08 while PRD-762 brought the forest starter kit up on the default engine.
**Priority:** P1 — the forest kit's overview draws 100 times the triangles of the `engine: "threejs"` arm on the default engine.
**Complexity:** 7 (HIGH)
**Depends on:** [PRD-762](PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) (the kit starts on the default engine)
**Epic:** [Strata terrain hardening](README.md), part of chain step PR-1 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Measured on 2026-11-08 in Chrome DevTools, NVIDIA RTX 2080, the forest starter kit from `verify-starter-kit.mjs`, overview view (`Digit3`), the same build on both arms:

| Arm | Instances | `wideTris` | Frame p95 |
| --- | --- | --- | --- |
| `engine: "threejs"` | 5 064 | 256 402 | 4.95 ms (60 fps) |
| default engine | 14 624 | 26 186 069 | 73.5 ms (15 fps) |

The ground view runs at 60 fps on both arms. Edge and overview drop to 12 to 15 fps on the default engine.

Cause: core's impostor baker (`packages/core/src/render/world-impostor.ts`) never runs on the owned engine, so every far tree draws a mesh LOD. `impostorRawRenderer` (`packages/core/src/world-cell-impostors.ts:212`) needs the full seam in `REQUIRED_IMPOSTOR_METHODS`. The facade (`packages/three-native/src/browser-renderer.ts`, `render-target.ts`) has no `getClearColor`, `getMRT`, `setMRT` or `initRenderTarget`. Its render target draws layer 0 only. The bake needs these:

1. A layered `RenderTarget` (`depth: IMPOSTOR_VIEWS`, `count: 2`) and `setRenderTarget(target, layer, mip)` to draw one layer.
2. A material `mrtNode` (`mrt({ output, normal })`) that writes two attachments.
3. Mips for every layer once the last view is drawn (three's `finishRender`).
4. `getClearColor`, `getMRT`, `setMRT` and `initRenderTarget`, as three's `WebGPURenderer` has them.

The native gpu scene already has the terminal impostor level and `DataArrayTexture` sampling. Only the bake seam is missing.

## Execution Phases

### Phase 1 — the facade has the bake seam

- [x] `getClearColor`, `getMRT`, `setMRT` and `initRenderTarget` on the facade renderer, and `impostorRawRenderer` accepts it. proof: a facade spec red then green — `render-target.spec.ts` (2 new tests) and `browser-surface.spec.ts` (own `output`/`normal` MRT nodes) red then green; `browser-tsl.spec.ts` red then green for free `element` and `transformNormal`, which the impostor surface reads
- [x] A layered render target draws the layer `setRenderTarget(target, layer)` names, and a two-attachment `mrtNode` writes both. proof: a native renderer test that reads back two layers and both attachments — `array_render_target` reads both layers and both attachments; `diffuseColor` into `output` reads 0.500 0.250 1.000 (red run 0, 0, 0)
- [x] Each layer gets its mips when the bake's last view is drawn. proof: the same native test reads a mip of two layers — `array_render_target` reads the mip tip of two layers

### Phase 2 — the kit draws impostors

- [x] `TN_WORLD_IMPOSTOR` reports a baked atlas for the fir on the default engine, not `reason=unsupported`. proof: Chrome DevTools on the kit, 2026-11-08 — `asset=fir level=4 views=16 bytes=2796160 reason=ready`, the same for fir-c, fern-a and fern-b, no console error. The kit needed four more engine fixes on the way, each red then green: `mat3(mat4)` lowers to the upper-left 3x3 (`tsl_mat3_of_mat4`), a positionNode caster with a geometry `boundingBox` is placed by it under auto-depth virtual shadows (`virtual_shadow_bounds_cache`), a shadow cutoff samples the node's own textures, and those textures join the cached sun map's signature (`alpha_test_node`)
- [ ] The overview view's `wideTris` and frame p95 on the default engine are at most the threejs arm's numbers above. proof: Chrome DevTools, the same build on both arms
  - 2026-11-08, later, 1920x1080, same pose, Playwright on the RTX 2080: presented p95 16.68 ms on both arms (60 fps; engine was 33.4 to 66.7 ms). Engine GPU frame 14.6 ms against threejs 9.9 ms, CPU frame p95 7.5 to 10.3 ms against 4.6 to 5.4 ms. Open: CPU frame p95 and GPU time are still over the threejs arm.
    How it was found: `TN_GPU_PASSES` put 47 of 48 GPU ms in the scene pass; hiding meshes by name put 43 ms in the near impostors (`fir:4:0`, `fir-c:4:0`); the WGSL captured from `createShaderModule` on both arms held 12 march loops and 38 atlas reads on the engine against three's 6 and 20, with the march mip level (derivatives included) evaluated inside the 33-step loop. Two lowering fixes, each with a red-green `tsl_shared_node` case: the normalNode lowers through the slots' one Lowering (0d6fb6fb2: 45-52 -> 21.7 ms GPU), and a hoisted variable is declared after the variables its value reads (74ccf227e: 21.7 -> 14.6 ms GPU).
    Both arms draw about 5 M main-pass triangles here (a three-style layer and frustum count: threejs 4.58 M, engine 5.07 M); the threejs arm's `TN_FRAME_BUDGET` `passes.main.triangles` of 94 k is a counting fault on that arm, not a drawing gap.
  - 2026-11-08, default engine, overview: `wideTris` 266 243 (was 26 186 069; threejs 256 402, +4 %), instances 7 308 (was 14 624). `TN_FRAME_BUDGET` frame p95 14.6 ms (mainPass 9.9 ms of Wasm CPU, 60 draws, 5.09 M main-pass triangles), rAF p95 33.3 ms (was 73.5 ms). Open: frame p95 is not yet at the threejs arm's 4.95 ms, and `wideTris` is 4 % over.

### Phase 3 — proof

- [ ] Visual judge: far trees on the default engine against the threejs arm, at the overview and edge views, 2 runs per arm. proof: a fresh judge verdict on PR #635

## Found on the way (not this PRD)

- The owned engine ignores `geometry.drawRange` in every draw: `renderer.cpp` encodes the whole index or vertex buffer, and no native test covers a range. three draws `max(start, 0)` to `min(count, start + count)`. Core's `ClusteredMesh` and `ClusteredBatch` (`setDrawRange(0, cursor)`) and the cell proxy (`setDrawRange(0, 0)` to hide a mesh) depend on it. The forest kit reaches none of them on the default engine, so it is not the overview gap below.
- The threejs arm's `TN_FRAME_BUDGET` `passes.main.triangles` reads 94 k at the forest overview, where a three-style layer and frustum count gives 4.58 M: the counter misses most of that arm's main pass, so engine-against-threejs triangle comparisons on it mislead.
- Paired overview run, 2026-11-08, same build: `wideTris` 257 840 (engine) against 257 488 (threejs). Main-pass triangles 5 087 113 against 90 619, draws 60 against 33, CPU frame p95 9.5 ms against 5.2 ms, presented p95 33.4 ms against 16.7 ms. The far trees now match; the main-pass gap was the counter above, not extra triangles.

## Acceptance

- [ ] The forest kit's overview runs at 60 fps on the default engine on the RTX 2080, with impostors baked and a NEUTRAL or IMPROVEMENT judge verdict against the threejs arm. proof: Chrome DevTools frame p95 and the Phase 3 verdict
