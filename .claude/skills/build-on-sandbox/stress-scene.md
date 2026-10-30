# The stress scene (performance loop)

The stress lab is a sandbox game whose second scene loads the engine to its limit with a realistic
open-world mix. It is not a game to play. It is the fixed bench for the inspect, fix, measure loop.

## Where it is

- Game folder: `../sandbox/stress-lab/`, a starter-kit sandbox game. The sandbox folder is its own git
  repository: commit scene changes there.
- Scene: `src/scenes/Stress.ts`. Report: `src/stressReport.ts`. Look: `src/render/stress.ts`.
- Open it with `main.html?stress` (natively: `TN_DEBUG_STRESS=1`). Without `?stress` the starter course
  opens, so the kit's own playtests still prove it.

## What it loads

The `real` preset: 4000 trees, 6000 rocks, 120 houses, 600 props, 120 animated rigs, 300 physics
bodies, 12 fires of 1500 particles, 16 lights, virtual shadow maps, and the engine's default look.
The camera orbits the town (radius 70 m, one turn in 40 s).

| URL flag | Effect |
| --- | --- |
| `&max` | the `max` preset (2.5 to 3 times the `real` counts) |
| `&noTrees`, `&noRocks`, `&noHouses`, `&noProps`, `&noCrowd`, `&noBodies`, `&noFires`, `&noLights` | removes one layer, to price it |
| `&plainShadow` | regular shadow maps instead of virtual shadow maps |
| `&adaptive` | the adaptive quality tier instead of `high` |
| `&still` | stops the orbit and the walkers |
| `&closeup` | frames a sunlit walker, for shadow judging |
| `&freezeAt=<s>` | holds the orbit at second `<s>` after a real pan |

## Put the latest engine in it

1. Build the packages you changed (`pnpm --filter <package> build`).
2. Copy the built files into `node_modules/` of the game folder, or make a fresh sandbox with
   `pnpm sandbox --genre <genre> --name <name>` and copy `src/` across.
3. Move `node_modules/.vite` aside and restart Vite, or the browser keeps the old prebundle.

## Measure

1. Open `main.html?stress` in real Chrome through the Chrome DevTools MCP, with the cache ignored.
   Read `adapter.info`: `swiftshader` means the numbers are not GPU numbers.
2. Wait 75 s. Startup, shader compiles and the world build are not stress.
3. Read `globalThis.__TN_STRESS__`: fps, frame, render, update and GPU p50, frame p95, presented p95,
   JS-Wasm crossings and long tasks.
4. Record every run: `pnpm stress:loop record <report.json> --label "<change>" --decision keep|reject`.
   The dashboard's Stress lab tab draws `docs/stress-loop/ledger.json`.

## Compare two engines

- Alternate the arms in one quiet window (A, B, B, A) with two or more runs per arm. Noise is about
  ±7% between sessions and ±3% inside one. Compare render p50 and frame p95, not fps from different
  sessions.
- Keep a change only on a paired gain. A count that falls (draws, crossings) is not a gain until frame
  time falls with it.
- A change that can move pixels needs the visual judge from the repo's `AGENTS.md`. Capture the same
  orbit time on both arms.
- Fix the engine in `packages/`, never the scene: the gain must reach every game.
