import { Box3, DoubleSide, Raycaster, Vector3, type Camera, type Intersection, type Material, type Mesh, type Object3D, type Scene } from "three";

import type { IPlaytestSightLineObservation } from "../protocol.js";

const MAX_BLOCKERS = 5;
const EPSILON_M = 0.05;

/** True when the object and every ancestor is visible; three renders nothing under a hidden node. */
function visibleThroughAncestors(object: Object3D): boolean {
  for (let current: Object3D | null = object; current !== null; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

/** True when the object is the root itself or sits under it. */
function within(object: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = object; current !== null; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

function fadesAway(material: Material | Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((entry) => entry.transparent && entry.opacity < 0.5);
}

/**
 * Casts one ray from the camera's world position to the subject's world bounds centre and reports
 * the solid meshes in the way. The subject's own subtree never blocks its own sight line, and a
 * hidden node, a points cloud, a line, a sprite or a mostly transparent surface is not a wall.
 *
 * A camera inside a solid must report blocked, but a front-side mesh ignores the back face the ray
 * leaves through. Candidates are raycast as double sided for the duration of this one cast, then
 * their materials are restored, so the camera-inside-a-pillar case and the wall case share one ray.
 */
export function observeSightLine(
  scene: Scene,
  camera: Camera,
  subject: Object3D,
): IPlaytestSightLineObservation {
  const target = new Box3().setFromObject(subject).getCenter(new Vector3());
  const origin = camera.getWorldPosition(new Vector3());
  const direction = target.clone().sub(origin);
  const distance = direction.length();
  const candidates: Mesh[] = [];
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh !== true || !visibleThroughAncestors(mesh) || within(mesh, subject) || within(mesh, camera)) return;
    if (fadesAway(mesh.material)) return;
    candidates.push(mesh);
  });
  if (!(distance > 0) || candidates.length === 0) return { blocked: false, blockers: [], distance };

  const sides = new Map<Material, Material["side"]>();
  for (const mesh of candidates) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (sides.has(material)) continue;
      sides.set(material, material.side);
      material.side = DoubleSide;
    }
  }
  let hits: Intersection<Object3D>[];
  try {
    const raycaster = new Raycaster();
    raycaster.layers.enableAll();
    raycaster.far = distance;
    raycaster.set(origin, direction.normalize());
    hits = raycaster.intersectObjects(candidates, false);
  } finally {
    sides.forEach((side, material) => {
      material.side = side;
    });
  }

  const blockers: string[] = [];
  for (const hit of hits) {
    if (!(hit.distance < distance - EPSILON_M)) continue;
    const name = hit.object.name || hit.object.type;
    if (blockers.includes(name)) continue;
    blockers.push(name);
    if (blockers.length === MAX_BLOCKERS) break;
  }
  return { blocked: blockers.length > 0, blockers, distance };
}
