---
prd_contract: v1
---

# PRD-676 — A playtest capture tells an agent whether a frame pays for pixels, clusters, shadow levels or effects

**Status:** NOT STARTED
**Priority:** P2 — AC-1 to AC-3 are open: no capture reports fragments per pixel, and no single report lists every effect's cull state. Phase 1 has not measured which of the four views an agent is missing.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (+1), a new one-frame GPU pass with readback (+2), a new playtest request field crosses the core and playtest packages (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. Extends the one-frame geometry capture that ships today (`packages/core/src/geometry-capture.ts`). Does not overlap `GIVisualize` in `docs/PRDs/Unreal/gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md` (GI terms only) or the light-complexity view in [PRD-660](../rendering/PRD-660-many-shadowed-lamps-cost-one-fixed-budget-not-one-shadow-map-each.md).

## Context

The primary consumer of ThreeNative is an agent, not a human. An agent cannot look at a debug
viewport. It reads numbers from a playtest run, and sometimes one image. So Unreal's debug views map
to numbers that one playtest capture returns, plus an optional image an agent or a judge can open.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

Unreal size for this topic: about 9,650 lines. The feature map counts Nanite debug and visualize at
4,278, virtual shadow map debug and stats at 1,015, and the Niagara debug HUD at 3,760. TSR
visualize is part of a shared 1,555-line row. Its shader alone is 595 lines.

- **Nanite has 41 visualize modes and one stats readout.** The modes include triangles, clusters,
  groups, pages, overdraw, raster bins, shading bins, material count and skinning.
  `UE 5.8.3: Engine/Shaders/Shared/NaniteDefinitions.h:298-338`. `r.Nanite.ShowStats` (default 0)
  prints a GPU counter block: triangles, vertices, instances before and after culling, visited
  nodes, candidate clusters, active raster bins and Nanite pixels.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/Nanite.cpp:17-21` and
  `Engine/Shaders/Shared/NaniteDefinitions.h:517-542`.
- **The overdraw view counts raster evaluations per pixel.** A debug buffer adds one per
  evaluation. The view maps the count through one minus two to the power of minus count times a
  scale, then through an inferno colour ramp. The scale defaults to 15% per evaluation.
  `UE 5.8.3: Engine/Shaders/Private/Nanite/NaniteVisualize.usf:298-305` and
  `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteVisualize.cpp:53-58`.
- **Virtual shadow maps keep 26 GPU stat counters and 12 visualize flags.** The counters include
  requested pages, static and dynamic cached pages, invalidated pages, empty pages, instances drawn
  and culled by each test, and three overflow flags (marking queue, light count, page pool).
  `UE 5.8.3: Engine/Shaders/Shared/VirtualShadowMapDefinitions.h:75-105`. The visualize flags show
  the clipmap level, the virtual page, the cached page, the dirty page and the shadow casters.
  `VirtualShadowMapDefinitions.h:40-52`. The stats switch is `r.Shadow.Virtual.Stats.Visible`.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:194`.
- **TSR has 16 internal views.** They show accumulated sample count, parallax disocclusion, and the
  masks where history is rejected, clamped or resurrected.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:403-421`.
- **The Niagara debug HUD lists every effect system.** Per system it counts registered, active and
  culled components (by distance and by visibility), emitters, particles and bytes.
  `UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraDebugHud.h:94-116`. It has
  overview, scalability, performance, performance-graph and GPU-compute modes.
  `Engine/Plugins/FX/Niagara/Source/Niagara/Public/NiagaraDebuggerCommon.h:394-401`. A wildcard
  filter narrows it to one system, and an option shows the global effect budget.
  `NiagaraDebugHud.cpp:143`, `:152`.

### What ThreeNative ships today

Searched 2026-10-21: `rg -i "visualize|debugView|overdraw" packages/` finds no debug view. The
capability manifest lists these readouts:

- `FrameBudget` (`packages/core/src/frame-budget.ts`): per presented frame, the GPU time and the
  draws and triangles of each render pass, on every platform.
- `GeometryCapture` (`packages/core/src/geometry-capture.ts:462`): one armed frame. It ranks the
  objects that submitted triangles and draws, beside an estimated projected diameter
  (`geometry-capture.ts:131-132`). A playtest asks for it through `assert.geometry` and the
  `runtime.geometry` capability (`packages/playtest/src/assertion-schema.ts:704-708`).
- `TN_VIRTUAL_SHADOW` (`packages/core/src/render/virtual-shadow.ts:380`): per clip level, which
  level moved, was invalidated, rendered or deferred, and its caster draws by kind
  (`virtual-shadow.ts:318-364`).
- `GPUParticles3D` (`packages/core/src/particles.ts:428-470`): `stats`, `dispatches` and `cull`
  (state, reason, transitions) per emitter. `ParticleSignificance.shed`
  (`packages/core/src/particle-significance.ts:77`) is the global effect budget.
- PRD-539's `scripts/verify-temporal-motion.ts` reports a rejected-history ratio offline
  ([PRD-539](PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md), its first box).

Two gaps are known. First, no number says how many fragments a pixel paid for. PRD-228 named the
cost of that gap: a 9–11 ms flat town pass on Mali, and "nobody knows whether that is vertex/binning
work or fragment work" ([PRD-228](../../done/PRD-228-the-pixel-budget-is-the-engines.md)). Second,
the per-emitter readouts exist, but an agent must find every emitter itself. Nothing collects them
into one list.

## Solution

**Reuse the geometry capture. Do not build a second capture.** `IGeometryCaptureRequest` gains an
optional `views` list. Each named view adds one section to the same one-frame report. The arming,
timeout, scene-exit cancel, playtest assertion and capability stay as they are. An idle game pays
nothing, as today.

| Unreal subsystem | ThreeNative view | File | Layer |
| --- | --- | --- | --- |
| Nanite overdraw view | `overdraw`: fragments per pixel (mean, p95, max, share above 4), optional inferno PNG | `packages/core/src/render-debug-overdraw.ts` (new) | core mechanism |
| Nanite cluster and stats views | `clusters`: per `ClusteredMesh` row, drawn clusters and triangles per projected pixel | `packages/core/src/geometry-capture.ts` | core mechanism |
| VSM stats and clipmap view | `shadowLevels`: per level, screen share it covers and the frame's `TN_VIRTUAL_SHADOW` row | `packages/core/src/render/virtual-shadow.ts` | core mechanism |
| Niagara debug HUD | `effects`: one row per `GPUParticles3D` with `cull`, `dispatches`, `stats` and the global `shed` | `packages/core/src/geometry-capture.ts` | core mechanism |
| TSR visualize | Deferred (Decisions) | — | — |

- **Overdraw.** The pass draws the scene once more with an override material. The material adds a
  constant into an `r16float` target with additive blending and no depth test, so each texel counts
  raster fragments. A compute reduction gives the histogram, and one readback returns it. The
  inferno ramp and the 15% scale follow Unreal's mapping. The image is a diagnostic that never
  reaches a game frame, so it is not a look decision.
- **Clusters.** `ClusteredMesh` already has `drawnClusters` and `drawnTriangles`
  (`packages/core/src/clustered-mesh.ts:257-265`). The row adds them and divides triangles by the
  projected area. The report labels the area as an estimate.
- **Report "unavailable" with a reason.** A host without timestamp queries, a target without
  float blending, or an alpha-tested material that the override cannot discard each says so. None
  of them reports zero.

**Consumer flow.** A playtest scenario adds `"views": ["overdraw", "effects"]` to its existing
`assert.geometry` request and sets thresholds on the returned numbers. The engine arms one frame,
answers, and removes every hook.

**Risks:**

- The override material loses alpha test, so cut-out foliage reads as full quads. The overdraw
  section counts these materials and reports them beside the histogram.
- The overdraw pass costs one extra scene draw on the captured frame only. The report marks that
  frame so `FrameBudget` does not count it as a game frame.

## Acceptance Criteria

- [ ] AC-1 [local]: On the vfx-gallery smoke case, the overdraw p95 falls by at least 2x between the full stack and the thinned stack, and the frame's other numbers do not explain the difference. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/overdraw-view.playtest.json --url http://127.0.0.1:5173 --server-command "pnpm --filter vfx-gallery dev" --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: The `effects` view lists every emitter in the vfx-gallery scene with its cull state, and an emitter behind the camera reads `paused` with reason `outside-view`. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/emitter-cull.playtest.json --url http://127.0.0.1:5173 --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host returns the overdraw histogram within one count of the browser at p95 for a fixed camera. proof: `pnpm parity --target desktop --only-tests render-debug-overdraw` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `views` on the geometry capture | playtest `assert.geometry` → `runtime.geometry` bridge → `GeometryCapture` | New field. The request without `views` is unchanged | Phase 2 |
| Overdraw section | the same request with `"overdraw"` | New. Answers PRD-228's vertex-or-fragment question | AC-1, AC-3 |
| Effects section | the same request with `"effects"` | Collects the per-emitter readouts that exist today | AC-2 |

## Decisions

- 2026-10-21 (filing): TSR visualize is deferred. PRD-539's verify script already reports the rejected-history ratio, and the temporal stage is template source. Revisit when a game shows ghosting or blur that this ratio does not explain. Then the history mask is a view here.
- 2026-10-21 (filing): no in-game HUD. The `DebugOverlay` Geometry tab (`@threenative/ui`) is the human view, and it can show these sections later. Agents read the report.
- 2026-10-21 (filing): port size estimate. About 500 to 700 TypeScript lines with specs, plus one native conformance scene of about 100 lines.

## Execution Phases

#### Phase 1: Measure which views an agent is missing
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/playtests/overdraw-view.playtest.json` (new), `examples/quarry/playtests/quarry-route.playtest.json`, `examples/vfx-gallery/playtests/emitter-cull.playtest.json`
**Implementation:** four seeded cases, each with a costly arm and a fixed arm: (a) a screen-filling smoke stack against a thinned stack, (b) the quarry cliff at `errorPixels` 0.25 against 1, (c) a sun shadow level that re-renders every frame against a settled one, (d) an emitter behind the camera with `graceSeconds = Infinity` against the default. **Gate:** a view continues only if no number that ships today changes by at least 2x between its two arms. A view whose case an existing number already explains is recorded under `## Decisions`, and its boxes are deleted (R4).
- [ ] Each of the four cases records, for both arms, the `TN_FRAME_BUDGET` pass split, the top geometry capture rows, the `TN_VIRTUAL_SHADOW` row and every emitter's `cull`, with the per-view verdict under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js <case>.playtest.json --url http://127.0.0.1:5173 --browser-recipe webgpu`, two runs per arm with `adapter.info` checked

#### Phase 2: Overdraw and cluster sections
**Status:** NOT STARTED
**Files:** `packages/core/src/render-debug-overdraw.ts` (new), `packages/core/src/geometry-capture.ts`, `packages/core/src/game.ts`, `packages/playtest/src/assertion-schema.ts`, `packages/core/__tests__/render-debug-overdraw.spec.ts` (new), `packages/core/__tests__/geometry-capture.spec.ts`
**Verification:** AC-1 closes this phase.
- [ ] The overdraw histogram of a stub frame with three stacked full-screen quads reads 3 at every pixel, and an alpha-tested material is counted as unavailable, not as zero. proof: red-green `pnpm exec vitest run packages/core/__tests__/render-debug-overdraw.spec.ts`
- [ ] A `ClusteredMesh` row carries `drawnClusters` and triangles per projected pixel, and a request without `views` returns the same report as before. proof: `pnpm exec vitest run packages/core/__tests__/geometry-capture.spec.ts`
- [ ] A scenario threshold on overdraw p95 fails on the full smoke stack and passes on the thinned one. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/overdraw-view.playtest.json --url http://127.0.0.1:5173 --browser-recipe webgpu`

#### Phase 3: Shadow-level and effect sections, then native
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/src/geometry-capture.ts`, `packages/core/__tests__/virtual-shadow.spec.ts`, `packages/runtime-native/conformance/scenes/shared/render-debug-overdraw.js` (new), `packages/runtime-native/conformance/registry.json`
**Verification:** AC-2 and AC-3 close this phase.
- [ ] The `shadowLevels` section gives each clip level's screen share, and the shares of a fixed camera sum to 1 within 0.01. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`
- [ ] The `effects` section lists every `GPUParticles3D` in the scene with `cull`, `dispatches`, `stats` and the global `shed`. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/emitter-cull.playtest.json --url http://127.0.0.1:5173 --browser-recipe webgpu`
- [ ] The desktop host answers the overdraw section for the conformance scene. proof: `pnpm parity --target desktop --only-tests render-debug-overdraw`
