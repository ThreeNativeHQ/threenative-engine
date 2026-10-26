// The town's one merge. It lives in scene code, not `render/`: `mergeByMaterial` is
// an engine mechanism, and render source stays portable (scripts/check-core-boundary.ts).
import { mergeByMaterial } from "@threenative/core";
import { type Group, InstancedMesh, Mesh, type Object3D } from "three";

/**
 * The town is a few thousand primitives that never move, which is the shape
 * `mergeByMaterial` exists for: the static scenery is baked into one mesh per
 * material, with the transforms already in the vertices. A merged mesh is
 * town-wide and so never frustum-culled, which is the right trade at this
 * triangle count — draw calls are the budget here, not triangles.
 *
 * A mesh only merges with meshes that answer the game the way it does: that
 * stop a round (or not), cast and take shadows the same, and sound the same
 * when hit. The palms are already instanced, and anything under a
 * `userData.moving` subtree (the boat on the swell) stays out, because baking a
 * transform that changes next frame freezes it.
 */
export function collapseTown(group: Group, hittable: Mesh[]): void {
  const stops = new Set(hittable);
  const moving = (object: Object3D): boolean => {
    for (let node: Object3D | null = object; node !== null; node = node.parent) {
      if (node.userData.moving === true) return true;
    }
    return false;
  };
  type Kind = {
    readonly members: Set<Mesh>;
    readonly stop: boolean;
    readonly castShadow: boolean;
    readonly receiveShadow: boolean;
    readonly surface: unknown;
  };
  const kinds = new Map<string, Kind>();
  group.traverse((object) => {
    if (!(object instanceof Mesh) || object instanceof InstancedMesh || moving(object)) return;
    const { castShadow, receiveShadow } = object;
    const stop = stops.has(object);
    const surface: unknown = object.userData.surface;
    const key = `${stop}|${castShadow}|${receiveShadow}|${String(surface)}`;
    let kind = kinds.get(key);
    if (kind === undefined) {
      kind = { members: new Set(), stop, castShadow, receiveShadow, surface };
      kinds.set(key, kind);
    }
    kind.members.add(object);
  });
  for (const kind of kinds.values()) {
    const merged = mergeByMaterial(group, {
      label: "town",
      skip: (mesh) => !kind.members.has(mesh),
    });
    for (const mesh of kind.members) {
      mesh.removeFromParent();
      stops.delete(mesh);
    }
    for (const mesh of merged) {
      mesh.castShadow = kind.castShadow;
      mesh.receiveShadow = kind.receiveShadow;
      if (kind.surface !== undefined) mesh.userData.surface = kind.surface;
      group.add(mesh);
      if (kind.stop) stops.add(mesh);
    }
  }
  hittable.splice(0, hittable.length, ...stops);
}
