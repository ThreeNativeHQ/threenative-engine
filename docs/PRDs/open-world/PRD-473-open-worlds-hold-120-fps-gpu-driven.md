# PRD-473 — Streamed open worlds hold 120 fps: a GPU-driven world

**Status:** PARTIAL — filed 2026-09-28; PR375 GPU-scene continuity and the runtime impostor path are in flight (see execution status below).
**Priority:** P1 — Open: GPU culls and LOD-selects batched instances, bundles replay static draws.
**Complexity:** 9 (HIGH): compute culling, indirect draws, cached draw commands, runtime impostor bake and cook-time HLOD across core, assets and the three patch. Risk override: none.
**Owner:** engine
**Depends on:** [PRD-458 60 fps by default](PRD-458-open-worlds-hold-60-fps-by-default.md) (instanced chain LOD, main-pass cell culling, asset dedupe, chunk merge, shadow caster split, streaming prewarm).

## Context

Unreal 5 draws a streamed world at 120 fps without the game tuning anything. Four mechanisms do most of that work:
- **GPU Scene:** instance data lives on the GPU, and a compute pass culls and picks LOD per instance.
- **Cached mesh draw commands:** the CPU re-issues nothing for static content.
- **HLOD:** distant cells become one merged proxy.
- **Impostors:** distant foliage becomes billboards baked from the real mesh.

After PRD-458, ThreeNative still pays per draw and per instance on the CPU.

**Evidence** (machinefall `?scene=map-walk`, a 20 m/s flyover, RTX 2080 WebGPU, 1600×900, Xvfb + `TN_FRAME_BUDGET` + `TN_FRAME_SPANS`, 2026-09-28, after PRD-458's fixes):

| Cost (per frame) | Measured | Cause |
|---|---|---|
| Draw submission | 350–500 draws × ~20 µs of three.js JS each (Nodes/Bindings/Geometries updateForRender, pipeline lookup, encoder calls) = 7–10 ms | Every draw re-walks three's per-object path even when nothing about it changed |
| Main-cull repacks + LOD refilter | ~1–2 ms, plus uploads, when the visible set changes | Culling and per-instance LOD selection run on the CPU and rewrite instance buffers |
| Shadow level renders | fine 48 m: ~4/s × 222 draws × 6.9 ms; mid/coarse: 614 draws, 11–15 ms | The same per-draw JS path, per level camera |
| GPU vertex load | main 16–27 M triangles, shadow levels up to 30 M | Distant trees keep 37–58% of LOD0 triangles; hand-placed chunks draw full detail at every distance |

120 fps needs CPU and GPU frame p95 ≤ 8.3 ms. At ~20 µs per draw, the CPU budget allows ~250 draws for everything, so per-draw CPU cost must fall by an order of magnitude, not by tuning.

three r185 already provides the building blocks:
- `BufferGeometry.setIndirect` issues `drawIndexedIndirect`, so the instance count lives in a GPU buffer.
- `BundleGroup` records a pass's draws into a `GPURenderBundle` once and replays it: the replay skips pipeline, binding and encode work until `bundleGroup.version` changes.
- TSL compute with storage buffers and atomics.
- `InstanceNode` reads a storage-buffer `instanceMatrix` by `instance_index`, and `firstInstance` offsets it.

## Solution

1. **GPU instance scene.**
   - WorldCells keeps every resident placement in one storage buffer: matrix, asset key, and per-instance LOD and size data. It is written only when residency changes, as dirty ranges.
   - One compute dispatch per rendered camera (the main camera plus each shadow level camera) does frustum culling, picks each instance's LOD level by projected size, and applies the shadow size gate.
   - It appends survivors into one shared compacted matrix buffer, into each `asset:level:part` region, with an atomic counter into that key's `DrawIndexedIndirect` arguments.
   - Main and caster batches draw indirect with `firstInstance` = region start, and `frustumCulled = false`.
   - This deletes the CPU repack, the refilter and per-key cull for batched scatter.
2. **Cached draw commands.**
   - World batches (main and casters) and merged static chunks live in `BundleGroup`s: per pass, and per virtual-shadow level for casters.
   - Because instance counts are indirect, streaming, culling and LOD changes never invalidate a bundle. Only a structural change bumps `version`: a key minted or retired, or a material or geometry swapped. So does the settled-static contract.
   - Per-frame CPU for the world becomes O(bundles), not O(draws).
3. **Foliage impostors (automatic).**
   - When an asset with foliage is adopted, the engine bakes an octahedral impostor with the game's own renderer: N×N views into an atlas render target (albedo+alpha, normal, depth).
   - The impostor becomes a final LOD level beyond the chain, switched by projected size like any level, drawn as one instanced quad per tree.
   - It also casts into the coarse shadow levels.
   - The bake runs once per unique asset behind the loading prewarm, and is cached by the cooked content hash.
4. **HLOD for hand-placed chunks.** The cook bakes, per world cell, a merged and simplified proxy of that cell's chunks: one mesh per material group, simplified to a projected-error budget. WorldCells swaps a chunk for its cell's HLOD proxy beyond the HLOD distance, and the proxy also casts into the coarse shadow levels.
5. **Measured promise.** The machinefall map holds CPU and GPU frame p95 ≤ 8.3 ms with 0 console errors, with no game-side option.

Consumer flow: unchanged. A game calls `WorldCells.load({ … })` and builds with `threenative build`. The cook adds HLOD proxies, the runtime bakes impostors and builds the GPU scene, and no option is required. Every mechanism has an off switch for debugging: `gpuScene: false`, `bundles: false`, `impostors: false`, `hlod: false`.

Risks:
- **Native.** WebGPU compute and indirect draws must exist on the native runtime (Dawn). An unsupported backend falls back to PRD-458's CPU path, reported by a `TN_WORLD_GPU_SCENE` marker naming why. It is never silent.
- **Bundles and per-object state.** A per-object uniform that changes (a mover) would re-record a bundle. Movers stay outside bundles; world batches are static by construction.
- **Impostor look.** Parallax and lighting at the switch distance. The switch is chosen by projected size (a few pixels of error), and the atlas carries normals so lighting matches.
- **Atomic append order is nondeterministic.** Draw order within a key can vary frame to frame. Opaque plus depth test makes that invisible; alpha-tested foliage is order-independent.

## Shadow bundle feasibility

**Not feasible** for the caster halves under three r185, so stage 2 is not attempted. The bundle *is* recorded per camera — `RenderBundles.js:39-48` keys on `[bundleGroup, camera, renderContext]`, fetched with the camera at `Renderer.js:3182-3184` and replayed at `1292` — so each level's ortho camera would get its own record. But a record's render list is built once, when `version` moves (`Renderer.js:1270-1272`), and `_projectObject` bakes the object's `visible`, `layers.test(camera.layers)` and `frustum.intersectsObject` into it at that moment (`Renderer.js:3082-3132`; children are re-projected only at `3204-3213`). A replay while `version` is unchanged reuses that frozen list (`Renderer.js:1319-1341`) and re-reads none of the three. The shadow node mutates exactly those on every level render: `#probe` sets `level.shadow.camera.layers` (`packages/core/src/render/virtual-shadow.ts:1031-1035`), flips cluster/wide with the window (`1030`), hides sub-texel casters and swaps in coarse geometry (`1007-1010`, `943-946`), and `#restoreHidden` puts them back (`1050-1053`), while the camera is re-placed each render (`1612`) and `updateMatrices` runs before `renderer.render(scene, shadow.camera)` (`ShadowNode.js:702-710`). Caster meshes keep `frustumCulled = true` (`world-cells.ts:4773-4783`), so their culling is baked stale as the window moves. Correctness would need a `needsUpdate` bump on every level render — re-paying the per-draw cost the bundle exists to remove, with no non-rendering frame to replay on — and a bundled caster cannot be hidden or re-layered, which negates the probe's texel gate and cluster/wide split. Solution item 2's "per virtual-shadow level for casters" half needs re-planning (GPU-side caster culling, AC-1, is the real answer).

## Acceptance Criteria
- [ ] AC-1 [local]: WorldCells culls and LOD-selects every batched instance on the GPU. A 200-frame walk performs 0 CPU instance-buffer repacks and 0 CPU level refilters for batched scatter, and the drawn instance set equals the CPU reference path's set, frame by frame, on the fixture. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts` plus a browser readback census on machinefall. Result: 30/30 in the spec, 2020/2022 in `pnpm exec vitest run packages/core` (2 pre-existing skips). Browser at 863f83258 on machinefall `?scene=map-walk`: `TN_WORLD_GPU_SCENE_VALIDATE ok compared=200 … meshMismatched=0`, and the same-pose screenshot is the CPU path's picture. GPU frame p50 went 10–18 ms → 9–15 ms and CPU p95 improved, so the scene flipped to the default here.
- [ ] AC-2 [local]: world batches and static chunks replay from render bundles. A 200-frame walk re-records bundles only on key mint/retire, and per-frame JS in the render phase for the world is ≤ 1.5 ms at 400 world draws. proof: `world-bundles.spec.ts` (bundle version counters) plus `TN_FRAME_SPANS` on machinefall.
- [ ] AC-3 [local]: a foliage asset gets an automatic octahedral impostor as its last LOD level, drawn beyond the chain, casting into the coarse shadow levels. Past the impostor distance, triangles per tree are 2. proof: `world-impostors.spec.ts` plus a visual-baseline capture at the switch distance.
- [ ] AC-4 [local]: the cook bakes a per-cell HLOD proxy for hand-placed chunks, and WorldCells draws it beyond the HLOD distance: one draw per material group per cell. proof: `packages/assets/__tests__/hlod.spec.ts` plus the `TN_WORLD_CHUNK_MERGE` / `TN_WORLD_HLOD` markers on machinefall.
- AC-5 (map-walk at 120 fps) moved to [PRD-475](PRD-475-open-world-120-fps-without-visual-loss.md) on 2026-10-01 (João): this PRD keeps the mechanisms, PRD-475 owns the frame target and the no-visual-loss check.
- [ ] AC-6 [local]: every mechanism falls back to PRD-458's CPU path on a backend without compute/indirect support, reporting why in `TN_WORLD_GPU_SCENE`. proof: a unit test with a backend lacking `drawIndexedIndirect`.

## Phases

### Phase 1 — GPU instance scene (AC-1, AC-6)
The largest CPU and GPU win, and the prerequisite for bundles.
- [x] One compute dispatch culls and LOD-selects every resident placement into a shared compacted matrix buffer, and every main key draws its own region of it through an indirect record. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts`.
- [x] A backend without compute, storage buffers or `drawIndexedIndirect` falls back to the CPU path and names why in `TN_WORLD_GPU_SCENE`. proof: the same spec's `gpuSceneUnsupported` cases.
- [x] The scene is on by default, and `gpuScene: false` / `?tnGpuScene=0` / `TN_GPU_SCENE=0` is the CPU path. proof: the same spec, with the CPU-path test asking for `gpuScene: false` explicitly.

### Phase 2 — Cached draw commands (AC-2)
- [x] CPU main-batch material eligibility reuses bounded mutable-graph snapshots, invalidates deep unversioned edits and repaired joins, tracks live material visibility, and retains unsupported array materials on the per-object path; diagnostics report actual CPU/GPU bundle membership. proof: `world-bundles.spec.ts` → 25/25; three review regressions reproduced first; core TS7 7.0.2 package typecheck → exit 0. This proves source correctness and stable-graph allocation avoidance, not a measured frame-time gain.
- [ ] Every GPU-dressed main batch mesh is parented under one `BundleGroup`, so a settled walk replays its draws instead of re-walking three's per-object path. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts`.
- [ ] `bundleGroup.needsUpdate` moves only on a structural change, and `stats().bundle` counts the records against the keys minted and retired. proof: the same spec's 200-frame streaming walk.
- **Bundles: measured no gain, default off, and why.** On machinefall's map-walk, with bundles on (the old default) the trees near the camera were not drawn while their shadows were: the adaptive texel gate in `VirtualShadowNode#probe` hides sub-texel casters with `visible = false` and `#restoreHidden` puts them back, and a bundle bakes each object's `visible` into the render list it records — a re-record taken while a tree was gate-hidden lost the tree for good. A/B on the same walk also measured no CPU p50/p95 gain, because the main thread is mostly idle and the frame is GPU/present bound. So `bundles` is now opt-in (`bundles: true`, `?tnBundles=1` or `TN_BUNDLES=1`), and the gate skips a bundled mesh so opting in cannot reproduce the conflict.

### Phase 3 — Impostors (AC-3) and HLOD (AC-4)
They are independent; the executable plan is below. Impostors are not implemented in the visibility pass.

- [x] The existing cook accepts eligible static scatter alongside chunks, preserves cutout triangles and placement transforms, publishes explicit coverage/bounds and a conservative error, and declines an unsupported cell whole. proof: focused `packages/assets/__tests__/hlod.spec.ts`, `packages/core/__tests__/world-package.spec.ts` and `packages/core/__tests__/world-cell-proxy.spec.ts` → 76/76 CPU tests, one worker on cores 10,22; changed-source strict typecheck → exit 0. Runtime integration and visual/performance acceptance remain open.
- [ ] WorldCells loads and atomically selects the ready cell proxy through its existing admission/cache paths, retaining source fallback, protected near detail, source shadows and collision; cancellation, eviction and charged decoded proxy resources stay bounded. proof: `packages/core/__tests__/world-cells-hlod.spec.ts` plus browser/native playtest observations of source/proxy coverage, lifecycle and timing. CPU implementation is present: four changed-behavior specs pass 68/68, including bundle, empty authored-LOD, selector and lifecycle controls. Real backend, visual, shadow-cost and timing acceptance remains unrun; zero-count submission observations and logical resource charges are not execution-time or physical GPU-memory measurements.

### Phase 4 — Measure and tune

Moved to PRD-475 with AC-5 (decision 2026-10-01, João).

## GPU-driven main-pass visibility (bugfix + continuity)

**Capability survey (game engine MCP, before any code).** `engine_search_capabilities` for the
impostor/billboard/LOD-culling family, then `engine_capability_detail` on every hit: there is **no
installed impostor capability**, so Phase 3 still has to build one, and the two matches are
`WorldCells` (`@threenative/core/world`; bounded cell residency, the GPU scene and the main cull) and
`Billboard3D` (the billboarding mechanism). **No new culling helper is needed** — the coarse gate
belongs where the placements and the batches already are.

**Constraints.**
- The CPU assigns a placement's level from the follow point when it builds it; the dispatch re-picks
  the level from the camera every frame. `#refilterStale` is deliberately off while the scene is on,
  so the CPU's per-level membership is stale by construction and must never decide what is drawn.
- The main pass keeps a coarse CPU gate for the ~230 meshes of a 2 km walk: a dressed mesh submits an
  indirect draw, and the record's zero count already draws nothing.

**Root cause (PR375, confirmed).** `SharedBatch.visibleFrom` gated each GPU-dressed mesh on that
mesh's own `#squareSizes`, the CPU's stale per-level membership, so a key holding no cell of its own
was hidden even when the dispatch selected its instances; `#publish` wrote the owed-prewarm
visibility onto the same mesh. A tree walked into at a level it was not built at disappeared.

### Phase V1 — the per-asset coarse gate, the sphere, and the drawn-buffer bound
- [x] Red on the committed fixture: a follow point parked past the 60 m switch builds every pine into the coarse level, the camera then walks in, and `pine:0:<part>` was `visible === false`. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts -t "keeps the near LOD mesh"` → 1 failed, `expected false to be true` at `mesh.visible`.
- [x] Fix at engine ownership: the coarse gate is computed once per asset (the union of every level and part's visible cells, including a key that still owes its prewarm draw) and applied to every dressed mesh, so the indirect record decides what each key draws. proof: the same command → 1 passed; `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts packages/core/__tests__/world-cells-main-cull.spec.ts packages/core/__tests__/world-bundles.spec.ts packages/core/__tests__/world-cells-shadow-prewarm.spec.ts` → 58/58; `pnpm --filter @threenative/core typecheck` clean.
- [x] Rotated off-centre source sphere: `#addPlacements` applies the placement matrix to the authored bounds centre instead of translating it, so a turned prop's sphere follows its quaternion. proof: `world-gpu-scene.spec.ts` test "hands the dispatch a turned off-centre prop's sphere centred where its quaternion carries the bounds" — a production `WorldCells.load` over a synthetic package (bounds `0…20` along +Z, one +Y quarter-turn placement) with `vi.spyOn(WorldGpuScene.prototype, "place")` asserting the bound centre `(10,0,0)` and radius `5`; the old translate-only wiring would answer `(0,0,10)`.
- [x] The dispatch's level test never draws one placement from two keys. proof: the same spec's "sends each placement to exactly one level, so two keys never draw it twice" — a `cullAndSelect`/`kernelDrawn` identity oracle over 12 placements across three levels, each mapped back to exactly one region.
- [x] A re-dress that re-registers the keys it already holds is a no-op, and a repeatedly regrown level re-packs from zero rather than appending: the drawn buffer stays bounded. proof: the same spec's "keeps a level's run and the drawn buffer stable across unchanged registrations" (bytes, offsets and version unchanged over 200 registrations) and "bounds the drawn buffer when a level is repeatedly regrown and re-streamed" — exactly `2 × 64 B/mat4 × capacity` per round, peak 32,768 B against the 65,536 B bound; before the fix 200 identical registrations took 65,536 → 16,777,216 B.
- [x] A dressed mesh is submitted at its region's capacity, so three's `RenderObject.getDrawParameters` admits an initially-empty indirect batch instead of skipping the draw before the GPU reads the record. proof: the same spec's near-LOD test runs the real `getDrawParameters` with `count > 0` and the indirect record present, bundles on and off.
- [ ] Visual acceptance (browser, OPEN): machinefall `?scene=map-walk&tnGpuScene=1` keeps every LOD switch drawn on approach, with `TN_WORLD_GPU_SCENE_VALIDATE ok compared>0 … meshMismatched=0` over 200 frames, 0 console errors, and no tree popping. proof: the machinefall walk log plus a same-pose capture. Evidence 2026-10-01 (box left open: popping in motion not checked): the 4-pose walk with `tnGpuSceneValidate=1` printed 53/53 `ok` markers, every one with nonzero GPU instances and `mismatched=0 meshMismatched=0 matricesMismatched=0`, 0 console errors; same-pose captures on PR #375.

### Phase V2 — continuity for the rest of the GPU scene
- [x] The bundles opt-in path is unaffected, because a bundled mesh never used the gate, and the near-LOD gate holds with bundles on as well as off. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` → 4/4; the same spec's near-LOD case runs both bundle modes. Impostor architecture (Phase 3) continues separately.

## PR375 execution status (runtime impostor path)

Scope: near full visibility + sparse middle foliage + bare hills with the real exported trees. Parent brains and reviews; all execution arms use DeepSeek V4.1 Flash exclusively.

**Stabilization 2026-10-01 (visual regression fixed; supersedes the checkpoints below):** the road/forest-floor shadow loss was the whole-asset impostor replacing the trees' coarse wide-shadow casters, so `impostors` is now opt-in (default false) until the impostor casts a forest shadow. The MapViews empty forest had three engine causes in `world-cells.ts`, each red-green in a spec: (1) terrain spent the whole admission budget after a jump and starved the prop queue (props now keep half while queued; `world-cells-admission.spec.ts`); (2) the one-ring residency hysteresis filled the cell budget after a jump, so the cells around the camera were refused (on a jump of more than one cell, read off the follow point rather than the lookahead, an unwanted cell yields; same spec, 8 → 5 refused); (3) with the GPU scene on the refilter was skipped, so a placement a build culled at `maxDistance` never got a source record (the refilter now runs on the cull gate only; `world-gpu-scene.spec.ts`, and the same walk rebuilds strictly fewer entries than the CPU path). Proof on machinefall (NVIDIA WebGPU, 1280×720, Xvfb): walk and views pass with 0 console errors; views validate GPU = CPU instances at all four poses; core 2148/2148, `pnpm typecheck` rc0, `pnpm lint` rc0 (warnings). Timing is not claimed: load average was ~30 during these runs and two identical walks read render p50 21.4 vs 9.0 ms; the deterministic walk counters (evictions 45 vs 44, residence changes 14 vs 13) match the pre-fix build. Impostors (AC-3), HLOD, 120 fps and native stay open.

**Checkpoint 2026-09-30 (checkpoint push, PARTIAL — not complete):** 10 relevant specs pass 282/282 (`/tmp/pr375-lane-1526754/lane-specs2.log`); `pnpm typecheck` and its rerun exit 0 (`typecheck2.log`); `pnpm lint` exits 0 with warnings only (`lint.log`). Full `pnpm test` is RED in the `runtime-native` contract suite — timestamp-query, crash-handler-policy, rg11b10-renderable, pump-silence and runtime-next-contract (18 failed) — log `/tmp/pr375-suite-partial.log`; `world-impostors.spec.ts` also fails the loader-cache-dispose case. The playtest lane's affine walk ran 4,926 frames but failed with 67 destroyed-texture submits, and the views describe timed out at 15 s. The first ownership guard STILL needs the generated chunk-geometry / custom-`loadModel` fixes and the cached-chunk clone. The user rejected the weaker shadows; visual acceptance is OPEN. No PRD box is ticked from this partial proof.

**Latest checkpoint — requested rollback on primary main (2026-09-30):** machinefall primary checkout now pins the BEFORE core archive `threenative-core-0.3.3-pr375-binding-054d0f866554.tgz` in package.json/lockfile; installed world.js is `6bf2e20958e9307339f25a43dfd1a50cd539cd2d8d761eda689c9ac2c23dc582`. Install, typecheck and build passed (chunk `index-C5mU3zkS.js`). A fresh WebGPU walk from primary main passed 27/27 assertions with zero console/network errors; parent opened `/home/joao/projects/machinefall/PR375-rollback-main.png` (SHA256 `7ae48952d48a302d4235297d5eb4b701a62c37b46b4e01b385ccb0c1432b02e5`) and confirmed the baseline road/forest shadows return. Capture artifacts: primary `apps/client/.threenative/pr375-main-rollback-20260930-140908/`. This capture used the existing cooked world copied into primary dist after the first capture exposed missing raw inputs; no fresh world cook is claimed. Primary now also has self-contained raw inputs: 527 real files / 8.5 GB / zero symlinks, with representative hashes matching the source, ignored by the existing assets/world rule. Main preview remains on 4191; the owned task preview on 4190 was stopped. No source edit, branch merge, commit or push was needed for this rollback. Source review identified the shadow regression: the whole-asset alpha-cutout impostor replaces coarse opaque trunk casters, then the wide shadow alpha-caster filter disables it. A shadow-role correction and alleged upside-down foliage still need visual proof before another candidate is installed. Quality remains a hard requirement; 120 fps, GPU parity, far hills and native acceptance remain open. The following candidate checkpoint is historical and visually rejected.

**Current checkpoint (2026-09-30, resumed from HANDOFF.md):** reviewed CORE fixes passed 113 focused integration/constraints checks plus 20 baker/surface checks and core typecheck; assets passed 18 HLOD, 5 dedupe and 44 compile checks plus assets typecheck. Both packages built and passed publint. Game installed immutable core `ada8e996fa62` (world.js `e1d3c2f9da139bcf2cd64e47899dd8f3437871cc352f40081e9976a9869e7136`) and assets `86ff3695376c`; typecheck/build passed, chunk `index-vKqoQLsF.js`, 86 cooked HLOD proxies, runtime HLOD still absent. Real NVIDIA captures are in machinefall task `apps/client/.threenative/pr375-session-after-core-ada8e996/`: plain views/walk passed with zero console/network errors. Parent opened same-pose BEFORE/AFTER highway images: walk foliage is visibly denser, but MapViews forest is still absent (GPU counts mostly zero). Validation walk failed with 43,321 console errors and late blank captures; 47 nonzero readback samples yielded 9 mismatches and 38 errors, not 200-frame parity. Plain walk median CPU-window p95 was 13.2 ms, above 8.3 ms; AC-1 is reopened and AC-5 remains open. Source validation snapshot now retains placement scale (53 GPU tests and core typecheck pass); this fix is not yet installed. Opus and broad DeepSeek static-camera diagnostics each timed out after 900 seconds; the wrapper now preserves partial timeout output. A narrower CPU MapViews probe at the same highway pose rendered 42,061 instances / 300 draws / 13.6M triangles and parent opened its dense-forest capture (`apps/client/.threenative/pr375-static-cpu-ada8e996-20260930-125116/v2-highway_air.png`). GPU omission is therefore narrowed to the GPU path; the CPU probe itself failed its console-error assertion with 25 destroyed RGBA16Float post-target errors and an initially blank v1 capture. A second GPU-path read-only diagnosis also timed out; an exact one-pine decoded-bounds comparison replaces that broad investigation. Playtest doctor passed; engine doctor failed its mixed-version check (assets 0.3.4 vs core/runtime 0.3.3), without establishing that as the rendering cause. Allocation ownership review found replaced buffers weakly held and GC-eligible, so no speculative lifetime fix was made; existing validation markers now include finite renderer memory counters and scene footprint bytes when available (55 GPU tests and core typecheck pass); this telemetry is not yet installed and is completion-time rather than peak memory. The first validation GPU error is VK_ERROR_OUT_OF_DEVICE_MEMORY; later invalid-resource errors are cascading symptoms. Far-source acquisition, coarse shadows and handoff now pass 23 impostor checks, but parent requires one aggregate per exact atlas key, complete physical-budget accounting and source-release/LRU proof before installation; the corrected one-key aggregate now passes 27 impostor checks, including alias-growth retry disposal, direct far-pinned LRU pressure and shadow invalidation. Parent found its main-pass distance gate used 3D instead of the source path's world-XZ distance; that correction is running. Source release remains incomplete: WorldCells disposes its own parts but never releases model paths from the shared AssetLoader cache, which retains original source textures for its lifetime. A bounded ownership review is determining safe cache release without destroying unrelated game consumers. No current far changes are installed in this captured binary. Static cooked census suggests 47 eligible atlas outputs fit the 48-atlas cap; exact live cache keys remain unverified. User rejected the partial AFTER as visually poor; parent re-opened BEFORE/AFTER and observed loss of forest-shadow coverage across the road/ground plus harsh leaf cards. This checkpoint FAILS visual acceptance; two bounded DeepSeek reviews now isolate shadow and foliage/LOD fidelity before packaging another candidate. Cache asset/chunk ownership changes passed 69 affected WorldCells/impostor tests, core typecheck and lint (warnings only); actual texture-disposal proof and runtime memory effect remain open. Zero/zero validation now records the actual camera, live placements and nearest sphere/frustum margin (56 GPU tests and core typecheck pass), not yet installed. Parent published the partial same-pose foliage comparison at https://github.com/ThreeNativeHQ/threenative/pull/375#issuecomment-5917953944 and copied PR375-foliage-before.png / PR375-foliage-after-core.png to machinefall root. Static-camera/far acceptance is still open; no notification sent, no 120 fps/native/complete claim. Older candidate observations below are historical.

- **Implemented (uncommitted):** the `SharedBatch` own-logical-capacity park/grow/free-range fix ends the real allocation runaway. Latest binding candidate: GPU views and walk with 0 console errors; 62 focused GPU + 34 WorldCells checks and core typecheck green. An earlier lifecycle candidate had 642 matched instances+matrices, but the forest was still absent from the GPU. Installed/built/archive `dist/world.js` SHA256 `6bf2e20958e9307339f25a43dfd1a50cd539cd2d8d761eda689c9ac2c23dc582`; archive `threenative-core-0.3.3-pr375-binding-054d0f866554.tgz`.
- **Open:** the actual GPU forest is still absent. Latest candidate artifacts `apps/client/.threenative/playtest/pr375-binding-fixed/{views-default,views-cpu,walk-default,views-validate}` show errors 0 across the four runs; validation sees only 3 markers (206/210/214 keys) with 0 GPU/CPU instances, so the nonzero-draw proof is not satisfied and no AC-3 / near-visual claim is made. Draw-path diagnostic in progress.
- **Runtime baker:** a real module exists — 16 octahedral views at 128 px, two RGBA8 arrays with mips, 2,796,160 B per atlas; the NVIDIA source pine GLB atlas has 16 non-empty views, 11 tests. A lit 2-triangle whole-asset surface is under verification, not integrated. This runtime bake supersedes the cook-time impostor proposal (executable plan step 3, now marked superseded); HLOD and other work are unchanged.
- **Remaining bounded implementation:** integrate the automatic alpha-foliage bake with WorldCells load/prewarm; finite atlas budget and cache keyed on the resolved cooked content URL plus the source cutout contract; preserve full source leaf coverage through authored/generated LODs until the impostor switch. One whole-asset terminal part means the wide caster uses one quad and the root placement matrix, with no per-part fallback duplicates. Use existing raw renderer/public APIs, owned disposal, CPU/GPU buffer updates. **Next:** real game and native visual checks at the near transition, mid coverage and far hills; parent reviews and updates this PRD, no merge request. Broad 120 fps / HLOD acceptance stays open. No box is ticked from a unit check or a blank capture.
- **Far residency:** a lightweight aggregate per atlas asset using the original placements, independent of the near full-geometry ring; upload matrices only on cell/run handoff; atomic near-ready swap/eviction avoids duplicates and holes; finite instance and atlas budgets. Terrain radius 8 vs near prop ring 2; of 60,331 exported tree placements, 49,516 are beyond 500 m. One `InstancedMesh` per asset (not per cell) is the minimum candidate; the full-geometry ring is not raised.

## Strata HLOD implementation checkpoint

The engine cook/schema slice is committed at `710b68c5cc09ee88058c3ebc5c156564d3db95c5`.
Runtime and CPU bundle work is based on the parent-approved published PR381 head
`786e236719a482062bc263bf3543a444b836095b`, with the readiness owner's source retained. It
changes WorldCells/world exports and the internal cell-proxy helper, not terrain, startup or
forest source. Capability search/detail preceded the implementation; models, placement inputs,
cache holders, loader concurrency and admission use the existing engine paths.

Cook staging and expansion are capped at 64 MiB, expanded nodes at 4,096 and each output GLB at
4 MiB. Eligible static scatter and chunks have explicit coverage, transformed bounds and error;
MASK triangles remain intact. Animated, skinned, morphed, nested instanced, sheared, alternate-scene,
orphan, blended, tangent-bearing and complex-material sources retain detail with a diagnostic.

The runtime considers proxies by default, with `hlod: false` as the named override. Selection uses
existing projected-error hysteresis and conservative transformed bounds. Compilation alone does
not make a proxy ready: engine hooks must observe a matching main-camera backend submission after
compilation, while source stays drawn. That zero-count submission observation does not prove a
full-triangle draw, absence of a hitch or visual quality. Unsupported/mutated materials, custom
hooks, partial placement reach, nonzero source LODs and shared neighboring source batches retain
source; game-owned appearance is never approximated silently. Existing engine observation hooks
remain compatible, and collapsed transforms return safely to detail.

Source segments remain resident, so near restoration is immediate. Only exclusive source main
meshes are hidden; existing caster and collision representations stay intact. Both affected bundle
groups are invalidated together. Actual visible post-cull source triangles and retired draws gate
activation; the cook's LOD0 census is never a performance proof. Fixed private proxy geometries,
conservatively decoded texture costs and pending reservations are charged against the existing
world byte budget. Pending load/compile resources and cache holders survive eviction until their
original promises settle. Counts are logical retained-resource charges, not measured driver memory
or a bound on undocumented decoder transient allocations.

An explicit empty authored `lods: []` now enrolls a valid installed chain for unchanged static
parts. Nonempty authored LODs remain authoritative. Section ranges, changed attributes, alpha
foliage and vertex deformation retain source instead of using a stale prepared chain. Active
Strata's in-memory TSL foliage and placement-reach contract still require a faithful proxy binding;
this slice does not activate an approximate forest proxy or claim a Strata HLOD performance gain.

The parent profile identified bundle material eligibility taking 2.682 s of sampled CPU in a
16.067 s pre-loss window. The fix checks bounded flat graph snapshots rather than allocating a
recursive values array and visited set on every stable-frame check. It still checks mutable links
on each frame; no version/root-only cache claims deep edits are safe. Overflow uses the original
uncached safety walk. CPU bundle membership is reported when GPU culling is off; array materials
retain the per-object path. Three replay regressions and two HLOD boundary regressions reproduced
before fixes. The final changed-behavior suite passes 68/68, core's TS7 7.0.2 package typecheck and
Biome pass, and independent source review reports no remaining concrete blockers.

The final affected cook/schema/runtime controls pass 250/250 across 12 files (one worker on
cores 10,22); the final core declaration build and publint pass. The bounded dependency/core/assets
declaration build also passed. Assets package typecheck remains
failed in raw-unreal because that workspace package cannot resolve its Three.js dependency; the
changed assets files report no errors. Logs and earlier failures are retained in the isolated
execution lane. GPU/native/playtest, full board, latency measurements and visual acceptance remain
open. Documentation links pass; focused prose/capability/API contracts pass 279/280. The remaining
failure is the unchanged `docs/verification` tree at 72.7 MB against its shipped 72 MB cap; this
slice adds no evidence files and does not raise that cap. The CPU lane is shared, so no wall-time
benchmark claim is made.

The subsequent corrected bridge-off profile attributes 3.390 s of sampled CPU to attribute
uploads in a 15.235 s window; that profile does not identify an exact mesh/buffer. Inspection and
real installed-Three CPU controls reproduce unconditional far uploads caused by
`DynamicDrawUsage`. The minimal correction removes that override. Growth, original-placement
writes and near/far zero/restore handoffs retain their existing `needsUpdate` version signals;
no static object flag or new dirty scheduler is added. Both the source attribute and interleaved
shader buffer produced 60 uploads over 60 unchanged frames before the fix and zero afterward.
Tests capture the actual production position graph, its four column bindings and its emitted FRAME
sync event: real handoffs publish changed matrix/cull bytes, camera-only changes do not republish
matrices, and real 85→86 growth allocates a fresh buffer and disposes the old mesh once. The seven
nearest shader/residency/bundle/caster/static/HLOD specs pass 97/97; changed-source/tests strict
TS7, Biome, and the rebuilt core declarations/publint pass. These are CPU backend-call controls,
not measured GPU bandwidth or frame-time savings.

The parent's matched baseline `786e2367` / candidate `9b33b68e` pair failed the same 120-second
spawn-admission gate with all 6 required cells loaded and `worldReady` false. Each 90-frame warmup
took about 90 seconds; neither arm reached the original 17-view gameplay/visual acceptance. The
candidate's `graphSnapshotCurrent` consumes 17.383 sampled self-seconds over the actual 183.154-second
browser profile (9.49%). This is loading-path cost, not a qualified steady gameplay comparison.
The retained final counters show 55 eligible CPU bundle members, so they do not establish an
unsafe-verdict-only cache as the measured fix.

The narrow correction replaces `for-in` plus `hasOwn` with `Object.keys` in snapshot validation.
Installed TSL node prototypes carry thousands of enumerable chaining methods that the original
own-property safety walk never observes. A real installed-node regression reproduces 186,400
inherited-method probes over 20 unchanged frames before the change and zero afterward, while
validation continues and records stay unchanged. Own-key order, link identity, headers, deep
unversioned mutation and node-version checks remain live on every eligibility check; each validated
row now allocates an own-key array. No new pass cache or version-only authority is introduced.
The seven nearest CPU specs pass 108/108, core package typecheck and changed source/tests strict
TS7 pass, and Biome passes with existing warnings. Fresh independent source review finds no
concrete blocker. The earlier red output and raw profiles remain retained; this source proof does
not establish lower production frame time. The parent owns the fresh profile, readiness/cadence
repair and GPU/visual acceptance; no new GPU, native, full-board or publication gate ran here.

Before integration, the owner's inherited-link check compared the guard with installed
Three 0.185.1 `Node.getChildren` / `_getChildren` and `NodeMaterial._getNodeChildren`.
Direct inherited Node children are ignored by Three and remain ignored. Three does consume
non-enumerable own Node/Material slots, inherited entries in plain node dictionaries and inherited
indices in sparse node arrays; the earlier `Object.values` guard missed these too. Four real
regressions reproduce those omissions, including a dictionary prototype change with unchanged own
keys/version. The guard now uses own property names for Node/Material slots and the installed Node
child reader for the remaining semantics, retaining reader identity and ordered child identities
as live snapshot witnesses. Deep unsafe edits refuse bundles and repaired graphs rejoin without
requiring `needsUpdate`. The TSL inherited-method regression still observes zero discarded probes.

Stored child identities are capped at 8,192 and count toward the existing snapshot-link limit.
Unsupported, malformed, oversized or throwing reader/iterator output retains the original source
path, with repair controls; three additional exceptions reproduced before that refusal fix.
Three's child reader eagerly scans authored array lengths before yielding, which this witness cap
does not bound. Child discovery allocates arrays/sets; this safety follow-up makes no production
speed claim. The final seven affected CPU specs pass 118/118 (36 bundle controls), package typecheck,
changed-source/tests strict TS7 and Biome pass, and independent review finds no remaining concrete
blocker. No GPU, native, broad board, publication or performance acceptance gate ran here.

Remaining validation must repeat the parent's profiler on the same production workload and compare
actual eligibility checks/refreshes alongside total CPU frame time. HLOD needs nonzero active proxy
observations on eligible content, same-pose near/middle/far and transition captures, approach/turn/
stream/eviction controls with collision and shadow coverage intact, and original PRD-475 visual,
GPU/CPU p95, hitch and memory thresholds. Compare `hlod: false` to the candidate against the current
globally instanced far-LOD/impostor baseline. Preserve the original acceptance; draw/triangle
reductions alone cannot tick it. The parent owns the GPU lane and integration into PR381; no GPU,
native, CI dispatch or publication has run for this slice.

## Phase 3 executable plan

**First step (pick one): cook-time per-cell HLOD caster proxies, not GPU-driven indirect casters.**

Why, from the code:
- A merged, position-only caster already exists and is already correct for a depth pass:
  `buildChunkShadowProxies` groups a chunk's covered opaque meshes by `side`, builds
  `shadowProxyGeometry`, flips `castShadow = false` on the covered meshes and puts the proxy on
  `VIRTUAL_SHADOW_CASTER_LAYER` (`packages/core/src/world-cells.ts:2019-2058`, `2067-2109`), and
  `#probe` bills it as a cluster and window-culls it for free
  (`packages/core/src/render/virtual-shadow.ts:1015-1020`). Cooking the same proxy per cell, from a
  simplified merge, changes where the geometry comes from and nothing else — no new layer, no new
  dispatch, no fallback path.
- Indirect casters cannot bring the w=640 count down. The wide layer is already one draw per
  `asset:level:part` mesh (`virtual-shadow.ts:1018-1019`); `BufferGeometry.setIndirect` moves only
  the instance *count* into a GPU buffer, so the record, the mesh and its draw submission stay one
  per key. The measured w=640 break is per-draw JS (11–19 ms), so only fewer draws cuts it.
- The coarse level already submits the chain's coarsest geometry (`virtual-shadow.ts:941-946`), so
  the wide bill is now draw count, not LOD detail; a per-cell merge is the only candidate that
  collapses many keys into one draw.
- It is also exactly AC-4's bake, so the shadow fix rides on work already required rather than a
  parallel mechanism. GPU casters stay the documented fallback (step 4).

Steps (each: files, the number that proves it, the smallest test):

0. Baseline marker, no production change. Add `draws` to `IVirtualShadowLevelStat`
   (`virtual-shadow.ts:246-253`), set from `clusterDraws + wideDraws` in `#probe`, print it in the
   `TN_VIRTUAL_SHADOW` line (`virtual-shadow.ts:1645-1672`). proof: a `?tnShadowStats=1` walk prints
   the width=640 row; it is ~336 today. test: `world-shadow-caster-cost.spec.ts`, assert the reported
   count equals the meshes the level's camera actually submits.
1. Cook bakes one merged, simplified, position-only proxy per cell. Files:
   `packages/assets/src/lod/hlod.ts` (new; error budget in cell-local units), wired through
   `packages/assets/src/pass-chain.ts` and `packages/assets/src/compile.ts`; input is the cells the
   world export already names (`tn_world_chunk`, `packages/blender-mcp/src/index.ts:101`); output one
   GLB plus material-group count and error per cell, keyed on the source hash so it caches. proof:
   `TN_WORLD_HLOD cells=N proxies=M maxError=…` at build, mirroring `TN_WORLD_CHUNK_MERGE`
   (`world-cells.ts:5726`); each proxy's triangles ≤ the budget, deterministic across runs. test:
   `packages/assets/__tests__/hlod.spec.ts`.
2. WorldCells draws the proxy beyond its distance, main and caster. Files:
   `packages/core/src/world-cells.ts` — load the cell proxy with the cell; past the distance hide
   `cell.chunks` and show the proxy; a copy on `VIRTUAL_SHADOW_CASTER_LAYER` with `castShadow = true`
   and `frustumCulled = false`, on the fold where `#cullCells`/refilter already flips cell
   visibility. Distance comes from the proxy's own projected error, no game option. proof:
   `TN_WORLD_HLOD draws=… replaced=…` and the `TN_VIRTUAL_SHADOW` width=640 draw count below 120.
   test: extend `world-shadow-caster-cost.spec.ts` — a cell past the distance submits one caster draw
   per material group, near cells submit their chunks. red-green: remove the swap, the count returns
   to ~336 and the test fails.
3. Far-tree impostors (AC-3), independent of 1–2. **The prior cook-time
   `packages/assets/src/lod/impostor.ts` proposal is superseded by the current runtime baker
   (execution-status section above) — one implementation, not a second one.** The
   runtime half still holds: emit the atlas as an extra level after the last discrete level,
   carrying the chain's own `error` and 2 triangles. The switch distance is `chainDistances`'
   formula (`world-cells.ts:2533-2549`) fed the last level's error, so no game-side value exists.
   `packages/core/src/model-lod.ts` already selects by projected error, so the impostor switches
   like any level; put its quad on both caster layers.
   proof: `TN_WORLD_IMPOSTOR asset=… levels=… switch=…`; past the switch, triangles per tree are 2,
   read from `?tnShadowStats=1` plus a `visuals:baseline` capture at the switch. test:
   `packages/core/__tests__/world-impostors.spec.ts` + `packages/assets/__tests__/impostor.spec.ts`.
4. Risks and what to cut. Cook cost and package size grow by one proxy per cell: bake behind the
   content-hash cache and skip a cell whose merged error already fits the budget (proxy == chunks, no
   win). Pop at the swap distance: switch by projected error, not metres; if it still pops, cut step
   2's main-pass half and ship the caster proxy alone, because the measured break is the shadow
   level. Impostor parallax or lighting at the switch: normals in the atlas, switch by the chain's
   last error; if it still reads wrong, fall back to the coarse chain and leave AC-3's box open (it
   is independent). If step 2 cannot get width=640 under 120 draws, re-plan the wide half onto
   GPU-driven indirect casters (`packages/core/src/world-gpu-scene.ts`), which removes the per-draw
   JS even though one record per key remains; never plan per-level `BundleGroup`s (see the
   feasibility section above).

## Terrain tile draw reduction

**Fact (measured).** In the machinefall streamed map the main pass submits ~225 draws, ~110 unnamed
non-instanced terrain-tile meshes: `buildLevel` (`world-tiles.ts:401`) makes one
`new Mesh(geometry, surface)` per tile per LOD level (`:490`), parented into a `LOD` at the tile
origin (`:2178`); `streamRadius 8` = 289 resident tiles × `lodFactors [1,2,4]` (one visible level
each) plus stitch bridges. Each ~30 µs of three's per-object JS (~3 ms/frame), never merged — the
CPU-bound mobile/native bill.

**(1) Per-tile difference: geometry only.** A level geometry is `position`/`normal`/`index`
(`:492-495`) — heights baked, no uv, no per-tile attribute or uniform; all tiles share the
game-owned `MeshSurface` (`:15`), the splat `MeshStandardNodeMaterial` reading `positionWorld` and
shared textures (`world-terrain-splat.ts:337-348`); the LOD adds a translation. So a merge cannot
change the look if the same vertices land at the same world positions, and adjacent same-LOD tiles
sample the same field on the same grid (`fieldHeightGrid` `:372`, `edgeSamplesFor` `:332`) — their
shared edges already coincide.

**(2) Chosen: merge same-LOD settled tiles into super-tiles.** Group by
`${lod}:${floor(tileX/K)},${floor(tileZ/K)}` (K≈4), one merged `Mesh` per block, rebuilt only when
membership or LOD changes.
- Reject **GPU indirect (c)**: `setIndirect` moves only the instance *count* into a GPU buffer, so
  record + mesh + submission stay one per key (`world-gpu-scene.ts`); a tile = one geometry = one
  instance per key. It removes cull/repack, not draws.
- Reject **instanced + height texture (b)**: the shared flat grid needs the surface to sample a
  per-tile height texture and rebuild normals in-shader — the engine owning the game's `surface`
  (rule 3).
- Reject **three `BatchedMesh`**: the LOD morph writes per-tile vertices on the CPU
  (`updateLodTransitionGeometry` `:1194`, writes `:1233`, `:1252`) and `BatchedMesh` copies geometry
  into one buffer with no per-instance vertex write; `deleteGeometry` compacts. More churn than a
  merge.
- **Change (all `world-tiles.ts`):** new `mergeLevelGeometry` (beside `buildLevel` `:401`)
  concatenates each tile level's `position`/`normal`/`index` at the tile origin, keeps
  block-perimeter skirts, names the mesh; `#markBlockDirty` from `#admitCandidate` `:2239`,
  `#evict` `:2707`, `#disposeTile` `:2718`, `#setLodLevel` `:2339`; `#rebuildDirtyBlocks` on the
  `IAdmissionBudget` pattern (`:39`), one per frame, at the end of `follow`; `#setLodVisibility`
  `:2379` and the morph skip a tile while `lodTransition !== undefined`. `#stitch`/
  `stitchGeometryData` (`:869`) unchanged — a bridge reads `level.edgeSamples` and the field, not the
  meshes.

**(3) Culling, transitions/stitch, shadows.** Blocks get their own bounds
(`computeBoundingBox`/`Sphere`, `:492-495`) and `frustumCulled = true`; culling becomes per block, so
a same-LOD segment behind the camera is drawn — hence K small. A morphing tile stays individual for
its three frames, so `updateLodTransitionGeometry`/`restoreLevelSurface` are untouched and the block
re-merges after; membership changes only on stream/LOD events. Bridges stay per-pair. Tiles are
receive-only (`mesh.receiveShadow`, `:2185`, bridge `:2529`; no `castShadow` in the file), so
merging touches no caster and the merged mesh sets the same flag.

**(4) Ordered steps, each with its number.**
0. No production change: add a `terrainTiles` stat (`tiles`/`blending`/`blocks`/`draws`) beside
   `lodTransitions` (`:1853`), printed `TN_TERRAIN_TILES`, and run the playtest `scene-nodes`
   main-pass census on machinefall `?scene=map-walk`. proof: `draws≈110`, equal to the unnamed
   `Mesh`es the main pass submits. test: assert the stat equals that mesh set.
1. Merge behind `mergeTiles:false`. proof: the census falls ≥4× (~110 → ≤25), the same-pose
   screenshot is the pre-merge picture, `TN_TERRAIN_VALIDATE` `maxSeamGap`/`maxLodPop` unchanged.
   test: `world-tiles.spec.ts` — a settled 3×3 same-LOD island is one draw whose positions equal the
   tiles' concatenation.
2. Budget block rebuilds (one per frame), exclude blending tiles. proof: no `TN_FRAME_SPANS` stall
   while walking, `blendingTiles`/`lodTransitions` unchanged. test: existing LOD-transition cases
   plus one blending case.
3. Default on, `mergeTiles:false` escape. proof: the census ≤25 with no game option.
Cut if: a seam appears → merge interior edges only, or one block per LOD tier; rebuild stalls show
in `TN_FRAME_SPANS` → enlarge K or revert to default-off; the picture differs → fix the origin
offset, do not ship.

**(5) Risks.** *Seams*: same-LOD edges only — never merge across LOD; gate on `maxSeamGap`
before/after. *Popping*: a block rebuild changes the visible set; blend-end re-merge is the only
trigger. *Streaming churn*: each admission/eviction dirties one O(block) rebuild — budget one per
frame, watch `TN_FRAME_SPANS`. *Memory*: a block duplicates settled level vertices; free the
per-tile level geometry once merged (keep `edgeSamples`+field for stitching) or charge it to
`residentByteBudget` — never hold both.

## Cook: a terminal coarse level on every chain (shipped ahead of GPU scene)

The problem table's "distant trees keep 37–58% of LOD0 triangles" is a *generation* stall, not a
culling one: `LockBorder` on an open or thin tree lets the error ladder stop at 87% kept, so a far
tree still submits ~16k triangles and the shadow levels tens of millions. The cook now appends one
terminal level to every chain — `packages/assets/src/lod/generate.ts` for triangles, cut by
`max(1500, 5% of LOD0)` with `Prune` and no border lock; `packages/assets/src/lod/cards.ts` for
foliage cards, which merges LOD0 cells into a coarser grid to get under the same target. It is
exempt from the saving gate, needs no game option, and the runtime already reads its recorded error
through `chainDistances` (`packages/core/src/world-cells.ts:2524`). `LOD_GENERATOR_VERSION` moved to
2 so a re-cook replaces stale chains; the artifact schema stayed at 1, so chains baked before this
still load. Measured on the synthetic open mesh (16 patches x 24 segments, 18,432 triangles): the
ladder reaches 1,536 and the terminal level 1,500. Proof:
`pnpm exec vitest run packages/assets/__tests__/lod-generation.spec.ts packages/assets/__tests__/foliage-lod.spec.ts`.
