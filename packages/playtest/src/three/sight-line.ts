import { Box3, DoubleSide, Raycaster, Vector3, type Camera, type Intersection, type Material, type Mesh, type Object3D, type Scene } from "three";

import type { IPlaytestSightLineObservation } from "../protocol.js";

const MAX_BLOCKERS = 5;
const EPSILON_M = 0.05;
/** A solid the ray crosses in less than this is a rope, a wire or a rail: the eye sees past it. */
const SLIVER_M = 0.15;
/** Two hits this close are one surface met on a shared triangle edge, not an entry and an exit. */
const SAME_SURFACE_M = 1e-4;

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

/**
 * A surface the eye sees through: mostly transparent, an alpha-tested cutout (leaves and grass are
 * quads the ray meets and the eye passes through the holes of), or a transparent effect that writes
 * no depth (light shafts, mist, glow). A transparent surface that writes depth stays a wall.
 */
function fadesAway(material: Material | Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some(
    (entry) => entry.alphaTest > 0 || (entry.transparent && (entry.opacity < 0.5 || !entry.depthWrite)),
  );
}

/**
 * The hits that stand in the way. The ray is double sided, so a closed solid reports an entry and an
 * exit; a pair under {@link SLIVER_M} apart is a sliver, and a sliver does not hide anyone. A surface
 * the ray crosses once (a plane) has no exit and stays a wall.
 */
function standingInTheWay(hits: readonly Intersection<Object3D>[], distance: number): Intersection<Object3D>[] {
  const surfaces: Intersection<Object3D>[] = [];
  for (const hit of hits) {
    const last = surfaces[surfaces.length - 1];
    if (last !== undefined && last.object === hit.object && hit.distance - last.distance < SAME_SURFACE_M) continue;
    surfaces.push(hit);
  }
  const walls: Intersection<Object3D>[] = [];
  for (let index = 0; index < surfaces.length; index += 1) {
    const entry = surfaces[index]!;
    if (!(entry.distance < distance - EPSILON_M)) break;
    const exit = surfaces[index + 1];
    if (exit !== undefined && exit.object === entry.object && exit.distance - entry.distance < SLIVER_M) {
      index += 1;
      continue;
    }
    walls.push(entry);
  }
  return walls;
}

/**
 * Casts one ray from the camera's world position to the subject's world bounds centre and reports
 * the solid meshes in the way. The subject's own subtree never blocks its own sight line, and a
 * hidden node, a points cloud, a line, a sprite, a cutout, a sliver (a rope or a rail the ray crosses
 * in under 15 cm) or a mostly transparent surface is not a wall.
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
  for (const hit of standingInTheWay(hits, distance)) {
    const name = hit.object.name || hit.object.type;
    if (blockers.includes(name)) continue;
    blockers.push(name);
    if (blockers.length === MAX_BLOCKERS) break;
  }
  return { blocked: blockers.length > 0, blockers, distance };
}
