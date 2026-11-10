import type { Matrix4, Object3D } from "three";

/**
 * The method the owned engine puts on every `Object3D` to copy its world matrix into a caller's
 * `Matrix4`. Plain three.js has no such method and reads `matrixWorld` instead.
 *
 * The engine defines this name in `runtime-native/src/engine/abi/bindings_scene.cpp` and probes it in
 * `adapters/v8/math/entry.js`. `__tests__/engine-hooks.spec.ts` holds those two copies to this one,
 * so a rename on either side fails a spec instead of silently taking every caller down the slow path.
 */
export const COPY_MATRIX_WORLD_HOOK = "__tnCopyMatrixWorld";

type CopyMatrixWorld = (target: Matrix4) => void;

/** An `Object3D` that may carry the engine's hook; the property is absent on plain three.js. */
type HookCarrier = Object3D & { readonly [COPY_MATRIX_WORLD_HOOK]?: unknown };

function hookOf(object: Object3D): CopyMatrixWorld | undefined {
  const hook = (object as HookCarrier)[COPY_MATRIX_WORLD_HOOK];
  return typeof hook === "function" ? (hook as CopyMatrixWorld) : undefined;
}

/** Whether `object` belongs to the owned engine, which copies world matrices out instead of aliasing them. */
export function hasCopyMatrixWorldHook(object: Object3D): boolean {
  return hookOf(object) !== undefined;
}

/**
 * Copy `object`'s current world matrix into `target` through the engine's hook.
 * @returns false when the object has no hook, so the caller reads `object.matrixWorld` itself
 */
export function copyMatrixWorld(object: Object3D, target: Matrix4): boolean {
  const hook = hookOf(object);
  if (hook === undefined) return false;
  hook.call(object, target);
  return true;
}
