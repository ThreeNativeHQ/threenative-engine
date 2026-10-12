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
  - Local CI wiring proof (2026-10-11): moved `Verify the generated Three.js patch has not drifted` from `budgets` to `build-artifacts`, before workspace-dist cache restore/build/publication, including develop cache warming. `time pnpm --filter @threenative/core patch:generate --check` reports wall cost and preserves failure; the generator throws on download failure and checks the pinned archive hash. CI caches pnpm, not the fresh upstream archive or its npm build. Clean check: `matched`, exit 0, 54.52 s. Appending one newline to the committed base patch: drift rejection, exit 1, 58.84 s; `git checkout -- packages/core/patches/three@0.185.1.patch` restored it byte-for-byte. Both patches and the generator select the required build job without impact-map or receipt changes. The new placement contract failed before the move and passed afterward; all 12 specs found by `rg -l "ci.yml" scripts/__tests__` passed (458 tests, 20.46 s), including structure, needs, selection and integration receipts. `pnpm check:docs` passed; scoped Biome passed with three existing complexity warnings. AC-2 and the Phase 1 CI box remain unticked pending a real CI run link; no push.
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
- [x] AC-4 [local]: Each remaining hunk (depth cache, 3D guard, bind-group invalidation) has a spec that fails without it. proof: `three-patch-retained.spec.ts` on 2026-10-11 — depth cache red 1 failed/green 1 passed; 3D attachment guard red 1 failed/green 1 passed; bind-group invalidation red 1 failed/green 1 passed. Stock source hashes verified; requested suite passes 106/106.
- [x] AC-5 [local]: The `updateTexture` wrapper costs under 0.05 ms per frame on machinefall. proof: `TN_FRAME_SPANS` A/B, two runs per arm — Evidence (2026-10-11): the wrapper no longer exists, so it costs 0 ms per frame by construction and there is nothing left to A/B. `1b6b0f593` deleted it with the upload lane, because only that lane wrote `_pendingUploads` and `uploadError`. `three-compressed-upload.spec.ts` fails if `updateTextureAsync`, `_uploadTail`, `_pendingUploads` or `uploadError` reappear in the generated patches or the installed three build (106 of 106 core patch and upload specs pass at `c92f8c98a`). No `TN_FRAME_SPANS` run was made.

## Execution Phases

#### Phase 1: generated patches
**Status:** PARTIAL
**Files:** `packages/core/scripts/generate-three-patch.mjs` (new), `packages/core/package.json`, `.github/workflows/ci.yml`
- [x] Regeneration matches. proof: default `pnpm --filter @threenative/core patch:generate && git diff --exit-code packages/core/patches` passed after commit; a separate fresh build with `--check` printed `matched`. Both artifact sha256 unchanged (base `ac74287d…170`, upgrade `721e99cd…e36`).
- [ ] CI drift check. proof: CI run link — step wired in `ci.yml` in `build-artifacts`; local hand-edit rejection proved on 2026-10-11, real CI run link pending.

#### Phase 2: upload lane out of the patch
**Status:** NOT STARTED
**Files:** `packages/core/src/renderer.ts`, `packages/core/src/render/texture-upload.ts` (new), patch source tree
- [ ] Upload works without patch hunks. proof: spec + WebGPU playtest

#### Phase 3: remaining hunks proven
**Status:** NOT STARTED
- [x] One failing-without spec per hunk. proof: `three-patch-retained.spec.ts`, 2026-10-11: stock red 3 failed/0 passed (depth, 3D guard, bind-group invalidation each 1 failed); patched green 3 passed/0 failed (each 1 passed).
- [x] Wrapper cost measured. proof: `TN_FRAME_SPANS` A/B — 2026-10-11: the wrapper was deleted in `1b6b0f593`, so the cost is 0 ms by construction; the absence guard in `three-compressed-upload.spec.ts` keeps it out. No A/B run was needed.

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

- **2026-10-11 — installer predecessor and deletion classification repaired.** The frozen Phase 1
  generated patch at `9d917a551` hashes to `ac74287d…e170`; `develop` and `2d2124792` hash to
  `f3c6b1fc…227f`, so these are different artifacts. The existing legacy finals retain the develop
  state; the pin's compat registry now also accepts the two Phase 1 generated bundle target hashes.
  Regeneration carries those acceptances into the upgrade JSON. Exact version/commit, path-set and
  target-payload hash checks are unchanged. Deletion-only hunks now prefer a matching complete old
  text over their new context, which can already occur in stock `src/nodes/accessors/Batch.js`.
  Two new regression specs observed red 2 failed/0 passed before the fix and green 2 passed/0 failed
  afterward; the complete compat/upgrade specs pass 33/33. A frozen compressed patch fixture
  reconstructs the pinned stock and old generated state, checking each old and new target hash.
  End-to-end commands: `git show 9d917a551:packages/core/patches/three@0.185.1.patch` saved to
  `/tmp/prd593-old.patch`; save the current patch to `/tmp/prd593-new.patch`; in the resolved installed
  Three.js root run `patch --reverse --batch --fuzz=0 --silent -p1 -i /tmp/prd593-new.patch` then
  `patch --batch --fuzz=0 --silent -p1 -i /tmp/prd593-old.patch`; from this checkout run
  `node packages/core/scripts/apply-three-patch.mjs`. All 30 old target hashes matched before apply,
  the script reported `patched`, and all 30 new target hashes matched afterward. Core typecheck
  exits 0. No lockfile, dependency, browser, GPU or native changes/runs; no push.

- **2026-10-11 — AC-4 retained hunk proofs.** `three-patch-retained.spec.ts` loads the actual
  installed source for `WebGPUTextureUtils.js` and `Textures.js` into an isolated temp tree.
  `TN_THREE_PATCH_STOCK=1 pnpm exec vitest run packages/core/__tests__/three-patch-retained.spec.ts`
  reverses those files' complete patch sections at zero fuzz and verifies both pinned stock Git
  blob hashes before loading them. Observed red: depth cache 1 failed (4 -> 1 -> 4 reallocates),
  3D guard 1 failed (usage 23 instead of 7), bind-group invalidation 1 failed (stale groups and
  versions still present at recreation). Observed patched green: each 1 passed, total 3/3.
  The depth test also verifies both buffers are destroyed on resize; the 3D test preserves the
  mipmap attachment override; invalidation retains unrelated data and covers two bind groups.
  The committed patch was not edited for negative controls. The first combined run timed out
  copying the complete src tree; copying only the two observed files removed that setup cost.
  Final requested five-spec suite: 106 passed/0 failed (24 upgrade, 9 compat, 3 retained,
  1 compressed-upload removal, 69 public preparation). Generator `--check` prints `matched`.
  Core typecheck exits 0. Scoped Biome exits 0 with two existing installer complexity warnings
  (`parseUpgradeJson` 64 and `planPatch` 20). Only AC-4 and its Phase 3 hunk-proof box are ticked;
  all other pending criteria remain open. No browser, GPU, native or push run.

2026-10-10 EPIC integration: parent reviewed the generator, bounded upgrade reader, frozen predecessor fixture and CI wiring. The lockfile delta is exactly 56 substitutions of the patch hash, with no other changes. Parent frozen install passed with the merged lock unchanged; the three focused patch specs passed 42 tests in 7.50 s, including all 31 legacy predecessors and all 30 previously shipped finals. A fresh default `pnpm --filter @threenative/core patch:generate --check` downloaded and built the pinned upstream and reported `matched`. CI structure/needs contracts passed 213 tests in 8.68 s. Actual CI, hand-edit rejection, upload migration, runtime/visual proof and wrapper cost remain open.

Scaffold drift closure: the first parent pre-push gate passed 331 tests but rejected the stale thirteen-tree fingerprints. Restoring only the previous shared Three patch and capability manifest/reference bytes recovered every old fingerprint in the actual `createProject` test. The observed current fingerprints were then recorded, and the unchanged full-tree assertion passed for all thirteen templates (1 selected test, 67 unselected; 1.63 s). No template source or hash exclusion changed.

2026-10-10 hand-edit rejection proof: parent copied the committed pin, source delta and patch artifacts to an ignored isolated directory, appended a hand-edited line to its base patch, and ran the real generator with `check: true`. A fresh pinned upstream download/build rejected the altered artifact with `check failed, generated patch drifts from the committed patch`. The checkout patch remained byte-identical. This closes the local negative case; AC-2 remains open for actual CI execution.

2026-10-12 correction to the "patch still contains the upload-lane hunks" line under AC-3: the upload-lane hunks were removed in `1b6b0f593`, and the 3D guard and depth-cache hunks that remain are covered by `three-patch-retained.spec.ts`. Re-run today: `three-compressed-upload.spec.ts` (1 test) and `three-patch-retained.spec.ts` (3 tests) pass, 4 of 4. A token check of the committed patch finds none of the forbidden upload-lane tokens. AC-3 and the Phase 2 box stay unticked because their proof also names a WebGPU playtest of the preview, and the preview's web lane is currently red on the three PRD-585 perf budgets (the 59 of 62 passing assertions include no compressed-upload check that isolates this change). The uploader the PRD calls `texture-upload.ts` is `CompressedTextureUploads` at `packages/core/src/compressed-texture-preparation.ts`.
