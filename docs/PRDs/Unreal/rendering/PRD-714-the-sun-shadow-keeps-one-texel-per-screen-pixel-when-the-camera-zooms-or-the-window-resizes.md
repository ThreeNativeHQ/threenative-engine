---
prd_contract: v1
---

# PRD-714 — The sun shadow keeps its texel size per screen pixel when the camera zooms or the window resizes

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the sun's clip levels use fixed half-widths of 16, 48 and 144 world units whatever the lens, so a zoomed camera shows blocky shadow edges and a wide lens wastes fill, while Unreal sizes every level from the camera.
**Complexity:** 5 (MEDIUM) — 2–3 core files (+1), a per-frame input that rebuilds cached levels (+1), the same rule on the owned engine (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-457](PRD-457-virtual-shadows-scale-by-measurement.md) Phase 1 for the counters it adds to the `TN_VIRTUAL_SHADOW` marker. Coordinates with `docs/PRDs/Unreal/shadows/PRD-652-the-shadow-tier-follows-unreal-shadow-quality-levels.md` (on `feat/unreal-look-epic`), which owns the tier bias this PRD adds to. Builds on [PRD-572](../../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md).

## Context

**Unreal LOC:** 831 for the directional clipmap (`VirtualShadowMapClipmap.cpp` 647 and `.h` 184). The lens rule is about 60 of those lines. **Port estimate:** about 150 to 200 lines in `packages/core/src/render/virtual-shadow.ts`, plus about 60 in the owned engine's clip-level code.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The camera sets the texel size.** The clipmap computes a scale from the camera: one half over the
  horizontal projection scale, times the largest virtual resolution over the camera viewport width
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:245-246`).
  It adds the base-2 logarithm of that scale to the tier's resolution bias, and never lets the
  sum go below 0 (`:251-254`). A narrower field of view or a wider viewport therefore asks for finer
  shadow pages. A wider field of view or a smaller viewport asks for coarser ones.
- **Dynamic resolution can be kept out.** `r.Shadow.Virtual.Clipmap.MinCameraViewportWidth` is 0 by
  default and clamps the viewport width from below. Its help text says the reason: a dynamic
  resolution drop must not push the shadow resolution too low (`:91-98`, `:228`, `:241`).
- **An orthographic camera uses its own width.** Depth does not shrink an orthographic scene, so the
  width comes from the clip-to-view scale, never below the viewport (`:232-240`). The first level is
  also lowered from that width (`:298-312`).
- **Levels double.** Each level has twice the radius of the one below it. The first level is 6 and
  the last is 22 by default (`:57-70`, `GetLevelRadius` at `:175`). The coarse levels 15 to 18 are
  always marked (`:71-84`).

### ThreeNative today

- `VirtualShadowNode` takes `clipExtents`, the half-width of each level in world units, default
  `[16, 48, 144]` (`packages/core/src/render/virtual-shadow.ts:93-99`, constant at `:459`). The level
  map has `mapSize` texels, the light's own shadow size. Nothing in the node reads the camera's
  projection or the render width.
- The default is right for a 60° vertical lens at 1080 px. Arithmetic, not a measurement: the finest
  level has a texel of 7.8 mm and a pixel of 17 mm at its 16 m hand-off, so 0.46 texel per pixel.
  The same ratio holds at 48 m and 144 m. At 15° it is 2.0 texels per pixel, so one texel covers two
  pixels and the edge is blocky. At 110° it is 0.19, so the level is five times finer than the eye can see.
- `ResolutionScaler` ([PRD-384](../../done/PRD-384-adaptive-resolution-gpu-headroom.md)) lowers the
  internal raster. The node does not know about it.
- A sniper scope, a binocular view and a zoom ability are normal in the templates' genres. The root
  rule says a constant the author must revisit later is a bug.

## Solution

**The gate first (Phase 1).** Report the texel-to-pixel ratio at each level's hand-off from the live
camera, in the `TN_VIRTUAL_SHADOW` marker. Sweep the field of view over 15°, 30°, 60°, 90° and 110°
and the render width over 960, 1920 and 3840 px on the starter. **Continue only if** the ratio leaves
0.25 to 1.0 at a field of view or width that a shipped template reaches. Otherwise record the table
under `## Decisions` and delete Phases 2 and 3.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Lens scale from projection scale and viewport width | `VirtualShadowNode` derives the default `clipExtents` from the camera's projection and the render width | core mechanism |
| `MinCameraViewportWidth` | option `minCameraViewportWidth`, default 0 | core mechanism |
| Orthographic width | the same derivation reads the orthographic span | core mechanism |
| Levels double | not copied: ThreeNative keeps its 3x ladder and scales all extents together | core mechanism |

- **Auto by default.** The derivation keeps the ratio that Phase 1 records at the 60° and 1080 px
  default, so a scene that does not zoom sees no change. A game that passes `clipExtents` owns them.
  The marker then says `extents: "authored"`.
- **No re-render storm.** An extent change moves every cached level. The scale snaps to a ladder of
  half-octave steps and changes only after the raw value leaves the current step by 10%. A smooth
  zoom then re-renders each level once per step, not once per frame.
- **Unreal names.** The new option is `minCameraViewportWidth`. The tier bias stays
  `resolutionLodBiasDirectional` (PRD-652).
- **Deferred, not built:** per-level page counts that change with the lens. ThreeNative draws whole
  levels, so only the extents move. Revisit if PRD-457 admits sparse pages.

## Acceptance Criteria

- [ ] AC-1 [local]: On the starter at a 15° and a 110° field of view, every level's texel-to-pixel ratio is within 20% of its 60° value. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: A visual judge returns IMPROVEMENT at 15° and NEUTRAL at 60° and 110° against the fixed extents, with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent — Evidence: pending.
- [ ] AC-3 [local]: A zoom from 60° to 15° over 120 frames re-renders each cached level at most 4 times. proof: the `TN_SHADOW_REFRESH` counters in the zoom scenario — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Lens-derived `clipExtents`, `minCameraViewportWidth` | `VirtualShadowNode` with no authored `clipExtents`, on every template that ships it | Replaces the constant `[16, 48, 144]` as the default. The option stays as the override | AC-1, AC-3 |

## Execution Phases

#### Phase 1: Does the fixed ladder miss at a lens a template reaches?
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow.ts` (marker field only), `packages/core/__tests__/virtual-shadow.spec.ts`
- [ ] The marker reports `texelsPerPixel` per level from the live camera, and a parser round trip returns it. proof: red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] The sweep table (5 fields of view by 3 widths) and the continue-or-stop verdict are recorded under `## Decisions`. proof: a `shadow-zoom` playtest scenario in the starter kit, `node packages/playtest/dist/runner/cli.js <scenario>.playtest.json --url <url> --browser-recipe webgpu`.

#### Phase 2: Extents from the lens
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/__tests__/virtual-shadow.spec.ts`
- [ ] The default extents scale with `1 / tan(fov / 2)` and the render width, snap to half-octave steps, and change only after a 10% exit. An authored `clipExtents` is untouched and reported. proof: red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] An orthographic camera takes its span, and `minCameraViewportWidth` clamps the width from below. proof: the same spec.

#### Phase 3: Judge and native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/shadows/virtual/`, `packages/runtime-native/conformance/scenes/shared/shadow-lens.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine derives the same extents from the same camera. proof: `pnpm parity --target desktop --only-tests shadow-lens`.
- [ ] AC-2 and AC-3 hold, with the sheets posted on the PR. proof: the AC-2 and AC-3 commands.
**Verification:** AC-1 to AC-3.

## Decisions

- 2026-10-21 (filing): the 3x ladder stays. Unreal doubles per level because its pages are sparse. A whole-level renderer pays for each extra level, so three levels at 3x is the cheaper shape.
