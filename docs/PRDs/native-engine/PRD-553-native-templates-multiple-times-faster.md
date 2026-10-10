# PRD-553 — Native templates run multiple times faster than three.js

**Status:** IN PROGRESS
**Priority:** P0 — owner, 2026-10-09: "zero tolerance. Native must be multiple times faster than threejs"; the Wasm `minimal` template is 1.7x three.js (637 vs 370 fps), not multiple times
**Complexity:** 6 (MEDIUM) — per-frame work that crosses the JS-engine boundary moves into the shared engine, one measured lever at a time
**Owner:** João
**Work package:** native-engine performance, measured on real templates against the three.js control on the same lane
**Depends on:** [PRD-540](../done/native-engine/PRD-540-web-games-boot-on-the-wasm-engine.md) (done), [PRD-531](PRD-531-n18-v8-game-runtime-adapter.md)

## Context

`pnpm profile:wasm-page --url <native minimal> --control <three.js minimal>` on 2026-10-09 (nvidia
turing, private Xvfb): native p50 1.40 ms, 637 fps; three.js p50 2.10 ms, 370 fps. The native page's
CPU: page JS 33.5%, engine Wasm 22.4%, `getCurrentTexture` 19.9% (the frame's backpressure wait;
three.js waits in `submit`, 44%), `(program)` 12.7%. The page JS makes 365 engine calls per frame;
about 250 of them are core's projected-size cull (`render-camera-cull.ts`), which walks the visible
scene every frame in JS and reads each object's bounds, matrices and flags through the engine.
Stubbing that walk drops the calls to 113 per frame and raises the frame rate 8%.

## Solution

Move per-frame work that the engine can do in one call into the shared C++ engine, keeping core's
rule as the one specification: core calls the engine's version when the scene root offers it, and
keeps its JS walk otherwise. Each lever is measured on the template against the control, and each
is hardened with a counter (engine calls per frame), never a timing gate.

## Execution Phases

#### Phase 1: The projected-size cull runs in the engine
**Status:** DONE

- [x] The engine's projected-size cull makes the decisions core's JS cull makes, object for object, including its exemptions and bound staleness. proof: `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_backend` (core's own cull over the same scenes in the pinned three and in the engine; the oracle is core's TypeScript, so the comparison runs on the real Wasm module, not a C++-only test) — 2026-10-09: `native_engine_wasm_browser_backend` runs core's own `RenderCameraCull` over the same scene in the pinned three (JS walk) and in the engine (`Object3D.__cullProjected`), three frames: the same report and the same hidden set, over camera-attached, alwaysRender, frustumCulled = false, an off-screen shadow caster, no usable bounds, a buffer rewritten every frame, and culled far objects, pass. The JS walk over engine objects never tracked a rewritten buffer (the wrapper has no `geometry.attributes.position.version`); the engine path does, as core's rule over three does.
- [x] Core uses it when the root offers it, and the Wasm `minimal` page drops its per-frame engine calls. proof: `pnpm profile:wasm-page --calls` engine calls per frame, and a counter assertion on the wasm-engine-boot renderer page — 2026-10-09: `pnpm profile:wasm-page --calls` on the `minimal` template: 365 -> 124 engine calls per frame, page JS 34.7% -> 24.5% of CPU (frame p50 unchanged at 1.40 ms: the native frame now waits on GPU and present). Gate: `pnpm --filter wasm-engine-boot playtest:game` bounds a steady drawn frame of the core game page at 37 engine calls, exit 0; with core's JS walk instead of the engine's cull it makes 62 and fails.

#### Phase 2: The template is multiple times faster than three.js
**Status:** PARTIAL

- [ ] The Wasm `minimal` page runs at least 2x the three.js control's frame rate on the same lane. proof: `pnpm profile:wasm-page --url <native> --control <three.js>`, subject/control frame p50
  2026-10-09: 1.40 ms vs 2.10 ms (1.5x). This lane cannot show 2x: a blank page that only clears and presents runs at 1.20 ms p50 (642 fps) under the same private Xvfb, and 2x the control is 728 fps. See Blocked on.
- [x] A steady safe point asks the engine about a bounded slice of the wrappers it holds, not every one every frame. proof: `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_gc` — 2026-10-09: red at 503 wrappers asked per steady safe point (at most 64 allowed), green after (32 plus the new ones), and a wrapper detached after it was confirmed is still collected. On the `minimal` page, page JS fell from 25.2% to 16.2% of the CPU profile.
- [x] Engine objects fire three's graph events (`added`, `removed`, `childadded`, `childremoved`), so core tracks LOD and clustered meshes instead of walking the scene twice a frame. proof: `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_backend` and `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_v8_skeletal` — 2026-10-09: the Wasm smoke was red ("Object3D has addEventListener"), green after with the events in three's order, a removed listener silent, and a throwing listener throwing from the graph call; V8 green on the same order. `pnpm --filter wasm-engine-boot playtest:game` now bounds a steady frame at 33 engine calls (37 before), exit 0. On the `minimal` page `updateModelLods` fell from 3.0% to 0.1% of the CPU profile and `updateClusteredMeshes` from 2.4% to 0.
- [ ] The native page's CPU work per frame is at most half the control's. proof: `pnpm profile:wasm-page --cpu-work`, subject/control work p50
  2026-10-09: 0.6 ms vs 1.1 ms (1.8x; `performance.now()` steps 0.1 ms here); 0.5 ms after the graph events (2.2x, inside the timer's step, so not ticked). After the uniform-packing change, five runs of `profile:wasm-page` with the profile-derived CPU busy time, desktop load 4-12: control/subject busy 1.26x, 2.88x, 2.84x, 1.99x, 1.60x (median 1.99x); frame p50 ratio median 1.6x. Too noisy to tick; needs a quiet machine. GPU work per frame is 1.03 ms vs 2.41 ms (2.3x, `--gpu-passes`).

#### Phase 3: Midway on the web never loses to three.js
**Status:** PARTIAL

- [x] Midway's native page spends no more CPU per frame than the three.js control. proof: `pnpm profile:wasm-page --url <native Midway> --control <three.js Midway> --gpu-calls`, profile-derived CPU busy per frame
  2026-10-09 (d87c61bed, frustum cull on the main pass, on the rebuilt `tn-native-engine-web` Wasm): 12.9 ms vs 15.7 ms (was 22.1 ms), 78 vs 63 fps, WebGPU calls 1160 vs 2204 per frame. Main-pass draws 163 vs 158 (was 577), half-res pass 49 vs 49 (was 282), shadow pass 146 vs 97. One run; not ticked until it repeats after the shadow-caster cull.
  2026-10-09 (0b031d823, shadow casters frustum-culled against each shadow camera, rebuilt Wasm 18:37): draws per pass main 164 vs 158, half-res 50 vs 49, shadow 95 vs 97 (was 146). The latest CPU reading, 18:22 and before the shadow cull reached the page: busy 9.88 ms vs 7.10 ms, frame p50 9.7 ms vs 6.8 ms, so the box stays open. Remaining CPU work is with the steady-frame lane (`RenderDatabase::render`, `Renderer::render`).
  2026-10-09 (9fae37298 + a188cd40a + a69b06235, rebuilt Wasm 19:05, three.js control on the same lane, load 3.2-5.7): control/subject CPU busy 1.39x, 1.29x, 1.51x (native 5.14, 4.56, 4.62 ms vs 7.13, 5.89, 6.97 ms). The steady-frame lane's own three runs at load 2.6-3.3 gave 4.70, 5.70, 4.71 ms vs 6.25, 6.26, 7.02 ms. Ticked: six runs in two sessions, none above the control. The change: a settled skinned-projection decline holds 60 frames like core's `DECLINE_RESCAN_FRAMES` (`projection::decide` was 37% of busy CPU), and the shadow-light list is cached until `Object3D::hierarchyVersion()` moves.
- [x] Midway's native frame p50 is at most the control's. proof: the same command, subject/control frame p50
  2026-10-09: 9.3 ms vs 7.2 ms. Top native self time: `RenderDatabase::render` 27.8% (inlined prepare), `Renderer::render` 13.5%, `AnimationMixer` 7%.
  2026-10-09 (same builds): subject/control frame p50 0.70x, 0.79x, 0.67x (4.70, 4.40, 4.50 ms vs 6.70, 5.60, 6.70 ms, 194-219 fps native); cpu-opus's three runs gave 4.6, 5.1, 4.5 ms vs 5.8, 5.9, 6.5 ms. Ticked.
- [ ] Midway's native page reaches `enter` no later than the control. proof: `pnpm profile:wasm-page --load`, the game's `LOAD_STEP` markers on both pages
  2026-10-09: scene-load-total 3.0 s vs 2.8 s, enter 6.0 s vs 4.27 s, ready 15.2 s vs 15.1 s. The gap is scene-load to enter (3.0 s vs 1.45 s); the top native self time there is the engine's JS glue, then `RenderDatabase::render` 1.8 s, `BufferAttribute::setRaw` 0.36 s and `ProjectedCull` 0.32 s.
  2026-10-09 (later, `.midway-uploads.ts` probe over both pages, 30 s load): the gap is not upload count. Native makes 274 texture uploads from 263 unique sources (5 repeated); three makes 349 from 326. Native's `copyExternalImageToTexture` time is 7.4 s against 3.7 s, and one call is most of it: a 128x128 canvas copy, call 252 of 274, blocks 4.3 s on the main thread (three's worst canvas copies block 1.35 s and 0.24 s). Every ImageBitmap copy, 2048x2048 included, takes about 8 ms. The stall is the main thread waiting on queued GPU work, so it moves with how much GPU work the load queues before that copy. The `lane/native-cpu` commits (typed bulk attribute fill, 369ebf3c1; one submit for every mip chain, 529b2378a) are not in this Wasm and are not measured on Midway yet.
  2026-10-09 (with 369ebf3c1 typed bulk fill and 529b2378a one submit for all mip chains, now cherry-picked as a188cd40a and a69b06235, Wasm 19:05, 3 runs): enter 5.73, 5.80, 5.77 s vs 4.10, 4.14, 4.09 s; scene-load-total 2.9 s vs 2.7 s. Still open: the single 128x128 canvas copy stalls the main thread 3.2 s (4.3 s before the mip batching) vs three's 1.35 s. 91 render pipelines made sync vs three's 150 sync and 65 async, so pipeline count is not the cause. cpu-opus has the stall.
  2026-10-10 (3ca98e52e, cpu-opus, Opus 5.5; its runs, not re-measured clean here because host load was 60-80): the canvas stall is not what holds `enter`. That 128x128 copy runs at about 8.0 s, after `enter` (5.8 s), inside `warmUpViews` -> `warmHiddenPasses` -> `Renderer::materialTexture`, so it delays `ready`, and `ready` already matches or beats three.js (14.3-15.1 s vs 14.9-15.3 s). The `enter` gap is the window between scene-load-total and `enter`, inside the game's `makeWorld`: 2778 ms native vs 1469 ms three.js on the CPU profile. Two native-only costs were cut: per-element `getComponent` -> `raw` -> `BufferStore::read` in `applyMatrix4`, `toNonIndexed`, `computeBoundingSphere`, `computeVertexNormals`, `computeBoundingBox` (about 830 ms; Float32 items now read in place), and `parseTrackName` re-running `std::regex` per action bind (100-170 ms; cached). `enter` is now 5.22-5.43 s vs 4.25-4.43 s: about 40% of the gap closed, native still loses by about 1 s. Left: 486k JS-to-engine calls in that window (`addScaledVector` 42k, `__address` get 36k, `hasAttribute` 34k, `clamp` 25k, `applyMatrix4` 24k, `name` gets about 57k), and 1353 ms of self time in `packages/three-native/src/browser-backend.ts` (`writeHandle`, `toEngine`, `wrap`, arena `alloc`, `countCall`). The lever is keeping the small math types (Vector3 and similar) in JS on the web backend and passing them by value at the boundary; that changes `Object3D.position` and the in-place fields, so it needs its own decision. Box stays open.
  2026-10-09 (d67b757f0, Vector3 and MathUtils as JS values on the web back end): enter about 0.96-1.09x the control over three runs at host load 34-73, so not ticked. The opt-in call census over the scene-load-total to `enter` window counts 175,190 engine calls; attribute reads are 29% of them.
  2026-10-10 (7f1538aa1, cpu-opus): the exact-window CDP profile (4+4 runs) puts facade self time at 198-453 ms native against 184-325 ms Wasm. The large `getImageData` wait in the rear station (2.2-4.8 s against 0.6-0.8 s) is a symptom: with `willReadFrequently` forced in both arms it falls to about 25 ms, and enter minus load-total stays at 2.3-2.8 s against 1.9-2.3 s. The window is CPU-bound: facade + Wasm 659 ms against three.core 421 ms, GC 127 ms against 19-81 ms. Facade call cost is cut 2-3x (`invoke` 544 -> 181 ns). Enter over three plain runs: 1.17, 1.06, 0.93x. Box stays open.
- [ ] Midway's native page reaches `ready` at least 10% before the control, over three runs in one window. proof: `pnpm profile:wasm-page --load`, the game's `LOAD_STEP` markers on both pages
  2026-10-09 (d67b757f0): 0.73-1.05x, mixed. Native uploaded 242.6 MB of geometry before `ready` against three's 114.8 MB, through `warmUpViews` -> `warmHiddenPasses` -> `GeometryCache::sync`.
  2026-10-10 (7f1538aa1, same window as the first-frame runs): 0.95, 0.80, 0.86x. 0.95 misses, so the box stays open.
- [x] Midway's native page draws its first frame at least 10% before the control, over three runs in one window. proof: `pnpm profile:wasm-page --load`, first-frame marker on both pages
  2026-10-09 (d67b757f0): 0.48-0.62x of the control's time, so native already leads; not ticked until three runs repeat it in one window at low host load.
  2026-10-10 (7f1538aa1, cpu-opus, three runs in one window, plain Midway, host load 17.5): 0.73, 0.68, 0.63x of the control (port 4796). The earlier window (4920c39bd) gave 0.69, 0.80, 0.58x. Visual judge (fresh Sonnet subagent, nvidia turing, 2 BEFORE dist-0093 + 2 AFTER 7f1538aa1): PASS, both frames SAME. Ticked.
- [x] New geometry reaches the GPU without queue-write waits: Midway's queue writes before `ready` stay under 10 MB. proof: the `.midway-uploads.ts` method (`writeBuffer` bytes and time over the load), both pages
  2026-10-09 (b4cb98bf6, cpu-opus; not yet re-run here): `GeometryCache` creates new buffers mapped and copies the store into them, as three's WebGPU backend does. Queue writes 240.8 MB / 7908 ms -> 6.5 MB / 10 ms; mapped creation 231.6 MB / 12 ms (three: 131.6 MB mapped plus 96.8 MB queued). `ctest -L native-engine` 288/290 (the two known reds).
  2026-10-10 (8c6acec73 web build, `scripts/.gpu-uploads.ts` with `STOP=ready`, both pages, host load 40-50): native `writeBuffer` before `ready` 8.7, 6.9, 6.5, 6.0 MB over four runs (69-117 calls, 8-15 ms), plus 231.6 MB in 5859 mapped-at-creation buffers. The three.js control queues 51.4, 96.7, 75.2 MB (46k-75k calls, 212-300 ms) plus 130-132 MB mapped; its fourth run timed out before `ready`. Ticked.
- [x] Midway's `enter` window makes at most half the engine calls it made at d67b757f0 (175,190). proof: the opt-in call census in `packages/three-native/src/browser-backend.ts`, counted between the `scene-load-total` and `enter` markers
  2026-10-09: 151,547 at bf456a1f1 (a geometry lists its attribute names with one call); 137,572 at 16c0f0d91 (an attribute's count, itemSize, normalized and gpuType with one call). Target 87,595. Largest left: PropertyBinding bind (4 calls per track, 11.3k), `Layers.enable`/`disable` from the game's traversals (7.3k), `getAttribute` first lookups (9.3k), `parent` gets (7.5k), shadow-flag sets (5.9k), `Vector3.__address` first reads (5.1k).
  2026-10-10: 87,728 after b4102738f and aebada1b8; 81,481 at 4b7f7a53d (Quaternion math in c85238246 and Color in 4b7f7a53d run in JS), under the 87,595 target. The call cut did not move `enter` (1.20, 1.31, 1.01x the three control in one window at host load 5-8): the CPU profile spreads the cost over per-call marshaling, so 6.2k fewer calls is about 70 ms, inside the run-to-run noise.

## Known gaps

- The engine's cull reads an InstancedMesh's own bound and every other object's geometry bound. Core's walk reads `object.boundingSphere` whenever three has set one, which it does for a SkinnedMesh (posed) and a BatchedMesh, so those two can cull differently; the parity test covers plain meshes only. (Fresh-eyes review, 2026-10-09.)

## Blocked on

- A display lane that presents faster than ~640 fps, for the frame-rate box: private Xvfb caps a blank WebGPU page at 642 fps, headless Chrome falls back to SwiftShader, and the host display is not for playtests. Until then the CPU-work and GPU-pass ratios carry the claim.
