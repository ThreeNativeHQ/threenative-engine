/**
 * `three-mesh-bvh`'s `MeshBVH` as the engine back ends provide it: the ray queries core's picking
 * makes (`raycastObject3D`, honouring `raycaster.firstHitOnly`), answered by the engine's own
 * triangle raycast. The upstream package runs its tree walk through `Triangle`, `Line3` and a
 * `Vector3` per step, every one an ABI crossing here, so it is not run as JS against engine objects.
 *
 * ponytail: the engine raycast tests every triangle of the mesh in C++; build a native tree when a
 * profile shows picking cost, with these results as its oracle.
 */

interface IRaycasterLike {
  firstHitOnly?: boolean;
  intersectObject(object: object, recursive: boolean): readonly object[];
}

/** three-mesh-bvh's split strategies, with its values (src/core/Constants.js). */
export const CENTER = 0;
export const AVERAGE = 1;
export const SAH = 2;

export class MeshBVH {
  readonly geometry: object;

  constructor(geometry: object, options?: Readonly<Record<string, unknown>>) {
    const { strategy, ...rest } = options ?? {};
    // A split strategy changes how three-mesh-bvh builds its tree, never which triangles a ray
    // hits; the engine raycast answers the same either way, so any of the three is accepted.
    if (strategy !== undefined && strategy !== CENTER && strategy !== AVERAGE && strategy !== SAH)
      throw new Error(
        `TN_NATIVE_MESH_BVH_STRATEGY: ${String(strategy)} is not CENTER, AVERAGE or SAH`,
      );
    const unsupported = Object.keys(rest);
    if (unsupported.length > 0)
      throw new Error(
        `TN_NATIVE_MESH_BVH_OPTIONS_UNSUPPORTED: ${unsupported.join(", ")}: the engine MeshBVH builds no tree, so it takes no other build option`,
      );
    this.geometry = geometry;
  }

  /** three-mesh-bvh's `raycastObject3D`: the object's hits (only the nearest with `firstHitOnly`). */
  raycastObject3D(object: object, raycaster: IRaycasterLike, intersects: object[] = []): object[] {
    const hits = raycaster.intersectObject(object, false);
    if (raycaster.firstHitOnly === true) {
      if (hits[0] !== undefined) intersects.push(hits[0]);
    } else {
      for (const hit of hits) intersects.push(hit);
    }
    return intersects;
  }
}
