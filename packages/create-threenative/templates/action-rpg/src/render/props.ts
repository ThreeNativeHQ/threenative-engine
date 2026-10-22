// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Every solid in the dungeon is one bevelled box, and every prop is a small assembly of them.
// Two rules make them read as made objects instead of blockout:
//
// - A 3 cm rounded edge catches a line of sun and a line of sky. Sharp edges catch neither.
// - The block sinks by its bevel radius. Resting the rounded bottom on the floor leaves a lit
//   sliver under it, and the shadow reads as detached from the thing casting it.
import { BoxGeometry, CylinderGeometry, Group, type Material, Mesh } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { bladeMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";

/** The corner radius every solid in this game is cut with. */
export const BEVEL = 0.03;

/**
 * A bevelled box, placed **in the geometry** rather than on the mesh.
 *
 * `worldGridUVs` measures UVs in world metres and `buildStaticColliders` reads the mesh's world
 * matrix, so the collider and the grid agree only while the offset is baked in. Rebuild the solid
 * somewhere else instead of writing `mesh.position`.
 */
export function solidBox(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  material: Material,
  radius = BEVEL,
): Mesh {
  const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius);
  geometry.translate(at[0], at[1] + size[1] / 2 - radius, at[2]);
  const mesh = new Mesh(worldGridUVs(geometry), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Bake the per-room dressing down to one mesh per material.
 *
 * Torches, brackets and lintel courses never move relative to their room; authored one at a time
 * they are a draw call each, and the shadow pass doubles that. The room's own floor, walls and
 * pillars stay separate objects, because those are the ones a playtest looks up by name and the
 * ones whose trimesh a body is built from.
 */
export function bakeByMaterial(parts: readonly Mesh[], into: Group, name: string): void {
  const byMaterial = new Map<Material, Mesh[]>();
  for (const mesh of parts) {
    const bucket = byMaterial.get(mesh.material as Material);
    if (bucket === undefined) byMaterial.set(mesh.material as Material, [mesh]);
    else bucket.push(mesh);
  }
  for (const [material, meshes] of byMaterial) {
    const geometry = mergeGeometries(
      meshes.map((mesh) => {
        mesh.updateMatrix();
        const placed = mesh.geometry.clone().applyMatrix4(mesh.matrix);
        const cloned = placed.index === null ? placed : placed.toNonIndexed();
        // Position and UVs only. Normals are recomputed below, and dropping the UVs would leave a
        // grid-mapped material with no coordinates to read the grid from — three warns, and the
        // merged surface comes out untextured.
        for (const name of Object.keys(cloned.attributes)) {
          if (name !== "position" && name !== "uv") cloned.deleteAttribute(name);
        }
        return cloned;
      }),
      false,
    );
    if (geometry === null) throw new Error("mergeGeometries returned null baking the dungeon.");
    geometry.computeVertexNormals();
    const merged = new Mesh(geometry, material);
    merged.name = name;
    merged.castShadow = meshes[0]?.castShadow ?? true;
    merged.receiveShadow = true;
    into.add(merged);
  }
}

/** Loot: a banded chest in the one touchable colour. A plinth with a marble on it read as neither. */
export function createLootVisual(): Group {
  const group = new Group();
  group.name = "loot-chest";
  const body = solidBox([0.66, 0.36, 0.46], [0, 0, 0], propMaterial);
  group.add(body);
  const lid = solidBox([0.7, 0.16, 0.5], [0, 0.36, 0], propMaterial, 0.05);
  group.add(lid);
  for (const x of [-0.22, 0.22]) group.add(solidBox([0.07, 0.52, 0.52], [x, 0, 0], propMaterial));
  return group;
}

/**
 * The hero's blade. Small, procedural, and named so `attachToBone` has something to hold: the
 * capability takes an object the game owns and parents it to a named joint, which is the whole
 * point — the hand owns the sword, so every clip that moves the hand moves the sword with it.
 */
export function createSword(): Group {
  const group = new Group();
  group.name = "held-blade";
  const blade = new Mesh(new BoxGeometry(0.05, 0.9, 0.13), bladeMaterial);
  blade.position.y = 0.55;
  blade.castShadow = true;
  group.add(blade);
  const guard = new Mesh(new CylinderGeometry(0.09, 0.09, 0.05, 8), bladeMaterial);
  guard.position.y = 0.09;
  group.add(guard);
  const grip = new Mesh(new CylinderGeometry(0.035, 0.04, 0.18, 8), structureMaterial);
  grip.position.y = -0.02;
  group.add(grip);
  return group;
}
