---
prd_contract: v1
---

# PRD-716 — A shadow caster that no visible surface receives, or another caster hides, skips its draw

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: no number says how many caster draws in a dense level are hidden in the light's view or land only where no visible surface is, and PRD-457 prices sparse pages without pricing this culling.
**Complexity:** 7 (HIGH) — a gate and a new pass per level (+2), new GPU resource per level (+2), 3–6 files (+1), native proof on the owned engine (+1), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-457](PRD-457-virtual-shadows-scale-by-measurement.md) Phase 1 (the shadow corpus and its draw counters). Coordinates with [PRD-602](PRD-602-a-clustered-shadow-caster-draws-what-its-shadow-texel-resolves.md) and `PRD-695` in this folder, which cut clustered casters per view.

## Context

**Unreal LOC:** about 1,100 of the 21,953 virtual-shadow lines: the per-page depth pyramid 369, the instance-to-page overlap tests 464 and the receiver masks in page management about 100, plus the culling hooks in the draw-command build. **Port estimate:** about 400 to 600 lines in core, only after the gate.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A depth pyramid for each physical page.** After a page draws, a compute pass builds a pyramid of
  its depth. Only dirty pages rebuild (`UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPhysicalPageManagement.usf:1644-1911`,
  `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:4829-4922`).
- **Two-pass culling with it.** `r.Shadow.Virtual.UseHZB` is 1 for clustered geometry
  (`VirtualShadowMapArray.cpp:624-629`) and `r.Shadow.Virtual.NonNanite.UseHZB` is 1 for ordinary
  meshes (`:477-481`). The per-page draw build tests each instance's page rectangle against the
  pyramid and counts what it culls (`VirtualShadowMapBuildPerPageDrawCommands.usf:315-322`). A caster
  hidden behind another caster in the light's view never draws.
- **A second pyramid for cached scenes.** `r.Shadow.Virtual.DynamicHZB` is 0. When on, the dynamic
  part of a cached page has its own pyramid. The help text says it pays for a forest with a static
  sun, and that it costs a quarter of the page pool in memory (`VirtualShadowMapArray.cpp:185-192`).
- **A receiver mask per page.** Pixel marking records which blocks of a page hold a visible receiver,
  as an 8 by 8 grid of bits per page. Page management merges the bits into mips
  (`VirtualShadowMapPageManagement.usf:145-156`, `:240-246`). An instance whose rectangle covers only
  empty blocks does not draw. The mask is on for the sun (`VirtualShadowMapClipmap.cpp:161`) and off
  for lamps (`VirtualShadowMapArray.cpp:776-780`). Its help text says it works best at lower
  resolutions.

### ThreeNative today

- `VirtualShadowNode` draws every caster in a level's window above `minCasterTexels`, default 1.5
  (`packages/core/src/render/virtual-shadow.ts:203-209`). A dirty rectangle limits a redraw
  (`partialRedraw`, PRD-538). Nothing tests a caster against the depth of the other casters or against
  the screen's receivers.
- `packages/core/src/render/depth-pyramid.ts` builds a pyramid of the camera's depth. The light view
  has none.
- `ReceiverDemandPass` (`virtual-shadow-pages.ts:604`) already computes which pages the screen needs.
  It feeds bookkeeping only.

## Solution

**The gate first (Phase 1).** On the PRD-457 corpus (static city block, moving forest, quarry) count,
for the finest two levels, the casters drawn, the casters fully hidden in a CPU-built pyramid of the
level's own depth, and the casters whose rectangle holds no visible receiver. **Continue** only if at
least 25% of the level's caster triangles are rejectable in one fixture and a test cull pass costs
under a third of the time it saves. Otherwise record the table under `## Decisions` and delete
Phases 2 and 3.

**The mapping (Phase 2 and 3).** Receiver bits come from `ReceiverDemandPass`. The pyramid reuses the
`depth-pyramid.ts` kernel on the level's depth. The cull runs in the GPU scene's existing caster
dispatch, one test per caster per level.

- **Auto by default.** It runs only on levels where the gate's threshold holds, measured per level at
  run time with the cost reading the node already takes. It reports its saved draws in the
  `TN_VIRTUAL_SHADOW` marker.
- **Deferred, not built:** `DynamicHZB` (a second pyramid). Revisit if the gate shows the dynamic part
  of a cached level dominates.

## Acceptance Criteria

- [ ] AC-1 [local]: A caster fully behind another caster in the light's view does not draw, a caster beside it does, and a caster over a receiver-free block does not. proof: red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: On the fixture that passed the gate, the finest two levels cost at least 20% less GPU time, and the frame p95 does not rise. proof: `node packages/playtest/dist/runner/cli.js perf`, cull on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Light-view caster cull | `VirtualShadowNode` levels past the measured threshold | Adds a test before the existing caster draw | AC-1, AC-2 |

## Execution Phases

#### Phase 1: How many caster draws are wasted?
**Status:** NOT STARTED
**Files:** `scripts/` (measurement script only)
- [ ] The three counts for the finest two levels on each PRD-457 fixture are recorded under `## Decisions`. proof: `pnpm tsx scripts/shadow-caster-waste.ts` (new, reads the corpus camera routes).
- [ ] A test cull pass is timed on the finest level, and the gate verdict is written. proof: the frame budget's `gpuMs` on the RTX 2080 browser lane, pass on against off.

#### Phase 2: The cull
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/src/render/depth-pyramid.ts`, `packages/core/__tests__/virtual-shadow.spec.ts`
- [ ] The light-view pyramid and the receiver bits cull casters as AC-1 states. proof: red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] AC-2 holds with the sheets posted on the PR. proof: the AC-2 command.

#### Phase 3: Native and judge
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/shadows/virtual/`, `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine culls the same casters. proof: `pnpm parity --target desktop --only-tests shadow-caster-cull`.
- [ ] A fresh visual judge returns NEUTRAL on the fixture's shadow frames, 2 runs per arm. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent.
**Verification:** AC-1 and AC-2.
