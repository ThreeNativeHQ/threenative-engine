---
prd_contract: v1
---

# PRD-634 — Sun shadows reach the horizon and soften with distance from the caster

**Status:** PARTIAL
**Priority:** P2 — template integration and native parity remain open: the starter's sun shadow ends 14 m from the player and has the same edge width everywhere, while Unreal's default shadows cover the view and widen with the gap between caster and receiver.
**Complexity:** 6 (MEDIUM) — a shadow-filter mechanism in core (+2), the shadow method choice across 13 templates (+2), native proof of both (+2); risk override: the templates already reverted a virtual-shadow default once (level-boundary artefacts), so Phase 1 measures before anything changes.
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L5 row). Coordinates with [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md), which owns virtual-shadow page cost. Builds on [PRD-572](../../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md) and [PRD-538](../../done/PRD-538-shadow-maps-redraw-only-what-streamed-in.md).

## Context

**ThreeNative today:**

- The starter draws one `PCFSoftShadowMap` sun map: 4096² on desktop, 2048² on phones, with an
  orthographic half-extent of 14 m and near/far 1/80 m
  (`packages/create-threenative/templates/starter/src/render/lighting.ts:11-26`). Other templates
  widen the box to 22–42 m. Past that box, nothing casts a shadow.
- The authored `radius: 2` changes nothing on the native engine: its PCF-soft branch is a fixed 3×3
  footprint (`packages/runtime-native/src/engine/shader/standard.cpp:719`). So the edge width is
  one constant, whatever the gap between caster and receiver.
- Core ships `VirtualShadowNode`, camera-following clip levels with a page cache
  (`packages/core/src/render/virtual-shadow.ts:867`). The templates stopped using it after level
  boundaries showed as shadows that suddenly turned sharp (`minimal/src/render/lighting.ts`
  comment). The done PRD-470 still claims `minimal` uses it, which is stale.
- [PRD-561](../../done/PRD-561-contact-shadows-from-screen-depth.md) declined screen-space contact shadows on 2026-10-10. Unreal agrees by default: its light's contact-shadow length is 0.

**Unreal 5.8.3** (source read 2026-10-19):

| Setting | Default | Source |
| --- | --- | --- |
| Method | Virtual shadow maps, turned on by the project generator | `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:136` |
| Clipmap | 128² pages, 16384² virtual resolution, directional levels 6 to 22 | `Engine/Shaders/Shared/VirtualShadowMapDefinitions.h:13-20`; `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:57-63` |
| Penumbra | Shadow-map ray tracing (SMRT): 8 rays × 4 samples at High and Epic, from the light's source angle | `Engine/Config/BaseScalability.ini:224,262` |
| Sun source angle | 0.5357° | `Engine/Source/Runtime/Engine/Private/Components/DirectionalLightComponent.cpp:1050` |
| Contact shadows | Off (length 0) | `Engine/Source/Runtime/Engine/Private/Components/LightComponent.cpp:470` |
| Fallback without VSM | 4 cascades to 400 m, distribution exponent 3 | `DirectionalLightComponent.cpp:1038-1055` |

At 0.5357°, the penumbra is about 0.94 cm wide for each metre between the caster and the receiver.
A capsule's feet stay sharp, and a shadow cast from 10 m up spreads to about 9 cm.

## Solution

1. **Phase 1 decides the method by measurement, on the L5 cells.** It compares three candidates
   against the Unreal frames and the `high` frame budget:
   - the current single map widened to the view
   - three.js cascades
   - `VirtualShadowNode` with the boundary artefact fixed

   The winner becomes the template default. The decision and its numbers go under `## Decisions`.
   Phase 1 also states the artefact's cause before it rules on virtual shadows.
2. **A source-angle soft filter in core.** It searches the shadow map for the average blocker depth
   and widens the filter by `gap × tan(sourceAngle)`, clamped to the map's texel size. The angle
   comes from the game, and the templates set Unreal's 0.5357°. The filter is a mechanism:
   - it does not decide the look, because the angle is a game value
   - it runs on any of the three methods

   It replaces the fixed 3×3 on the native engine as well.
3. **Contact shadows stay off**, as in Unreal (PRD-561 holds).

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L5 cells match the Unreal L5 cells within the PRD-631 thresholds in all 12 poses, including the shadowed-floor region of the exterior wide pose. proof: `pnpm unreal-look:compare --layer L5` — Evidence: pending.
- [ ] AC-2 [local]: In the sphere-row pose at a 15° sun, the penumbra width of the 10 m wall shadow is within 25% of the Unreal width. proof: `pnpm unreal-look:compare --layer L5 --metric penumbra` — Evidence: pending.
- [ ] AC-3 [local]: The chosen method holds the `high` frame budget on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Source-angle soft filter | `templates/*/src/render/lighting.ts` → `sun.shadow.sourceAngle` | Replaces the fixed PCF footprint, web and native | Phase 2 |
| View-wide sun shadow | `lighting.ts`, with the method chosen in Phase 1 | Replaces the 14–42 m box | Phase 3 |

## Execution Phases

#### Phase 1: Choose the method on the reference
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/shadow-candidates.ts` (new)
- [ ] The three candidates are scored on the L5 cells and on `high` frame time, and the winner is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L5 --candidates single,cascades,virtual`.

#### Phase 2: The source-angle filter
**Status:** PARTIAL — core mechanism and CPU checks only; GPU rendering, native parity and starter integration unverified.
**Files:** `packages/core/src/render/soft-shadow.ts` (new), `packages/core/__tests__/soft-shadow.spec.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`
- [x] The filter width grows linearly with the caster gap, and is clamped at one texel for a gap of 0. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts` — 2026-10-19: 4 tests pass, exit 0; invalid inputs and GPU-free factory/node creation covered. `pnpm exec biome check packages/core/src/render/soft-shadow.ts packages/core/__tests__/soft-shadow.spec.ts packages/core/src/index.ts` and `pnpm --filter @threenative/core exec tsc --noEmit` both exit 0. Game supplies `sourceAngleRad`; `shadow.filterNode` uses blocker search and variable-radius PCF. GPU/visual results unverified.
- [ ] The native engine applies the same filter within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests soft-shadow-source-angle`.
- [ ] AC-2 passes on the starter. proof: `pnpm unreal-look:compare --layer L5 --metric penumbra`.

#### Phase 3: Every template
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/lighting.ts`, `packages/create-threenative/templates/minimal/AGENTS.md` (and mirror)
- [ ] All templates use the chosen method and the filter, and the template gate passes. proof: `pnpm test:templates`.
- [ ] The `low` tier keeps one 2048² map with the filter, and the phone budget holds. proof: `pnpm test:templates` (starter, `low`).
- [ ] Every affected template's `AGENTS.md` (and mirror) states the view-wide sun shadow and its `sourceAngle`, with the override that restores a fixed box, so a new project's agent knows the default and how to override it. proof: `rg -l 'sourceAngle' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-19: Contact shadows stay declined (PRD-561). Unreal's default light has contact-shadow
  length 0, so the reference does not ask for them.
- 2026-10-19: Unreal's SMRT traces rays through the shadow map. This PRD copies the effect (a
  penumbra that grows with the caster gap), not the method. A blocker-search filter gives that
  effect on any shadow method, and WebGPU can run it.
- 2026-10-19: the measured source angle is 0.7357° (live 5.8.3 level dump, `template-actors.json`),
  not 0.5357°; the templates use the measured value. The starter's `shadow.radius = 2`
  (`templates/starter/src/render/lighting.ts:28`) is part of the blob look the review flagged;
  the source-angle filter replaces it.
