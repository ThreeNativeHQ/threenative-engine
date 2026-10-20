# PRD-488 — Foliage moves in the wind

**Status:** PROPOSED
**Priority:** P2 — Foliage is static; shared world origin across batches and a native row are unbuilt.
**Complexity:** 4 (MEDIUM) — 6–10 files (+2: `render/world-impostor-surface.ts`, `world-gpu-scene.ts`, one exported core node, a conformance case, the shooter's `palm.ts` and a new `wind.ts`); engine and Machinefall release separately (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-478](../done/open-world/PRD-478-open-world-frame-architecture.md) (shadow levels re-render only when the camera moves; its map-walk timing method is reused here). Related: [PRD-475](PRD-475-open-world-120-fps-without-visual-loss.md) (the 120 fps / no-visual-loss bar), [PRD-487](../Unreal/assets/PRD-487-imported-materials-keep-their-detail.md) (Unreal `T_WindNoise` reaches `userData` there)

## Context

Foliage never moves. Wind exists only for cloth: `SoftBody3D` takes a local-space `wind` (`packages/core/src/softbody.ts:51`), the platformer waves its flag on the CPU (`templates/platformer/src/render/props.ts:139`), and the starter's pennant is a soft body. No template or core file displaces a foliage vertex. (Template paths here are under `packages/create-threenative/`.)

A wind shader in a template is easy. Keeping it consistent across the engine's instancing paths is the hard part, because each path sees the instance differently:

- **Plain instancing:** the shooter's palms are `InstancedMesh`es of three prototype geometries (`templates/shooter/src/render/palm.ts:445`).
- **GPU scene:** it compacts visible instances into one shared matrix buffer that every main batch's `instanceMatrix` *is* (`packages/core/src/world-gpu-scene.ts:1323`). `instanceIndex` changes from frame to frame, so a phase keyed by index swims, and a new per-instance attribute would need a second compaction.
- **Runtime impostors** (`packages/core/src/render/world-impostor-surface.ts`): the surface owns `material.positionNode` (`:369–428`) and reads the instance matrix through `userInstanceMatrix` (`:463`), which handles both storage and plain attributes. A game has no way to add an offset to the impostor billboard, so a swaying tree would freeze when it becomes an impostor.
- **Virtual shadows:** after PRD-478 Phase 1, a level re-renders only when the camera moves (682 → 172 re-renders per walk on its first candidate). A caster that sways every frame would force a re-render every frame.

Megascans store their wind masks in vertex colours, and the UE5 importer leaves vertex colours out (`threenative-asset-mcp/docs/PRDs/done/ue5-editor-static-meshes.md`). Imported Fab foliage therefore arrives with no authored bend mask.

## Solution

- **Mechanism (core).** One exported TSL node gives the instance's world origin. It reads the same matrix every path already draws with, so the phase survives compaction, impostors and shadow passes without a new attribute. `WorldImpostorSurface` accepts a game-supplied offset node and applies it to the billboard.
- **Look (template source).** A new `templates/shooter/src/render/wind.ts` sets the sway: direction, gust curve, amplitude. Phase comes from the instance origin. Bend weight is the vertex's height over the instance's measured bounds, so no authored mask is needed (auto by default). An authored mask or `T_WindNoise` overrides it when present.
- **Shadows.** Cached virtual-shadow levels keep casters at rest pose, so wind adds no level re-renders. The stock shadow path re-renders every frame and sways for free.

## Decisions

- 2026-10-03 (agent, proposed): the phase comes from the instance's world origin, not a per-instance phase attribute. The compacted matrix buffer already carries the origin on every path. An attribute would need a parallel compaction in `world-gpu-scene.ts` and a copy in every impostor and shadow path.
- 2026-10-03 (agent, proposed): cached virtual-shadow levels draw casters at rest pose. Swaying them would undo PRD-478's re-render cut. Rest-pose shadows are judged under the blind A/B rather than proven identical.
- 2026-10-20 (shadow slicing): amended for near levels. Unreal sways foliage in every shadow level by default. [PRD-651](../Unreal/shadows/PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md) sways a caster in the levels whose texel resolves the sway, through the mover maps, and keeps the rest pose in coarser levels. This PRD still owns the wind itself. No box changed.
- 2026-10-03 (agent, proposed): importing Megascans' vertex-colour wind masks is out of scope. The height weight needs no importer change; a follow-up PRD takes the masks if the A/B shows the height weight bending trunks.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Instance-origin node | template `wind.ts` → foliage material `positionNode` on `InstancedMesh`, GPU-scene batches and impostors | none (new) | Phase 1 |
| Impostor offset hook | `WorldImpostorSurface` options ← game wind node | frozen impostor billboards | Phase 1 |
| Wind look | shooter palms; Machinefall map-walk forest | static foliage | Phases 2–3 |

## Execution Phases

#### Phase 1: The phase survives every instancing path
**Status:** NOT STARTED
**Files:** `packages/core/src/render/world-impostor-surface.ts`, `packages/core/src/world-gpu-scene.ts`, the exported node; `packages/runtime-native/conformance/registry.json`
- [ ] [local] One instance reports the same world origin from `InstancedMesh`, from a GPU-scene batch before and after a compaction reorder, and from its impostor. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts packages/core/__tests__/world-impostor-surface.spec.ts`.
- [ ] [local] A game offset node passed to `WorldImpostorSurface` moves the billboard by the same amount it moves the mesh at that instance. proof: `pnpm exec vitest run packages/core/__tests__/world-impostor-surface.spec.ts`.
- [ ] [local] The node compiles and draws on the native host. proof: a new instance-origin case in `packages/runtime-native/conformance/registry.json`, run by `pnpm parity`.

#### Phase 2: The template sways
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/shooter/src/render/wind.ts` (new), `templates/shooter/src/render/palm.ts`, `templates/shooter/playtests/wind.playtest.json`
- [ ] [local] Frond tips move between two captures 0.5 s apart, while trunk bases, buildings and the ground stay still. proof: `wind.playtest.json` under `pnpm test:templates`.
- [ ] [local] Wind-on stills show no visible loss against wind-off at three poses. proof: `pnpm visuals:ab --before <wind-off> --after <wind-on> --out <dir>` plus a fresh judge subagent.

#### Phase 3: The open world pays for it
**Status:** NOT STARTED
**Files:** Machinefall `apps/client/src/render/` (adopts `wind.ts`), `apps/client/playtests/scenes/map-walk.playtest.json`
- [ ] [local] On map-walk, wind adds at most 0.25 ms (3% of the 8.3 ms budget) to GPU p95 against wind-off in the same build, across 3 interleaved runs on the RTX 2080. proof: `TN_FRAME_BUDGET` windows from `playtest perf`, `gpuMain + gpuShadow`.
- [ ] [local] A stationary camera with wind on has the same virtual-shadow level re-render count as wind off. proof: `?tnFrameSpans=1` counters on two same-build runs.
- [ ] [local] A frame-by-frame judge finds no sway-phase jump where trees switch between mesh and impostor. proof: `scripts/visual-ab.ts` sequence at the switch distance, with impostors on.
