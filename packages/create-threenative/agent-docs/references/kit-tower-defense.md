# Kit notes: tower-defense

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the road, pads, enemies, towers, economy, waves, HUD, and look; `src/game.ts` is portable and React mounts only from `src/main.ts`.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; this kit deliberately uses an authored `PathFollow3D` route instead of a navmesh.


## Commands and map

`src/balance.ts` holds every number — costs, ranges, wave rules — with no engine import; `src/waves.ts` and `src/economy.ts` are pure, so a unit test can pin them without a renderer. `src/enemies/Enemy.ts` walks the same `PathFollow3D` curve the road is drawn from; `src/towers/Tower.ts` finds targets with a jittered `intersectShape` query. Change the road and pads in `src/board/Route.ts`, the look in `src/render/`. The HUD reads `GameState` and sends intents (`arm`, `launch`, `upgrade`, `recycle`, `target`, `strike`) that `src/intents.ts` queues for the scene. Register gameplay entities with `ctx.entities`. Keep `playtests/survives.playtest.json` as smoke proof (a held key pans the camera while a wave is fought) and update the other scenarios with each rule: `defeat` is the end of the game.


## Budget real time for the look

The shared look comes from core through `src/render/quality.ts`; the filmic curve and metered auto exposure are enabled by default. `src/render/exposure.ts` holds this game's meter policy (`maxStops` 0.3, `minStops` -1, so the dark void keeps its depth).


## Optional multiplayer transport

Kit facts: `1`-`4` arm a tower and a click picks a pad, `B` builds on the best free pad, `Space` launches a wave, `U`/`X` upgrade or recycle, `F` fires the strike, `P` pauses, `H` opens the field guide, `R` restarts; right-drag, the wheel and `Q`/`E` move the camera. Four towers (Sentry, Mortar, Arc coil, Cryo) have three levels and three targeting modes, Titans arrive on waves 6 and 12, and one orbital strike recharges every 30 s. The only texture is the Poly Haven CC0 sky; every tower and enemy is built in `src/render/shapes.ts`.
