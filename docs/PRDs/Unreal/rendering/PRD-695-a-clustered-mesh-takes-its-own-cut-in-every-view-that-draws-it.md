---
prd_contract: v1
---

# PRD-695 — A clustered mesh takes its own cut in every view that draws it

**Status:** NOT STARTED
**Priority:** P1 — Phase 1 is open: a game with an orthographic camera (`camera.projection: "orthogonal"`) and any primitive of 65,536 triangles or more throws in `pixelsPerUnit` on every frame, because virtual geometry is on by default and its cut accepts only a perspective camera. Phases 2 and 3 (other views) are P3 behind their gate.
**Complexity:** 6 (MEDIUM) — 1–5 implementation files (+1), a per-view cut cache with draw-range slots is a new mechanism (+2), the cut now runs inside three's render and shadow callbacks (+1), state across frames: one cached cut per view (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. [PRD-602](PRD-602-a-clustered-shadow-caster-draws-what-its-shadow-texel-resolves.md) owns the directional shadow levels, and this PRD leaves them to it. Uses [PRD-600](PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md)'s pruned walk when it has shipped (optional). Composes with [PRD-694](PRD-694-traces-and-colliders-see-a-clustered-mesh-at-one-fixed-error-not-at-the-camera-cut.md), which owns the consumers that do not rasterize.

## Context

**Unreal size.** The view code is about 600 lines: packed views and their LOD scales
(`Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:195-441`, 247 lines,
`Engine/Shaders/Private/Nanite/NanitePackedNaniteView.ush`, 69 lines), the cube shadow emit in
`Nanite.cpp` (about 265 lines), and the local-light view setup in
`VirtualShadowMaps/VirtualShadowMapArray.cpp:5039-5103`. **Port estimate:** about 250 TypeScript
lines in `packages/core/src/clustered-mesh.ts` and `clustered-batch.ts`, and their specs.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Every view is a packed view with its own LOD scale.** The scale is half the projection's
  vertical term times the view height in pixels, divided by the pixel budget per edge
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:195-203`). A caller
  can multiply the budget per view (`NaniteShared.cpp:245`).
- **An orthographic view has no distance term.** The projected scale is 1 for every cluster, so the
  LOD scale alone sets the cut (`UE 5.8.3: Engine/Shaders/Private/Nanite/NaniteCullingCommon.ush:112-118`).
  Zoom and field of view enter through the projection term, never as separate inputs.
- **One cull pass serves many views.** A pass takes up to 4096 views
  (`UE 5.8.3: Engine/Shaders/Shared/NaniteDefinitions.h:76-78`).
- **A local light is one view per shadow face.** Each cube face or spot map of a local light is its
  own Nanite view, culled to the light radius
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:5039-5103`,
  radius at `:5090`). Directional clipmap levels are the same idea (`:4948-5035`), owned here by PRD-602.
- **A capture view picks its own budget.** Each surface-cache card page is a view, and its budget
  is scaled by the card's own LOD factor
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneRendering.cpp:3024-3035`).
- **A secondary view can borrow the main view for distance culling.** Culling-view overrides use the
  main view's origin and screen size for distance and screen-size tests
  (`NaniteShared.cpp:205-221`). The LOD scale stays the view's own.
- **Stereo views share one pass only for instanced stereo** (`NaniteShared.cpp:436-440`).
  ThreeNative ships no stereo target.

### ThreeNative today

- **The cut accepts a perspective camera only.** `pixelsPerUnit` throws for any other camera
  (`packages/core/src/clustered-mesh.ts:80-89`). A spec asserts the throw
  (`packages/core/__tests__/clustered-mesh.spec.ts:443`). It also ignores `camera.zoom`.
- **The engine ships orthographic cameras.** `createCamera` returns an `OrthographicCamera` for
  `projection: "orthogonal"` (`packages/core/src/game.ts:662-671`). The engine cuts every clustered
  mesh before each render (`game.ts:1827-1835`), so that game throws on every frame. Discrete LOD
  already handles orthographic cameras (`packages/core/src/model-lod.ts:63-79`).
- **The cut is the render camera's only.** Every other view draws whatever range the main camera
  left: three's point and spot shadow cameras, the `CubeCamera` of the probe bake
  (`packages/core/src/render/probe-volume.ts:720`), the orthographic impostor bake
  (`packages/core/src/render/world-impostor.ts:355`, `:454`), a mirror camera and a second viewport.
  A near probe gets far detail, and a far view pays for near detail. PRD-600 names the mirror case
  as a risk and adds a `viewCull = false` override for it.
- **three exposes the hooks.** It calls `onBeforeRender` per object per draw, before the draw reads
  `drawRange` (three 0.185.1 `src/renderers/common/Renderer.js:3579`), and `onBeforeShadow` with the
  shadow camera (`src/nodes/lighting/ShadowNode.js:61`).

## Solution

**Phase 1 fixes the throw and measures the other views.** The cut takes its scale from the
projection matrix, as Unreal does: half the vertical projection term times the target height. For
an orthographic camera the projected scale is 1, so the cut is uniform. Zoom follows from the same
matrix. The red spec that asserts the throw turns into a spec that asserts the orthographic cut.
Then a fixture renders a clustered mesh through a shadowed point light, the probe bake and the
impostor bake, and records the triangles each view draws against the cut its own camera wants.
**Gate:** continue to Phases 2 and 3 only if a template or example draws a clustered mesh in a
non-main view, or the fixture shows at least 2× excess triangles or a missing cluster in any view.
Otherwise record the verdict under `## Decisions` and delete Phases 2 and 3 (R4). The throw fix
ships either way.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Packed view LOD scale (`NaniteShared.cpp:195-203`) | `viewScale(camera, height)` in `clustered-mesh.ts`, from the projection matrix | core mechanism |
| One view per shadow face (`VirtualShadowMapArray.cpp:5039-5103`) | `onBeforeShadow` picks the cut for the shadow camera and its map size | core mechanism |
| Capture views with their own budget (`LumenSceneRendering.cpp:3024-3035`) | `onBeforeRender` picks the cut for any camera that is not the render camera, keyed by camera and target height | core mechanism |
| Many views per pass | each cached view cut lives in its own slot of the mesh's index buffer, and the hook only moves `drawRange` to that slot | core mechanism |
| Culling-view overrides (`NaniteShared.cpp:205-221`) | not ported: three culls whole objects per camera already | — |

- **Auto by default.** The engine picks each view's cut from that view's own projection and target
  height. `maxViewCuts` (default 8) bounds the slots. A view past the bound draws the nearest cached
  cut, and the mesh reports it in `TN_VIRTUAL_GEOMETRY` together with the slot memory.
- **Re-cut only on change.** A view re-cuts when its camera moves past `recutDistance` or its scale
  changes, as the main view does today.
- **PRD-600's `viewCull = false` override stays,** and it becomes a fallback for a view that three
  renders without either hook.
- **The look is untouched.** The game's material draws every cut.

**Left out on purpose:** stereo views (no target ships), directional shadow levels (PRD-602), and
non-raster consumers (PRD-694).

## Acceptance Criteria

- [ ] AC-1 [local]: A game with `projection: "orthogonal"` and a clustered mesh renders its frames with 0 console errors, and the drawn triangles fall when the orthographic size grows. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/game.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: In the fixture, each non-main view draws the cut its own camera selects, with 0 differences against a flat reference per view. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts -t "per view"` — Evidence: pending.
- [ ] AC-3 [local]: The desktop host draws the orthographic fixture and the point-light shadow fixture within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests clustered-views` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Projection-matrix view scale | `updateClusteredMeshes` from `game.ts` for any render camera | Replaces `pixelsPerUnit` and its perspective-only throw | AC-1 |
| Per-view cut slots | `onBeforeRender` and `onBeforeShadow` on `ClusteredMesh` and the batch bands | New. Other views stop drawing the main camera's cut | AC-2, AC-3 |

## Decisions

- 2026-10-21 (filing): Filed from the Nanite internals read. The feature map had no row for views
  other than the main camera and the directional shadow levels. The orthographic throw was found by
  reading `clustered-mesh.ts:80-89` against `game.ts:662-671`. It is an engine bug, not a game bug:
  every game with an orthographic camera and a dense primitive hits it.

## Execution Phases

#### Phase 1: An orthographic view takes a cut, and the other views are measured
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/game.spec.ts`
- [ ] The cut takes its scale from the projection matrix, an orthographic camera gets a uniform cut, and zoom changes the cut. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] A game loop with an orthographic camera and a clustered mesh runs 10 frames without a throw. proof: red-green `pnpm exec vitest run packages/core/__tests__/game.spec.ts -t orthographic`
- [ ] The fixture records drawn against wanted triangles for a point-light shadow face, a probe-bake face and an impostor-bake view, and the gate verdict is written under `## Decisions`. proof: `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts -t "view census"`

#### Phase 2: Every view draws its own cut
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/clustered-batch.spec.ts`
- [ ] The hooks move `drawRange` to the slot of the drawing view, a stationary view does not re-cut, and the ninth view draws the nearest cached cut and is reported. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts`
- [ ] A fresh visual judge compares a probe-baked scene and a point-light shadow before and after, two runs per arm, and returns NEUTRAL or IMPROVEMENT with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent

#### Phase 3: The owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/clustered-views.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host calls both hooks and draws each view's cut, or the PRD records which hook it lacks. proof: `pnpm parity --target desktop --only-tests clustered-views`
**Verification:** AC-1 to AC-3.
