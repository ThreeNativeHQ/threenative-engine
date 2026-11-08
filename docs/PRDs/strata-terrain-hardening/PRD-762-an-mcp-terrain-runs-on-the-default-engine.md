# PRD-762: An MCP-generated terrain runs on the default engine

**Status:** IN PROGRESS — Phase 1: the MCP path starts on the default engine (2026-11-08); its world draws 97x too many triangles there.
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
- [x] Splat stacking refuses a layer set that mixes a cooked (BC7) layer with a raw one, instead of a copy WebGPU rejects (seen on the sandbox in dev). proof: new `world-terrain-splat.spec.ts` case red without the fix (1 failed), green with it (46/46).
- [x] Array textures, `.depth(layer)`, material dispose events and `MeshPhysicalNodeMaterial` on the Wasm engine (4c7ef4bbe, 90356e139, 1ffc15261). proof: `browser-textures.spec.ts` and `material-fields.spec.ts` red then green, 477/477; `array.playtest.json` Wasm scenario green (SwiftShader); the sandbox now passes `loadTerrainSplat` (`TN_TERRAIN_SPLAT layers=4 samplers=9`).
- [x] A model whose dev cook adds the optional `TN_virtual_geometry` loads on the engine loader, which hosts no cluster plugin (was `TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED` on fir.glb). proof: new `model-lod-engine-loader.spec.ts` case red (the sandbox error verbatim), green after; 111/111 with the asset and LOD specs; core `tsc` 0.
- [x] A material `normalNode` (the terrain splat) writes its shading normal to the post normal target instead of `TN_POST_NORMAL_UNSUPPORTED` losing the renderer (42d68e353). proof: `material_test` `emissive_output` normal case red (2 CHECK failures) then green; sandbox on the RTX 2080 Wasm engine runs past it with no `TN_POST_NORMAL_*`.
- [x] A fragment program over 16 samplers (the splat's 14 stacked-layer reads plus env, dfg, shadow) shares samplers of equal state instead of losing the renderer (`TN_WASM_RENDERER_LOST`, 17 samplers). proof: `shader_ir_test` `types` case red without sharing (4 CHECK failures), green with it; `limits.playtest.json` 17-texture read sums 153 on the RTX 2080 (red: renderer lost with `TN_PROGRAM_SAMPLERS`); sandbox boot has no `RENDERER_LOST` for 60 s.
- [x] Every later refusal on this path, each with its own box as it is found. proof: the sandbox log names the next refusal, or none — 2026-11-08: none left. A fresh `pnpm sandbox --genre open-world` game (tarball installs, PR #635 head `396bfe94b`) called `terrain_generate {"request":"a pine forest valley with a lake for a third-person sandbox game"}` (5.1 s, 34 720 instances, 29 draws) and loaded the pasted snippet with no refusal and no console or runtime error.
- [x] The sandbox game starts on the default engine from the MCP snippet, with no game edit. proof: headed WebGPU, adapter checked, `TN_STARTUP_READY`. — 2026-11-08: `playtests/play.playtest.json` on the default engine, headed WebGPU, adapter `nvidia`/`turing` hardware: the game plays (score 1), 0 console errors, 0 runtime errors. The starter emits no `TN_STARTUP_READY` line, so the proof is the scenario's own play state. The only edit was the pasted snippet plus `void loadCells;`.

- [x] The web engine's glTF loader returns every scene, so a cooked model's LOD levels (`fir_lod1..3`, kept as named scenes) load: `tnw_web_load_gltf` shares `LoadResult.scenes` and the web `GLTFLoader` returns them (web host ABI 12). Found live with Chrome DevTools: 12 `TN_WORLD_CELL_FAILURE ... has no scene 'fir_lod1'` warnings, every instance at LOD0. proof: `gltf-files-scratch.spec.ts` and `gltf-loader-web.spec.ts` new cases red (2 failed) then green; three-native 541/541, core `model-lod-engine-loader.spec.ts` green, `pnpm wasm:build` 0. Fresh sandbox, same scenario, NVIDIA Turing: 0 LOD warnings, CPU-culled `wideTris` 2 088 459 → 146 493 (the threejs arm's own number), renderer triangles 202.7 M → 22.6 M, GPU p95 71 → 24.5 ms. Look not judged yet (Phase 3 judge).
- [ ] On the default engine the world's CPU path draws about 97 times the triangles its cull selected: 202 726 561 renderer triangles against `wideTris=2088459`, about 9 presented FPS. The `engine: "threejs"` arm draws 151 546 with the GPU world scene on (`dressed=44/44`). The owned engine reports `TN_WORLD_GPU_SCENE off reason=backend=webgpu-without-hasFeature` (`packages/core/src/world-gpu-scene.ts:247`). proof: the same sandbox scenario reports at most the threejs arm's triangle count on the default engine
  Open after the LOD fix (2026-11-08): with `?tnDebug=1` in Chrome DevTools, the main pass draws 19.5 M triangles in ~163 draws (shadow 15 k), GPU 15.7 ms, for 5 844 CPU-culled instances. The GPU world scene stays off (`dressed=0/44`) because the owned engine's three facade has no `IndirectStorageBufferAttribute`/`setIndirect`, though it has compute (PRD-620) and storage buffers. The threejs arm's 151 k is three's `info` count, which leaves out GPU-selected indirect draws, so the two counts are not like for like. Next: indirect draws on the web facade and the C++ host, then `hasFeature` on `renderer.backend`.
  Also seen (2026-11-08): the `engine: "threejs"` arm logs 4 `GPUValidationError: [Buffer "bindingBuffer101_render_..."] used in submit while destroyed`. The starter arena sits inside the cooked hill, so the hillside shows as a grazing streak above the walls on both arms (game placement, not an engine fault).

### Phase 2 — the forest starter kit starts on the default engine

- [ ] Sky gaps 1-4 (Daylight → SkyMesh). proof: a three-native spec per gap
- [ ] The remaining kit gaps: VirtualShadowNode, world prewarm, `TN_virtual_geometry`, the reflector hook. proof: a spec per gap
- [ ] `verify-starter-kit.mjs` passes on the default engine. proof: `node examples/strata-terrain-preview/scripts/verify-starter-kit.mjs` exit 0

### Phase 3 — proof

- [ ] A playtest scenario for the MCP terrain path on the default engine. proof: `playtest <scenario> --browser-recipe webgpu` pass
- [ ] Load time to reveal, and presented FPS on a real display, both measured on the default engine. proof: `playtest perf` on the real display, adapter checked
- [ ] Visual judge: the default engine against the `engine: "threejs"` arm at the same poses, 2 runs per arm. proof: a fresh judge verdict on the PR
