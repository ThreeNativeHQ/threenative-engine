# PRD-652 — The native engine closes the sandbox game gaps

**Status:** IN PROGRESS
**Priority:** P1 — ten sandbox games stop on 0.3.6 at `StorageTexture` or the `metalness` scene-pass target (AC-1 to AC-4 open), which keeps PRD-637 AC-6 and AC-7 open.
**Complexity:** 6 (MEDIUM)
**Owner:** engine runtime
**Depends on:** PRD-620 (TSL compute, phases 1 and 2 done)

## Context

PRD-637 ran every sandbox game on the published 0.3.6 cohort. The native engine is the default
engine since PRD-624, and the owner rejected the `engine: "threejs"` fallback on 2026-10-15.
Two gaps stop five games each (`## Blocked on` in PRD-637):

- `Atmosphere` (`packages/core/src/atmosphere/luts.ts:87-162`) bakes three LUTs into a
  `StorageTexture` (HalfFloat RGBA) with `textureStore` in `Fn().compute(w*h)`, then samples them
  in later bakes and in the sky. The engine catalog has no `StorageTexture`, so the binder throws
  `TN_NATIVE_UNCATALOGUED_STORAGETEXTURE` (`packages/three-native/src/browser-entry.ts:99`).
  PRD-620 gave the engine storage buffers and compute dispatch, but no storage-texture binding.
- The forked `worldEnvironment.ts` in five games asks the scene pass for `metalness` and
  `roughness` for SSR. The native pass has `output`, `depth` and `normal` only
  (`packages/three-native/src/pass-node.ts:240-255`). `normal` is an extra geometry pass that the
  renderer runs when a post pass reads it (`runtime-native/src/engine/renderer/renderer.cpp:2871-2923`).

Smaller gaps, one game each: texture `clone` (`soul-cave`), `modelWorldMatrix` (`grove`), glTF
`KHR_materials_emissive_strength` (`rigged-run`).

## Solution

1. **StorageTexture.** Add `StorageTexture` to the catalog and a `textureStore` TSL node. The shader
   IR and the WGSL emitter get a `texture_storage_2d<format, write>` binding. The texture is
   allocated with storage and sampled usage, so a later compute or a material samples it. Dispatch
   order is the existing compute queue order.
2. **metalness and roughness.** One extra geometry pass, the same shape as the normal pass, writes
   the material metalness and roughness into one two-channel target. In Three.js a float MRT output
   fills every channel (`NodeBuilder.format` splats a float to a vector), so each name samples as a
   splat of its own channel: any component of `metalness` is the metalness.
3. **Small gaps.** Each is the Three.js behaviour on the engine facade, with a player test.

Each gap ships with a native proof in `packages/runtime-native/tests/native-engine/` (ctest on
`tn-native-engine-player-v8`, desktop V8 + Dawn), and one affected sandbox game runs it on web
(the Wasm engine is the web default) from `pnpm sandbox` tarballs. No release is published.

## Acceptance Criteria

Recorded on the phase boxes below.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `StorageTexture` + `textureStore` | `Atmosphere` LUT bake → `renderer.compute` (`packages/core/src/atmosphere/index.ts:256`) | `TN_NATIVE_UNCATALOGUED_STORAGETEXTURE` refusal deleted | Phase 1 |
| Scene-pass `metalness`/`roughness` | `scenePass.getTextureNode("metalness")` in SSR stage | `TN_NATIVE_PASS_TEXTURE_UNSUPPORTED` for these names deleted | Phase 2 |

## Decisions

- 2026-10-21 (agent): the material target is planned only when a post *pass* reads it, as the `normal` target already is. A graph whose output program samples `metalness` directly, with no pass, gets no target. SSR, the consumer, is a pass. Making output-only reads plan the targets (for `normal` too) is a follow-up, not this PRD.
- 2026-10-21 (agent): the first pirate run failed with `TN_WASM_GLTF_UNAVAILABLE` because the local `third_party/` had no cgltf, so the proof Wasm build left the glTF loader out. That is the build machine, not an engine gap: `node scripts/download-deps.mjs --only cgltf` fixed it, and the proofs since then link cgltf.
- 2026-10-21 (agent): the `modelWorldMatrix` player case draws `tn.scene` directly. On the V8 player, `RenderPipeline.outputNode = pass(scene, camera)` throws `TN_NATIVE_POST_INVALID`; that path is a follow-up, not this PRD.

## Execution Phases

#### Phase 1: StorageTexture runs on the native engine
**Status:** IN PROGRESS
- [x] A compute kernel writes a `StorageTexture` with `textureStore`, a second kernel samples it, and readback matches the written values. proof: `ctest -R native_engine_player_compute` (desktop V8 + Dawn). — 2026-10-21, RTX 2080 Dawn/Vulkan headless: `native_engine_player_{compute,compute_ops,imports,tsl_values}` 4/4 passed; the case also checks a material read (64,128,96,255) and the `TN_NATIVE_STORAGE_TEXTURE_FORMAT` refusal.
- [ ] `first-light` runs its own playtests on the Wasm engine with the `Atmosphere` sky. proof: `pnpm sandbox` tarballs, `pnpm test` in the game.
  Left: the StorageTexture error is gone. The next two gaps are fixed in the engine: TSL nodes now report `isNode` (core `Atmosphere.radiance` branches on it), `PassNode.getViewZNode()` exists, and a graph read of the scene `depth` binds `texture_depth_2d` (player case: linear depth 0.4 read back as sRGB 170 through the output and a post pass). The game rerun on a Wasm build with those fixes is pending.

#### Phase 2: The scene pass has metalness and roughness targets
**Status:** IN PROGRESS
- [x] After `setMRT(mrt({ output, normal, metalness, roughness }))`, `getTextureNode("metalness")` and `("roughness")` resolve and read back the material values on any channel. proof: `ctest -R native_engine_player_imports`. — 2026-10-21, RTX 2080 Dawn/Vulkan headless: a MeshStandardMaterial (metalness 0.25, roughness 0.75) read through a post pass as `vec4(metal.r, rough.g, metal.b, rough.a)` reads back (64, 191, 64, 191) ±2; `native_engine_player_{imports,compute,compute_ops,tsl_values}` 4/4 passed. One packed RGBA16Float geometry pass feeds both names, each sampled as a channel splat.
- [x] `pirate-authoring-retest` runs its own playtests on the Wasm engine with SSR on. proof: `pnpm sandbox` tarballs, `pnpm test` in the game. — 2026-10-21, a copy of the game on tarballs packed from 45cc873c0 with a cgltf Wasm build (`tn-native-engine-web.wasm` 3,640.35 kB), headed `--browser-recipe webgpu`, adapter nvidia/turing: `pnpm test` exit 0, 22/22 scenarios pass, no console errors, `ssrEnabled: true`.
- [ ] A fresh visual judge compares the native frames of both games against the same pose on `engine: "threejs"` (reference only) and returns no REGRESSION. proof: headed `--browser-recipe webgpu` captures, judge verdict on the PR.

#### Phase 3: Small gaps
**Status:** NOT STARTED
- [ ] Texture `clone()` returns an independent texture on the engine. proof: player test, then `soul-cave` past `water.ts`.
  Left: player test passes (`native_engine_player_imports`, RTX 2080, clone keeps the class and image, sampler and transform fields stay independent); the `soul-cave` run is pending.
- [ ] TSL `modelWorldMatrix` resolves in a material. proof: player test, then `grove` playtest.
  Left: player test passes (two parented quads read their world translation through `modelWorldMatrix.mul(vec4(0,0,0,1)).x` and `.element(3).y`); the `grove` run is pending.
- [ ] glTF `KHR_materials_emissive_strength` scales the emissive. proof: player test, then `rigged-run` playtest.
  Left: player test passes with cgltf linked (inline GLB sets `emissiveIntensity`, defaults to 1, an unknown required extension still fails by name); the `rigged-run` run is pending.
