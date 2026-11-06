# Kit notes: sailing

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns ship handling, the sea's look and tuning, `Buoyancy3D`, course order, HUD, water, and look; `src/game.ts` is portable and React mounts from `src/main.ts`.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; this kit uses its analytic wave field and measured hull points instead.


## Commands and map

Four course marks around the headland, a helm and a set of sheets, 120 seconds of wind. The hull and rig are `assets/ship.glb` — Poly Haven's `dutch_ship_medium` (CC0; James Ray Cock, Rico Cilliers, Nicolò Zubbini) — fetched by `Boot.load()` (`props.ts#loadShipModel`, alongside the sky) and read back synchronously in `Sailing.enter()` (`props.ts#getShipModel`), then oriented by `props.ts#createShipModel`: a scene-level `load()` on `Sailing` itself would still leave the registry empty the instant `enter()` returns, since `Boot.enter()` calls `goto("sailing")` without awaiting it. `conventions.ts#measureHull` reads the physics body's box and `Buoyancy3D` hull points off the loaded model rather than a hand-tuned constant, so a different hull model never needs those numbers touched by hand. `SHIP_SAILS` in `props.ts` stays simulated cloth: the GLB's own baked sail mesh is stripped at cook time so the two never double up. `Ship.ts` uses `RigidBody3D` plus `Buoyancy3D`, and reads the hull's attitude off four swell samples rotated by the heading rather than leaving it to the solver: `Buoyancy3D`'s drag comes from the body's *linear* velocity and so damps no rotation at all, and a free body capsizes inside seconds. A helm and sheets are two axes, not one stick: `vector("move")` clamps its diagonal to unit length, which is right for a thumb and wrong for a ship that must hold full sail and hard over at once.

The sea is `SpectralOcean`, added with `ctx.add` so the compute registry runs its passes. It draws nothing: `src/render/ocean.ts` owns the mesh, the material, the mirror and every colour, and is the only file to edit for the water's look. The cascade buffers the vertex stage reads are the ones the CPU height query is copied from, so the hull floats on the surface that is drawn; two fields would leave the ship riding water nothing renders, with every assertion here still green.

The initial loading curtain also waits for the first finite CPU height in `src/scenes/ocean-readiness.ts`. It registers the existing startup hold synchronously, dispatches once after framework readiness, and releases on a real sample, including zero. The existing 45 s hold budget bounds the wait; timeout or compute failure emits `TN_SAILING_HEIGHT_READBACK_FAILED` before the gate fails open. Exit cancels the observer; restarts after startup use the ordinary compute lifecycle. This gate does not guarantee the timing of later throttled copies.

Five details are load-bearing. The material is `MeshStandardNodeMaterial`, not a basic one: a basic material takes no lights, so the sun on the water has to be faked with a `pow()` term, and the sea cannot agree with the hull floating on it. `normalNode` overrides `normalView`, so feed it a view-space normal or the reflection becomes a column of glare that follows the camera. The surface is a **logarithmic disc** centred on the ship, the cascade lookup adding the disc's own offset back: a square patch either ends inside the haze as a visible rectangular hem, or reaches the horizon with 300 m quads beside the hull. The ripple normals fade on the **pixel footprint** (`dFdx`/`dFdy` of the world position) and the slope they lose is spent as roughness, or every sea past 130 m is a mirror. And the CPU height is a coarse throttled copy: `readbackResolution` over the largest `patchSize` is the spacing between samples, and make that spacing wider than the waves and the ship sits at a smoothed mean sea level, hanging over its own troughs. It is also `undefined` until the first copy lands, which `Ship.ts` handles by falling back to mean sea level, and `surfaceHeight(ocean, x, z, dt)` is the call anything that floats should use rather than `sampleHeight` raw: it predicts the height from the same sample's measured vertical velocity and age. The hull additionally owns a `createHeightReconciler()` history: a new copy preserves the previous predicted height and velocity, then completes its correction over the measured interval between copies. `surfacePredictionCorrection` and `maxSurfacePredictionCorrection` report the waterline offset honestly; wave velocity and the attitude probes keep their measured inputs. `WaveField.sample(x, z, time)` returns height and normal and allocates; `heightAt(x, z, time)` is the same arithmetic without the jacobian and without an allocation — ask it for floats, splash and wake, and keep `sample` where you shade with the normal. `RippleField` is the sea answering back: a finite patch carrying only the disturbance, so add its `heightAt` to the sea height and its `foamAt` to the foam and never use it in place of a sea. It steps at display rate or the CFL limit, whichever is smaller; `speed`, `damping`, `foamHalfLife`, `current`, `step` and `maxSteps` override that, and a `step` over the limit is rejected with the limit in the message. Its rim absorbs, so `recenter` it on whatever the player is watching.

The sky is `assets/sky.jpg` (Poly Haven, CC0), fetched in `Boot.load` beside the ship — a scene's `load` is the one method allowed to await, and `Sailing.enter` must stay synchronous, because a playtest runner reads the registry the instant `enter()` returns. `sky.ts` draws it at `SKY_RANGE` and lights the scene at `FILL_RANGE`, and those are different numbers on purpose: half that photograph is a flat grey placeholder where a panorama's lower hemisphere should be, and at full range it becomes the largest term in every surface's light budget. Reflection is one half-res `WaterSurface3D` pass, with `markReflected` naming what the mirror may draw — it is a second draw of the world, so the sea stays off it, the sky arrives in the same texture, and there is no second sky lookup to blend against it.

Tune the sea state in `src/render/ocean.ts`, the rig and hull in `src/render/props.ts` and `src/entities/Ship.ts`, and the course in `src/scenes/Sailing.ts`. The React HUD reads published state; keep `playtests/survives.playtest.json` as smoke proof and native scenarios honest.

On a touch-primary device (`isMobile() && isTouchscreenAvailable()`), `src/render/touch-controls.ts` adds a left stick whose vector `Sailing` adds into both the helm and the sheets; keyboard is the fallback.


## Portable authoring contracts

Generated conventions call `normaliseToMetres` for authored ship scale; buoyancy owns water contact. `input.vector("move").y` is +up and means forward wind; use one explicit `-move.y` conversion.

The bridge flushes about 100 ms; keep speed/lap in state and frame feedback in Three.js.


## Optional multiplayer transport

`quality.ts` names one cost override, reported as `TN_RENDER_CHAIN_COST_OVERRIDE`: no final gather, SSGI or SSR (the frame is the water, and screen-space reflections over moving water read as smear) and no motion blur (it smeared the chase-camera ship and its sails). Kit facts: WASD or arrows steer, the left touch stick sails, `C` is a capsize test, `R` restarts. `SpectralOcean` displaces the drawn surface and answers the height query `Buoyancy3D` reads, so the ship floats on the water you see. `src/render/sky.ts` is adapted from MIT-licensed VictorZakharov/beautiful-water; its header keeps the credit and the MIT licence name, so keep that header.
