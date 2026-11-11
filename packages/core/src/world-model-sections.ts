import { type Box3, type BufferGeometry, type Material, type Mesh, Vector3 } from "three";
import { baseGeometryOf } from "./model-lod.js";

/** One material section of a mesh: the whole mesh, or one group of a multi-material mesh. */
export interface IMeshSection {
  readonly material: Material;
  readonly group?: { readonly start: number; readonly count: number };
}

/**
 * A mesh's material sections: one per geometry group for a material array, else the whole mesh.
 * Instanced props draw one batch per material, so an imported model splits here first.
 *
 * @situation scatter or instance an imported glTF model that has several materials
 * @constraint a section's `material` can be `undefined` for a group naming a missing material slot; skip it
 * @example for (const section of meshSections(mesh)) parts.push(sectionGeometry(mesh, box, section));
 */
export function meshSections(mesh: Mesh): IMeshSection[] {
  const materials = mesh.material;
  return Array.isArray(materials)
    ? mesh.geometry.groups.map((group) => ({
        material: materials[group.materialIndex ?? 0] as Material,
        group,
      }))
    : [{ material: materials }];
}

/**
 * One section's geometry in model space, standing on y = 0. Every section of a model takes the same
 * base from the whole model's `box`, so a crown keeps its place on its trunk: basing each section on
 * its own bounds detaches them. The mesh's LOD0 geometry is cloned under its world matrix, and a
 * group becomes the clone's draw range.
 *
 * @situation the crown of an instanced tree floats off its trunk, or the parts of a model separate
 * @situation turn each part of an imported model into a geometry for an instanced prop batch
 * @constraint `box` is the whole model's world bounds after any unit normalisation; call `mesh.updateWorldMatrix` first
 * @example const box = new Box3().setFromObject(root); const geometry = sectionGeometry(mesh, box, section);
 */
export function sectionGeometry(
  mesh: Mesh,
  box: Box3,
  section: IMeshSection,
  options: { readonly centreXZ?: boolean } = {},
): BufferGeometry {
  const geometry = baseGeometryOf(mesh).clone().applyMatrix4(mesh.matrixWorld);
  const { group } = section;
  if (group) {
    const start = Math.max(group.start, geometry.drawRange.start);
    const end = Math.min(
      group.start + group.count,
      geometry.drawRange.start + geometry.drawRange.count,
    );
    geometry.clearGroups();
    geometry.setDrawRange(start, Math.max(0, end - start));
  }
  const centre = box.getCenter(new Vector3());
  const centred = options.centreXZ === true;
  geometry.translate(centred ? -centre.x : 0, -box.min.y, centred ? -centre.z : 0);
  return geometry;
}

/**
 * Recompute the normals of a geometry whose normals are missing, zero or not finite, and leave
 * authored normals alone. Some exported art ships zero normals and draws black under any light.
 * Run it after any reshape, so the recomputed normals fit the final shape.
 *
 * @situation an imported model draws black or unlit because it ships zero normals
 * @constraint one bad normal recomputes them all; an intentionally hard-edged model loses its authored split normals only if one is bad
 * @example geometry.scale(1.1, 1, 1.1); repairZeroNormals(geometry);
 */
export function repairZeroNormals(geometry: BufferGeometry): boolean {
  const normals = geometry.getAttribute("normal");
  let valid = normals !== undefined;
  for (let i = 0; valid && normals && i < normals.count; i++) {
    const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i));
    valid = Number.isFinite(length) && length >= 0.01;
  }
  if (!valid) geometry.computeVertexNormals();
  return !valid;
}
