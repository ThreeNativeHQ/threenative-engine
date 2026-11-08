# PRD-853 — The traced RadianceCache replaces the harness CPU bake

**Status:** NOT STARTED
**Priority:** P2 — the last step of the Unreal GI comparison that [PRD-831](../../done/PRD-831-the-harness-installs-radiancecache-with-point-lights-and-a-sky-map-and-a-judge-compares-it-to-unreal.md) started
**Complexity:** 6 (MEDIUM-HIGH) — a sky map in the trace kernel, a probe visibility test, a gather temporal filter, and a harness swap
**Owner:** unassigned
**Depends on:** PRD-831 (point lights in the trace kernel, the judged CPU-bake harness and its ratchets)

## Context

PRD-831 gave the trace kernel point lights and judged the harness GI against Unreal 5.8.3 on `cornell`, `neon-corridor` and `sunlit-room`. The harness still lights those scenes from the CPU bake in `scripts/unreal-look/scaffold/render/giCache.ts`, because the traced field (`?giField=trace`) is further from Unreal on two of the three scenes:

- `sunlit-room`: almost black. The trace has a flat sky colour and no sky map, and `?giVis=1` drops most probes near the walls. Without `?giVis=1` the light leaks through the walls.
- `neon-corridor`: probe-cell blotches on the back wall, the floor and the ceiling.
- `cornell`: CLOSE, with flicker at the lamp under temporal AA jitter (lamp temporal std about 60 against 6 for the CPU bake).

Sheet with the CPU bake, the traced field with `?giVis=1` and Unreal: PR #634, comment on the PRD-831 close.

## Solution

1. Add a sky map lookup for a missed ray to the trace kernel, and prove one point-lit traced field against the capture field on the GPU.
2. Stop the leak: a per-probe visibility test on the traced read, or Lumen's answer (the screen probe's near-field trace, the cache read only past ProbeTMin, UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenRadianceCacheInterpolation.ush:190`). Port Lumen's gather temporal filter (`LumenScreenProbeGatherTemporal.usf`) so a jittered frame accumulates before the TAA.
3. Install `RadianceCache` in the harness in place of `giCache.ts`, keep the PRD-831 rules (glass outside the trace scene, a primitive under `MeshCardsMinSize` outside it), delete the CPU bake, and judge the swap.

## Acceptance Criteria

- [ ] AC-1 [local, GPU]: A traced field lit by one point light is within 10% of the capture field on the same scene. — proof: a GPU playtest or conformance row on the owned web engine, adapter named.
- [ ] AC-2 [local, GPU]: With `RadianceCache` in the harness, `compare --check` holds every PRD-831 ratchet on the three scenes at L7-high and L9. — proof: `pnpm unreal-look:compare --check --scene gi:<scene> --layer L7-high` and `--layer L9`.

## Execution Phases

#### Phase 1: A sky map and a GPU proof for the trace kernel
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-trace.ts`, `packages/core/__tests__/probe-trace.spec.ts`
- [ ] A missed ray reads the sky map. proof: `pnpm exec vitest run packages/core/__tests__/probe-trace.spec.ts`
- [ ] The point-lit traced field matches the capture field within 10% on the GPU. proof: AC-1

#### Phase 2: No leak and no flicker
**Status:** NOT STARTED
**Files:** `packages/core/src/render/radiance-cache.ts`, `packages/three-native/src/screen-space.ts`
- [ ] `sunlit-room` with `?giField=trace` has no light through the walls. proof: a fresh-judge verdict, CLOSE per pose against Unreal L7-Epic
- [ ] The cornell lamp region holds its temporal std under 10 in a 40-frame recording. proof: the PRD-831 recording method, before and after

#### Phase 3: The harness swap
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/giCache.ts` (deleted), `scripts/unreal-look/scaffold/CalibrationScene.ts.in`, `scripts/unreal-look/scaffold/Reference.ts.in`
- [ ] The harness installs `RadianceCache` and `giCache.ts` is deleted. proof: AC-2
- [ ] A fresh judge returns NEUTRAL or IMPROVEMENT against the CPU bake on the three scenes, with the sheets on the PR. proof: the PR comment

## Decisions

- 2026-11-07: filed by PRD-831, which closed on the judged CPU-bake harness. The swap is deferred, not dropped. Revisit when Phase 2 holds on `sunlit-room`.
