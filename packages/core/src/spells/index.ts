/**
 * Spells: a timeline that changes the world it lands in.
 *
 * A spell is not an emitter. It charges, releases, travels, impacts and lingers, and each beat
 * drives several systems at once. This subpath holds that machinery.
 *
 * Kept off the main entry on purpose: `@threenative/core` declares `sideEffects: false` and this is
 * its own module, so a game that never casts a spell ships none of it.
 */

/**
 * Step a spell's timeline: charge, release, travel, impact, linger, done.
 * @situation a fireball or a lightning bolt that charges, flies, lands and lingers
 * @situation several spells mid-flight, with no allocation per cast
 * @constraint the pool is fixed and recycles the cast alive longest; it never grows
 * @constraint a ball that has passed its target lands on the target, however late the frame notices
 * @override timing, shape, speed and radius come from the spell; a cast may override shape and seed
 * @example const casts = new CastPool(world);
 * casts.cast(fireball, target, { from: hand });
 * casts.update(dt);
 */
export { CastPool } from "./cast-pool.js";
export type {
  CastPhase,
  CastShape,
  ICast,
  ICastEnvironment,
  ICastOptions,
  ICastTiming,
  ISpell,
} from "./cast-pool.js";

/**
 * The marks a spell leaves on the floor: heat, char, wet, frost, crack and glow.
 * @situation a fireball impact that leaves a scorch and fades over time
 * @situation ice that melts where lightning spread, or a lava geyser's crack
 * @constraint it draws nothing; the game decides what a mark looks like
 * @constraint the patch is finite and every channel decays on its own half-life
 * @override halfLife, resolution and size tune the patch; pattern, radius, seed and angle set each mark
 * @example field.splat({ heat: 1, char: 0.6, radius: 2.5, x: hit.x, z: hit.z });
 * field.update(dt);
 */
export { REACTION_CHANNELS, ReactionField } from "./reaction-field.js";
export type {
  IReactionDirty,
  IReactionFieldOptions,
  IReactionSplat,
  ReactionChannel,
  ReactionPattern,
} from "./reaction-field.js";

/**
 * A fixed pool of spell lights, created once at zero intensity.
 * @situation a spell impact that glows without changing the light count
 * @situation a charge glow or a falling meteor lighting what it passes
 * @constraint the whole pool exists before the first cast; a cast changes intensity, never the list
 * @constraint flash returns undefined when the pool is busy; a spell carries on without one
 * @override count is the pool size; each flash supplies position, colour, intensity, range and seconds
 * @example lights.flash({ x, y, z, color, intensity: 40, range: 12, seconds: 0.35 });
 */
export { SpellLights } from "./spell-lights.js";
export type { ISpellLightFlash, ISpellLightsOptions } from "./spell-lights.js";

/**
 * Everything a spell may touch: the scene, the floor, the light pool, the surface field, one shake
 * and one flash limiter.
 * @situation cast an engine spell without passing a scene into every call
 * @situation honour an accessibility setting that limits flashing
 * @constraint damage, mana, cooldowns and who the target is stay in the game
 * @constraint with reducedFlashes on, a fourth flash inside one second is refused, never dimmed
 * @override groundAt, castSlots, lightCount, reaction, shake and reducedFlashes are named options
 * @example const world = new SpellWorld({ scene, groundAt });
 * const casts = new CastPool(world);
 */
export { SpellWorld } from "./spell-world.js";
export type { ISpellWorldOptions, ISpellWorldShakeOptions } from "./spell-world.js";

/**
 * A ball of fire that charges, crosses the room and leaves the floor burning.
 * @situation a fireball spell the player casts at a target
 * @situation a burning projectile that explodes and scorches the ground
 * @situation a wizard's fire attack with a wind-up, a flight and an aftermath
 * @situation make a fireball
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint the first cast costs what the hundredth does: nothing is built at cast time
 * @override core, highlight, speed, charge, impact, linger, radius, burst, trail, lingerBurst, light, shake, scorch
 * @example const fireball = createFireball(world);
 * casts.cast(fireball, target);
 */
export { createFireball, type IFireSpellOverrides } from "./spells.js";

/**
 * A bolt out of the sky: it charges, strikes the point instantly, and the ground remembers it.
 * @situation a lightning strike spell that hits a point immediately
 * @situation a thunderbolt with a wind-up and a burnt mark where it lands
 * @situation make a lightning spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @override core, highlight, charge, impact, linger, radius, light, shake, scorch
 * @example const bolt = createThunderstrike(world);
 * casts.cast(bolt, target);
 */
export { createThunderstrike } from "./spells.js";

/**
 * A shard of ice that flies flat and fast, and freezes the ground it breaks on.
 * @situation an ice spike spell that flies at a target and shatters
 * @situation a freezing projectile that leaves frost on the floor
 * @situation make an ice spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @override core, highlight, speed, charge, impact, linger, radius, burst, trail, light
 * @example const spike = createGlacialSpike(world);
 * casts.cast(spike, target);
 */
export { createGlacialSpike } from "./spells.js";

/**
 * A volley of arcane missiles: fast, precise, and each one pops on arrival.
 * @situation an arcane missile spell that fires projectiles at a target
 * @situation a magic barrage a mage class spams
 * @situation make an arcane bolt spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @override core, highlight, speed, charge, impact, linger, radius, burst, light
 * @example const barrage = createArcaneBarrage(world);
 * casts.cast(barrage, target);
 */
export { createArcaneBarrage } from "./spells.js";

/**
 * A ward around the caster: it forms, holds, and breaks outward when it expires.
 * @situation a shield spell a player casts on themselves
 * @situation a magic barrier that forms around the caster
 * @situation make a protective bubble spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @override core, highlight, charge, impact, linger, radius, light
 * @example const aegis = createAegis(world);
 * casts.cast(aegis, world.focus);
 */
export { createAegis } from "./spells.js";

/**
 * A pillar of fire that erupts where it lands and keeps burning.
 * @situation a fire area spell that erupts at a point and burns there
 * @situation an inferno column a boss drops on the arena
 * @situation make a sustained fire area spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @override core, highlight, charge, impact, linger, radius, burst, trail, light, shake, scorch
 * @example const inferno = createInferno(world);
 * casts.cast(inferno, target);
 */
export { createInferno } from "./spells.js";

/**
 * Build a spell from a recipe: four beats, a tint, and the numbers between them.
 * @situation author a spell the catalog does not cover, out of the same beats
 * @constraint read the world through SpellWorld only, so a game can swap the scene and the floor
 * @example const spell = createSpell(world, recipe);
 */
export {
  createSpell,
  type ISpellEmitter,
  type ISpellImpact,
  type ISpellRecipe,
  type ISpellTint,
} from "./spell.js";
/**
 * Tune what a particle kind does, as data rather than a shader.
 * @situation retune a spell's particles at run time from a settings screen
 * @situation change how long, how fast or how heavy a kind of particle is without a new pipeline
 * @constraint set writes uniforms; no kernel, material or pipeline is rebuilt
 * @constraint a table knows only the kinds it was asked for, so an unused kind costs nothing
 * @override lifetime, size, speed, cone, gravity, drag, buoyancy, alpha, colour and highlight
 * @example const kinds = new ParticleKindTable(["flame", "smoke"]);
 * kinds.set("flame", { lifetime: [0.3, 0.6], colour: [0.4, 0.8, 1] });
 */
export { type IParticleKindValues, ParticleKindTable } from "../particle-kinds.js";
export type { ParticleKindName } from "../particle-kinds.js";
