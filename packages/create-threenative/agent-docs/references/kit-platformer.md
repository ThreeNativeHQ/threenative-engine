# Kit notes: platformer

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Overview

A chibi fox runs ninety-seven metres of floating meadow, rope bridges and stompable walkers to a goal flag: three hearts, five gems, a double jump and a dash. Every model is procedural — no mesh file, no texture, no animation clip.


## Ownership

This repository owns the route, the fox's feel, the walkers, the pickups, the HUD, and the look; `src/game.ts` is portable and React mounts from `src/main.ts`.


## Start every change

`@threenative/physics/navigation` is browser-only WASM, and this route needs no navigation: it is authored geometry, so the fox collides with exactly the triangles it sees and desktop/native stays honest.


## Commands and map

`src/entities/Fox.ts` owns movement and feel — the one table of constants the route is balanced around; `Walker.ts` is a stompable patrol, `Pickup.ts` a collectible; `src/level/Stage.ts` builds the route and tags the walkable meshes, `Checkpoints.ts` owns hearts and respawns; `src/render/` is ordinary Three.js and every model in the game; `src/ui/Hud.tsx` is the one HUD. The camera and the sun are written in `afterPhysics`, never in the scene's frame function, because `moveAndSlide` only queues motion. Keep `playtests/survives.playtest.json` as smoke proof and `touch-controls.ts`/`touch-layout.ts` aligned with the native playtest. Collision is the engine's, from your geometry: `buildStaticColliders(ctx, stage.group, { predicate: (object) => object.userData.solid === true })` turns the tagged walkable meshes into fixed trimesh bodies and leaves thousands of decorative ones out of it. A `CollisionShape3D` capsule is centred on the body's origin, so the origin is the fox's waist and its rig is pushed down by `halfHeight + radius`; forget that and the fox floats a body-length above every surface.


## Portable authoring contracts

No model here is imported, so there is no authored scale to normalise and the collider is the body: the generated scale-and-snap conventions do not apply to this template.

`src/render/sky.ts` builds the gradient background from `palette.ts`; a separate measured environment lights the scene, the background's lower hemisphere matches `skyFloor`, and `SUN_DIRECTION` aims `lighting.ts`'s authored sun.


## Optional multiplayer transport

The generated `quality.ts` uses those core defaults; game exposure policy stays in `src/render/exposure.ts`. `tonemapMode: "aces"` and `autoExposureEnabled: false` with fixed `exposure` are named overrides on the same preset.
