// The two fighters are one mannequin told apart by a material swap, plus the shield bubble.
import { DoubleSide, Mesh, MeshStandardMaterial, type Object3D, SphereGeometry } from "three";

/** The player's suit: the kit's one saturated blue. */
export const p1Material = new MeshStandardMaterial({ color: 0x2a6cf0, roughness: 0.5 });
/** The opponent's suit: the HUD's red. */
export const cpuMaterial = new MeshStandardMaterial({ color: 0xd0532a, roughness: 0.5 });
/** Worn while intangible: a roll, a get-up, a fresh respawn. */
export const ghostMaterial = new MeshStandardMaterial({
  color: 0xf4f6fa,
  depthWrite: false,
  opacity: 0.42,
  roughness: 0.4,
  transparent: true,
});

/**
 * Swap the skin material on a cloned rig. Only skinned meshes change, so one asset dresses both
 * fighters apart.
 */
export function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

/** A translucent sphere, scaled each frame to the shield's radius. */
export function createShieldBubble(color: number): Mesh {
  const bubble = new Mesh(
    new SphereGeometry(1, 24, 16),
    new MeshStandardMaterial({
      color,
      depthWrite: false,
      emissive: color,
      emissiveIntensity: 0.6,
      opacity: 0.38,
      roughness: 0.2,
      side: DoubleSide,
      transparent: true,
    }),
  );
  bubble.name = "shield-bubble";
  bubble.visible = false;
  return bubble;
}
