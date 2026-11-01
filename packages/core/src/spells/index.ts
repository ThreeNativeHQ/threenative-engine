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
