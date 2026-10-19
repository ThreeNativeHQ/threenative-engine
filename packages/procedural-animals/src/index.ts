export type { IAnimalBake, IAnimalBone, AnimalTier } from "./format.js";
export type { IAnimalAssetResolver } from "./runtime.js";
/**
 * Validates a pinned wolf PANM bake before constructing any renderer resource.
 * @situation validate a baked procedural animal before allocating geometry
 * @constraint unknown revisions, malformed sections, indices and skin weights throw by name
 * @requires npm i @threenative/procedural-animals
 * @example const bake = parseAnimalBake(bytes);
 */
export { parseAnimalBake } from "./format.js";
/**
 * Resolves and loads a prebuilt wolf through the game's ordinary asset resolver.
 * @situation load a cooked animal from ctx.assets without runtime generation
 * @constraint a corrupt served bake rejects rather than falling back to a different file
 * @requires npm i @threenative/procedural-animals
 * @example const bake = await loadAnimalBake(ctx.assets, "wolf.animal");
 */
export { loadAnimalBake } from "./runtime.js";
/**
 * Validates all bytes before constructing geometry with the bake's skin and rig attributes.
 * @situation construct a Three.js geometry from a validated procedural wolf bake
 * @constraint this creates bind geometry only; game-owned DQS material and animated bounds remain required
 * @requires npm i @threenative/procedural-animals
 * @example const { bake, geometry } = createAnimalGeometry(bytes);
 */
export { createAnimalGeometry } from "./runtime.js";

export { createAnimalActor } from "./follow.js";
export type {
  IAnimalMotion,
  IAnimalMotionContext,
  IAnimalAcceptedState,
  IAnimalActorOptions,
  AnimalActionResult,
} from "./follow.js";
export type { IAnimalPose, IAnimalSkeleton } from "./pose.js";
