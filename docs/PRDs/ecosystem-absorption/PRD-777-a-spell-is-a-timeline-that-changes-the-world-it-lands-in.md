---
prd_contract: v1
---

# PRD-777 — A spell is a timeline that changes the world it lands in

**Status:** IN PROGRESS — the foundation, the kind table, the six first-wave spells and the spell lab are on the branch and proven; the visual box is open on a sprite-render blocker this machine shows.
**Priority:** P2 — Every box is open: the engine has no spell category, and PRD-778 to PRD-781 need the `@threenative/core/spells` foundation that this PRD builds.
**Complexity:** 7 (HIGH) — 11+ implementation files (+3), a new spell category in core (+2), cast and surface state that carries across frames (+2). Risk override: none.
**Owner:** unassigned
**Depends on:** [PRD-527](../native-engine/N14-native-render-chain-and-advanced-visuals/PRD-527-n14e-particles-and-fluids-run-native.md) for the desktop box only. Its native GPU particle parity boxes are open.

## Context

[Ultra Elements](https://github.com/Humpalumps/ultra-elements) (MIT, pinned at `698b720c81d8f1f282bae53633d72413b5c4408d`, 2026-10-30) ships 39 real-time spells for three.js. **All 39 become engine capabilities** (owner, 2026-10-31).

**This is a new VFX category.** [PRD-316](../Unreal/vfx/PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) is a catalog of single effects: one emitter with one recipe, fired once. An Ultra Elements spell has three properties that an emitter does not have (upstream `SPELLBOOK.md`):

1. **Silhouette:** the spell is recognizable in one frame.
2. **Timeline:** charge, release, travel, impact and linger. Each phase drives several systems together.
3. **World response:** the spell changes the floor, the lights, nearby particles and its target.

The engine has no vocabulary for this. `engine_search_capabilities` for a fireball, lightning or ice spell returned only `measureThreePose`, score 0.27. The kit has `createAttackArc`, `createHitBurst` and `createArcaneSurge` in `src/render/vfx.ts`, and each is one emitter.

### What upstream is

| Fact | Measured | Consequence |
|---|---|---|
| Renderer | WebGL2, raw GLSL ES 3.00, 44 source files use `ShaderMaterial` or `onBeforeCompile` | The code cannot run here. Each spell is rewritten in TSL for the owned engine and the native host. |
| Size | 28,433 lines in `src/spells` and `src/vfx`, 29 spell files | The port ships in five PRDs. |
| Shared systems | All 29 spell files use the particles, ground field, lights, camera rig and dummies. 26 use forces. 24 use shock shells. | The foundation comes first. |
| Arena coupling | 34 files read the arena SDF or `ARENA` constants. The ground field reaches materials through the arena shader. | `SpellWorld` replaces the arena. |
| Upstream discipline | Deterministic for a seed, no allocation after `create()`, no shader program added at cast | Keep all three. They match our performance rules. |
| Upstream cost | 24 s to first cast on a first visit, because all spell shaders compile at start-up | A game builds only the spells that it imports. |
| Maturity | Created 2026-10-30, one commit, one contributor | Pin the commit. Do not track upstream. |

Upstream timings (3 ms per frame on an RTX 3060) are WebGL2 numbers for a small arena. They are unverified on this engine.

## The epic: 39 spells in five PRDs

The PRD size cap splits this work. All five PRDs ship on one PR, because they serve one goal.

| PRD | Scope | New mechanisms | Spells |
|---|---|---:|---:|
| **PRD-777** | Foundation and first wave | `CastPool`, kind table, `ReactionField`, spell lights, `SpellWorld` | 6 |
| [PRD-778](PRD-778-spells-that-arc-trail-and-draw-sigils.md) | Arcs, ribbons, sigils | Bolts, analytic ribbons, sigils | 10 |
| [PRD-779](PRD-779-spells-that-erupt-solid-from-the-ground.md) | Erupting solids | Spikes, debris | 8 |
| [PRD-780](PRD-780-spells-made-of-volumes-and-swarms.md) | Volumes and swarms | Hero volumes, swarms | 7 |
| [PRD-781](PRD-781-spells-made-of-liquid-and-bent-space.md) | Liquid and bent space | Fluid, metaballs, lens, portal view | 8 |

First wave: Fireball, Thunderstrike, Glacial Spike, Arcane Barrage, Aegis, Inferno.

## Solution

**Consumer flow:** an agent searches "fireball" → `engine_search_capabilities` returns `createFireball` → the game imports it from `@threenative/core/spells` → player input calls `casts.cast(fireball, target)` → the phase callbacks drive particles, lights, shake and `ReactionField` splats → the cast ends and its slot returns to the pool.

```ts
import { CastPool, createFireball, SpellWorld } from "@threenative/core/spells";

const world = new SpellWorld({ scene, camera, groundAt });
const fireball = createFireball(world, { core: "#fff2dc", speed: 18 });
const casts = new CastPool(world);
casts.cast(fireball, target);
```

**Contract for every spell:**

- It is one named factory on the `@threenative/core/spells` subpath, with a capability row. `create<Spell>(world, overrides?)` is the only public shape.
- A stock look ships as the default. Every colour, size, count and timing value is a named override, and upstream presets ship as named override objects. A game changes the look completely with no package edit.
- It imports only what it uses. `@threenative/core` already declares `sideEffects: false`, and a dedicated subpath keeps spells out of the main entry.
- All shader code is TSL. It builds its pipelines at `create` time and adds none at cast.
- It reads the world through `SpellWorld` only, with no arena constants.

**`SpellWorld`:** the game supplies the scene, the camera and `groundAt(x, z)`. It holds the light pool, `ReactionField`, shake and flash limiter. Spell targets are game-owned callbacks. Damage, mana and cooldowns stay in the game.

**Foundation decisions:**

| Upstream system | Decision |
|---|---|
| Cast pool and phase clock (`cast.js`) | `CastPool`: a full pool recycles the oldest cast, and each cast takes a seed. |
| Particle kind table (`Particles.js`) | One kernel on `GPUParticles3D` with many kinds. Behaviour and forces are data, so a write recompiles nothing. |
| Ground field (`GroundField.js`) | `ReactionField`, same shape as `RippleField`: it draws nothing and the game's material reads it. A CPU grid uploads only its changed region, so a game reads it directly for combos with no GPU readback. `ponytail:` GPU simulation if a large world needs more cells. |
| Spell lights | A fixed pool at zero intensity, so that a cast does not change the light count. |
| Camera shake | Reuse `CameraShake`. |
| Scene depth particle collision | Use `groundAt` until [PRD-610](../Unreal/vfx/PRD-610-sparks-bounce-off-the-surfaces-the-camera-can-see.md) lands. |

Spell emissive values are tuned to the default filmic curve and metered exposure, not to upstream AgX.

**Unreal reference (design guards, no code):** Niagara submits spell-sized lights as simple lights (`UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRendererLights.cpp:100`, `:201`).

**Risks:**

- ⚠️ A bright impact can pump metered exposure. The judge checks this.
- ⚠️ Fireball and Inferno are volumes upstream. They ship here as a TSL shell with particles, and PRD-780 upgrades them.
- ⚠️ A catalog in core raises the package's source size. The one-spell bundle box guards the game's cost.

This PRD has 11 boxes, over the cap of about 8. The foundation, its one-spell cost and its first-wave proof cannot separate without a PRD that ships no spell.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Spell cast in a game | action-rpg `src/scenes/Play.ts` spell slots → `CastPool.cast` (fill `file:line` in Phase 1) | Arcane Surge stays. Fireball, Thunderstrike and Glacial Spike add slots to `src/ui/AbilityBar.tsx`. | Phase 1 box |
| Whole catalog proof | `examples/spell-lab` (new, floor and three dummies) casts each spell by name | New. PRD-778 to PRD-781 append to it. | Phase 2 and 3 boxes |
| Surface reaction | Spell impact → `ReactionField.splat` → game floor material (fill `file:line` in Phase 2) | New | Phase 2 box |
| Agent discovery | `engine_search_capabilities` → `capabilities.json`, recall corpus row | New | Acceptance box |

## Decisions

- 2026-10-31 (João): spells are a new VFX category, separate from the PRD-316 emitter catalog. This PRD does not depend on PRD-316.
- 2026-10-31 (João): "need all absorbed as engine capabilities". All 39 ship as importable core factories, and the agent's proposal to keep looks in kit source is rejected. This is a named exception to "never own the look", in the same form as the Unreal default: a stock look with an override on the same call. Phase 1 writes it into `AGENTS.md`.
- 2026-10-31 (Claude): the catalog goes on a `@threenative/core/spells` subpath, not in a new package, because it carries no new dependency.
- 2026-10-31 (Claude): upstream GLSL stays out of the repository, and the algorithms are ported to TSL. A WebGL2 path is closed by the renderer rule and has no native proof.
- 2026-11-03 (owner, overrides the behaviour-only port): "its a MIT project, just copy". The from-scratch spells drew a white dot and an orange smudge. Upstream's JavaScript is copied verbatim under `packages/core/src/spells/ultra/`, mirroring its file names. Only what the engine cannot run changes: each GLSL program becomes TSL line by line (same maths, same constants), and each `WebGLRenderTarget` becomes a `RenderTarget`. It runs on the default engine, the Wasm build over WebGPU, never on upstream three's WebGL2 (owner: "webgl is trash, it will be slow FPS"). Fireball's closure lands and passes the judge before the other five.

## Execution Phases

#### Phase 1: One spell runs its whole timeline from a core import

**Status:** IN PROGRESS — the pool exists and is proven; the kind table, Fireball, the lab and the kit slot do not.
**Files:** `AGENTS.md` (the look exception, then `pnpm sync:agents`), `packages/core/package.json` and `tsup.config.ts` (subpath), `packages/core/src/spells/index.ts`, `cast-pool.ts`, `spell-world.ts`, `spell-lights.ts`, `reaction-field.ts` (new), `packages/core/src/particle-kinds.ts` (kind table, new — kept out of `particles.ts`, which is already 648 lines against the 400-line notice), `THIRD_PARTY_NOTICES.md` (upstream MIT notice, new — the file did not exist), `examples/spell-lab/` (new), kit `src/scenes/Play.ts`, kit `src/ui/AbilityBar.tsx`.
**Implementation:** Port the `cast.js` phase rules. Add the kind table. Build Fireball on them, then bind it to a kit slot. Use the real `GPUParticles3D`, `prewarm` and `CameraShake`.

- [x] `CastPool` steps charge, travel, impact, linger and done, recycles the oldest at capacity, and allocates nothing per cast. proof: `pnpm exec vitest run packages/core/__tests__/cast-pool.spec.ts` — Evidence: 12 tests pass. The pool's slots, records, `from`/`to` vectors and `data` scratch keep their identity across a recast, and a ball that has passed its target lands on the target rather than flying past it. A review pass found and this commit fixes three defects the first tests missed: a spell could land during charge or linger (re-firing its impact every frame), any `update` hook disabled the pool's own integration so a spell that only animates never moved, and a cast with no `from` started at the previous cast's origin instead of the caster's.
- [x] A game retunes Fireball through named overrides, and no new pipeline builds. proof: `pnpm exec vitest run packages/core/__tests__/particle-kinds.spec.ts` — Evidence: 7 tests pass (file renamed from the PRD's `particles.spec.ts`). The decisive test keeps the emitter's `material`, `process` and `spawn` references, retunes the kind, and asserts all three are the same objects afterwards while the uniform values moved — a retune is a uniform write, so no pipeline is built. `ParticleKindTable` holds lifetime, size, speed, cone, gravity, drag, buoyancy, alpha, colour and highlight as uniforms; eight stock kinds ship.
- [x] A build that imports only Fireball contains no other spell's code. proof: `pnpm --filter spell-lab build:one-spell`, then search the bundle for a marker string — Evidence: `examples/spell-lab/src/one-spell.ts` imports only `CastPool`, `SpellWorld` and `createFireball`; `vite build --config vite.one-spell.config.ts` emits a 50.37 kB bundle (14.37 kB gzip) in which `"fireball"` appears once and `"thunderstrike"`, `"glacial-spike"`, `"arcane-barrage"`, `"aegis"` and `"inferno"` appear zero times.
- [ ] Pressing a kit spell key casts Fireball, and its impact changes the pixels at the target. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/action-rpg/playtests/spells.playtest.json --browser-recipe webgpu` — OPEN, unrun. The slot is wired: `G` casts Fireball from the hero's facing, `Play.ts` owns one `SpellWorld` and one `CastPool`, the world is advanced beside the ability, and a `spell.casts` component exists for the scenario (`playtests/spells.playtest.json`, written). It has **not been executed**, because the template is only installed when scaffolded and this pass did not run the scaffolder. `pnpm typecheck` in the template reports no error in `Play.ts` or `game.ts`; every error it does report is a missing `react`/`@threenative/ui` module from the uninstalled template.

**Phase 1 notes.** The subpath ships and the manifest lists four symbols under `@threenative/core/spells`: `CastPool`, `ReactionField`, `SpellLights`, `SpellWorld`. The five drawable mechanisms a spell needs — the particle kind table, a projectile core, a shock shell, a bolt ribbon and a shield bubble — are not written. Each is TSL that has to be iterated against a real WebGPU adapter, and writing them without that iteration would have shipped guesses, so they were left for the next pass rather than committed unverified.

#### Phase 2: The world responds, and the other five spells land

**Status:** PARTIAL — the surface field and the flash limiter exist and are proven; no spell writes to them.
**Files:** `packages/core/src/spells/reaction-field.ts`, `spell-lights.ts` and five spell factories (new), `examples/spell-lab/`, kit `src/render/materials.ts`, kit `src/scenes/Play.ts`, kit `AGENTS.md`, `scripts/fixtures/capability-recall/corpus.json`.
**Implementation:** Port the heat, char, wet and frost channels with decay and splats. Bind Thunderstrike and Glacial Spike to kit slots. Add a recall row per spell.

- [x] A Fireball impact leaves a scorch on the floor that fades over time. proof: `node packages/playtest/dist/runner/cli.js examples/spell-lab/playtests/spell-lab.playtest.json --browser-recipe webgpu`, scorch step — Evidence: PASS on an NVIDIA RTX 2080 (turing, hardware adapter, headed, `--browser-recipe webgpu`). The scenario asserts `casts >= 1`, `impacts >= 1`, `floorMarks >= 1` (the `ReactionField` version moves only when a spell marks the floor) and a before/after frame change, and the capture shows a burnt-orange patch on the floor where the fireball landed.
- [x] Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno each cast and change the pixels at the target. proof: `spell-lab.playtest.json`, per-spell steps — Evidence: six scenario files, one per spell (`spell-lab`, `thunderstrike`, `glacial-spike`, `arcane-barrage`, `aegis`, `inferno`), all PASS on the RTX 2080 headed. One file per spell rather than six labelled steps, because the `visual` assertion diffs the whole scenario and a per-step diff is not available. Each asserts its cast, its impact, that particles spawned, no console errors and a before/after frame change.
- [x] With reduced flashes on, a spell burst shows at most 3 flashes per second (WCAG 2.3.1, kept from upstream). proof: `pnpm exec vitest run packages/core/__tests__/spell-world.spec.ts` — Evidence: 9 tests pass. A fourth flash inside one second is refused and counted in `suppressedFlashes`, never dimmed, and the limiter allows the next flash once the window has passed. The pool itself never hides a light: Three.js drops an invisible object before it collects lights, so a hidden light would be the light-count change the pool exists to prevent.

#### Phase 2b: The spells are upstream's code, on our engine

**Status:** IN PROGRESS — owner decision 2026-11-03.
**Files:** `packages/core/src/spells/ultra/` (new, upstream paths: `spells/cast.ts`, `spells/fire.ts`, `spells/lightning.ts`, `spells/ice.ts`, `spells/arcane.ts`, `vfx/common.ts`, `vfx/noise.ts`, `vfx/Particles.ts`, `vfx/GroundField.ts`, `vfx/Volumes.ts`, `vfx/FluidVolume.ts`, `vfx/Shockwaves.ts`, `vfx/Ribbons.ts`, `vfx/Bolts.ts`, `vfx/Spikes.ts`, `vfx/Sigils.ts`, `vfx/Refraction.ts`, `vfx/FxTarget.ts`), `examples/spell-lab/` (engine Wasm wiring, `vite.config.ts`), `THIRD_PARTY_NOTICES.md`.
**Implementation:** Copy each upstream file. Keep its JavaScript, names and constants. Transliterate each GLSL program to TSL. Composite the FX target through `WorldEnvironment`'s `baseColour` hook, which sits where upstream composites: after the scene pass, before exposure and the tone curve. Our post chain replaces upstream `PostFX`. Delete the from-scratch spells once their port lands.

- [ ] spell-lab boots on the default engine, the Wasm build of this branch, over WebGPU. proof: `doctor --url` names the engine and a hardware adapter, and `node scripts/web-engine-stamp.mjs --check` passes.
- [ ] Fireball is upstream's code and reads as upstream's Fireball in its five beats (charge, release, impact, overview, after). proof: Opus visual judge against upstream's `dev/tools/sheet.mjs` beats, headed, `--browser-recipe webgpu`.
- [ ] Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno are upstream's code and pass the same judge. proof: as above, per spell.
- [ ] The from-scratch spell files are deleted, and the capability entries point at the ported factories. proof: `pnpm caps:recall` exits 0 and recalls each spell first.

#### Phase 3: It holds on native, on budget and to the eye

**Status:** NOT STARTED
**Files:** `examples/spell-lab/playtests/spell-lab.playtest.json`, spell default values only.
**Implementation:** Capture each spell at the charge, impact and linger poses. Use upstream `?shot=<spell>&t=<s>` frames from the pinned commit as the reference for silhouette and timeline. Do not use them as a pixel target, because the engine's look wins. The judge is a fresh read-only Opus subagent.

- [ ] All six spells cast on the desktop host. proof: `node packages/playtest/dist/runner/cli.js examples/spell-lab/playtests/spell-lab.playtest.json --target desktop`
- [ ] Casting all six in sequence from a cold start stays inside the frame budget of the kit's `performance.playtest.json`. proof: `TN_FRAME_BUDGET` presented p95 and worst frame in `spell-lab.playtest.json`
- [ ] A visual judge returns IMPROVEMENT over the kit's current effects for all six spells, with readable silhouette, four-beat timeline and visible world response. proof: before and after sheets on the PR, headed, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm

## Acceptance criteria

- [ ] AC-1 [local]: `engine_search_capabilities` returns the matching factory for each of the six spell names, and the manifest lists it under `@threenative/core/spells`. proof: `pnpm caps:recall` — Evidence: PARTIAL and RED.
  The manifest half holds: `packages/create-threenative/capabilities.json` lists `CastPool`, `ReactionField`, `SpellLights` and `SpellWorld` under `@threenative/core/spells`. The six factories do not exist, so no spell name is recalled.
  ⚠️ `pnpm caps:recall` is also **red by one row** on this branch: `brief.topdown-action.1` now returns `Billboard3D` as a fifth result, so `rejectHits` reads 16 against a floor of 15 (it reads 15 on `origin/develop`). Adding any capability raises the total situation count that `tokenWeights` divides by, which scales every entry's score by about 2% and re-breaks one tie at the result limit. `--update-budget` refuses to record a regression, so the floor was left alone instead of being relaxed. This must be settled before the branch merges: the honest fixes are to tighten the scorer's tie-break or to record the drift deliberately.
