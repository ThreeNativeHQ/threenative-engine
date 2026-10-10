# PRD-581 — Midway runs as one JS-free native binary through Perry

**Status:** IN PROGRESS
**Priority:** P1 — the owner asked for Midway "fully running with perry and fully native, no JS or JS bridge" (2026-10-10); it does not link under Perry today (Phases 1–3 open).
**Complexity:** 5 (HIGH) — the three facade, `@threenative/core` and the HUD all cross the Perry boundary; risk override: none
**Owner:** João
**Depends on:** [PRD-530](./PRD-530-n17-strict-native-typescript-game-packaging.md) (strict packaging, identity, JS-free inspection, gate T)
**Estimate:** Phase 1 ≈ 2 days; Phase 2 ≈ 2–3 days; Phase 3 ≈ 2 days. Most of it runs on Codex.

## Context

Layer: engine (`packages/three-native/`, `packages/runtime-native/`, `tools/native-typescript/`).
Midway's own source does not change: a fix that Midway needs is a missing engine or facade API.

Survey on 2026-10-10 (`compile-game.mjs sandbox/midway-open-pacific`, Perry 0.5.1520): Perry
compiled all 56 modules natively, with 0 compiler errors and 0 JavaScript modules. The link fails on:

- 5 unresolved imports: `@threenative/core`, `@threenative/core/playtest`, `three/tsl`,
  `three/webgpu`, `three/addons/loaders/HDRLoader.js`.
- 26 undefined symbols: TSL names (`Fn`, `uniform`, `vec2`..`vec4`, `mx_noise_float`,
  `mx_worley_noise_vec2`, `pmremTexture` and others) and core exports (`defineGame`, `playtest`,
  `mergeParts`, `onLaunchFailure`, `attitudeAxes`, `softCircleDataTexture`).
- 14 missing members of the Perry three facade (`BufferGeometry`, `DataTexture`, `Vector2`,
  `Vector4`, `Float32BufferAttribute`, `DataUtils`, wrap/filter/format constants).
- 1 unknown global: `document`.

Staging `@threenative/core` adds its own imports (PRD-530 Phase 3 lists them): `three/webgpu`,
`three/tsl`, the GLTF/KTX2/DRACO/meshopt loaders, `three-mesh-bvh`, `zustand/vanilla` and the
`document`/`window`/`ResizeObserver` reads.

Two three facades exist. The Perry one (`tools/native-typescript/three/three.ts`, 435 lines) covers
the qualification fixtures only. The browser one (`packages/three-native/src/`, about 7.3k lines)
runs Midway on the web today. It reaches the engine through a 13-function C ABI (`TnAbiModule`
in `browser-backend.ts`: `_tn_construct`, `_tn_get`, `_tn_set`, `_tn_invoke` and others) plus
linear-memory views. That ABI is the same C ABI that a native link exposes.

Midway's HUD is DOM: `index.html` markup, `src/ui/dom.ts` and `src/hud.ts`. On the native host it
runs in a web view (`src/ui/main.tsx`), which is JS. The native-css renderer (Blitz, PR #388)
draws HTML and CSS with no JS engine.

## Solution

1. **One three facade, two transports (Phase 1).** The browser facade gets a transport seam. The
   Wasm transport stays as it is. A Perry transport binds the same `_tn_*` calls as native C
   functions and reads engine memory through native pointers, with the struct layouts for the
   pointer width (the wasm32 offsets are constants today). The Perry build then uses the browser
   facade, and the 435-line Perry facade is deleted when the corpus passes on it.
2. **`@threenative/core` under strict Perry (Phase 2).** Stage core and its workspace packages.
   Browser globals go through the host seams that the native host already has. Loaders go to the
   engine's C++ GLTF and HDR paths. `zustand/vanilla` compiles from source. `three-mesh-bvh` takes
   the form the Perry fork accepts.
3. **The HUD without a web view (Phase 3).** A `document` facade over the native-css document
   gives `dom.ts` and `hud.ts` the DOM subset they use. Then PRD-530 gate T runs on Midway.

The Perry compiler is the owner's fork (`ThreeNativeHQ/perry`), pinned through
`tools/native-typescript/compiler.lock.json`. A compiler gap is fixed in the fork, not in game code
(PRD-530 decision 2026-10-08).

## Execution Phases

#### Phase 1: The browser three facade runs under Perry
**Status:** IN PROGRESS
**Files:** `packages/three-native/src/browser-backend.ts`, `tools/native-typescript/three/`, `tools/native-typescript/corpus/`
- [x] The three-native facade compiles under strict Perry and calls the engine as native C functions, with no Wasm module and no JS engine in the binary. proof: a `three-native-minimal` case in `node tools/native-typescript/run-corpus.mjs --native` prints what the Wasm build prints, and `node packages/runtime-native/scripts/inspect-js-free.mjs --binary <case binary>` passes — 2026-10-10: `run-corpus.mjs --reference --native --case three-native-minimal` PASS/PASS using the real Wasm module and native C transport; strict compile 26 native / 0 JavaScript modules; standalone inspection JS_FREE_OK (Dawn). Full native corpus: 20/20 PASS with `TN_NATIVE_ENGINE_BUILD=build/tn-linux-engine` and Cargo offline. Browser suite excluding the subprocess driver lane: 142 tests pass; driver lane unverified because Node child execution returns EPERM.
- [ ] The Perry build of that case draws the same frame as the Wasm build. proof: the case's screenshot against the Wasm screenshot with `pnpm parity` (zero mismatch, or a visual judge PASS) — OPEN: native 320×240 PNG and callback assertion pass on cached SwiftShader Vulkan; no hardware claim. Native clear alpha now matches Wasm's default 1 (PNG assertion RED→GREEN). Reference capture fails `listen EPERM` on localhost; direct Chromium launch also fails at sandbox_host_linux.cc:41 (`shutdown: Operation not permitted`), so Wasm screenshot and comparison cannot run in this sandbox. Null native adapters fail closed.
- [x] The Midway survey reports no missing facade member and no undefined TSL name. proof: `node tools/native-typescript/compile-game.mjs <midway-open-pacific>` (`missingFacadeMembers` empty; no TSL name in `undefinedSymbols`) — 2026-10-10: 79 native / 0 JavaScript modules; missing members `[]`, no undefined TSL names and no Perry errors. Survey exits 1 on the remaining core/playtest/HDR imports and six core symbols (Phase 2); `document` and `OffscreenCanvas` remain unknown globals. Midway source unchanged.

#### Phase 2: `@threenative/core` links under strict Perry
**Status:** NOT STARTED
**Files:** `packages/runtime-native/scripts/package-strict.mjs`, `tools/native-typescript/compile-game.mjs`, `packages/core/src/`
- [ ] The minimal template links under strict Perry with core staged, and its playtest journey passes on desktop. proof: `node tools/native-typescript/compile-game.mjs packages/create-threenative/templates/minimal` exits 0, then `node packages/playtest/dist/runner/cli.js <minimal>.playtest.json --target desktop` on that binary
- [ ] Midway's GLB and HDR assets load through the engine's C++ loaders under Perry, with the same mesh and texture counts as three. proof: a corpus case that loads Midway's ship GLB and sky HDR and prints the counts, compared with the same script under tsx and three
- [ ] Midway links under strict Perry. proof: `node tools/native-typescript/compile-game.mjs <midway-open-pacific>` exits 0

#### Phase 3: Midway's HUD and gate T
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/` (native-css document), `packages/three-native/src/`
- [ ] Midway's briefing screen and in-flight HUD draw through the native-css document, with no web view. proof: `node packages/playtest/dist/runner/cli.js <midway>/native-playtests/<journey>.playtest.json --target desktop` screenshots, judged against the web build by a fresh visual judge
- [ ] Midway's strict Linux binary passes JS-free inspection and its desktop journey (PRD-530 Phase 3 boxes 1 and 2). proof: `node packages/runtime-native/scripts/inspect-js-free.mjs --binary <midway strict binary>`, then the journey with `--target desktop`
- [ ] Enter, first frame and frame p50 of the Perry binary are recorded against the V8 native host and the Wasm web build, same window, 3 runs. proof: `node packages/playtest/dist/runner/cli.js <journey> --target desktop` timing output for each arm

## Blocked on

- The strict Android binary on the emulator stays in PRD-530 Phase 3 box 3.
- Pinning the Perry fork needs the fork's commits pushed to `ThreeNativeHQ/perry` with a tag.

## Decisions

- 2026-10-10, owner: "see if you can do whole perry integration, fill any gaps, have midway fully running with perry and fully native no js or js bridge". This widens the 2026-10-09 PRD-530 decision that kept Perry a side bet. The PRD-553 web work continues beside it.
- 2026-10-10, lead: reuse the browser three facade with a Perry transport instead of growing the 435-line Perry facade, because the browser facade already runs Midway and both reach the same C ABI.
