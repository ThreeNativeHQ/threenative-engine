# PRD-537 — Far hills show the forest

**Status:** NOT STARTED
**Priority:** P2 — Open: Machinefall's far hills show bare terrain; the engine's whole-map impostors are off and their shadow regression is unfixed.
**Complexity:** 5 (MEDIUM) — one engine file family (`world-cells.ts`, shadow levels) and one game opt-in; the mechanism exists, the work is turning it on without a shadow or pop regression
**Owner:** João
**Depends on:** PRD-478 (its walking budget, 8.3 ms CPU and GPU p95, is the cost ceiling here)

## Context

The owner saw it on 2026-10-07: in Machinefall, the hills in the background are bare. Measured on the built world (`world.25d1d6a1.json`, the `a5-current` site):

| Fact | Value |
| --- | --- |
| Map | 2048 m square, 128 m cells, 254 cells with content |
| Placements | 121,421 in total, 67,585 of them trees (76 tree assets) |
| Placement data | 32 bytes each, 3.9 MB for the whole map (`placements.bin`) |
| Props and trees end at | the streaming ring, about 256–360 m from the camera (`MapWalk.ts` comment) |
| Terrain reaches | the whole map (`terrain.streamRadius: 8`, 17 × 17 tiles) |

So past the ring the terrain draws and nothing stands on it.

The engine already has the mechanism. `WorldCells` option `impostors: true` bakes an octahedral impostor for every alpha-cutout foliage asset at runtime and adds it as the asset's terminal two-triangle level. It also keeps **whole-map far aggregates**: one `InstancedMesh` per atlas key that holds the original placements and hands each one over to the near ring (`stats().impostor.far`, `#newFarMesh`, `#disableFar`). The option is off by default. Its own doc gives the reason: the impostor replaces the coarsest level the wide shadow levels draw, and its card left the road and forest floor almost unshaded (PR #375 visual regression). Machinefall's `World.ts` does not set it.

Options considered:
1. **Turn on the existing whole-map impostors and fix the shadow regression** (this PRD). Placements are already small; the atlases are bounded by a 128 MiB budget; far trees cost one instanced draw per atlas key.
2. **Draw each cell's proxy GLB past the ring.** Rejected: the 86 `world.cell_*.proxy.*.glb` files hold merged props (grass, cattails, shrubs, a watchtower, cars), not trees, and weigh 485 MB in total (up to 70 MB each).
3. **Paint a canopy into the far terrain colour.** Kept as a fallback only: it is game-side and cheap, but it shows no tree tops on the skyline.

Layer split: the residency, hand-over and shadow behaviour are engine mechanism (`packages/core/src/world-cells.ts`, `render/world-impostor*.ts`, `render/virtual-shadow.ts`). Whether a game turns impostors on, and what its trees look like, belongs to the game (Machinefall `apps/client/src/level/World.ts`).

## Decisions

- 2026-10-07, João: the brain writes this PRD; a cheap arm (Haiku 5.5, max effort) executes the mechanical steps under close review. Visual judging and the engine shadow fix stay with the brain.

## Acceptance Criteria

- [ ] AC-1: on the aerial and map-views poses, 3 fresh blind raters prefer the impostors-on capture to the impostors-off capture for the far hills. proof: capture sheets on the PR plus the raters' votes.
- [ ] AC-2: on the four `map-walk` poses (camp, first stream, highway, bridge), near shadows with impostors on match impostors off in a blind triptych judge. proof: triptych sheets plus the judge's verdict.
- [ ] AC-3: the `world-capture` pop series with impostors on shows no one-arm pop that impostors off does not show. proof: pop series judged blind.

## Execution Phases

#### Phase 1: Measure the existing far path on Machinefall
**Status:** NOT STARTED
**Files:** Machinefall `apps/client/src/level/World.ts`; no engine file

- [ ] Machinefall reads `?tnImpostors=1` and passes `impostors: true` to `WorldCells.load`; without the flag nothing changes. proof: `map-walk` playtest passes with and without the flag; a diff of `World.ts` only.
- [ ] With the flag, `stats().impostor.far` reports the far aggregates on `map-walk`: aggregate count, far instances, near-owned, atlas bytes against the 128 MiB budget. proof: the `world` entity's debug fields in the playtest report, both numbers written here.
- [ ] Captures with the flag on and off at the four `map-walk` poses and two aerial poses show trees on the far hills only with the flag on. proof: labelled sheets on the PR and one blind judge.

  - **2026-10-08 measurement, boxes still open:** on a measurement copy of the candidate client (not committed to Machinefall), `?tnImpostors=1` passes `impostors: true`. Laptop Intel GPU, all four runs pass (one impostors-off retry after a bridge `advance` timeout). Final `map-walk` marker with the flag: 42 assets baked (62 bakes, all ready, 0 pending), 46 far aggregates, 102,985 far instances (98,505 live, 4,480 owned by the near ring), far instance bytes 7.0 MB, atlas 131,419,520 B of the 134,217,728 B budget (97.9 %). The numbers come from a game-side console marker, not the playtest's debug fields.
  - What the captures show: **the far hills stay bare with impostors on, in every pose**, so the whole-map aggregates are not what is missing there; whether the hills hold any tree placements, or the aggregates are culled before them, is the next question. Impostors on also add a hard-edged dark shadow from about the ring edge to the treeline, with a staircase of large rectangular steps on open meadow, and blue-black impostor cards with white cut-off trunks: the PR #375 failure turned around (too much shadow). Near shadows match. Strongest on `01-camp` and the highway aerial; the owner saw it on the laptop screen. Caveat: the `map-views` run used `?scene=map-walk`, so the aerial and bridge-deck views need a rerun with their own scene. Sheets: the session scratchpad `ff537/`.

#### Phase 2: Shadows keep their casters when impostors are on
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`, `packages/core/src/render/virtual-shadow.ts`; `packages/core/__tests__/`

- [ ] With impostors on, a shadow level's caster set inside its own window equals the set with impostors off: the impostor terminal never replaces a near caster. proof: red-green spec beside `world-shadow-gpu-keys.spec.ts`, both arms on the committed `world-v1` package.
- [ ] Far impostors cast only where no finer caster covers the same placement. proof: red-green spec counting each placement's casters per level.

#### Phase 3: Hand-over without pop, then on in the game
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts` (only if the pop series finds a defect); Machinefall `World.ts`

- [ ] At the ring boundary a far impostor hands over to the near mesh in the same frame, with no frame that draws neither. proof: red-green spec on `#disableFar` over a walk that crosses the ring.
- [ ] Machinefall sets `impostors: true` by default and removes the flag. proof: Machinefall commit plus a passing `map-walk` playtest.

## Blocked on

- Walking CPU and GPU p95 with impostors on, against PRD-478's 8.3 ms: needs the RTX 2080 on a quiet desktop (the desktop load was 35–110 all day on 2026-10-07).
- The owner's side-by-side review of the far hills.

## Notes

- Whether `impostors` should default to true in the engine is a separate decision, once Phase 2 removes the reason it is off. The repository rule "conventions ship on by default" argues for it.
