# PRD-806 — Fix the medium and low findings of the PR #483 epic review

**Status:** PROPOSED — the 14 medium findings (13 after one duplicate) and 45 low findings verified on HEAD `21c713b7d` on 2026-11-05. The high findings are in [PRD-805](../../done/PRD-805-epic-review-findings.md). No fix has started.
**Priority:** P2 — each open finding below is a real defect, and none makes the board red at HEAD
**Complexity:** 5 (MEDIUM); many small fixes in independent files
**Owner:** ThreeNative maintainers

## Problem

The per-finding facts, the cited `file:line` and a one-line fix sketch are in [the evidence file](PRD-805-epic-review-findings.evidence.md). The verifier was a DeepSeek arm, so read each cited line before you fix it. Each fix gets a red-green spec. A fix that changes what reaches the screen (E46, E56, E73) also needs the visual judge.

## Execution Phases

#### Phase 1: Engine and asset pipeline

- [ ] E09 and E11 `packages/assets/src/compile.ts`: the pre-scan fails odd GLBs even with `models: "none"` (:339), and the terrain-world cache key ignores `PIPELINE_VERSION` (:584). proof: red-green specs in `packages/assets/__tests__/`
- [ ] E46 `packages/assets/src/lod/generate.ts:982`: scaled far cards clamp at the quantized POSITION bounds. proof: a red-green spec in `packages/assets/__tests__/`
- [ ] E49 `packages/runtime-native/src/engine/scene/texture.h:138`: a Texture copy copies its listeners. proof: a red-green case in the engine texture test
- [ ] E73 `packages/runtime-native/src/engine/renderer/renderer.cpp:4999`: the custom MRT slot of a `depthWrite=false` draw is not written at 1x. proof: a red-green case in the engine renderer test

#### Phase 2: Game, editor and scripts

- [ ] E17 and E29 (Strata example): a prop restream cancels the in-flight terrain update (`src/render/editorView.ts:251`), and the status line lost `role=status` and `aria-live` (`src/render/selection.ts:57`). proof: red-green specs in `examples/strata-terrain-preview/__tests__/`
- [ ] E39, E40 and E41 (terrain editor): the ortho extent subtracts `target[0]` from every axis (`cameras.ts:185`), the picker shows `assets[0]` but scatter paints `"pine"` (`tools.ts:112`), and the CSS ids do not match the camera rows (`cameras.ts:158`). proof: red-green specs in `packages/terrain/__tests__/`
- [ ] E52 and E59 (one finding) `scripts/ci-runner-admission.mjs:82`: rain goes to the GPU runner but is admitted as a CPU slot. proof: a red-green spec in `scripts/__tests__/`
- [ ] E56 and E62 (terrain package): `bendCrownNormals` is not idempotent (`starter/forest/world.ts:154`), and the matrix pins 35 empty worlds as success (`__tests__/terrain-mcp.spec.ts:1173`). proof: `pnpm exec vitest run packages/terrain/__tests__/`

#### Phase 3: The 45 low findings

- [ ] Fix or reject each REAL low finding in the evidence file, with the reason beside each rejection. proof: one line per finding in this box

## Acceptance Criteria

- [ ] AC-1: `pnpm typecheck` and `pnpm lint` exit 0 after the fixes. proof: command output in the box
