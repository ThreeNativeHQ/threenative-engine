# PRD-806 — Fix the medium and low findings of the PR #483 epic review

**Status:** PARTIAL — 6 of 8 Phase 1 and 2 boxes are fixed (E46 and E73 added on PR #635, 2026-11-08). Open: E56/E62 (E56 fixed, E62 waits for an MCP-cooked world judge), and the 45 low findings. Scope: the 14 medium findings (13 after one duplicate) and 45 low findings verified on HEAD `21c713b7d` on 2026-11-05. The high findings are in [PRD-805](../../done/PRD-805-epic-review-findings.md).
**Priority:** P2 — each open finding below is a real defect, and none makes the board red at HEAD
**Complexity:** 5 (MEDIUM); many small fixes in independent files
**Owner:** ThreeNative maintainers

## Problem

The per-finding facts, the cited `file:line` and a one-line fix sketch are in [the evidence file](PRD-805-epic-review-findings.evidence.md). The verifier was a DeepSeek arm, so read each cited line before you fix it. Each fix gets a red-green spec. A fix that changes what reaches the screen (E46, E56, E73) also needs the visual judge.

## Execution Phases

#### Phase 1: Engine and asset pipeline

- [x] E09 and E11 `packages/assets/src/compile.ts`: the pre-scan fails odd GLBs even with `models: "none"` (:339), and the terrain-world cache key ignores `PIPELINE_VERSION` (:584). proof: red-green specs in `packages/assets/__tests__/` — FIXED 2026-11-05: E09 in `32bcc9244`, E11 in `f6bd216f6` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after). `packages/assets/__tests__` 55 files, 868 tests pass.
- [x] E46 `packages/assets/src/lod/generate.ts:982`: scaled far cards clamp at the quantized POSITION bounds. proof: a red-green spec in `packages/assets/__tests__/` — FIXED 2026-11-07 on PR #635 (`5ba984939`, from `c2a06bdfc`): `card-copies-quantized.spec.ts` 1 failed without the fix, passes with it. The forest golden `world.glb` hash moves with it (`9000247e1`); the 25 MiB budget holds. Visual judge (headed WebGPU, RTX 2080, upstream three build, 2 runs per arm, 5 worlds): NEUTRAL, no visible change at the capture poses; the alpine shadow difference is run-to-run flake (see E73).
- [x] E49 `packages/runtime-native/src/engine/scene/texture.h:138`: a Texture copy copies its listeners. proof: a red-green case in the engine texture test — FIXED (`7d9510f88`, carried into PR #635). 2026-11-09, engine-only V8 player build (`-DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DMYSTRAL_USE_V8=ON`): `tn-native-engine-v8-textures-test clone_listeners` FAILS with the copy constructor defaulted (`v8_textures_test.cpp:135` `clone->languageListeners == nullptr`, `:137` `fired == 1`) and PASSES with the fix; `half_float` passes.
- [x] E73 `packages/runtime-native/src/engine/renderer/renderer.cpp:4999`: the custom MRT slot of a `depthWrite=false` draw is not written at 1x. proof: a red-green case in the engine renderer test — FIXED 2026-11-08 on PR #635 (`8c1c9695d`): native `attachment-mask` 3/3, `pnpm wasm:build` 0; owned-engine judge (`TN_ENGINE=threenative`, headed WebGPU, RTX 2080, 2 runs per arm, 5 worlds × 4 poses) NEUTRAL, no lost shadow, halo or colour shift.
  History: the fix is on PR #635 (`460f9e5a4`; reverted in `d55471289` and restored in `8c1c9695d`). The Wasm build compiles it (`pnpm wasm:build` exit 0), and the native `attachment-mask` test passes 3/3. The first judge called the alpine boulder shadows lost and blamed E73. That was wrong: the preview's `build` ships upstream three unless `TN_ENGINE=threenative` is set (`examples/strata-terrain-preview/vite.config.ts:129`), so those frames never ran the C++ engine. Two more runs of one unchanged build showed the long boulder shadows in one run and not in the other: the shadow presence at the capture pose is run-to-run flake.

#### Phase 2: Game, editor and scripts

- [x] E17 and E29 (Strata example): a prop restream cancels the in-flight terrain update (`src/render/editorView.ts:251`), and the status line lost `role=status` and `aria-live` (`src/render/selection.ts:57`). proof: red-green specs in `examples/strata-terrain-preview/__tests__/` — E17 FIXED 2026-11-05 in `32829237d` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after): the drag restream and the terrain update now supersede only their own lane. E29 NOT-REAL: the epic moved every announcement into the single `#editor-announcements` live region on purpose, so the status line needs no own live region.
- [x] E39, E40 and E41 (terrain editor): the ortho extent subtracts `target[0]` from every axis (`cameras.ts:185`), the picker shows `assets[0]` but scatter paints `"pine"` (`tools.ts:112`), and the CSS ids do not match the camera rows (`cameras.ts:158`). proof: red-green specs in `packages/terrain/__tests__/` — FIXED 2026-11-05: E39 in `5b2d7cfdb`, E40 in `1695544a6`, E41 in `5ab0ba340` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after).
- [x] E52 and E59 (one finding) `scripts/ci-runner-admission.mjs:82`: rain goes to the GPU runner but is admitted as a CPU slot. proof: a red-green spec in `scripts/__tests__/` — FIXED 2026-11-05 in `6c526a522` (DeepSeek arm, reviewed; red at `b1e89ac2a`, green after). The `ci-*` script specs pass: 24 files, 838 tests.
- [ ] E56 and E62 (terrain package): `bendCrownNormals` is not idempotent (`starter/forest/world.ts:154`), and the matrix pins 35 empty worlds as success (`__tests__/terrain-mcp.spec.ts:1173`). proof: `pnpm exec vitest run packages/terrain/__tests__/`
  Open: E56 FIXED 2026-11-07 on PR #635 (`b8f6c9db0`): `forest-crown-normals.spec.ts` 1 failed without the fix, passes with it; the five preview worlds judge NEUTRAL (upstream three build). E62 is on PR #635 (`b41bfaa61`) and `packages/terrain/__tests__/` passes 531/531, but it changes what a landform cook draws (firs on forest and coastal presets), so the box waits for the judge on an MCP-cooked world (PRD-762 Phase 3 frames).

#### Phase 3: The 45 low findings

- [ ] Fix or reject each REAL low finding in the evidence file, with the reason beside each rejection. proof: one line per finding in this box

## Acceptance Criteria

- [ ] AC-1: `pnpm typecheck` and `pnpm lint` exit 0 after the fixes. proof: command output in the box
