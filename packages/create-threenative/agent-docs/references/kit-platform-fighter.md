# Kit notes: platform-fighter

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the stage (`src/level.ts`), the fighter simulation (`src/sim/`), the CPU (`src/sim/cpu.ts`), the camera, the HUD and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. The kit has no physics engine: `src/sim/` is plain TypeScript stepped once per fixed tick, so a playtest can replay it exactly.

Mechanics borrow defaults from the Super Smash Bros. reference cards (`engine_reference_detail` on `super-smash-bros-vetritheretri`: `walk-speed-tiers`, `dash-run-transition`, `jump-force-and-shorthop`, `double-jump`, `fast-fall`, `air-drift-and-gravity`, `ground-friction`, `knockback-formula`, `hitstun-and-damage-levels`, `hitlag-freeze`, `shield-decay-and-size`, `shield-pushback`, `ledge-hold`, `platform-drop`, `battle-camera-framing`, `blast-zone-knockout`). Each constant names its card where it is defined, in `src/sim/constants.ts`. Card units convert to metres with `UNIT = 0.003`.

## Commands and map

Controls: A/D or the arrows run, Space (or W, Up) jumps and double jumps (tap for a short hop, hold for a full hop), S or Down fast falls and drops through a platform, J attacks (a jab on the ground, an aerial in the air), K smash-attacks (hold to charge, release to swing), L shields (the bubble shrinks while held and breaks at 30 health), Shift rolls (a short intangible window), R restarts.

`src/sim/match.ts` is the rules: hits, blocks, blast zones, stocks, respawn and the winner. `src/sim/fighter.ts` is one fighter's mode machine (`free`, `squat`, `attack`, `hitstun`, `shield`, `dodge`, `ledge`, `getup`, `stun`, `dead`). `src/sim/attacks.ts` holds the three attacks as frame tables (startup, active, recovery) and the knockback and hitstun formulas. `src/sim/stage.ts` and `src/sim/motion.ts` hold the collision and the air and ground movement. `src/sim/ledge.ts` holds the ledge grab, hang, jump, drop and get-up.

Damage percent rises per hit. Knockback is `((p*0.1 + p*d*0.05) * 2/(weight+1) * 1.4 + 18) * growth/100 + base`, where `p` is the victim percent after the hit. Hitstun is knockback divided by 1.875 frames. The CPU weighs 1.25 and the player 1.0, so the same hit sends the CPU a little less far at the same percent.

`src/sim/cpu.ts` is the opponent: it approaches, jabs or charges a smash, shields a swing it sees coming (60 percent of the time), climbs a ledge and recovers by double jump toward the stage. It sleeps for the first 300 frames (five seconds), so a scenario's timing does not depend on it. The stations (Digit1-9, Digit0, Z, X, C) put the fighters in fixed test spots and answer only under the playtest runner; delete them with the playtests that use them.

Every figure is `assets/mannequin-combat.glb`. The player is blue and the CPU is red through a material swap (`src/render/fighters.ts`). The stage and the platforms are grid boxes on the procedural metre-grid materials. The camera (`src/render/camera.ts`) frames both fighters side-on and zooms with their distance.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`. Register testable entities with `ctx.entities` (`p1`, `cpu`, `stage`). The scene publishes `GameState` every tick through `ctx.state.set`; `src/scenes/snapshot.ts` builds it from the match. The scene steps the match exactly once per fixed tick, after `ctx.startup.compileSettled`. `ctx.random` is seeded in `src/game.ts`, so the CPU repeats run to run.

`src/render/` is yours to edit. Keep the camera side-on and level with the stage: a high tilt hides the ledge, and the kit contract row `camera-sees-subject` fails.
