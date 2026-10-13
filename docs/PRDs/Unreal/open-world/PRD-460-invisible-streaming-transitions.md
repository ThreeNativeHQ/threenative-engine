# PRD-460 — Invisible streaming: a dithered fade for arriving props and a crossfade across LOD levels

**Status:** NOT STARTED
**Priority:** P2 — Props still pop at hard culls and LOD switches; dithered arrival fade unbuilt.
**Complexity:** 6 (MEDIUM); risk override: none. About 7 implementation files across `core` and the example's render source, a new per-instance attribute on every batch, and a fade timeline that has to survive an eviction mid-ramp.
**Owner:** unassigned (drafted by Claude, 2026-09-26)
**Depends on:** PRD-459 (the admission budget owns *when* a batch appears; this PRD owns *how* it appears). Prerequisite landing separately: transparent scatter drawn as cutout, and multi-primitive scatter assets.

## Context

Props pop in on Machinefall's 2 km map in two ways, and both are hard switches in the code rather
than a missing effect:

- **Arrival and cull.** 134 of the 218 assets carry `maxDistance` 70 m, and each is culled hard at
  `maxDistance − maxDistance/8` (`cullDistance`, `packages/core/src/world-cells.ts:3456`). An instance at the cull
  distance is in one frame and gone the next.
- **LOD switch.** The packaged `lods` switch at 60 m is a rebuild into the other level's batch. The
  source says so: *"ponytail: a hard switch, no crossfade — a placement crosses a level boundary by
  being rebuilt into the other level's batch, so the swap pops. A blend needs a per-instance mix the
  InstancedBatch has no slot for"* (`packages/core/src/world-cells.ts:6774`), and the guide repeats it
  (`docs/guides/world-streaming.md:208`).
- **Cells at the ring edge** appear at the residency boundary, so a 25-cell ring puts a visible seam
  of new geometry at the edge of view.

Terrain already does this correctly and is the precedent, not the work: a tile's LOD change morphs
vertex positions over `LOD_TRANSITION_FRAMES = 3` (`packages/core/src/world-tiles.ts:229`).
[PRD-566](../../done/PRD-566-terrain-lod-morphs-on-the-gpu-and-picks-by-screen-error.md) moves that morph to
the GPU; it stays out of this PRD. Scatter has no equivalent because the mix is per instance and `InstancedBatch` writes
only `instanceMatrix` (`packages/core/src/instanced-batch.ts:236-238`).

Three constraints decide the mechanism:

1. **The mix is the engine's; the appearance is the game's.** `InstancedBatch` decides nothing about
   how a batch looks (`packages/core/src/instanced-batch.ts:68`), so the engine ships a per-instance
   attribute and a timeline, and the game ships the material that reads it.
2. **The shader must be TSL.** Raw GLSL `ShaderMaterial` is excluded under WebGPU
   (`packages/runtime-native/conformance/registry.json`, `raw-glsl-shader-material-webgpu`), so a
   dithered fade is a node material in game render source.
3. **The cutout convention is already in the way, on purpose.**
   `packages/core/src/render/alpha-antialiasing.ts` converts cutouts to alpha-to-coverage and its
   `isCutout` deliberately refuses `transparent` and `alphaHash` materials (`:37`). Stochastic
   alpha *is* `alphaHash`, and a material cannot be both alpha-to-coverage and stochastic, so the
   fading surface and the convention must never claim the same material in one frame.

### What Unreal does (UE 5.8.3, read 2026-10-09; clean-room summary, no code copied)

- **A cull fade needs no per-instance state.** Instanced meshes fade by distance alone. Each batch
  carries a start distance and the reciprocal of the fade span, scaled by the view-distance setting.
  The shader computes each instance's opacity from its own distance
  (`Engine/Source/Runtime/Engine/Private/InstancedStaticMesh.cpp:1372-1390`). Nothing is timed and
  nothing waits for a release.
- **A whole-object distance-cull or arrival fade is a short timed ramp held per object per view.**
  The default is 0.25 s (`r.LODFadeTime`, `Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:307-308`).
  Only primitives that opt in (`IsUsingDistanceCullFade`) get it (`SceneVisibility.cpp:521`). Each
  fading primitive keeps a linear scale and bias and an end time (`SceneVisibility.cpp:1112-1134`).
- **A mesh LOD crossfade is not per object.** The view keeps two samples of its own origin and
  picks each mesh's LOD from both. One shared transition value, from 0 to 1 across the lag
  (`lod.TemporalLag`, default 0.5 s), dithers between the two picks
  (`Engine/Source/Runtime/Engine/Private/SceneManagement.cpp:28-32` and `:96-105`). No per-object
  state exists, so a re-crossing needs no reversal there.
- **A re-crossing mid-fade reverses direction and keeps the current opacity.** The bias is solved
  so that the opacity is continuous, and the end time is recomputed (`SceneVisibility.cpp:1139-1160`).
- **Only nearby movement fades.** A fade starts only inside a travel band
  (`r.DistanceFadeMaxTravel`, default 1000 Unreal units, which is 10 m, `SceneVisibility.cpp:310-311`,
  used at `:492`). A camera cut, a large camera move or a long gap since the last render disables
  distance fades (`SceneVisibility.cpp:5568-5585`, read at `:864` and `:1188`), so a teleport pops
  instead of fading everything at once. The LOD lag path honors the same flag
  (`SceneManagement.cpp:108-111`).
- **Stencil LOD dither is off by default.** `r.StencilForLODDither` (default 0,
  `Engine/Source/Runtime/Renderer/Private/DepthRendering.cpp:67-71`) trades `clip()`, which disables
  early-Z, for a stencil test in a full depth prepass. Three's WebGPU path draws no such prepass, so
  this PRD does not adopt it (see Decisions). The early-Z cost of `discard` on tile GPUs is measured
  instead.

## Solution

A per-instance mix slot on every batch, a fade timeline in `WorldCells`, and a crossfade that keeps
a crossing placement drawn by both levels at complementary mixes.

1. **`InstancedBatch` gains one per-instance float attribute** (`fade`, 0 = invisible, 1 = fully
   drawn) with a settable per-index value and the attribute exposed for a game material to bind. It
   writes no appearance and picks no threshold; a batch with no fade in use carries the same cost as
   today.
2. **Cull fades by distance; arrivals and level swaps by time.** The cull fade follows Unreal's
   instanced form: each batch exposes its fade start and the reciprocal of its fade span as
   uniforms, derived from the asset's `maxDistance` and the existing `maxDistance/8` band. The
   game's material computes the instance's mix from distance, so a cull needs no per-instance
   timeline and no held release. An instance is released only beyond the band's far end, where its
   mix is already 0. **Arrivals** (a newly admitted or rebuilt batch) ramp 0 → 1 over a
   game-supplied `fadeMs`, and the guide cites Unreal's 0.25 s (cull and arrival) and 0.5 s (LOD lag) as reference values, not
   as defaults. An arrival fades only when the follow point moved less than one cell since the last
   update. A jump, which PRD-459's admission already detects, admits without a fade. Culling and
   LOD switching keep **hysteresis**: the gate re-arms only past half the band, so an instance on
   the gate does not flicker.
3. **A level switch crossfades instead of rebuilding.** A placement that crosses a level boundary
   is drawn by both levels for `fadeMs` with complementary mixes (summing to 1), then the old level's
   copy is dropped. A placement that re-crosses mid-crossfade **reverses from its current mix**:
   the ramp's bias is re-solved so the mix is continuous, as Unreal does for its per-object cull fade. It never restarts from 0
   or 1. This replaces the rebuild-into-the-other-level path at the hard-switch note
   (`packages/core/src/world-cells.ts:6774`).
4. **The dither material is generated game source.** The screen-door threshold, the pattern, the
   colour and the duration are the game's; the example's `src/render/` carries the reference
   implementation the guide points at.

**Non-goals:** terrain (it morphs already), chunk GLB fades, shadows, and any change to what a cell
draws — only how a drawable arrives and leaves.

**Risks:**
- A fading instance must still be culled correctly: a per-instance mix is not a cull, so an
  in-fade instance at the cull boundary keeps its slot and the batch's bounding sphere must still
  cover it.
- Alpha-to-coverage and a stochastic fade fight over the same material (see constraint 3); the
  report in `alpha-antialiasing.ts` is the place that conflict must be visible.
- Native: `27-instanced-mesh` is an implemented, desktop-gated conformance case
  (`packages/runtime-native/conformance/registry.json`), so the instanced path is proven there, but a
  native fade claim needs its own run. No mobile claim without a device run.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: every arriving instance passes through at least two distinct mix values before reaching full coverage, a culled instance's mix falls with distance across the band and it is released only at mix 0, and an arrival after a follow-point jump admits at full coverage with no fade — proof: `pnpm --filter @threenative/core test world-cells-fade` — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: no instance's mix changes by more than one fade step per frame while it is partially covered, reported through the public path and asserted by a playtest across an admission and a LOD switch — proof: `pnpm --filter @threenative/core test world-cells-fade` and `pnpm --filter abyss-framework playtest:world` — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: a placement crossing a level boundary is drawn by both levels during the crossfade with complementary mixes summing to 1 ± 0.01, and the pre-change hard switch fails this — proof: `pnpm --filter @threenative/core test world-cells-fade` — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: a follow path oscillating across the cull gate does not thrash batch rebuilds, hysteresis holds the mix stable within the band, and a placement re-crossing a level boundary mid-crossfade reverses with no mix jump larger than one fade step — proof: `pnpm --filter @threenative/core test world-cells-fade` — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: the fading surface and the alpha-to-coverage convention never claim the same material in one frame, reported through the existing `alpha-antialiasing` report — proof: `pnpm --filter @threenative/core test alpha world-cells-fade` — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: the `world-flythrough` playtest captures consecutive frames across a cell admission and a LOD switch; no instance goes from 0 to full coverage within one frame, and the captures are reviewed — proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.playtest.json --url … --browser-recipe webgpu` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Per-instance mix slot | A game builds a batch with `InstancedBatch`; the attribute is bound by the game's TSL material | No per-instance channel existed; the hard-switch `ponytail:` note at `world-cells.ts:6774` is retired | AC-1, AC-3 |
| Fade timeline | Cell admission, `maxDistance` cull and `lods` switching, all inside `WorldCells.update` | Hard cull and hard level swap | AC-1, AC-3, AC-4 |
| Dither material | Generated source in `templates/*/src/render/` for a template that streams a world, plus the reference copy in `examples/abyss-framework/src/render/` and the guide | Nothing; a game's own appearance, kept in game source | AC-2, AC-6 |
| Playtest capture check | The scenario's `steps` + screenshots, asserted through the entity's reported counters | New | AC-6 |

## Decisions

- 2026-10-09 (João, via the Unreal-source review request): the cull fade is distance-driven per
  batch, as Unreal's instanced meshes do it, instead of a per-instance timeline. This removes the
  "eviction mid-ramp" state from the cull path. The timed ramp remains only for arrivals and level
  crossfades.
- 2026-10-09 (João, via the same request): stencil LOD dither is not adopted. Unreal ships it off by
  default, and it needs a full depth prepass that three's WebGPU renderer does not draw. The dither
  stays a `discard` in the game's material; Phase 3 measures its cost.
- 2026-10-12 (Unreal source review): Unreal's 0.25 s `r.LODFadeTime` ramp is the per-object distance-cull and arrival fade. Its mesh LOD dither is a different mechanism with one shared 0.5 s lag per view and no per-object state. This PRD keeps a per-placement mix and a reversal for the level crossfade, because ThreeNative has no shared two-origin scheme. The reversal rule is therefore ThreeNative's own design, taken from the cull path. Line numbers for repo files were refreshed.

## Execution Phases

#### Phase 1: The mix slot and the timeline

**Status:** NOT STARTED
**Files:** `packages/core/src/instanced-batch.ts` (per-instance attribute), `packages/core/src/world-cells.ts` (fade in, fade out, hysteresis), `packages/core/__tests__/world-cells-fade.spec.ts`.
**Implementation:** the attribute plus a per-index setter; arrival ramps and the held cull ramp; the cull gate re-arms only past the hysteresis band. No material, no threshold, no colour.
**Verification:** `pnpm --filter @threenative/core test world-cells-fade` — AC-1, AC-4; the existing `world-cells` suite must stay green.
- [ ] per-instance attribute written and readable per index. proof: `pnpm --filter @threenative/core test instanced-batch`
- [ ] distance-driven cull fade, timed arrival ramp skipped on a jump, and hysteresis. proof: `pnpm --filter @threenative/core test world-cells-fade`
- [ ] cutout convention and the fading surface never overlap. proof: `pnpm --filter @threenative/core test alpha`

**Checkpoint:** pending

#### Phase 2: The level crossfade and the game's dither

**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts` (dual-level draw with complementary mixes), generated source under `packages/create-threenative/templates/*/src/render/` for the template that streams a world, `examples/abyss-framework/src/render/`, `docs/guides/world-streaming.md`.
**Implementation:** the crossing placement lives in both level batches for the crossfade window; the dither is a TSL node material reading the mix attribute, with a reference implementation in the example and the template source generated for games.
**Verification:** `pnpm --filter @threenative/core test world-cells-fade` — AC-3; `pnpm check:docs` for the guide.
- [ ] dual-level draw with complementary mixes, red against the hard switch. proof: `pnpm --filter @threenative/core test world-cells-fade`
- [ ] TSL dither material in generated source, reference copy in the example. proof: `pnpm --filter abyss-framework build`
- [ ] guide documents the recipe and what the game owns. proof: `pnpm check:docs`

**Checkpoint:** pending

#### Phase 3: The observed gate

**Status:** NOT STARTED
**Files:** `examples/abyss-framework/playtests/world-flythrough.playtest.json`, `examples/abyss-framework/src/scenes/WorldProbe.ts` (report the max per-frame mix step and the crossfade count).
**Implementation:** the probe reports what the assertion needs; the scenario captures the frames around an admission and a level switch.
**Verification:** the playtest run — AC-2, AC-6, plus a capture reviewed by eye.
- [ ] probe reports the per-frame mix step and crossfades. proof: `pnpm --filter abyss-framework build`
- [ ] playtest asserts no 0 → full coverage in one frame and keeps its residency assertions. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.playtest.json --url 'http://127.0.0.1:5181/?world' --browser-recipe webgpu`
- [ ] native instanced path re-checked on the desktop host; no claim beyond that run. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.desktop.playtest.json --target desktop --executable <pkg>`

**Checkpoint:** pending
