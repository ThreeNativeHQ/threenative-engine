---
prd_contract: v1
---

# PRD-777 — A spell is a timeline that changes the world it lands in

**Status:** NOT STARTED
**Priority:** P2 — Every box is open: the engine has no spell category, and the action-rpg kit casts one ability with one particle layer.
**Complexity:** 7 (HIGH) — 11+ implementation files (+3), a new spell category in core (+2), cast and surface state that carries across frames (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-527](../native-engine/N14-native-render-chain-and-advanced-visuals/PRD-527-n14e-particles-and-fluids-run-native.md) for the desktop box only. Its native GPU particle parity boxes are open.

## Context

[Ultra Elements](https://github.com/Humpalumps/ultra-elements) (MIT, pinned at `698b720c81d8f1f282bae53633d72413b5c4408d`, 2026-10-30) ships 39 real-time spells for three.js.

**This is a new VFX category.** [PRD-316](../Unreal/vfx/PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) is a catalog of single effects: one emitter with one recipe, fired once. An Ultra Elements spell has three properties that an emitter does not have (upstream `SPELLBOOK.md`):

1. **Silhouette:** the spell is recognizable in one frame.
2. **Timeline:** charge, release, travel, impact and linger. Each phase drives several systems together.
3. **World response:** the spell changes the floor, the lights, nearby particles and its target.

The engine has no vocabulary for this. `engine_search_capabilities` for a fireball, lightning or ice spell returned only `measureThreePose`, score 0.27. The kit has `createAttackArc`, `createHitBurst` and `createArcaneSurge` in `src/render/vfx.ts`, and each is one emitter.

### What upstream is

| Fact | Measured | Consequence |
|---|---|---|
| Renderer | WebGL2, raw GLSL ES 3.00, 44 source files use `ShaderMaterial` or `onBeforeCompile` | The code cannot run here. Our path is TSL through the owned engine and native host. |
| Size | 28,433 lines in `src/spells` and `src/vfx`, 29 spell files | A full port is large, so it ships in waves. |
| Shared systems | All 29 spell files use the particles, ground field, lights, camera rig and dummies. 26 use forces. 24 use shock shells. | The value is in these systems, not in one spell. |
| Arena coupling | 34 files read the arena SDF or `ARENA` constants. The ground field reaches materials through the arena shader. | Each system must lose this coupling. |
| Upstream discipline | Deterministic for a seed, no allocation after `create()`, no shader program added at cast | Keep all three. They match our performance rules. |
| Upstream cost | 24 s to first cast on a first visit, because all spell shaders compile at start-up | A game builds only the spells that it uses. |
| Maturity | Created 2026-10-30, one commit, one contributor | Pin the commit. Do not track upstream. |

Upstream timings (3 ms per frame on an RTX 3060) are WebGL2 numbers for a small arena. They are unverified on this engine.

## Solution

**Consumer flow:** player input → `CastPool.cast(spell, target)` → phase callbacks in the game's spell source → particles, lights, shake and `ReactionField` splats → the cast ends and its slot returns to the pool.

**Layer split.** Rule (b) of the two questions still applies: a look ships as generated source. Mechanism with no look goes in core, and this PRD adds it there.

| Upstream system | Used by | Decision | Layer |
|---|---|---|---|
| Cast pool and phase clock (`cast.js`) | all | **Absorb** as `CastPool` | `packages/core` |
| Particle kind table (`Particles.js`): behaviour is data, so a slider writes data and nothing recompiles | all | **Absorb** as a kind table on `GPUParticles3D` | `packages/core`; the game supplies all colours and curves |
| Ground field (`GroundField.js`) | all | **Absorb** as `ReactionField`, same shape as `RippleField`: it draws nothing and the game's material reads it | `packages/core` |
| Pooled spell lights | all | **Absorb** as a fixed pool at zero intensity, so that a cast does not change the light count | `packages/core` |
| Force fields on particles | 26 files | **Absorb** as kind table parameters | `packages/core` |
| Camera shake | all | **Reuse** `CameraShake` | shipped |
| Bolts | 5 files | **Reuse** the technique in rain's `src/render/lightning.ts` | kit source |
| Trails and ribbons | several | **Generated source**, shared with [PRD-705](../Unreal/vfx/PRD-705-a-sword-swing-leaves-one-connected-trail-not-a-cloud-of-dashes.md) | kit source |
| Sigils, spikes, shock rings (emission) | 8, 5, 24 files | **Generated source** in TSL | kit source |
| Spell recipes, palettes, presets | all | **Generated source** | kit source |
| Scene depth particle collision | all | **Defer** to [PRD-610](../Unreal/vfx/PRD-610-sparks-bounce-off-the-surfaces-the-camera-can-see.md). Use a floor plane from the game until it lands. | — |
| Raymarched and combustion volumes, FLIP fluid | 7+ files | **Defer** to [PRD-664](../Unreal/vfx/PRD-664-smoke-and-explosions-are-lit-volumes-not-flat-sprites.md) and `fluid-particles.ts`. Revisit when PRD-664 passes its Phase 1 gate. | — |
| Heat haze, lensing, half-res OIT pass | few | **Defer.** Revisit when a spell fails its judge without them. | — |
| Arena, pool, sky, post, tuning panel | — | **Do not absorb.** The game and the engine own these. | — |

**First wave: six spells.** Fireball (projectile), Thunderstrike (strike), Glacial Spike (projectile, ice), Arcane Barrage (multi-projectile), Aegis (self dome), Inferno (ground eruption). The other 33 go in later PRDs, one wave each, after this PRD proves the mechanisms.

**Decided defaults:**

- `ReactionField` is a CPU grid that uploads only its changed region. A game can read it directly for combos (a wet floor spreads lightning), with no GPU readback, and the same code runs on native. Comment the ceiling: `ponytail:` GPU simulation if a large world needs more cells.
- `CastPool` holds no gameplay. Damage, mana and cooldowns stay in the game.
- Spell emissive values are tuned to the default filmic curve and metered exposure, not to upstream AgX.

**Unreal reference (design guards, no code):** Niagara submits spell-sized lights as simple lights (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRendererLights.cpp:100`, `:201`). Ribbon tessellation defaults to factor 16 and angle 15 (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRibbonRendererProperties.cpp:79-80`).

**Risks:**

- ⚠️ A bright impact can pump metered exposure. The judge checks this.
- ⚠️ Fireball and Inferno are volumes upstream. A TSL shell and particles may not reach the same look before PRD-664.
- ⚠️ Six spells in a kit add pipelines to its load. The cold-start box measures this.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Spell cast | action-rpg `src/scenes/Play.ts` ability input → `CastPool.cast` (fill `file:line` in Phase 1) | Arcane Surge stays. Spells add slots to `src/ui/AbilityBar.tsx`. | Phase 1 boxes |
| Surface reaction | Spell impact → `ReactionField.splat` → kit `src/render/materials.ts` floor material (fill `file:line` in Phase 2) | New | Phase 2 box |
| Agent discovery | `engine_search_capabilities` → `scripts/render-chain-capabilities.ts` rows, recall corpus row | New | Acceptance box |

## Decisions

- 2026-10-31 (João): spells are a new VFX category, separate from the PRD-316 emitter catalog. This PRD does not depend on PRD-316.
- 2026-10-31 (Claude): this PRD keeps upstream GLSL out of the repository and ports the algorithms to TSL. A WebGL2 path is closed by the renderer rule and has no native proof.
- 2026-10-31 (Claude): new core classes pass the kill switch in `scripts/count-loc.ts`, or they move to kit source.

## Execution Phases

#### Phase 1: One spell runs its whole timeline through core

**Status:** NOT STARTED
**Files:** `packages/core/src/cast-pool.ts` (new), `packages/core/src/particles.ts` (kind table), `packages/core/src/index.ts`, kit `src/render/spells/fireball.ts` and `src/render/spells/kinds.ts` (new), kit `src/scenes/Play.ts`, kit `src/ui/AbilityBar.tsx`, kit `THIRD_PARTY_NOTICES.md` (new, upstream MIT notice).
**Implementation:** Port the `cast.js` phase rules to `CastPool`: a full pool recycles the oldest cast, and each cast takes a seed. Add the kind table so that one kernel serves many kinds. Bind Fireball to the kit's ability input.

- [ ] `CastPool` steps charge, travel, impact, linger and done, recycles the oldest at capacity, and allocates nothing per cast. proof: `pnpm exec vitest run packages/core/__tests__/cast-pool.spec.ts`
- [ ] A kind parameter write changes particle behaviour and builds no new pipeline. proof: `pnpm exec vitest run packages/core/__tests__/particles.spec.ts`
- [ ] Pressing the ability key casts Fireball, and its impact changes the pixels at the target. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/action-rpg/playtests/spells.playtest.json --browser-recipe webgpu`

#### Phase 2: The world responds, and the other five spells land

**Status:** NOT STARTED
**Files:** `packages/core/src/reaction-field.ts` (new), core light pool, kit `src/render/materials.ts`, kit `src/render/spells/*.ts` (five new), kit `AGENTS.md`, `scripts/render-chain-capabilities.ts`, `scripts/fixtures/capability-recall/corpus.json`.
**Implementation:** Port the heat, char, wet and frost channels with decay and splats. The floor material reads the field. Add one capability row per spell. Run `pnpm sync:agents` after the `AGENTS.md` edit.

- [ ] A Fireball impact leaves a scorch on the dungeon floor that fades over time. proof: `spells.playtest.json` scorch step, same command as Phase 1
- [ ] Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno each cast from input and change the pixels at the target. proof: `spells.playtest.json` per-spell steps
- [ ] With reduced flashes on, a spell burst shows at most 3 flashes per second (WCAG 2.3.1, kept from upstream). proof: `pnpm exec vitest run packages/core/__tests__/cast-pool.spec.ts`

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/action-rpg/playtests/spells.playtest.json`, kit spell tuning only.
**Implementation:** Capture each spell at the charge, impact and linger poses. Use upstream `?shot=<spell>&t=<s>` frames from the pinned commit as the reference for silhouette and timeline. Do not use them as a pixel target, because the engine's look wins. The judge is a fresh read-only Opus subagent.

- [ ] All six spells cast on the desktop host. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/action-rpg/playtests/spells.playtest.json --target desktop`
- [ ] Casting all six in sequence from a cold start stays inside the kit's frame budget. proof: `TN_FRAME_BUDGET` presented p95 and worst frame in `spells.playtest.json`, against the limit in `performance.playtest.json`
- [ ] A visual judge returns IMPROVEMENT over the current kit for all six spells, with readable silhouette, four-beat timeline and visible world response. proof: before and after sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: A cold agent in a sandbox, asked for an RPG with fireball and lightning spells, finds the kit spells through `engine_search_capabilities` and casts them with no hand-written particle kernel. proof: `pnpm sandbox`, then `pnpm caps:recall` for the corpus row — Evidence: pending.
