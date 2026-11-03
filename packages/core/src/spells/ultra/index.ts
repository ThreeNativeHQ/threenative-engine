// Ultra Elements (MIT, Copyright (c) 2026 Humpalumps), ported @698b720: the shared foundation every
// ported spell module builds on, and the spells ported so far. Only what a game calls is public;
// ported spell modules import the TSL chunks, Volumes and FxTarget by relative path.
export { Q, TIERS } from "./engine/quality.js";
/**
 * The shared Ultra Elements spell world: casts, volumes, spell lights and the per-frame CPU tick.
 * Add `fx.scenes.fx` to the scene, `addSpell` each ported spell, call `renderFrame(dt)` each frame.
 * @situation an Ultra Elements spell such as the raymarched teardrop Fireball cast at a target
 * @situation a volumetric fire spell drawn through the Three.js TSL node API on WebGPU
 * @constraint call bakeNoise first: the volume shaders sample its noise, curl and blackbody textures
 */
export {
  createFx,
  type Fx,
  type IFxOptions,
  type ITrail,
  type ITrails,
  type IShocks,
  type IGround,
  type IFluid,
  type IFluidDomain,
  type IRig,
  type IArena,
  type IDummy,
} from "./main.js";
export type { ICast, ISpell, ISpellInstance, Phase } from "./spells/cast.js";
export { default as fire } from "./spells/fire.js";
export { U } from "./vfx/common.js";
/**
 * CPU bake of the Ultra Elements 3D noise, curl and blackbody textures that every spell volume samples.
 * @situation the noise and blackbody textures an Ultra Elements spell needs before it first draws
 * @constraint costs about 0.6 s at 64^3 and about 5 s at 128^3 on the main thread; bake once at load
 */
export { bakeNoise, type IBakedNoise } from "./vfx/noise.js";
/**
 * The Ultra Elements GPU particle system behind `fx.particles`: a spell's kinds, emitters and field emitters.
 * @situation the flames, embers, sparks, smoke and debris an Ultra Elements spell emits as it charges, flies and hits
 */
export type { IEmitter, KindDef, Particles } from "./vfx/Particles.js";
