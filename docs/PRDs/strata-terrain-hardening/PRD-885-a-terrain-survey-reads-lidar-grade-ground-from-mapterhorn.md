# PRD-885 — A terrain survey reads lidar-grade ground from Mapterhorn

**Status:** NOT STARTED
**Priority:** P2 — The walkable ground of a cooked world carries no real relief under 10 m (AC-2 and AC-3 open), which the ground judges read as "one smooth dirt sheet".
**Complexity:** 2 (LOW); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None. [PRD-854](../done/PRD-854-one-terrain-request-decides-the-landform-water-size-and-survey.md) landed the survey fetch that this PRD changes.

## Context

Owner, 2026-11-13: "investigate how we can make strata terrain 10x better ... I saw this Mapterhorn
on github, see if useful".

`packages/terrain/src/mcp/survey.ts` fetches real ground from the AWS terrain tiles
(`s3.amazonaws.com/elevation-tiles-prod/terrarium`, 256 px PNG, the frozen `tilezen/joerd` set).
`forestFloor` in `packages/terrain/src/mcp/cook.ts:793` reads zoom 15, about 3.7 m per pixel, and
resamples it on a 2 m grid over 512 m. `docs/PRDs/strata-terrain-hardening/PR-CHAIN.md:32` already
names the gap: "A walkable 512 m square needs the erosion and grain layers on top, or 1 m lidar."

[Mapterhorn](https://github.com/mapterhorn/mapterhorn) (BSD-3-Clause pipeline) is the maintained
successor of that tile set. It uses the same terrarium encoding, so the height formula in
`decodeTerrarium` does not change. The tiles are 512 px lossless WebP at
`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`. Copernicus GLO-30 covers the planet to zoom 12, and
national lidar surveys cover zoom 13 to 17 where they exist. `https://download.mapterhorn.com/attribution.json`
lists 151 sources, all under open licences (CC BY 4.0, United States public domain, Licence Ouverte
2.0, CC0, Copernicus free and open).

Measured on 2026-11-13, one tile per site and zoom at the centre of five `SURVEYS` rows. "Detail"
is the RMS of the height that is left after a Gaussian low-pass of 10 m, on the central 75% of the
tile. Both zoom 15 tiles cover the same ground.

| Site | AWS z15, m/px | AWS detail under 10 m | Mapterhorn z15, m/px | Mapterhorn detail under 10 m | Finest Mapterhorn zoom |
| --- | --- | --- | --- | --- | --- |
| Matterhorn | 3.32 | 0.23 m | 1.66 | 4.89 m | 17 (0.42 m/px) |
| Sprague Lake, Colorado | 3.64 | 0.09 m | 1.82 | 0.28 m | 16 (0.91 m/px) |
| Coon Valley, Wisconsin | 3.45 | 0.03 m | 1.73 | 0.14 m | 16 (0.86 m/px) |
| Étretat, France | 3.09 | 0.05 m | 1.54 | 0.36 m | 17 (0.39 m/px) |
| Mount Fuji, Japan | 3.90 | 0.20 m | 1.95 | 0.63 m | 16 (0.97 m/px) |

Mapterhorn holds 3 to 21 times more real relief under 10 m at the same sites. Three sampled tiles
are `VP8L` (lossless), so the numbers are data and not compression noise. This is a statistic. It
is not a visual verdict. Phase 1 gets the verdict before any shipping code changes.

Not verified: the usage policy of `tiles.mapterhorn.com` for automated clients, and the exact
attribution text that Mapterhorn requires. Mapterhorn's own MapLibre examples use "© Mapterhorn" with
a link to `mapterhorn.com/attribution`. Phase 2 reads the repository licence files before it writes
the text.

## Solution

One tile source, the finest zoom the site has, and a grid fine enough to carry it.

- `survey.ts` reads Mapterhorn tiles. The tile is 512 px, and the WebP is decoded with `sharp`
  (already in the workspace `catalog:`, used by `packages/assets`), imported only in this Node-only
  cook path. The AWS source and the hand-written PNG tile decoder leave in the same change.
- A survey asks for the zoom that its grid cell needs. When the site has no tile at that zoom
  (HTTP 404: Sprague Lake and Mount Fuji stop at 16), the survey steps to the next coarser zoom.
  The cook result names the source, the zoom used and its metres per pixel. A site with no tile at
  any zoom fails closed, as it does today.
- `forestFloor` cooks at 1 m cells (resolution 513 over 512 m) when the source is 1 m per pixel or
  finer. Its erosion and smoothing layers must not remove the relief the lidar supplied.
- The disk cache (`TN_TERRAIN_TILE_CACHE`) and the fail-closed message stay. One cook reads about
  ten tiles.

Risks: `sharp` is a native dependency on a package that has none today (see Decisions). A 513 grid
has four times the cells, so bake time and the 25 MiB kit budget need a reading. More ground
triangles near the camera need a frame-time reading.

## Acceptance Criteria

- [ ] AC-1 [local]: A survey at a lidar site returns Mapterhorn ground at the finest zoom the site has, and the cook result names the source, zoom and metres per pixel. proof: `pnpm exec vitest run packages/terrain/__tests__/terrain-survey.spec.ts` with fixture tiles for a zoom 17 site and a zoom 16 site — Evidence: pending.
- [ ] AC-2 [local]: The cooked forest-floor heights keep at least 80% of the source's relief under 10 m (RMS after a 10 m low-pass) at 1 m cells. proof: a new case in `packages/terrain/__tests__/terrain-survey.spec.ts` on the Sprague Lake fixture — Evidence: pending.
- [ ] AC-3 [local]: At walking pose on the cooked forest floor, a fresh visual judge returns IMPROVEMENT on the `ground` row against the AWS arm. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit`, two headed WebGPU runs per arm, sheets on the PR — Evidence: pending.
- [ ] AC-4 [local]: The cooked kit stays at or under 25 MiB and presented p95 frame time does not rise. proof: `pnpm --filter strata-terrain-preview test:consumer` for the size, and `measure-steady-state-fps` with paired arms on one code state for the frame time — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Survey tile fetch | `terrain_generate` with `ground: {location}` or a landform word → `cookKit` → `surveyHeights` (`packages/terrain/src/mcp/survey.ts`) | AWS terrarium fetch and PNG tile decoder are deleted | AC-1 |
| Forest-floor patch | `cookKit` → `forestFloor` (`packages/terrain/src/mcp/cook.ts:781`) | zoom 15 on a 2 m grid is replaced | AC-2, AC-3 |

## Decisions

- 2026-11-13 (author, reversible): decode WebP with `sharp` and do not write a VP8L decoder by hand. `sharp` is already in the catalog. A hand decoder is several hundred lines for one tile format. If the owner wants `@threenative/terrain` to stay free of native dependencies, the cook moves the decode behind an optional dependency and fails closed naming the install command.
- 2026-11-13 (author, reversible): one source, no AWS arm kept in shipped code. The committed DEM crops of the five starter worlds do not change, so their look does not change.

## Execution Phases

#### Phase 1: The ceiling, measured before any shipping change

**Status:** NOT STARTED
**Files:** none shipped. A scratch script cooks the same Sprague Lake forest floor from each source.
**Implementation:** Cook the patch from AWS zoom 15 at resolution 257 (today), and from Mapterhorn zoom 16 at resolution 513. Capture the same walking pose for each arm. If the judge reads NEUTRAL, record that under Decisions, keep AC-1 only (the maintained source and the finer far data), and delete AC-2 to AC-4 as moot.
**Verification:** two headed runs per arm, `--browser-recipe webgpu`, fresh judge on the `ground` row.

- [ ] The judge's verdict for lidar ground at 1 m cells against today's ground is recorded with both sheets. proof: the PR comment that carries the two sheets and the verdict

#### Phase 2: The survey reads Mapterhorn

**Status:** NOT STARTED
**Files:** `packages/terrain/src/mcp/survey.ts` (source, 512 px, WebP decode, zoom step-down), `packages/terrain/src/core/surveys.ts` (attribution text), `packages/terrain/package.json` (`sharp`), `packages/terrain/__tests__/terrain-survey.spec.ts` and its fixtures.
**Implementation:** Replace the tile URL and the decoder. Pick the zoom from the grid cell size. Step down on 404 and report the zoom used. Write the attribution from Mapterhorn's licence files into the kit, as the AWS path does today.
**Verification:** `pnpm exec vitest run packages/terrain/__tests__/terrain-survey.spec.ts` — AC-1.

- [ ] `surveyHeights` decodes a Mapterhorn fixture tile to its real elevations and steps from zoom 17 to 16 at a site that has no zoom 17 tile. proof: `pnpm exec vitest run packages/terrain/__tests__/terrain-survey.spec.ts`
- [ ] No AWS tile URL and no PNG tile decoder are left in `packages/terrain/src`. proof: `rg -c 'elevation-tiles-prod|readPNGChunks' packages/terrain/src` prints nothing

#### Phase 3: The forest floor carries the relief

**Status:** NOT STARTED
**Files:** `packages/terrain/src/mcp/cook.ts` (`forestFloor` zoom and resolution, the layers that follow the heightmap).
**Implementation:** Cook at 1 m cells when the source allows it. Reduce or mask the erosion and smoothing passes on this path until AC-2 holds. Read the kit size and the frame time.
**Verification:** AC-2 spec case, then the AC-3 captures and the AC-4 readings.

- [ ] The forest floor cooks at resolution 513 from a source of 1 m per pixel or finer, and at 257 otherwise. proof: `pnpm exec vitest run packages/terrain/__tests__/terrain-survey.spec.ts`
