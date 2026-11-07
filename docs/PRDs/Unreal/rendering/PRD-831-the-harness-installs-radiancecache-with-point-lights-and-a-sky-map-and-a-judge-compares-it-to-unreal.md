# PRD-831 — The harness installs RadianceCache with point lights and a sky map, and a judge compares it to Unreal

**Status:** NOT STARTED
**Priority:** P2 — closes the Unreal comparison that [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) could not run
**Complexity:** 6 (MEDIUM-HIGH) — a trace-kernel feature, a harness replacement of `giCache.ts`, and a PRD-647 judge round
**Owner:** unassigned
**Depends on:** PRD-603 (the traced `RadianceCache`)

## Context

PRD-603 ships `RadianceCache` (`packages/core/src/render/radiance-cache.ts`). It lights a probe field from emission, one sun and a flat sky colour. The Unreal GI calibration scenes need more: `cornell` and `neon-corridor` are lit by point lights, and `sunlit-room` by a sky map and a sun (`tools/unreal-reference/gi/<scene>/scene.json`). The harness still installs the CPU bake in `scripts/unreal-look/scaffold/render/giCache.ts` (2,152 lines), so PRD-603 could not judge its change against an Unreal scene. Its fixture, the off-screen emitter, has no Unreal counterpart. PRD-603's visual judge compared trace against capture only and returned NEUTRAL.

## Solution

1. Give the trace kernel point lights (position, colour, intensity, cutoff distance, one shadow ray each, the same attenuation window as three's `getDistanceAttenuation`) and a sky map lookup for a missed ray.
2. Install `RadianceCache` in the harness in place of `giCache.ts`, keep the enclosed-probe extra rays and the glass rule (a translucent surface is not in the trace scene, UE 5.8.3: `Lumen/LumenSceneRendering.cpp`, `bOpaqueOrMasked`), and delete the CPU bake.
3. Run the PRD-647 round on `cornell`, `neon-corridor` and `sunlit-room` at `high`, Unreal Epic as the target, with the fresh judge and its brief (`tools/unreal-reference/gi/judge-brief.md`). Post the sheets on the PR.

## Acceptance Criteria

- [ ] AC-1 [local]: A spec shows the traced field lit by a point light within 10% of the capture field on the same scene. — proof: `pnpm exec vitest run packages/core/__tests__/probe-trace.spec.ts`
- [ ] AC-2 [local; needs the Unreal lock and a desktop GPU slot]: The L7 cells on the three scenes are no further from Unreal than with `giCache.ts`. — proof: `pnpm unreal-look:compare --layer L7`, before and after, engine named.

## Execution Phases

#### Phase 1: Point lights and a sky map in the trace kernel
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-trace.ts`, `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/probe-trace.spec.ts`
**Implementation:** extend the trace lighting inputs and the radiance at a hit. Keep the sun and the flat sky as they are.
- [ ] A traced field lit by one point light matches the capture field within 10%. proof: AC-1 spec

#### Phase 2: The harness uses RadianceCache and a judge compares it to Unreal
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/giCache.ts` (deleted), `scripts/unreal-look/scaffold/Reference.ts.in`
**Implementation:** install `RadianceCache`, delete the CPU bake, run the round.
- [ ] The harness installs `RadianceCache` and `giCache.ts` is deleted. proof: the AC-2 command
- [ ] The judge compares the engine with Unreal on `cornell`, `neon-corridor` and `sunlit-room` and returns MATCH or CLOSE per pose, with the sheets posted on the PR. proof: the PRD-647 round report

## Decisions

- 2026-11-07: filed by PRD-603 so that the Unreal comparison is deferred with a revisit condition, not dropped. Revisit when a lane holds the desktop GPU slot and the Unreal lock.
