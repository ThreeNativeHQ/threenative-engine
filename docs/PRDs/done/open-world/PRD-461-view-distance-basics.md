# PRD-461 — View distance basics: terrain radius, near-only colliders, and fog that hides the stream edge

**Status:** DONE (2026-10-08, PR #470). It was READY, and the blocker was gone. `terrain.streamRadius` and
`terrain.colliderRadius` shipped in `4f9638c2e` (PR #358, 2026-09-27, "world streaming — scatter LOD,
streaming perf, PRDs 453–457"); `world-cells.ts:337` and `:3919` read them today. The remaining
prerequisite items below (multi-primitive scatter assets, transparent scatter as cutout) are not named
in this PRD's own acceptance criteria, so they no longer gate it.
**Complexity:** 1 (LOW); risk override: none. Three implementation files (`core` twice, the example's render source), and the rest is a recipe, guidance and its proof.
**Owner:** unassigned (drafted by Claude, 2026-09-26)
**Depends on:** was blocked on the scatter/terrain change — `terrain.streamRadius` and `terrain.colliderRadius` options, multi-primitive scatter assets, and transparent scatter drawn as cutout. The two options **landed** in `4f9638c2e` (PR #358); PRD-459 and PRD-460 are independent of the whole change.

**Priority:** P1 — Ready and unticked: terrain radius is still the prop ring, every resident tile still gets a collider, and nothing hides the stream edge.
## Context

Machinefall's 2 km map streams 25 cells of 128 m at ring 2 — a 640 m resident square, corners at
452 m — and three things about that are decided by accident rather than by a choice:

- **Terrain radius is the prop ring.** `WorldCells` sizes the composed `TerrainTiles` from the ring:
  `residentTileBudget: (2·ring+1)²` and `streamRadius: this.#ring`
  (`packages/core/src/world-cells.ts:493`, `:506`, `:512`). A game cannot give terrain a longer view
  than it gives props, and cannot give props a shorter one, because they are one number.
- **Every resident tile gets a collider.** `TerrainTiles` calls the game's `createCollider` for each
  admitted tile (`packages/core/src/world-tiles.ts:1724`) and disposes it only when the tile is
  evicted, so physics follows the render radius instead of the player.
- **Nothing hides the boundary.** The engine sets `scene.fog = null` (`packages/core/src/game.ts:540`)
  and fog is game-owned render source — `scene.fog = new Fog(…)` in
  `packages/create-threenative/templates/*/src/render/sky.ts`. So the stream edge is simply visible:
  props appear at the ring edge, which is 452 m away at the corners and 640 m at the edge midpoints.

## Solution

A default recipe for a 2 km map, enforced where it can be measured, with the rest documented.

1. **Terrain radius and collider radius become the game's own numbers** — prerequisite options
   forwarded through `IWorldCellsTerrainOptions`. **These shipped in `4f9638c2e` (PR #358)**; the
   remaining work is the tile budget below following the terrain radius rather than the ring.
2. **Colliders live near the player, not near the render radius.** A tile outside `colliderRadius`
   draws but has no collider, and a collider whose tile leaves the radius as the player moves is
   disposed then, not when the tile is evicted. That is the behaviour this PRD owns; the option
   itself is the prerequisite.
3. **The recipe**, for a 2 km map on 128 m cells (256 cells, as exported in PRD-448's AC-8):

   | Setting | Value | Why that number |
   | --- | --- | --- |
   | `ring` (props) | 2 | 5 × 5 = 25 cells resident, 640 m across, 452 m to the corner |
   | `terrain.streamRadius` | 3 | 7 × 7 = 49 tiles, 896 m across, 634 m to the corner — terrain outlives the props so the prop edge is the only edge |
   | `terrain.colliderRadius` | 1 | 3 × 3 tiles, 384 m across, 272 m to the corner; a game that walks rather than flies may use 0–1 |
   | `terrain.lodDistances` | 256, 512 (the defaults, `packages/core/src/world-tiles.ts:1382`) | both switches land inside the fog far, so a terrain pop is behind haze |
   | fog | `near` 180 m, `far` 420 m, in game render source | `far` must stay under the prop ring's *corner* (452 m), or the corner edge is visible; the terrain corner (634 m) stays comfortably beyond it |
   | `budgets` | 25 cells, 20 000 instances, 8 MB placements | at ~500 placements per cell the placement budget is not the binding constraint; resident cells and draw calls are |

   The engine ships no constant for any of it. Fog is a look and the engine cannot measure it, so
   the recipe is documented numbers, a test that keeps them self-consistent, and a game that
   overrides them freely.
4. **Guidance, not engine fog:** the recipe lands in `docs/guides/world-streaming.md` with the
   arithmetic above, and the flythrough example's render source carries the fog it proves against.

**Non-goals:** HLOD, impostor forests, GPU-driven scatter, virtual texturing, occlusion culling,
simulation LOD, and any engine-owned fog or atmosphere default.

**Risks:**
- Colliders are a physics feature and Rapier WASM does not run on Android or iOS
  (`packages/runtime-native/conformance/registry.json`, `rapier-wasm-mobile`), so the collider claim
  is browser and desktop only until a mobile physics lane exists.
- A `colliderRadius` smaller than a fast fall speed lets a body leave the collidered ground; the
  recipe's 272 m corner is far above any fall, and the number is the game's to change.
- The recipe is derived for 128 m cells. A different cell size moves every number, so it is
  documented as arithmetic over `cellSize`, not as fixed values.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: with `ring: 2` and `terrain.streamRadius: 3`, residency reports 25 resident cells and 49 resident tiles, and the ring-derived terrain radius fails this — proof: `pnpm exec vitest run packages/core/__tests__/world-cells-view-distance.spec.ts` — Evidence: 2026-10-08, 3/3 pass. Red first: `stats().residentTiles` was `undefined` (3 failed); the new `residentTiles` / `residentColliders` stats fields turned it green. The control (no `streamRadius`) reports 25 tiles, not 49.
- [x] AC-2 [local; actor: agent]: no tile outside `terrain.colliderRadius` has a collider, a collider is disposed when its tile leaves the radius while the tile keeps drawing, and a control with no `colliderRadius` shows the pre-change behaviour (every resident tile collides) — proof: `pnpm exec vitest run packages/core/__tests__/world-terrain-tiles.spec.ts` — Evidence: 2026-10-08, 50/50 pass; tile `0:0` stays resident after its body is disposed, and the control reports 49 bodies for 49 tiles. The collider lifetime itself shipped in `4f9638c2e`, so this is a guard, not a red-green.
- [x] AC-3 [local; actor: agent]: the documented recipe cannot drift: the guide's numbers are asserted against the code's own clamps (fog far ≤ the nearest new-prop edge `ring · c` < terrain edge, collider radius ≤ ring, LOD distances increasing and in the haze) — proof: `pnpm exec vitest run packages/core/__tests__/world-streaming-recipe.spec.ts` and `pnpm check:docs` — Evidence: 2026-10-08, 5/5 pass, including three controls that throw: fog far 420 m, collider radius 3, decreasing LOD distances (the last through `TerrainTiles`' own check). `pnpm check:docs`: 2910 links, exit 0. The ordering changed from this PRD's draft: see the Phase 2 checkpoint.
- [x] AC-4 [local; actor: agent]: a capture at the prop ring edge under the recipe's fog shows no visible geometry boundary; the capture paths and the review are recorded — proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.playtest.json --url 'http://127.0.0.1:5181/?world&viewDistance' --browser-recipe webgpu --headed` — Evidence: 2026-10-08, NVIDIA Turing WebGPU adapter. The run writes `artifacts/playtest/view-distance-cross-{a,b,c,f,g}.png`. A fresh judge subagent compared them with the same steps under `?world` (no fog, ring 1). Verdict PASS: in a, b and c the far terrain and the prop ring fade into the fog with no line, gap or cut-off, while every control frame shows a hard terrain edge. f and g are past the 256 m fixture (the flight ends at x = 180 m), so they show clamped terrain and no props in both runs; that is the fixture, not the recipe.
- [x] AC-5 [local; actor: agent]: the `world-flythrough` scenario run with the recipe's numbers keeps its residency assertions, reports 0 failed loads, and asserts colliders exist only inside the radius — proof: the playtest run above — Evidence: 2026-10-08, three recipe runs (the last after the flag became a plain string match). Every residency assertion and every new one passes: `failures` 0, `loadsInFlight` 0, `evictions` 16, `maxResidentCells` 16, `residentTiles` 49, `residentColliders` 9, `bodies` 9, `bodyReachTiles` 1.1875 (≤ 1.5), p95 19 ms. The run exits 1 on three shadow counters (`shadowFrame`, `shadowRendered`, `shadowDeferrals` all 0). That red is pre-existing: `origin/develop`'s unchanged scenario under `?world` fails the same three, plus `residentCells` `changed`. The `?world` control fails the new assertions (9 tiles, 0 bodies, 12 cells), so they are load-bearing.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Independent terrain radius | `WorldCells.load({ ring, terrain: { streamRadius, colliderRadius } })` | `streamRadius: this.#ring` and the ring-derived tile budget (`world-cells.ts:493`, `:506`, `:512`) | AC-1 |
| Near-only colliders | The same `update`, through the game's own `createCollider` callback | A collider per resident tile (`world-tiles.ts:1724`) | AC-2 |
| 2 km recipe + fog guidance | `docs/guides/world-streaming.md`; the example's `src/render/` for the fog it proves against | Nothing; a documented recipe, kept consistent by a test | AC-3, AC-4 |

## Execution Phases

#### Phase 1: Radius and collider lifetime

**Status:** DONE — the radii and the collider lifetime shipped in `4f9638c2e` (PR #358); this phase adds the two stats fields that report them, and the tests.
**Files:** `packages/core/src/world-cells.ts` (`stats().residentTiles` and `stats().residentColliders`; the forwarding and the tile budget already shipped), `packages/core/src/world-tiles.ts` (collider lifetime as the player moves), `packages/core/__tests__/world-cells-view-distance.spec.ts`.
**Implementation:** the terrain budget follows the terrain radius rather than the ring; a tile outside the collider radius draws with an `EmptyCollider`, and a collider whose tile leaves the radius is disposed on that step.
**Verification:** `pnpm exec vitest run packages/core/__tests__/world-cells-view-distance.spec.ts packages/core/__tests__/world-terrain-tiles.spec.ts` — AC-1, AC-2; the existing world suites stay green. (`pnpm --filter @threenative/core test` runs `publint`, not vitest.)
- [x] terrain radius independent of the ring, red against the ring-derived value. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-view-distance.spec.ts` — 3/3 pass; red before the stats fields (3 failed, `undefined`).
- [x] collider created and disposed by radius, not by residency. proof: `pnpm exec vitest run packages/core/__tests__/world-terrain-tiles.spec.ts` — 50/50 pass.
- [x] existing residency, cancellation and budget suites unchanged. proof: `pnpm exec vitest run packages/core/__tests__/world packages/core/__tests__/matrix-world.spec.ts` — 34 files, 451 passed, 2 skipped.

**Checkpoint:** 2026-10-08 — Phase 1 done. Both fixtures hold 4x4 cells, so the 25-cell count is proven on a synthetic 8x8 grid of 32 m cells over the same heightmap.

#### Phase 2: The recipe and the fog guidance

**Status:** DONE
**Files:** `docs/guides/world-streaming.md` (the recipe table and its arithmetic), `examples/abyss-framework/src/render/` (the fog the example proves against), `packages/core/__tests__/world-streaming-recipe.spec.ts`.
**Implementation:** the recipe as arithmetic over `cellSize`, so another map size follows by changing one number; the consistency test reads the documented values and asserts the ordering and the code's clamps.
**Verification:** `pnpm exec vitest run packages/core/__tests__/world-streaming-recipe.spec.ts` + `pnpm check:docs` — AC-3, AC-4.
- [x] recipe documented as arithmetic over cell size, with the ordering constraints spelled out. proof: `pnpm check:docs` — exit 0; `docs/guides/world-streaming.md` "A view-distance recipe, and fog that hides the stream edge".
- [x] consistency test fails when the documented numbers break the ordering. proof: `pnpm exec vitest run packages/core/__tests__/world-streaming-recipe.spec.ts` — 5/5 pass; the test reads the guide's table and its three controls throw.
- [x] example render source carries the fog and the capture is reviewed. proof: `pnpm --filter abyss-framework build` — exit 0; `examples/abyss-framework/src/render/worldFog.ts`, applied under `?world&viewDistance`; capture review in AC-4.

**Checkpoint:** 2026-10-08 — recipe and test landed. **Correction:** this PRD's draft set fog far 420 m against the prop ring's 452 m corner. A cell loads when the follow point crosses a cell boundary, so a new cell's near side can be `ring · c` = 256 m away, and 420 m left the ring's sides in view. The recipe is now fog `near` = `c` (128 m), `far` = `ring · c` (256 m); the terrain edge `streamRadius · c` = 384 m stays behind it.

#### Phase 3: The measured gate

**Status:** DONE
**Files:** `examples/abyss-framework/playtests/world-flythrough.playtest.json`, `examples/abyss-framework/src/scenes/WorldProbe.ts`.
**Implementation:** the scenario runs with the recipe's numbers and asserts residency, tiles, colliders and failures.
**Verification:** the playtest run — AC-5, AC-4.
- [x] probe reports resident tiles and collider count. proof: `pnpm --filter abyss-framework build` — exit 0; `WorldProbe` reports `residentTiles`, `residentColliders`, `bodies` and `bodyReachTiles`.
- [x] scenario asserts the fixture's 16 cells (the recipe's 25 needs a 5x5 grid; the unit test proves it), 49 tiles, colliders inside the radius, 0 failures. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.playtest.json --url 'http://127.0.0.1:5181/?world&viewDistance' --browser-recipe webgpu --headed` — all PRD-461 assertions pass; see AC-5 for the pre-existing shadow red.
- [x] edge capture taken at the ring edge and reviewed. proof: the same run's `view-distance-cross-*.png` — judge PASS, see AC-4.

**Checkpoint:** 2026-10-08 — done. The recipe runs under `?world&viewDistance`, so the phase477 desktop and Android lanes that share `WorldProbe` keep their ring-1 numbers. The bodies are counting stubs from the game's own `createCollider`; they prove which tiles the engine asks to collide, not Rapier bodies. Follow-ups, not in scope: the three shadow counters read 0 on `origin/develop` too, and terrain streams past the fixture's extent with clamped heights.
