/**
 * The first six spells: Fireball, Thunderstrike, Glacial Spike, Arcane Barrage, Aegis and Inferno.
 *
 * Each is a recipe over `createSpell` — the four beats with different numbers in them — plus the
 * stock look the owner asked to absorb. Every colour, size, count and timing below is a named
 * override on the factory call, so a game changes a spell completely without editing this file.
 *
 * Timings, silhouettes and stock looks are ported behaviour-only from Ultra Elements
 * (`src/spells/fire.js`, `lightning.js`, `ice.js`, `arcane.js`, MIT, pinned `698b720`). The GLSL is
 * not: every line on screen is TSL for the owned renderer and the native host.
 */

import { Color } from "three/webgpu";
import type { SpellWorld } from "./spell-world.js";
import { type ISpellEmitter, type ISpellRecipe, createSpell } from "./spell.js";

/** Anything a game may change about a spell. Merged over the stock recipe. */
export interface IFireSpellOverrides {
  readonly core?: string;
  readonly highlight?: string;
  readonly speed?: number;
  readonly charge?: number;
  readonly impact?: number;
  readonly linger?: number;
  readonly radius?: number;
  readonly burst?: number;
  readonly trail?: number;
  readonly lingerBurst?: number;
  readonly light?: number;
  readonly shake?: number;
  readonly scorch?: number;
}

const colour = (value: string): Color => new Color(value);

function recipe(base: ISpellRecipe, overrides: IFireSpellOverrides): ISpellRecipe {
  const tint = {
    colour: colour(overrides.core ?? `#${base.tint.colour.getHexString()}`),
    highlight: colour(overrides.highlight ?? `#${base.tint.highlight.getHexString()}`),
  };
  const withBurst = (
    role: ISpellEmitter | undefined,
    burst: number | undefined,
  ): ISpellEmitter | undefined =>
    role === undefined || burst === undefined ? role : { ...role, burst };
  return {
    ...base,
    burst: withBurst(base.burst, overrides.burst),
    core:
      base.core === undefined
        ? undefined
        : { ...base.core, intensity: overrides.light ?? base.core.intensity },
    impact: {
      ...base.impact,
      shake: overrides.shake ?? base.impact.shake,
      splat:
        base.impact.splat === undefined
          ? undefined
          : { ...base.impact.splat, char: overrides.scorch ?? base.impact.splat.char },
    },
    linger: withBurst(base.linger, overrides.lingerBurst),
    radius: overrides.radius ?? base.radius,
    speed: overrides.speed ?? base.speed,
    timing: {
      charge: overrides.charge ?? base.timing.charge,
      impact: overrides.impact ?? base.timing.impact,
      linger: overrides.linger ?? base.timing.linger,
      travel: base.timing.travel,
    },
    tint,
    trail: withBurst(base.trail, overrides.trail),
  };
}

/**
 * A ball of fire that charges in the hand, crosses the room and leaves the floor burning.
 * @situation a fireball spell a player casts at an enemy
 * @situation a burning projectile that explodes and scorches the ground
 * @situation a wizard's fire attack with a wind-up, a flight and an aftermath
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint the stock look ships as the default, and no override rebuilds a pipeline
 * @override core, highlight, speed, charge, impact, linger, radius, burst, trail, lingerBurst, light, shake, scorch
 * @example const fireball = createFireball(world);
 * casts.cast(fireball, target);
 */
export function createFireball(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        burst: { burst: 26, kind: "spark", style: "spark" },
        core: { intensity: 1.3, radius: 0.34 },
        impact: {
          light: { intensity: 60, range: 14, seconds: 0.45 },
          shake: 0.11,
          shell: { radius: 2.6, seconds: 0.42, strength: 0.85 },
          splat: { char: 0.75, heat: 1, radius: 2.6 },
        },
        linger: { burst: 3, interval: 0.1, kind: "flame", style: "media" },
        name: "fireball",
        radius: 0.35,
        shape: "projectile",
        speed: 18,
        timing: { charge: 0.7, impact: 0.25, linger: 2.6, travel: 2.6 },
        tint: { colour: colour("#ff8a2a"), highlight: colour("#fff2dc") },
        trail: { burst: 2.4, kind: "flame", style: "media" },
      },
      overrides,
    ),
  );
}

/**
 * A bolt out of the sky: it charges, strikes the point instantly and the ground remembers it.
 * @situation a lightning strike spell that hits a point immediately
 * @situation a thunderbolt with a wind-up and a burnt mark where it lands
 * @situation an electrical spell with a column of light from above
 * @override core, highlight, charge, impact, linger, radius, light, shake, scorch
 * @example const bolt = createThunderstrike(world);
 */
export function createThunderstrike(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        bolt: { height: 22, seconds: 0.8, width: 0.55 },
        burst: { burst: 30, kind: "spark", style: "spark" },
        charge: { burst: 2, kind: "mote" },
        impact: {
          light: { intensity: 120, range: 20, seconds: 0.5 },
          shake: 0.16,
          shell: { radius: 3.4, seconds: 0.36, strength: 1 },
          splat: { char: 0.9, glow: 0.8, heat: 0.7, pattern: "ring", radius: 3.2 },
        },
        linger: { burst: 1.6, interval: 0.16, kind: "arc", style: "glow" },
        name: "thunderstrike",
        radius: 0.2,
        shape: "strike",
        timing: { charge: 0.6, impact: 0.8, linger: 1.6, travel: 1.8 },
        tint: { colour: colour("#5b78ff"), highlight: colour("#d6e6ff") },
      },
      overrides,
    ),
  );
}

/**
 * A shard of ice that flies flat and fast, and freezes the ground it breaks on.
 * @situation an ice spike spell that flies at a target and shatters
 * @situation a freezing projectile that leaves frost on the floor
 * @situation a cold spell with a charge, a flight and a lingering chill
 * @override core, highlight, speed, charge, impact, linger, radius, burst, trail, light
 * @example const spike = createGlacialSpike(world);
 */
export function createGlacialSpike(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        burst: { burst: 28, kind: "ice", style: "glow" },
        charge: { burst: 2, kind: "mote" },
        core: { intensity: 1.1, radius: 0.22 },
        impact: {
          light: { intensity: 40, range: 11, seconds: 0.35 },
          shake: 0.07,
          shell: { radius: 2.2, seconds: 0.38, strength: 0.7 },
          splat: { crack: 0.4, frost: 1, radius: 2.8 },
        },
        linger: { burst: 2, interval: 0.14, kind: "ice", style: "glow" },
        name: "glacial-spike",
        radius: 0.12,
        shape: "projectile",
        speed: 26,
        timing: { charge: 0.8, impact: 0.3, linger: 2.4, travel: 1.4 },
        tint: { colour: colour("#4f9bff"), highlight: colour("#c9f4ff") },
        trail: { burst: 1.8, kind: "ice", style: "glow" },
      },
      overrides,
    ),
  );
}

/**
 * A volley of arcane missiles: fast, precise, and each one pops on arrival.
 * @situation an arcane missile spell that fires several projectiles at a target
 * @situation a magic barrage a mage class spams
 * @situation a pink energy bolt with a short charge
 * @override core, highlight, speed, charge, impact, linger, radius, burst, light
 * @example const barrage = createArcaneBarrage(world);
 */
export function createArcaneBarrage(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        burst: { burst: 18, kind: "spark", style: "glow" },
        charge: { burst: 3, kind: "mote" },
        core: { intensity: 1.4, radius: 0.19 },
        impact: {
          light: { intensity: 34, range: 9, seconds: 0.28 },
          shake: 0.05,
          shell: { radius: 1.6, seconds: 0.28, strength: 0.6 },
          splat: { glow: 0.7, heat: 0.2, radius: 1.8 },
        },
        linger: { burst: 1.4, interval: 0.12, kind: "spark", style: "glow" },
        name: "arcane-barrage",
        radius: 0.2,
        shape: "projectile",
        speed: 24,
        timing: { charge: 0.55, impact: 0.12, linger: 1.1, travel: 1.6 },
        tint: { colour: colour("#ff4fd8"), highlight: colour("#ffd8f6") },
        trail: { burst: 2, kind: "spark", style: "glow" },
      },
      overrides,
    ),
  );
}

/**
 * A ward around the caster: it forms, holds, and breaks outward when it expires.
 * @situation a shield spell a player casts on themselves
 * @situation a magic barrier that forms around the caster
 * @situation a defensive bubble that flashes when it breaks
 * @override core, highlight, charge, impact, linger, radius, light, shake
 * @example const aegis = createAegis(world);
 */
export function createAegis(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        burst: { burst: 22, kind: "mote", style: "glow" },
        charge: { burst: 3, kind: "mote" },
        impact: {
          light: { intensity: 26, range: 8, seconds: 0.3 },
          shell: { hold: true, radius: 1.9, seconds: 0.6, strength: 1 },
          splat: { glow: 0.4, radius: 1.6 },
        },
        linger: { burst: 1.2, interval: 0.2, kind: "mote", style: "glow" },
        name: "aegis",
        radius: 0.3,
        shape: "self",
        timing: { charge: 0.45, impact: 0.15, linger: 3.4, travel: 0 },
        tint: { colour: colour("#ff4fd8"), highlight: colour("#c9a8ff") },
      },
      overrides,
    ),
  );
}

/**
 * A pillar of fire that erupts where it lands and keeps burning.
 * @situation a fire area spell that erupts at a point and burns there
 * @situation an inferno column a boss drops on the arena
 * @situation a sustained flame that scorches the ground for seconds
 * @override core, highlight, charge, impact, linger, radius, burst, trail, light, shake, scorch
 * @example const inferno = createInferno(world);
 */
export function createInferno(world: SpellWorld, overrides: IFireSpellOverrides = {}) {
  return createSpell(
    world,
    recipe(
      {
        burst: { burst: 40, kind: "flame", style: "media" },
        charge: { burst: 4, kind: "ember" },
        impact: {
          light: { intensity: 90, range: 18, seconds: 0.9 },
          shake: 0.14,
          shell: { radius: 4.2, seconds: 0.6, strength: 0.9 },
          splat: { char: 1, heat: 1, radius: 4.4 },
        },
        linger: { burst: 5, interval: 0.08, kind: "flame", style: "media" },
        name: "inferno",
        radius: 0.4,
        shape: "area",
        timing: { charge: 0.9, impact: 0.3, linger: 5, travel: 0 },
        tint: { colour: colour("#ff5a12"), highlight: colour("#ffd9a0") },
        trail: { burst: 3, kind: "smoke", style: "media" },
      },
      overrides,
    ),
  );
}
