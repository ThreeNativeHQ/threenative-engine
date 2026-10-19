import { BufferAttribute, BufferGeometry } from "three";
import { validateBakedMesh } from "./core/bake.js";
import type { IBakedMesh } from "./core/types.js";

/**
 * Converts baked arrays to ordinary geometry using the consumer's installed Three.js.
 * @requires npm i @threenative/terrain
 * @situation put an authored terrain mesh in a game-owned Three.js scene
 * @constraint creates only geometry; the caller owns its material, scene and disposal
 * @example const geometry = toGeometry(bakeMesh(new Terrain({ resolution: 17 }).evaluate()));
 * @override every surface choice remains in game source
 */
export function toGeometry(mesh: IBakedMesh): BufferGeometry {
  validateBakedMesh(mesh);
  const geometry = new BufferGeometry();
  geometry.name = mesh.name;
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(mesh.uvs, 2));
  if (mesh.colors) geometry.setAttribute("color", new BufferAttribute(mesh.colors, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
