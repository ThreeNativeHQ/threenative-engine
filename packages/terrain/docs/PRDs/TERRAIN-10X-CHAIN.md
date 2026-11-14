# Strata terrain: the chain of most valuable work (2026-11-13)

This file is a handoff for an agent that executes the work. It is a ranking, not a PRD. Each step
names the PRD that holds the scope, the boxes and the proofs. Read `/AGENTS.md` and
`docs/PRDs/AGENTS.md` first. PR-CHAIN.md stays the live plan for the hardening
batch. This file ranks across batches.

Owner, 2026-11-13: "investigate how we can make strata terrain 10x better and give me your
recommendations", then "just give me the PRD chain at the end, of most valuable things to add, and
I'll execute later".

## State on `origin/develop` at `7d588dcaa`

- The terrain shape is not the weak part. The cook already reads real elevation tiles and picks a
  real survey site for each landform (PRD-854, done).
- Look: on the 2026-11-09 baseline in [PRD-580](PRD-580-strata-starter-kit-art-bar.md),
  no world reaches 4 out of 5 on any rubric row. Forest scores 3/3/3/2/3. Tundra scores 2/1/2/1/1.
- Speed: the forest overview costs 31 to 39 ms of GPU time on the RTX 2080 at 1600x900, which is 20
  to 30 FPS (reading in [PRD-866](BLOCKED/requires-owner-decision/PRD-866-a-generated-forest-stands-under-mountains-with-real-shapes.md)).
- Focus: about 22 terrain PRDs are open across five worlds. Recent changes were judged NEUTRAL or a
  small IMPROVEMENT.

## The chain

Do one step at a time, in this order. A step is complete when its PRD boxes are ticked with their
proofs.

| Step | Work | Why it is at this position |
| --- | --- | --- |
| 1 | [PRD-584](./P1/PRD-584-an-agent-asks-for-a-forest-over-mcp-and-gets-a-60-fps-glb.md) AC-4: the forest holds 60 FPS on web | Each look step below adds GPU cost, and the frame is already 2 times over budget. |
| 2 | Forest to the art bar, alone: merge PR #675 (PRD-883 swaying grass, PRD-884 baked trees), then [PRD-855](./P1/PRD-855-the-ground-vegetation-reads-like-a-real-forest-floor.md), then box F1 of [PRD-580](PRD-580-strata-starter-kit-art-bar.md) | Forest is the nearest world to the bar. Do not start the other four worlds before forest scores 4. |
| 3 | [PRD-790](./P2/PRD-790-a-new-biome-is-a-data-row-and-the-world-streams-past-one-square.md) Phase 2: streaming is on by default | It removes the white void past the 512 m square. PRD-580 AC-1 waits on it. |
| 4 | [PRD-885](./P2/PRD-885-a-terrain-survey-reads-lidar-grade-ground-from-mapterhorn.md): lidar ground from Mapterhorn | Mapterhorn holds 3 to 21 times more real relief under 10 m at five of our survey sites. Phase 1 gets a visual verdict first. |
| 5 | [PRD-668](../../../../docs/PRDs/Unreal/rendering/PRD-668-a-displaced-surface-changes-its-silhouette-near-the-camera.md): displaced ground near the camera | Do it after step 4, because real relief can reduce its scope. |

After the chain: PRD-580 phases 2 and 3 for coastal, alpine, desert and tundra, then
[PRD-856](./P2/PRD-856-the-mountains-carry-real-silhouettes-erosion-and-rock.md) for the mountains.

## Notes for step 2

- The owner's reference frame is a low warm sun, about one hour before sunset, with haze between the
  tree stands. The forest kit uses a fixed mid-morning sun. Test the low sun and the haze first. It
  is a change of constants in the kit's `sky.ts`.
- Each look change needs the visual judge that `/AGENTS.md` describes: the same pose before and
  after, two headed WebGPU runs for each arm, and a fresh judge.

## Owner decisions that are open

- PRD-866: the far forest band drops the overview from 30 to 20 FPS. Recommendation: keep the band
  off by default until step 1 is complete.

## Deferred, with the reason

- PRD-672 (terrain shaded into cached pages): its own cost gate is not met.
- The erosion filter of Rune Skovbo Johansen (March 2026, MPL-2.0): it adds gullies with no
  simulation and works for each tile. Its licence needs an owner decision. Use it only for sites
  that have no lidar.
- Terrain Diffusion (MIT code, 30 m per pixel, NVIDIA GPU): it generates fictional terrain. The cook
  already reads real 30 m data for any place on Earth.

## Not verified by the author

- The box counts of PRD-855, PRD-856, PRD-668, PRD-883 and PRD-884. Run `pnpm prd:progress <file>`
  before you start a step.
- The usage policy of `tiles.mapterhorn.com` for automated clients.
