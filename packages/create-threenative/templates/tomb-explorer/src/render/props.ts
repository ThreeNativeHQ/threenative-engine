// Generated for you. The relic and the blade are a few boxes on the grid materials: no asset.
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BLADE } from "../level.js";
import { BLADE_RAISED, BLADE_THICK } from "../sim/blade.js";
import { UNIT } from "../tuning.js";
import { propMaterial, structureMaterial } from "./materials.js";

/** The climber's suit: a warm tan, so the grey grid frames her. */
export const climberMaterial = new MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.55 });

/**
 * The material swap that dresses the mannequin: skinned meshes only.
 */
export function dress(
  root: { traverse: (visit: (object: unknown) => void) => void },
  material: MeshStandardMaterial,
): void {
  root.traverse((object) => {
    const mesh = object as Mesh & { isSkinnedMesh?: boolean };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

const gold = new MeshStandardMaterial({
  color: 0xe8b86a,
  emissive: 0x6a4a14,
  metalness: 0.6,
  roughness: 0.3,
});

/** The relic on its pedestal: a spinning gold diamond, the one saturated thing on the far shore. */
export function createRelic(): { readonly group: Group; readonly gem: Mesh } {
  const group = new Group();
  group.name = "relic";
  const pedestal = new Mesh(new CylinderGeometry(0.34, 0.42, 0.9, 20), structureMaterial);
  pedestal.position.y = 0.45;
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  group.add(pedestal);
  const gem = new Mesh(new OctahedronGeometry(0.2, 0), gold);
  gem.position.y = 1.22;
  gem.castShadow = true;
  group.add(gem);
  return { group, gem };
}

/** The slicing blade: a slab that spans the corridor, hung from a lintel. Move `slab` up and down. */
export function createBlade(): { readonly group: Group; readonly slab: Mesh } {
  const group = new Group();
  group.name = "blade";
  const width = (BLADE.z1 - BLADE.z0) * UNIT;
  const lintel = new Mesh(new RoundedBoxGeometry(0.5, 0.4, width, 2, 0.03), structureMaterial);
  lintel.position.y = (BLADE_RAISED + BLADE_THICK) * UNIT + 0.4;
  lintel.castShadow = true;
  group.add(lintel);
  const slab = new Mesh(
    new BoxGeometry(BLADE.halfWidth * 2 * UNIT, BLADE_THICK * UNIT, width),
    propMaterial,
  );
  slab.name = "blade-slab";
  slab.castShadow = true;
  group.add(slab);
  return { group, slab };
}
