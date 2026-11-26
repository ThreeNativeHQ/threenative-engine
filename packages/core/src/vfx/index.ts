/**
 * VFX: 46 stock effects, ported from MIT and CC0 donors (provenance:
 * `scripts/fixtures/vfx-niagara-46-effects.json`).
 *
 * Every factory returns the layers of one effect. Add one `GPUParticles3D` per layer and move or
 * scale those emitters to place the effect. Kept off the main entry on purpose: `@threenative/core`
 * declares `sideEffects: false` and each recipe is its own function, so a game ships only the
 * effects it imports.
 */
import { type IParticleOptions, type IVfxOverrides, createDonorEffect } from "./particles.js";
import {
  ashPlumeLayers,
  burstFlashLayers,
  dustCloudLayers,
  effekseerFire01Layers,
  effekseerFire02Layers,
  effekseerFire03Layers,
  effekseerHit01Layers,
  effekseerHit02Layers,
  effekseerHoly01Layers,
  effekseerIce01Layers,
  effekseerIce02Layers,
  effekseerIce03Layers,
  effekseerLightning01Layers,
  effekseerLightning02Layers,
  effekseerLightning03Layers,
  effekseerWind01Layers,
  effekseerWind02Layers,
  effekseerWind03Layers,
  emberFountainLayers,
  explosionCloudLayers,
  fireLayers,
  godotBloodSplashLayers,
  godotFirefliesLayers,
  godotShieldBreakLayers,
  godotWaterfallMistLayers,
  groundMistLayers,
  healingAuraLayers,
  impactDustLayers,
  impactSparksLayers,
  jetFlameLayers,
  kenneyConfettiBurstLayers,
  kenneyLeafSwirlLayers,
  kenneySlashArcLayers,
  magicBeamLayers,
  magicOrbLayers,
  magicWispLayers,
  muzzleFlashLayers,
  pixiBubbleStreamLayers,
  pixiCartoonSmokeBlastLayers,
  poisonCloudLayers,
  rainLayers,
  smokeLayers,
  snowLayers,
  sparkStreaksLayers,
  steamPlumeLayers,
} from "./presets.js";

export type { IParticleBuffers, IParticleOptions, IVfxOverrides } from "./particles.js";
export { RibbonField } from "./portal.js";

/**
 * The portal vortex: a particle ring plus a GPU ribbon field that spirals into its centre.
 * @situation a swirling magic portal
 * @situation a warp gate or a summoning circle
 * @situation a vortex that pulls particles into its centre
 * @constraint add `new GPUParticles3D(portal.ring)` and `portal.ribbons` with ctx.add; both are compute-driven
 * @override seed, amount, color, size, lifetime
 * @example const portal = createPortalVortex();
 * ctx.add(new GPUParticles3D(portal.ring)).position.copy(gate);
 * ctx.add(portal.ribbons).position.copy(gate);
 */
export { createPortalVortex } from "./portal.js";
export type { IPortalVortex } from "./portal.js";

/**
 * A steady flame that licks upward from one point.
 * @situation a campfire, torch or brazier flame
 * @situation a burning object that keeps burning
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createFire()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createFire(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(fireLayers, 11, overrides);
}

/**
 * A fast, narrow jet of flame, like a thruster or a flamethrower.
 * @situation a rocket thruster or jet engine exhaust
 * @situation a flamethrower stream
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createJetFlame()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createJetFlame(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(jetFlameLayers, 13, overrides);
}

/**
 * A short, bright flash that bursts outward once.
 * @situation a flash when a grenade, pickup or spell goes off
 * @situation a bright pop on impact
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createBurstFlash()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createBurstFlash(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(burstFlashLayers, 71, overrides);
}

/**
 * The flash at the muzzle of a gun when it fires.
 * @situation a muzzle flash when a gun fires
 * @situation a quick flare at a barrel tip
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createMuzzleFlash()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createMuzzleFlash(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(muzzleFlashLayers, 73, overrides);
}

/**
 * Grey smoke that rises and spreads as it fades.
 * @situation a smoke plume rising from a fire, a chimney or a burning building
 * @situation a smoke plume over a battlefield
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createSmoke()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createSmoke(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(smokeLayers, 17, overrides);
}

/**
 * A low cloud of tan dust that swells and settles.
 * @situation a dust cloud from a landing, a stomp or a vehicle
 * @situation dust kicked up off dry ground
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createDustCloud()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createDustCloud(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(dustCloudLayers, 19, overrides);
}

/**
 * A pale plume of steam that rises from a vent.
 * @situation steam from a vent, a pipe or a hot spring
 * @situation a white vapour plume
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createSteamPlume()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createSteamPlume(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(steamPlumeLayers, 23, overrides);
}

/**
 * A dark column of ash that billows upward.
 * @situation volcanic ash or a burnt-out building
 * @situation a dark smoke column
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createAshPlume()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createAshPlume(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(ashPlumeLayers, 29, overrides);
}

/**
 * A fireball cloud that blooms and rolls into smoke.
 * @situation an explosion with a fire cloud
 * @situation a barrel or a car that explodes in fire and smoke
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createExplosionCloud()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createExplosionCloud(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(explosionCloudLayers, 31, overrides);
}

/**
 * A puff of dust thrown out where something hits the ground.
 * @situation dust where a bullet or a heavy blow hits the ground
 * @situation a ground impact puff
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createImpactDust()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createImpactDust(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(impactDustLayers, 37, overrides);
}

/**
 * Low mist that drifts along the floor.
 * @situation fog or mist creeping along the ground
 * @situation a swamp or graveyard haze
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createGroundMist()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createGroundMist(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(groundMistLayers, 41, overrides);
}

/**
 * A green toxic cloud that lingers in place.
 * @situation a poison or toxic gas cloud
 * @situation a damage-over-time area hazard
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createPoisonCloud()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createPoisonCloud(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(poisonCloudLayers, 43, overrides);
}

/**
 * Falling rain streaks over an area.
 * @situation rain falling over the scene
 * @situation a rainy weather effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createRain()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createRain(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(rainLayers, 47, overrides);
}

/**
 * Snowflakes that drift down over an area.
 * @situation snow falling over the scene
 * @situation a snowy weather effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createSnow()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createSnow(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(snowLayers, 53, overrides);
}

/**
 * Bright spark streaks that fly out and fall.
 * @situation sparks from grinding metal or a short circuit
 * @situation welding sparks
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createSparkStreaks()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createSparkStreaks(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(sparkStreaksLayers, 79, overrides);
}

/**
 * A spray of sparks where a hit lands.
 * @situation sparks where a bullet hits metal
 * @situation a sword clash or a hit spark
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createImpactSparks()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createImpactSparks(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(impactSparksLayers, 83, overrides);
}

/**
 * Glowing embers that shoot up and drift down.
 * @situation embers rising from a fire
 * @situation a fountain of glowing sparks
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createEmberFountain()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createEmberFountain(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(emberFountainLayers, 89, overrides);
}

/**
 * A small floating wisp of magic light.
 * @situation a will-o'-the-wisp or a fairy light
 * @situation a floating magic mote
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createMagicWisp()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createMagicWisp(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(magicWispLayers, 103, overrides);
}

/**
 * A glowing orb of swirling magic.
 * @situation a magic orb, a charged spell or a power core
 * @situation a glowing energy ball
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createMagicOrb()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createMagicOrb(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(magicOrbLayers, 107, overrides);
}

/**
 * A straight beam of magic energy.
 * @situation a magic beam or a laser spell
 * @situation a column of energy
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createMagicBeam()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createMagicBeam(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(magicBeamLayers, 109, overrides);
}

/**
 * A soft green aura of rising motes around a point.
 * @situation a healing aura around a character
 * @situation a regeneration or buff effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createHealingAura()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createHealingAura(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(healingAuraLayers, 113, overrides);
}

/**
 * A flame whose tongues curl as they rise.
 * @situation a stylised, curling flame
 * @situation a magic fire
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createCurlingFlame()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createCurlingFlame(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerFire01Layers, 127, overrides);
}

/**
 * A flame that throws off embers.
 * @situation a fire with flying embers
 * @situation a burning torch with sparks
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createFlameWithEmbers()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createFlameWithEmbers(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerFire02Layers, 131, overrides);
}

/**
 * A big fire with flame, smoke and embers.
 * @situation a bonfire or a large campfire
 * @situation a burning pile with smoke
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createBonfire()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createBonfire(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerFire03Layers, 137, overrides);
}

/**
 * A short burst of jagged electric arcs.
 * @situation an electric discharge or a shock hit
 * @situation a spark gap or a taser zap
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createLightningBurst()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createLightningBurst(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerLightning01Layers, 139, overrides);
}

/**
 * Electric arcs that crackle upward without stopping.
 * @situation an electric pylon, a tesla coil or a charged weapon
 * @situation a column of crackling lightning
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createLightningColumn()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createLightningColumn(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerLightning02Layers, 149, overrides);
}

/**
 * Electric arcs that whirl around a sphere.
 * @situation a ball of lightning or an electric shield
 * @situation a plasma globe
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createLightningSphere()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createLightningSphere(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerLightning03Layers, 151, overrides);
}

/**
 * A burst of frost crystals out from a point.
 * @situation a frost nova or an ice hit
 * @situation a freezing burst
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createFrostBurst()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createFrostBurst(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerIce01Layers, 157, overrides);
}

/**
 * A slow swirl of frost around a point.
 * @situation a frost aura around a character
 * @situation a cold, freezing area
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createFrostAura()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createFrostAura(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerIce02Layers, 163, overrides);
}

/**
 * Ice shards that fly up and bounce on the floor.
 * @situation ice shattering or a frozen enemy breaking
 * @situation ice shards on impact
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createIceShatter()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createIceShatter(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerIce03Layers, 167, overrides);
}

/**
 * A golden glow with rays and orbiting light.
 * @situation a holy blessing, a shrine or a resurrection
 * @situation a divine light effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createHolyGlow()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createHolyGlow(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerHoly01Layers, 173, overrides);
}

/**
 * Sparks and dust thrown out by a heavy hit.
 * @situation a heavy melee hit
 * @situation a punch or hammer impact
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createImpactBurst()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createImpactBurst(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerHit01Layers, 97, overrides);
}

/**
 * A bright flash with sparks on a hit.
 * @situation a critical hit flash
 * @situation a hit confirm effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createImpactFlash()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createImpactFlash(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerHit02Layers, 101, overrides);
}

/**
 * Streaks of wind that blow sideways.
 * @situation wind lines blowing across the scene
 * @situation a speed or dash effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createWindStreaks()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createWindStreaks(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerWind01Layers, 59, overrides);
}

/**
 * A gust of air that swirls as it blows.
 * @situation a gust of wind or a fan blast
 * @situation a push or knockback wind
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createWindGust()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createWindGust(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerWind02Layers, 61, overrides);
}

/**
 * A whirlwind that spins around a point.
 * @situation a whirlwind, a tornado or a dust devil
 * @situation a spinning wind spell
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createWhirlwind()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createWhirlwind(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(effekseerWind03Layers, 67, overrides);
}

/**
 * A curved arc that follows a weapon swing.
 * @situation a sword slash or a melee swing trail
 * @situation a claw swipe
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createSlashArc()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createSlashArc(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(kenneySlashArcLayers, 179, overrides);
}

/**
 * Coloured confetti that bursts and flutters down.
 * @situation confetti for a win, a level-up or a celebration
 * @situation a party popper
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createConfettiBurst()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createConfettiBurst(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(kenneyConfettiBurstLayers, 181, overrides);
}

/**
 * Leaves that swirl in the wind.
 * @situation falling or swirling leaves
 * @situation an autumn wind effect
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createLeafSwirl()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createLeafSwirl(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(kenneyLeafSwirlLayers, 191, overrides);
}

/**
 * A stream of bubbles that rises.
 * @situation bubbles under water or from a diver
 * @situation a bubbling potion or a fish tank
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createBubbleStream()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createBubbleStream(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(pixiBubbleStreamLayers, 193, overrides);
}

/**
 * A puffy cartoon smoke blast.
 * @situation a cartoon poof when something appears or vanishes
 * @situation a stylised explosion puff
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createCartoonSmokeBlast()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createCartoonSmokeBlast(
  overrides: IVfxOverrides = {},
): readonly IParticleOptions[] {
  return createDonorEffect(pixiCartoonSmokeBlastLayers, 197, overrides);
}

/**
 * Fireflies that blink and drift over an area.
 * @situation fireflies in a forest at night
 * @situation glowing insects or floating lights
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createFireflies()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createFireflies(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(godotFirefliesLayers, 199, overrides);
}

/**
 * A splash of blood droplets on a hit.
 * @situation blood when a character takes damage
 * @situation a gore or hit splatter
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createBloodSplash()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createBloodSplash(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(godotBloodSplashLayers, 211, overrides);
}

/**
 * A shield that cracks into flying shards.
 * @situation a shield or barrier breaking
 * @situation a glass or crystal shatter
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createShieldBreak()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createShieldBreak(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(godotShieldBreakLayers, 223, overrides);
}

/**
 * Mist that rolls off falling water.
 * @situation spray at the foot of a waterfall
 * @situation mist from a fountain or rapids
 * @constraint every colour, size, count and timing is a named override on the call
 * @constraint add one GPUParticles3D per returned layer with ctx.add; move or scale those emitters to place the effect
 * @override seed, amount, color, size, lifetime
 * @example for (const layer of createWaterfallMist()) ctx.add(new GPUParticles3D(layer)).position.copy(at);
 */
export function createWaterfallMist(overrides: IVfxOverrides = {}): readonly IParticleOptions[] {
  return createDonorEffect(godotWaterfallMistLayers, 227, overrides);
}
