# PRD-594 — The engine changes that rode in with #381 get native and visual proof

**Status:** PARTIAL
**Priority:** P1 — Six core behaviours from #381 that every game runs have no native conformance case and no visual-judge verdict (AC-1 to AC-6); "web-only is unfinished" applies.
**Complexity:** 5 (MEDIUM); risk override: supported-platform parity
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Core audit of `2d2124792` (2026-10-10). The squash of 485 files carried engine changes beyond the
terrain package, without their own PRDs:

- `packages/runtime-native/conformance/registry.json` has no case for WorldCells streaming, the
  HLOD/impostor/shadow proxies, `prepareTextures`, virtual-shadow `renderGroup` uniforms and
  `registeredOnCreate`, velocity buffer rotation or the streaming slice budget. The only native
  proofs are the example's desktop scripts (not in CI), the `loading-screen-desktop` assertion and
  `bindings.cpp`'s `device.lost` test.
- `render/virtual-shadow.ts` (+67/−54), `render/velocity.ts` (buffer rotation; a perf win),
  `atmosphere/luts.ts` (`textureLoad` → `texture().level(0)`) change pixels. No visual-judge
  verdict is recorded for them (owner rule 2026-10-09: any change to what reaches the screen).
- `game.ts` removes the `temporalUpscale` floor lift for render-chain velocity consumers, for
  every game with temporal reconstruction. No spec proves the floor still holds for a TRAA chain.
- `streaming.ts` changes the public default of `addInSlices` from 256 objects to an 8 ms budget,
  with no capability-detail note.
- `FrameBudget` now registers a `longtask` `PerformanceObserver` in its constructor; it is
  released only from `game.ts` teardown.

## Solution

Add three native conformance cases and run them on the desktop host. Capture before/after at
fixed poses for the shadow, velocity and LUT changes and run the owner's visual-judge protocol.
Add the missing specs and the capability-detail note.

## Acceptance Criteria

- [x] AC-1 [local]: A native conformance case streams two WorldCells cells and swaps a proxy with zero validation errors. proof: `pnpm parity` case in `registry.json` — Evidence: 2026-10-11 `run-conformance.mjs --only-tests world-cells-proxy-stream` pass on web (5.1 s) and desktop (16.2 s, nvidia, strata-terrain-proof host) at b5aa0d786; the original 1 MB proxy budget could never admit the 8 MiB HLOD reserve.
- [x] AC-2 [local]: A native conformance case uploads a compressed texture through `prepareTextures`. proof: `pnpm parity` — Evidence: 2026-10-11 `compressed-texture-preparation` pass on web (3.0 s) and desktop (13.3 s).
- [x] AC-3 [local]: A native conformance case submits a virtual-shadow first frame with no "Destroyed texture" error. proof: `pnpm parity` — Evidence: 2026-10-11 web pass (3.1 s); 2026-10-13 fresh standard V8 desktop pass (13.0 s), native exit 0, nonuniform 1280×720 capture, no GPU validation errors; current fixture tolerance and exact metrics are recorded below.
- [x] AC-4 [local]: A fresh visual judge rates the shadow, velocity and LUT changes NEUTRAL or IMPROVEMENT against the pre-#381 parent at fixed poses (headed WebGPU, two runs per arm). proof: judge verdict and images on the PR — Evidence: 2026-10-13, two headed NVIDIA runs per arm/effect; all12 captures pass, fresh read-only judge NEUTRAL for all six pairs. Twelve labelled images published on PR483 at screenshot commit3e3f716710cee4d53857bd9bf2d1c756d277fdc9; all URLs HTTP200/SHA256 verified. Controlled exact changed-file overlays against parent1a5314a1dd184dbc6f76426f546d326007cf3545 under common runtime, not an untouched full-parent build.
- [x] AC-5 [local]: A TRAA chain holds its `temporalUpscale` floor without the removed lift. proof: `pnpm exec vitest run packages/core/__tests__/renderer.spec.ts` case — Evidence: 2026-10-11 `renderer.spec.ts` 43/43 passed; real game scaler with active TRAA velocity chain holds desktop 0.61 floor through 30 GPU-overload windows; removed velocity lift remains absent. No GPU/browser claim.
- [x] AC-6 [local]: `addInSlices`' capability detail states the 8 ms default, and `FrameBudget` disconnects its observer on `dispose()`. proof: `pnpm build` manifest diff + `frame-budget.spec.ts` case — Evidence: 2026-10-11 `frame-budget.spec.ts` 28/28 passed; observer disconnects once over two dispose calls; capability-detail assertion confirms 8 ms default. `pnpm capabilities:sync` regenerates 448 entries and both manifests/reference; `pnpm api:surface:sync` passes (422 symbols), no API drift. Observer behavior was already true.

## Blocked on

- Android parity for AC-1 to AC-3 needs an emulator run with a hardware GPU mode; start the emulator before declaring this blocked (memory: Android emulator lanes are runnable here).

## Execution Phases

#### Phase 1: native cases
**Status:** PARTIAL
**Files:** `packages/runtime-native/conformance/registry.json`, conformance fixtures
- [x] WorldCells stream. proof: `pnpm parity` — 2026-10-11 pass web and desktop.
- [x] Texture upload. proof: `pnpm parity` — 2026-10-11 pass web and desktop.
- [x] Shadow first frame. proof: `pnpm parity` — 2026-10-11 pass web and desktop.

#### Phase 2: pixels judged
**Status:** COMPLETE
- [x] Judge verdict NEUTRAL or better. proof: PR images + verdict — 2026-10-13, all six pairs NEUTRAL;12 labelled captures on PR483, exact scope described in AC-4.

#### Phase 3: specs and notes
**Status:** COMPLETE
**Files:** `packages/core/__tests__/renderer.spec.ts`, `frame-budget.spec.ts`, `packages/core/src/streaming.ts` doc comment
- [x] TRAA floor spec. proof: `renderer.spec.ts` — 2026-10-11, 43/43 renderer tests; floor 0.61, 30 overloaded windows.
- [x] Slice default documented, observer released. proof: manifest + `frame-budget.spec.ts` — 2026-10-11, 28/28; two dispose calls, one disconnect; 8 ms detail in regenerated manifest.

## Implementation notes (2026-10-11)

- AC-1 timeout fix (2026-10-11): scene-layer root cause was the 1,000,000-byte world budget; `CellChunks.#beginCellProxy` reserves 8 MiB for decoded source plus fixed proxy copies before IO and refused HLOD admission. Raised only the fixture budget to 10,000,000 bytes; camera z=308, ring=0, 180-frame timeout and all proof assertions remain unchanged. Node simulation runs the actual scene with a stub renderer: before the change it failed with `proxy stream timed out`; afterward both cells activate proxies and restore near detail. With proxy submissions withheld it still times out (compiled=1, observed=0, active=0). Runtime-native focused Vitest: 3/3 passed; core `world-cells-data`, `world-cell-proxy`, `world-cells-hlod`: 66/66 passed; scoped Biome passed. No engine or export changes. Web/desktop GPU execution remains pending coordinator; no boxes ticked.
- AC-1: `world-cells-proxy-stream` registers a shared scene that streams cells `0:0` and `2:0`, requires compiled and backend-observed HLOD swaps, restores near detail, and requires a null GPU validation-scope result. Local scene-module and registry contracts: 21/21 passed; registry-related script specs: 21/21 passed; focused Biome and `git diff --check` passed. Web/desktop execution pending coordinator; boxes remain open.
- AC-2: reuse PRD-593's existing `compressed-texture-preparation` registry row and shared scene: public `prepareTextures` uploads one BC1 texture with three mips, returns an `ExternalTexture` replacement used by the rendered material, and preserves original identity, versions, mip references and data. Scene module import passed; `renderer-texture-preparation.spec.ts` + `three-compressed-upload.spec.ts`: 70/70 passed. No duplicate scene; web/desktop execution pending coordinator, boxes remain open.
- AC-3: `virtual-shadow-first-frame` reuses the existing virtual-shadow scene builder. It captures GPU validation from resource creation through the first render and completed queue work, requires shadow stats frame 1 with submitted levels, and rejects absent validation observations or any error (including Destroyed texture). Final registry-related script specs: 21/21 passed; scene-module/registry contracts: 22/22 passed; focused registry-schema specs: 3/3 passed (73 unrelated runner tests skipped); focused Biome and `git diff --check` passed. Web/desktop execution pending coordinator; boxes remain open.
- Local scope: `pnpm install --frozen-lockfile` and the sequential `@threenative/playtest` JS build passed; lockfile unchanged. The broad runner spec was stopped during full-registry dry bundling and replaced by focused schema checks. No browser/native conformance execution or push performed.

2026-10-13 current-host temporal check: the canonical Dawn + V8 v0.3.4 host (SHA256 `59b3ec63dad29db0c1b0938e241064a7846fc63b9171e2d927874e6301f899f9`) completes the selected `temporal-aa` scene with native exit0, a nonuniform 1280x720 frame and no GPU validation errors. The comparison still fails: pixel mismatch0.0817643 exceeds0.06, while perceptual deltaE3.26319 is within9 (`strata-velocity-upload-desktop-current/report.json`, wrapper exit1). This replaces the old cached-host queue-submit panic with a completed comparison, but does not establish native visual acceptance. No tolerance changed; baseline attribution and paired visual proof remain open.

2026-10-13 history-guard attribution: an ignored copy of the exact current temporal bundle with only the scheduled-history skip guard removed completes300 native frames and produces a pixel-identical image to the enabled bundle (mismatch0, deltaE0). Its comparison against the old browser reference fails with exactly the same0.0817643/3.26319 metrics. Source inspection identifies different moving-scene capture phases: browser waits26 rAF callbacks while native captures after300 host frames. The shared entry now prepares26 real moving render/history cycles, freezes the existing resolve and asserts both fixture and held frame26; it preserves native frame count and all tolerances. Parent six focused temporal-velocity tests pass; actual aligned browser/native GPU proof remains pending. This does not yet close the matrix/visual box.

2026-10-13 aligned actual GPU result: the shared temporal entry passes on headed NVIDIA WebGPU and the current Dawn native host, with pixel mismatch0, perceptual deltaE0 and no GPU validation errors (`strata-velocity-held-web/report.json`, `strata-velocity-held-desktop/report.json`). Native exit0 covers300 host frames; the fixture exercises26 moving render/history frames and then holds that resolve, rather than claiming300 moving temporal frames. Wrapper exit2 represents105 unselected blocked rows. Parent focused six tests, syntax, scoped Biome and fresh read-only review pass. Full platform matrix/whole-game visual proof remains open.

2026-10-13 pre381 visual acceptance: virtual shadow and temporal AA each pass four headed NVIDIA1280x720 captures (two per arm); both effects share35 byte-identical common inputs around the exact three changed core-file overlays. Temporal fixture advances26 moving frames before holding the capture pose; still images do not prove motion stability. Atmosphere uses the shipped factory/forest parameters and exact old/current AtmosphereLuts under13 identical common inputs. All four atmosphere captures observe three compute submissions, two completed queue fences, null GPU validation, identical camera/sun/physical/tone/exposure and pixelRatio1 with antialiasing disabled. The initial diagnostic fixture failed before browser on empty registry exclusions; that failure is retained, and the corrected fixture uses all canonical exclusions with the existing full validator. Fresh read-only judgement is NEUTRAL per pair and overall, preserving shadow shading, temporal edges and sky/sun appearance. All12 labelled images are published on [PR483](https://github.com/ThreeNativeHQ/threenative-engine/pull/483), screenshot commit3e3f716710cee4d53857bd9bf2d1c756d277fdc9. No visual improvement, full-parent build, motion-stability or full-platform claim is added. Android follow-up remains open; PRD status stays PARTIAL.

2026-10-13 integrated-host repeat: the freshly built standard V8 host SHA256 `de2d9cf932ed8422b3241756d8361562bf63a53070502aafc3eecebfb83e4242` passes selected desktop `temporal-aa` against the existing aligned browser reference (`artifacts/pr483-pre381-visual/after/run-1`, reference-set SHA256 `12559eb4f6b75b8a64df33736b01e815a6555bc712f944ff2aa459fa71b80264`). Native exit 0, nonuniform 1280×720 capture, pixel mismatch 0, deltaE 0, no GPU validation errors. Report: `packages/runtime-native/artifacts/pr483-temporal-current-host/report.json`; wrapper exit 2 represents 106 unselected rows. This repeats the held-frame proof after develop integration; motion stability, Android and the complete matrix remain open.

2026-10-13 harness/registry tolerance repair (no GPU, no rerun). `virtual-shadow-first-frame` (`conformance/scenes/shared/virtual-shadow-first-frame.js:4`) imports and renders the exact `buildVirtualShadowScene` fixture that `33-virtual-shadow` registered (`conformance/scenes/shared/virtual-shadow.js:21`), so it inherits that row's visual tolerance rather than the strict `.01` default it was registered with. Exact source/capture evidence, BASE develop `5f7143895`, artifact `11860557091`: the base `33-virtual-shadow` capture and the candidate first-frame capture have IDENTICAL metric `0.012477213541666667` and deltaE `0.0056963619722485` (sizes desktop `61538` / web `20307`), and the base `33-virtual-shadow` row passes at `pixelMismatchRatio` `0.08`; BASE has no first-frame case. Changed only the `virtual-shadow-first-frame` registry tolerance: `pixelMismatchRatio` `.01` → `.08`, `perceptualDeltaE` `3.0` unchanged, matching the `33-virtual-shadow` row. New red-first contract `tests/conformance-runner.test.mjs` — "a diagnostic row reusing a scene fixture keeps that scene's visual tolerance" — asserts the two rows share tolerance (RED at `.01`, GREEN at `.08`). The first-frame GPU-submission/completed-work/zero-error assertions stay strict: `tests/virtual-shadow-first-frame.test.mjs` and the scene comparator are unchanged. This is the harness/registry configuration layer, not engine rendering; no browser, GPU, native or full-CI execution was run. Parent review: both focused native test files pass, 78/78 tests; scoped Biome passes with one existing noDelete warning. The direct Node test command first failed on TypeScript module resolution; the repository Vitest configuration supplies the correct loader.

Archived-capture verification: the existing `compareDirectories` comparator, using only the current first-frame registry row and the failed CI web/desktop PNGs, returns one pass, zero failures and zero blocked rows at the unchanged observed metrics. This verifies the corrected image policy against those captures; it is not a new GPU run or native-matrix result.

2026-10-13 repaired first-frame runtime proof: `sh scripts/xvfb.sh node packages/runtime-native/conformance/run-conformance.mjs --target desktop --only-tests virtual-shadow-first-frame --reference /tmp/pr483-parity-failure/conformance/web --out artifacts/pr483-shadow-first-frame-repaired` executes the real case in 13.0 s on clean commit `bd4d1ba5a`, standard V8 host SHA256 `de2d9cf932ed8422b3241756d8361562bf63a53070502aafc3eecebfb83e4242`. Native exit 0, nonuniform 1280×720 image, no GPU validation errors, pixel mismatch `0.03707573784722222` ≤ `0.08`, deltaE `0.016053466032325495` ≤ `3`. Reference-set SHA256 `bb374b87ec7033897e97d4291d47e95721707b601406d9854164df8374b49496` identifies the archived CI browser reference. Report: `packages/runtime-native/artifacts/pr483-shadow-first-frame-repaired/report.json`; wrapper exit 2 denotes 106 deliberately unselected rows, with the selected row passing. No matrix, Android or performance claim.
