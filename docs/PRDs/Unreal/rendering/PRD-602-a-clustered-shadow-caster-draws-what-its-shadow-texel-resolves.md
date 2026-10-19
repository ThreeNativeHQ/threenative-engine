# PRD-602 — A clustered shadow caster draws what its shadow texel resolves

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 measurement gate and the per-level shadow cut are unbuilt, and the shadow cost of clustered casters has never been measured.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (+1), a second cut keyed by shadow texel is a new path in the shadow node (+2), cached shadow levels must stay valid when the camera cut changes (+1), native proof on the owned host (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Uses [PRD-600](PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md)'s view-pruned walk when that has shipped, and a flat scan with a per-cluster sphere test when it has not. Respects [PRD-457](PRD-457-virtual-shadows-scale-by-measurement.md), [PRD-538](../../done/PRD-538-shadow-maps-redraw-only-what-streamed-in.md) and [PRD-377](../../assets/PRD-377-auto-lod-is-on-by-default.md) (no independent shadow proxy meshes in its v1, so this PRD derives the shadow cut from the same DAG and adds no second mesh).

## Context

`VirtualShadowNode` (`packages/core/src/render/virtual-shadow.ts:849`) renders a clipmap of shadow levels. Each level has a window and a texel size. A level's texel is `2 * extent / mapSize` (documented at `virtual-shadow.ts:190`). The node already shrinks what coarse levels draw in two ways.

- **A texel gate** hides every caster too small for the level (`#probe`, `virtual-shadow.ts:1626`, option `minCasterTexels`).
- **A geometry swap** gives a registered AutoLOD chain its coarsest geometry past the finest level (`shadowLodBias`, default true, `virtual-shadow.ts:211`, `:1146`). The swap is applied in `#probe` (`virtual-shadow.ts:1693-1701`) and undone by `#restoreHidden` (`virtual-shadow.ts:1921`).

A `ClusteredMesh` is in neither case. Its geometry is not a registered chain, because PRD-377 forbids wrapping a clustered mesh in a discrete chain (`lodChainOf`, `packages/core/src/model-lod.ts:1124`). No code in `clustered-mesh.ts` or `clustered-batch.ts` handles shadows. A clustered mesh with `castShadow` is a layer-0 caster that every level draws (`IVirtualShadowDraws.layer0`, `virtual-shadow.ts:330`). It draws the index range that the main camera chose. The batch README says "shadows draw one coarse cut, fixed at load" ([README](../../done/nanite-like/README.md), decision 5). The code does not do that. The shadow pass submits the camera cut, and three culls the mesh as a whole by its bounding sphere only.

That has two costs, and the second one is a quality fault.

- **Detail the texel cannot hold.** The camera cut is fine near the camera and is drawn into every level. A 4 m clipmap texel cannot resolve a 1-pixel error at 7 m. The level still pays for it.
- **Detail the camera does not show.** A far mountain is coarse in the camera cut. It casts a long shadow into the near view, and that shadow is built from the coarse silhouette, even when the shadow texel could resolve far more. A cached shadow page can also go stale when the camera cut changes. The node's automatic mover detection watches world matrices, instance matrices and deformation (`staticAfterFrames`, `virtual-shadow.ts:212-218`). It does not watch an index range. Phase 1 checks whether this happens.

Nothing measures the cost. The quarry has a sun and no shadows (`examples/quarry/src/render/look.ts:36`), so its numbers say nothing about this. Phase 1 adds shadows to the quarry behind a flag and prices the problem.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Every shadow level is its own Nanite view.** A clipmap adds one view per level, each with its own view matrices, and the view list goes to the same cull that serves the main camera. So each level picks its own cut and prunes by its own window. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:4948-4960`, `:5009-5035`.
- **Shadows accept more error than the main view.** The error budget for shadow views is the main pixel budget times a multiplier. The multiplier comes from a LOD bias cvar that defaults to 1.0, so the default shadow budget is two texels of edge error instead of one pixel. The multiplier also folds in the streaming quality scale. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Shadows/ShadowSceneRenderer.cpp:48-52`, `:142-145`, and `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:245`.
- **The same node and cluster tests run for a shadow view.** A node outside the level window is rejected before its subtree is expanded. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteClusterCulling.usf:478-499`.
- **Shadow views can be budgeted on their own.** A separate time budget and a separate lower limit scale the shadow error when the pass runs over budget. Both default to off. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:337-342` and `:350-354`. ThreeNative's level gate scale (`gateScale`, `virtual-shadow.ts:632`) is the matching lever for casters, so this PRD adds no second budget.

## Solution

1. **Measure first (Phase 1).** The quarry look gets a `?shadows=virtual` switch. It mounts `VirtualShadowNode` on the sun and sets `castShadow` on the cliff and the boulders. Default arms stay unchanged, so every earlier quarry number stays valid. The measurement runs the `virtual` arm twice, with the clustered casters casting and not casting. The difference in `gpuMs` is the price. The VSM stats marker gains a per-level triangle count, so the price is also known per level. **Gate:** continue only if clustered casters cost at least 0.5 ms of median `gpuMs` on the browser at 1080p, or at least 15% of the time the shadow levels take. Otherwise record the decline under `## Decisions` and delete Phases 2 and 3 (R4).
2. **A texel cut per level (Phase 2).** `ClusteredMesh` gets `shadowGeometry(texelWorld, window)`. It returns a geometry that shares the mesh's vertex attributes and holds its own index range. The range holds the cut where each cluster's world error (its error times the mesh's largest axis scale) is at or below `shadowErrorTexels` times the texel size, and its parent's is above. The default is 2 texels, which is where Unreal's default bias lands. A cluster whose bounds miss the level window is left out. The cut does not read the camera at all. It is watertight for the same reason the camera cut is: parent error never falls below child error, and every sibling shares one parent error. The result is cached per level by texel size and window. `ClusteredBatch` does the same with one shadow instanced mesh per level, cut at the largest copy scale in the window, so no copy gets a coarser cut than its size allows. In `#probe`, a caster that is a clustered mesh or batch gets its level geometry at every level, finest included. `#restoreHidden` puts the camera geometry back, in the same way it restores a coarsened chain. Because the shadow cut ignores the camera, a camera-driven re-cut no longer changes a cached shadow page.
3. **Consumer flow.** A game builds a `VirtualShadowNode` and loads a model with the virtual geometry extension. It sets `castShadow` as it does today. The shadow node calls `shadowGeometry` when it prepares a level. The observable result is fewer triangles per shadow level and a far caster whose shadow keeps its detail. A named `shadowErrorTexels` on the mesh overrides the default. The object reports the override.

**Look is untouched.** Nothing here chooses a material, a bias or a filter. The error budget is a mechanism number, and the game can move it.

**Risks:**

- **Memory.** Each level holds one index buffer per caster. A clipmap with six levels holds at most six small buffers per mesh. They count against the same GPU memory report as the camera cut's buffer.
- **Finest level cost.** The finest level at a 2 cm texel wants nearly the full detail inside its window. The window prune keeps this to the part of the mesh inside the window. A flat scan with a sphere test serves until PRD-600 ships the pruned walk.
- **Seam between levels.** Two levels cut the same mesh differently. Each level is its own map, so no crack can show between them. The visual judge checks the blend zone between levels.
- **Native.** Conformance case `33-virtual-shadow` proves the node runs on the host. A clustered caster needs its own desktop run. If the host cannot run it, the PRD makes no native claim for it.

**Left out on purpose:** local-light shadows (the clipmap is the directional path), tessellation and displacement fades in shadows (they need displacement materials, which decide the look), and any new time budget.

## Acceptance Criteria

- [ ] AC-1 [local]: For 100 seeded pairs of texel size and window, the shadow cut equals an independent flat reference, contains 0 clusters that miss the window, leaves 0 open interior edges, and does not change when the camera moves. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: With `?shadows=virtual` on the quarry route at 1080p on a named WebGPU adapter, the `virtual` arm's `gpuMs` falls by at least half of the difference that Phase 1 recorded between casting and not casting, with 0 console errors. proof: `pnpm --filter quarry measure -- --arm virtual --url 'http://127.0.0.1:5191/?shadows=virtual'` — Evidence: pending.
- [ ] AC-3 [local]: The same route on the desktop host draws the shadow cut with no frame-op replay error, or the PRD records that the host cannot run the node. proof: `pnpm --filter quarry build:desktop && pnpm --filter quarry pack:native && pnpm --filter quarry measure -- --arm virtual --target desktop` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Texel cut for a clustered caster | `VirtualShadowNode.#probe` asks the caster for its level geometry on every level it renders | The camera cut drawn into shadow levels is replaced for clustered casters | AC-1, AC-2 |
| Shadow cut for a batch | The same probe, for `ClusteredBatch` roots | The batch's per-band camera cuts stop feeding shadow levels | AC-1, AC-2 |
| Per-level triangle count in the stats marker | `readVirtualShadowMarker` readers and the quarry `measure` script | New read-only field | Phase 1 |

## Execution Phases

#### Phase 1: Price the shadow bill of clustered casters
**Status:** NOT STARTED
**Files:** `examples/quarry/src/render/look.ts`, `examples/quarry/scripts/measure.ts`, `packages/core/src/render/virtual-shadow.ts`
**Implementation:** the `?shadows=virtual` switch, a per-level triangle field in the stats marker, and the casting-on and casting-off runs. The gate verdict goes under `## Decisions`.
- [ ] The `virtual` arm is measured with clustered casters casting and not casting, on the browser at 1080p. The `gpuMs` difference and the per-level triangle counts are recorded here, together with whether a cached shadow page keeps an old cut after the camera cut changes. proof: `pnpm --filter quarry measure -- --arm virtual --url 'http://127.0.0.1:5191/?shadows=virtual'` and the same with the casters set not to cast
- [ ] The same pair of runs is recorded on the desktop host. proof: `pnpm --filter quarry measure -- --arm virtual --target desktop`

#### Phase 2: A clustered caster draws its level's cut
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `packages/core/src/render/virtual-shadow.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/clustered-batch.spec.ts`
**Implementation:** `shadowGeometry` on the mesh and the batch, the cache per level, the swap and restore in `#probe` and `#restoreHidden`, and the `shadowErrorTexels` override with its report.
**Verification:** AC-1 and AC-2 close this phase. The visual judge from the root `AGENTS.md` compares shadow frames before and after, including the blend zone between two levels and a far caster's long shadow.
- [ ] The level cut matches the flat reference and ignores the camera. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] A batch draws one shadow cut per level at its largest copy scale, and the camera geometry returns after each level. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-batch.spec.ts`

#### Phase 3: The same result on the owned host
**Status:** NOT STARTED
**Files:** `examples/quarry/src/native-virtual.ts`
**Implementation:** the native entry reads the same shadow switch.
**Verification:** AC-3 closes this phase. No mobile claim is made.
- [ ] The desktop route with shadows shows the Phase 2 triangle counts per level. proof: the AC-3 command
