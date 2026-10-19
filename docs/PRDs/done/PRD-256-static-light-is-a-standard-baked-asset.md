---
prd_contract: v1
---

# PRD-256 — Static light is a standard baked asset

**Status: COMPLETE, 2026-08-30. Web and Linux desktop-native render the same compiled GLB/KTX2; Android/iOS remain explicitly unsupported by the existing KTX2 guard.**

Executed evidence: [static-light verification](../../verification/prd-256-static-lightmap-2026-08-29.md).

Parent batch: feature-mining.

**Outcome:** an ordinary `.glb` or static scene placed in `assets/` receives deterministic
`TEXCOORD_1`/UV2 atlas coordinates and a compressed `.ktx2` static lightmap during the existing
`@threenative/assets` compile step. The game still loads the model through `ctx.assets.model()` and
uses ordinary Three.js `material.lightMap`; the same compiled artifact is packaged for web and
native. No scene format, editor, runtime baker, proprietary asset format, style preset, default
lighting rig, or new game-facing asset vocabulary is added.

**Complexity:** +3 touches 10+ files across `@threenative/assets`, `@threenative/core`, templates,
playtests and native packaging checks; +2 new build-time subsystem; +2 artifact correctness surface
(UV seams, chart padding, ray determinism, texture compression); +2 multi-platform proof = **9 →
HIGH mode. Mandatory checkpoint after every phase.**

## Why this is not PRD-245

PRD-245 is realtime SurfelGI: it owns frame-lifetime GPU buffers, scene BVH dispatch, surfel ageing
and a TSL node the game composites in `src/render/postprocessing.ts`. It remains a runtime lighting
mechanism whose cost can kill it on device.

This PRD is the opposite lane: **offline static lighting as compiled content**. At runtime it is just
an imported model with `geometry.attributes.uv2` and `material.lightMap` assigned to a `THREE.Texture`.
No frame graph, no GI node, no render-pass ordering, no runtime rays and no visual default enter
`packages/core`. If PRD-245 is refused on cost, this PRD can still ship; if this PRD ships, PRD-245
is still the owner for dynamic indirect light.

## The hard veto, answered first

The charter allows framework-owned mechanism only when every appearance decision stays with the
game. This design passes because the framework does **not** choose a lighting style:

| Appearance decision | Who makes it under this design |
| --- | --- |
| Which lights exist, their colour, intensity, falloff and shadows | **The input scene/game.** The baker reads them; it does not synthesize a rig. |
| Whether a material receives the baked contribution | **The input material/static flag.** Non-static or opted-out meshes are ignored. |
| Lightmap resolution budget | **A build-time asset option or per-asset metadata**, expressed as pixels/texels, not as style. |
| Runtime composition | **Three.js.** `MeshStandardMaterial.lightMap` and `lightMapIntensity` are ordinary fields the game can edit after load. |
| Tonemapping/post/exposure | **Generated `src/render/` game code**, unchanged by this PRD. |

The framework owns only the portable build mechanism: flattening scene-reachable static meshes,
generating UV2 charts, baking texels, encoding KTX2, writing manifest metadata and attaching the
result on load. Deleting the manifest lightmap entry or setting `material.lightMap = null` removes
the feature without editing package code; that is the negative control.

## Why the framework and not the game

A game can write a one-off bake script, but it cannot portably guarantee the resulting artifact is
what every target packages and decodes. The existing asset-pipeline series already established the
right boundary:

- `@threenative/assets` is Node-only and carries encoder dependencies the runtime must never inherit
  (`packages/assets/package.json:2-44`, `packages/assets/README.md:1-8`).
- `threenative build` already calls `compileAssets({ config: config.assets, cwd })` before both web
  and native packaging (`packages/create-threenative/src/build.ts:285-288`, `:428-432`).
- `compileAssets()` already walks `assets/`, runs ordered passes, writes content-addressed outputs
  and a versioned `assets.manifest.json` (`packages/assets/src/compile.ts:651-783`).
- `ctx.assets.model()` already resolves logical paths through that manifest, constructs stock
  `GLTFLoader`, wires `KTX2Loader` for `KHR_texture_basisu`, and returns the same Three.js object the
  game adds to the scene (`packages/core/src/assets.ts:287-388`).
- Native packagers already stage the same `public/` directory beside the game bundle
  (`packages/create-threenative/src/build.ts:439-495`).

So the product outcome belongs in the existing compile/load path, not in a new CLI command, runtime
baker, editor, or package. The public surface remains: put assets in `assets/`, run the existing
build/dev scripts, load with `ctx.assets.model('scene.glb')`.

## Upstream evidence and license plan

| Source | Evidence | License decision |
| --- | --- | --- |
| `repalash/xatlas-three` @ `8ae9119546b5` | README says it unwraps Three `BufferGeometry`, can pack multiple geometries into a single atlas for lightmap/AO baking, writes pack output to `uv2`, requires indexed geometry, and warns xatlas may add/remove vertex data (`README.md:1-4`, `:69-87`). `BaseUVUnwrapper.packAtlas()` adds indexed geometries, passes positions/normals/uvs to xatlas, writes generated coordinates to `outputUv` (default `uv2`), rewrites positions/normals/indices and remaps all remaining attributes through `oldIndexes` (`src/UVUnwrapper.ts:119-241`). | MIT (`LICENSE:1-21`, `package.json:14-26`). Admit as a build-time dependency only if Phase 0 confirms its transitive `xatlasjs` package is MIT-compatible and can be resolved locally, not from jsDelivr. Keep copyright notice. |
| `lucas-jones/three-lightmap-baker` @ `47fb4f640c60` | README states the technique: XAtlas generates UV2; render geometry in UV2 space to position and normal textures; iterate texels and cast rays; `three-mesh-bvh` accelerates raycasts (`README.md:33-50`). Source confirms `generateAtlas()` calls `unwrapper.packAtlas(geometry, 'uv2', 'uv')` (`src/atlas/generateAtlas.ts:27-34`), `renderAtlas()` draws world position and normal with `gl_Position = vec4((uv2 + offset) * 2.0 - 1.0, 0.0, 1.0)` and dilation offsets (`src/atlas/renderAtlas.ts:3-148`), and `LightmapperMaterial` traces from baked positions/normals against `MeshBVH` in a full-screen pass (`src/lightmap/LightmapperMaterial.ts:60-231`). | **No repository-level license was found. Do not copy source, shaders, constants or API.** Use the technique only: UV2 atlas → position/normal bake → ray/visibility accumulation → denoise/dilate → KTX2 output. |
| `Ibrahim-3d/three-lightmap-baker` @ `f0eee56182e0c13ff5232c265fb5c8d4dcae2ab7` | The current implementation confirms the same complete pipeline: XAtlas UV2 generation (`packages/baker-classic/src/atlas/generateAtlas.ts`), UV2-space position/normal/albedo atlases (`packages/baker-classic/src/atlas/renderAtlas.ts`), BVH-backed direct/indirect light sampling and progressive bake orchestration (`packages/baker-classic/src/lightmap/LightmapperMaterial.ts`, `packages/baker-classic/src/pipeline.ts`). | MIT (`LICENSE:1-21`, `package.json:1-8`). This is the licensed implementation reference. Mine bounded mechanisms behind ThreeNative's deterministic offline pass; do not absorb its browser editor, WebGL renderer ownership, scene format or API. |

No source from the unlicensed `lucas-jones/three-lightmap-baker` may be pasted into the
implementation. The Ibrahim repository is a licensed reference, not permission for a wholesale
port: implementation files must name the exact permissive source and keep the baker deterministic,
offline and inside the existing asset pipeline.

## Current in-repo facts

| Area | Current state |
| --- | --- |
| Asset compiler | `packages/assets/src/compile.ts` has `models`, `textures`, `targets`, pass registry, deterministic source walk and content-addressed writes. `PIPELINE_VERSION` is `3` and must bump when this pass changes output bytes. |
| Texture compression | `packages/assets/src/passes/texture.ts` encodes textures to KTX2 via `ktx2-encoder`, emits `.ktx2`, records `format` and `transcodeTargets`, and always generates mips. |
| Model optimization | `packages/assets/src/passes/model.ts` reads self-contained `.glb`, runs glTF-Transform, preserves scene-reachable counts/bounds through self-verification, and writes Meshopt/KHR quantized output. |
| Runtime loading | `packages/core/src/assets.ts` reads manifest version `1`, resolves logical model paths to compiled outputs, wires KTX2/Meshopt/Draco lazily, caches by logical path, and disposes model textures on release. |
| Build callers | `buildWeb()` and `buildNative()` both call `compileAssets()` before Vite/native packaging. Native package scripts receive `--assets <cwd>/public`. |
| Mobile compressed texture support | `assertNativeAssetsCompatible()` currently rejects `.ktx2` entries for Android/iOS with `TN_NATIVE_KTX2_UNSUPPORTED` (`packages/create-threenative/src/build.ts:127-176`), while desktop and web are allowed. Any mobile claim is therefore false until that gate changes or the PRD explicitly records the target as unverified/refused. |
| Existing lightmap code | The runtime-native tree contains legacy Mystral CLI lightmap stubs (`packages/runtime-native/src/cli/lightmap.cpp`) that import `mystral/tools/lightmap-baker`, but that is not the ThreeNative asset pipeline and must not become the product path. PRD-207 treated it as build-tool extraction debt, not as a shipped public feature. |
| Existing lightmap/UV2 surface | Repo search found no shipped `lightMap`, `uv2` or `TEXCOORD_1` usage in packages/templates. This PRD creates the first product path. |

## Product contract

1. A self-contained `.glb` under `assets/` that contains scene-reachable static meshes can compile
   into a `.glb` with valid `TEXCOORD_1` for every baked primitive plus a content-addressed `.ktx2`
   lightmap in `public/`.
2. Runtime loading remains `ctx.assets.model('level.glb')`. The returned `THREE.Group`/`GLTF` has
   ordinary Three.js materials with `material.lightMap` assigned to a `THREE.Texture`, and the
   geometry exposes `uv2`/`TEXCOORD_1` for that map.
3. The lightmap is a standard `.ktx2`; the model is a standard `.glb`. Any non-ThreeNative Three.js
   app with `GLTFLoader` plus `KTX2Loader` can load the compiled artifacts when given the manifest's
   resolved paths. There is no `.tnlightmap`, `.tnscene`, sidecar source format or runtime-only
   loader fork.
4. The bake is deterministic: same input bytes, same config, same dependency versions and same CPU
   architecture produce byte-identical `.glb`, `.ktx2` and manifest entries. If a GPU baker cannot
   meet that, Phase 0 kills it before implementation and the first implementation is CPU/offscreen
   deterministic instead.
5. Non-static, skinned, morphed or animated meshes are skipped or fail with a named reason. The
   first ship target is static environment lighting, not baked characters.
6. Web and desktop-native must consume byte-identical compiled artifacts. Android/iOS physical-device
   support must be reported only after execution; current KTX2 mobile refusal is an explicit blocker,
   not a papered-over TODO.

## Non-goals

- No realtime GI, surfel pool, light-probe runtime, dynamic rebake, progressive runtime baker or
  editor bake button.
- No new scene format, asset database, `.meta` sidecars, proprietary container or generated source of
  truth under `dist/`.
- No default lighting style, default light rig, post stack, tone mapping, exposure, LUT, material
  palette or art-direction opinion in packages.
- No new top-level `threenative bake` command. The existing `threenative build` / template dev watcher
  is the path.
- No copied code from `three-lightmap-baker` unless a license is later added and reviewed; this PRD
  assumes technique only.
- No mobile-ready claim from an emulator, simulator, package build, or desktop run.

## Proposed file ownership and callers

| File | Action | Reason / caller |
| --- | --- | --- |
| `packages/assets/package.json` | EDIT | Add MIT-compatible build-time UV/bake dependencies only after Phase 0 license check. Runtime packages must not inherit them. |
| `packages/assets/src/compile.ts` | EDIT | Parse lightmap config/metadata, include the new pass in the built-in registry, bump `PIPELINE_VERSION`, include manifest `lightmaps` metadata and preserve deterministic output ordering. Caller: `compileAssets()` from `create-threenative/src/build.ts`. |
| `packages/assets/src/passes/lightmap.ts` | NEW | Build-time pass: read `.glb`, select static primitives, generate UV2, bake/dilate/denoise, encode `.ktx2`, return modified model bytes and auxiliary texture output metadata. |
| `packages/assets/src/passes/lightmap-xatlas.ts` | NEW | Thin adapter over `xatlas-three`/`xatlasjs` or a replacement wrapper; all dependency-specific calls stay here. |
| `packages/assets/src/passes/lightmap-bake.ts` | NEW | Deterministic baker core. May use BVH/ray acceleration; must not import WebGL-only runtime code or rely on frame timing. |
| `packages/assets/src/index.ts` | EDIT | Export only build-time types/pass helpers needed by tests; no public runtime/game API. |
| `packages/assets/__tests__/lightmap-pass.spec.ts` | NEW | Determinism, UV2 existence, manifest shape, skip/fail reasons and negative controls. |
| `packages/core/src/assets.ts` | EDIT | After `GLTFLoader.parse()`, when the manifest entry names a compiled lightmap, load the KTX2 texture through the existing shared `compressedTextures.loader`, assign it to standard Three.js `material.lightMap`, and preserve cache/release disposal. Caller remains `ctx.assets.model()`. |
| `packages/core/__tests__/assets.spec.ts` | EDIT | Assert lightmap texture loader sharing, material assignment, release disposal and fail-closed missing texture behaviour. |
| `packages/create-threenative/src/config.ts` | EDIT only if needed | Validate an `assets.models` sub-option or asset metadata pass-through. Prefer no new game-facing key; if a key is unavoidable, it must be under existing `assets` and named in glTF/Three.js terms, not a new ThreeNative concept. |
| `packages/create-threenative/src/build.ts` | EDIT | Native mobile compatibility gate: either admit KTX2 lightmaps only when real mobile decoder support exists, or fail closed with a lightmap-specific message. Desktop/web path should require no new build branch. |
| `packages/create-threenative/templates/starter/assets/` | EDIT/ADD | One small real static GLB proof subject if no existing template asset exercises static lightmaps. Keep `src/render/` ownership unchanged. |
| `packages/create-threenative/templates/starter/playtests/static-lightmap.playtest.json` | NEW | Consumer proof: normal `ctx.assets.model()` path renders with baked lightmap on web. |
| `packages/runtime-native/conformance/registry.json` and scene fixture | EDIT/ADD | Desktop-native artifact proof: same compiled GLB/KTX2 loads through the native host. Android/iOS rows stay `UNVERIFIED` until run. |
| `docs/verification/prd-256-static-lightmap-<date>.md` | NEW during implementation | Evidence record, not authored by this planning-only task. |

## Integration ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `lightmapPass` in `@threenative/assets` | `packages/assets/src/compile.ts:388-397` pass registry, reached by `compileAssets()` | nothing; extends model compile output for eligible static meshes | n/a | disable only the pass → output GLB has no `TEXCOORD_1`, manifest has no lightmap entry, visual proof falls back to dynamic/direct-only lighting |
| 2 | XAtlas UV2 generation | `lightmapPass` before model write | hand-authored UV2 requirement | n/a | feed an indexed static mesh and remove UV2 write → `GLTFLoader` result lacks `geometry.attributes.uv2`, core assignment must refuse rather than attach a useless lightmap |
| 3 | Baked `.ktx2` lightmap auxiliary output | `compileAssets()` output writer and manifest | raw PNG/lightmap sidecar proposals | n/a | delete the `.ktx2` from `public/` after manifest write → `ctx.assets.model()` rejects naming the missing compiled lightmap |
| 4 | Runtime `material.lightMap` attach | `packages/core/src/assets.ts` `model()` branch, reached from every template's `ctx.assets.model()` | nothing; standard Three material field | n/a | comment out the attach call → binary consumer still loads geometry, but web/native visual A/B and material inspection fail |
| 5 | Native artifact proof | `packages/create-threenative/src/build.ts:428-495` packages `public/` and conformance loads it | self-comparing web-only proof | n/a | patch one byte in native-staged `.ktx2` → parity gate fails with two distinct paths and hashes |

## Phase 0 — kill and measurement gates before feature code

Phase 0 is mandatory. If any kill gate fails, close this PRD as `REFUSED` or `BLOCKED` with the
number and stop before writing feature code.

1. **License gate.** Verify `xatlas-three` and its transitive `xatlasjs` license from installed npm
   tarballs, not only GitHub prose. Record SPDX, package versions and notice obligations. If
   `xatlasjs` is not MIT/permissive or cannot be vendored/resolved locally without CDN access, do not
   depend on it; either select another permissive xatlas binding or block this PRD.
2. **No-copy gate.** Confirm `three-lightmap-baker` still has no repository-level license. Add a
   checklist item in the implementation PR that no source/shader/constants from it were copied. If an
   implementation file matches it beyond ordinary terminology, reject the PR.
3. **Determinism spike.** Build a scratch script outside tracked files that bakes the same small GLB
   twice in fresh temp directories, hashes `.glb`, `.ktx2` and manifest output, and proves equality.
   If the chosen GPU path is nondeterministic, switch to a deterministic CPU/offscreen path before
   Phase 1 or kill the feature.
4. **Measurement baseline.** On the candidate proof scene, record current direct-lit screenshot,
   model triangle count, texture bytes, build time, and runtime frame cost. This is not acceptance;
   it prevents later "looks different" claims without a baseline.
5. **Mobile blocker check.** Run or inspect `threenative build --target android` on a scratch project
   with one compiled KTX2 texture. Today it is expected to fail with `TN_NATIVE_KTX2_UNSUPPORTED`.
   Record this as the dependency for mobile lightmaps. Do not weaken the guard to make this PRD green.
6. **Consumer proof shape.** Create a scratch plain Three.js loader script that can load a compiled
   GLB plus KTX2 lightmap using only `GLTFLoader`/`KTX2Loader` and manifest data. If the design needs
   a private loader or scene vocabulary, kill it.

## Execution phases

### Phase 1 — UV2 atlas lands in the compiled GLB, with no lighting yet

**Goal:** prove deterministic XAtlas integration and glTF writeback before any bake quality debate.

**Files:** `packages/assets/src/passes/lightmap-xatlas.ts` (NEW),
`packages/assets/src/passes/lightmap.ts` (NEW skeleton), `packages/assets/src/compile.ts` (EDIT),
`packages/assets/__tests__/lightmap-pass.spec.ts` (NEW), one static GLB fixture (NEW under tests or
template assets).

- [x] Read self-contained `.glb` through `@gltf-transform/core` like `modelPass` does; external buffers
      remain unsupported with a named error.
- [x] Select only static mesh primitives: no skin, morph targets or animation-targeted nodes in this
      phase. Unsupported content either skips with report metadata or throws when the file is marked
      bake-required.
- [x] Ensure geometries are indexed before XAtlas; non-indexed conversion must preserve positions,
      normals, tangents, colours, UV0, joints/weights if present, and indices.
- [x] Write generated lightmap coordinates as glTF `TEXCOORD_1`; do not overwrite `TEXCOORD_0`.
- [x] Preserve material assignments and primitive count unless XAtlas requires vertex splits; if
      vertices change, compare world-space bounds and primitive material coverage, not raw vertex count.
- [x] Record atlas size, chart count, padding, texels-per-unit and skipped meshes in the manifest/report.

**Required tests and red controls:**

| Test | Assertion | Negative control |
| --- | --- | --- |
| `lightmap-pass.spec.ts` `writes TEXCOORD_1 for every baked primitive` | compiled GLB JSON has `TEXCOORD_1`; runtime parse exposes `uv2` | remove the writeback → red |
| `preserves TEXCOORD_0` | source UV0 count/data hash for unaffected vertices survives | accidentally write UV2 into UV0 → red |
| `is deterministic across temp directories` | byte-identical GLB from two runs | include absolute temp path in metadata → red |
| `fails closed on unsupported animated meshes when required` | named `TN_ASSETS_LIGHTMAP_UNSUPPORTED_ANIMATION` | silently skip a required mesh → red |

### Phase 2 — Bake position/normal/lightmap texels offline, then encode KTX2

**Goal:** produce a compressed static lightmap artifact and prove it is not a random texture.

**Files:** `packages/assets/src/passes/lightmap-bake.ts` (NEW),
`packages/assets/src/passes/lightmap.ts` (EDIT), `packages/assets/src/compile.ts` (EDIT auxiliary
outputs), `packages/assets/__tests__/lightmap-pass.spec.ts` (EDIT), `packages/assets/src/report.ts`
(EDIT).

- [x] Build a deterministic texel worklist from UV2. Do not depend on animation frame order,
      `requestAnimationFrame`, wall-clock time or GPU race order.
- [x] Generate world position and normal per valid lightmap texel, conceptually matching the
      upstream technique but not copying its shaders.
- [x] Cast visibility/light samples against a BVH or equivalent acceleration structure. Sample pattern
      is seeded from stable asset content/config, not from process/time.
- [x] Dilate edge texels so mipmaps do not bleed black across chart seams; record padding/dilation.
- [x] Encode the lightmap through the existing KTX2 path or a shared encoder helper. Lightmaps that
      store colour should use the existing colour-texture path; data maps must not be marked sRGB.
- [x] Manifest entries list the main model output and the auxiliary lightmap output without inventing
      a public file type. Example internal shape is acceptable: `entries['level.glb'].lightmaps[]`
      with `{ output, materialTargets, texCoord: 1, format: 'uastc'|'etc1s', bytesBefore, bytesAfter }`.
- [x] Bump `PIPELINE_VERSION` because identical source bytes now produce different model output.

**Required tests and red controls:**

| Test | Assertion | Negative control |
| --- | --- | --- |
| `produces a KTX2 lightmap with mip levels` | `ktx-parse` sees `.ktx2` and `levelCount > 1` | disable mip generation → red |
| `records the auxiliary output in the manifest` | logical model entry names the lightmap output and `texCoord: 1` | omit metadata → red |
| `casts occlusion, not a flat fill` | a blocker scene has darker texels behind an occluder | replace ray test with constant white → red |
| `dilates chart borders` | border texels are populated after dilation | skip dilation → red on seam fixture |

### Phase 3 — Runtime consumes it as ordinary Three.js material state

**Goal:** no game code changes beyond loading the same model logical path.

**Files:** `packages/core/src/assets.ts` (EDIT), `packages/core/__tests__/assets.spec.ts` (EDIT),
possibly `packages/core/src/index.ts` only if an already-public type must describe manifest shape
(prefer no export).

- [x] Extend manifest reading structurally while preserving version-1 backwards compatibility. A
      manifest with no lightmap metadata behaves exactly as today.
- [x] In `model()`, after `GLTFLoader.parse()` resolves, load each referenced `.ktx2` through the
      existing shared KTX2 loader. Do not create a second `KTX2Loader` or support-detection path.
- [x] Attach the texture to `material.lightMap` for the targeted material(s), and set `needsUpdate`.
      Do not set lighting style defaults, postprocessing, exposure, colour management policy or
      `lightMapIntensity` unless the source material already asked for it through standard data.
- [x] If the model has lightmap metadata but lacks `uv2`, throw `TN_ASSETS_LIGHTMAP_UV2_MISSING`.
- [x] Include lightmap textures in `release('model', path)` / `clear()` disposal through existing
      `disposeModel()` traversal.

**Required tests and red controls:**

| Test | Assertion | Negative control |
| --- | --- | --- |
| `assigns material.lightMap from manifest metadata` | parsed mesh material has a `THREE.Texture` in `lightMap` | remove assignment → red |
| `uses the shared compressed texture loader` | `detectSupport` still called once across model+lightmap+regular texture | construct second loader → red |
| `fails when UV2 is missing` | named error, no silent attach | remove UV2 from compiled GLB → red |
| `disposes lightmaps with the model` | texture dispose spy called on release/clear | skip traversal/attachment disposal → red |

### Phase 4 — Binary consumer and artifact parity proof

**Goal:** prove this is standard content, not a ThreeNative-only illusion.

**Files:** `packages/create-threenative/templates/starter/playtests/static-lightmap.playtest.json`
(NEW), small template proof asset(s) if needed, `scripts/__tests__/asset-parity.spec.ts` or existing
parity location (EDIT/NEW), conformance fixture/registry (EDIT/NEW), verification record (NEW during
implementation).

- [x] Web playtest loads the ordinary logical GLB through `ctx.assets.model()` and verifies a baked
      shadow/occlusion/colour patch is visible with no runtime light creating that exact pattern.
- [x] Plain Three.js binary consumer script loads the compiled `.glb` and `.ktx2` from `public/` with
      `GLTFLoader` and `KTX2Loader`, assigns `material.lightMap` using manifest metadata, and renders
      the same non-blank baked pattern. It must not import `@threenative/core`.
- [x] Web and desktop-native package parity gate prints two distinct resolved paths for the GLB and
      KTX2 plus equal SHA-256 hashes. Empty comparison exits `2`, never `0`.
- [x] Desktop-native conformance renders 300 frames with the compiled artifact staged from `public/`.
- [x] Android/iOS rows are either executed and recorded honestly or stay `UNVERIFIED` because current
      mobile KTX2 guards refuse the artifact. Do not infer device support from desktop native.

**Required tests and red controls:**

| Test | Assertion | Negative control |
| --- | --- | --- |
| web playtest | baked pattern visible; console clean | set `material.lightMap = null` after load → visual red |
| binary consumer | plain Three.js script renders using compiled files | import `@threenative/core` → test fails the import census |
| parity gate | two distinct paths, equal hashes for GLB/KTX2 | patch one byte in native-staged KTX2 → red |
| native desktop conformance | non-blank frame with baked pattern | omit `public/` staging → load failure, red |

### Phase 5 — Dev loop, report, rollback and docs inside generated-project instructions

**Goal:** make the feature usable without creating a new user workflow.

**Files:** `packages/assets/src/watch.ts` (EDIT only if auxiliary outputs need per-file reconcile),
`packages/assets/src/report.ts` (EDIT), template `AGENTS.md`/generated instructions only if user-agent
behaviour changes, verification record (NEW during implementation).

- [x] `watchAssets()` handles auxiliary lightmap outputs atomically: no manifest points at a half-written
      KTX2, and a failed bake keeps the previous good content-addressed output.
- [x] Report prints per-model bake time, atlas size, texel occupancy, skipped mesh reasons,
      lightmap bytes and KTX2 savings.
- [x] Rollback is one of: remove lightmap metadata/config from the asset, set lightmap pass disabled
      under existing `assets.models`/compile config, or set `assets.textures`/lightmap compression off
      for targets that cannot decode it. The no-manifest/raw GLB fallback must still load.
- [x] Generated-project instructions mention only the existing asset flow. They must not introduce
      `threenative bake`, editor steps, or proprietary terms.

## Acceptance criteria

- [x] A real static `.glb` compiled by `@threenative/assets` contains `TEXCOORD_1`/UV2 on every baked
      primitive, with UV0 preserved.
- [x] The compile step writes a content-addressed `.ktx2` baked static lightmap with mipmaps and a
      manifest entry linking it to the logical model path.
- [x] `ctx.assets.model('level.glb')` returns ordinary Three.js objects whose materials consume the
      bake through `material.lightMap`; game code uses no ThreeNative-specific lightmap API.
- [x] Removing the manifest lightmap entry or setting `material.lightMap = null` removes the visual
      contribution in the web playtest.
- [x] A plain Three.js consumer, outside ThreeNative, loads the compiled GLB/KTX2 using stock loaders
      and renders the baked result.
- [x] Web and desktop-native consume byte-identical compiled GLB and KTX2 artifacts, proved by a gate
      that prints two distinct paths and equal hashes.
- [x] Android/iOS physical-device status is stated exactly from execution. If unrun or still blocked
      by `TN_NATIVE_KTX2_UNSUPPORTED`, the PRD remains `PARTIAL` or names that blocker; it must not
      say mobile-ready.
- [x] `pnpm typecheck && pnpm lint && pnpm test` stays green on a machine with no CMake/NDK/Xcode;
      native proof stays in opt-in native/conformance gates.
- [x] Every acceptance-path negative control has an observed red recorded in `docs/verification/`.
- [x] No source/shader/constants from unlicensed `three-lightmap-baker` are copied.

## Verification commands

```sh
# Repository gate — no native toolchain required.
pnpm typecheck && pnpm lint && pnpm test

# Asset package focus.
pnpm --filter @threenative/assets test

# Template/web consumer proof.
sh scripts/xvfb.sh pnpm test:templates

# Plain Three.js binary consumer proof; exact script name decided in Phase 4.
pnpm tsx scripts/static-lightmap-consumer-proof.ts --project <scratch-project>

# Artifact parity proof; must print distinct paths and hashes.
pnpm tsx scripts/asset-parity.ts --kind static-lightmap --project <scratch-project>

# Desktop native proof, opt-in.
pnpm native:build && node packages/runtime-native/conformance/run-conformance.mjs --only-tests static-lightmap

# Device lanes only when hardware/simulator exists; record UNVERIFIED otherwise.
node packages/playtest/dist/runner/cli.js <static-lightmap>.playtest.json --target android --device <serial> --text
```

## Rollback and kill switch

Rollback must not strand a game:

1. Set the lightmap pass off for the asset/build config or remove the asset metadata. The compiler
   emits the ordinary optimized `.glb` and no auxiliary lightmap entry.
2. Existing `ctx.assets.model()` no-manifest and no-lightmap branches keep loading raw/unlit models.
3. Native mobile builds keep their current fail-closed KTX2 guard until real support is proven; do not
   relax it as a rollback.
4. If the pass corrupts a model, `modelPass`-style self-verification throws before manifest write, so
   the previous content-addressed output remains live in dev watch mode.

Kill conditions:

- Phase 0 cannot produce deterministic byte-identical output.
- License review cannot admit the XAtlas dependency, and no permissive replacement is selected.
- The first real proof scene requires a private loader, scene format, or nonstandard runtime object to
  consume the bake.
- The generated UV2/lightmap path is more code or workflow than telling users to run stock
  `gltf-transform`/DCC baking for the repeated cases measured.
- Web/native parity self-compares one path or passes with zero compared files.
- Mobile support is claimed from anything other than executed device/simulator evidence.

## Implementation notes for the next agent

- Start by reading `packages/assets/src/passes/model.ts` rather than writing a separate glTF IO path;
  it already handles self-contained GLB parsing, extension registration and drift checks.
- Keep auxiliary output writing deterministic and content-addressed. If `IAssetPassOutput` cannot
  express multiple outputs, extend the pass contract deliberately; do not sneak files into `public/`
  from inside a pass without the manifest knowing.
- Prefer internal manifest metadata over public API. The user-facing contract is Three.js:
  `TEXCOORD_1`, `uv2`, `material.lightMap`, `.glb`, `.ktx2`.
- Use the existing KTX2 encoder/loader path. A second lightmap texture loader is a duplicate runtime
  implementation and should fail review.
- Treat the legacy `mystral bake` C++ path as evidence of what not to expose: it names old Mystral
  APIs and imports a non-existent `mystral/tools/lightmap-baker`; it is not the ThreeNative product.
