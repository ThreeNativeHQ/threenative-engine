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
