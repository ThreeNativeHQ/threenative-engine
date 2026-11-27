# Kit notes: military-shooter

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the yard, the soldiers, the rules in `src/rules/`, the HUD and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. The kit is inspired by modern military shooters. Cards cited: `halo-combat-evolved-opence` (`tick-clock`, `shield-absorption`, `shield-recharge`, `body-vitality`, `ai-bursts`, `first-person-view`) and `quake` (`grenade-ballistics`). Stances, the sprint budget, the spread accumulator, recoil and soldier accuracy have no card: their numbers are game-owned, and each comment says so.

## Commands and map

Controls: WASD or arrows move. The mouse looks (a click captures it). Space or the left button fires. F or the right button aims down the sights. Shift sprints forward. C crouches and Z goes prone; the same key again stands up. R reloads. G throws a grenade. Enter restarts.

- `src/rules/movement.ts`: stances, ground friction and acceleration, the sprint budget (4 s, 1 s to start, 1.5 times the speed, a key release after any interruption).
- `src/rules/weapon.ts`: the spread accumulator (0 to 255), the cone per stance blended by eye height, the shot's random disc, the view kick.
- `src/rules/vitals.ts`: the shield takes a hit first, the overflow goes to health, a stun pauses the recharge, health never regenerates.
- `src/rules/accuracy.ts`: how well a soldier shoots, from distance, posture and motion, and its burst timing.
- `src/rules/ticks.ts`: the 30 Hz tick the shield and the bursts count in.
- `src/entities/Soldier.ts`: the soldier state machine (`hold`, `burst`, `gap`, `dead`). A round whose line to the chest a wall or cover cuts is stopped there and counted in `blocked`.
- `src/entities/Grenade.ts`: a thrown grenade with a 2.5 s fuse that bounces. The blast is cut off by walls and cover and hurts the thrower.
- `src/level.ts`: the yard as tables. Low cover is 1.0 m: it stops rounds aimed at a crouched or prone player and not at a standing one.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts`. The player has no rig: the rifle on the camera is five boxes (`src/render/viewmodel.ts`). The Digit1 to Digit5 keys and Digit8 are playtest stations and a damage key. They answer only under a playtest runner (`src/stations.ts`). Each station names the one soldier that may fire there. Delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`. Physics nodes are Godot-named and disposable. Register testable entities with `ctx.entities` (`player`, `soldier.<post id>`). `input.vector("move").y` is +up, so forward is `+move.y`. Soldiers fire only after `ctx.startup.compileSettled`, so a scenario's timings do not depend on the launch time. `ctx.random` is seeded in `src/game.ts`, so the soldiers' aim repeats run to run. The camera is placed from the solved body after the physics step (`afterPhysics`), so the eye never lags the body.
