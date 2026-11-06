# Kit notes: puzzle

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the vault, the warden, the crates, the seal, the HUD and the look; `src/game.ts` is portable and React mounts only from `src/main.ts`.


## Commands and map

Forty-five dynamic bodies from seed 6132 — 41 solid crates to shove, 4 phase crates to walk through, and a seal to stand on. `src/scenes/Play.ts` authors the layout, drops the pile on the first observed frame so the settle is provable, and refuses a crate inside the seal (`assertClearOfSeal`) or in the crossing (`assertLaneClear`) — a check: the lane check once made a finishable level unfinishable when two crates placed elsewhere shifted the jitter. `src/render/vault.ts` returns the geometry and the solid boxes, so `src/render/` imports no framework package. The third collision layer in `src/entities/Crate.ts` is the glowing ward: it has to fall and stack, so it cannot be a sensor, and it must be transparent to *everything the player can move*. `Warden.ts` sets `pushesDynamicBodies` (Rapier's `false` default reads as a broken collider); `Seal.ts` ends the run on a backend-reported **overlap**, never a distance check. V replays the vault twice and publishes the drift. `src/render/touch-controls.ts` adds a thumbstick on touch, and `playtests/survives.playtest.json` is the smoke proof; keep the other thirteen honest.


## Portable authoring contracts

The vault is one fixed three-quarter shot that drifts a fraction of a metre toward the warden, so the camera reads the body in the frame function; a trailing follow camera is a different game.


## Optional multiplayer transport

`src/render/exposure.ts` clamps the meter (`maxStops` 0.5, `minStops` -2) because the room is dark by design and an open meter turns it into a pale box. `quality.ts` names one cost override, reported as `TN_RENDER_CHAIN_COST_OVERRIDE`: no final gather, SSGI, SSR, motion blur or local exposure, half-resolution occlusion, and the kit bloom instead of the Unreal bloom, because the core stack took the performance scenario over 16.7 ms GPU p95 with 45 bodies.
