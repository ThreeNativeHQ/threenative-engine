# Kit notes: car-combat

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the car, the arena, the rival drivers, the race rules, the HUD and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Carmageddon reference cards (`engine_reference_detail` on `carmageddon`: `tyre-grip-limit`, `engine-torque`, `gearbox-shifting`, `brake-and-handbrake`, `steering-curvature`, `steering-self-centre`, `impact-damage-routing`, `subsystem-damage`, `ai-objectives`, `ai-path-following`, `chase-camera`). Each constant names its card and `file:line` where it is defined. A number marked "kit tuning" is not in a card: the card works in game units, this kit in metres per second. Checkpoints, laps and the time bonus have no card, so they are all kit tuning.

## Commands and map

Controls: Up is the throttle. Down brakes, and once the car is nearly stopped it reverses (the gear flips sign, as the card says, so there is no reverse key). Left and Right steer. Space is the handbrake. R restarts.

The car is one class, `src/entities/Car.ts`. The player and every rival drive it through the same `drive` call, so there is no faked car for the AI. It wraps the engine's `VehicleBody3D` (ray-cast suspension). Four small modules hold the mechanics, each a plain function or class with no physics import:

- `src/vehicle/steering.ts`: a key builds a curvature from -1 to 1. Opposing input corrects at a flat rate. Agreeing input builds at `0.05 / (5 + speed)`, so the same key press takes longer at speed. With no input the curvature bleeds toward the yaw the car carries, so a slide stays recoverable.
- `src/vehicle/tyres.ts`: grip is a friction ellipse. An axle has one budget, `mu * sqrt(load)`. The lateral demand and the drive demand add into one length. Over budget, the drive force shrinks (surplus is lost) and the tyre is flagged slipping. A car that turns hard has little left to accelerate with.
- `src/vehicle/drivetrain.ts`: engine torque has a throttle demand of 1.2, minus an engine-braking loss that grows with rpm squared. An automatic gearbox upshifts above 6000 rpm when the rear tyres grip, and downshifts below 3000. Brake force jumps to an initial value and climbs to a cap while the pedal is held. The handbrake drops the car to neutral and the rear grip to a fifth.
- `src/vehicle/damage.ts`: an impact is classified into front, rear, left or right from the direction the speed changed. Each region feeds named parts (engine, gearbox, driver, four wheels, four brakes). A hit under 5 levels is ignored. A part saturates at 99, and a hit under 10 levels cannot cross the line. The car is wrecked when the engine, gearbox or driver reaches 99, or when all four wheels do. Engine damage cuts power, brake damage cuts braking, wheel damage past 30 pulls the wheel out of true and lowers its grip, and a rear brake at 60 kills the handbrake. Repair on a pad runs the damage backwards at 9 levels per second.

`src/arena/layout.ts` is the whole map as tables and one path function: a stadium circuit, six gates, two repair pads and three infield blocks. `src/render/arena.ts` turns it into meshes and colliders. Edit the tables, not the builder.

`src/ai/rival.ts` gives each rival one timed objective (`race`, `pursue`, `backup`, `wait`). A grudge, built by ramming and worn down by time, and the driver's nastiness set the chance to start a pursuit each second. At most three rivals pursue and two race. A rival jammed against a stopped player backs off with reverse. In `race` it follows the circuit 15 m ahead and slows for corners.

`src/systems/Race.ts` holds the clock, the gates and the laps. The clock starts at 45 s, each gate adds 20 s, and two laps win. Wrecking every rival also wins. Time up or a wrecked player loses.

The Digit keys are playtest stations that set up one mechanic in one tick (`src/systems/stations.ts`). They answer only under the playtest runner. Delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; physics nodes are Godot-named and disposable. Register testable entities with `ctx.entities` (`player`, `rival.<n>`, `race`, `world`). The kit uses no model, texture or sound file: the cars, gates and arena are procedural geometry on the metre-grid materials in `src/render/materials.ts`.

`src/render/` is yours to edit: the prototype grid look, the sky and the chase camera. Keep the camera behind the car: the kit contract row `camera-sees-subject` fails when a wall hides it.
