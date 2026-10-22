---
prd_contract: v1
---

# PRD-687 — An agent sees what the GI rays see in a playtest capture

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the GI defects found so far were found by ablations and report fields, and no capture shows the traced scene, the surface cache coverage or the probes. The gate decides whether views would have found them sooner.
**Complexity:** 5 (MEDIUM) — 1–5 files: the view modes, specs, one conformance scene (+1), new debug passes that reuse the trace kernel (+1), native proof (+1), playtest capture wiring (+1), manifest entries (+1); risk override: none
**Owner:** João
**Depends on:** PRD-646 Phase 3 (`docs/PRDs/Unreal/gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md`, on `feat/unreal-look-epic`): the `GIVisualize` object and its `indirectDiffuse` mode. PRD-639 Phase 2 and PRD-642 Phase 2 on the same branch (`docs/PRDs/Unreal/gi/PRD-639-a-surface-cache-gives-traced-rays-the-texture-glow-and-lights-of-what-they-hit.md`, `docs/PRDs/Unreal/gi/PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md`): the material atlas and the owned-engine trace kernel the views reuse. [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 3: the probe ages the probe view shows. Does not overlap [PRD-676](../performance/PRD-676-a-playtest-capture-tells-an-agent-whether-a-frame-pays-for-pixels-clusters-shadow-levels-or-effects.md), which says it leaves GI views to PRD-646.

## Context

**Unreal LOC:** 3,368 lines: the Lumen scene, reflection and surface cache views (2,163 lines,
`LumenVisualize.cpp`, `LumenVisualize.usf` and their headers) and the radiance cache, radiosity and
card lighting views (1,205 lines, `LumenVisualizeRadianceCache.cpp`, `LumenVisualizeRadianceCache.usf`,
`LumenRadianceCacheDebug.usf`, `LumenVisualizeRadiosityProbes.usf`, `LumenSceneLightingDebug.usf`).
The hardware ray tracing views (1,680 lines) are deferred with PRD-645. **Port estimate:** about 250
to 400 ThreeNative lines, because each view is one trace or one draw over data that exists.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **One switch, many views.** `r.Lumen.Visualize` selects a view: overview, Lumen Scene, reflection
  view, surface cache coverage, dedicated reflection rays, albedo, normals, emissive, direct lighting,
  indirect lighting, and the lighting update views
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenVisualize.cpp:29-50`).
- **Lumen Scene traces from the camera.** It shows the simplified scene that GI rays hit, shaded from
  the surface cache, at the highest quality and view distance
  (`Engine/Source/Runtime/Engine/Private/LumenVisualizationData.cpp:40-46`).
- **Surface cache coverage marks the gaps.** Pink is a surface the cache does not cover. Yellow is a
  mesh the scene culled (`LumenVisualizationData.cpp:64-70`).
- **Dedicated reflection rays.** The view marks the pixels smooth enough to trace their own
  reflection ray, foliage in green and the rest in red (`LumenVisualizationData.cpp:72-78`).
- **Probes are drawn in place.** `r.Lumen.RadianceCache.Visualize` draws the radiance cache probes
  with their radiance (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenVisualizeRadianceCache.cpp:9-14`).

### ThreeNative today

- PRD-646 plans `GIVisualize` with one mode, `indirectDiffuse`. PRD-641 adds `framesAccumulated` and
  `fastUpdateAmount` in its Solution text.
- The surface cache reports by text: `TN_SURFACE_CACHE` lists atlas bytes, pages and the materials
  that fell back to flat colour (PRD-639). The `unreadable-image` fallback of PRD-639 was found from
  that report after a capture showed no change.
- PRD-642 D1 found its causes with three ablations per cell (`?off=ssr`, `?off=reflcap`, `?off=gi`).
- No capture shows which objects are in the traced pack, what a GI ray returns at a hit, or which
  probes are stale.

## Solution

**The gate first (Phase 1).** List the GI defects recorded under `## Decisions` in PRD-639, PRD-640,
PRD-642 and PRD-644. For each one, write which view below would have shown it in one capture and
whether a report field already names it. **Continue** only if two or more defects map to a view and
to no report field. Otherwise record the table under `## Decisions` and delete Phases 2 and 3 (R4).

**Phase 2, the scene views.** `GIVisualize` gains three modes with Unreal's names in camelCase:

- `lumenScene`: one ray per pixel from the camera through the traced pack. The hit is shaded the way
  a GI ray sees it: the surface cache colour, the direct light at the hit and the emissive. A miss
  shows the sky.
- `surfaceCache`: the same ray. A hit on a mapped material shows its atlas texel, a flat-colour
  fallback shows a flat tint, and a pixel the camera sees but the pack does not hold shows pink.
- `dedicatedReflectionRays`: the pixels at or below `maxRoughnessToTrace`, foliage in green and the
  rest in red.

**Phase 3, the probe view and native.** `radianceCacheProbes` draws each probe of the `ProbeVolume`
as a small sphere that shows its irradiance. A stale or invalid probe gets an outline colour. The
view never changes the probes.

**Where it lives.** The modes are mechanism in the `GIVisualize` module of PRD-646, in
`packages/core/src/render/`. They reuse the trace kernel and the atlas and add no new data. The tint
colours of a debug view are not the game's look, so they live in the module. The playtest capture
takes a mode by name, so an agent can ask for `lumenScene` in a scenario. The manifest entry gains
`@alias lumen scene`, `@alias surface cache visualize` and `@alias radiance cache visualize`.

## Acceptance Criteria

- [ ] AC-1 [local]: With the `images` callback of PRD-639 turned off on `neon-corridor`, the `surfaceCache` view shows the brick wall as a flat-colour fallback, and with it on, as mapped. proof: `pnpm unreal-look:capture --engine threenative --scene gi:neon-corridor --visualize surfaceCache`, both arms — Evidence: pending.
- [ ] AC-2 [local; needs a built desktop host]: The conformance row `gi-visualize-scene` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests gi-visualize-scene` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `lumenScene`, `surfaceCache`, `dedicatedReflectionRays` | A playtest scenario or the harness asks `GIVisualize` for the mode | New. Ablations stay for cause tests | AC-1 |
| `radianceCacheProbes` | The same object | New | Phase 3 |

## Execution Phases

#### Phase 1: Would a view have found the defects sooner
**Status:** NOT STARTED
**Files:** this PRD (`## Decisions` table only)
- [ ] The table of recorded GI defects, the view that shows each and the report field that names each, is under `## Decisions` with the gate verdict. proof: the cited `## Decisions` entries of PRD-639, PRD-640, PRD-642 and PRD-644 on `feat/unreal-look-epic`, read on the day of the gate.

#### Phase 2: The traced scene and the surface cache as views
**Status:** NOT STARTED
**Files:** the PRD-646 `GIVisualize` module, its spec, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A pixel on a mesh outside the pack shows pink in `surfaceCache`, a mapped hit shows its atlas texel, and `lumenScene` returns the same hit colour as a GI ray at that point. proof: `pnpm exec vitest run packages/core/__tests__/gi-visualize.spec.ts`.
- [ ] A capability search for "lumen scene" returns `GIVisualize`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: The probe view and native proof
**Status:** NOT STARTED
**Files:** the PRD-646 `GIVisualize` module, `packages/runtime-native/conformance/scenes/shared/gi-visualize-scene.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] `radianceCacheProbes` draws one sphere per probe with its irradiance, outlines a stale probe, and leaves the probe data unchanged. proof: `pnpm exec vitest run packages/core/__tests__/gi-visualize.spec.ts`.
- [ ] The conformance row `gi-visualize-scene` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests gi-visualize-scene`.
**Verification:** AC-1 and AC-2.
