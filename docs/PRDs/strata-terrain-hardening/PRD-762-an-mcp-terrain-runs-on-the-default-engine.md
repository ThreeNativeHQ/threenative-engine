# PRD-762: An MCP-generated terrain runs on the default engine

**Status:** IN PROGRESS
**Priority:** P0. An agent that follows the shipped path gets a game that does not start.
**Epic:** [Strata terrain hardening](README.md). Delivered with PR #483.

## Problem

The owner asked for a third-person sandbox game with a decent terrain that loads fast. The user path
is: scaffold a game, call `terrain_generate` on the `threenative-terrain` MCP, and paste the returned
load snippet. That path fails on the default Wasm engine (`engine: "threenative"`).

Reproduced on 2026-10-28 with `pnpm sandbox --genre open-world` (a starter game) and
`terrain_generate {"request":"a pine forest valley with a lake ..."}`. The MCP cooked the world in 5.4 s:
4,820 instances, 25 draws, a 21 MB GLB. The game then refused to start:

1. `TN_NATIVE_UNCATALOGUED_DATAARRAYTEXTURE` at `loadTerrainSplat` (`world-terrain-splat.ts:255`).
2. With the splat skipped (probe only): `TN_TSL uniform: argument 0 is not a TSL node ...`, which is
   `uniform(new Matrix4())` at `world-gpu-scene.ts:1916`.

The forest starter kit hits the same engine gaps plus four sky gaps. The 12 gaps were sized on PR #483
(comment 6484895203 and the AFK log): varyingProperty, modelViewProjection, assign on an expression,
vec3 construction (sky); array textures; MeshPhysicalNodeMaterial; material addEventListener;
`TN_virtual_geometry`; mat4 uniform; the reflector hook; VirtualShadowNode; world prewarm.

Rule: the native engine stays the default. An `engine: "threejs"` pin does not count as done.

### Phase 1 — the MCP terrain path starts on the default engine

Fix each refusal in the layer that owns it, in the order the path hits them. Every fix gets a red-green
spec.

- [x] mat4 uniform: `WorldGpuScene` builds its occlusion-view uniform on first kernel use, not in a class field. proof: `world-gpu-scene-engine-uniforms.spec.ts` fails without the change and passes with it; `world-gpu-scene.spec.ts` plus the new spec: 106/106 pass; core `tsc` 0 errors.
- [ ] Array textures: the terrain splat and its stacked layers draw on the Wasm engine. proof: a three-native spec, then the sandbox past `loadTerrainSplat`
- [ ] Every later refusal on this path, each with its own box as it is found. proof: the sandbox log names the next refusal, or none
- [ ] The sandbox game starts on the default engine from the MCP snippet, with no game edit. proof: headed WebGPU, adapter checked, `TN_STARTUP_READY`.

### Phase 2 — the forest starter kit starts on the default engine

- [ ] Sky gaps 1-4 (Daylight → SkyMesh). proof: a three-native spec per gap
- [ ] The remaining kit gaps: VirtualShadowNode, world prewarm, `TN_virtual_geometry`, the reflector hook. proof: a spec per gap
- [ ] `verify-starter-kit.mjs` passes on the default engine. proof: `node examples/strata-terrain-preview/scripts/verify-starter-kit.mjs` exit 0

### Phase 3 — proof

- [ ] A playtest scenario for the MCP terrain path on the default engine. proof: `playtest <scenario> --browser-recipe webgpu` pass
- [ ] Load time to reveal, and presented FPS on a real display, both measured on the default engine. proof: `playtest perf` on the real display, adapter checked
- [ ] Visual judge: the default engine against the `engine: "threejs"` arm at the same poses, 2 runs per arm. proof: a fresh judge verdict on the PR
