# Absorb report, 2026-11-10

Date: 2026-11-10. Snapshot: local `develop` 86ba395ab. No code changed.

Owner, 2026-11-10: "look for abstractions opportunity that would make dev life easier, gain
performance optimizations by default, or have anything thats a net positive overall", then "lint rules
to avoid anti patterns", then "goal: DRY, save on tokens, high performance by default (devs dont even
need to know the heavy lifting its being done)", then "we'll have to refactor the sandbox games to use
these new abstractions, and opus 5.5 high will have to review also".

## Method

Four read-only Sonnet surveyors, one area each. The lead merged the reports and re-ran the checks marked
"lead" below. Everything else is a surveyor claim: re-check it before you build on it.

| Surveyor | Area | Size read |
| --- | --- | --- |
| A | `sandbox/starlance` (rail shooter, `minimal` kit) and `sandbox/stress-lab` (`starter` kit) | 11 523 new lines, 3 226 changed lines |
| B | `sandbox/midway-open-pacific` (carrier flight game) | 27 594 lines |
| C | The 16 kits in `packages/create-threenative/templates/` | 108 179 source lines |
| D | 9 sandbox `FRICTION.md` files; `starlance` and `midway-open-pacific` logs went to A and B | 843 lines in 11 files |

Excluded because a PRD already owns it: kit base and kit contract (PRD-749), draw-call and hitch defaults
(PRD-748), frame-order and collider seams (PRD-325), stamped shared render sources (PRD-833, done), the
reinvention detector (PRD-355), capability search (PRD-298, PRD-300, PRD-865).

## Findings

Three patterns hold across the three newest games and the 16 kits.

1. **A shipped capability is rebuilt by hand because the author does not see it.**
   `midway-open-pacific` rebuilt `MatrixWorldPass`, `FrameBudget` with `DebugOverlay`, `mergeByMaterial`
   and `InputMap` axes, about 350 lines. `starlance` rebuilt `ctx.after`, `createRandom` and
   `ctx.assets.memo`, and rebuilds a 9-second stage on each page load. Lead: the manifest has 0 rows for
   `assets.memo` and `startup.progress`, and 18 kit files carry their own PRNG while 7 use `createRandom`.
2. **A mechanism that every game needs is missing, so each game writes it.** Object pools: 8 copies in
   `starlance` (about 390 lines), 3 keyed view loops in `midway-open-pacific` (about 230 lines), 3 kits.
   `RigidBody3D` has no damping, friction, restitution, angular velocity or sleep (lead: 0 hits in
   `packages/physics/src/RigidBody3D.ts`; 2 games logged it).
3. **Kit plumbing that no game should edit ships as game source.** Loading cover (about 300 lines in
   14 kits), on-screen touch controls (1 976 lines in 12 kits, lead), material assignment and lighting
   (3 614 lines in 12 kits), and quality-tier inputs that the engine can measure (lead: `mobile:
   isMobile()` at 35 sites in 17 files). A new game starts with these lines in its context.

The kit lint cannot see most of it. Lead: `hotCallbacks.ts:73-75` tracks `update` and `render` only on a
`Scene` subclass, so entity `update` methods are not checked.

## PRDs

| PRD | Goal | Priority |
| --- | --- | --- |
| [PRD-872](PRD-872-the-lint-names-the-engine-call.md) | The kit lint sees every per-frame method and names the engine call for each reinvention. Missing `ctx` members become manifest rows. | P1 |
| [PRD-873](PRD-873-the-engine-owns-the-pool-and-the-bodys-rest.md) | `ObjectPool`, `RigidBody3D` rest options, a `prewarm` that cannot hide a live scene, and a state store that skips unchanged keys. | P2 |
| [PRD-874](PRD-874-kit-plumbing-leaves-the-generated-game.md) | Loading cover, touch overlay, restart and pause flow, quality-tier inputs and material assignment move to the engine with every appearance value passed in. | P2 |

Order: PRD-872 first (cheapest, guards the other two), then PRD-873, then PRD-874. No PRD blocks another.

## Rules for every PRD here

1. **Search first.** Run `engine_search_capabilities` for each new symbol before you write it. A row in
   this report that names "none found" is a surveyor claim.
2. **Mechanism only.** A new engine symbol takes every colour, size, count and timing from the game
   (root `AGENTS.md` rule 3). A value the engine can measure is not an option.
3. **The sandbox games adopt it.** Owner, 2026-11-10. Each PRD refactors `starlance`,
   `midway-open-pacific` and `stress-lab` to the new symbols in its last phase. Reinstall the packages
   from the branch tarballs, the way `stress-lab` does (`sandbox/.packages/*.tgz`). Do not patch a
   sandbox copy of the engine.
4. **Opus 5.5 at high effort reviews.** Owner, 2026-11-10. A fresh Opus 5.5 subagent at high effort
   reviews each phase diff and each sandbox refactor. The verdict goes in the PR body, not in a box.
5. **Visual judge.** A change that alters what reaches the screen needs the judge from root `AGENTS.md`.
   The verdict goes on the box that claims the outcome.

## Later: ranked rows with no PRD yet

Each row gets its own PRD when it is picked. Effort: S under 1 hour, M half a day, L 1 to 3 days.

| # | Row | Evidence | Effort |
| --- | --- | --- | --- |
| L1 | Scene-warning pass names a material that reads a missing attribute, and a scene where every surface is transparent | 4 games (`grove`, `fps-framework`, `fps-vanilla`, `wildwood`); `TN_SCENE_WARNING` covers unlit foliage only | M |
| L2 | `shadowProxy(root, { skip })`: merged shadow-only casters with the layer mask owned by the engine | `midway-open-pacific/src/render/world.ts`, about 170 lines; logged 2026-09-22 (351 submissions down to 5) | M |
| L3 | `ProjectilePool` with swept sphere hits and a `SphereIndex` for near queries | `starlance` `Enemies.ts`, `Weapons.ts`, about 235 lines; `midway-open-pacific` allocates a `prev` object per projectile per tick | L |
| L4 | `HudPainter`: instanced quads, bitmap font and `projectToHud` for games with no React | `starlance` `hud.ts`, `hudStyle.ts`, `cockpitHud.ts`, about 360 lines | L |
| L5 | `heightFogNode` in `@threenative/core/render/environment` | 118 lines in 11 kits, 4 variants that differ by 1 or 2 lines | M |
| L6 | Sky and cloud render-target plumbing reuses `Atmosphere` and `AtmosphereLuts` | About 370 lines in 6 kits; 0 kits construct `Atmosphere`. Open: whether the compute LUTs run on the owned engine | L |
| L7 | `CharacterBody3D({ coyoteTime, jumpBuffer })` | 4 kits and `stress-lab`, about 20 lines each | S |
| L8 | `runInSlices(generator, { budgetMs })` | `midway-open-pacific` passes fake 4 096-slot arrays to `addInSlices`, 52 lines | S |
| L9 | `CueBank` over `AudioBus`: cooldown per cue, speed-of-sound delay, keyed loop set under a budget | `midway-open-pacific/src/audio.ts`, about 235 lines, 1 game | L |
| L10 | Model textures take the engine anisotropy default | `midway-open-pacific` walks every texture 4 times; core sets `anisotropy = 8` only for terrain splats | M |
| L11 | Shadow map size from a texel budget | `mobile ? 2048 : 4096` in 12 kit `lighting.ts` files (lead) | M |
| L12 | Portable `GridNavigator` | A* hand-written in `rts` (276 lines) and `shooter`; `NavigationAgent3D` is browser-only | L |
| L13 | `--template empty` kit, and `--force` into a folder that holds only `.packages/` | `fluid-lab` 2026-10-01; `minimal` holds 3 701 lines | M |

Quick wins with no PRD (commit directly after the related check):

- `TN_PLAYTEST_SCENARIO_ASSERTS_NOTHING` suggestion names `warmupFrames: 0`.
- `TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING` suggestion names `doctor` and `--headed --browser-recipe webgpu`.
- The `maxReadyMs: 8000` example in `packages/playtest/src/assertion-schema.ts` becomes a placeholder.
- `atSteps` gains `gte`.

## Not surveyed

- **Engine package architecture.** The untangle batch (PRD-832 to PRD-842) and the god-files batch
  (PRD-800 to PRD-804) closed between 2026-11-06 and 2026-11-08. This survey did not repeat them.
- **Stale PRDs that overlap this batch.** PRD-203 (loading drift) and PRD-193 (allocation-free frames)
  are NOT STARTED. PRD-874 Phase 1 and PRD-872 Phase 1 cover their goal by a different route. Closing
  them is an owner call.
- **Older sandbox games.** Only the three newest games were read in full.
