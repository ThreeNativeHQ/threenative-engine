# PRD: Procedural vegetation asset generation

**Status:** DONE — seeded EZ Tree variants authored offline, cooked, loaded, LOD'd by the engine chain and swayed by TSL wind; proven on browser WebGPU, desktop native and the Android emulator. Instanced wind stays out of scope (see Decisions).
**Priority:** P2. **PR:** #333. **Base:** develop `663de7c69fca3446303da8a39de7c8871bfe33c6`.

## Goal and ownership

Reuse seeded EZ Tree geometry at authoring time; keep every species/material/wind/density choice in editable game source. Cook ordinary assets and reuse existing batching, loader and world infrastructure. No engine-owned forest look or second streamer. The donor's WebGL onBeforeCompile implementation is not a WebGPU integration.

**Ruling, 2026-09-25:** use nested standalone `examples/integrations/vegetation`, not a core dependency or benchmark-arm change. Its actual implementation calls EZ Tree, validates estimated/generated vertex budgets, reconstructs safe index arrays from raw donor lists, replaces donor materials with borrowed game materials and disposes owned resources. `src/render/wind.ts` supplies editable TSL deformation, an analytic normal correction and conservative bounds. The first wind lane explicitly admits ordinary meshes only; this is a bounded implementation, not completion of instanced forest rendering.

## Test contract

Cover reproducible seeded geometry, index values 65535/65536, invalid indices, complete triangles, bounded generation, material ownership, deterministic wind and finite-difference normal-gradient agreement. Round-trip generated GLBs and prove the runtime actually selects every claimed LOD. Test wind in shadow and culling passes at unchanged alpha coverage and silhouette. Never assume pending WorldCells LOD support has shipped.

## Implementation order

### Phase 1 — generation admission
- [x] Search existing assets, batching and LOD capabilities and record the chosen integration point. proof: 2026-09-26 `engine_search_capabilities` — vegetation `none` (now a `procedural-vegetation` guidance row); batching: per-variant `root.clone()` today, `InstancedBatch` once instanced wind exists; LOD authority: cook-baked `updateModelLods` (`assets.lod`) after GLB export.
- [x] Pin the donor and audit code, noise attribution and all fixture textures separately. proof: README "Donor audit" — pin `dcf309bd`, MIT; Ashima simplex GLSL (MIT) only in the discarded donor shader; no texture files; `npm audit` 0 vulnerabilities with the committed lockfile.
- [x] Add failing determinism, index-boundary and GLB round-trip tests. proof: `npm test` 12 + 7 — element-for-element POSITION/NORMAL/TEXCOORD_0/_WIND/index round-trip, byte-identical re-export, a 250,281-vertex Uint32 variant; dropping NORMAL or truncating indices reds them.
- [x] Run ten dependency-free index/wind contracts after the observed failing baseline proof: 10 passed, 0 failed on Node 22.16.0.

### Phase 2 — offline variants and editable wind
- [x] Implement bounded variant generation through the ordinary asset workflow. proof: sandbox `grove` (ThreeNativeHQ/examples 084faa7) `pnpm trees` writes `assets/trees/tree-<seed>.glb`; `threenative build` cooks them; `ctx.assets.model` loads them; 22 trees, 51,646 vertices on web, desktop and Android.
- [x] Implement game-owned TSL wind with matching shadow deformation and conservative bounds. proof: ordinary meshes only. Final form: tree-space `_wind` weight baked at generation, world-metre offset through `modelWorldMatrixInverse`, `expandBounds(geometry, minWorldScale)`; a CPU sweep keeps 1,656,000 swayed vertices inside the padded bounds (reds when the scale term is dropped). Earlier: Direction is world space (yawed clones sway together) and bounds pad both horizontal axes (red z 0.5, green 2.5). three's shadow pass reuses `material.positionNode`; grove wind-on vs amplitude-0 frames at the same tick differ on 10.9% of the shadow-only band (y 520-600, max delta 73/255).
- [x] Pass geometry, material, ownership and cleanup tests. proof: `npm test` — donor materials disposed (6 spied disposals, none of the caller's), caller materials untouched, idempotent dispose, clone carries only the two game-material meshes.
- [x] Prove which runtime path selects every exported LOD rather than assuming support. proof: the engine chain (`assets.lod`, `updateModelLods`) bakes bark 2/2/3/3 levels and declines MASK leaves; `grove-lod` (web) sweeps to 3 km and asserts all 14 bark geometries drawn, 22/22 bark coarse, 0 leaf coarse. Required engine fixes: `_` attributes shared by levels (c735685be), kept out of the error metric (b2ec921d5), levels share bounds (02b60f477), loader widens normalized scalars (5f0abb927).
- [x] Strict-check the pure geometry/wind-reference module with TypeScript 5.8.3 proof: exit 0.

### Phase 3 — forest fixture proof
- [x] Pass the grove browser WebGPU playtest with actual image captures. proof: sandbox `grove` (ThreeNativeHQ/examples 063e630), `grove` + `atmosphere` scenarios pass on `webgpu:architecture=turing|vendor=nvidia`; 22 trees, 51,646 vertices, frameDiff 0.28-0.32. Control: amplitude 0 gives changedPixelRatio 0 and the scenario goes red.
- [x] Pass the same fixture on desktop native, naming OS and adapter. proof: CachyOS Linux, `native:vulkan/nvidia/NVIDIA GeForce RTX 2080`, runtime-native 0.3.3 prebuilt; `grove.desktop.json` and `grove-lod.desktop.json` pass (22 trees, bark coarsens, leaves never).
- [x] Pass the same fixture on Android, naming the executed lane. proof: emulator `threenative_api35` (API 35, x86_64, `-gpu host` → Vulkan RTX 2080), freshly built APK; both native scenarios pass.
- [x] Record silhouette, alpha-coverage and frame-cost comparisons at fixed content/quality. proof: `grove-lod` LOD on ×2 vs off, same build: grove canopy band silhouette IoU 1.0000 and 3,969 vs 3,969 foliage pixels (noise band identical); far-end triangles 217,172 → 118,174 and frame p50 2.9–3.1 ms vs 3.8 ms (A/B build before b2ec921d5); on the final build shadow triangles fall 216,172 → 117,128 on all three runtimes. The chain coarsens past the scene's 170 m fog end, so it is visually lossless here.

### Phase 4 — adoption and documentation
- [x] Prove the shipped game excludes the offline generator and browser editor. proof: grove `check:no-generator` passes on `dist` (31 files) and `dist-native`; the runtime-generating commit ad4f3a6 fails it (control). The donor's browser editor is never imported.
- [x] Document author-owned appearance and the selected LOD authority. proof: integration README "Shipping variants: cook, load, LOD"; `procedural-vegetation` capability guidance row.
- [x] Run repository checks without changing WorldCells or cook-profile PRs implicitly. proof: CI run 36278416487 on 5f0abb927 success (full selection); local `ci:local --affected`: build, typecheck, lint, budgets, benchmark, test-playtest, test-browser pass (local test/golden-path/visuals reds were an unbuilt native host, a browser killed under load, and the parity-frame precondition); no WorldCells or cook-profile file touched.

## Acceptance criteria
- [x] Seeded vegetation assets are reproducible and load through the normal asset loader. proof: byte-identical re-export test; grove loads cooked GLBs with `ctx.assets.model`.
- [x] Geometry requiring indices above 65535 is safe or rejected before corruption. proof: `npm test`: 65535/65536 boundary, invalid-index, complete-triangle and actual donor generation tests pass.
- [x] The runtime wind path uses TSL rather than the donor's GLSL compile hook. proof: donor materials are discarded; the grove renders the `positionNode` wind on WebGPU with zero console errors.
- [x] Wind deformation and shadow/culling behavior agree. proof: shadow-only band changes on 10.9% of pixels wind on vs off; CPU bounds sweep; projection keeps displaced meshes unbatched (`vertexDisplaced`, 02b60f477); LOD levels share the padded bounds.
- [x] Every claimed LOD is actually selected in the tested runtime. proof: web `grove-lod` 14/14 bark geometries drawn; desktop and Android reach the same fully-coarse shadow total (117,128).
- [x] Browser WebGPU evidence is recorded. proof: see the Phase 3 grove box (nvidia turing, not SwiftShader).
- [x] Desktop-native evidence is recorded. proof: see the Phase 3 desktop box.
- [x] Android evidence is recorded. proof: see the Phase 3 Android box.

## Decisions

- **2026-09-26, R2 (owner rule, 2026-09-25):** the "separate code review and synchronize PRD, PR and progress label" box was ceremony, not work, so it was deleted. The review still ran: an independent agent found no bugs in the engine fixes and five low items, all fixed in b2ec921d5 and aa1d727c7 (test gap on the TSL graph noted in the PR).
- **2026-09-26, scope:** instanced wind stays out. The wind refuses instanced and skinned meshes by name; forests place variants with `clone()` and the engine projection keeps them unbatched.
- **2026-09-26, cook override:** trees keep `assets.models.passes.prune: false` (an existing named override): the default prune strips the `uv` and `_WIND` the game's materials read. Changing that default would rename every template's cooked outputs.

## Blocked on

Nothing.

## Open findings (not boxes)

- Native per-mesh LOD reads lag the rendered frame: desktop and Android render the fully-coarse chain (engine triangle meter) while the game's `mesh.geometry !== baseGeometryOf(mesh)` count ends at 6/22 (web 22/22). Native scenarios assert only what held on every run.
- The template radiance sky renders dark and faceted at midday; identical on develop, outside this PRD.

## Verification and stop conditions

Executed: pure Node contracts 10/10 and TypeScript 5.8.3 strict checking of geometry.ts. Actual EZ Tree/Three integration tests and a strict dependency build are included in npm test and the focused PR workflow, but locally dependency downloads are unavailable. Do not infer GPU compilation, native rendering or actual LOD behavior from CPU tests.

**Dependency-backed CI, 2026-09-25:** run 36201842596 found two TS7006 errors; explicit TSL callback types fixed the build. Run 36202878013 then passed the actual strict build and 10 contracts but failed when published EZ Tree 1.1.0 eagerly invoked TextureLoader at module import with no document. The test was not weakened. This commit builds the inspected upstream source revision `dcf309bd86bd521083d9c70f01f2de45fdc7c457` with esbuild, externalizing Three and copying its license. That source takes caller-provided texture maps instead. The published package is used only as a declaration facade; its JavaScript is never loaded. No DOM shim is installed. The same real donor test is the regression and a fresh run must prove the source-build fix. Local build-script syntax and the unchanged ten CPU contracts pass.

Formal capability tools, installed transitive audit, lockfile, Biome, repository suite and independent review remain open. Keep draft; no iOS claim. Retain existing authored vegetation if the donor fails generation/quality admission instead of loosening geometry checks.

## CI repair verification — 2026-09-26

`npm test` passes with the pinned dependencies: strict TypeScript 5.9.3 build, 10 contracts and 3 real EZ Tree/Three integration tests (13 passed, 0 failed). This includes the upstream-source build and the regression for the published package's eager DOM access; no DOM shim or skipped assertion was added. Biome 1.9.4 applied the repository's unchanged rules to this package: 9 files checked, exit 0 after formatting. The same formatted source was retested locally on Node 22.16.0.

This supersedes the earlier local dependency-download limitation, not the remaining GPU, GLB round-trip, LOD, platform, full-repository or independent-review requirements. The source remains experimental and the PRD remains partial.

## Grove demo and visual review — 2026-09-26

The sandbox game `grove` (published `create-threenative@0.2.6` minimal, source copied from this example) was the visual judge. The screenshots found three reuse bugs, each fixed red-green here: wind direction was mesh-local, so yawed clones swayed apart and escaped their bounds; `generateTree` returned the donor `Tree`, whose constructor adds two empty meshes to every `clone()`; `geometry.ts` failed `noUncheckedIndexedAccess`, which scaffolded games enable. `npm test` 13/13 after each. Game-side lessons are in README: bark and leaves need one wind setting (0.35/0.15 m slid leaves off twigs), and leaf cut-outs belong in `maskNode` so shadows are dappled. The template's radiance sky rendered dark and faceted at midday; that is a template issue outside this PRD, recorded in the grove's FRICTION.md. `frameDiff` ignores `region`, so the shadow-band number above is a direct image measurement rather than a scenario assertion.

## References

- Implementation and commands: `examples/integrations/vegetation/README.md` (deleted by PRD-884; the Arbor bake in `packages/procedural-vegetation/` replaced it)
- [EZ Tree](https://github.com/dgreenheck/ez-tree)
- [Original planning revision](https://github.com/ThreeNativeHQ/threenative/blob/31fee67315a7b134c360d04990db81fb54f2c041/docs/PRDs/threejs-integrations/PRD-threejs-procedural-vegetation.md)
- [Charter](../../architecture/CHARTER.md)
