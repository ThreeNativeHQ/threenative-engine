# PRD-594 — The engine changes that rode in with #381 get native and visual proof

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: A native conformance case streams two WorldCells cells and swaps a proxy with zero validation errors. proof: `pnpm parity` case in `registry.json` — Evidence: pending.
- [ ] AC-2 [local]: A native conformance case uploads a compressed texture through `prepareTextures`. proof: `pnpm parity` — Evidence: pending.
- [ ] AC-3 [local]: A native conformance case submits a virtual-shadow first frame with no "Destroyed texture" error. proof: `pnpm parity` — Evidence: pending.
- [ ] AC-4 [local]: A fresh visual judge rates the shadow, velocity and LUT changes NEUTRAL or IMPROVEMENT against the pre-#381 parent at fixed poses (headed WebGPU, two runs per arm). proof: judge verdict and images on the PR — Evidence: pending.
- [ ] AC-5 [local]: A TRAA chain holds its `temporalUpscale` floor without the removed lift. proof: `pnpm exec vitest run packages/core/__tests__/renderer.spec.ts` case — Evidence: pending.
- [ ] AC-6 [local]: `addInSlices`' capability detail states the 8 ms default, and `FrameBudget` disconnects its observer on `dispose()`. proof: `pnpm build` manifest diff + `frame-budget.spec.ts` case — Evidence: pending.

## Blocked on

- Android parity for AC-1 to AC-3 needs an emulator run with a hardware GPU mode; start the emulator before declaring this blocked (memory: Android emulator lanes are runnable here).

## Execution Phases

#### Phase 1: native cases
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/registry.json`, conformance fixtures
- [ ] WorldCells stream. proof: `pnpm parity`
- [ ] Texture upload. proof: `pnpm parity`
- [ ] Shadow first frame. proof: `pnpm parity`

#### Phase 2: pixels judged
**Status:** NOT STARTED
- [ ] Judge verdict NEUTRAL or better. proof: PR images + verdict

#### Phase 3: specs and notes
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/renderer.spec.ts`, `frame-budget.spec.ts`, `packages/core/src/streaming.ts` doc comment
- [ ] TRAA floor spec. proof: `renderer.spec.ts`
- [ ] Slice default documented, observer released. proof: manifest + `frame-budget.spec.ts`
