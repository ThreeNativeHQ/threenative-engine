# PRD-491 — Water and atmosphere run native

**Status:** PROPOSED
**Priority:** P1 — Web-only gap open: SpectralOcean and atmosphere LUTs have no native conformance rows.
**Complexity:** 3 (LOW) — 1–5 implementation files (+1); a failing case may need a fix in the C++ host (+2); risk override: none
**Owner:** João
**Depends on:** None

## Context

The charter says web-only is unfinished: a helper that was admitted because it cannot be written portably has to ship native proof. Four such helpers have none. `packages/runtime-native/conformance/registry.json` (95 rows) has no row for any of them:

| Helper | File | What native has never executed |
| --- | --- | --- |
| `SpectralOcean` | `packages/core/src/ocean/spectral.ts` | cascaded FFT compute and the throttled height readback. [PRD-246](../done/PRD-246-two-oceans-two-contracts.md) says "native desktop conformance (Phase 1's case was not added)" and claims web only |
| `WaterSurface3D` | `packages/core/src/water-surface.ts` | `reflector`, `viewportSharedTexture` and `viewportDepthTexture`. No conformance scene uses any of the three |
| `Atmosphere` / `AtmosphereLuts` | `packages/core/src/atmosphere/` | three compute LUT bakes into `HalfFloatType` `StorageTexture`s via `textureStore`. [PRD-248](../done/PRD-248-the-atmosphere-is-luts-the-sky-is-the-games.md) calls native and device lanes UNVERIFIED |
| `Daylight` | `packages/core/src/render/daylight.ts` | three's `SkyMesh` with the AgX curve. Its `VirtualShadowNode` is already covered by row `33-virtual-shadow` |

What already exists:
- `conformance/scenes/shared/spectral-ocean.js` was written on 2026-08-30 (`3491ad969`) but never registered, so the parity runner never runs it.
- The sailing template uses `SpectralOcean` and `WaterSurface3D` (`src/scenes/Sailing.ts:113`) and has a desktop scenario at `native-playtests/float.playtest.json`. That proves the game floats, not that the water renders like the web.
- No template or example constructs `Atmosphere` or `Daylight`.

## Solution

One conformance row per helper, registered with `desktopGate: true` and `required: true`, each with a browser reference and a non-blank capture. Each scene's look numbers are the scene's own, as in `spectral-ocean.js`. The rows also assert numbers, not just pixels: the ocean's readback frame lag, the LUT texels against the CPU `zenithTransmittance`/`directionalTransmittance` reference in `atmosphere/params.ts`, and the water's metres of thickness at a known depth.

A row that fails on desktop is fixed in the layer that owns it: core TypeScript first, the host only when the TypeScript path is correct and Dawn refuses. Widening a host stub to make a web-only feature work is the wrong fix (`packages/runtime-native/AGENTS.md`). `pnpm census` runs in the same commit as the registry change.

Mobile stays unclaimed. PRD-246's decision on whether the FFT fits a mobile frame is still unmade, and nothing here claims Android or iOS.

## Acceptance Criteria

- [ ] AC-1 [shared]: the four rows run in CI's desktop parity lane and pass on this PRD's pull request. proof: the `desktop-parity` job of `native-platforms.yml` on the PR.

## Integration Ledger

Integration: unchanged. This PRD adds proof rows; a fix found by a failing row changes no public entry point.

## Execution Phases

#### Phase 1: Ocean and atmosphere rows
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/registry.json`, `conformance/scenes/shared/atmosphere-luts.js` (new), `conformance/scenes/shared/daylight.js` (new)
- [ ] `spectral-ocean` is registered and passes on desktop: displacement visible, readback lag reported and bounded. proof: `pnpm parity --target desktop --only-tests spectral-ocean`.
- [ ] `atmosphere-luts` passes on the browser reference: transmittance texels match the CPU reference within half-float precision. proof: `pnpm parity --target web --only-tests atmosphere-luts`.
- [ ] `atmosphere-luts` passes on desktop under the same assertion. proof: `pnpm parity --target desktop --only-tests atmosphere-luts`.
- [ ] `daylight` passes on desktop: sky, sun and haze within tolerance of the browser reference. proof: `pnpm parity --target desktop --only-tests daylight`.

#### Phase 2: Water surface row
**Status:** NOT STARTED
**Files:** `conformance/scenes/shared/water-surface.js` (new), `registry.json`; whatever a failure names
- [ ] `water-surface` passes on the browser reference: a box under 2 m of water reads 2 m from `thicknessAt` within 5 cm, and the reflection shows a marker placed above the plane. proof: `pnpm parity --target web --only-tests water-surface`.
- [ ] `water-surface` passes on desktop with the same assertions and capture tolerance. proof: `pnpm parity --target desktop --only-tests water-surface`.
- [ ] The sailing template's desktop scenario still passes after any fix. proof: `node packages/playtest/dist/runner/cli.js native-playtests/float.playtest.json --target desktop` in a scaffolded sailing project.
