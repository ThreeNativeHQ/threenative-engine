// Every prop is a few primitives on the grid materials or a plain colour: no asset.
import { ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, Shape } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/** The four seats, apart by one material swap on the same mannequin: you, then three CPU. */
export const pawnMaterials: readonly MeshStandardMaterial[] = [
  0xd0532a, 0x2a6cf0, 0xe8b86a, 0x3fae5a,
].map((color) => new MeshStandardMaterial({ color, roughness: 0.5 }));

/** Red spaces take coins; the lone saturated blue is `propMaterial`. */
export const redMaterial = new MeshStandardMaterial({ color: 0xd0532a, roughness: 0.5 });
/** The live star's space and the star itself. */
export const goldMaterial = new MeshStandardMaterial({
  color: 0xe8b86a,
  emissive: 0x6a4a10,
  roughness: 0.35,
  metalness: 0.3,
});
/** A star space already used: dark, so only the live one catches the eye. */
export const usedMaterial = new MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.8 });
export const greenLamp = new MeshStandardMaterial({ color: 0x3fae5a, emissive: 0x1b7a35 });
export const redLamp = new MeshStandardMaterial({ color: 0xd0532a, emissive: 0x8a2a10 });

/**
 * Swap the skin material on a cloned rig, so one asset dresses every seat. Only skinned meshes
 * change: a prop already held in a hand keeps its own material.
 */
export function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

/** A five-point star, 0.9 m across and 0.2 m thick. */
export function createStar(): Group {
  const outline = new Shape();
  for (let point = 0; point < 10; point += 1) {
    const radius = point % 2 === 0 ? 0.45 : 0.2;
    const angle = (point * Math.PI) / 5 + Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (point === 0) outline.moveTo(x, y);
    else outline.lineTo(x, y);
  }
  const geometry = new ExtrudeGeometry(outline, { bevelEnabled: false, depth: 0.2 });
  geometry.translate(0, 0, -0.1);
  const mesh = new Mesh(geometry, goldMaterial);
  mesh.castShadow = true;
  const star = new Group();
  star.name = "star";
  star.add(mesh);
  return star;
}

/** The die: a rounded cube that tumbles while it rolls. The number is on the HUD. */
export function createDie(): Mesh {
  const die = new Mesh(
    new RoundedBoxGeometry(0.7, 0.7, 0.7, 3, 0.08),
    new MeshStandardMaterial({ color: 0xe6e4e1, roughness: 0.4 }),
  );
  die.name = "die";
  die.castShadow = true;
  die.visible = false;
  return die;
}
