# PRD-593 — The three.js patch is generated, and the upload lane leaves it

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: One command regenerates both patch files, and the result equals the committed files. proof: `pnpm --filter @threenative/core patch:generate && git diff --exit-code packages/core/patches` — Evidence: pending.
- [ ] AC-2 [shared]: CI fails when a patch file is edited by hand. proof: CI job step in `ci.yml` — Evidence: pending.
- [ ] AC-3 [local]: `prepareTextures` uploads compressed textures with the patch's upload-lane hunks removed. proof: `pnpm exec vitest run packages/core/__tests__/three-compressed-upload.spec.ts` plus a WebGPU playtest of the strata preview — Evidence: pending.
- [ ] AC-4 [local]: Each remaining hunk (depth cache, 3D guard, bind-group invalidation) has a spec that fails without it. proof: `pnpm exec vitest run packages/core/__tests__/three-patch-*.spec.ts` — Evidence: pending.
- [ ] AC-5 [local]: The `updateTexture` wrapper costs under 0.05 ms per frame on machinefall. proof: `TN_FRAME_SPANS` A/B, two runs per arm — Evidence: pending.

## Execution Phases

#### Phase 1: generated patches
**Status:** NOT STARTED
**Files:** `packages/core/scripts/generate-three-patch.mjs` (new), `packages/core/package.json`, `.github/workflows/ci.yml`
- [ ] Regeneration matches. proof: generate + `git diff --exit-code`
- [ ] CI drift check. proof: CI run link

#### Phase 2: upload lane out of the patch
**Status:** NOT STARTED
**Files:** `packages/core/src/renderer.ts`, `packages/core/src/render/texture-upload.ts` (new), patch source tree
- [ ] Upload works without patch hunks. proof: spec + WebGPU playtest

#### Phase 3: remaining hunks proven
**Status:** NOT STARTED
- [ ] One failing-without spec per hunk. proof: `three-patch-*.spec.ts`
- [ ] Wrapper cost measured. proof: `TN_FRAME_SPANS` A/B
