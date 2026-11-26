// Generated for you. The two performers share one asset, `mannequin-combat.glb`, and are dressed
// apart by a material swap, so the kit ships no second model.
import { MeshStandardMaterial, type Object3D } from "three";

/** The teacher: warm, so the call reads against the blue of the player's side. */
export const teacherMaterial = new MeshStandardMaterial({ color: 0xc8782a, roughness: 0.55 });
/** The player: the kit's one saturated blue, the colour of the things you act on. */
export const playerMaterial = new MeshStandardMaterial({ color: 0x2a6cf0, roughness: 0.5 });

/**
 * Swap the skin material on a cloned rig, so one asset dresses the teacher and the player apart.
 * Only skinned meshes change.
 */
export function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}
