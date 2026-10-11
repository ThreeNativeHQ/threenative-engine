# PRD-593 — The three.js patch is generated, and the upload lane leaves it

**Status:** PARTIAL
**Priority:** P1 — #381 grew the hand-maintained three patches by about 11 000 lines on private three internals, so any three upgrade can silently break texture upload for every game (AC-1 to AC-4).
**Complexity:** 6 (MEDIUM); risk override: compatibility — a wrong patch breaks every game's renderer
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Core audit of `2d2124792` (2026-10-10):

- `packages/core/patches/three@0.185.1.patch` grew +630/−120 lines and
  `three@0.185.1-prd269-upgrade.patch` grew from 5 620 to 15 838 lines. Each change appears up to
  six times (`src/*`, `build/three.webgpu.js`, `build/three.webgpu.nodes.js`, in both files).
  `packages/core/scripts/apply-three-patch.mjs` stacks them; no script generates them.
- The patch adds a bounded async compressed-texture upload lane (`Textures.js` +119,
  `WebGPUTextureUtils.js` +147: `updateTextureAsync`, a promise queue, an `AbortController` per
  texture, 2 ms and 64 KiB budgets), exposed as `prepareTextures` in `packages/core/src/renderer.ts`.
  It reads private `_textures`, `_uploadTail` and `backend.get(texture).texture`.
- It also adds, for every game: a `_depthBuffers` cache per sample count, a 3D-texture
  attachment guard for wgpu-native, bind-group invalidation on texture destroy, and an
  `updateTexture` wrapper that checks `_pendingUploads` and `uploadError` on each call. Its
  per-frame cost is unmeasured.
- Owner rule (memory "three patch last resort"): patching three is the last resort.

## Solution

1. Add a generator: a pinned three checkout plus a patched `src` tree regenerates both patch files;
   the compiled-build hunks come from three's own build. CI fails when the generated patch differs
   from the committed one.
2. Move the upload lane out of the patch: core creates the `GPUTexture` and writes mips with
   `device.queue.writeTexture` on its own budget, then hands the texture to three through a
   documented seam. If no seam exists, file the upstream issue and record the retire condition in
   the patch header.
3. Split the remaining additions into named hunks with one red-green spec each, and measure the
   `updateTexture` wrapper's per-frame cost.

## Acceptance Criteria

- [x] AC-1 [local]: One command regenerates both patch files, and the result equals the committed files. proof: `pnpm --filter @threenative/core patch:generate && git diff --exit-code packages/core/patches` — Evidence: passed after commit on 2026-10-10, including default pinned upstream download and own build; both artifacts unchanged. A separate fresh `--check` build also printed `matched`.
- [ ] AC-2 [shared]: CI fails when a patch file is edited by hand. proof: CI job step in `ci.yml` — Evidence: pending.
- [ ] AC-3 [local]: `prepareTextures` uploads compressed textures with the patch's upload-lane hunks removed. proof: `pnpm exec vitest run packages/core/__tests__/three-compressed-upload.spec.ts` plus a WebGPU playtest of the strata preview — Evidence: pending.
  - Open: AC-3 and the Phase 2 box stay unticked. The patch still contains the upload-lane hunks. This PRD stays open.
  - Public proof (2026-10-11): `renderer-texture-preparation.spec.ts` passes 43 of 43 tests. The spec now has 35 existing tests and 8 added tests.
  - Guards: the planner rejects a mip whose size is not the halved base, and a mip chain longer than the base allows. Both checks run before any GPU allocation.
  - The write step rejects an unaligned base unless the device reports `texture-compression-unaligned`. The check runs before `createTexture`.
  - Cancellation: a public test rejects a cancelled caller at once and starts the next allocation after every popped scope settles. It passes.
  - Legacy proof: `three-compressed-upload.spec.ts` passes 102 of 102 tests. It drives three's internal `Renderer`, `Textures`, and `WebGPUTextureUtils` modules. The patched upload lane is in `Textures.js`. Together, both specs pass 145 of 145.
  - Gates: core typecheck exits 0. Scoped Biome exits 0 with three complexity warnings: `planCompressedUpload` (33), `upload` (21), and `writeTiles` (25), limit 15. `git diff --check` exits 0, and the untracked helper has no whitespace findings.
  - Earlier work stays in place: source isolation, device and lifetime ownership, and the error-scope drain. A synchronous `check` or `writeTexture` throw now waits for every popped error scope before the lane advances.
  - Depth guard (2026-10-11): `compressedLayers` rejects a 2D `CompressedTexture` whose `image.depth` is above 1, before any GPU allocation. In installed three 0.185.1, `CompressedArrayTexture` sets `image.depth`. `CompressedTexture` sets `image` to `{ width, height }` only.
  - `renderer-texture-preparation.spec.ts` passes 49 of 49 tests, up from 43. Six tests were added. Only the 2D rejection failed before the guard: `promise resolved "1" instead of rejecting`. The other five pass before and after, so they pin existing behavior. Surplus layer data stays accepted: three depth tests start with four layers at depth three.
  - Legacy `three-compressed-upload.spec.ts` passes 102 of 102. Core typecheck exits 0. Scoped Biome exits 0 with the same three complexity warnings. `git diff --check` exits 0 for the spec, and `git diff --no-index --check` prints nothing for the helper. These are mock-device unit results only. No browser, native, visual, or perf run.
  - Binding state (2026-10-11): `snapshotOf` compares the binding fields `Texture.copy` carries, except `name` and `userData`, plus `wrapR` and `compareFunction` when present, `source.dataReady`, and matrix elements as numbers. A changed binding starts a new upload. The cached prepared texture stays until that upload commits.
  - Binding proof: `renderer-texture-preparation.spec.ts` passes 59 of 59 tests. Before this change, 10 binding tests failed and 49 passed. `three-compressed-upload.spec.ts` passes 102 of 102 tests. Core typecheck exits 0. Scoped Biome exits 0 with the same three complexity warnings. `git diff --check` exits 0, and the untracked helper prints no whitespace findings. These are mock-device unit results only.
  - Depth guard, tightened (2026-10-11): a 2D texture accepts only `image.depth` of `undefined` or `1`. Before the change, six new cases failed because the old guard let each value through: `NaN`, `0`, `-1`, `-Infinity`, `0.5`, and `null`. The first failure reported `promise resolved "1" instead of rejecting`. `Infinity` and `1.5` already rejected. Invalid values now get a message that does not name an array class.
  - Gates (2026-10-11): `renderer-texture-preparation.spec.ts` passes 69 of 69. `three-compressed-upload.spec.ts` passes 102 of 102. Core typecheck exits 0. Scoped Biome exits 0 with the same three complexity warnings. `git diff --check` exits 0 for the spec, and `git diff --no-index --check` prints nothing for the helper. These are mock-device unit results only. AC-3 stays open.
  - Remaining proof: native, browser, visual, perf, and patch. AC-3 needs a WebGPU playtest of the strata preview, and the patch hunks removed, before it can be ticked.
  - Native proof, first run (2026-10-11): the selected desktop row failed on the stale wgpu host `build/tn-linux-wgpu/mystral` (v0.3.0, built 2026-08-27, sha256 `b7563826…ce23e`). The full host stdout shows the cause: `[ThreeNative conformance] failed: Error: Device lost during texture preparation.` A probe script on that host shows `device.lost` resolves at once with `undefined`. That host predates the #381 fix in `src/webgpu/bindings.cpp`, which keeps `device.lost` pending. The EGL vendor file was not the cause: the host acquired the RTX 2080 on Vulkan.
  - Native proof, current host (2026-10-11): `pnpm native:build` in this checkout built the default Dawn + V8 host `build/tn-linux/mystral` (v0.3.4, sha256 `3377038a…71fadb`) in 5 min 18 s. The selected desktop row `compressed-texture-preparation` passed twice: 22.5 s and 14.4 s. Adapter: `NVIDIA GeForce RTX 2080`, backend Vulkan. `native.completed` is true and `gpuValidationErrors` is empty. The 1280x720 screenshot shows a green upper half and a red lower half on a dark background, which matches the approved web image. The runner exits 2 because 103 unselected rows report `blocked`, so this is not a full-board pass.
  - WEB headed setting: `packages/runtime-native/conformance/run-conformance.mjs:807` sets `headless: false`.
  - AC-3 stays open. Web and native now pass for the public helper, but the patch still contains the upload-lane hunks, and the strata preview WebGPU playtest has not run without them.
  - Upload patch removal (2026-10-11): removed the private `Renderer.prepareTextureAsync` and backend delegation, `Textures.updateTextureAsync`, its serialized promise queue, per-texture abort/loss/disposal handling, and the bounded 2 ms / 64 KiB uploader in `WebGPUTextureUtils`. Removed the `updateTexture` wrapper and its async-only helpers: only `updateTextureAsync` populated `_pendingUploads` and wrote `data.uploadError`, so both wrapper checks belonged exclusively to that lane. Retained bind-group invalidation on texture destroy, the per-sample-count `_depthBuffers` cache, the wgpu-native 3D attachment guard, and all unrelated hunks. Core `prepareTextures` already routed exclusively through `CompressedTextureUploads`; removed its dead private-method declaration and private-method test doubles, preserving the three-argument `Promise<number>` contract and optional fourth replacement map.
    Both patches were regenerated only with `pnpm --filter @threenative/core patch:generate`; a second fresh build with `--check` printed `matched`. `wc -l` before/after: base 6,221 -> 5,048; upgrade 230 -> 230; total 6,451 -> 5,278. Installed Three.js matches all 30 generated target hashes, and grep found no `updateTextureAsync` or `_uploadTail` in either installed WebGPU bundle. The replacement guard checks both generated artifacts, the decompressed upgrade payload, and installed source/bundles; it failed against the old lane before removal and passes afterward.
    Focused suite passed 104/104 (previously 205/205): `renderer-texture-preparation.spec.ts` 69 -> 69, `three-compressed-upload.spec.ts` 102 -> 1, `three-patch-compat.spec.ts` 9 -> 9, `three-patch-upgrade.spec.ts` 22 -> 22, and terrain `prop-texture-preparation.spec.ts` 3 -> 3. Removed all 102 tests of the obsolete private manager/uploader lifecycle and synchronous private baseline; public upload behavior reuses the existing 69-test spec, including real transcoded mip data. The compatibility expectation now accepts an unchanged predecessor when removing the upload method makes its hash identical to the generated target. Core typecheck and build exit 0; scoped Biome exits 0 with seven existing renderer complexity warnings.
    Reapplication exposed two installer limitations: the Phase 1 generated bundle hashes are not registered predecessors, and stock `Batch.js` is misclassified because its deletion-only trailing-blank hunk's new text already occurs in stock. Verified every installed Phase 1 hash, reversed that exact patch to stock, applied the new generated patch with standard `patch` at zero fuzz, and verified all target hashes; the repository apply script then reported unchanged. These installer limitations remain open. No browser, GPU, native, visual, or performance run was performed here; the coordinator owns those runs. AC-3 and Phase 2 stay unticked.
  - After hunk removal (2026-10-11, `1b6b0f593`): the selected conformance row `compressed-texture-preparation` passed on web (headed, adapter `nvidia`/`turing`, 3.4 s, no page or GPU validation errors) and on the desktop Dawn host (30.2 s, `native.completed` true, no GPU validation errors). The two screenshots match: green upper half, red lower half. The other 103 rows report `blocked`.
  - Strata preview WebGPU playtest after hunk removal (2026-10-11): `terrain.playtest.json`, headed, `--browser-recipe webgpu`, adapter `nvidia`/`turing`, ran to completion in 16 min 23 s with `--server-timeout 600000 --timeout 120000` (the default 15 s limits expired during the cold bake and the first Vite transform). Result: 59 of 62 assertions pass and the scenario fails. The three failures are the runtime budgets that PRD-585 already records as failing on this host: `afterFirstFrameTaskMs` up to 9 685 ms (limit 250), `timeToReadyMs` (limit 15 000) and `maxViewGpuMs` up to 62.09 ms (limit 12). The console, network and runtime-diagnostic policies pass. Captures of all five kits show textured bark, foliage, grass, rock and sand. AC-3 stays open until the preview passes as a whole.
- [ ] AC-4 [local]: Each remaining hunk (depth cache, 3D guard, bind-group invalidation) has a spec that fails without it. proof: `pnpm exec vitest run packages/core/__tests__/three-patch-*.spec.ts` — Evidence: pending.
- [ ] AC-5 [local]: The `updateTexture` wrapper costs under 0.05 ms per frame on machinefall. proof: `TN_FRAME_SPANS` A/B, two runs per arm — Evidence: pending.

## Execution Phases

#### Phase 1: generated patches
**Status:** PARTIAL
**Files:** `packages/core/scripts/generate-three-patch.mjs` (new), `packages/core/package.json`, `.github/workflows/ci.yml`
- [x] Regeneration matches. proof: default `pnpm --filter @threenative/core patch:generate && git diff --exit-code packages/core/patches` passed after commit; a separate fresh build with `--check` printed `matched`. Both artifact sha256 unchanged (base `ac74287d…170`, upgrade `721e99cd…e36`).
- [ ] CI drift check. proof: CI run link — step wired in `ci.yml`; draft CI run OPEN, not ticked.

#### Phase 2: upload lane out of the patch
**Status:** NOT STARTED
**Files:** `packages/core/src/renderer.ts`, `packages/core/src/render/texture-upload.ts` (new), patch source tree
- [ ] Upload works without patch hunks. proof: spec + WebGPU playtest

#### Phase 3: remaining hunks proven
**Status:** NOT STARTED
- [ ] One failing-without spec per hunk. proof: `three-patch-*.spec.ts`
- [ ] Wrapper cost measured. proof: `TN_FRAME_SPANS` A/B

## Decisions

- **2026-10-10 — old compiled byte identity is disproven.** The 16 uncovered source preimages are
  moot: all 31 exact legacy acceptances are preserved and verified, and every generated target is
  pinned solely to the source delta plus the upstream own build. The version-2 upgrade JSON format
  is intentional.
- **2026-10-10 — reader hardened at the trust boundary.** `apply-three-patch.mjs` now rejects a pin
  that is not exactly three `0.185.1` / `2431a09f…d5b9`, rejects generated/final/payload/compat path
  sets that do not agree with the base patch, and refuses a stock hunk whose applied text does not
  hash to the patch index blob. `three-patch-compat.spec.ts` adds one red test per failure; the
  focused suite is 42 tests (9 compat + 22 upgrade + 11 generator), all green.
- **2026-10-10 — exact lock hash closure.** `pnpm-lock.yaml` had 56 old base-patch sha256 literals
  (`f3c6b1fc…`); they are replaced by the new base sha256 (`ac74287d…`) with no version, importer or
  format change. The offline attempt lacked the `threejs-procedural-animals` codeload tarball.
  The authorized online `pnpm install --frozen-lockfile` then passed in 5.1 seconds and restored
  dependencies without changing the lockfile sha256 (`2a680c32…dc4`). All 42 focused tests passed
  again after installation. Generated unified-diff payloads retain upstream whitespace.

2026-10-10 EPIC integration: parent reviewed the generator, bounded upgrade reader, frozen predecessor fixture and CI wiring. The lockfile delta is exactly 56 substitutions of the patch hash, with no other changes. Parent frozen install passed with the merged lock unchanged; the three focused patch specs passed 42 tests in 7.50 s, including all 31 legacy predecessors and all 30 previously shipped finals. A fresh default `pnpm --filter @threenative/core patch:generate --check` downloaded and built the pinned upstream and reported `matched`. CI structure/needs contracts passed 213 tests in 8.68 s. Actual CI, hand-edit rejection, upload migration, runtime/visual proof and wrapper cost remain open.

Scaffold drift closure: the first parent pre-push gate passed 331 tests but rejected the stale thirteen-tree fingerprints. Restoring only the previous shared Three patch and capability manifest/reference bytes recovered every old fingerprint in the actual `createProject` test. The observed current fingerprints were then recorded, and the unchanged full-tree assertion passed for all thirteen templates (1 selected test, 67 unselected; 1.63 s). No template source or hash exclusion changed.

2026-10-10 hand-edit rejection proof: parent copied the committed pin, source delta and patch artifacts to an ignored isolated directory, appended a hand-edited line to its base patch, and ran the real generator with `check: true`. A fresh pinned upstream download/build rejected the altered artifact with `check failed, generated patch drifts from the committed patch`. The checkout patch remained byte-identical. This closes the local negative case; AC-2 remains open for actual CI execution.
