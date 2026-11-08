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

- [ ] `getClearColor`, `getMRT`, `setMRT` and `initRenderTarget` on the facade renderer, and `impostorRawRenderer` accepts it. proof: a facade spec red then green
- [ ] A layered render target draws the layer `setRenderTarget(target, layer)` names, and a two-attachment `mrtNode` writes both. proof: a native renderer test that reads back two layers and both attachments
- [ ] Each layer gets its mips when the bake's last view is drawn. proof: the same native test reads a mip of two layers

### Phase 2 — the kit draws impostors

- [ ] `TN_WORLD_IMPOSTOR` reports a baked atlas for the fir on the default engine, not `reason=unsupported`. proof: Chrome DevTools on the kit
- [ ] The overview view's `wideTris` and frame p95 on the default engine are at most the threejs arm's numbers above. proof: Chrome DevTools, the same build on both arms

### Phase 3 — proof

- [ ] Visual judge: far trees on the default engine against the threejs arm, at the overview and edge views, 2 runs per arm. proof: a fresh judge verdict on PR #635

## Acceptance

- [ ] The forest kit's overview runs at 60 fps on the default engine on the RTX 2080, with impostors baked and a NEUTRAL or IMPROVEMENT judge verdict against the threejs arm. proof: Chrome DevTools frame p95 and the Phase 3 verdict
