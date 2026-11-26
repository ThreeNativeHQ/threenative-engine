# Kit notes: open-world

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the city, the cars, traffic, pedestrians, police, the wanted level, the job, the HUD and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the GTA III (`grand-theft-auto-iii-re3`) and San Andreas (`grand-theft-auto-san-andreas-reversed`) reference cards (`engine_reference_detail`); each constant names its card or re3 source line where it is defined.

## Commands and map

Controls on foot: WASD/arrows move relative to the camera; the mouse orbits it; Shift sprints on a stamina budget; Space/J/click punches (a two-hit jab-cross) or fires; hold E/right-click to lock on to the nearest person ahead (pistol out); Q swaps fist and pistol; F enters the nearest car (an occupied one is a carjack: the driver is pulled out and runs). In a car: W/S throttle and brake (brake to a stop, then reverse), A/D steer, Space handbrake, F gets out below 6 m/s. R restarts.

`src/city/layout.ts` is the whole city as tables: a 4x4 road grid at 48 m pitch, the 3x3 blocks between (hospital, police, respray garage, drop-off lot, plaza, and towers), the named places, the directed right-hand lane graph with stop lines, turn curves and a breadth-first `routeToward`, and the sidewalk loops pedestrians walk. `src/render/city.ts` turns it into merged static meshes and colliders; edit the tables, not the builder.

`src/entities/Car.ts` is one `VehicleBody3D` per car, for the player, traffic, police and the job alike: pedal arbitration, a steering lag with a squared signed input and a speed-sensitive lock, a handbrake that drops the rear grip, impact damage, fire and explosion. `src/systems/drivers.ts` drives every AI car by pure pursuit along lane polylines: traffic cruises at 9-14 m/s, stops for anything in a 1.6 m corridor ahead, keeps a 3 m gap, takes an intersection box in turn, reverses out when stuck, and panics when rammed; police route toward the player and drive straight at them on sight. `src/entities/Pedestrian.ts` is civilians (wander a block's sidewalk, wait at corners, cross, flee from gunfire, aiming, and cars on the sidewalk, fall when hit) and cops (chase, arrest within reach, shoot from two stars).

`src/systems/wanted.ts` is the GTA III chaos model: each crime adds points, the stars are the bands at 40/200/400/800/1600, one star bleeds away slowly, and six seconds out of every officer's line of sight flashes the stars; six more drops a level. The respray garage clears the level for $1000. Wasted respawns at the hospital and busted at the police station, each for a $100 fee and a clean slate. The phone booth in the plaza offers the job: take the yellow car to the drop-off lot within 60 s for $1500; it fails on time-out, when the car burns or when the player is wasted or busted.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap (`src/render/materials.ts`); the pistol is a box on `hand_r`. The Digit1-0, Minus and Equal keys are playtest stations (`STATIONS` in `src/systems/World.ts`) that set up one mechanic each; they answer only under the playtest runner, so delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; physics nodes are Godot-named and disposable; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale, and `attachToBone` for the held pistol. Register testable entities with `ctx.entities` (`player`, `world`, `car.<n>`, `ped.<n>`, `cop.<n>`); `player` resolves to the car while driving, so camera and movement checks follow whatever the player controls. `input.vector("move").y` is +up. The seeded random in `World` makes traffic, pedestrians and spawns repeat run to run.

`src/render/` is yours to edit: the grid look, the car builder (`render/car.ts`), and the camera (`render/camera.ts`: an orbit rig on foot that recentres behind the player, and a chase rig in a car that pulls back with speed and pulls in at walls).
