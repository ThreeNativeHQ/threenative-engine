---
prd_contract: v1
---

# PRD-706 — An effect starts on the skin of a moving character

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the action-rpg Arcane Surge starts at the player's origin point, not on the player's body, and no gate has measured whether GPU skinning of sample points matches the drawn skin.
**Complexity:** 6 (MEDIUM) — 6–10 files: a new `mesh-emission-points.ts`, its spec, the index export, the gallery probe, the action-rpg template, a conformance scene and registry row (+2), a new public class (+2), previous-frame positions kept per point for velocity (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-609](../../done/PRD-609-a-gpu-burst-starts-where-and-when-it-is-asked-and-live-particles-stay-put.md) (done): the spawn kernel that reads the points. Respects [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) (§3): the points decide no look.

## Context

**Unreal LOC:** 16,554 lines: skeletal mesh sampling 10,206 (`NiagaraDataInterfaceSkeletalMesh*`,
`NDISkeletalMesh_*`, `NDISkeletalMeshCommon.h`) and static mesh sampling 6,348
(`NiagaraDataInterfaceStaticMesh*`, `NiagaraDataInterfaceStaticMeshUvMapping.*`). Most of it is
bone, socket, vertex, UV-mapping and region sampling that this PRD does not port. **Port estimate:**
about 300 to 450 ThreeNative lines: about 180 in core, about 180 of specs, and a conformance scene
of about 60.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Three skinning modes.** None reads the reference pose. Skin-on-the-fly skins only the
  triangles and vertices a script reads. Pre-skin skins the whole mesh up front
  (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Classes/NiagaraDataInterfaceSkeletalMesh.h:341-362`).
  The default is skin-on-the-fly
  (`Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraDataInterfaceSkeletalMesh.cpp:2520`).
- **The sample is a triangle and a barycentric coordinate.** Skinned reads return the position, the
  normal and a velocity, and can interpolate between the previous and the current frame for a
  spawn inside the frame
  (`Engine/Plugins/FX/Niagara/Source/Niagara/Private/NDISkeletalMesh_TriangleSampling.cpp:141-168`).
- **It reads the current frame by default.** `bRequireCurrentFrameData` is true, so the effect
  ticks after the mesh's animation. Turning it off reads last frame's data and runs earlier
  (`NiagaraDataInterfaceSkeletalMesh.h:782-785`).
- **Area weighting is opt-in per mesh.** A triangle pick is weighted by area only when the mesh LOD
  sets `bSupportUniformlyDistributedSampling`
  (`NDISkeletalMesh_TriangleSampling.cpp:701-703`). That flag is off by default for skinned meshes
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Classes/Engine/SkinnedAssetCommon.h:359`) and is a field on
  static meshes too (`Engine/Source/Runtime/Engine/Classes/Engine/StaticMesh.h:1313`).
- **The weighted pick is an alias table.** Two random numbers pick an entry: the first chooses a
  slot, the second compares against that slot's probability and takes the slot or its alias
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Public/WeightedRandomSampler.h:40-45`). The static mesh
  interface uploads the table to the GPU when it exists
  (`Engine/Plugins/FX/Niagara/Source/Niagara/Private/DataInterface/NiagaraDataInterfaceStaticMesh.cpp:70-71, 496-497`).

### ThreeNative today

- The action-rpg Arcane Surge bursts at `player.mesh.position`
  (`packages/create-threenative/templates/action-rpg/src/scenes/Play.ts:425`). The player is the
  skinned `mannequin-combat.glb` (`Play.ts:109`). The effect does not touch the body.
- three ships `MeshSurfaceSampler` as an addon
  (`packages/core/node_modules/three/examples/jsm/math/MeshSurfaceSampler.js:46`). It samples a static
  geometry on the CPU, weighted by area. It does not skin, and it does not run in a kernel.
- No core module turns a skinned surface into GPU points. `engine_search_capabilities` for "spawn
  particles on the surface of an animated skinned character" returned `SkeletalMesh3D` and
  diagnostics only (2026-10-21).
- `renderer.projection` can draw repeated skinned rigs as one palette draw (capability
  `renderer.projection`). Points must read the same pose the draw shows.

Layer: engine. A game can sample a static mesh with the three addon in a few lines, so the static
case stays game source. Skinning sample points with the pose of this frame needs the bone palette
at the time the engine uploads it, on web and on the native host. A game cannot reach that
portably, so the framework owns it.

## Solution

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Triangle and barycentric samples | `MeshEmissionPoints` (`@alias skeletal mesh sampling, static mesh sampling, emission points`) in `packages/core/src/mesh-emission-points.ts` (new). It bakes `count` samples once, weighted by area | core |
| Alias table | The bake uses an alias table, so a resample is O(1). The table stays on the CPU | core |
| Skin-on-the-fly, current frame | A compute-driven kernel at render cadence skins each sample with the mesh's current bone palette after the animation update and writes `positions`, `normals` and `velocities` storage buffers | core |
| Velocity and sub-frame interpolation | Velocity is current minus previous position over the frame time. Sub-frame interpolation is deferred (see Decisions) | core |
| Static mesh | The same class with no skin step: one transform by the world matrix | core |
| What spawns, where, how many | The game's `spawn` kernel reads `points.position(i)`, `points.normal(i)` and `points.velocity(i)` | the game's `src/render/` |

- **Auto by default.** Area weighting is on, because the engine can measure triangle area. Unreal
  turns it on only by a mesh flag. A game that wants a uniform triangle pick passes
  `weighting: "triangle"`.
- The name follows Godot's "emission points". Godot bakes them only from static meshes.

Risks:

- Three's skinning node is written for the vertex stage. Phase 1 proves a compute kernel can read
  the same palette without a second skinning path in the native host.
- A projected palette draw may update the pose on a different tick. Phase 1 measures the gap.

## Acceptance Criteria

- [ ] AC-1 [local]: Over a two-second run clip of the mannequin, every skinned sample lies within 1 cm of the drawn skin. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/skin-points.playtest.json --url http://127.0.0.1:5189 --server-command 'pnpm --filter vfx-gallery dev --host 127.0.0.1 --port 5189 --strictPort' --browser-recipe webgpu --live-clock` — Evidence: pending.
- [ ] AC-2 [local]: 4,096 skinned points cost at most 0.1 ms GPU on the RTX 2080 browser WebGPU lane. proof: the same playtest's `compute` bucket reading — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `MeshEmissionPoints` | `ctx.add(new MeshEmissionPoints(player skin, { count }))`, then the surge `spawn` kernel in action-rpg `src/render/vfx.ts` | Replaces the surge's origin-point line burst | Phase 3, AC-1 |
| Capability search | `engine_search_capabilities "particles on a skinned character"` | New entry with the Unreal terms as `@alias` | Phase 2 |

## Execution Phases

#### Phase 1: Can a kernel skin points with the pose the frame draws, and what does it cost?
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/scenes/skinPointsProbe.ts` (new), `examples/vfx-gallery/playtests/skin-points.playtest.json` (new)
**Implementation:** a throwaway kernel skins 4,096 area-weighted samples of the mannequin with its current bone palette. A `GPUReadback` returns them, and the probe compares each one with the same point skinned on the CPU from the pose of the drawn frame. **Gate:** continue only if the largest error is at most 1 cm on web, the desktop host gives the same answer, and the kernel costs at most 0.1 ms. Otherwise record the result under `## Decisions` and delete Phases 2 and 3 (R4).
- [ ] The web probe prints the largest error and the GPU cost on a named WebGPU adapter. proof: the AC-1 playtest command.
- [ ] The desktop host prints the same two numbers. proof: `node packages/playtest/dist/runner/cli.js examples/vfx-gallery/playtests/skin-points.playtest.json --target desktop --executable <pkg>`.

#### Phase 2: The emission points
**Status:** NOT STARTED
**Files:** `packages/core/src/mesh-emission-points.ts` (new), `packages/core/__tests__/mesh-emission-points.spec.ts` (new), `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] The area-weighted bake puts samples on triangles in proportion to area within a chi-square bound, `weighting: "triangle"` picks triangles uniformly, and a mesh with no triangles throws. proof: red-green `pnpm exec vitest run packages/core/__tests__/mesh-emission-points.spec.ts`.
- [ ] A skinned point matches the CPU-skinned point within 1e-4 m for a fixed pose, and its velocity equals the position change over the frame time. proof: red-green `pnpm exec vitest run packages/core/__tests__/mesh-emission-points.spec.ts`.
- [ ] A capability search for "particles on a skinned character" returns `MeshEmissionPoints`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: The surge starts on the body, judged, and native
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/src/render/vfx.ts`, `packages/create-threenative/templates/action-rpg/src/scenes/Play.ts`, `packages/create-threenative/templates/action-rpg/AGENTS.md` (and mirror), `packages/runtime-native/conformance/scenes/shared/mesh-emission-points.js` (new), `packages/runtime-native/conformance/registry.json`
**Verification:** this changes what reaches the screen. Visual criteria: the surge particles start on the player's body and follow it while it runs, none start in the air beside it, and the colour and timing stay as before.
- [ ] The surge spawns from the player's emission points, the combat scenario stays green, and a fresh visual judge returns IMPROVEMENT with no REGRESSION frame. proof: `pnpm test:templates` (action-rpg) and headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `mesh-emission-points` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests mesh-emission-points`.
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-21 (filing): no bone, socket, vertex, UV-mapping or region sampling. Each needs its own consumer. Revisit bone sampling when a template attaches an effect to a named bone that a `SkeletalMesh3D` attachment cannot hold.
- 2026-10-21 (filing): no sub-frame interpolation. PRD-609 bursts are instants, and its decision defers sub-frame spread. Revisit with that spread.
- 2026-10-21 (filing): no GPU alias table. The bake runs once on the CPU. Revisit when a game resamples a mesh every frame.
