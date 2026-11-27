# Kit notes: survival-horror

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the mansion wing, the survivor, the zombies, the case, the item box, the saves and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount.

## Start every change

The map is data: `src/level.ts` holds the rooms, the doors, the camera zones, the furniture, the pickups and the zombie spawns. Move a door, a camera or an item there; `src/render/mansion.ts` builds the meshes and `src/scenes/Play.ts` the colliders and the interactions from the same tables. Every camera zone keeps its lens inside its room, below the wall tops, so no wall stands between the lens and the survivor.

## Mechanics and where they live

| Mechanic | File | Key numbers |
| --- | --- | --- |
| Fixed cameras, instant cuts, 0.35 m hysteresis | `level.ts` `CAMERA_ZONES`, `render/camera.ts` | hall cut at x = 9 to the reverse angle; `track: true` pans in place |
| Tank controls, run, quick turn | `entities/Survivor.ts` | walk 1.4, back 1.15, run 3.6 m/s; turn 2 rad/s (run x1.1, aim x5/7); quick turn 180° in 0.5 s on back + run |
| Aim stance, auto-target, fire | `Survivor.ts`, `Play.ts` `acquire`/`shot` | 50° cone, 10 m, nearest visible; 0.5 s between rounds; 16 damage x0.75-1.125; aim up within 2.5 m: 30% critical; the lock moves on when its target falls, dies or rises; R reloads with the gun up |
| Magazine, reserve, reload, empty click | `Survivor.ts` | 15-round magazine; reserve is the ammo in the case; empty gun auto-reloads or clicks |
| Zombies | `entities/Zombie.ts` | sight 6 m in a 120° wedge, 2.5 m proximity, hear a shot in the room or a run within 5 m; 0.55 m/s shamble with a lurch; 90 health; 0.6 s stagger shoved along the shot |
| Grab, bite, break free | `Zombie.ts` | grab within 0.95 m; hold 2.2 s; bite (20) lands at 1 s; each struggle press takes 0.4 s off (three presses in a second escape); 1.5 s cooldown; 1.2 s grab immunity after a hold and after every door |
| Knock-down, the one that gets back up | `Zombie.ts` | `rises: true` in `ZOMBIES` stays down 7 s, stands in 1.4 s, then walks at 0.75 m/s; a gun aimed down finds a body on the floor |
| Condition | `Survivor.ts` `conditionOf`, `ui/Hud.tsx` | Fine above 66, Caution above 33, Danger below; Danger limps at 0.85 m/s; the ECG trace speeds up |
| Case and item box | `items.ts`, `Play.ts`, `ui/CaseScreen.tsx` | 6 slots; ammo stacks to 60, ribbons to 10; a full case refuses and says so; the box is unlimited |
| Herbs, keys, locked doors | `Play.ts` `useItem`, `combine`, `openDoor` | herb heals 25; C in the case mixes two green herbs into one slot that heals 60; a key is spent on its door; a door fades down and up over 1.4 s |
| Typewriter saves | `Play.ts` `typewriter` | one Ink Ribbon per save, in memory for the page; after a death Enter continues from the last save (or tries again), N starts a new game at any time |

## Controls

W/S forward and back, A/D turn; Shift runs; S+Shift quick-turns; J, left Ctrl or right mouse button aims (W/S tilt the aim up or down); E, Space or left mouse button acts or fires; R reloads; I opens the case and C mixes herbs in it; Escape closes a menu; Enter answers the end screens; N starts a new game. H and K are playtest probes: H takes 20 health and K gives the Study Key.

## Rig

Every figure is `assets/mannequin-combat.glb`. The survivor wears the default material and holds a procedural handgun on `hand_r` (`attachToBone`); zombies are the same rig in `zombieMaterial`. Clips: `Pistol_Aim_Neutral/Up/Down`, `Pistol_Shoot`, `Pistol_Reload`, `Walk_Loop`, `Jog_Fwd_Loop`, `Idle_Loop`, `Hit_Chest`, `Death01`, `PickUp_Table`, and `Interact` for the grab.

## Proof

`playtests/` holds one scenario per mechanic; `survives.playtest.json` is the smoke proof. Positions in the scenarios come from `level.ts`: the spawn is 1.4 m from the save-room door, facing it.
