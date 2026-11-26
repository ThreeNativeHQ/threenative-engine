# Kit notes: stealth

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the compound, the guard AI, the alert phases, the HUD and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Metal Gear Solid 1 reference cards (`engine_reference_detail` on `metal-gear-solid-1`: `guard-vision`, `guard-hearing`, `alert-escalation`, `choke-chain`, `turn-before-run`, `chase-camera-follow`, `item-pickup`); each constant names its card where it is defined. Distances are scaled 2.5x from MGS1 units to this compound.

## Commands and map

Controls: WASD/arrows move (walk is silent); Shift runs (fast, every step is a 4 m noise); C crouches (slow, half the silhouette); push into a wall for 0.1 s to press your back to it, slide along it (you stop at a wall end, and only there the camera peeks round the corner); Q knocks while pressed (a 7 m noise that pulls a guard over to look); F grabs a guard from behind (within 1.3 m, more than 110 degrees off its facing, not on Alert), and F again pumps the choke: five pumps knock it out for 40 s, three seconds without a pump and it breaks free and calls the Alert; hold E beside a body to drag it (walls and crates shorten the pull); E takes the keycard and opens the locked door, and beats dragging when both are in reach; a hit during a choke breaks the hold; R restarts. The extraction pad behind the door ends the mission.

`src/level.ts` is the whole layout as tables: walls, crates (low crates hide a crouched player, tall ones everyone), shadow pools, patrol routes with pauses, the camera, keycard, door and pad. `src/render/compound.ts` turns it into meshes and colliders; edit the tables, not the builder.

`src/ai/perception.ts` decides what a guard sees: a 45-degree half cone, a 10 m reach shortened by crouching and shadow, a line-of-sight ray to the chest by stance, and a close-sense radius that ignores the cone for a standing player. Suspicion rises with sight strength and distance, decays slowly when unseen; at 0.3 the guard stares ("?") then walks over to look, at 1 it has seen the player ("!"). Noises are posted to a `NoiseBus` once per tick. `src/ai/phase.ts` is the base-wide commander: Infiltration, Alert (all guards converge and fire), Evasion (10 s search around the last known position, after 3 s unseen), Caution (20 s of faster, wider-eyed patrols), then Infiltration. A body found by a guard sends the base to Evasion around it, once per body (`Guard.reported`); the finder wakes the body, or radios it in from behind cover it cannot walk round. Guards that cannot reach a point give up after 1.5 s of blocked walking (`STUCK_TIME`); there is no navmesh, so keep patrol routes and doorways clear of crates.

`src/entities/Guard.ts` is the guard state machine (`patrol`, `suspicious`, `investigate`, `alert`, `search`, `held`, `down`, `checkBody`); a knocked-out guard drops its collider so the body on the floor is not an invisible wall. `src/entities/SecurityCamera.ts` sweeps between two yaws, pauses at each end, sees a crouched player, has a 1.2 m blind spot under it, and calls Alert itself. Alert guards fire only when aimed, after a beat when they regain sight, and each shot draws a tracer. `src/ui/Radar.tsx` draws walls, tall crates, guard and camera cones, the player arrow and the next objective (on the rim when out of reach) north-up, and jams during Alert and Evasion.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts` (`dress` changes skinned meshes only, so the held rifle keeps its own material). Guards hold a five-box rifle on `hand_r` with a per-clip rotation table (`RIFLE_HOLD`). The Digit1-6 keys are playtest stations that put the player at a fixed test spot; delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; physics nodes are Godot-named and disposable; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale, and `attachToBone` for the held rifle. Register testable entities with `ctx.entities` (`player`, `guard.<patrol id>`, `camera.west`); `input.vector("move").y` is +up, so north is `-move.y`. Guards and cameras act only after `ctx.startup.compileSettled`, so a scenario's timings do not depend on how long the launch took. `ctx.random` is seeded in `src/game.ts`, so the guards' aim and search points repeat run to run.

`src/render/` is yours to edit: the prototype grid look, the view cones on the floor (`createViewCone`; hide them for the radar-only read), the mood markers and the overhead camera rig. Keep the camera steep (`OFFSET` in `render/camera.ts`): a shallower tilt hides a player pressed to the north face of a 2.2 m wall, and the kit contract row `camera-sees-subject` fails.
