# Kit notes: tomb-explorer

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the temple grid, the body simulation, the camera, the HUD and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Tomb Raider I-II reference cards (`engine_reference_detail` on `tomb-raider-i-ii`): run steering, jump, ledge grab, hang and shimmy, swim and dive, water and air, fall damage, pick-up and chase camera. Each constant in `src/tuning.ts` names its card and `file:line`. A constant marked "own" is not on a card: the kit tuned it by feel and by the playtests.

## Commands and map

Controls: arrows or WASD run, turn and step back. Shift walks and never steps off an edge. Space jumps (a running press jumps at once, a standing press crouches first), strokes in water, and dives from the surface. Hold E in the air to catch a ledge, and hold E at the relic to take it. R restarts.

`src/level.ts` is the whole layout as one grid of cells. Each cell has a floor height and a ceiling height in reference units (256 per click, 1024 per sector). The water volume, the spawn, the relic and the blade are tables in the same file. Edit the tables, not the builder in `src/render/temple.ts`.

`src/sim/` is a pure TypeScript body that steps at 30 Hz, the rate of the reference engine. `Lara.update` runs as many 30 Hz updates as the frame time covers, so a playtest result does not depend on the frame rate. One file per state group: `ground.ts` (run, walk, turn ramp, standing and running jump launch), `air.ts` (flight, ledge catch, landing and fall damage), `hang.ts` (hang, shimmy, climb), `swim.ts` (surface, dive, tread, air), `pickup.ts` (walk to the stand point, then the take), `blade.ts` (the timed trap), `death.ts`, `step.ts` (dispatch, air meter, blade). Positive vertical speed is downward, as in the reference engine.

Fall damage is zero below a landing speed of 140 and grows with the square of the excess up to 14 more. A drop of 14 clicks lands at 147 and costs 250 of 1000 health. The playtest `fall-damage-from-fourteen-clicks` pins both numbers.

`src/render/temple.ts` merges the grid into a few meshes. `src/render/camera.ts` is a chase camera that closes a tenth of the gap each 30 Hz update and shortens its arm against walls. Every figure is `assets/mannequin-combat.glb`. Hang uses the `Jump_Loop` pose and climb uses `Interact`. The Digit1-9, Digit0 and Minus keys are playtest stations that put the climber at a fixed test spot. They answer only under the playtest runner. Delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`. There is no physics plugin: the grid is the collision world. Generated conventions call `GroundSnap` for floor contact and `normaliseToMetres` for authored model scale. Register testable entities with `ctx.entities` (`player`). `ctx.random` is seeded in `src/game.ts`.

`src/render/` is yours to edit: the prototype grid look, the sky and the chase camera. Keep the camera arm short in tunnels: a long arm hides the climber in the water tunnel and the kit contract row `camera-sees-subject` fails.
