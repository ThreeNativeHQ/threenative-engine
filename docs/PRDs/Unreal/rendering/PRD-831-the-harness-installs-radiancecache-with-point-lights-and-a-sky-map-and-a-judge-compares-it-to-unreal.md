# PRD-831 — The harness installs RadianceCache with point lights and a sky map, and a judge compares it to Unreal

**Status:** IN PROGRESS (point lights in the kernel done; the harness arm is blocked on the owned engine)
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
- [ ] A traced field lit by one point light matches the capture field within 10%. proof: AC-1 spec — the kernel takes up to `trace.points.length` point lights (position, colour, intensity, cutoff distance, one shadow ray each, three's attenuation window); a spec proves the uniforms copy and clear. NOT TICKED: no GPU run compares it with a capture yet.

#### Phase 2: The harness uses RadianceCache and a judge compares it to Unreal
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/giCache.ts` (deleted), `scripts/unreal-look/scaffold/Reference.ts.in`
**Implementation:** install `RadianceCache`, delete the CPU bake, run the round.
- [ ] The harness installs `RadianceCache` and `giCache.ts` is deleted. proof: the AC-2 command
- [ ] The judge compares the engine with Unreal on `cornell`, `neon-corridor` and `sunlit-room` and returns MATCH or CLOSE per pose, with the sheets posted on the PR. proof: the PRD-647 round report

## Decisions

- 2026-11-07: filed by PRD-603 so that the Unreal comparison is deferred with a revisit condition, not dropped. Revisit when a lane holds the desktop GPU slot and the Unreal lock.
- 2026-11-07 (Unreal capture attempt, what ran): the Unreal 5.8.3 `cornell` L7-Epic and L7-Epic-indirect frames rendered on the desktop (`UE_ROOT=~/UnrealEngine-5.8.3 pnpm unreal-look:capture --engine unreal --scene gi:cornell --layers L7`, exit 0, untracked under `tools/unreal-reference/captures/unreal/cornell/`). Two three.js-engine diagnosis arms (CPU bake, and `RadianceCache` replacing each material's `irradianceNode`) ran on the Intel laptop with a `gtaoR=0.5` override on both, because upstream three has no GTAO screen reach. The full frames matched to 0.1 in mean colour (56.2/54.0/46.3 and 56.3/54.1/46.3), and the indirect-only (`direct=0`) frames were black on both arms (mean 0.1, Unreal 37.5/35.3/30.5). The cause: the harness shows indirect light through the screen-probe gather, which runs on the owned engine only. A three.js-engine frame is a diagnosis frame that feeds no gate. So the comparison with Unreal needs the owned engine, and the trace needs the CPU BVH of `GPUSceneBVH` there (the owned engine's `MeshBVH` builds no tree, `TN_NATIVE_MESH_BVH_OPTIONS_UNSUPPORTED`).
- 2026-11-07 (next step, in order): (1) a CPU BVH builder in `probe-trace.ts` that does not use `MeshBVH`; (2) run the `probe-volume-trace` row on the owned web engine; (3) wire `RadianceCache` into the harness through `giCache.irradiance` (units: E / pi; the volume returns E) and the screen-probe fallback; (4) the PRD-647 round on the owned engine.
- 2026-11-07 (steps 1 and 2 done, step 3 is next): the CPU BVH builder landed (`cpu-bvh.ts`, spec vs brute force on 300 rays) and `GPUSceneBVH` builds its position, index and normal storage on first read, so the owned engine's frozen storage nodes never block the trace. On the owned web engine on the Intel laptop (`--target web --engine threenative`, adapter gen-12lp) the `probe-volume-trace` scene traced 8 of 8 probes and reached `ready` (`TN_PROBE_VOLUME`, bake cost 7.8 ms on the first slice). The row is still `fail` for a reason outside this change: its control row `probe-volume-sample` fails the same way on that lane (a 404 and eight "worker sent an error" page errors, so the owned engine's worker threads do not start there), and the screenshot reads near black, since the owned engine lights materials through the screen-probe gather, not through the volume's `sampleNode`. The 404 URL is not named: a context-level response listener printed none, so it comes from inside a worker. Next: name the 404 (read it on a lane where an owned-engine web row passes), then step 3.
- 2026-11-07 (cornell judged on the owned engine, `?giField=trace`, PRD-603 PR #629 comments 6702910990 and 6703040769): the harness traced field gave a fresh-judge IMPROVEMENT, cornell CLOSE, corner CLOSE, no region worse than BEFORE. Two causes ended the dark grainy corner and the short-box floor glow: the gather read a per-pixel mean as its fallback (fixed in `screen-space.ts`, per ray direction as Lumen does), and 8x8 rays let one ray hit the lamp shade and light one probe 6x its neighbours (fixed with Unreal's 32x32 rays, `LumenScreenProbeGather.cpp:641`, and a half-spacing read offset, `LumenRadianceCacheInterpolation.ush:190`). Open, in order: (1) three small blotches at the box feet (red at the tall box foot, brown and green at the short box foot); (2) colour bleed on faces that look at a coloured wall is too saturated (tall box left face pure red, Unreal salmon); (3) cornell floor p50 170 vs Unreal 137; (4) `neon-corridor` and `sunlit-room` are not judged; (5) the engine `RadianceCache` default stays 8x8 rays, so the 32x32 default is a cost decision against the PRD-603 AC-1 budget.
