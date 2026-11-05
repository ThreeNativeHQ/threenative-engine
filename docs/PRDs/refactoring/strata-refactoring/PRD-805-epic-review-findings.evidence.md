# PR #483 epic findings — verified on HEAD 21c713b7d

Read-only verification of `/home/joao/.cache/tmp-tn/strata-refactor/epic-findings.md` (E00..E75).
Verdict = does the claimed failure hold at HEAD. Severity is my own assessment.

### E00 NOT-REAL [low] packages/core/__tests__/world-cells-data.spec.ts:876 — spawn-snapshot test cannot fail
The mutation point is the world's own follow point: `spawnWorld(new Vector3(224, 0, 32))` at :877 and `spawn.x = 224` at :890, so an aliasing waiter would move onto the cell `world.update()` is admitting, and the closing `expect(ready).rejects.toThrow("WorldCells spawn cancelled")` (:894) fails if it resolves first.
Also `WorldCells.update` settles waiters after admissions in the same call (`world-cells.ts:1246`). Could not mutate to prove; defaulted NOT-REAL.

### E01 REAL [low] packages/core/__tests__/world-cells-data.spec.ts:823 — concurrent-waiter test claims timers cleared, never checks
Title says "clears each deadline" but the body uses real timers, and its only timer assertion is on the promises resolving (:832-836). The sibling test (:739-762) does `vi.spyOn(globalThis,"clearTimeout")`; this one does not, so dropping `clearTimeout` in `settleWaiters` keeps it green.
Game/test file: add `getTimerCount()` under fake timers, or a clearTimeout spy.

### E02 REAL [low] examples/strata-terrain-preview/src/game.ts:115 — failed horizon fetch cached forever
`let horizonLoad: Promise<void> | undefined` (:62) with `horizonLoad ??= fetchBakedFile(...)...` (:115) and `await horizonLoad` (:123); no `.catch`/reset anywhere (`rg horizonLoad` = 3 hits). One rejection poisons every later world load in the page's life.
Game layer: `.catch(error => { horizonLoad = undefined; throw error; })` before the cache assignment.

### E03 REAL [low] examples/strata-terrain-preview/scripts/verify-starter-kit.mjs:691 — rmSync removed, guards kept
The epic diff drops `rmSync(ARTIFACTS, {recursive:true})` and leaves only `mkdirSync` (:703); the asserts at :691-700 are worded "artifact output would remove a source checkout" but nothing removes it any more. A reused `KIT_ARTIFACTS` keeps a previous run's `capture.json` (:729) and PNGs.
Game script: either restore the guarded wipe after the asserts, or reword them.

### E04 NOT-REAL [low] scripts/verify-starter-kit.mjs:603 — COMPOSITION_FAR appends keys on every run
`src/game.ts` is re-copied from the fixture on every run, kept game or not: `for (const name of ["game.ts","state.ts"]) cpSync(join(FIXTURES, name), ...)` at :571, before the `COMPOSITION_FAR` replace at :588-598. No accumulation.

### E05 REAL [low] examples/strata-terrain-preview/src/world/water.ts:43 — swim queries drop the sea
`waterBodies(rivers, lakes, field)` is called with no `sea` in both `waterSurfaceAt` (:48) and `waterCurrentAt` (:65); `game.ts:453-455` wires the swimmer through them while `game.ts:127` draws the coastal world's ocean (`packages/terrain/starter/coastal/biome.data.json:106-110`). `sea` is a parameter no caller supplies, so the sea is in the drawn geometry and absent from the swim store the header promises.
Game layer: pass the ocean body into `waterSurfaceAt`/`waterCurrentAt` for a world whose spec has one.

### E06 REAL [low] examples/strata-terrain-preview/src/world/forestStage.ts:18 — comments name two stage arms, three exist
:18 "The two explicit `?stage=` arms" over `FOREST_STAGE_ARMS = ["before","after","wildwood"]` (:19); `vite.config.ts` comment says "`?stage=before|after`".
Game/comments: name the third arm.

### E07 REAL [low] examples/wasm-engine-boot/playtests/post-normal-node.playtest.json:1 — normal-node scenario asserts what post does
`diff` against `post.playtest.json` differs only in `name`; the page's probe (`src/post-page.ts:33-44`) has no field saying the normalNode was used, so "normalNode honoured" and "ignored, fallback ran" both pass. It still catches the old throw (that sets `probe.error`), just not the fallback.
Example layer: expose the normal-source on the probe (`post-page.ts:106`) and assert it in the scenario.

### E12 NOT-REAL [low] examples/strata-terrain-preview/scripts/check-temperate.mts:9 — committed script imports missing exports
The file is gone at HEAD: `git diff --stat 33c69249f HEAD` shows `scripts/check-temperate.mts | 210 -----`, and `ls scripts/` has no such file. Already resolved by 638c9ed73.

### E13 REAL [low] examples/strata-terrain-preview/scripts/check-water.mjs:58 — new water assertions run nowhere
`check-water.mjs` exists and the epic changed it (`git diff --stat`: 20 ±), but `rg check-water` finds only its own header and prose in the example's `AGENTS.md:91`/`CLAUDE.md:93` — no package.json script, no CI job.
Game/CI layer: wire it into a script/job or delete it.

### E14 REAL [low] examples/strata-terrain-preview/scripts/verify-consumer.mjs:500 — hasForest always true after the throw
`if (!hasForest) throw` at :495-498, then `if (hasForest)` at :500 and :598 and the `hasForest ? ... : const forest = null` ternary at :508-509: the false arms are unreachable, so the code reads as a skip path that cannot happen.
Game script: drop the flag and the dead arms.

### E16 REAL [low] packages/core/__tests__/world-impostor-surface.spec.ts:441 — dither partition loop is tautological
The loop at :441-445 asserts `Number(noise >= mix) + Number(noise < mix) === 1` on plain JS numbers and never reads `worldLodMaterial` (`src/render/world-impostor-surface.ts`: `fadeIn = noise.lessThan(mix)`, `fadeOut = noise.greaterThanEqual(mix)`). Changing either comparison keeps it green.
Test: assert the two mask nodes hold the same `mix`/`noise` nodes, or delete the loop.

### E18 REAL [low] examples/strata-terrain-preview/src/render/farForest.ts:13 — override comment inverted
Header says "`?farForest=off` is the named override: no trees past the square" but `FAR_FOREST` is `.get("farForest") === "on"` (:24-25): the collar is off by default. Same stale line in `src/sceneProps.ts:338`.
Game comment: `?farForest=on` is the named override.

### E19 REAL [low] examples/strata-terrain-preview/src/render/horizon.ts:53 — "remove before report" knob ships
`// TEMP-MASSIF knob: remove before report.` sits over the code reading `get("massif") === "before"` and swapping `forest-before` in for `forest` (:54-59). A URL carrying it changes the far silhouette with no override report.
Game layer: delete the knob (and the `forest-before` survey use).

### E20 NOT-REAL [low] examples/strata-terrain-preview/src/render/biomes.ts:40 — HeightBand doc describes density
At HEAD `type HeightBand` (:40-47) carries no JSDoc at all, and `rg "How thickly|A sixth look"` finds nothing in `biomes.ts`. Comment already gone.

### E28 REAL [low] examples/strata-terrain-preview/src/render/propMaterials.ts:320 — sway() doc contradicts castShadowPositionNode
`/** Attach the wind ... and to its shadow pass so the shadow sways too. */` (:320) directly above `base.castShadowPositionNode = positionLocal;` (:328) and the comment saying the shadow casts the rest pose (:325-327).
Game comment: say the shadow casts the rest pose and why.

### E29 REAL [medium] examples/strata-terrain-preview/src/render/selection.ts:57 — status line lost role=status/aria-live
Diff line 44/45: `<p id="placement-status" role="status" aria-live="polite">` became `<p id="placement-status" class="small muted">`, and `message()` writes save results, undo conflicts and "Only Y rotation is supported" into it.
Game layer: put `role="status" aria-live="polite"` back on `#placement-status`.

### E30 REAL [low] examples/strata-terrain-preview/src/render/terrain.ts:946 — shipped TEMP A/B knobs
Three live knobs at HEAD: `?peaks=before` (`terrain.ts:946-949`), `?meadowBase=off` (`scatter.ts:54-55`), `?massif=before` (`horizon.ts:53`). Each changes the look from a URL with no override report.
Game layer: remove before the report, or route through the named-override record.

### E08 REAL [high] packages/core/__tests__/instance-velocity-upload.spec.ts:164 — four history-reuse tests fail at HEAD
`pnpm exec vitest run packages/core/__tests__/instance-velocity-upload.spec.ts` → 4 failed, 6 passed (failures at :164, :187, :241). The 0.187.0 patch sets `previousInstanceMatrix.array.set(scheduledPrevious); previousInstanceMatrix.needsUpdate = true;` with no identity/version check (`patches/three@0.187.0.patch` hunk around :64-71), so the previous-matrix buffer is re-uploaded every draw. Same hunks at base 33c69249f, so the red predates the epic (three-0.187 upgrade), but HEAD is red and the per-frame upload is back.
Engine layer: reinstate the "unchanged scheduled history" check in the patch (and/or `src/render/velocity.ts`) that 919dc0356 wrote for 0.185.1.

### E36 REAL [high] packages/create-threenative/__tests__/looks.spec.ts:75 — arena-shadow test fails at HEAD
`pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts` → 1 failed, 21 passed: `expected [18.72, 29.98, 48, 87.64, 160] to deeply equal [18.72, 48, 160]`. `VirtualShadowNode` inserts ≤2x intermediate levels, so `shadows.options.clipExtents` is the expanded ladder, not the authored pair.
Test layer: assert the ladder (`[arenaExtent, ..., 48, ..., 160]`) or the authored extents via the node's own option, not the flattened array.

### E69 REAL [high] scripts/__tests__/verify-forest-playtest.spec.ts:38 — READY_ANCHOR matches nothing, 6 of 8 fail
`pnpm exec vitest run scripts/__tests__/verify-forest-playtest.spec.ts` → 6 failed, 2 passed, all `TN_FOREST_ANCHOR: the Play readiness check not found exactly once in the starter`. `READY_ANCHOR = "      this.#sky === undefined\n"` (`verify-forest-playtest.ts:28`) while the starter's check now reads `if (this.#assetProof === undefined || this.#playerModel === undefined)` (`templates/starter/src/scenes/Play.ts:138`).
Tooling layer: update `READY_ANCHOR` and the replacement text in `scripts/verify-forest-playtest.ts:97-99`.

### E70 REAL [high] scripts/__tests__/prepare-release.spec.ts:178 — fixture copies a file that does not exist
`pnpm exec vitest run scripts/__tests__/prepare-release.spec.ts` → 2 failed, 12 passed, `ENOENT ... packages/blender-mcp/src/index.ts`. The tree has `packages/blender-bridge`, no `blender-mcp`; the path is in the fixture's `sourceFiles` list (:178) and copied at :197.
Test layer: point the fixture at the real package path (or drop the entry).

### E71 REAL [high] scripts/__tests__/mcp-tool-schemas.spec.ts:17 — snapshot lacks terrain_biome_new
`pnpm exec vitest run scripts/__tests__/mcp-tool-schemas.spec.ts` → 1 failed, 6 passed: recorded `["terrain_generate","terrain_patch"]` vs served three tools (`packages/terrain/src/mcp/tools.ts:64`). The epic added the tool without regenerating `packages/create-threenative/terrain-mcp-tools.json`.
Engine/packaging layer: `pnpm tsx scripts/capture-terrain-mcp-tools.ts` to regenerate the snapshot.

### E72 REAL [high] scripts/__tests__/strata-script-census.spec.ts:36 — six new example files undocumented
`pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts` → 1 failed: exactly `playtests/vista.playtest.json`, `playtests/water-proof.playtest.json`, `scripts/props.mjs`, `scripts/recipe.mjs`, `scripts/stamp.mjs`, `scripts/world-files.mjs`. All six are additions of this epic (`git diff --stat 33c69249f HEAD -- .../scripts/` shows props/recipe/stamp/world-files added).
Game layer: name them in `examples/strata-terrain-preview/AGENTS.md`, then `pnpm sync:agents`.

### E09 REAL [medium] packages/assets/src/compile.ts:339 — pre-scan hard-fails odd GLBs even with models:"none"
The scan loops over every `.glb` logical (`classify` is extension-only, `compile-types.ts:409`) before the pass list is fixed, and wraps any `unpackGlb` throw in `TN_ASSETS_MODEL_UNREADABLE` (:341-345). `unpackGlb` requires `length % 4 === 0` per chunk, header length == buffer length, and no trailing bytes (`passes/shared-images.ts:394-424`). The comment at :355-367 shows the `models:"none", textures:"none"` build is a real, supported case that used to copy such files through. The epic also relaxed its own fixture (`__tests__/native-package.spec.ts`, `padEnd(84)` → `padEnd(88)`) instead of keeping the old tolerance.
Engine layer: run the marker scan only when a model pass is in the chain, or treat an unpack failure as "not a terrain world".

### E10 NOT-REAL [low] packages/assets/src/gltf-io.ts:156 — writer registers fewer extensions
`createGltfWriter` omits `EXTTextureAstc`/`TNVirtualGeometry` (vs `createGltfReader`, :142), but glTF-Transform preserves extension JSON it does not know: an unregistered name read is only a warning (`@gltf-transform/core` `dist/index.js:4358`), and the raw `extensions` payload stays on the document, so a write does not drop it. The registered set buys typed conversion, not retention. Only a *required* unregistered extension throws, and on the read side. Not a silent drop.

### E11 REAL [medium] packages/assets/src/compile.ts:584 — terrain-world cache key ignores PIPELINE_VERSION
Every other asset hashes `passConfigurations[classify(logical)]`, which mixes `pipelineVersion: PIPELINE_VERSION`, pass cache keys, pass options and the runtime decoder identity (:388-400). A terrain world hashes only the constant `"terrain-world-v1"` / `"terrain-world-native-separate-v2"` (:584-591), so a pipeline fix that bumps PIPELINE_VERSION never recooks a cooked world and the stale GLB is served from the cache.
Engine layer: include `PIPELINE_VERSION` (and the terrain pass cache keys) in the world branch of the digest.

### E17 REAL [medium] examples/strata-terrain-preview/src/render/editorView.ts:251 — prop restream cancels the in-flight terrain update
One `streamGeneration` counter (:251) serves both `update()`'s stream (:955) and the prop-drag restream (:282). A drag fires `onTransform` → microtask → `streamProps` → `generation !== streamGeneration` → the update's stream returns `undefined` (:269) → its `.then` disposes the freshly built terrain mesh and returns (:956-959), leaving `mesh`, `terrain`, `groundAt` and `renderedRecipe` (:990-1003) at their old values, with no later `update()` scheduled.
Game layer: split the counters — a prop-only restream must not supersede the terrain update (or retry the terrain half).

### E21 REAL [high] packages/core/src/warmup.ts:1245 — rejected compiles are now awaited as if they timed out
`withinDeadline` deliberately maps a rejection to `false` (`:545-548`, "a rejected compile is ... not a reason to fail the launch"). `compileWithinDeadline` cannot tell the two apart: `if (!finished) pendingCompiles.push(work)` (:1244-1246), `finish` stores `Promise.all(pendingCompiles)` as the report's completion (:1278-1281), and `game-startup.ts:589` does `await heldCompletion` inside `afterHolds`, which `startup-readiness.ts:583-593` turns into `#rejectReady`. So one unsupported material or a failed covered render now fails a held launch — the exact outcome the comment forbids. Both the completion plumbing and the push are new in this epic (`git diff 33c69249f HEAD -- packages/core/src/warmup.ts`).
Engine layer: push only compiles still unsettled at the deadline (tri-state from `withinDeadline`, or push a never-rejecting wrapper).

### E39 REAL [medium] packages/terrain/src/editor/app/cameras.ts:185 — ortho extent subtracts target[0] from every axis
`Math.hypot(...pose.position.map((value) => value - pose.target[0]))` (:185-188) uses the target's X for all three axes; the correct pairing is `(value, index) => value - pose.target[index]`. Every saved orthographic observation camera gets a wrong extent (e.g. [0,100,0] vs [50,0,50] → 86.6 instead of 122.5).
Terrain editor layer: index the target.

### E40 REAL [medium] packages/terrain/src/editor/app/tools.ts:112 — picker shows assets[0] but scatter paints "pine"
`optionSelect("Asset ID", "asset", assets, assets.includes(o.asset) ? o.asset : (assets[0] ?? ""))` (:111-115) only sets the `<select>`'s selected option; `c.options.scatter.asset` stays `"pine"` (default at `evaluation.ts:429`) because the write-back lives in the `#tool-options` `onchange` handler (`tools.ts:189-206`) and no change event fires. `strokes.ts:61-65` then scatters/clears `o.asset`.
Terrain editor layer: write the shown fallback back into the options when building the control.

### E41 REAL [medium] packages/terrain/src/editor/app/cameras.ts:158 — CSS ids do not match the rows
Stylesheet selects `#camera-row`, `#camera-row.active`, `#camera-row small` (:158-159) while a row gets `id = "camera-row-<id>"` and `className = "camera-row active?"` (:39-40). No rule matches, so the row's flex layout, the active highlight and the right-aligned projection tag never apply — the active camera is invisible.
Terrain editor layer: use `.camera-row[...]` selectors.

### E42 REAL [low] packages/runtime-native/src/engine/wasm/web_host.cpp:720 — tnw_web_read_mrt kills the host on a missing slot
`return fail(started == GpuStatus::InvalidHandle ? ... : ...)` sets `state = Failed` (`fail` at :107-111), so one bad slot name or a slot the frame pass never writes stops every later `tnw_web_poll`. The same file's own `refuse()` (:117-124) exists for exactly this ("fails one call and leaves the host running") and the epic's new `tnw_web_init_texture`/`tnw_web_copy_texture`/`tnw_web_device_limit` use it.
Engine layer: `refuse(...)` in `tnw_web_read_mrt`.

### E45 REAL [low] packages/terrain/src/editor/saveQueue.ts:372 — 409 rebase can commit an empty command batch
`#rebase` returns `diffLayers(fresh, rebased)`; when an external writer already made the same change the diff is `[]`, and `#run` retries `#commit({commands: []})`, which the server refuses with a plain `Error("Expected 1–512 patch commands")` (`server.ts:257-259`). `isConflict` (saveQueue.ts:99-103) sees no 409, so the intent is `#reject`ed although the disk already holds it.
Terrain layer: treat a rebased transaction with zero commands as success (drop the intent, adopt the fresh snapshot).

### E48 NOT-REAL [high] packages/runtime-native/src/engine/shader/standard.cpp:1807 — buildBasic reads() always false
The refactor kept the semantics: base was `for (const auto& node : variant.nodes.graphs()) if (visit(node)) return true`, HEAD is `variant.nodes.forEachGraph([&](const graph::Node& n) { found = found || visit(n); })`, and `forEachGraph` visits the same slots plus the MRT ones (`position_node.h:87-90`). `visit` still matches `Kind::Varying && name == varying` (:1809-1812). The existing native test pins the behaviour: `tests/native-engine/material_test.cpp:943-950` builds exactly this unlit graph and CHECKs `output normalView = ` in the vertex stage.

### E49 REAL [medium] packages/runtime-native/src/engine/scene/texture.h:138 — Texture copies its listeners
`Texture : public EventDispatcher` (:137) declares no copy constructor, so `std::make_shared<Texture>(*texture)` (`abi/bindings_material.cpp:764`, `assets/gltf/loader.cpp:845`) copies `listeners_` (`scene/event.h:52`) and the `languageListeners` shared_ptr (:44). `clone->dispose()` (`texture.h:196-200`) then dispatches `dispose` to the original's listeners with the original's `void*` context — a JS listener fires for the wrong texture, and a freed original leaves a dangling context.
Engine layer: give `EventDispatcher` (or `Texture`) a copy that leaves the listener maps empty.

### E52 REAL [medium] scripts/ci-runner-admission.mjs:82 — rain is routed to the GPU runner but admitted as a CPU slot
`GPU_RUNNER_INSTANCES` lists `ci:template-nonvisual:racing` only, while `.github/workflows/ci.yml:930` sends `matrix.template == 'racing' || matrix.template == 'rain'` to `vars.TN_RUNNER_GPU` — and the epic added rain to that expression (`git diff 33c69249f HEAD -- .github/workflows/ci.yml`, the `runs-on` line). `admissionPlan` filters GPU instances out of the CPU-slot list (:171), so rain takes a `TN_RUNNER_SLOTS` slot it will not use and pushes another job to a hosted runner.
`scripts/` layer: add `ci:template-nonvisual:rain` to `GPU_RUNNER_INSTANCES`.

### E59 REAL [medium] scripts/ci-runner-admission.mjs:82 — duplicate of E52
Same fact, same line: rain takes a CPU admission slot the workflow never spends. Verdict follows E52; one fix closes both.

### E64 REAL [high] scripts/verify-strata-startup.ts:414 — startup gate compares against a baseline with a different devDependency set
`verifyStartupPackageIdentity` deep-equals `devDependencies` between the pinned baseline (88b988cd7) and HEAD (:169-186, called at :414). Comparing the two package files shows HEAD added `@threenative/runtime-native`, `create-threenative` and `tsx`, so the gate throws `incompatible package identity: devDependencies` before any run. `scripts/__tests__/verify-strata-startup.spec.ts` passes only because it feeds synthetic fixtures.
`scripts/` layer: re-pin `BASELINE_SHA` to a reviewed baseline with the new devDependencies, or state the allowed delta explicitly.

### E65 REAL [low] scripts/verify-strata-startup.ts:293 — three patch digests recorded, never compared
`collectThreePatchDigests` hashes only `packages/core/patches/three@0.187.0.patch` and drops a missing file (:292-304), so the baseline arm (which has `three@0.185.1.patch`) yields `{}`. The digests are written into `identity.json` (:473-487) but `verifyStartupBuildIdentity(baselineIdentity, candidateIdentity)` (:491) is handed identities without them (:443-455). A patch difference between the arms is invisible to the gate.
`scripts/` layer: fold `threePatchDigests` into the two identity objects.

### E66 REAL [low] packages/terrain/src/mcp/cook.ts:371 — reported water is the declared rows, not what the world floods
The reply echoes `water: biome.water` (:426), i.e. the validated *request/biome rows*, while `water.json` is written from `state.waters`/`state.rivers` (:345-363) and has no ocean field at all. An ocean row is appended to the recipe by `applyWaterRows` (:200-208) and echoed back as what the world floods, yet it can never appear in `water.json`. The "override only changes the echo" half is not established — `applyWaterRows` does rewrite river/lake layers (:212-224).
`packages/terrain` layer: report the evaluated bodies (or add ocean to `water.json`).

### E73 REAL [medium] packages/runtime-native/src/engine/renderer/renderer.cpp:4999 — custom MRT slot of a depthWrite=false draw is never written at 1x
The aux pipeline always tests `target.depthCompare = WGPUCompareFunction_Equal` at 1x (:4998-4999), and the bias branch that makes a nearer draw pass (`LessEqual`, `depthBias -4`) exists only `if (sampleCount_ == 4)` (:5003-5007). A transparent/`depthWrite=false` material that names an `mrt()` slot never wrote its own depth in the main pass, so Equal compares against the opaque surface behind it and the slot is dropped; at 4x the same draw passes.
Engine layer: choose `LessEqual` + bias (or `Always`) whenever `item.depthWrite` is false, not only at 4x.

### E74 REAL [low] packages/runtime-native/src/engine/renderer/renderer.cpp:4942 — MRT cap rejects a legal 8-attachment pass
`moreColors` holds 7 entries (`pipeline_cache.h:69`), so a pass can carry 8 colour targets, and the fill loop at :5000 sizes itself as `namedTargets + mrtSlots.size()` (1 + 7). The guard `if (1 + namedTargets + mrtSlots.size() > 8)` therefore rejects `namedTargets + mrtSlots == 8` (e.g. 8 custom slots, 0 named) with `TN_NATIVE_MRT_UNSUPPORTED`, whose text also says the limit is 7.
Engine layer: compare `namedTargets + mrtSlots.size() > 8`.

### E75 REAL [low] packages/runtime-native/src/engine/renderer/renderer.cpp:1793 — copying a Data3DTexture violates WebGPU usage
`materialTextureKey` gives `kVolume` the usage `TextureBinding | CopyDst` only (:1850-1854), so `copyTextureToTexture`'s source (or a volume destination) has no `CopySrc`/`CopyDst` as needed and the copy is a WebGPU validation error, not the named `TN_NATIVE_COPY_TEXTURE`. The mipmap tail also ignores the comment's "a volume's generateMipmaps is ignored": with `dstLevel == 0`, `generateMipmaps` and 4-byte texels it generates a chain on the 3D texture (:1816-1821).
Engine layer: add the missing usage bits (or refuse volumes in `copyTextureToTexture`).

### E15 REAL [low] packages/core/src/renderer.ts:1195 — overlapping compiles can leave the frame-buffer texture renamed
`frameBufferName` is captured per call (:1190-1194) and restored in `finally` as `frameBufferTexture.name = frameBufferName ?? ""` (:1216), with no ownership or depth count. Two overlapping `compileAsync` calls interleave that save/restore, and whichever finishes last leaves its captured name; `activeCompiles` (:690, :1203) exists precisely because frames run during a compile, and `compileAsync` has no mutual exclusion.
Engine layer: restore only if this call still owns the name (token/depth count).

### E22 REAL [low] packages/create-threenative/src/terrain-kit.ts:18 — symlinked ancestors reject legitimate targets
`assertNoSymlinkAncestor` walks every ancestor to the filesystem root with `lstat` on the *lexical* path (:18-36) and throws on any symlink, with no `realpath` normalisation and no allowance for OS-owned links, so on macOS (`/tmp`, `/var` → `/private`) and under a symlinked home/nix store, `copyTerrainKit` always throws `TN_TERRAIN_KIT_SYMLINK` while the message tells the user to pick real parent folders. `__tests__/terrain-kit.spec.ts` builds its targets under `os.tmpdir()`.
`packages/create-threenative` layer: compare against `realpath` of each ancestor (refusing only links below the first real one).

### E23 REAL [low] packages/core/__tests__/world-bundle-safety.spec.ts:72 — the row-cap test sits under the row cap
The same file records that `chain(1000)` measures 2,009 rows (:78), so `chain(500)` is about 1,005 rows — under the old 1,024-row witness cap the test's title and its "~1,290 rows" comment claim to cross. Only the old 8,192-link cap makes it red against old code.
Test layer: use a chain that really passes 1,024 rows, or assert the measured row count.

### E24 REAL [low] packages/core/__tests__/three-patch-retained.spec.ts:124 — width-change step never reaches the size check
The test dispatches a `resize` event (:121) that destroys *and clears* both cached buffers (`expect(four.destroy)`/`one.destroy` at :122-123) before it changes `width = 32` and asserts a new buffer (:124-125). The next `getDepthBuffer` therefore takes the `cache === undefined` path, so deleting the `cache.width !== width` comparison from the patch keeps this green.
Test layer: change the width without a resize event, then assert the buffer changes.

### E25 REAL [low] packages/core/src/frame-budget.ts:1116 — endFrame doc says a hitch returns undefined
The doc on `endFrame` still says it returns "`undefined` when the frame was a hitch and therefore excluded", while the hitch branch now `return sample;` under "diagnostics still need the measured callback phases" (:1172-1173). `loop.ts:475` stores that return and feeds the per-frame diagnostics sample.
Engine layer: fix the doc (the window meters are what exclude the hitch).

### E26 REAL [low] packages/core/src/card-lod.ts:38 — a zero-area kept card scales about the origin
`island.area > 0 ? island.centre.divideScalar(island.area) : island.centre` falls back to the raw accumulator, which is `(0,0,0)` for an all-degenerate island because every contribution was weighted by 0 (the `addScaledVector(centre, area)` accumulation). The kept card is then scaled by `sqrt(total/keptArea)` about the world origin instead of its own centre.
Engine layer: keep an unweighted vertex sum as the fallback centre.

### E27 REAL [low] packages/playtest/src/runner/runner.ts:493 — profile starts before the worker-relaunch throw
`startBrowserCpuProfile` moved to :493-495, ahead of the `WorkerGameRelaunch` throw at :498-500. The `finally` at :1017 calls `stopCpuProfile(false)`, which writes the profile and prints its `{cpuProfile}` line (:303-308), so the aborted attempt's profile is reported and then overwritten by the retry.
`packages/playtest` layer: start the profile after the relaunch check.

### E31 REAL [low] packages/engine-mcp/src/index.ts:438 — silent-e stop words survive as their stems
"make", "give", "take", "have" are in `STOP_WORDS` and are dropped before stemming, but their inflections are not: `makes`→`mak`, `gives`→`giv`, `takes`→`tak`, `likes`→`lik` (verified against the file's own `stem`/`suffixStripped`), and none of those stems is in `STOP_WORDS`, so the post-stem filter (:437-438) keeps them. The spec's title "drops a stop word in every inflection" is true only for words whose stem matches a stop word (`keeps`→`keep`).
`packages/engine-mcp` layer: add the stemmed forms, or drop a silent `e` before the stop-word test.

### E32 REAL [low] packages/physics/src/scatter-colliders.ts:193 — forced "trunk" can throw on a zero radius
`if (collision === "trunk") return TRUNK;` (:193) skips the `profile.radius * across < MIN_TRUNK_RADIUS` guard that the auto path applies (:204). `#create` then calls `CollisionShape3D.capsule(Math.max(0, height / 2 - radius), radius)` (:306) with `radius === 0`, and `CollisionShape3D.capsule` throws through `finitePositive(radius, "capsule")` (`CollisionShape3D.ts:135`), from `update()`.
`packages/physics` layer: apply the radius guard (or a minimum) to the forced trunk too.

### E33 REAL [low] examples/strata-terrain-preview/__tests__/propStreaming.spec.ts:11 — the named per-variant minimum is local theatre
`minimumByVariant` is a local `Map` built from the same fixture (:12-16) and only used for `expect(minimumByVariant.size).toBe(placements.length)` (:17); the gate assertions (:18-28) use the fixture scales directly. The production wiring (`propWorld.ts` min-per-variant → `impostorDistanceForScale`) is not exercised, so a min computed over the wrong set would pass.
Game test: assert through the production helper.

### E34 REAL [low] examples/strata-terrain-preview/__tests__/prop-streaming.spec.ts:868 — no upper bound on the invalidated region
The loop asserts only that each reported box *contains* the instance bounds and that `max.y - min.y > 0` (:868-877). A world-sized box satisfies every assertion, so "regional" is unverified.
Game test: bound each box by the instance's own size plus a margin.

### E35 REAL [low] examples/strata-terrain-preview/__tests__/river-clearance.spec.ts:84 — bank placement is only a count
The second test's river-rock assertion is `expect(counts.riverrock).toBeGreaterThan(250)` (:91); only the pebble half asserts positions (`flooded`). Rocks anywhere pass.
Game test: assert each `riverrock` placement sits near the ribbon.

### E37 REAL [low] packages/core/src/world-chunk-shadow.ts:240 — three per-camera buffers against a 5-level ladder
`if (levels.size === 3)` evicts the oldest camera slot and `level.selected.fill(255)` forces the whole index to be rewritten and re-uploaded (:240-248, :270). The virtual shadow ladder gives every level its own camera (`render/virtual-shadow.ts:1681`), and the ≤2x expansion makes 5 levels the normal case (as `looks.spec.ts` shows), so the 4th and 5th cameras rewrite a buffer every render. The cost is marked as a ponytail simplification (:241).
Engine layer: size the cache from the shadow ladder's level count (or keep the slot per level index).

### E38 REAL [low] packages/core/src/world-terrain-splat.ts:215 — file:/// directories collapse to file:/
Running `packageAssetPath` from this file: `"file:///game/world/" + "tex/a.jpg"` returns `file:/game/world/tex/a.jpg` (the prefix regex needs a host character after `//`, so the `file:` scheme is treated as a path segment and one `/` is re-inserted by the join). Every layer texture goes through it (`:529`, including the default `<textures>/<id>_<kind>.jpg`), so a package served from a file URL loses its slashes.
Engine layer: keep the `file:` scheme (and its triple slash) in the prefix.

### E43 REAL [low] packages/runtime-native/tests/conformance-runner.test.mjs:130 — tolerance claim vs pinned value
Title says "one-level rasterizer rounding and no more" over the comment's measured `0.0125 / deltaE 0.0057`, while the pinned tolerance is `{ pixelMismatchRatio: 0.02, perceptualDeltaE: 3.0 }` — a first-frame shadow regression up to deltaE 3.0 still passes. The pinned values, not the claim, are what the registry enforces.
Test layer: tighten the assertion or retitle it.

### E44 NOT-REAL [low] tests/native-engine/abi_test.cpp:1198 — two nodes sharing a binding with different textures
The two texture nodes never coexist in one material graph: `texture` is what `lit`/`colorNode` chains in, `other` is a local never attached to the material, so `findGraphSources` (`renderer/render_database.cpp:45-70`) never sees the name twice and its `TN_NATIVE_TEXTURE_VALUE_SHARED` guard is not bypassed. The CHECK documents `.value` moving only its own node, which is what the comment above it says.

### E46 REAL [medium] packages/assets/src/lod/generate.ts:982 — scaled card copies clamp at the quantized POSITION bounds
`appendCardCopies` writes the grown card positions with `extended.setElement(...)` (:982-984) on the POSITION accessor it cloned from the cooked species document; that document comes through `modelPass` with `quantize: true` by default (`passes/model.ts:837`), so POSITION is a *normalized* INT16 accessor. glTF-Transform's normalized `setElement` runs `encodeNormalizedInt`, which clamps to [-1, 1] and rounds to 1/32767 (verified in the installed `@gltf-transform/core` `dist/index.js:810-816, 1611-1617`). Any card vertex pushed past the mesh's quantized bounds is clamped, so the far level stops preserving area exactly where the growth matters (the crown edge).
Engine layer: dequantize (or skip normalized accessors) for the card copies, and update the accessor's min/max.

### E47 REAL [low] packages/assets/src/passes/shared-images.ts:421 — the "no JSON chunk" error is unreachable
The post-loop test is `offset !== buffer.length || json === null || typeof json !== "object" || json?.asset?.version !== "2.0"`; `typeof undefined !== "object"` is true, so a GLB with no JSON chunk throws the generic "invalid GLB JSON or chunk length" at :420-421 and the specific `GLB has no JSON chunk` branch at :423 can never run.
Engine layer: test `json === undefined` first.

### E50 REAL [low] packages/terrain/__tests__/editor-document.spec.ts:540 — fixed 200 ms sleep turns a load flake into a hang
`const first = send(); await new Promise(r => setTimeout(r, 200)); const second = await send();` (:556-558): if the first request has not claimed the export lock within 200 ms, the second request owns the lock and its fake cook spins on the gate file (:544-548), which the test only removes after `expect(second.status).toBe(409)` — so the test times out instead of failing.
Terrain test: poll for the lock (or a ready signal), and remove the gate in the `finally`.

### E51 NOT-REAL [low] tests/native-engine/shader_package_test.cpp:330 — wall-clock ratio can flake
`CHECK(renameMs < 30.0 * copyMs + 10.0)` (:330) with the recorded 25 ms rename against a 2.4 ms copy leaves about 3.3x headroom plus a 10 ms floor; both arms allocate and touch the same 16 MB string, so contention moves them together. No evidence of a flake and no cheaper deterministic alternative is proposed; speculative as reported.

### E53 REAL [low] packages/three-native/src/tsl-uniforms.ts:168 — object-valued uniform nodes are pinned for the page's life
The epic replaced `Set<WeakRef<TNode>>` (with pruning in `sync`) by `const objects = new Set<TNode>()` (:172) and the sync loop now walks every entry ever added (:329-333). `liveUniforms` is created once per page (`browser-tsl.ts:810`, `player/core-tsl.mjs:18`), so a game that builds `uniform(new Color())` per material or per world grows both memory and every frame's sync. The comment marks it as deliberate ("kept for the page's life ... Release with the owning material").
Engine layer: keep the wrapper alive through the owning material (a release hook on dispose) instead of a set with no removal.

### E54 REAL [low] packages/terrain/__tests__/example-imports.spec.ts:9 — the guard only matches import syntax
The regex catches `from '...examples/…'` and `import('...examples/…')` only (:9), while two real dependencies use path strings: `landforms.spec.ts:16` (`new URL("../../../examples/strata-terrain-preview/scripts/dem/", import.meta.url)`) and `kit-assets.spec.ts:227` (`join(root, "../../examples/strata-terrain-preview/src")`). Moving or renaming that example does not fail this guard.
Terrain test: also match `examples/` inside a quoted path literal.

### E55 REAL [low] packages/terrain/__tests__/kit-runtime.spec.ts:109 — placement record comment states the wrong layout
The comment says "x, y, z, three unused, a scale in the last slot" (:95), but the 8-float record is position(3) + normalized quaternion(4) + scale(1) (`core/world-package.ts:177-179`), and the fixture `[0,0,0, 0,0,0,1, 1]` is a unit quaternion with scale 1.
Terrain test: fix the comment.

### E56 REAL [medium] packages/terrain/starter/forest/world.ts:154 — bendCrownNormals is not idempotent
`bendCrownNormals(mesh.geometry, CROWN_NORMAL_BEND)` mutates the geometry in place (:162-177), and `dressProp` runs on the model `ctx.assets.model()` returns, which is cached and shared. Loading the forest, switching to another Strata world and returning re-bends the same normals by another 0.7 lerp toward the crown axis, so the shading drifts on each revisit.
`packages/terrain` starter layer: mark the geometry once (`userData`) or bend a clone.

### E57 REAL [low] packages/terrain/starter/desert/world.ts:51 — mid-LOD boulders never get the sky
`lighting: { sky, lods: false, dress }` in alpine, coastal, desert and tundra (:51/:65), while `starter.ts:262-266` dresses only `asset.glb` unless `lods` is true; desert, tundra and alpine each bake `boulder.mid` at `midDistance: 35` (`starter/<kit>/assets.json`). Past 35 m the boulder draws its raw scan material with no envMap, the exact failure the forest code comments on (`starter.ts:262-263`).
`packages/terrain` starter layer: dress the mid GLB too.

### E58 REAL [low] packages/runtime-native/src/engine/renderer/render_database.cpp:1885 — reflectionPass trusts a stale key
`reflectionPass` looks up `reflections_[reflector.get()]` and builds only when `!pass.database`, never checking `pass.owner.expired()` (:1885-1892); `renderReflections` purges expired owners (:1947) but the epic's new `precacheReflections` (:1906, called from `compileAsync` at :1804) does not. A reflector freed by a world switch whose address a new reflector reuses therefore returns the old pass and database.
Engine layer: purge expired entries (or check the owner) at the top of `reflectionPass`.

### E60 REAL [low] scripts/prepare-release.ts:224 — comment calls terrain peers external
"Terrain peers are external packages, such as three and vite" (:224) sits above a loop that exists to sync `@threenative/core` and `@threenative/physics` too: `packages/terrain/package.json` peers are those two plus three and vite, and `scripts/__tests__/prepare-release.spec.ts:202-225` asserts the internal sync.
`scripts/` layer: fix the comment.

### E61 REAL [low] scripts/verify-forest-playtest.ts:132 — a reply can resolve on a half-received line
`for (const line of buffer.split("\n")) if (line.includes('"id":2')) { child.kill(); resolve(line); }` (:130-135): the last element of the split is the unterminated tail, and `"id":2` appears near the start of the JSON-RPC reply, so a reply larger than one pipe chunk resolves with a truncated line that the caller cannot parse.
`scripts/` layer: only match newline-terminated lines.

### E62 REAL [medium] packages/terrain/__tests__/terrain-mcp.spec.ts:1173 — the matrix pins 35 empty worlds as success
The 35 landform × kit pairs assert `expect(result.instances).toBe(0)` and `expect(manifest.cells).toEqual([])` (:1203-1204), because the five biome files name the preview's licensed `spruce`/`sapling` while the kits ship `fir` (verified: `starter/*/biome.data.json` vs `starter/*/assets.json`). A `terrain_generate {kit, landform}` call therefore cooks a treeless world for every pair and the matrix calls that the AC.
`packages/terrain` data layer: name species the kits ship (the savanna override test shows the fix), or fail the cook.

### E63 REAL [low] packages/terrain/__tests__/terrain-mcp.spec.ts:1319 — wall-clock comparison across two process contexts
`expect(result.ms).toBeLessThanOrEqual(forestCook.ms)` (:1383) compares a cook measured inside a freshly spawned MCP child with a later in-process `cookKit` measurement, with no margin: the cold child carries JIT/module-load cost, so load alone can flip the comparison.
Terrain test: measure both arms the same way, or assert a generous factor.

### E67 NOT-REAL [low] packages/terrain/src/mcp/server.ts:100 — a failed cook burns the biome name
The parent removes what it claimed on failure: `catch (error) { await rm(biomeDir, { recursive: true, force: true }); throw error; }` (`src/mcp/server.ts:107-110`), and the comment above states that retry is the intent. Both `resolveOutput` calls happen before anything is written, so a refusal leaves nothing behind either.

### E68 REAL [low] packages/terrain/src/mcp/tools.ts:201 — an explicit kit silently beats a conflicting biome/request
`const kit = args.kit ?? biomeKit ?? (spec === undefined ? TERRAIN_KITS[wordMatch] : "forest")` (:201-209) takes the explicit kit and never compares it with `args.biome` or the request words, so `{kit:"forest", biome:"beach"}` or `{kit:"forest", request:"a desert"}` cooks the forest with no warning, while the same tool fails closed on unknown fields and unmatched words.
`packages/terrain` layer: throw when an explicit kit disagrees with the biome argument or the matched word.

## Summary

| Verdict | Count |
| --- | --- |
| REAL | 67 |
| NOT-REAL | 9 |
| UNSURE | 0 |
| **total** | **76** |

Severity of the 67 REAL: **8 high**, **14 medium**, **45 low**.
NOT-REAL: E00, E04, E10, E12, E20, E44, E48, E51, E67 (their claimed facts do not hold at HEAD: fixed/deleted already, contradicted by an existing test, or the guard they say is missing exists).

**REAL high** — every one of these makes the board red or a launch fail at HEAD:
- E08 engine: 4 instance-history specs red; the 0.187.0 patch drops the "unchanged history" reuse, so previous matrices upload every draw (predates the epic, still red).
- E36 test: `packages/create-threenative/__tests__/looks.spec.ts:75` red on the expanded shadow ladder.
- E69 tooling: `scripts/__tests__/verify-forest-playtest.spec.ts` 6/8 red, `READY_ANCHOR` no longer matches the starter.
- E70 test: `scripts/__tests__/prepare-release.spec.ts` 2 red, fixture copies a non-existent `packages/blender-mcp`.
- E71 packaging: `scripts/__tests__/mcp-tool-schemas.spec.ts` red, `terrain-mcp-tools.json` lacks `terrain_biome_new`.
- E72 docs: `scripts/__tests__/strata-script-census.spec.ts` red, six new example scripts/playtests undocumented.
- E21 engine: `compileWithinDeadline` queues *rejected* compiles into the held-startup completion, so one unsupported material fails the launch the comment says must not fail.
- E64 scripts: `verify-strata-startup.ts` compares devDependencies against the pinned baseline and now always throws.

**REAL medium**: E09, E11, E17, E29, E39, E40, E41, E46, E49, E52, E56, E59, E62, E73.
E52 and E59 are the same finding (rain admitted as a CPU slot); one fix closes both.
