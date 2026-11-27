# Kit notes: flight

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the airframe constants, the rocket belt model, the course, the scoring, the HUD and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. The hang glider flies on the engine `FlightModel` from `@threenative/core`, as Midway does. Task rules borrow algorithms and defaults from the Pilotwings 64 reference cards (`engine_reference_detail` on `pilotwings-64-n64decomp`: `stall-threshold` for the warning, `air-volumes`, `ring-gates`, `landing-gate`, `jet-thrust`, `rotor-fuel`); each constant names its card where it is defined. Speeds are metres per second.

## Commands and map

Controls: Up dives and Down pulls up (the stick is a bar: a hold builds it, a tap nudges it); Left and Right bank; V swaps the hang glider and the rocket belt and restarts; R restarts. The belt leans with Up and Down, turns with Left and Right, climbs on Space and sinks on Shift. Held neutral, the belt holds its height.

`src/sim/` draws nothing and touches no DOM, so it runs the same on every target. `world.ts` is the island: `groundHeight`, the wind, the thermals, the pad and both ring courses. `glider.ts` wraps `FlightModel` with a 95 kg airframe and a 24 square metre sail. The engine owns lift, drag and the stall (a wing past its critical angle loses lift and drops its nose). The kit adds a speed-stability term, because the engine elevator is a load command: the nose drops when slow and rises when fast. Wind and thermals enter as the model wind vector. `belt.ts` is thrust against gravity along the body axis, with a lever that sets the burn. `scoring.ts` counts a ring only when the craft crosses its face front-first inside the opening, and scores a touchdown on distance from the pad centre and sink rate (a crash is none). `attempt.ts` ties one craft, the rings and the touchdown into the state the HUD reads.

`src/render/` draws it: `terrain.ts` (the island heightfield, the sea, the landmarks), `markers.ts` (rings, thermal columns, wind socks), `aircraft.ts` (both craft and the mannequin pilot), `camera.ts` (the chase view, kept clear of the hills). The thermals stand still: they do not drift with the wind.

Every humanoid is `assets/mannequin-combat.glb`. The Digit1-8 keys are playtest stations (`src/scenes/stations.ts`) that put the craft at a fixed test spot; they answer only under a playtest runner. Delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`. Register testable entities with `ctx.entities` (`player`, `ring-<n>`, `thermal-<n>`, `wind-sock`). The dive and bank keys are two bindings (`pitch`, `bank`), not one `move` vector, because `vector()` clamps a diagonal to unit length.
