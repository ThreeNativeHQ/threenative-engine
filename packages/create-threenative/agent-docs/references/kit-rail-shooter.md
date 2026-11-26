# Kit notes: rail shooter

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the rail, the waves, the flight model, the weapons, the boss, the HUD and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Star Fox 64 reference cards (`engine_reference_detail` on `star-fox-64`: `arwing-boost`, `arwing-brake`, `banking`, `barrel-roll`, `laser-fire`, `charge-lock-on`, `lock-on-tracking`, `shield-damage`, `rails-path-progress`, `camera-rails`). `src/tuning.ts` holds every number and names the card beside each borrowed one. Card speeds are in units per update at 30 updates a second; one unit is 0.4 m here.

## Commands and map

Controls: arrows or WASD steer the ship inside a box around the rail; Space fires (a hold repeats and charges); a release after a third of a second sends the homing shot, and after two thirds of a second the hold also marks the target nearest the reticle; Shift boosts, X brakes (one shared gauge: it fills while either runs, drains while neither does, and locks both until it is empty again); Q and E bank, and a second tap inside a third of a second is a barrel roll that turns enemy shots back and lets them hurt enemies; R restarts.

`src/level.ts` is the whole course as tables: the rail's control points, the seven waves (each a spline in the rail's own frame: metres ahead of the trigger, then right and up), the shield rings and the arena stop. `src/rail.ts` wraps the engine's `PathFollow3D` and returns the corridor frame (forward, right, up) at a distance; the ship, the enemy paths, the camera, the pylons and the boss all read it. Edit the tables, not the builders.

`src/entities/Ship.ts` is the flight model (stick, gauge, roll, bank, shield). `Weapons.ts` pools three instanced meshes for lasers, homing shots and enemy fire, and owns the charge, the mark and the turn-back. `Enemy.ts` flies a world-space spline and fires aimed, led shots while the ship is ahead of it. `Boss.ts` has two pod weak points and an armoured core: phase 1 until both pods fall, phase 2 with the core open, phase 3 under 40 percent of its hit points. Hit points are the whole damage model: a scout takes 2 laser hits, a gunship 6, a pod 12, the core 30; a homing shot counts as 6.

Every hull is boxes, cones and spheres on the two grid materials (`src/render/hulls.ts`), the sky is the procedural atmosphere and the pilot is not drawn. The scaffold still ships `assets/mannequin-combat.glb`, named once in `src/conventions.ts`, so every kit carries the same asset. The Digit1-7 keys are playtest stations (a hostile shot, a pinned scout, a pinned gunship, the first wave, a wounded ship beside a ring, the boss arena, a killing blow); they answer only under a playtest runner. Delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; there is no physics: every hit is a distance test. Register testable entities with `ctx.entities` (`player`, `boss`, `enemy.<id>`). `input.vector("move").y` is +up. The ship acts only after `ctx.startup.compileSettled`, so a scenario's timings do not depend on how long the launch took. Every field of the store is rewritten each tick, so `goto("play")` restarts clean.
